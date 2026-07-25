/**
 * Forecaster (Firestore) — Port von reference/scripts/forecaster.py.
 * Die pure Mathematik lebt in shared/src/forecast.ts (Golden-Parity);
 * hier: Live-Prognose mit den self-getunten best_params + Shadow-Grid-Logging
 * nach market/{sym}/forecasts/{baseDate_w_lookback} (Doc-ID = fachlicher
 * Schlüssel ⇒ idempotent, ersetzt den SQLite-UNIQUE-Index).
 */

import { getFirestore } from 'firebase-admin/firestore';
import {
  FORECAST_HORIZON,
  INTRADAY_HORIZON,
  INTRADAY_LOOKBACK_GRID,
  INTRADAY_WEIGHT_GRID,
  LOOKBACK_GRID,
  WEIGHT_GRID,
  bestParams,
  comboKey,
  computeForecast,
  computeIntradayForecast,
  type ComboStat,
  type ForecastComputation,
  type ForecastDoc,
  type IntradayForecastComputation,
  type IntradayForecastDoc,
} from '../../../shared/src/index.js';
import type { IntradayBar } from './marketData.js';
import { mergeGrids } from './tuner.js';

export interface ForecastMeta {
  w: number;
  lookback: number;
  weightGrid: number[];
  lookbackGrid: number[];
}

/**
 * Globale Tuning-Statistik (wie die Referenz: EIN Gitter über alle Symbole).
 * Das Shadow-Gitter = Basis-Gitter ∪ Tuner-Erweiterungen (hart geclampt in
 * mergeGrids) — die LIVE-Params bleiben rein empirische bestParams.
 */
export async function loadForecastMeta(): Promise<ForecastMeta> {
  const snap = await getFirestore().doc('meta/forecastStats').get();
  const combos = (snap.get('combos') as Record<string, ComboStat> | undefined) ?? {};
  const tuning = snap.get('tuning') as
    | { extraWeights?: number[]; extraLookbacks?: number[] }
    | undefined;
  const { weightGrid, lookbackGrid } = mergeGrids(WEIGHT_GRID, LOOKBACK_GRID, tuning);
  return { ...bestParams(combos), weightGrid, lookbackGrid };
}

export interface LiveForecast extends ForecastComputation {
  w: number;
  sentiment: number;
  predictedPct: number;
}

/**
 * Live-Prognose + einmaliges Shadow-Logging pro (symbol, baseDate).
 * `sentiment` kommt ab M6 aus den News; bis dahin 0 (reiner Drift).
 */
export async function runForecast(
  symbol: string,
  closes: number[],
  baseDate: string,
  sentiment: number,
): Promise<LiveForecast | null> {
  const db = getFirestore();
  const { w: bestW, lookback: bestLb, weightGrid, lookbackGrid } = await loadForecastMeta();

  const live = computeForecast(closes, baseDate, sentiment, bestW, FORECAST_HORIZON, bestLb);
  if (!live) return null;
  const predictedPct =
    live.baseClose > 0
      ? (live.points[live.points.length - 1]!.value / live.baseClose - 1) * 100
      : 0;

  // Shadow-Grid nur einmal je (symbol, baseDate) — Port von _already_logged
  const coll = db.collection('market').doc(symbol).collection('forecasts');
  const existing = await coll.where('baseDate', '==', baseDate).limit(1).get();
  if (existing.empty) {
    const batch = db.batch();
    const madeAt = new Date().toISOString();
    for (const w of weightGrid) {
      for (const lb of lookbackGrid) {
        const fc = computeForecast(closes, baseDate, sentiment, w, FORECAST_HORIZON, lb);
        if (!fc) continue;
        const docData: ForecastDoc = {
          baseDate,
          baseClose: fc.baseClose,
          w,
          lookback: lb,
          horizonDays: fc.points.length,
          sentiment,
          dailyVol: fc.dailyVol,
          points: fc.points,
          predictedPct:
            fc.baseClose > 0
              ? (fc.points[fc.points.length - 1]!.value / fc.baseClose - 1) * 100
              : 0,
          madeAt,
          evaluated: false,
        };
        batch.set(coll.doc(`${baseDate}_${comboKey(w, lb)}`), docData);
      }
    }
    await batch.commit();
  }

  return { ...live, w: bestW, sentiment, predictedPct };
}

export interface LiveIntradayForecast extends IntradayForecastComputation {
  w: number;
  sentiment: number;
  predictedPct: number;
}

const pctToLast = (points: Array<{ value: number }>, base: number): number =>
  base > 0 ? (points[points.length - 1]!.value / base - 1) * 100 : 0;

/**
 * Intraday-Kurzfrist-Prognose (Prognose 2.0 Teil 2): Live-Projektion der
 * nächsten Stunde auf 5-min-Bars — bei JEDEM Scan neu (maximale Update-Rate).
 * Shadow-Gitter nur bei offenem Markt und nur einmal je UTC-Stundenslot
 * (Bar-Start % 3600 < 300) — Doc-ID = fachlicher Schlüssel ⇒ idempotent.
 */
export async function runIntradayForecast(
  symbol: string,
  bars: IntradayBar[],
  sentiment: number,
  marketOpen: boolean,
): Promise<LiveIntradayForecast | null> {
  if (bars.length < 5) return null;
  const db = getFirestore();
  const closes = bars.map((b) => b.c);
  const baseT = bars[bars.length - 1]!.t;

  const statsSnap = await db.doc('meta/forecastStatsIntraday').get();
  const combos = (statsSnap.get('combos') as Record<string, ComboStat> | undefined) ?? {};
  const best = bestParams(combos);
  // bestParams-Fallback sind die TAGES-Defaults — auf Intraday-Gitter mappen
  const bestW = (INTRADAY_WEIGHT_GRID as readonly number[]).includes(best.w) ? best.w : 0.5;
  const bestLb = (INTRADAY_LOOKBACK_GRID as readonly number[]).includes(best.lookback) ? best.lookback : 24;

  const live = computeIntradayForecast(closes, baseT, sentiment, bestW, INTRADAY_HORIZON, bestLb);
  if (!live) return null;

  // Shadow-Logging: offener Markt + Stundenslot; einmal je (symbol, baseT)
  if (marketOpen && baseT % 3600 < 300) {
    const coll = db.collection('market').doc(symbol).collection('forecastsIntraday');
    const existing = await coll.where('baseT', '==', baseT).limit(1).get();
    if (existing.empty) {
      const batch = db.batch();
      const madeAt = new Date().toISOString();
      for (const w of INTRADAY_WEIGHT_GRID) {
        for (const lb of INTRADAY_LOOKBACK_GRID) {
          const fc = computeIntradayForecast(closes, baseT, sentiment, w, INTRADAY_HORIZON, lb);
          if (!fc) continue;
          const docData: IntradayForecastDoc = {
            baseT,
            baseClose: fc.baseClose,
            w,
            lookback: lb,
            horizonBars: fc.points.length,
            sentiment,
            vol: fc.vol,
            points: fc.points,
            predictedPct: pctToLast(fc.points, fc.baseClose),
            madeAt,
            evaluated: false,
          };
          batch.set(coll.doc(`${baseT}_${comboKey(w, lb)}`), docData);
        }
      }
      await batch.commit();
    }
  }

  return { ...live, w: bestW, sentiment, predictedPct: pctToLast(live.points, live.baseClose) };
}
