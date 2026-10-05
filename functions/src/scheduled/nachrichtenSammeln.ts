/**
 * nachrichtenSammeln — alle fünf Minuten den Alpaca-Nachrichtenstrom in die
 * append-only Sammlung `marktNachrichten/{id}` übernehmen (KI-Kaskade,
 * Stufe 1, 05.10.).
 *
 * ── Append-only, und warum das die halbe Messung ist ──────────────────────
 *
 * Jede Meldung wird GENAU EINMAL geschrieben — mit `create`, nach einem
 * `getAll`, das die schon vorhandenen aussortiert. Ein späterer Lauf, der
 * dieselbe Meldung noch einmal liest (Überlappung, Nachreichung, geänderte
 * Zusammenfassung), lässt sie unangetastet. Damit ist `firstSeenAt` wirklich
 * der ERSTE Moment, in dem wir die Meldung hatten, und kein Lauf kann ihn
 * nachträglich verschieben. Würde man überschreiben, wanderte `firstSeenAt`
 * mit jeder Wiederholung nach hinten, und jede spätere Auswertung „wie hat
 * der Kurs NACH dem Sehen reagiert" hätte den Kursverlauf zwischen dem
 * echten und dem verschobenen Sehen stillschweigend als Vorwissen.
 *
 * `create` ist dabei die zweite Sicherung: Liefe doch einmal ein zweiter Lauf
 * parallel, scheitert dessen Batch, statt Meldungen zu überschreiben — und der
 * Cursor rückt nur nach einem erfolgreichen Commit, die Meldungen kommen im
 * nächsten Lauf also wieder.
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Keine Bewertung, kein Sentiment, keine Order, kein KI-Token. Die Sammlung
 * ist server-only (Catch-all in firestore.rules); öffentlich lesbar ist nur
 * der Stand in `meta/nachrichtenStand` mit Zählern und Cursor, ohne Konto-
 * oder Nutzerbezug.
 */

import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { allSymbols, classify } from '../../../shared/src/index.js';
import { envSchluessel, keineSchluesselImText, type FetchLike } from '../core/alpacaBroker.js';
import {
  abrufStart,
  holeLetzteKurse,
  holeNachrichten,
  juengsteAchsenZeit,
  normalisiereNachricht,
  spaeterer,
  NACHRICHT_MAX_ALTER_MS,
  NACHZUEGLER_AB_MS,
  type GesehenerKurs,
  type MarktNachricht,
} from '../core/alpacaNews.js';
import { ladeUniversumSymbole } from '../core/universumLeser.js';

/** Fassung des Datensatzes — ändert sich die Form, ändert sich die Zahl. */
export const MARKT_NACHRICHT_V = 1;

/** Firestore erlaubt 500 Schreibvorgänge je Batch; Luft für Erweiterungen. */
const BATCH_GROESSE = 400;
/** `getAll` mit sehr vielen Referenzen auf einmal ist unnötig riskant. */
const LESE_GROESSE = 300;
/** Ab Laufbeginn: danach keine Kursabfragen mehr (Timeout 180 s, Commit geht vor). */
export const KURS_FRIST_MS = 100_000;
/**
 * Nach so vielen Fehlschlägen in Folge wird eine Fortsetzung doch verworfen
 * (eine Stunde bei 5-min-Takt). Bis dahin gilt: Das Token ist eine Position,
 * eine Störung kein Grund, sie aufzugeben. Danach liest der Sammler ab dem
 * Cursor neu — doppelt gelesen kostet nur Lesezugriffe.
 */
export const FORTSETZUNG_MAX_FEHLER = 12;

export interface SammelErgebnis {
  grund: null | 'keine_schluessel' | 'fehler';
  gelesen: number;
  brauchbar: number;
  neu: number;
  zuAlt: number;
  seiten: number;
  abgeschnitten: boolean;
}

/** Eine gespeicherte Fortsetzung: dieselbe Abfrage, ab diesem Seiten-Token. */
export interface Fortsetzung {
  start: string;
  token: string;
  /** Größte bisher in diesem Durchgang gelesene Achsen-Zeit. */
  bis: string | null;
  /** Wann die Kette begann — wie lange der Sammler schon hinterherläuft. */
  seit: string | null;
}

/** Fortsetzung aus dem Stand-Dokument lesen — fremde Formen gelten als keine. */
export function leseFortsetzung(roh: unknown): Fortsetzung | null {
  const f = (roh ?? null) as Record<string, unknown> | null;
  if (!f || typeof f['start'] !== 'string' || typeof f['token'] !== 'string' || f['token'].length === 0) return null;
  if (!Number.isFinite(Date.parse(f['start']))) return null;
  return {
    start: f['start'],
    token: f['token'],
    bis: typeof f['bis'] === 'string' ? f['bis'] : null,
    seit: typeof f['seit'] === 'string' ? f['seit'] : null,
  };
}

/** Median in Sekunden zwischen Veröffentlichung und erstem Sehen — pur. */
export function verzoegerungMedianS(
  neu: ReadonlyArray<{ publishedAt: string; firstSeenAt: string }>,
): number | null {
  const werte = neu
    .map((n) => (Date.parse(n.firstSeenAt) - Date.parse(n.publishedAt)) / 1000)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (werte.length === 0) return null;
  const m = Math.floor(werte.length / 2);
  return Math.round(werte.length % 2 === 1 ? werte[m]! : (werte[m - 1]! + werte[m]!) / 2);
}

/**
 * Der Datensatz, wie er in `marktNachrichten/{id}` steht — pur (ohne die
 * Server-Zeit `gespeichertAt`, die der Aufrufer beim Commit setzt).
 *
 * `alterS` je Kurs = `firstSeenAt − Trade-Zeit` in Sekunden: positiv heißt,
 * der Trade lag VOR dem ersten Sehen; negativ, er kam erst danach (Blättern
 * und Kursabfrage brauchen Sekunden) — dann zeigt der Kurs schon ein Stück
 * Reaktion und taugt nicht als „Stand beim Sehen".
 */
export function nachrichtenDatensatz(
  n: MarktNachricht,
  firstSeenAt: string,
  kurse: Readonly<Record<string, GesehenerKurs>>,
  kurseAbgefragtAt: string | null,
): Record<string, unknown> {
  const kurseGesehen: Record<string, GesehenerKurs & { alterS: number | null }> = {};
  const gesehenMs = Date.parse(firstSeenAt);
  for (const s of n.symbole) {
    const k = kurse[s];
    if (!k) continue;
    const alter = (gesehenMs - Date.parse(k.t)) / 1000;
    kurseGesehen[s] = { ...k, alterS: Number.isFinite(alter) ? Math.round(alter) : null };
  }
  return {
    ...n,
    v: MARKT_NACHRICHT_V,
    quelle: 'alpaca',
    firstSeenAt,
    nachzuegler: Date.parse(firstSeenAt) - Date.parse(n.publishedAt) > NACHZUEGLER_AB_MS,
    kurseAbgefragtAt,
    kurseGesehen,
  };
}

export async function runNachrichtenSammeln(
  fetchImpl: FetchLike = fetch,
  jetzt: () => Date = () => new Date(),
): Promise<SammelErgebnis> {
  const db = getFirestore();
  const standRef = db.doc('meta/nachrichtenStand');
  const leer: SammelErgebnis = {
    grund: null, gelesen: 0, brauchbar: 0, neu: 0, zuAlt: 0, seiten: 0, abgeschnitten: false,
  };

  const k = envSchluessel();
  if (!k) {
    await standRef.set({ letzterLauf: jetzt().toISOString(), grund: 'keine_schluessel' }, { merge: true });
    return { ...leer, grund: 'keine_schluessel' };
  }

  const laufBeginn = jetzt().getTime();
  let fort: Fortsetzung | null = null;
  let fehlerFolgeVorher = 0;
  try {
    const stand = await standRef.get();
    const alterCursor = typeof stand.get('cursor') === 'string' ? (stand.get('cursor') as string) : null;
    fort = leseFortsetzung(stand.get('fortsetzung'));
    fehlerFolgeVorher = Number(stand.get('fehlerFolge') ?? 0) || 0;
    // Abgeschnittener Vorlauf → DIESELBE Abfrage ab dem gemerkten Token.
    // Sonst eine neue ab Cursor minus Überlappung.
    const abfrage = fort
      ? { start: fort.start, token: fort.token }
      : { start: abrufStart(alterCursor, jetzt().getTime()), token: null };
    const abruf = await holeNachrichten(k, abfrage, fetchImpl, jetzt);
    if (abruf.fehler) logger.warn(`nachrichtenSammeln: Blättern unterbrochen — ${abruf.fehler.slice(0, 200)}`);

    const katalog = new Set(allSymbols());
    const universum = await ladeUniversumSymbole();
    // Für den HANDEL heißt ein leeres Universum „nur Katalog" — sicher. Für
    // die MESSUNG hieße es: alle Universums-Meldungen still verwerfen und
    // den Cursor an ihnen vorbeiziehen (Red-Team 05.10.). Also pausieren —
    // als Fehler, damit Cursor und Fortsetzung stehen bleiben.
    if (universum.size === 0) throw new Error('Universum leer — Sammeln pausiert, bis universumSync gelaufen ist');
    const bekannt = (s: string): boolean => katalog.has(s) || universum.has(s);

    const brauchbar = new Map<string, { n: MarktNachricht; gesehenAt: string }>();
    let zuAlt = 0;
    for (const { roh, gesehenAt } of abruf.roh) {
      const n = normalisiereNachricht(roh, bekannt);
      if (!n || brauchbar.has(n.id)) continue;
      if (Date.parse(gesehenAt) - Date.parse(n.publishedAt) > NACHRICHT_MAX_ALTER_MS) {
        zuAlt += 1;
        continue;
      }
      brauchbar.set(n.id, { n, gesehenAt });
    }

    // Schon gespeicherte aussortieren — sie bleiben, wie sie sind.
    const kandidaten = [...brauchbar.values()];
    const vorhanden = new Set<string>();
    for (let i = 0; i < kandidaten.length; i += LESE_GROESSE) {
      const refs = kandidaten.slice(i, i + LESE_GROESSE).map((c) => db.doc(`marktNachrichten/${c.n.id}`));
      if (refs.length === 0) continue;
      for (const snap of await db.getAll(...refs)) if (snap.exists) vorhanden.add(snap.id);
    }
    const neu = kandidaten.filter((c) => !vorhanden.has(c.n.id));

    // Kurs beim ersten Sehen — best effort, kostet nie die Meldung.
    let kurse: Record<string, GesehenerKurs> = {};
    let kurseFehler: string[] = [];
    let kurseAbgefragtAt: string | null = null;
    if (neu.length > 0) {
      const symbole = [...new Set(neu.flatMap((c) => c.n.symbole))];
      kurseAbgefragtAt = jetzt().toISOString();
      ({ kurse, fehler: kurseFehler } = await holeLetzteKurse(k, symbole, (s) => classify(s) === 'crypto', fetchImpl, {
        bisMs: laufBeginn + KURS_FRIST_MS,
        jetzt: () => jetzt().getTime(),
      }));
      if (kurseFehler.length > 0) logger.warn(`nachrichtenSammeln: Kurse unvollständig — ${kurseFehler[0]}`);
    }

    for (let i = 0; i < neu.length; i += BATCH_GROESSE) {
      const batch = db.batch();
      for (const c of neu.slice(i, i + BATCH_GROESSE)) {
        batch.create(db.doc(`marktNachrichten/${c.n.id}`), {
          ...nachrichtenDatensatz(c.n, c.gesehenAt, kurse, kurseAbgefragtAt),
          gespeichertAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }

    // Cursor und Fortsetzung erst NACH den Commits: Scheitert einer, bleibt
    // der Stand, und der nächste Lauf liest dieselben Meldungen erneut.
    const gelesenBis = spaeterer(
      fort?.bis ?? null,
      juengsteAchsenZeit(abruf.roh.map((r) => r.roh), Date.parse(abruf.abrufAt)),
    );
    const abgeschnitten = abruf.weiter !== null;
    const neuerCursor = abgeschnitten ? alterCursor : spaeterer(alterCursor, gelesenBis);
    // Wie weit der Sammler hinter der Gegenwart liegt — die Größe, an der
    // ein Stillstand sichtbar wird, auch wenn jeder Lauf „erfolgreich" ist.
    const stehtBei = abgeschnitten ? (gelesenBis ?? alterCursor) : neuerCursor;
    const rueckstandS = stehtBei ? Math.max(0, Math.round((jetzt().getTime() - Date.parse(stehtBei)) / 1000)) : null;
    await standRef.set(
      {
        ...(abgeschnitten
          ? {
            fortsetzung: {
              start: abfrage.start,
              token: abruf.weiter,
              bis: gelesenBis,
              seit: fort?.seit ?? new Date(laufBeginn).toISOString(),
            },
          }
          : { fortsetzung: FieldValue.delete(), cursor: neuerCursor }),
        letzterLauf: jetzt().toISOString(),
        letzterErfolg: jetzt().toISOString(),
        grund: null,
        fehler: abruf.fehler ? keineSchluesselImText(abruf.fehler).slice(0, 160) : FieldValue.delete(),
        // Ein Lauf, dessen Blättern an einer Seite scheiterte, ist kein
        // sauberer Lauf — sonst pendelte der Zähler zwischen 0 und 1, und
        // eine anhaltende Störung bliebe unsichtbar.
        fehlerFolge: abruf.fehler ? FieldValue.increment(1) : 0,
        rueckstandS,
        gelesen: abruf.roh.length,
        brauchbar: brauchbar.size,
        neu: neu.length,
        zuAlt,
        seiten: abruf.seiten,
        abgeschnitten,
        kurseFehler: kurseFehler.length,
        verzoegerungMedianS: verzoegerungMedianS(neu.map((c) => ({ publishedAt: c.n.publishedAt, firstSeenAt: c.gesehenAt }))),
        neuGesamt: FieldValue.increment(neu.length),
      },
      { merge: true },
    );
    return {
      grund: null,
      gelesen: abruf.roh.length,
      brauchbar: brauchbar.size,
      neu: neu.length,
      zuAlt,
      seiten: abruf.seiten,
      abgeschnitten,
    };
  } catch (err) {
    const text = keineSchluesselImText((err as Error).message ?? String(err)).slice(0, 160);
    logger.warn(`nachrichtenSammeln: ${text}`);
    // Die Fortsetzung BLEIBT bei Störungen (Netz, 5xx, 429, Firestore): Der
    // nächste Lauf liest dieselbe Seite erneut. Gespeichert wurde in diesem
    // Lauf nichts, was ihr widerspräche — Cursor und Fortsetzung werden nur
    // nach erfolgreichem Commit fortgeschrieben. Verworfen wird nur, was
    // Alpaca als ungültig ablehnt, oder nach einer Stunde Fehlschlägen.
    const status = (err as { status?: unknown }).status;
    const verwerfen =
      fort !== null
      && (status === 400 || status === 422 || fehlerFolgeVorher + 1 >= FORTSETZUNG_MAX_FEHLER);
    await standRef
      .set(
        {
          letzterLauf: jetzt().toISOString(),
          grund: 'fehler',
          fehler: text,
          fehlerFolge: FieldValue.increment(1),
          // Kennzahlen dieses Laufs — nicht die des Vorlaufs stehen lassen.
          gelesen: 0,
          neu: 0,
          ...(verwerfen ? { fortsetzung: FieldValue.delete() } : {}),
        },
        { merge: true },
      )
      .catch(() => undefined);
    return { ...leer, grund: 'fehler' };
  }
}

/** Alle fünf Minuten, rund um die Uhr — Nachrichten kennen keine Börsenzeiten. */
export const nachrichtenSammeln = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 180,
    memory: '256MiB',
    /* Dieselben Plattform-Schlüssel wie universumSync — dort seit 15.08.
     * gebunden und von der Deploy-Diagnose als vorhanden bestätigt. Ein
     * gebundenes Secret, das nicht existiert, bräche den GESAMTEN Deploy. */
    secrets: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
  },
  async () => {
    const r = await runNachrichtenSammeln();
    logger.info(
      `nachrichtenSammeln: ${r.neu} neu von ${r.brauchbar} brauchbaren (${r.gelesen} gelesen, ${r.zuAlt} zu alt, `
        + `${r.seiten} Seiten${r.abgeschnitten ? ', abgeschnitten' : ''})${r.grund ? ` — ${r.grund}` : ''}`,
    );
  },
);
