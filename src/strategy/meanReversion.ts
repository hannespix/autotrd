/**
 * mean_reversion — kurze Übertreibungen im Aufwärtstrend kaufen.
 *
 * Regime: Close > SMA(regimeLen), sonst nichts (long-only im Trend; Short
 * gespiegelt nur mit allowShort). Einstieg bei RSI(2..6) unter
 * `rsiOversold` oder optional z-Score unter −zEntry. Der Ausstieg ist die
 * Rückkehr zum Mittel (Close über SMA(bbLen)), ein erholter RSI oder der
 * Zeitstopp `maxHoldBars`. Der Stop ist bewusst weit (2–5 ATR): Er ist
 * Katastrophenschutz, nicht Exit-Mechanik — Mean Reversion mit engem Stop
 * verkauft systematisch am Tief. Kein Ziel, kein Trailing (fest 0).
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot } from '../core/types.ts';
import { TIMEFRAMES } from '../core/types.ts';
import { atr, atrBracket, enterDecision, fmtPx, hold, indAt, rsi, sma, trailOrHold, zscore } from './indicators.ts';
import { req, spec } from './params.ts';

const ATR_LEN = 14;
const RR_MULT = 0;
const TRAIL_MULT = 0;

const paramSpace: readonly ParamSpec[] = [
  spec('regimeLen', 100, 200, 50, 'int', 'Regime-SMA: nur long über, nur short unter'),
  spec('rsiLen', 2, 6, 2, 'int', 'Kurzer RSI'),
  spec('rsiOversold', 5, 25, 5, 'int', 'Einstieg bei RSI darunter'),
  spec('rsiExit', 50, 75, 5, 'int', 'Signal-Exit bei RSI darüber'),
  spec('bbLen', 10, 30, 10, 'int', 'Mittel-Länge für z-Score und Rückkehr-Exit'),
  spec('zEntry', 1.5, 3, 0.5, 'float', 'z-Score-Schwelle (nur mit useZ)'),
  spec('useZ', 0, 1, 1, 'int', 'z-Score-Einstieg zusätzlich zum RSI'),
  spec('atrMult', 2, 5, 1, 'float', 'Weiter Katastrophen-Stop in ATR(14)'),
  spec('maxHoldBars', 3, 15, 4, 'int', 'Zeitstopp in Bars'),
  spec('allowShort', 0, 1, 1, 'int', 'Gespiegelte Short-Einstiege'),
];

const defaults: Params = {
  regimeLen: 200,
  rsiLen: 2,
  rsiOversold: 10,
  rsiExit: 65,
  bbLen: 20,
  zEntry: 2,
  useZ: 0,
  atrMult: 3,
  maxHoldBars: 7,
  allowShort: 0,
};

function warmupBars(p: Params): number {
  return Math.max(req(p, 'regimeLen'), req(p, 'rsiLen') + 1, req(p, 'bbLen'), ATR_LEN) + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  const bbLen = req(p, 'bbLen');
  return {
    regime: sma(bars.c, req(p, 'regimeLen')),
    mean: sma(bars.c, bbLen),
    z: zscore(bars.c, bbLen),
    rsi: rsi(bars.c, req(p, 'rsiLen')),
    atr: atr(bars.h, bars.l, bars.c, ATR_LEN),
  };
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const regime = indAt(ind, 'regime', i);
  const mean = indAt(ind, 'mean', i);
  const z = indAt(ind, 'z', i);
  const rsiNow = indAt(ind, 'rsi', i);
  const atrNow = indAt(ind, 'atr', i);
  const pos = snap.position;
  const rsiExit = req(p, 'rsiExit');
  const maxHold = req(p, 'maxHoldBars');
  const bbLen = req(p, 'bbLen');

  if (pos) {
    if (pos.side === 'long') {
      if (close > mean) return { kind: 'exit', reason: `Rückkehr zum Mittel: Close ${fmtPx(close)} über SMA${bbLen} ${fmtPx(mean)}` };
      if (rsiNow > rsiExit) return { kind: 'exit', reason: `RSI ${rsiNow.toFixed(1)} über ${rsiExit}` };
    } else {
      if (close < mean) return { kind: 'exit', reason: `Rückkehr zum Mittel: Close ${fmtPx(close)} unter SMA${bbLen} ${fmtPx(mean)}` };
      if (rsiNow < 100 - rsiExit) return { kind: 'exit', reason: `RSI ${rsiNow.toFixed(1)} unter ${100 - rsiExit}` };
    }
    if (pos.barsHeld >= maxHold) return { kind: 'exit', reason: `Zeitstopp: ${pos.barsHeld} Bars ≥ ${maxHold}` };
    return trailOrHold(pos, close, atrNow, TRAIL_MULT);
  }

  const rsiOversold = req(p, 'rsiOversold');
  const useZ = req(p, 'useZ') === 1;
  const zEntry = req(p, 'zEntry');
  const atrMult = req(p, 'atrMult');

  if (close > regime) {
    const byRsi = rsiNow < rsiOversold;
    const byZ = useZ && z < -zEntry;
    if (byRsi || byZ) {
      const br = atrBracket(close, atrNow, atrMult, RR_MULT, 'long');
      const why = byRsi ? `RSI${req(p, 'rsiLen')} ${rsiNow.toFixed(1)} < ${rsiOversold}` : `z ${z.toFixed(2)} < −${zEntry}`;
      if (br) return enterDecision('long', br, `Überverkauft im Aufwärtstrend (${why}), Close > SMA${req(p, 'regimeLen')}`);
    }
  } else if (req(p, 'allowShort') === 1 && close < regime) {
    const byRsi = rsiNow > 100 - rsiOversold;
    const byZ = useZ && z > zEntry;
    if (byRsi || byZ) {
      const br = atrBracket(close, atrNow, atrMult, RR_MULT, 'short');
      const why = byRsi ? `RSI${req(p, 'rsiLen')} ${rsiNow.toFixed(1)} > ${100 - rsiOversold}` : `z ${z.toFixed(2)} > ${zEntry}`;
      if (br) return enterDecision('short', br, `Überkauft im Abwärtstrend (${why}), Close < SMA${req(p, 'regimeLen')}`);
    }
  }
  return hold();
}

export const strategy: Strategy = {
  id: 'mean_reversion',
  timeframes: TIMEFRAMES,
  paramSpace,
  defaults,
  holdsOvernight: true,
  warmupBars,
  precompute,
  decide,
};
