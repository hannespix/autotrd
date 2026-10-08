/**
 * evalForecasts — Self-Improvement-Loop (Port von forecast_eval.py).
 *
 * Täglich nach US-Börsenschluss: bewertet alle unbewerteten Prognosen, deren
 * LETZTER Horizont-Tag strikt vor heute liegt und dessen Close realisiert ist
 * (Lookahead-Gate in shared/forecast.ts — nie aufweichen), und schreibt die
 * globale Kombi-Statistik nach meta/forecastStats (Basis für best_params).
 */

import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_INTRADAY_LOOKBACK,
  FORECAST_V,
  INTRADAY_LOOKBACK_GRID,
  LOOKBACK_GRID,
  bestParams,
  comboKey,
  fallZahl,
  isForecastDue,
  isIntradayForecastDue,
  MIN_TOTAL_SCORES,
  scoreForecast,
  scoreIntradayForecast,
  sentimentHit,
  type ComboStat,
  type ForecastDoc,
  type IntradayForecastDoc,
} from '../../../shared/src/index.js';
import type { IntradayBar } from '../core/marketData.js';
import { getMarketSnapshot } from '../core/marketData.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

const BATCH_LIMIT = 200;

/* ── Messkorrektur (Red-Team 05.10., H1/H2) ───────────────────────────────
 *
 * H1 „Tagesbewertung verhungert": Der Tageslauf holte 200 unbewertete
 * Dokumente OHNE Sortierung — in Pfad-Reihenfolge, also die alphabetisch
 * ersten Symbole zuerst. Blieben die unbewertbar (Symbol ohne Snapshot,
 * End-Tag auf einem Feiertag, der nie als Kerze erscheint), füllten sie das
 * Limit jeden Werktag aufs Neue, und neuere Fälle kamen nie an die Reihe.
 * Derselbe Stau wie intraday am 27.07., nur langsamer. Zwei Gegenmittel,
 * beide aus dem Intraday-Pfad: nach Basistag sortieren (die Schlange
 * wandert) und das, was nach TAGES_VERFALL_TAGE immer noch nicht bewertbar
 * ist, verfallen lassen. Verfallen ist die KONSERVATIVE Richtung: Es wird
 * nie mit unvollständigen Daten bewertet, sondern gar nicht — das
 * Lookahead-Gate bleibt unangetastet.
 *
 * H2 „scored zählt Dokumente statt Fälle": `scored` war die Summe der n
 * über alle Lookback-Kombis — ein Fall (Symbol, Basistag) zählte dreifach,
 * und `accuracyWeightedVote` hielt 7 Fälle für 21 Messpunkte. Jetzt ist
 * `scored` die Zahl der FÄLLE (das größte n einer Kombi — alle Kombis sehen
 * dieselben Fälle, Batch-Grenzen können Geschwister höchstens um eins
 * versetzen). Die Trefferquote bleibt über die Arme gepoolt: Sie ist damit
 * frei von der Auswahl des besten Arms (kein Winner's Curse), nur die
 * Stichprobengröße ist jetzt ehrlich. Stimmrecht gibt es damit erst nach
 * 20 Fällen statt nach 7 — Guards nur verschärft. */
export const TAGES_VERFALL_TAGE = 30;

/**
 * Verfall OHNE Kursdaten (Red-Team B1): Scheitert der Snapshot, weiß der
 * Lauf nichts über den Fall — ein transienter Yahoo-Fehler darf dann keine
 * bewertbare Historie vernichten. Erst wenn der End-Tag so weit zurückliegt,
 * dass ein Symbol ohne Kursquelle schlicht tot ist, wird verfallen; bis
 * dahin wird übersprungen und im nächsten Lauf erneut versucht.
 */
export const TAGES_VERFALL_OHNE_KURSE_TAGE = 120;

/**
 * Verfall am KURSRASTER (Red-Team B2): `nextWeekdays` kennt keine
 * Feiertage. Fällt der End-Tag auf einen, erscheint er nie als Kerze — und
 * die Prognosen EINES Basistags aller Symbole (bis zu 120 Dokumente) stünden
 * 30 Kalendertage am Kopf der sortierten Schlange. Liegen bereits so viele
 * Kerzen NACH dem End-Tag vor, kommt er nicht mehr: Der Markt ist weiter.
 * Zwei statt eine, weil eine Yahoo-Lücke (null-Close) am Folgetag noch
 * geschlossen werden kann. Lookahead-neutral: Es wird nie gescort, nur
 * verfallen.
 */
export const KERZEN_NACH_ENDTAG = 2;

/** Ist der End-Tag einer Tages-Prognose so alt, dass er nie mehr als Kerze
 *  erscheinen wird? Kalendertage, UTC-Mitternacht, strikt größer. */
export function tagesPrognoseVerfallen(endTag: string, today: string, tage = TAGES_VERFALL_TAGE): boolean {
  const ende = Date.parse(`${endTag}T00:00:00Z`);
  const heute = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(ende) || !Number.isFinite(heute)) return false;
  return heute - ende > tage * 86_400_000;
}

/** Wie viele realisierte Kerzen liegen NACH dem End-Tag? (ISO-Datum, lexikalisch) */
export function kerzenNachEndTag(actuals: Record<string, number>, endTag: string): number {
  let n = 0;
  for (const [tag, close] of Object.entries(actuals)) if (tag > endTag && close > 0) n += 1;
  return n;
}

/**
 * Sentiment-Schatten (News-Rückkehr 29.07.): Trefferzählung „hätte das
 * News-Vorzeichen die Richtung getroffen?" je Zeitbasis nach
 * meta/sentimentStats. NUR Statistik — kein Stimmrecht, keine Rückkopplung
 * in Prognose oder Handel. Erst wenn diese Quote über genügend Stichproben
 * eine Kante über dem Münzwurf zeigt, darf ein späterer, eigener Umbau
 * daraus eine Stimme machen (dieselbe Beweislast wie beim Forecast-Vote).
 */
interface SentDelta {
  pos: { n: number; hits: number };
  neg: { n: number; hits: number };
}

const emptySentDelta = (): SentDelta => ({ pos: { n: 0, hits: 0 }, neg: { n: 0, hits: 0 } });

/**
 * Zählt dieser Prognose-Lookback für den Sentiment-Schatten? (Red-Team-Befund
 * 05.10.)
 *
 * Bis dahin zählte JEDES Prognose-Dokument — und davon gibt es je Symbol und
 * Basistag eines je Lookback (Tag: 10/20/30, intraday: 24/48). Alle tragen
 * dieselbe Nachrichtenlage, denselben Basiskurs und denselben End-Kurs:
 * dreimal derselbe Treffer. `n` war damit rund dreifach aufgebläht, und eine
 * Lernschleife auf dieser Zahl hätte Rauschen für Evidenz gehalten.
 *
 * Bewusst KEIN Merker im Speicher: Der Tageslauf holt 200 unbewertete
 * Dokumente (seit 08.10. nach Basistag sortiert), die Geschwister eines
 * Falls können an einer Batch-Grenze also in verschiedenen Läufen landen. Nur eine Regel am Dokument selbst zählt
 * laufübergreifend genau einmal — der kleinste Lookback des Gitters. Die
 * Geschwister entstehen gemeinsam oder gar nicht (alle Lookbacks brauchen
 * dieselben ≥ 5 Schlusskurse, geschrieben wird in einem Batch); fehlte der
 * Vertreter doch einmal, fehlte der Fall: ein verlorener Messpunkt statt
 * eines doppelten.
 */
export function vertrittSentimentFall(lookback: number, gitter: readonly number[]): boolean {
  return gitter.length > 0 && lookback === Math.min(...gitter);
}

export function tallySent(delta: SentDelta, sentSign: number | undefined, baseClose: number, actLast: number | undefined): void {
  const hit = sentimentHit(sentSign, baseClose, actLast);
  if (hit === null) return;
  const b = sentSign === 1 ? delta.pos : delta.neg;
  b.n += 1;
  b.hits += hit ? 1 : 0;
}

/**
 * Fassung der bereinigten Zählung. Ändert sich, was gezählt wird (Lexikon,
 * Schwellen, News-Fenster), muss diese Zahl steigen und der Zähler unter
 * neuem Namen beginnen — sonst addieren sich zwei Messungen in einem Feld,
 * genau der Fehler, den `einmalig` gerade behebt.
 */
export const SENT_SCHATTEN_V = 1;

async function writeSentStats(scope: 'daily' | 'intraday', delta: SentDelta): Promise<void> {
  if (delta.pos.n + delta.neg.n === 0) return;
  // Unter `einmalig` (05.10.): Die alten Felder `daily`/`intraday` zählten
  // jeden Fall je Lookback mehrfach und bleiben als Altbestand stehen —
  // korrekte und aufgeblähte Zahlen in einem Zähler wären keine Statistik.
  await getFirestore()
    .doc('meta/sentimentStats')
    .set(
      {
        updatedAt: new Date().toISOString(),
        altbestand: 'daily/intraday: bis 05.10. je Lookback mehrfach gezählt — nicht auswerten',
        einmalig: {
          v: SENT_SCHATTEN_V,
          [scope]: {
            pos: { n: FieldValue.increment(delta.pos.n), hits: FieldValue.increment(delta.pos.hits) },
            neg: { n: FieldValue.increment(delta.neg.n), hits: FieldValue.increment(delta.neg.hits) },
          },
        },
      },
      { merge: true },
    );
}

export interface EvalResult {
  scored: number;
  bestParams: { lookback: number };
  /** Diagnose (H1): offen geholt, davon fällig, verfallen, fällig-aber-unrealisiert. */
  pending: number;
  due: number;
  expired: number;
  unrealized: number;
}

/** Alle fälligen Prognosen bewerten; liefert Anzahl + neue best_params. */

/**
 * Zähler verwerfen, wenn sie aus einer ANDEREN Prognoserechnung stammen.
 *
 * `combos` wächst per `increment` und wird nie zurückgesetzt — richtig,
 * solange die Rechnung dieselbe bleibt. Nach einer Formeländerung addierten
 * sich sonst die Treffer zweier Rechnungen in denselben Zähler, dauerhaft
 * und unsichtbar (Begründung ausführlich bei `FORECAST_V`).
 *
 * Rein gehalten und exportiert, damit die Entscheidung prüfbar ist: Sie
 * verwirft im Zweifel Messdaten, und das darf nicht aus Versehen passieren.
 */
export function zaehlerVerwerfen(gespeichert: unknown, aktuell: number = FORECAST_V): boolean {
  // Fehlt der Marker, stammt der Stand aus der Zeit VOR ihm — also aus der
  // Rechnung, die bei seiner Einführung galt. Der gilt weiter.
  if (gespeichert === undefined || gespeichert === null) return false;
  return gespeichert !== aktuell;
}

/** Vor dem Fortschreiben: Stand prüfen, bei Fassungswechsel leeren. */
async function pruefeFassung(
  statsRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const snap = await statsRef.get();
  if (!snap.exists) return;
  if (!zaehlerVerwerfen(snap.get('forecastV'))) return;
  logger.warn(
    `${statsRef.path}: Prognoserechnung ist jetzt V${FORECAST_V} — Zähler werden verworfen, `
      + 'sie beantworten eine andere Frage',
  );
  await statsRef.set({ combos: {}, forecastV: FORECAST_V, scored: 0, dirAccuracy: null });
}

/**
 * Die Kombi-Zähler eines Symbols in den laufenden Batch legen.
 *
 * Eine Funktion für beide Pfade (Tag und Intraday): Zwei Kopien wären zwei
 * Gelegenheiten, sie verschieden zu ändern — und der Fehler fiele nicht auf,
 * weil beide Statistiken für sich plausibel aussähen.
 *
 * Kombi-Schlüssel enthalten Punkte ("0.5_20"). Als String-Pfad würde
 * Firestore daran verschachteln; `FieldPath`-Segmente sind literal. Deshalb
 * die variadische `update`-Form statt eines Objekts.
 */
function aggregatInBatch(
  batch: ReturnType<ReturnType<typeof getFirestore>['batch']>,
  statsRef: ReturnType<ReturnType<typeof getFirestore>['doc']>,
  delta: ReadonlyMap<string, ComboStat>,
): void {
  if (delta.size === 0) return;
  const args: unknown[] = [new FieldPath('updatedAt'), new Date().toISOString()];
  for (const [key, d] of delta) {
    args.push(new FieldPath('combos', key, 'n'), FieldValue.increment(d.n));
    args.push(new FieldPath('combos', key, 'hits'), FieldValue.increment(d.hits));
    args.push(new FieldPath('combos', key, 'maeSum'), FieldValue.increment(d.maeSum));
  }
  (batch.update as (...a: unknown[]) => unknown)(statsRef, ...args);
}

export async function evaluateDue(): Promise<EvalResult> {
  const db = getFirestore();
  const today = new Date().toISOString().slice(0, 10);

  // Nach Basistag sortiert — Begründung oben (H1) und im Intraday-Zwilling.
  const base = db.collectionGroup('forecasts').where('evaluated', '==', false);
  let pending;
  try {
    pending = await base.orderBy('baseDate', 'asc').limit(BATCH_LIMIT).get();
  } catch (err) {
    // Der zusammengesetzte Index (evaluated, baseDate) baut nach dem Deploy
    // ein paar Minuten — bis dahin unsortiert, nie gar nicht.
    logger.warn('evalForecasts: Index (evaluated, baseDate) noch nicht bereit — unsortiert', err);
    pending = await base.limit(BATCH_LIMIT).get();
  }

  // Fällige nach Symbol gruppieren (Actuals einmal pro Symbol holen)
  const dueBySymbol = new Map<string, Array<{ ref: FirebaseFirestore.DocumentReference; doc: ForecastDoc }>>();
  let due = 0;
  for (const snap of pending.docs) {
    const doc = snap.data() as ForecastDoc;
    if (!isForecastDue(doc.points, today)) continue;
    const symbol = snap.ref.parent.parent?.id;
    if (!symbol) continue;
    due += 1;
    const list = dueBySymbol.get(symbol) ?? [];
    list.push({ ref: snap.ref, doc });
    dueBySymbol.set(symbol, list);
  }

  let scored = 0;
  let expired = 0;
  let unrealized = 0;
  const sentDelta = emptySentDelta();
  const endTagVon = (doc: ForecastDoc): string => doc.points[doc.points.length - 1]!.time;

  /* Das Aggregat wird JE SYMBOL fortgeschrieben, im selben Batch wie die
   * `evaluated`-Marker (Audit-Befund 11.08.).
   *
   * Vorher setzte jeder Symbol-Commit die Marker, und `comboDelta` sammelte
   * die Treffer nur im Speicher — geschrieben wurde erst nach ALLEN Symbolen.
   * Bricht der Lauf dazwischen ab (der Intraday-Zwilling läuft huckepack im
   * Scan und teilt sich dessen 180-s-Timeout), tragen die schon bearbeiteten
   * Prognosen dauerhaft `evaluated: true`, ihre Treffer erreichen die
   * Statistik aber nie. `dirAccuracy` wird dann über eine verzerrte Teilmenge
   * gerechnet — und genau diese Zahl steuert über `accuracyWeightedVote` das
   * Stimmgewicht der Prognose im HANDEL. Nachholbar ist der Verlust nicht,
   * und er hinterlässt keine Spur.
   *
   * Der Preis sind ein paar Schreibvorgänge mehr auf ein Dokument statt einem
   * — `FieldValue.increment` ist genau dafür gebaut. Die umgekehrte
   * Reihenfolge (erst Aggregat, dann Marker) wäre schlechter: Sie tauschte
   * verlorene gegen doppelt gezählte Treffer.
   *
   * `pruefeFassung` und das Anlegen müssen deshalb VOR die Schleife —
   * `update` scheitert auf einem fehlenden Dokument.
   *
   * `sentDelta` bleibt bewusst, wie es war: reine Schatten-Statistik ohne
   * Handelswirkung. Ein Verlust dort kostet Messpunkte, keine Trades. */
  const statsRef = db.doc('meta/forecastStats');
  await pruefeFassung(statsRef);
  await statsRef.set({}, { merge: true });

  for (const [symbol, entries] of dueBySymbol) {
    let actuals: Record<string, number>;
    try {
      const snap = await getMarketSnapshot(symbol, '6mo');
      actuals = Object.fromEntries(snap.bars.map((b) => [b.date, b.close]));
    } catch (err) {
      logger.warn(`evalForecasts: keine Actuals für ${symbol}`, err);
      // Ohne Snapshot weiß der Lauf NICHTS über den Fall — ein transienter
      // Fehler darf keine bewertbare Historie vernichten (Red-Team B1).
      // Nur ein seit TAGES_VERFALL_OHNE_KURSE_TAGE totes Symbol verfällt,
      // damit es nicht ewig am Kopf der Schlange steht; alles andere wird im
      // nächsten Lauf erneut versucht.
      const tot = entries.filter(({ doc }) =>
        tagesPrognoseVerfallen(endTagVon(doc), today, TAGES_VERFALL_OHNE_KURSE_TAGE),
      );
      if (tot.length > 0) {
        const batch = db.batch();
        for (const { ref } of tot) batch.update(ref, { evaluated: true, expired: true });
        const ok = await batch
          .commit()
          .then(() => true)
          .catch((e) => {
            logger.warn('evalForecasts: Verfall nicht geschrieben', e);
            return false;
          });
        if (ok) expired += tot.length;
      }
      continue;
    }

    const batch = db.batch();
    const symbolDelta = new Map<string, ComboStat>();
    for (const { ref, doc } of entries) {
      const score = scoreForecast(doc.points, doc.baseClose, actuals);
      const endTag = endTagVon(doc);
      if (!score) {
        // End-Tag (noch) nicht realisiert → später erneut. Verfallen, wenn
        // der Markt schon KERZEN_NACH_ENDTAG Kerzen weiter ist (Feiertag als
        // End-Tag, Red-Team B2) oder die Kalenderfrist um ist. NIEMALS mit
        // unvollständigen Daten scoren.
        if (kerzenNachEndTag(actuals, endTag) >= KERZEN_NACH_ENDTAG || tagesPrognoseVerfallen(endTag, today)) {
          batch.update(ref, { evaluated: true, expired: true });
          expired += 1;
        } else {
          unrealized += 1;
        }
        continue;
      }
      const sentVertreter = vertrittSentimentFall(doc.lookback, LOOKBACK_GRID);
      // Der Treffer je FALL steht am Vertreter — aus Zählern allein ließe
      // sich später keine Abhängigkeit zwischen Nachbartagen herausrechnen.
      const sentHit = sentVertreter ? sentimentHit(doc.sentSign, doc.baseClose, actuals[endTag]) : null;
      batch.update(ref, {
        evaluated: true,
        evaluatedAt: new Date().toISOString(),
        maePct: score.maePct,
        dirHit: score.dirHit,
        nPoints: score.nPoints,
        ...(sentHit === null ? {} : { sentHit }),
      });
      const key = comboKey(doc.lookback);
      const d = symbolDelta.get(key) ?? { n: 0, hits: 0, maeSum: 0 };
      d.n += 1;
      d.hits += score.dirHit ? 1 : 0;
      d.maeSum += score.maePct;
      symbolDelta.set(key, d);
      // Sentiment-Schatten: nur bewertete Prognosen — dieselben Gates, ein
      // Fall je (Symbol, Basistag).
      if (sentVertreter) {
        tallySent(sentDelta, doc.sentSign, doc.baseClose, actuals[endTag]);
      }
      scored += 1;
    }
    aggregatInBatch(batch, statsRef, symbolDelta);
    await batch.commit();
  }
  await writeSentStats('daily', sentDelta).catch((err) => logger.warn('sentimentStats daily', err));

  const combos =
    ((await statsRef.get()).get('combos') as Record<string, ComboStat> | undefined) ?? {};
  const bp = bestParams(combos);
  // H2: `scored` = Fälle, Trefferquote über die Arme gepoolt (Begründung oben).
  const faelle = fallZahl(combos);
  const total = Object.values(combos).reduce((s, d) => s + d.n, 0);
  const hits = Object.values(combos).reduce((s, d) => s + d.hits, 0);
  await statsRef.set(
    {
      best: bp,
      scored: faelle,
      dirAccuracy: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
      tuningActive: faelle >= MIN_TOTAL_SCORES,
    },
    { merge: true },
  );

  logger.info(
    `evalForecasts: ${scored} bewertet, ${expired} verfallen, ${unrealized} unrealisiert, bester Lookback=${bp.lookback}`,
  );
  return { scored, bestParams: bp, pending: pending.size, due, expired, unrealized };
}

/* ── Intraday-Eval (Prognose 2.0 Teil 2) ─────────────────────────────────────
 * Läuft huckepack in JEDEM Scan (Horizonte realisieren binnen einer Stunde —
 * das tägliche 16:30-Fenster wäre viel zu träge). Gate: Bar-realisiert
 * (isIntradayForecastDue) + realisierter End-Close (scoreIntradayForecast).
 * Unbewertbar verfallene Prognosen (Session-Ende vor Horizont, Halts) werden
 * nach EXPIRE_SEC als expired markiert — sie zählen NICHT in die Statistik,
 * dürfen aber die Pending-Query nicht ewig verstopfen. */

const INTRADAY_BATCH_LIMIT = 150;
/**
 * Verfallsfenster für Kurzfrist-Prognosen: 12 Stunden.
 *
 * Vorher standen hier 3 Tage — viel zu lang. Eine Prognose über EINE Stunde,
 * die zwölf Stunden später immer noch keinen realisierten End-Close hat,
 * bekommt auch keinen mehr; der Bar ist längst geschrieben oder er kommt nie.
 * Das lange Fenster war mitverantwortlich für den Stillstand vom 27.07.: Die
 * Batch-Abfrage zog immer wieder dieselben unbewertbaren Altlasten, die weder
 * bewertet noch verworfen werden konnten (`unrealized: 126, expired: 0`).
 *
 * Verfallen ist dabei die KONSERVATIVE Richtung — es wird nie mit
 * unvollständigen Daten bewertet, sondern gar nicht.
 */
const INTRADAY_EXPIRE_SEC = 12 * 3600;

/**
 * Tages-Dokumente mit 5-min-Bars, aus denen die realisierten Closes kommen
 * (t→close). Sortierung über das `date`-FELD — Firestore kann keine
 * absteigenden Doc-ID-Scans (gleiche Falle wie bei den indicators-Docs).
 *
 * Acht statt drei: Die Tage werden nur geschrieben, wenn an ihnen auch
 * gescannt wurde. Über ein Wochenende oder eine Scan-Lücke hinweg deckten
 * drei Dokumente das Verfallsfenster nicht ab — die dazugehörigen Prognosen
 * blieben dann dauerhaft unbewertbar, obwohl ihre Bars längst existierten.
 */
const ACTUAL_DAY_DOCS = 8;

async function loadIntradayActuals(symbol: string): Promise<Record<string, number>> {
  const snap = await getFirestore()
    .collection('market')
    .doc(symbol)
    .collection('ohlc5m')
    .orderBy('date', 'desc')
    .limit(ACTUAL_DAY_DOCS)
    .get();
  const actuals: Record<string, number> = {};
  for (const doc of snap.docs) {
    for (const bar of (doc.get('bars') as IntradayBar[] | undefined) ?? []) {
      if (bar.c > 0) actuals[String(bar.t)] = bar.c;
    }
  }
  return actuals;
}

/**
 * Ergebnis eines Intraday-Bewertungslaufs.
 *
 * `scored` allein reicht zur Diagnose NICHT — genau daran hing der Befund vom
 * 27.07.: Die Kennzahl stand tagelang auf 0, während gleichzeitig 31
 * Prognosen entstanden. Aus einer 0 lässt sich nicht ablesen, WORAN es lag:
 * keine offenen Prognosen? keine fällig? keine realisierten Kurse? Die
 * Zwischenstände unten beantworten das von außen, ohne Cloud-Logging.
 */
export interface IntradayEvalResult {
  /** Offene (unbewertete) Prognosen, die die Abfrage gefunden hat. */
  pending: number;
  /** Davon fällig — letzter Horizont-Bar liegt in der Vergangenheit. */
  due: number;
  /** Davon bewertet — der End-Close war tatsächlich realisiert. */
  scored: number;
  /** Fällig, aber der End-Bar wird nie realisiert (Session-Ende/Halt). */
  expired: number;
  /**
   * Fällig, aber (noch) nicht bewertbar: Der End-Close fehlt in den
   * gespeicherten 5-min-Bars. Steht diese Zahl dauerhaft hoch, stimmt etwas
   * zwischen Prognose-Raster und Kursraster nicht — und NICHT mit dem Gate.
   */
  unrealized: number;
}

/** Alle fälligen Intraday-Prognosen bewerten; Statistik nach meta/forecastStatsIntraday. */
export async function evaluateIntradayDue(): Promise<IntradayEvalResult> {
  const db = getFirestore();
  const nowSec = Math.floor(Date.now() / 1000);

  // orderBy('baseT') ist hier kein Schönheitsfehler, sondern der Kern:
  // OHNE Sortierung liefert eine Collection-Group-Abfrage die Dokumente in
  // PFAD-Reihenfolge — also alle Prognosen der alphabetisch ersten Symbole
  // zuerst. Sind ausgerechnet die unbewertbar, verbraucht der Kopf der Schlange
  // jedes Mal das ganze Batch-Limit, und kein einziges neueres Dokument kommt
  // je an die Reihe. Genau dieser Stau war am 27.07. zu sehen: pending stand
  // exakt auf dem Limit (150), 126 davon fällig, kein einziges bewertet.
  // Nach Zeit sortiert wandert die Schlange dagegen zuverlässig durch — und
  // was hinten nicht mehr bewertbar ist, verfällt nach INTRADAY_EXPIRE_SEC.
  const base = db.collectionGroup('forecastsIntraday').where('evaluated', '==', false);
  let pending;
  try {
    pending = await base.orderBy('baseT', 'asc').limit(INTRADAY_BATCH_LIMIT).get();
  } catch (err) {
    // Der zusammengesetzte Index (evaluated, baseT) baut nach dem Deploy ein
    // paar Minuten. Bis dahin lieber unsortiert weiterarbeiten als gar nicht —
    // ohne diesen Rückfall stünde die Bewertung genau in dem Zeitfenster still,
    // in dem der Stau abgebaut werden soll.
    logger.warn('evalIntraday: Index (evaluated, baseT) noch nicht bereit — unsortiert', err);
    pending = await base.limit(INTRADAY_BATCH_LIMIT).get();
  }
  const leer: IntradayEvalResult = { pending: 0, due: 0, scored: 0, expired: 0, unrealized: 0 };
  if (pending.empty) return leer;

  const bySymbol = new Map<string, Array<{ ref: FirebaseFirestore.DocumentReference; doc: IntradayForecastDoc }>>();
  let due = 0;
  for (const snap of pending.docs) {
    const doc = snap.data() as IntradayForecastDoc;
    if (!isIntradayForecastDue(doc.points, nowSec)) continue;
    const symbol = snap.ref.parent.parent?.id;
    if (!symbol) continue;
    due += 1;
    const list = bySymbol.get(symbol) ?? [];
    list.push({ ref: snap.ref, doc });
    bySymbol.set(symbol, list);
  }

  let scored = 0;
  let expired = 0;
  let unrealized = 0;
  const sentDelta = emptySentDelta();

  // Dieselbe Regel wie im Tagespfad — Begründung dort.
  const statsRef = db.doc('meta/forecastStatsIntraday');
  await pruefeFassung(statsRef);
  await statsRef.set({}, { merge: true });

  for (const [symbol, entries] of bySymbol) {
    let actuals: Record<string, number>;
    try {
      actuals = await loadIntradayActuals(symbol);
    } catch (err) {
      logger.warn(`evalIntraday: keine Actuals für ${symbol}`, err);
      continue;
    }
    const batch = db.batch();
    const symbolDelta = new Map<string, ComboStat>();
    for (const { ref, doc } of entries) {
      const score = scoreIntradayForecast(doc.points, doc.baseClose, actuals);
      if (score) {
        const endKurs = actuals[String(doc.points[doc.points.length - 1]!.t)];
        const sentVertreter = vertrittSentimentFall(doc.lookback, INTRADAY_LOOKBACK_GRID);
        const sentHit = sentVertreter ? sentimentHit(doc.sentSign, doc.baseClose, endKurs) : null;
        batch.update(ref, {
          evaluated: true,
          evaluatedAt: new Date().toISOString(),
          maePct: score.maePct,
          dirHit: score.dirHit,
          nPoints: score.nPoints,
          ...(sentHit === null ? {} : { sentHit }),
        });
        const key = comboKey(doc.lookback);
        const d = symbolDelta.get(key) ?? { n: 0, hits: 0, maeSum: 0 };
        d.n += 1;
        d.hits += score.dirHit ? 1 : 0;
        d.maeSum += score.maePct;
        symbolDelta.set(key, d);
        // Sentiment-Schatten: gleiche Gates wie der dirHit (nur realisierte),
        // ein Fall je (Symbol, Basis-Bar).
        if (sentVertreter) {
          tallySent(sentDelta, doc.sentSign, doc.baseClose, endKurs);
        }
        scored += 1;
      } else if (nowSec - doc.baseT > INTRADAY_EXPIRE_SEC) {
        // End-Bar wird nie realisiert (Session-Ende/Halt) → verfallen lassen,
        // NIEMALS mit unvollständigen Daten scoren (Gate bleibt heilig).
        batch.update(ref, { evaluated: true, expired: true });
        expired += 1;
      } else {
        // Fällig, aber der End-Close steht noch nicht in den gespeicherten
        // Bars. Normal für die ersten Minuten nach Fälligkeit; bleibt die
        // Zahl dauerhaft hoch, passen Prognose- und Kursraster nicht
        // zusammen. Das Gate bleibt unangetastet — hier wird nur gezählt.
        unrealized += 1;
      }
    }
    aggregatInBatch(batch, statsRef, symbolDelta);
    await batch.commit();
  }
  await writeSentStats('intraday', sentDelta).catch((err) => logger.warn('sentimentStats intraday', err));

  if (scored > 0) {
    const combos =
      ((await statsRef.get()).get('combos') as Record<string, ComboStat> | undefined) ?? {};
    const bp = bestParams(combos, DEFAULT_INTRADAY_LOOKBACK);
    // H2 wie im Tagespfad: Fälle statt Dokumente (hier 2 je Fall).
    const faelle = fallZahl(combos);
    const total = Object.values(combos).reduce((s, d) => s + d.n, 0);
    const hits = Object.values(combos).reduce((s, d) => s + d.hits, 0);
    await statsRef.set(
      {
        best: bp,
        scored: faelle,
        dirAccuracy: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
        tuningActive: faelle >= MIN_TOTAL_SCORES,
      },
      { merge: true },
    );
  }

  if (scored + expired > 0) {
    logger.info(`evalIntraday: ${scored} bewertet, ${expired} verfallen`);
  }
  return { pending: pending.size, due, scored, expired, unrealized };
}

/**
 * Täglich 16:30 ET (nach US-Schluss), Mo–Fr.
 *
 * Die Selbstdiagnose ins öffentliche meta/health ist hier kein Luxus: Am
 * 27.07. war live nachweisbar, dass dieser Lauf NIE stattgefunden hatte
 * (meta/forecastStats existierte nicht, obwohl evaluateDue() das Dokument
 * bedingungslos schreibt) — die Ursache war ein fehlender Cloud-Scheduler-Job.
 * Ohne Zugriff auf Cloud Logging ist so ein Ausfall sonst unsichtbar. Das
 * Feld beantwortet von außen die einzige wirklich wichtige Frage: Lief er?
 */
export const evalForecasts = onSchedule(
  {
    schedule: '30 16 * * 1-5',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Der Default von 60 s reicht nicht: Der Lauf holt je betroffenem Symbol
    // einen Marktdaten-Snapshot, um die Horizonte gegen die REALITÄT zu
    // prüfen. Bei einem Rückstau (erste Bewertung nach Tagen ohne Lauf) sind
    // das viele Symbole auf einmal — ein Timeout mitten drin würde bewertete
    // und unbewertete Prognosen mischen.
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    const now = new Date();
    const res = await evaluateDue();
    await getFirestore()
      .doc('meta/health')
      .set(
        {
          forecastEval: {
            at: now.toISOString(),
            date: now.toISOString().slice(0, 10),
            scored: res.scored,
            best: res.bestParams,
            // H1-Diagnose: Steht `pending` dauerhaft auf dem Limit, staut es.
            pending: res.pending,
            due: res.due,
            expired: res.expired,
            unrealized: res.unrealized,
          },
        },
        { merge: true },
      )
      .catch((err) => logger.warn('forecastEval-Diagnose nicht geschrieben', err));
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const evalNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'evalNow ist nur im Emulator verfügbar' });
    return;
  }
  const daily = await evaluateDue();
  const intraday = await evaluateIntradayDue();
  res.status(200).json({ ...daily, intraday });
});
