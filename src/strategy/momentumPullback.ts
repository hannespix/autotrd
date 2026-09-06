/**
 * momentum_pullback — Rücksetzer im bestehenden Trend kaufen.
 *
 * Trend: EMA(fast) > EMA(slow) UND Close > EMA(slow). Einstieg long, wenn
 * im Trend der kurze RSI in dieser Bar von unter `rsiEntry` auf ≥ `rsiEntry`
 * kreuzt — der Rücksetzer ist beendet, nicht bloß „tief". Signal-Exit nur
 * bei Trendbruch (EMA-Kreuzung) oder optional bei überkauftem RSI; sonst
 * regeln Stop, Ziel und Trailing den Ausstieg.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { TIMEFRAMES } from '../core/types.ts';
import { atr, atrBracket, benchmarkAllows, ema, enterDecision, fmtPx, hold, indAt, rsi, trailOrHold } from './indicators.ts';
import { req, spec } from './params.ts';

/** Feste Längen — bewusst kein Suchparameter (weniger Freiheitsgrade = weniger Overfitting). */
const ATR_LEN = 14;
const BENCH_LEN = 200;

const paramSpace: readonly ParamSpec[] = [
  spec('fast', 10, 30, 5, 'int', 'Schnelle EMA'),
  spec('slow', 50, 200, 50, 'int', 'Langsame EMA (Trend)'),
  spec('rsiLen', 2, 14, 4, 'int', 'RSI-Länge für den Rücksetzer'),
  spec('rsiEntry', 30, 50, 5, 'int', 'Einstieg, wenn RSI von unten über diese Marke kreuzt'),
  spec('rsiExit', 65, 80, 5, 'int', 'Signal-Exit bei RSI darüber (nur mit exitOnRsi)'),
  spec('exitOnRsi', 0, 1, 1, 'int', 'Überkauft-Exit an/aus'),
  spec('atrMult', 1.5, 4, 0.5, 'float', 'Erststop-Distanz in ATR(14)'),
  spec('rrMult', 0, 4, 0.5, 'float', 'Ziel in Vielfachen des Erstrisikos (0 = kein Ziel)'),
  spec('trailMult', 0, 5, 1, 'float', 'Trailing-Distanz in ATR (0 = aus); zieht erst im Plus nach'),
  spec('useBenchmarkFilter', 0, 1, 1, 'int', 'Long nur, wenn Benchmark über SMA(200)'),
  spec('allowShort', 0, 1, 1, 'int', 'Gespiegelte Short-Einstiege'),
];

const defaults: Params = {
  fast: 20,
  slow: 100,
  rsiLen: 6,
  rsiEntry: 40,
  rsiExit: 75,
  exitOnRsi: 0,
  atrMult: 2.5,
  rrMult: 2,
  trailMult: 0,
  useBenchmarkFilter: 1,
  allowShort: 0,
};

function warmupBars(p: Params): number {
  const bench = req(p, 'useBenchmarkFilter') === 1 ? BENCH_LEN : 0;
  // rsiLen + 1: der RSI hat seinen ersten Wert an Index n, die Kreuzung braucht zusätzlich die Vorbar.
  return Math.max(req(p, 'fast'), req(p, 'slow'), req(p, 'rsiLen') + 1, ATR_LEN, bench) + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  return {
    emaFast: ema(bars.c, req(p, 'fast')),
    emaSlow: ema(bars.c, req(p, 'slow')),
    rsi: rsi(bars.c, req(p, 'rsiLen')),
    atr: atr(bars.h, bars.l, bars.c, ATR_LEN),
  };
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const fast = indAt(ind, 'emaFast', i);
  const slow = indAt(ind, 'emaSlow', i);
  const rsiNow = indAt(ind, 'rsi', i);
  const atrNow = indAt(ind, 'atr', i);
  const pos = snap.position;
  const rsiExit = req(p, 'rsiExit');
  const exitOnRsi = req(p, 'exitOnRsi') === 1;

  if (pos) {
    if (pos.side === 'long') {
      if (fast < slow) return { kind: 'exit', reason: `Trendbruch: EMA${req(p, 'fast')} ${fmtPx(fast)} unter EMA${req(p, 'slow')} ${fmtPx(slow)}` };
      if (exitOnRsi && rsiNow > rsiExit) return { kind: 'exit', reason: `RSI ${rsiNow.toFixed(1)} über ${rsiExit} (überkauft)` };
    } else {
      if (fast > slow) return { kind: 'exit', reason: `Trendbruch: EMA${req(p, 'fast')} ${fmtPx(fast)} über EMA${req(p, 'slow')} ${fmtPx(slow)}` };
      if (exitOnRsi && rsiNow < 100 - rsiExit) return { kind: 'exit', reason: `RSI ${rsiNow.toFixed(1)} unter ${100 - rsiExit} (überverkauft)` };
    }
    return trailOrHold(pos, close, atrNow, req(p, 'trailMult'));
  }

  const rsiPrev = indAt(ind, 'rsi', i - 1);
  const rsiEntry = req(p, 'rsiEntry');
  const useBench = req(p, 'useBenchmarkFilter') === 1;
  const atrMult = req(p, 'atrMult');
  const rrMult = req(p, 'rrMult');

  const trendUp = fast > slow && close > slow;
  const pullbackDone = rsiPrev < rsiEntry && rsiNow >= rsiEntry;
  if (trendUp && pullbackDone && (!useBench || benchmarkAllows(snap.benchmark, BENCH_LEN, 'long'))) {
    const br = atrBracket(close, atrNow, atrMult, rrMult, 'long');
    if (br) return enterDecision('long', br, `Rücksetzer beendet: RSI${req(p, 'rsiLen')} ${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)} über ${rsiEntry} im Aufwärtstrend`);
  }
  if (req(p, 'allowShort') === 1) {
    const mirror = 100 - rsiEntry;
    const trendDown = fast < slow && close < slow;
    const bounceDone = rsiPrev > mirror && rsiNow <= mirror;
    if (trendDown && bounceDone && (!useBench || benchmarkAllows(snap.benchmark, BENCH_LEN, 'short'))) {
      const br = atrBracket(close, atrNow, atrMult, rrMult, 'short');
      if (br) return enterDecision('short', br, `Erholung beendet: RSI${req(p, 'rsiLen')} ${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)} unter ${mirror} im Abwärtstrend`);
    }
  }
  return hold();
}

export const strategy: Strategy = {
  id: 'momentum_pullback',
  timeframes: TIMEFRAMES,
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
};
