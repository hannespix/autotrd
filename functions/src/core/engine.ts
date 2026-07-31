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
export interface SignalOptions {
  /**
   * Liegt bereits eine offene Position vor? Dann gelten die Ausstiegs-Regeln
   * (niedrigere Schwelle, Gleichstand zugunsten des Verkaufs). Ohne Angabe
   * wird die Einstiegs-Sicht berechnet — das ist auch die Anzeige-Sicht.
   */
  hasPosition?: boolean;
  /**
   * Seite der offenen Position (Shorts, Owner 26.07.): Bei 'short' ist der
   * AUSSTIEG die KAUF-Richtung (Eindecken) — die Exit-Asymmetrie (leichtere
   * Schwelle, Gleichstand für den Exit) gilt dann gespiegelt für buy.
   */
  positionSide?: 'long' | 'short';
}

export function computeSignal(
  closes: number[],
  price: number,
  indicators: IndicatorsConfig,
  signals: SignalsConfig,
  forecast?: ForecastVoteInput | null,
  opts?: SignalOptions,
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

  // Forecast-Vote (das „Herz"): gewichtete Richtungsstimme der Prognose.
  // Deckel beim EINSTIEG (Audit 26.07.): Mit Gewicht 2 und minConfluence 2
  // entschied die Prognose bisher im Alleingang — die „Konfluenz aus drei
  // Indikatoren" war ein Etikett. Ohne `forecastSolo` braucht ein Kauf
  // deshalb mindestens eine echte Indikator-Stimme dazu. Beim AUSSTIEG
  // zählt sie voll: ein verpasster Verkauf kostet Geld, ein verpasster
  // Kauf nur eine Chance.
  // Gewicht 0 heißt STUMM — nicht „mindestens 1". Genau hier saß der Fund
  // vom 31.07. (Owner-Screenshot): Das genauigkeitsgewichtete Vote hatte die
  // Prognose mangels Evidenz auf 0 gestellt, aber der Einstiegs-Deckel
  // `Math.max(1, …)` hob die Stimme wieder auf 1 an — ADA-USD zeigte 2▲,
  // obwohl kein einziger Indikator im Kaufbereich stand. Die Beweislast-
  // Umkehr war damit auf der Kaufseite still ausgehebelt; der Regelbaum-
  // Compiler (compileClassic) hatte den `> 0`-Guard von Anfang an.
  const fcWeight = Math.trunc(signals.forecastWeight);
  if (signals.useForecast && forecast && fcWeight > 0) {
    const thr = signals.forecastThresholdPct;
    const capped = signals.forecastSolo === true
      ? fcWeight
      : Math.max(1, Math.min(fcWeight, signals.minConfluence - 1));
    if (forecast.predictedPct >= thr) {
      buyVotes += capped;
      votes.forecast = 'buy';
    } else if (forecast.predictedPct <= -thr) {
      sellVotes += fcWeight; // Ausstiegsrichtung ungedeckelt
      votes.forecast = 'sell';
    } else {
      votes.forecast = 'hold';
    }
  }

  // Ein-/Ausstieg getrennt bewerten. Der Aufrufer sagt über `hasPosition`,
  // welcher Fall vorliegt; ohne Angabe gilt die Einstiegs-Sicht (Anzeige).
  const entryReq = signals.minConfluence;
  const exitReq = Math.max(1, signals.exitConfluence ?? Math.max(1, signals.minConfluence - 1));
  const inPosition = opts?.hasPosition === true;
  const required = inPosition ? exitReq : entryReq;

  let direction: SignalDirection = 'hold';
  if (inPosition && opts?.positionSide === 'short') {
    // Offener SHORT: Der Ausstieg ist das EINDECKEN (buy) — dieselbe
    // Risiko-Asymmetrie wie beim Long-Verkauf, nur gespiegelt.
    if (buyVotes >= exitReq && buyVotes >= sellVotes) direction = 'buy';
  } else if (inPosition) {
    // Offene Position: Verkauf hat Vorfahrt und gewinnt den Gleichstand.
    // Vorher blockierten RSI und Bollinger (die in fallenden Märkten
    // „überverkauft, also kaufen" sagen) genau dann den Ausstieg, wenn er
    // nötig war — 2:2 hieß „nichts tun".
    if (sellVotes >= exitReq && sellVotes >= buyVotes) direction = 'sell';
  } else if (buyVotes >= entryReq && buyVotes > sellVotes) {
    direction = 'buy';
  } else if (sellVotes >= entryReq && sellVotes > buyVotes) {
    // Ohne Position ist „sell" nur eine Anzeige-Information (nichts zu verkaufen)
    direction = 'sell';
  }

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
