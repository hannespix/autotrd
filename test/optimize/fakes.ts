/**
 * Test-Fakes für den Optimierer: deterministischer Simulator, einfache
 * Statistik, Fake-Strategien, Bar-Generator, Test-Config. Kein Import aus
 * src/backtest oder src/strategy — die entstehen parallel.
 *
 * Der Fake-Simulator leitet aus Params + Zeitraum ein SimResult ab:
 * je Bar ein Trade mit Rendite `edge(params) + noise·u − Kosten`, wobei `u`
 * ein Hash aus Symbol, Zeit und (optional) Params ist. Mit `noiseKey:
 * 'time'` sehen alle Kandidaten dieselben Zufallszahlen (Objective streng
 * monoton in der Kante); mit `'params'` hat jeder Kandidat eigenes Glück —
 * genau die Situation, in der ein Optimierer Rauschen für Kante hält.
 */
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig, type Config, type OptimizerInput } from '../../src/core/config.ts';
import { DAY, dayKeyFor } from '../../src/core/time.ts';
import type { AssetClass, BarSeriesLike, EquityPoint, Metrics, ParameterWechsel, Params, ParamSpec, SimResult, SizingSpec, Strategy, TimeframeMin, Trade } from '../../src/core/types.ts';
import { OHNE_BREMSEN } from '../../src/core/types.ts';
import type { MetricsFns } from '../../src/optimize/robustness.ts';
import { paramKey } from '../../src/optimize/search.ts';
import type { SimConfig, SimInput, SimulateFn } from '../../src/optimize/walkForward.ts';

/* ───────────────────────── Hash & Bars ───────────────────────── */

/** FNV-1a (32 Bit) → [0, 1). */
export function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // zweite Runde gegen Muster in aufeinanderfolgenden Zeitstempeln;
  // XOR liefert int32 — deshalb nach jedem Schritt zurück auf uint32
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

export const T0 = Date.UTC(2024, 0, 1);

/** Eine Bar je Kalendertag ab T0 (Krypto-Semantik: jeder Tag ist Handelstag). */
export function dailyBars(days: number, start = T0): BarSeries {
  const bars = [];
  for (let i = 0; i < days; i++) {
    const t = start + i * DAY;
    bars.push({ t, o: 100, h: 101, l: 99, c: 100, v: 1000 });
  }
  return BarSeries.from(bars);
}

/* ───────────────────────── Fake-Simulator ───────────────────────── */

export interface FakeSimOptions {
  /** Erwartete Rendite je Bar (Kante) als Funktion der Params. */
  edge: (p: Params) => number;
  /** Rauschamplitude je Bar (gleichverteilt in [−noise, +noise)). */
  noise: number;
  /** 'time': alle Kandidaten sehen dasselbe Rauschen; 'params': jeder Kandidat eigenes. */
  noiseKey: 'time' | 'params';
  /** Kosten je Trade als Anteil der Equity (skaliert mit costMultiplier). */
  costPerTrade: number;
  barsPerTrade?: number;
  /** Salz, damit zwei Fakes verschiedenes Rauschen sehen. */
  salt?: string;
  /**
   * Brutto-Exposure (Anteil 0–1), die jeder Punkt der Equity-Kurve trägt —
   * wie `EquityPoint.exposure` des echten Simulators. Ohne Angabe fehlt das
   * Feld, und die Basis-Latte sagt „nicht bewertbar" (fail-closed).
   */
  exposure?: number;
}

/** Zufallsrenditen als Kante: Erwartungswert 0, Kosten > 0 — darf nie befördert werden. */
export const NOISE_PROFILE: FakeSimOptions = { edge: () => 0, noise: 0.03, noiseKey: 'params', costPerTrade: 0.001 };
/**
 * Echte Kante, wächst mit Param a (0,015 … 0,020 je Bar); gemeinsames Rauschen
 * ⇒ Objective streng monoton in a. Der ganze Raum trägt die Kante (Plateau):
 * Ein Raum, in dem nur wenige Punkte verdienen, hätte eine so große
 * Trial-Streuung, dass der Deflated Sharpe die Auswahl zu Recht anzweifelt.
 */
export const REWARD_PROFILE: FakeSimOptions = { edge: (p) => 0.015 + 0.0005 * (p.a ?? 0), noise: 0.03, noiseKey: 'time', costPerTrade: 0.0005 };
/** Sicher verlierende Strategie (für Degradierungs-Tests). */
export const DEAD_PROFILE: FakeSimOptions = { edge: () => -0.004, noise: 0.03, noiseKey: 'params', costPerTrade: 0.001 };

export interface SimCall {
  strategyId: string;
  /** Das Symbol, für das `strategyFor` gefragt wurde — ein Aufruf je Symbol. */
  symbol: string;
  params: Params;
  range: { start: number; end: number } | null;
  costMultiplier: number;
  /** Der Korb dieses Aufrufs — die Schlüssel von `input.bars` (Korb-je-Fold-Spion). */
  symbols: string[];
  /** Sizing-Semantik der Wahl, wie `strategyFor` sie liefert (Basis: Allokation) — Spion für die Messung. */
  sizing: SizingSpec | undefined;
  /**
   * Fahrplan dieses Symbols, wie `strategyFor` ihn liefert — nur in der
   * durchgehenden OOS-Kette gesetzt (Spion: Korb je Fold IN der Kette, ein
   * Eintrag je Fold, `params: null` = in diesem Fold nicht im Korb).
   */
  wechsel: readonly ParameterWechsel[] | undefined;
}

/** Lauf eines Symbols im Fake: Wahl, Optionen und Zähler auf der gemeinsamen Zeitachse. */
interface SymLauf {
  symbol: string;
  bars: BarSeriesLike;
  strategyId: string;
  o: FakeSimOptions;
  fahrplan: readonly ParameterWechsel[];
  fahrplanIdx: number;
  params: Params | null;
  sinceTrade: number;
  /** Nächster Bar-Index dieses Symbols (die Serien sind sortiert). */
  i: number;
}

/**
 * Fake-Simulator; `options` darf je Strategie-ID verschieden sein. `calls`
 * protokolliert jeden Aufruf (Range-Spion für Lookahead-Prüfungen).
 *
 * Form wie der echte Simulator, soweit die Kette sie braucht: EINE Zeitachse
 * über alle Symbole (Vereinigung der Bar-Zeiten), je Zeitpunkt ein Punkt der
 * Equity-Kurve, je Handelstag (`dayKeyFor`) genau eine Tagesrendite, Trades
 * mit Ausstiegszeit = Bar-Zeit. Nur so kann `kettenScheiben` den einen Lauf
 * an den Fold-Grenzen schneiden; ein Fake mit Renditen je Symbol oder
 * Ausstieg bei `t + 1` verlor je Fold einen Trade an den Nachbarn (18.09.2026).
 * Das Ergebnis je Trade ist proportional zur Equity (Kante + Rauschen je Bar),
 * die Reihenfolge der Symbole ändert das Endergebnis nicht.
 */
export function makeFakeSimulate(options: FakeSimOptions | ((strategyId: string) => FakeSimOptions)): SimulateFn & { calls: SimCall[] } {
  const calls: SimCall[] = [];
  const fn = (input: SimInput): SimResult => {
    const trades: Trade[] = [];
    const equity: EquityPoint[] = [];
    const dailyReturns: number[] = [];
    let eq = input.initialEquity;
    const cm = input.costMultiplier ?? 1;
    const start = input.range?.start ?? -Infinity;
    const end = input.range?.end ?? Infinity;
    let days = 0;

    const laeufe: SymLauf[] = [];
    for (const [symbol, bars] of input.bars) {
      const sp = input.strategyFor(symbol);
      if (!sp) continue;
      const o = typeof options === 'function' ? options(sp.strategy.id) : options;
      calls.push({ strategyId: sp.strategy.id, symbol, params: { ...sp.params }, range: input.range ? { ...input.range } : null, costMultiplier: cm, symbols: [...input.bars.keys()], sizing: sp.sizing, wechsel: sp.wechsel });
      // Fahrplan wie im echten Simulator: ab `ab` gelten die Parameter des
      // Eintrags, `null` heißt kein Handel (die durchgehende OOS-Kette).
      const fahrplan = sp.wechsel ? [...sp.wechsel].sort((a, b) => a.ab - b.ab) : [];
      laeufe.push({ symbol, bars, strategyId: sp.strategy.id, o, fahrplan, fahrplanIdx: 0, params: sp.params, sinceTrade: 0, i: 0 });
    }
    const exposure = laeufe[0]?.o.exposure;
    const times = [...new Set(laeufe.flatMap((l) => Array.from(l.bars.t)))].sort((a, b) => a - b);
    let dayStart = eq;
    let tag = '';
    for (const t of times) {
      // Fahrplan zeitgesteuert für alle Symbole, auch ohne Bar an diesem Zeitpunkt.
      for (const l of laeufe) {
        while (l.fahrplanIdx < l.fahrplan.length && l.fahrplan[l.fahrplanIdx]!.ab <= t) l.params = l.fahrplan[l.fahrplanIdx++]!.params;
        while (l.i < l.bars.length && l.bars.t[l.i]! < t) l.i++;
      }
      if (t < start) continue;
      if (t >= end) break;
      const k = dayKeyFor(t, input.config.assetClass);
      if (tag !== '' && k !== tag) {
        dailyReturns.push(eq / dayStart - 1);
        dayStart = eq;
        days++;
      }
      tag = k;
      for (const l of laeufe) {
        if (l.i >= l.bars.length || l.bars.t[l.i] !== t) continue;
        const o = l.o;
        l.sinceTrade++;
        if (l.sinceTrade >= (o.barsPerTrade ?? 1) && l.params !== null) {
          l.sinceTrade = 0;
          const params = l.params;
          const edge = o.edge(params);
          const pkey = o.noiseKey === 'params' ? `${l.strategyId}|${paramKey(params)}` : '';
          const u = hashUnit(`${o.salt ?? ''}|${l.symbol}|${t}|${pkey}`) * 2 - 1;
          const gross = eq * (edge + o.noise * u);
          const fees = eq * o.costPerTrade * cm;
          const net = gross - fees;
          const px = l.bars.c[l.i]!;
          trades.push({
            symbol: l.symbol,
            side: 'long',
            qty: 1,
            entryTime: t,
            entryPrice: px,
            exitTime: t,
            exitPrice: px + net,
            grossPnl: gross,
            fees,
            netPnl: net,
            rMultiple: null,
            exitReason: 'signal',
            strategy: l.strategyId,
            barsHeld: 1,
            mae: null,
            mfe: null,
          });
          eq += net;
        }
      }
      equity.push(exposure === undefined ? { t, equity: eq } : { t, equity: eq, exposure });
    }
    if (tag !== '') {
      dailyReturns.push(eq / dayStart - 1);
      days++;
    }
    return { trades, equity, dailyReturns, metrics: metricsOf(trades, equity, dailyReturns, input.initialEquity, days, input.config.assetClass), finalEquity: eq, notes: [], bremsen: OHNE_BREMSEN };
  };
  return Object.assign(fn, { calls });
}

function metricsOf(trades: Trade[], equity: EquityPoint[], dailyReturns: number[], initial: number, days: number, assetClass: AssetClass): Metrics {
  // Annualisierung wie der Kern (backtest/simulator.ts): 365 Perioden bei Krypto, sonst 252.
  const periodsPerYear = assetClass === 'crypto' ? 365 : 252;
  const final = equity.length ? equity[equity.length - 1]!.equity : initial;
  let peak = initial;
  let maxDd = 0;
  for (const e of equity) {
    if (e.equity > peak) peak = e.equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e.equity) / peak);
  }
  const n = dailyReturns.length;
  const mu = n ? dailyReturns.reduce((s, r) => s + r, 0) / n : 0;
  let v = 0;
  let dv = 0;
  for (const r of dailyReturns) {
    v += (r - mu) * (r - mu);
    if (r < 0) dv += r * r;
  }
  const std = n > 1 ? Math.sqrt(v / (n - 1)) : 0;
  const downside = n ? Math.sqrt(dv / n) : 0;
  let wins = 0;
  let losses = 0;
  let winCount = 0;
  let fees = 0;
  let gross = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      wins += t.netPnl;
      winCount++;
    } else losses += -t.netPnl;
    fees += t.fees;
    gross += t.grossPnl;
  }
  return {
    netProfit: final - initial,
    netReturnPct: initial > 0 ? ((final - initial) / initial) * 100 : 0,
    cagrPct: null,
    // exakt wie backtest/metrics.ts: annualisiert, null bei < 2 Werten, σ = 0 bzw. ohne Verlusttag —
    // der Rückfall für Fenster ohne Verlusttag lebt in der Produktion (objective.ts), nicht im Fake
    sharpe: n > 1 && std > 0 ? (mu / std) * Math.sqrt(periodsPerYear) : null,
    sortino: n > 1 && downside > 0 ? (mu / downside) * Math.sqrt(periodsPerYear) : null,
    maxDrawdownPct: maxDd * 100,
    profitFactor: losses > 0 ? wins / losses : null,
    winRatePct: trades.length ? (winCount / trades.length) * 100 : null,
    expectancy: trades.length ? (wins - losses) / trades.length : null,
    avgR: null,
    trades: trades.length,
    exposurePct: 100,
    feeShare: gross > 0 ? fees / gross : null,
    days,
  };
}

/* ───────────────────────── Fake-Statistik ───────────────────────── */

function normCdf(z: number): number {
  // Abramowitz/Stegun 7.1.26 über erf — für Tests genau genug (|Fehler| < 2e-7)
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const erf = x >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -12;
  let hi = 12;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function moments(x: readonly number[]): { mu: number; m2: number; m3: number; m4: number } {
  const n = x.length;
  const mu = n ? x.reduce((s, v) => s + v, 0) / n : 0;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - mu;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  return { mu, m2: n ? m2 / n : 0, m3: n ? m3 / n : 0, m4: n ? m4 / n : 0 };
}

function psr(sr: number, n: number, skew: number, kurt: number, sr0: number): number {
  const denomSq = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(denomSq > 0) || n < 2) return NaN;
  return normCdf(((sr - sr0) * Math.sqrt(n - 1)) / Math.sqrt(denomSq));
}

export const fakeMetricsFns: MetricsFns = {
  sharpeRatio: (returns, periodsPerYear) => {
    const n = returns.length;
    if (n < 2) return null;
    const { mu, m2 } = moments(returns);
    const std = Math.sqrt((m2 * n) / (n - 1));
    if (!(std > 0)) return null;
    return (mu / std) * Math.sqrt(periodsPerYear);
  },
  skewness: (x) => {
    if (x.length < 3) return 0;
    const { m2, m3 } = moments(x);
    return m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
  },
  kurtosis: (x) => {
    if (x.length < 4) return 3;
    const { m2, m4 } = moments(x);
    return m2 > 0 ? m4 / (m2 * m2) : 3;
  },
  probabilisticSharpe: (a) => psr(a.sr, a.n, a.skew, a.kurt, a.sr0 ?? 0),
  deflatedSharpe: (a) => {
    const gamma = 0.5772156649015329;
    let sr0 = 0;
    if (a.nTrials > 1) {
      const n = a.nTrials;
      sr0 = Math.sqrt(Math.max(a.varSr, 0)) * ((1 - gamma) * normInv(1 - 1 / n) + gamma * normInv(1 - 1 / (n * Math.E)));
    }
    return psr(a.sr, a.n, a.skew, a.kurt, sr0);
  },
};

/* ───────────────────────── Fake-Strategien & Config ───────────────────────── */

export const SPACE_AB: ParamSpec[] = [
  { name: 'a', min: 0, max: 10, step: 1, kind: 'int', doc: 'Kante' },
  { name: 'b', min: 0, max: 4, step: 1, kind: 'int', doc: 'wirkungslos' },
];

export function fakeStrategy(
  id: string,
  o: { space?: ParamSpec[]; defaults?: Params; warmup?: number; timeframes?: TimeframeMin[] } = {},
): Strategy {
  const space = o.space ?? SPACE_AB;
  const defaults = o.defaults ?? { a: 5, b: 2 };
  const warmup = o.warmup ?? 5;
  return {
    id,
    timeframes: o.timeframes ?? [1440, 5],
    paramSpace: space,
    defaults,
    warmupBars: () => warmup,
    precompute: () => ({}),
    decide: () => ({ kind: 'hold' }),
    holdsOvernight: true,
  };
}

export function testConfig(
  over: {
    symbols?: string[];
    home?: string;
    /** Rohform (vor den Defaults) — Festkandidaten dürfen `tier`/`params` weglassen wie eine YAML-Datei. */
    optimizer?: Partial<OptimizerInput>;
    timeframe?: TimeframeMin;
    benchmark?: string;
    candidates?: string[];
    maxSymbols?: number;
    /** Rohform des Risiko-Blocks (z. B. `cashParking`) — geht durch `parseConfig`, also durch alle Prüfungen. */
    risk?: Record<string, unknown>;
  } = {},
): Config {
  return parseConfig({
    universe: {
      assetClass: 'crypto',
      symbols: over.symbols ?? ['AAA'],
      ...(over.benchmark ? { benchmark: over.benchmark } : {}),
      ...(over.candidates ? { candidates: over.candidates } : {}),
      ...(over.maxSymbols ? { maxSymbols: over.maxSymbols } : {}),
    },
    ...(over.risk ? { risk: over.risk } : {}),
    timeframe: over.timeframe ?? 1440,
    optimizer: {
      strategies: ['edge', 'noise'],
      lookbackDays: 400,
      isDays: 120,
      oosDays: 30,
      stepDays: 30,
      embargoBars: 0,
      samples: 60,
      seed: 7,
      minOosTrades: 60,
      minFoldPositiveShare: 0.6,
      objective: 'sortino',
      stressCostMultiplier: 1.5,
      holdoutDays: 30,
      promotionMargin: 0.1,
      ...over.optimizer,
    },
    paths: { home: over.home ?? './var' },
  });
}

export function simConfigOf(cfg: Config): SimConfig {
  return { risk: cfg.risk, session: cfg.session, costs: cfg.costs, assetClass: cfg.universe.assetClass, timeframe: cfg.timeframe };
}
