/**
 * Forecaster (Firestore) — Port von reference/scripts/forecaster.py.
 * Die pure Mathematik lebt in shared/src/forecast.ts (Golden-Parity);
 * hier: Live-Prognose mit dem self-getunten besten Lookback + Shadow-Grid-
 * Logging nach market/{sym}/forecasts/{baseDate_lookback} (Doc-ID =
 * fachlicher Schlüssel ⇒ idempotent, ersetzt den SQLite-UNIQUE-Index).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  FORECAST_HORIZON,
  INTRADAY_HORIZON,
  INTRADAY_STEP_SEC,
  DEFAULT_INTRADAY_LOOKBACK,
  INTRADAY_LOOKBACK_GRID,
  LOOKBACK_GRID,
  applyBandCalibration,
  bestParams,
  comboKey,
  computeForecastV2,
  computeIntradayForecastV2,
  shadowSentSign,
  type BandCalibration,
  type ComboStat,
  type ForecastComputation,
  type ForecastDoc,
  type IntradayForecastComputation,
  type IntradayForecastDoc,
  type NewsSnapshot,
} from '../../../shared/src/index.js';
import type { IntradayBar } from './marketData.js';

export interface ForecastMeta {
  lookback: number;
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
  return { ...bestParams(combos), lookbackGrid: [...LOOKBACK_GRID], combos };
}

export interface LiveForecast extends ForecastComputation {
  predictedPct: number;
  /** Band-Kalibrierung aus der realisierten Fehlerverteilung (null = keine Evidenz). */
  calib: BandCalibration | null;
}

/**
 * Live-Prognose + einmaliges Shadow-Logging pro (symbol, baseDate).
 */
export async function runForecast(
  symbol: string,
  closes: number[],
  baseDate: string,
  news: NewsSnapshot | null = null,
): Promise<LiveForecast | null> {
  const db = getFirestore();
  const { lookback: bestLb, lookbackGrid, combos } = await loadForecastMeta();

  // V2 (Teil 3): Feature-Tilt + Regime-Band; Band anschließend auf die
  // realisierte Fehlerverteilung des aktiven Lookbacks kalibriert.
  const raw = computeForecastV2(closes, baseDate, FORECAST_HORIZON, bestLb);
  if (!raw) return null;
  const { fc: live, calib } = applyBandCalibration(raw, combos[comboKey(bestLb)]);
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
    // Sentiment-Schatten (News-Rückkehr 29.07.): Die News-Lage zum
    // Prognosezeitpunkt wird nur GESTEMPELT — sie verschiebt keine Drift
    // (der alte Tilt ist bewusst nicht zurück). Die Bewertung zählt später
    // in meta/sentimentStats, ob das Vorzeichen die Richtung getroffen hätte.
    const sent = shadowSentSign(news, Math.floor(Date.now() / 1000));
    for (const lb of lookbackGrid) {
      // Shadow = derselbe V2-Generator wie live — nur so misst die
      // Bewertung die Prognosen, die wirklich ausgespielt werden.
      const fc = computeForecastV2(closes, baseDate, FORECAST_HORIZON, lb);
      if (!fc) continue;
      const docData: ForecastDoc = {
        baseDate,
        baseClose: fc.baseClose,
        lookback: lb,
        horizonDays: fc.points.length,
        dailyVol: fc.dailyVol,
        points: fc.points,
        predictedPct:
          fc.baseClose > 0
            ? (fc.points[fc.points.length - 1]!.value / fc.baseClose - 1) * 100
            : 0,
        madeAt,
        evaluated: false,
        ...(sent ? { sentSign: sent.sign, sentVal: sent.val } : {}),
      };
      batch.set(coll.doc(`${baseDate}_${comboKey(lb)}`), docData);
    }
    await batch.commit();
  }

  return { ...live, predictedPct, calib };
}

export interface LiveIntradayForecast extends IntradayForecastComputation {
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
  marketOpen: boolean,
  news: NewsSnapshot | null = null,
): Promise<LiveIntradayForecast | null> {
  // Raster-Guard (Befund 28.07.): Prognosepunkte sind `baseT + k·300` und
  // werden später gegen die gespeicherten 5-min-Bars gematcht. Liegt `baseT`
  // auch nur Sekunden neben dem Raster, trifft KEIN einziger Punkt — die
  // Prognose ist dann nicht ungenau, sondern für immer unbewertbar. Der
  // Quellfilter in `getIntradayBars` fängt das bereits ab; hier steht der
  // zweite Riegel, damit eine künftige zweite Datenquelle denselben Fehler
  // nicht lautlos wieder einschleppt. Abschneiden statt Runden: ein
  // hochgerundeter Zeitstempel wäre eine Prognose aus der Zukunft.
  const grid = bars.filter((b) => b.t % INTRADAY_STEP_SEC === 0);
  if (grid.length < bars.length) {
    logger.warn(
      `Intraday ${symbol}: ${bars.length - grid.length} Bar(s) neben dem ${INTRADAY_STEP_SEC}s-Raster verworfen`,
    );
  }
  if (grid.length < 5) return null;
  const db = getFirestore();
  const closes = grid.map((b) => b.c);
  const baseT = grid[grid.length - 1]!.t;

  const statsSnap = await db.doc('meta/forecastStatsIntraday').get();
  const combos = (statsSnap.get('combos') as Record<string, ComboStat> | undefined) ?? {};
  // Eigener Fallback: Der Tages-Default (20) liegt gar nicht im
  // Intraday-Gitter [24, 48] — ein gemeinsamer Default hätte hier stets
  // einen Lookback erzeugt, den keine Shadow-Kombi je bewertet.
  const { lookback: bestLb } = bestParams(combos, DEFAULT_INTRADAY_LOOKBACK);

  const rawLive = computeIntradayForecastV2(closes, baseT, INTRADAY_HORIZON, bestLb);
  if (!rawLive) return null;
  const { fc: live, calib } = applyBandCalibration(rawLive, combos[comboKey(bestLb)]);

  // Shadow-Logging: offener Markt + Stundenslot; einmal je (symbol, baseT)
  if (marketOpen && baseT % 3600 < 300) {
    const coll = db.collection('market').doc(symbol).collection('forecastsIntraday');
    const existing = await coll.where('baseT', '==', baseT).limit(1).get();
    if (existing.empty) {
      const batch = db.batch();
      const madeAt = new Date().toISOString();
      // Sentiment-Schatten wie beim Tages-Pfad: stempeln, nie verschieben.
      const sent = shadowSentSign(news, Math.floor(Date.now() / 1000));
      for (const lb of INTRADAY_LOOKBACK_GRID) {
        const fc = computeIntradayForecastV2(closes, baseT, INTRADAY_HORIZON, lb);
        if (!fc) continue;
        const docData: IntradayForecastDoc = {
          baseT,
          baseClose: fc.baseClose,
          lookback: lb,
          horizonBars: fc.points.length,
          vol: fc.vol,
          points: fc.points,
          predictedPct: pctToLast(fc.points, fc.baseClose),
          madeAt,
          evaluated: false,
          ...(sent ? { sentSign: sent.sign, sentVal: sent.val } : {}),
        };
        batch.set(coll.doc(`${baseT}_${comboKey(lb)}`), docData);
      }
      await batch.commit();
    }
  }

  return { ...live, predictedPct: pctToLast(live.points, live.baseClose), calib };
}
