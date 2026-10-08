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
import { PROFIL_KLASSEN, allSymbols, profilHatInhalt } from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { type FetchLike, ProfilQuelleFehler, holeProfil } from '../core/profilQuelle.js';

/** Höchstens so viele Symbole je Lauf (3 Abrufe je Symbol). */
export const PROFIL_PRO_LAUF = 80;
/** Abstand zwischen zwei Symbolen — 3 Abrufe je 3,3 s ≈ 55/min, unter der 60er-Grenze. */
export const PROFIL_ABSTAND_MS = 3300;
export const PROFIL_STAND_V = 1;

export interface ProfilSyncErgebnis {
  grund: string | null;
  geschrieben: number;
  leer: number;
  fehler: number;
  cursor: number;
}

const schluessel = (): string => (process.env.FINNHUB_API_KEY ?? '').trim();
const schlaf = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
): Promise<ProfilSyncErgebnis> {
  const db = getFirestore();
  const standRef = db.doc('meta/profilStand');
  const key = schluessel();
  const leer: ProfilSyncErgebnis = { grund: null, geschrieben: 0, leer: 0, fehler: 0, cursor: 0 };
  if (!key) {
    await standRef.set({ at: now.toISOString(), grund: 'keine_schluessel', v: PROFIL_STAND_V }, { merge: true });
    logger.info('Profil: kein FINNHUB_API_KEY in der Umgebung — übersprungen');
    return { ...leer, grund: 'keine_schluessel' };
  }
  const kandidaten = profilKandidaten();
  if (kandidaten.length === 0) return { ...leer, grund: 'keine_kandidaten' };
  const vorher = await standRef.get().catch(() => null);
  const cursorAlt = ((vorher?.get('cursor') as number | undefined) ?? 0) % kandidaten.length;
  const heute = now.toISOString().slice(0, 10);
  const beginn = Date.now();
  let geschrieben = 0;
  let leerZahl = 0;
  let fehler = 0;
  let grund: string | null = null;
  let i = 0;
  for (; i < Math.min(PROFIL_PRO_LAUF, kandidaten.length); i += 1) {
    const sym = kandidaten[(cursorAlt + i) % kandidaten.length]!;
    try {
      const profil = await holeProfil(sym, key, heute, fetchImpl, now.toISOString());
      if (!profilHatInhalt(profil)) {
        leerZahl += 1;
      } else {
        await db.doc(`market/${sym}`).set({ profil }, { merge: true });
        geschrieben += 1;
      }
    } catch (err) {
      fehler += 1;
      if (err instanceof ProfilQuelleFehler && (err.grund === 'rate_limit' || err.grund === 'kein_zugriff')) {
        // Drossel oder gesperrter Schlüssel: weiterzumachen hieße, das
        // Kontingent zu verbrennen — Grund festhalten, morgen weiter.
        grund = err.grund;
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
      geschrieben,
      leer: leerZahl,
      fehler,
      cursor,
      kandidaten: kandidaten.length,
      dauerMs: Date.now() - beginn,
      v: PROFIL_STAND_V,
    },
    { merge: true },
  );
  logger.info(`Profil: ${geschrieben} geschrieben, ${leerZahl} leer, ${fehler} Fehler${grund ? `, Grund ${grund}` : ''}`);
  return { grund, geschrieben, leer: leerZahl, fehler, cursor };
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
