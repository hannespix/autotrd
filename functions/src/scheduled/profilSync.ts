/**
 * Täglicher Profil-Lauf (Task 19, Teil 2): Firmenprofil und Fundamentaldaten
 * je US-Aktie des Katalogs über den Finnhub-Adapter, als Feld
 * `market/{sym}.profil` (nur für Angemeldete lesbar — kein öffentliches
 * Weiterreichen lizenzierter Daten), Stand und GRUND in `meta/profilStand`.
 *
 * Verhalten ohne Schlüssel: sauber dunkel (`grund: keine_schluessel`), kein
 * Fehler, kein Deploy-Bruch — das Secret wird erst gebunden, nachdem die
 * Deploy-Diagnose es als VORHANDEN gemeldet hat (Muster universumSync).
 * Budget: Gratis-Tarif 60 Abrufe/min, drei je Symbol → ein fester Abstand
 * zwischen den Symbolen hält den Lauf unter der Grenze; mehr als
 * PROFIL_PRO_LAUF Symbole gibt es je Lauf nicht, der Rest kommt morgen
 * (Cursor im Stand-Dokument). Ein Fehlschlag lässt den alten Stand stehen.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { PROFIL_KLASSEN, allSymbols, budgetTag, profilHatInhalt } from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { type FetchLike, ProfilQuelleFehler, holeProfil } from '../core/profilQuelle.js';

/** Höchstens so viele Symbole je Lauf (3 Abrufe je Symbol). */
export const PROFIL_PRO_LAUF = 80;
/** Abstand zwischen zwei Symbolen — 3 Abrufe je 3,3 s ≈ 55/min, unter der 60er-Grenze. */
export const PROFIL_ABSTAND_MS = 3300;
/**
 * Zeitbudget je Lauf (Red-Team M1): 66 Symbole × 3,3 s sind 218 s Sockel;
 * mit Latenz und Timeouts (3 × 8 s je Symbol) reißt timeoutSeconds 540 —
 * und dann schreibt der Lauf weder Cursor noch Stand. Also selbst aufhören,
 * Cursor sichern, morgen weiter.
 */
export const PROFIL_ZEITBUDGET_MS = 450_000;
export const PROFIL_STAND_V = 2;

export interface ProfilSyncErgebnis {
  grund: string | null;
  /** HTTP-Status beim Abbruch (401 = Schlüssel ungültig, 403 = kein Zugriff, 429 = Drossel); null sonst. */
  status: number | null;
  geschrieben: number;
  leer: number;
  fehler: number;
  cursor: number;
}

const schluessel = (): string => (process.env.FINNHUB_API_KEY ?? '').trim();
const schlaf = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Stunde in New York (0–23) — Börsenschluss ist 16:00 ET. */
const etStunde = (d: Date): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d).find((t) => t.type === 'hour')?.value ?? 0);

/** Kandidaten: der Katalog der Profil-Klassen, deterministisch sortiert (Cursor-Rotation). */
export function profilKandidaten(): string[] {
  const out = new Set<string>();
  for (const cls of PROFIL_KLASSEN) for (const s of allSymbols(cls)) out.add(s);
  return [...out].sort();
}

export async function runProfilSync(
  now = new Date(),
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  abstandMs = PROFIL_ABSTAND_MS,
  uhr: () => number = Date.now,
): Promise<ProfilSyncErgebnis> {
  const db = getFirestore();
  const standRef = db.doc('meta/profilStand');
  const key = schluessel();
  const leer: ProfilSyncErgebnis = { grund: null, status: null, geschrieben: 0, leer: 0, fehler: 0, cursor: 0 };
  if (!key) {
    await standRef.set({ at: now.toISOString(), grund: 'keine_schluessel', v: PROFIL_STAND_V }, { merge: true });
    logger.info('Profil: kein FINNHUB_API_KEY in der Umgebung — übersprungen');
    return { ...leer, grund: 'keine_schluessel' };
  }
  const kandidaten = profilKandidaten();
  if (kandidaten.length === 0) return { ...leer, grund: 'keine_kandidaten' };
  const vorher = await standRef.get().catch(() => null);
  const cursorAlt = ((vorher?.get('cursor') as number | undefined) ?? 0) % kandidaten.length;
  // Kalendertag und Tageszeit in New York (Red-Team M3): 17:45 ET ist nach
  // Schluss, ein Termin von heute also vorbei; 22:30 ET ist noch derselbe Tag.
  const heute = budgetTag(now);
  const nachSchluss = etStunde(now) >= 16;
  const beginn = uhr();
  let geschrieben = 0;
  let leerZahl = 0;
  let fehler = 0;
  let grund: string | null = null;
  let status: number | null = null;
  let i = 0;
  for (; i < Math.min(PROFIL_PRO_LAUF, kandidaten.length); i += 1) {
    if (uhr() - beginn > PROFIL_ZEITBUDGET_MS) {
      grund = 'zeit';
      break;
    }
    const sym = kandidaten[(cursorAlt + i) % kandidaten.length]!;
    try {
      // Yahoo-52W-Hoch aus Teil 1 als Plausibilitätsanker (Red-Team H2).
      const alt = await db.doc(`market/${sym}`).get();
      const yahooW52Hoch = alt.exists ? ((alt.get('kennzahlen.w52Hoch') as number | null | undefined) ?? null) : null;
      const profil = await holeProfil(sym, key, heute, fetchImpl, now.toISOString(), { nachSchluss, yahooW52Hoch });
      if (!profilHatInhalt(profil)) {
        leerZahl += 1;
      } else {
        await db.doc(`market/${sym}`).set({ profil }, { merge: true });
        geschrieben += 1;
      }
    } catch (err) {
      fehler += 1;
      // Drossel (429) oder ungültiger Schlüssel (401): weiterzumachen hieße,
      // das Kontingent zu verbrennen — Grund festhalten, morgen weiter. Ein
      // 403 ist bei Finnhub auch SYMBOLBEZOGEN (Papier nicht im Gratis-Tarif);
      // als Abbruch parkte der Cursor dauerhaft auf diesem Symbol (Red-Team
      // H1). Deshalb: 403 nur am ersten Symbol des Laufs als Schlüsselproblem
      // werten, sonst zählen und weitergehen.
      if (err instanceof ProfilQuelleFehler && (err.grund === 'rate_limit' || (err.grund === 'kein_zugriff' && (err.status === 401 || i === 0)))) {
        grund = err.grund;
        status = err.status ?? null;
        break;
      }
      // Der Schlüssel steht nie in der Meldung — der Adapter nennt nur den Grund.
      logger.warn(`Profil ${sym}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160));
    }
    if (i + 1 < Math.min(PROFIL_PRO_LAUF, kandidaten.length)) await schlaf(abstandMs);
  }
  const cursor = (cursorAlt + i) % kandidaten.length;
  await standRef.set(
    {
      at: now.toISOString(),
      grund,
      status,
      // Erster Live-Lauf 08.10.: kein_zugriff am ERSTEN Symbol, obwohl derselbe
      // Schlüssel von Hand 200 liefert — der Wert im Secret Manager wich ab.
      // Nur Metadaten (nie der Wert): Länge und ob er wie ein Finnhub-Schlüssel
      // aussieht (Kleinbuchstaben/Ziffern), damit Anführungszeichen, Präfix
      // „FINNHUB_API_KEY=" oder Leerzeichen im Stand sichtbar werden.
      schluessel: { laenge: key.length, form: /^[a-z0-9]{20,64}$/.test(key) },
      geschrieben,
      leer: leerZahl,
      fehler,
      cursor,
      kandidaten: kandidaten.length,
      dauerMs: uhr() - beginn,
      v: PROFIL_STAND_V,
    },
    { merge: true },
  );
  logger.info(`Profil: ${geschrieben} geschrieben, ${leerZahl} leer, ${fehler} Fehler${grund ? `, Grund ${grund}${status ? ` (HTTP ${status})` : ''}` : ''}`);
  if (grund === 'kein_zugriff') {
    logger.warn(`Profil: Finnhub verweigert den Zugriff (HTTP ${status ?? '?'}); Schlüssel-Form ${/^[a-z0-9]{20,64}$/.test(key) ? 'plausibel' : 'UNPLAUSIBEL'} (Länge ${key.length}) — Wert im Secret Manager prüfen`);
  }
  return { grund, status, geschrieben, leer: leerZahl, fehler, cursor };
}

/** Täglich 17:45 ET (Mo–Fr) — nach dem Universum-Lauf, vor dem Momentum-Lauf. */
export const profilSync = onSchedule(
  {
    schedule: '45 17 * * 1-5',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 540,
    memory: '512MiB',
    /* Gebunden, nachdem der Owner das Secret am 08.10. angelegt hat; die
     * Deploy-Diagnose führt es seit demselben Commit in ihrer Liste. Ein
     * gebundenes Secret, das nicht existiert, bricht den GESAMTEN
     * Functions-Deploy — deshalb steht es auch dort. */
    secrets: ['FINNHUB_API_KEY'],
  },
  async () => {
    await runProfilSync();
  },
);

/** Emulator-Trigger für die lokale Abnahme — im Projekt gesperrt. */
export const profilSyncNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'profilSyncNow ist nur im Emulator verfügbar' });
    return;
  }
  res.json(await runProfilSync());
});
