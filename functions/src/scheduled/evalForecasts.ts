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
  bestParams,
  comboKey,
  isForecastDue,
  isIntradayForecastDue,
  scoreForecast,
  scoreIntradayForecast,
  type ComboStat,
  type ForecastDoc,
  type IntradayForecastDoc,
} from '../../../shared/src/index.js';
import type { IntradayBar } from '../core/marketData.js';
import { getMarketSnapshot } from '../core/marketData.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

const BATCH_LIMIT = 200;

export interface EvalResult {
  scored: number;
  bestParams: { w: number; lookback: number };
}

/** Alle fälligen Prognosen bewerten; liefert Anzahl + neue best_params. */
export async function evaluateDue(): Promise<EvalResult> {
  const db = getFirestore();
  const today = new Date().toISOString().slice(0, 10);

  const pending = await db
    .collectionGroup('forecasts')
    .where('evaluated', '==', false)
    .limit(BATCH_LIMIT)
    .get();

  // Fällige nach Symbol gruppieren (Actuals einmal pro Symbol holen)
  const dueBySymbol = new Map<string, Array<{ ref: FirebaseFirestore.DocumentReference; doc: ForecastDoc }>>();
  for (const snap of pending.docs) {
    const doc = snap.data() as ForecastDoc;
    if (!isForecastDue(doc.points, today)) continue;
    const symbol = snap.ref.parent.parent?.id;
    if (!symbol) continue;
    const list = dueBySymbol.get(symbol) ?? [];
    list.push({ ref: snap.ref, doc });
    dueBySymbol.set(symbol, list);
  }

  let scored = 0;
  const comboDelta = new Map<string, ComboStat>();

  for (const [symbol, entries] of dueBySymbol) {
    let actuals: Record<string, number>;
    try {
      const snap = await getMarketSnapshot(symbol, '6mo');
      actuals = Object.fromEntries(snap.bars.map((b) => [b.date, b.close]));
    } catch (err) {
      logger.warn(`evalForecasts: keine Actuals für ${symbol}`, err);
      continue;
    }

    const batch = db.batch();
    for (const { ref, doc } of entries) {
      const score = scoreForecast(doc.points, doc.baseClose, actuals);
      if (!score) continue; // End-Tag (noch) nicht realisiert → später erneut
      batch.update(ref, {
        evaluated: true,
        evaluatedAt: new Date().toISOString(),
        maePct: score.maePct,
        dirHit: score.dirHit,
        nPoints: score.nPoints,
      });
      const key = comboKey(doc.w, doc.lookback);
      const d = comboDelta.get(key) ?? { n: 0, hits: 0, maeSum: 0 };
      d.n += 1;
      d.hits += score.dirHit ? 1 : 0;
      d.maeSum += score.maePct;
      comboDelta.set(key, d);
      scored += 1;
    }
    await batch.commit();
  }

  // Globale Kombi-Statistik inkrementell fortschreiben (nur realisierte Scores).
  // WICHTIG: Kombi-Schlüssel enthalten Punkte ("0.5_20") — als String-Pfad
  // würde Firestore daran verschachteln; FieldPath-Segmente sind literal.
  const statsRef = db.doc('meta/forecastStats');
  if (comboDelta.size > 0) {
    const args: unknown[] = [new FieldPath('updatedAt'), new Date().toISOString()];
    for (const [key, d] of comboDelta) {
      args.push(new FieldPath('combos', key, 'n'), FieldValue.increment(d.n));
      args.push(new FieldPath('combos', key, 'hits'), FieldValue.increment(d.hits));
      args.push(new FieldPath('combos', key, 'maeSum'), FieldValue.increment(d.maeSum));
    }
    await statsRef.set({}, { merge: true });
    await statsRef.update(
      args[0] as FieldPath,
      args[1],
      ...(args.slice(2) as unknown[]),
    );
  }

  const combos =
    ((await statsRef.get()).get('combos') as Record<string, ComboStat> | undefined) ?? {};
  const bp = bestParams(combos);
  const total = Object.values(combos).reduce((s, d) => s + d.n, 0);
  const hits = Object.values(combos).reduce((s, d) => s + d.hits, 0);
  await statsRef.set(
    {
      best: bp,
      scored: total,
      dirAccuracy: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
      tuningActive: total >= 20,
    },
    { merge: true },
  );

  logger.info(`evalForecasts: ${scored} bewertet, best_params w=${bp.w} lb=${bp.lookback}`);
  return { scored, bestParams: bp };
}

/* ── Intraday-Eval (Prognose 2.0 Teil 2) ─────────────────────────────────────
 * Läuft huckepack in JEDEM Scan (Horizonte realisieren binnen einer Stunde —
 * das tägliche 16:30-Fenster wäre viel zu träge). Gate: Bar-realisiert
 * (isIntradayForecastDue) + realisierter End-Close (scoreIntradayForecast).
 * Unbewertbar verfallene Prognosen (Session-Ende vor Horizont, Halts) werden
 * nach EXPIRE_SEC als expired markiert — sie zählen NICHT in die Statistik,
 * dürfen aber die Pending-Query nicht ewig verstopfen. */

const INTRADAY_BATCH_LIMIT = 150;
const INTRADAY_EXPIRE_SEC = 3 * 86_400;

/** Realisierte 5-min-Closes eines Symbols (jüngste ~3 Tage) als t→close.
 *  Sortierung über das `date`-FELD — Firestore kann keine absteigenden
 *  Doc-ID-Scans (gleiche Falle wie bei den indicators-Docs). */
async function loadIntradayActuals(symbol: string): Promise<Record<string, number>> {
  const snap = await getFirestore()
    .collection('market')
    .doc(symbol)
    .collection('ohlc5m')
    .orderBy('date', 'desc')
    .limit(3)
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

  const pending = await db
    .collectionGroup('forecastsIntraday')
    .where('evaluated', '==', false)
    .limit(INTRADAY_BATCH_LIMIT)
    .get();
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
  const comboDelta = new Map<string, ComboStat>();

  for (const [symbol, entries] of bySymbol) {
    let actuals: Record<string, number>;
    try {
      actuals = await loadIntradayActuals(symbol);
    } catch (err) {
      logger.warn(`evalIntraday: keine Actuals für ${symbol}`, err);
      continue;
    }
    const batch = db.batch();
    for (const { ref, doc } of entries) {
      const score = scoreIntradayForecast(doc.points, doc.baseClose, actuals);
      if (score) {
        batch.update(ref, {
          evaluated: true,
          evaluatedAt: new Date().toISOString(),
          maePct: score.maePct,
          dirHit: score.dirHit,
          nPoints: score.nPoints,
        });
        const key = comboKey(doc.w, doc.lookback);
        const d = comboDelta.get(key) ?? { n: 0, hits: 0, maeSum: 0 };
        d.n += 1;
        d.hits += score.dirHit ? 1 : 0;
        d.maeSum += score.maePct;
        comboDelta.set(key, d);
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
    await batch.commit();
  }

  const statsRef = db.doc('meta/forecastStatsIntraday');
  if (comboDelta.size > 0) {
    const args: unknown[] = [new FieldPath('updatedAt'), new Date().toISOString()];
    for (const [key, d] of comboDelta) {
      args.push(new FieldPath('combos', key, 'n'), FieldValue.increment(d.n));
      args.push(new FieldPath('combos', key, 'hits'), FieldValue.increment(d.hits));
      args.push(new FieldPath('combos', key, 'maeSum'), FieldValue.increment(d.maeSum));
    }
    await statsRef.set({}, { merge: true });
    await statsRef.update(args[0] as FieldPath, args[1], ...(args.slice(2) as unknown[]));

    const combos =
      ((await statsRef.get()).get('combos') as Record<string, ComboStat> | undefined) ?? {};
    const bp = bestParams(combos);
    const total = Object.values(combos).reduce((s, d) => s + d.n, 0);
    const hits = Object.values(combos).reduce((s, d) => s + d.hits, 0);
    await statsRef.set(
      {
        best: bp,
        scored: total,
        dirAccuracy: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
        tuningActive: total >= 20,
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
