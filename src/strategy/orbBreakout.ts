/**
 * orb_breakout — Opening-Range-Breakout, rein intraday (EOD-Flatten macht
 * core/logic, weil holdsOvernight = false).
 *
 * Opening Range = Hoch/Tief aller Bars, deren Start in den ersten
 * `rangeMin` Minuten des ET-Tages liegt. Einstieg long an der ERSTEN Bar
 * des Tages, deren Close über dem ORB-Hoch schließt, während die Vorbar
 * noch ≤ ORB-Hoch schloss — innerhalb von `rangeMin + entryWindowMin`
 * Minuten nach Tagesbeginn und optional nur mit Volumen über
 * volMult × Durchschnitt der vorherigen 20 Bars. Genau EIN Einstieg je Tag
 * und Symbol: `precompute` markiert die erste Ausbruchs-Bar; alle späteren
 * Bars des Tages liefern `hold`, unabhängig von der Position — so rechnen
 * Backtest und Live identisch.
 *
 * Warum Minuten statt Bar-Zählung: `precompute` kennt den Zeitrahmen nicht
 * (der Vertrag übergibt ihn nicht), und Bar-Zählungen verschieben sich bei
 * Datenlücken. Fenster in Minuten gegen die Startzeit der ersten Tagesbar
 * sind zeitrahmenfrei und bei lückenlosen Daten identisch mit
 * ceil(rangeMin / tf) Bars.
 */
import type { BarSeriesLike, Decision, IndicatorSet, ParamSpec, Params, Strategy, SymbolSnapshot, TimeframeMin } from '../core/types.ts';
import { MIN } from '../core/time.ts';
import { atr, bracketFromStop, dayIndex, enterDecision, fmtPx, hold, indAt, nanArray, sma, trailOrHold } from './indicators.ts';
import { req, spec } from './params.ts';

const ATR_LEN = 14;
const VOL_LEN = 20;

/** Nur Intraday: 60 wäre bei 30 Minuten Range unsinnig, 1440 hat keinen Tagesverlauf. */
const INTRADAY_TIMEFRAMES: readonly TimeframeMin[] = [1, 2, 3, 5, 10, 15, 30];

const paramSpace: readonly ParamSpec[] = [
  spec('rangeMin', 15, 60, 15, 'int', 'Opening Range in Minuten ab Tagesbeginn'),
  spec('entryWindowMin', 60, 240, 60, 'int', 'Einstiegsfenster in Minuten nach der Range'),
  spec('rrMult', 1, 3, 0.5, 'float', 'Ziel in Vielfachen des Erstrisikos'),
  spec('stopMode', 0, 1, 1, 'int', '0 = Stop am ORB-Tief/Hoch, 1 = ATR-Stop'),
  spec('atrMult', 1, 3, 0.5, 'float', 'ATR-Stop-Distanz (nur stopMode 1)'),
  spec('volMult', 0, 2, 0.5, 'float', 'Volumen-Filter: > volMult × SMA20 der Vorbars (0 = aus)'),
  spec('trailMult', 0, 4, 1, 'float', 'Trailing-Distanz in ATR (0 = aus); zieht erst im Plus nach'),
  spec('allowShort', 0, 1, 1, 'int', 'Gespiegelte Short-Ausbrüche'),
];

const defaults: Params = {
  rangeMin: 30,
  entryWindowMin: 120,
  rrMult: 2,
  stopMode: 0,
  atrMult: 1.5,
  volMult: 0,
  trailMult: 0,
  allowShort: 0,
};

function warmupBars(_p: Params): number {
  return Math.max(ATR_LEN, VOL_LEN) + 2;
}

function precompute(bars: BarSeriesLike, p: Params): IndicatorSet {
  const n = bars.length;
  const rangeMs = req(p, 'rangeMin') * MIN;
  const windowMs = rangeMs + req(p, 'entryWindowMin') * MIN;
  const volMult = req(p, 'volMult');
  const allowShort = req(p, 'allowShort') === 1;

  const orbHigh = nanArray(n);
  const orbLow = nanArray(n);
  const entryLong = new Float64Array(n);
  const entryShort = new Float64Array(n);
  const volSma = sma(bars.v, VOL_LEN);
  const days = dayIndex(bars.t);

  let day = -1;
  let dayStart = 0;
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  let entered = false;
  for (let i = 0; i < n; i++) {
    const t = bars.t[i]!;
    if (days[i] !== day) {
      day = days[i]!;
      dayStart = t;
      hi = Number.NEGATIVE_INFINITY;
      lo = Number.POSITIVE_INFINITY;
      entered = false;
    }
    const offset = t - dayStart;
    if (offset < rangeMs) {
      // Range noch im Aufbau: keine ORB-Werte, kein Einstieg.
      hi = Math.max(hi, bars.h[i]!);
      lo = Math.min(lo, bars.l[i]!);
      continue;
    }
    orbHigh[i] = hi;
    orbLow[i] = lo;
    if (entered || offset >= windowMs) continue;
    // i ≥ 1 und Bar i-1 gehört zum selben Tag: die erste Tagesbar liegt immer in der Range.
    const close = bars.c[i]!;
    const prevClose = bars.c[i - 1]!;
    const volOk = volMult === 0 || bars.v[i]! > volMult * volSma[i - 1]!;
    if (!volOk) continue;
    if (close > hi && prevClose <= hi) {
      entryLong[i] = 1;
      entered = true;
    } else if (allowShort && close < lo && prevClose >= lo) {
      entryShort[i] = 1;
      entered = true;
    }
  }
  return { orbHigh, orbLow, entryLong, entryShort, atr: atr(bars.h, bars.l, bars.c, ATR_LEN) };
}

function decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision {
  const i = snap.i;
  const close = snap.bars.c[i];
  if (close === undefined || i < 0) return hold();
  const atrNow = indAt(ind, 'atr', i);
  const pos = snap.position;
  if (pos) return trailOrHold(pos, close, atrNow, req(p, 'trailMult'));

  const stopMode = req(p, 'stopMode');
  const atrMult = req(p, 'atrMult');
  const rrMult = req(p, 'rrMult');
  const rangeMin = req(p, 'rangeMin');

  if (indAt(ind, 'entryLong', i) === 1) {
    const orbLow = indAt(ind, 'orbLow', i);
    const stop = stopMode === 0 ? orbLow : close - atrMult * atrNow;
    const br = bracketFromStop(close, stop, rrMult, 'long');
    if (br) return enterDecision('long', br, `ORB${rangeMin}-Ausbruch über ${fmtPx(indAt(ind, 'orbHigh', i))}, Stop ${stopMode === 0 ? 'ORB-Tief' : `${atrMult}×ATR`}`);
  } else if (req(p, 'allowShort') === 1 && indAt(ind, 'entryShort', i) === 1) {
    const orbHigh = indAt(ind, 'orbHigh', i);
    const stop = stopMode === 0 ? orbHigh : close + atrMult * atrNow;
    const br = bracketFromStop(close, stop, rrMult, 'short');
    if (br) return enterDecision('short', br, `ORB${rangeMin}-Ausbruch unter ${fmtPx(indAt(ind, 'orbLow', i))}, Stop ${stopMode === 0 ? 'ORB-Hoch' : `${atrMult}×ATR`}`);
  }
  return hold();
}

export const strategy: Strategy = {
  id: 'orb_breakout',
  timeframes: INTRADAY_TIMEFRAMES,
  paramSpace,
  defaults,
  holdsOvernight: false,
  warmupBars,
  precompute,
  decide,
};
