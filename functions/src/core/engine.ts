/**
 * Konfluenz-Engine — Port der Signal-Logik aus
 * reference/scripts/trading_engine.py::_analyze_ticker (M2: noch OHNE
 * Forecast-Vote, der kommt in M5 als `_forecast_vote()`-Äquivalent dazu).
 *
 * Votes:
 *  - RSI:  Wert < thresholdBuy → buy · Wert > thresholdSell → sell
 *  - MACD (crossoverBuy): Linie > Signal UND Hist > 0 → buy ·
 *          Linie < Signal UND Hist < 0 → sell
 *  - Bollinger: %B > bbBreakoutPct → sell · %B < (100 − bbBreakoutPct) → buy
 * Entscheidung: buy ≥ minConfluence UND buy > sell → 'buy' (analog 'sell'),
 * sonst 'hold'.
 */

import type {
  IndicatorSnapshot,
  IndicatorsConfig,
  SignalDirection,
  SignalsConfig,
} from '../../../shared/src/index.js';
import { bollinger, lastValue, macd, wilderRsi } from '../../../shared/src/index.js';

export interface SignalComputation {
  direction: SignalDirection;
  /** Stimmenzahl der Gewinner-Seite (0 bei 'hold' ohne Votes). */
  confluence: number;
  buyVotes: number;
  sellVotes: number;
  requiredConfluence: number;
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger' | 'forecast', SignalDirection>>;
  price: number;
  snapshot: IndicatorSnapshot;
}

/** Indikator-Tageswerte (Snapshot) aus der Close-Serie + Live-Preis. */
export function computeIndicatorSnapshot(
  closes: number[],
  price: number,
  cfg: IndicatorsConfig,
): IndicatorSnapshot {
  const rsiVal = lastValue(wilderRsi(closes, cfg.rsi.window));

  const m = macd(closes);
  const line = lastValue(m.line);
  const signal = lastValue(m.signal);
  const hist = lastValue(m.histogram);

  const b = bollinger(closes, 20, 2);
  const upper = lastValue(b.upper);
  const middle = lastValue(b.middle);
  const lower = lastValue(b.lower);
  // %B wie die Engine-Referenz: Live-Preis gegen die Bänder (nicht Bar-Close)
  let pctB: number | null = null;
  if (upper !== null && lower !== null) {
    const range = upper - lower || 1e-9;
    pctB = ((price - lower) / range) * 100;
  }

  return {
    rsi: rsiVal,
    macd:
      line !== null && signal !== null && hist !== null
        ? { line, signal, histogram: hist }
        : null,
    bollinger:
      upper !== null && middle !== null && lower !== null && pctB !== null
        ? { upper, middle, lower, pctB }
        : null,
  };
}

export interface ForecastVoteInput {
  /** Prognostizierte Änderung zum Horizont-Ende in % (aus dem Forecaster). */
  predictedPct: number;
}

/**
 * Eine Symbol-Analyse: Votes sammeln, Konfluenz-Entscheidung fällen.
 * `forecast` ist die gewichtete Richtungsstimme der self-getunten Prognose
 * (Port von _forecast_vote, gesteuert über signals.useForecast/
 * forecastWeight/forecastThresholdPct).
 */
export function computeSignal(
  closes: number[],
  price: number,
  indicators: IndicatorsConfig,
  signals: SignalsConfig,
  forecast?: ForecastVoteInput | null,
): SignalComputation {
  const snapshot = computeIndicatorSnapshot(closes, price, indicators);
  let buyVotes = 0;
  let sellVotes = 0;
  const votes: SignalComputation['votes'] = {};

  if (indicators.rsi.enabled && snapshot.rsi !== null) {
    if (snapshot.rsi < indicators.rsi.thresholdBuy) {
      buyVotes += 1;
      votes.rsi = 'buy';
    } else if (snapshot.rsi > indicators.rsi.thresholdSell) {
      sellVotes += 1;
      votes.rsi = 'sell';
    } else {
      votes.rsi = 'hold';
    }
  }

  if (indicators.macd.enabled && indicators.macd.crossoverBuy && snapshot.macd) {
    const { line, signal, histogram } = snapshot.macd;
    if (line > signal && histogram > 0) {
      buyVotes += 1;
      votes.macd = 'buy';
    } else if (line < signal && histogram < 0) {
      sellVotes += 1;
      votes.macd = 'sell';
    } else {
      votes.macd = 'hold';
    }
  }

  if (indicators.bollinger.enabled && snapshot.bollinger) {
    const pct = snapshot.bollinger.pctB;
    const thr = indicators.bollinger.bbBreakoutPct;
    if (pct > thr) {
      sellVotes += 1;
      votes.bollinger = 'sell';
    } else if (pct < 100 - thr) {
      buyVotes += 1;
      votes.bollinger = 'buy';
    } else {
      votes.bollinger = 'hold';
    }
  }

  // Forecast-Vote (das „Herz"): gewichtete Richtungsstimme der Prognose
  if (signals.useForecast && forecast) {
    const thr = signals.forecastThresholdPct;
    const weight = Math.trunc(signals.forecastWeight);
    if (forecast.predictedPct >= thr) {
      buyVotes += weight;
      votes.forecast = 'buy';
    } else if (forecast.predictedPct <= -thr) {
      sellVotes += weight;
      votes.forecast = 'sell';
    } else {
      votes.forecast = 'hold';
    }
  }

  const required = signals.minConfluence;
  let direction: SignalDirection = 'hold';
  if (buyVotes >= required && buyVotes > sellVotes) direction = 'buy';
  else if (sellVotes >= required && sellVotes > buyVotes) direction = 'sell';

  return {
    direction,
    confluence: direction === 'buy' ? buyVotes : direction === 'sell' ? sellVotes : Math.max(buyVotes, sellVotes),
    buyVotes,
    sellVotes,
    requiredConfluence: required,
    votes,
    price,
    snapshot,
  };
}
