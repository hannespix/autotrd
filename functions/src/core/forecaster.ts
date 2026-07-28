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
  applyBandCalibration,
  bestParams,
  comboKey,
  computeForecastV2,
  computeIntradayForecastV2,
  type BandCalibration,
  type ComboStat,
  type ForecastComputation,
  type ForecastDoc,
  type IntradayForecastComputation,
  type IntradayForecastDoc,
} from '../../../shared/src/index.js';
import type { IntradayBar } from './marketData.js';

export interface ForecastMeta {
  w: number;
  lookback: number;
  weightGrid: number[];
  lookbackGrid: number[];
  /** Realisierte Kombi-Statistik — speist die Band-Kalibrierung (Teil 3). */
  combos: Record<string, ComboStat>;
}

/**
 * Globale Tuning-Statistik (wie die Referenz: EIN Gitter über alle Symbole).
 *
 * Das Gitter ist seit 28.07. FEST. Vorher durfte ein täglicher KI-Review es
 * erweitern — ein Claude-Aufruf pro Tag, dessen einziger Effekt war, dem
 * Shadow-Logging weitere Kombis hinzuzufügen. Da die Prognose ohne
 * nachgewiesene Trefferquote ohnehin nicht mitstimmt, kostete das Geld für
 * mehr Rauschen. Die LIVE-Params bleiben, was sie immer waren: rein
 * empirische bestParams aus realisierten Treffern.
 */
export async function loadForecastMeta(): Promise<ForecastMeta> {
  const snap = await getFirestore().doc('meta/forecastStats').get();
  const combos = (snap.get('combos') as Record<string, ComboStat> | undefined) ?? {};
  return {
    ...bestParams(combos),
    weightGrid: [...WEIGHT_GRID],
    lookbackGrid: [...LOOKBACK_GRID],
    combos,
  };
}

export interface LiveForecast extends ForecastComputation {
  w: number;
  sentiment: number;
  predictedPct: number;
  /** Band-Kalibrierung aus der realisierten Fehlerverteilung (null = keine Evidenz). */
  calib: BandCalibration | null;
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
  const { w: bestW, lookback: bestLb, weightGrid, lookbackGrid, combos } = await loadForecastMeta();

  // V2 (Teil 3): Feature-Tilt + Regime-Band; Band anschließend auf die
  // realisierte Fehlerverteilung der aktiven Kombi kalibriert.
  const raw = computeForecastV2(closes, baseDate, sentiment, bestW, FORECAST_HORIZON, bestLb);
  if (!raw) return null;
  const { fc: live, calib } = applyBandCalibration(raw, combos[comboKey(bestW, bestLb)]);
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
    // Ohne Sentiment (seit 28.07. der Normalfall) ist w ein toter Regler:
    // Alle w-Kombis rechnen identisch. Die Achse kollabiert auf [0] — das
    // drittelt Schreibvolumen und Bewertungslast, ohne Information zu
    // verlieren. Alte Kombi-Statistiken mit w≠0 bleiben unangetastet.
    const wGrid: readonly number[] = sentiment === 0 ? [0] : weightGrid;
    for (const w of wGrid) {
      for (const lb of lookbackGrid) {
        // Shadow = derselbe V2-Generator wie live — nur so misst die
        // Bewertung die Prognosen, die wirklich ausgespielt werden.
        const fc = computeForecastV2(closes, baseDate, sentiment, w, FORECAST_HORIZON, lb);
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

  return { ...live, w: bestW, sentiment, predictedPct, calib };
}

export interface LiveIntradayForecast extends IntradayForecastComputation {
  w: number;
  sentiment: number;
  predictedPct: number;
  calib: BandCalibration | null;
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

  const rawLive = computeIntradayForecastV2(closes, baseT, sentiment, bestW, INTRADAY_HORIZON, bestLb);
  if (!rawLive) return null;
  const { fc: live, calib } = applyBandCalibration(rawLive, combos[comboKey(bestW, bestLb)]);

  // Shadow-Logging: offener Markt + Stundenslot; einmal je (symbol, baseT)
  if (marketOpen && baseT % 3600 < 300) {
    const coll = db.collection('market').doc(symbol).collection('forecastsIntraday');
    const existing = await coll.where('baseT', '==', baseT).limit(1).get();
    if (existing.empty) {
      const batch = db.batch();
      const madeAt = new Date().toISOString();
      // Gleiche w-Kollaps-Logik wie im Tages-Pfad (siehe runForecast).
      const wGrid: readonly number[] = sentiment === 0 ? [0] : INTRADAY_WEIGHT_GRID;
      for (const w of wGrid) {
        for (const lb of INTRADAY_LOOKBACK_GRID) {
          const fc = computeIntradayForecastV2(closes, baseT, sentiment, w, INTRADAY_HORIZON, lb);
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

  return { ...live, w: bestW, sentiment, predictedPct: pctToLast(live.points, live.baseClose), calib };
}
