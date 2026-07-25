/**
 * Technische Indikatoren — Port der Python-Referenz
 * (reference/technical-analysis/scripts/technical_analysis.py, `ta`-Bibliothek).
 *
 * WICHTIG (CLAUDE.md, Parity-Pflicht):
 * - RSI nutzt WILDER-Glättung: pandas `ewm(alpha=1/window, adjust=False)`.
 * - MACD nutzt Span-EMAs: `ewm(span=n, adjust=False)`, alpha = 2/(n+1).
 * - Bollinger nutzt die POPULATIONS-Standardabweichung (pandas `std(ddof=0)`).
 * - `minPeriods`-Semantik wie pandas: Werte vor Erreichen der Mindestanzahl
 *   gültiger Beobachtungen sind `null`.
 *
 * Alle Funktionen sind pur (keine Abhängigkeiten) und geben Arrays in
 * Eingabelänge zurück (`null` wo undefiniert) — identisch nutzbar in
 * Functions (Scan/Backtest) und Frontend (Chart/Vorschau).
 * Golden-Tests gegen Python-Fixtures: shared/test/indicators.golden.test.ts.
 */

export type Series = (number | null)[];

/**
 * Exponentiell gewichteter Mittelwert wie pandas `ewm(..., adjust=False)`:
 * Rekursion startet beim ersten gültigen Wert (führende `null`s werden
 * übersprungen, wie pandas führende NaNs); Ausgabe ist `null`, bis
 * `minPeriods` gültige Beobachtungen gesehen wurden.
 */
function ewmMean(values: Series, alpha: number, minPeriods: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let y: number | null = null;
  let seen = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (x === null || x === undefined || Number.isNaN(x)) continue;
    seen += 1;
    y = y === null ? x : (1 - alpha) * y + alpha * x;
    if (seen >= minPeriods) out[i] = y;
  }
  return out;
}

/** EMA mit pandas-`span`-Parametrisierung (alpha = 2/(span+1)). */
export function ema(values: Series, span: number, minPeriods = span): Series {
  return ewmMean(values, 2 / (span + 1), minPeriods);
}

/** Einfacher gleitender Durchschnitt, pandas `rolling(window).mean()`. */
export function sma(values: Series, window: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - window + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || v === undefined || Number.isNaN(v)) { ok = false; break; }
      sum += v;
    }
    if (ok) out[i] = sum / window;
  }
  return out;
}

/**
 * RSI nach Wilder — exakte Nachbildung von `ta.momentum.rsi`:
 * diff → up/down-Serien → `ewm(alpha=1/window, adjust=False,
 * min_periods=window)` → 100 − 100/(1+RS); RS-Nenner 0 ⇒ RSI = 100.
 */
export function wilderRsi(closes: number[], window = 14): Series {
  const n = closes.length;
  // `ta` bildet diff.where(diff > 0, 0.0): das führende NaN der Diff-Serie
  // wird zu 0.0 (NaN-Bedingung ⇒ False ⇒ Ersatzwert) — die EWM-Rekursion
  // startet also bei Index 0 mit 0, NICHT beim ersten echten Diff.
  const up: Series = new Array(n).fill(null);
  const down: Series = new Array(n).fill(null);
  if (n > 0) {
    up[0] = 0;
    down[0] = 0;
  }
  for (let i = 1; i < n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    up[i] = d > 0 ? d : 0;
    down[i] = d < 0 ? -d : 0;
  }
  const emaUp = ewmMean(up, 1 / window, window);
  const emaDown = ewmMean(down, 1 / window, window);
  const out: Series = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const u = emaUp[i];
    const dn = emaDown[i];
    if (typeof u !== 'number' || typeof dn !== 'number') continue;
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + u / dn);
  }
  return out;
}

export interface MacdResult {
  line: Series;
  signal: Series;
  histogram: Series;
}

/** MACD wie `ta.trend.MACD` (EMA fast − EMA slow; Signal = EMA über MACD). */
export function macd(closes: number[], fast = 12, slow = 26, signalWindow = 9): MacdResult {
  const values: Series = closes.slice();
  const emaFast = ema(values, fast, fast);
  const emaSlow = ema(values, slow, slow);
  const line: Series = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (typeof f === 'number' && typeof s === 'number') line[i] = f - s;
  }
  const signal = ema(line, signalWindow, signalWindow);
  const histogram: Series = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const l = line[i];
    const s = signal[i];
    if (typeof l === 'number' && typeof s === 'number') histogram[i] = l - s;
  }
  return { line, signal, histogram };
}

export interface BollingerResult {
  upper: Series;
  middle: Series;
  lower: Series;
  /** %B in 0–100 wie die Engine-Referenz: (close − lower) / (upper − lower) · 100 */
  pctB: Series;
}

/** Bollinger-Bänder wie `ta.volatility.BollingerBands` (std mit ddof=0!). */
export function bollinger(closes: number[], window = 20, numStd = 2): BollingerResult {
  const n = closes.length;
  const middle = sma(closes, window);
  const upper: Series = new Array(n).fill(null);
  const lower: Series = new Array(n).fill(null);
  const pctB: Series = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    const m = middle[i];
    if (typeof m !== 'number') continue;
    let sq = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const d = closes[j]! - m;
      sq += d * d;
    }
    const std = Math.sqrt(sq / window); // ddof=0 (Population) — NICHT window-1
    const u = m + numStd * std;
    const l = m - numStd * std;
    upper[i] = u;
    lower[i] = l;
    const range = u - l || 1e-9;
    pctB[i] = ((closes[i]! - l) / range) * 100;
  }
  return { upper, middle, lower, pctB };
}

export interface VwapBar {
  /** Unix-Sekunden des Bars (5m-Intraday). */
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Session-VWAP für Intraday-Bars: kumulativ (typischer Preis × Volumen) je
 * Handelstag; eine Lücke > 60 min gilt als Session-Wechsel und setzt die
 * Kumulation zurück. Vor dem ersten Volumen der Session bleibt der Wert null
 * (kein Teilen durch 0); volumenlose Bars schreiben den letzten VWAP fort.
 */
export function vwapSessions(bars: VwapBar[]): Series {
  const out: Series = new Array(bars.length).fill(null);
  let cumPv = 0;
  let cumV = 0;
  let prevTime: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (prevTime !== null && b.time - prevTime > 3600) {
      cumPv = 0;
      cumV = 0;
    }
    prevTime = b.time;
    const typical = (b.high + b.low + b.close) / 3;
    cumPv += typical * b.volume;
    cumV += b.volume;
    if (cumV > 0) out[i] = cumPv / cumV;
  }
  return out;
}

export interface AggBar {
  /** Unix-Sekunden. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Intraday-Bars zu größeren Kerzen bündeln (Auto-Auflösung, TradingView-
 * Gefühl): Bucket = floor(time / (minutes·60)). Open = erster, Close =
 * letzter, High/Low = Extrema, Volumen summiert. Pure — Reihenfolge der
 * Eingabe (aufsteigend) bleibt erhalten.
 */
export function aggregateBars(bars: AggBar[], minutes: number): AggBar[] {
  if (minutes <= 0) return bars.slice();
  const size = minutes * 60;
  const out: AggBar[] = [];
  let cur: AggBar | null = null;
  let bucket = Number.NaN;
  for (const b of bars) {
    const bk = Math.floor(b.time / size);
    if (cur === null || bk !== bucket) {
      if (cur !== null) out.push(cur);
      cur = { time: bk * size, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      bucket = bk;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Letzter Nicht-null-Wert einer Serie (Analogon zu `.dropna().iloc[-1]`). */
export function lastValue(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}
