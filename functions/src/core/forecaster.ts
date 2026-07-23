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
  LOOKBACK_GRID,
  WEIGHT_GRID,
  bestParams,
  comboKey,
  computeForecast,
  type ComboStat,
  type ForecastComputation,
  type ForecastDoc,
} from '../../../shared/src/index.js';
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
