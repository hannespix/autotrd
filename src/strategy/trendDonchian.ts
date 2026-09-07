/**
 * trend_donchian — Trendfolge über Donchian-Ausbrüche.
 *
 * Einstieg long: Close über dem Hoch der VORHERIGEN `entryLen` Bars UND
 * Close über EMA(trendLen) [UND Benchmark über ihrer SMA(benchLen)].
 * Ausstieg: Stop (ATR), optionales Ziel, Trailing nur im Plus — per
 * Signal ausschließlich der Trendbruch (Close unter dem Tief der
 * vorherigen `exitLen` Bars). Owner-Befund aus dem Vorgängersystem:
 * Signal-Exits schnitten Gewinner ab, Ziel-Exits gewannen 26/26 — deshalb
 * gibt es hier keinen „Gegensignal"-Exit.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { TIMEFRAMES } from '../core/types.ts';
import { atr, atrBracket, benchmarkAllows, ema, enterDecision, fmtPx, hold, indAt, rollingMax, rollingMin, trailOrHold } from './indicators.ts';
import { req, spec } from './params.ts';

const paramSpace: readonly ParamSpec[] = [
  spec('entryLen', 10, 60, 5, 'int', 'Ausbruch über das Hoch der vorherigen n Bars'),
  spec('exitLen', 5, 30, 5, 'int', 'Trendbruch: Close unter dem Tief der vorherigen n Bars'),
  spec('atrLen', 7, 21, 7, 'int', 'ATR-Länge für Stop/Ziel/Trailing'),
  spec('atrMult', 1.5, 4, 0.5, 'float', 'Erststop-Distanz in ATR'),
  spec('trailMult', 0, 5, 1, 'float', 'Trailing-Distanz in ATR (0 = aus); zieht erst im Plus nach'),
  spec('rrMult', 0, 4, 0.5, 'float', 'Ziel in Vielfachen des Erstrisikos (0 = kein Ziel)'),
  spec('trendLen', 50, 200, 50, 'int', 'EMA-Trendfilter'),
  spec('useBenchmarkFilter', 0, 1, 1, 'int', 'Long nur, wenn Benchmark über SMA(benchLen)'),
  spec('benchLen', 100, 200, 50, 'int', 'SMA-Länge des Benchmark-Filters'),
  spec('allowShort', 0, 1, 1, 'int', 'Gespiegelte Short-Einstiege (core/logic sperrt zusätzlich per Config)'),
];

const defaults: Params = {
  entryLen: 20,
  exitLen: 10,
  atrLen: 14,
  atrMult: 2.5,
  trailMult: 3,
  rrMult: 0,
  trendLen: 100,
  useBenchmarkFilter: 1,
  benchLen: 200,
  allowShort: 0,
};

function warmupBars(p: Params): number {
  const bench = req(p, 'useBenchmarkFilter') === 1 ? req(p, 'benchLen') : 0;
  return Math.max(req(p, 'entryLen'), req(p, 'exitLen'), req(p, 'atrLen'), req(p, 'trendLen'), bench) + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  const entryLen = req(p, 'entryLen');
  const exitLen = req(p, 'exitLen');
  return {
    // Hoch/Tief der VORHERIGEN n Bars — die aktuelle Bar ist ausgeschlossen, sonst wäre nie etwas ein Ausbruch.
    entryHigh: rollingMax(bars.h, entryLen),
    entryLow: rollingMin(bars.l, entryLen),
    exitLow: rollingMin(bars.l, exitLen),
    exitHigh: rollingMax(bars.h, exitLen),
    trend: ema(bars.c, req(p, 'trendLen')),
    atr: atr(bars.h, bars.l, bars.c, req(p, 'atrLen')),
  };
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const atrNow = indAt(ind, 'atr', i);
  const pos = snap.position;

  if (pos) {
    const exitLen = req(p, 'exitLen');
    if (pos.side === 'long') {
      const exitLow = indAt(ind, 'exitLow', i);
      if (close < exitLow) return { kind: 'exit', reason: `Trendbruch: Close ${fmtPx(close)} unter ${exitLen}-Bar-Tief ${fmtPx(exitLow)}` };
    } else {
      const exitHigh = indAt(ind, 'exitHigh', i);
      if (close > exitHigh) return { kind: 'exit', reason: `Trendbruch: Close ${fmtPx(close)} über ${exitLen}-Bar-Hoch ${fmtPx(exitHigh)}` };
    }
    return trailOrHold(pos, close, atrNow, req(p, 'trailMult'));
  }

  const trend = indAt(ind, 'trend', i);
  const useBench = req(p, 'useBenchmarkFilter') === 1;
  const benchLen = req(p, 'benchLen');
  const atrMult = req(p, 'atrMult');
  const rrMult = req(p, 'rrMult');
  const entryLen = req(p, 'entryLen');
  const trendLen = req(p, 'trendLen');

  const entryHigh = indAt(ind, 'entryHigh', i);
  // NaN in der Aufwärmphase macht jeden Vergleich false — genau so gewollt.
  if (close > entryHigh && close > trend && (!useBench || benchmarkAllows(snap.benchmark, benchLen, 'long'))) {
    const br = atrBracket(close, atrNow, atrMult, rrMult, 'long');
    if (br) return enterDecision('long', br, `Donchian-Ausbruch über ${entryLen}-Bar-Hoch ${fmtPx(entryHigh)}, Trend > EMA${trendLen}`);
  }
  if (req(p, 'allowShort') === 1) {
    const entryLow = indAt(ind, 'entryLow', i);
    if (close < entryLow && close < trend && (!useBench || benchmarkAllows(snap.benchmark, benchLen, 'short'))) {
      const br = atrBracket(close, atrNow, atrMult, rrMult, 'short');
      if (br) return enterDecision('short', br, `Donchian-Ausbruch unter ${entryLen}-Bar-Tief ${fmtPx(entryLow)}, Trend < EMA${trendLen}`);
    }
  }
  return hold();
}

export const strategy: Strategy = {
  id: 'trend_donchian',
  timeframes: TIMEFRAMES,
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
};
