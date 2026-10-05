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
  naechsterCursor,
  normalisiereNachricht,
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

export interface SammelErgebnis {
  grund: null | 'keine_schluessel' | 'fehler';
  gelesen: number;
  brauchbar: number;
  neu: number;
  seiten: number;
  abgeschnitten: boolean;
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

/** Der Datensatz, wie er in `marktNachrichten/{id}` steht — pur. */
export function nachrichtenDatensatz(
  n: MarktNachricht,
  firstSeenAt: string,
  kurse: Readonly<Record<string, GesehenerKurs>>,
): Record<string, unknown> {
  const kurseGesehen: Record<string, GesehenerKurs> = {};
  for (const s of n.symbole) if (kurse[s]) kurseGesehen[s] = kurse[s]!;
  return { ...n, v: MARKT_NACHRICHT_V, quelle: 'alpaca', firstSeenAt, kurseGesehen };
}

export async function runNachrichtenSammeln(
  fetchImpl: FetchLike = fetch,
  jetzt: () => Date = () => new Date(),
): Promise<SammelErgebnis> {
  const db = getFirestore();
  const standRef = db.doc('meta/nachrichtenStand');
  const leer: SammelErgebnis = { grund: null, gelesen: 0, brauchbar: 0, neu: 0, seiten: 0, abgeschnitten: false };

  const k = envSchluessel();
  if (!k) {
    await standRef.set({ letzterLauf: jetzt().toISOString(), grund: 'keine_schluessel' }, { merge: true });
    return { ...leer, grund: 'keine_schluessel' };
  }

  try {
    const stand = await standRef.get();
    const alterCursor = typeof stand.get('cursor') === 'string' ? (stand.get('cursor') as string) : null;
    const start = abrufStart(alterCursor, jetzt().getTime());
    const abruf = await holeNachrichten(k, start, fetchImpl, jetzt);

    const katalog = new Set(allSymbols());
    const universum = await ladeUniversumSymbole();
    const bekannt = (s: string): boolean => katalog.has(s) || universum.has(s);

    const brauchbar = new Map<string, { n: MarktNachricht; gesehenAt: string }>();
    let juengsteMs = Number.NEGATIVE_INFINITY;
    for (const { roh, gesehenAt } of abruf.roh) {
      const ms = Date.parse(String((roh as { created_at?: unknown } | null)?.created_at ?? ''));
      if (Number.isFinite(ms) && ms > juengsteMs) juengsteMs = ms;
      const n = normalisiereNachricht(roh, bekannt);
      if (n && !brauchbar.has(n.id)) brauchbar.set(n.id, { n, gesehenAt });
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
    if (neu.length > 0) {
      const symbole = [...new Set(neu.flatMap((c) => c.n.symbole))];
      ({ kurse, fehler: kurseFehler } = await holeLetzteKurse(k, symbole, (s) => classify(s) === 'crypto', fetchImpl));
      if (kurseFehler.length > 0) logger.warn(`nachrichtenSammeln: Kurse unvollständig — ${kurseFehler[0]}`);
    }

    for (let i = 0; i < neu.length; i += BATCH_GROESSE) {
      const batch = db.batch();
      for (const c of neu.slice(i, i + BATCH_GROESSE)) {
        batch.create(db.doc(`marktNachrichten/${c.n.id}`), nachrichtenDatensatz(c.n, c.gesehenAt, kurse));
      }
      await batch.commit();
    }

    const juengsteGelesen = Number.isFinite(juengsteMs) ? new Date(juengsteMs).toISOString() : null;
    await standRef.set(
      {
        cursor: naechsterCursor(alterCursor, abruf.abrufAt, abruf.abgeschnitten, juengsteGelesen),
        letzterLauf: jetzt().toISOString(),
        letzterErfolg: jetzt().toISOString(),
        grund: null,
        fehler: FieldValue.delete(),
        fehlerFolge: 0,
        gelesen: abruf.roh.length,
        brauchbar: brauchbar.size,
        neu: neu.length,
        seiten: abruf.seiten,
        abgeschnitten: abruf.abgeschnitten,
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
      seiten: abruf.seiten,
      abgeschnitten: abruf.abgeschnitten,
    };
  } catch (err) {
    const text = keineSchluesselImText((err as Error).message ?? String(err)).slice(0, 300);
    logger.warn(`nachrichtenSammeln: ${text}`);
    await standRef
      .set(
        { letzterLauf: jetzt().toISOString(), grund: 'fehler', fehler: text, fehlerFolge: FieldValue.increment(1) },
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
    timeoutSeconds: 120,
    memory: '256MiB',
    /* Dieselben Plattform-Schlüssel wie universumSync — dort seit 15.08.
     * gebunden und von der Deploy-Diagnose als vorhanden bestätigt. Ein
     * gebundenes Secret, das nicht existiert, bräche den GESAMTEN Deploy. */
    secrets: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
  },
  async () => {
    const r = await runNachrichtenSammeln();
    logger.info(
      `nachrichtenSammeln: ${r.neu} neu von ${r.brauchbar} brauchbaren (${r.gelesen} gelesen, ${r.seiten} Seiten`
        + `${r.abgeschnitten ? ', abgeschnitten' : ''})${r.grund ? ` — ${r.grund}` : ''}`,
    );
  },
);
