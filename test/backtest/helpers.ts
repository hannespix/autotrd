/**
 * Test-Helfer des Backtesters: Inline-Strategien, Config aus den
 * zod-Defaults, handgebaute 5-min-Bars. Die echten Strategien (src/strategy)
 * werden hier bewusst NICHT benutzt — der Simulator wird gegen den
 * `Strategy`-Vertrag geprüft, nicht gegen eine bestimmte Strategie.
 */
import { BarSeries } from '../../src/core/bars.ts';
import { ConfigSchema, type Config } from '../../src/core/config.ts';
import { MIN, msFromET, parseDay } from '../../src/core/time.ts';
import type {
  AssetClass,
  Bar,
  BarSeriesLike,
  Decision,
  IndicatorSet,
  Params,
  Strategy,
  SymbolSnapshot,
  TimeframeMin,
} from '../../src/core/types.ts';
import type { SimConfig } from '../../src/backtest/simulator.ts';

export function baseConfig(
  over: {
    risk?: Partial<Config['risk']>;
    session?: Partial<Config['session']>;
    costs?: Partial<Config['costs']>;
    assetClass?: AssetClass;
    timeframe?: TimeframeMin;
  } = {},
): SimConfig {
  const cfg = ConfigSchema.parse({ universe: { symbols: ['TEST'] } });
  return {
    risk: { ...cfg.risk, ...over.risk },
    session: { ...cfg.session, ...over.session },
    costs: { ...cfg.costs, ...over.costs },
    assetClass: over.assetClass ?? 'us_equity',
    timeframe: over.timeframe ?? 5,
  };
}

export type DecideFn = (snap: SymbolSnapshot, ind: IndicatorSet, p: Params) => Decision;

export function strategyOf(opts: {
  id?: string;
  holdsOvernight?: boolean;
  warmup?: number;
  timeframes?: readonly TimeframeMin[];
  decide: DecideFn;
  precompute?: (bars: BarSeriesLike, p: Params) => IndicatorSet;
}): Strategy {
  return {
    id: opts.id ?? 'inline',
    timeframes: opts.timeframes ?? [1, 5, 15, 60, 1440],
    paramSpace: [],
    defaults: {},
    warmupBars: () => opts.warmup ?? 0,
    precompute: opts.precompute ?? (() => ({})),
    decide: opts.decide,
    holdsOvernight: opts.holdsOvernight ?? true,
  };
}

export type Ohlc = readonly [o: number, h: number, l: number, c: number];

/** 5-min-Bars eines ET-Handelstags ab 09:30 (+ startMinute) aus [o,h,l,c]-Tupeln. */
export function dayBars5(day: string, ohlc: readonly Ohlc[], startMinute = 0): Bar[] {
  const { y, m, d } = parseDay(day);
  const open = msFromET(y, m, d, 9, 30);
  return ohlc.map(([o, h, l, c], k) => ({ t: open + (startMinute + 5 * k) * MIN, o, h, l, c, v: 1_000 }));
}

/** n flache Bars zum Kurs p. */
export function flat(n: number, p: number): Ohlc[] {
  return Array.from({ length: n }, () => [p, p, p, p] as const);
}

/** Ein kompletter Handelstag (78 Bars) zum Kurs p, optional mit Ersetzungen je Index. */
export function fullDay5(day: string, p: number, patch: Record<number, Ohlc> = {}): Bar[] {
  const ohlc = flat(78, p);
  for (const [k, v] of Object.entries(patch)) ohlc[Number(k)] = v;
  return dayBars5(day, ohlc);
}

export function seriesOf(bars: readonly Bar[]): BarSeries {
  return BarSeries.from(bars);
}

export function barsMap(entries: Record<string, readonly Bar[]>): ReadonlyMap<string, BarSeriesLike> {
  const m = new Map<string, BarSeriesLike>();
  for (const [sym, bars] of Object.entries(entries)) m.set(sym, BarSeries.from(bars));
  return m;
}

export const nearly = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
