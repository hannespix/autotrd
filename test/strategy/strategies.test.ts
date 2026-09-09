/**
 * Strategie-Tests: Vertrag (Gitter, Zeitrahmen, Warmup), Präfix-Konsistenz
 * von precompute UND decide (Lookahead-Wächter), Determinismus und
 * Entscheidungs-Sanity auf konstruierten Serien je Vorlage.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { buildSessionInfo } from '../../src/core/session.ts';
import { MIN, addDays, isTradingDay, msFromET } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike, Decision, Params, PositionState, Strategy, SymbolSnapshot, TimeframeMin, KorbRang } from '../../src/core/types.ts';
import { STRATEGIES, getStrategy, resolveParams, strategyIds } from '../../src/strategy/index.ts';
import { gridOf, validateParams } from '../../src/strategy/params.ts';

/* ───────────────────────── Hilfen ───────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tradingDays(startDay: string, count: number): string[] {
  const out: string[] = [];
  let d = startDay;
  while (out.length < count) {
    if (isTradingDay(d, 'us_equity')) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y!, m!, d!];
}

/** Zufällige Tagesbars an echten Handelstagen (geometrischer Random Walk). */
function randomDaily(n: number, seed: number): BarSeries {
  const rnd = mulberry32(seed);
  const days = tradingDays('2024-01-02', n);
  const out: Bar[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = Math.max(1, c * (1 + (rnd() - 0.48) * 0.03));
    const [y, m, d] = ymd(days[i]!);
    out.push({ t: msFromET(y, m, d, 9, 30), o, h: Math.max(o, c) + rnd() * 0.5, l: Math.min(o, c) - rnd() * 0.5, c, v: 1000 + Math.floor(rnd() * 5000) });
  }
  return BarSeries.from(out);
}

/** Zufällige 5-Minuten-Bars über mehrere Handelstage (78 je Tag). */
function randomIntraday(dayCount: number, seed: number, tf = 5): BarSeries {
  const rnd = mulberry32(seed);
  const out: Bar[] = [];
  let c = 100;
  const perDay = Math.ceil(390 / tf);
  for (const day of tradingDays('2026-03-02', dayCount)) {
    const [y, m, d] = ymd(day);
    const open = msFromET(y, m, d, 9, 30);
    for (let k = 0; k < perDay; k++) {
      const o = c;
      c = Math.max(1, c * (1 + (rnd() - 0.49) * 0.004));
      out.push({ t: open + k * tf * MIN, o, h: Math.max(o, c) + rnd() * 0.1, l: Math.min(o, c) - rnd() * 0.1, c, v: 1000 + Math.floor(rnd() * 5000) });
    }
  }
  return BarSeries.from(out);
}

/** Tagesbars aus einer Close-Funktion; Hoch/Tief ±0.3 um o/c. */
function dailyFromCloses(closes: number[]): BarSeries {
  const days = tradingDays('2024-01-02', closes.length);
  const out: Bar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]!;
    const o = i === 0 ? c : closes[i - 1]!;
    const [y, m, d] = ymd(days[i]!);
    out.push({ t: msFromET(y, m, d, 9, 30), o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1000 });
  }
  return BarSeries.from(out);
}

function snapAt(bars: BarSeriesLike, i: number, tf: TimeframeMin, position: PositionState | null = null, benchmark?: { bars: BarSeriesLike; i: number }): SymbolSnapshot {
  const snap: SymbolSnapshot = { symbol: 'TEST', bars, i, position, session: buildSessionInfo(bars, i, tf, 'us_equity') };
  if (benchmark) snap.benchmark = benchmark;
  return snap;
}

function longPos(over: Partial<PositionState> = {}): PositionState {
  return {
    symbol: 'TEST',
    side: 'long',
    qty: 10,
    entryPrice: 100,
    entryTime: 0,
    stop: 95,
    target: null,
    initialStop: 95,
    highWater: 100,
    strategy: 'x',
    barsHeld: 0,
    entryDay: '2024-01-02',
    ...over,
  };
}

function withParams(s: Strategy, over: Partial<Params>): Params {
  return resolveParams(s, over);
}

const ramp = (n: number, start: number, step: number): number[] => Array.from({ length: n }, (_, i) => start + step * i);

/* ───────────────────────── Register & Vertrag ───────────────────────── */

describe('Register', () => {
  it('kennt die Vorlagen mit eindeutigen IDs', () => {
    expect(strategyIds()).toEqual(['trend_donchian', 'momentum_pullback', 'mean_reversion', 'orb_breakout', 'cross_sectional_momentum', 'regime_allocation']);
    expect(new Set(strategyIds()).size).toBe(STRATEGIES.length);
    expect(getStrategy('mean_reversion').id).toBe('mean_reversion');
  });
  it('unbekannte ID wirft mit Liste der bekannten', () => {
    expect(() => getStrategy('nope')).toThrow(/Unbekannte Strategie "nope".*trend_donchian.*orb_breakout/);
  });
  it('resolveParams: Defaults ← Overrides, validiert', () => {
    const p = resolveParams(getStrategy('trend_donchian'), { entryLen: 30 });
    expect(p.entryLen).toBe(30);
    expect(p.exitLen).toBe(10);
    expect(() => resolveParams(getStrategy('trend_donchian'), { entryLen: 31 })).toThrow(/Gitter/);
    expect(() => resolveParams(getStrategy('trend_donchian'), { nope: 1 })).toThrow(/kein Parameter/);
  });
});

describe.each(STRATEGIES.map((s) => [s.id, s] as const))('Vertrag: %s', (_id, s) => {
  it('Defaults liegen auf dem Gitter, in den Grenzen und decken genau den Suchraum ab', () => {
    expect(() => validateParams(s.paramSpace, s.defaults)).not.toThrow();
    expect(Object.keys(s.defaults).sort()).toEqual(s.paramSpace.map((x) => x.name).sort());
    for (const sp of s.paramSpace) {
      expect(sp.kind === 'int' || sp.kind === 'float').toBe(true);
      expect(gridOf(sp)).toContain(s.defaults[sp.name]);
    }
  });
  it('Warmup ≥ längste Fensterlänge + 2', () => {
    const w = s.warmupBars(s.defaults);
    const lengths = s.paramSpace.filter((x) => /Len$|^fast$|^slow$|Bars$/.test(x.name)).map((x) => s.defaults[x.name]!);
    expect(w).toBeGreaterThanOrEqual(Math.max(0, ...lengths) + 2);
  });
  it('Zeitrahmen sind gültig und nicht leer', () => {
    expect(s.timeframes.length).toBeGreaterThan(0);
    for (const tf of s.timeframes) expect([1, 2, 3, 5, 10, 15, 30, 60, 1440]).toContain(tf);
  });
});

describe('Warmup-Werte', () => {
  it('trend_donchian: Benchmark-Länge zählt nur mit Filter', () => {
    const s = getStrategy('trend_donchian');
    expect(s.warmupBars(s.defaults)).toBe(202);
    expect(s.warmupBars(withParams(s, { useBenchmarkFilter: 0 }))).toBe(102);
  });
  it('momentum_pullback / mean_reversion / orb_breakout', () => {
    const m = getStrategy('momentum_pullback');
    expect(m.warmupBars(m.defaults)).toBe(202);
    expect(m.warmupBars(withParams(m, { useBenchmarkFilter: 0 }))).toBe(102);
    const r = getStrategy('mean_reversion');
    expect(r.warmupBars(r.defaults)).toBe(202);
    const o = getStrategy('orb_breakout');
    expect(o.warmupBars(o.defaults)).toBe(22);
  });
  it('orb_breakout ist rein intraday, hält nicht über Nacht', () => {
    const o = getStrategy('orb_breakout');
    expect(o.holdsOvernight).toBe(false);
    expect(o.timeframes).not.toContain(60);
    expect(o.timeframes).not.toContain(1440);
    expect(o.timeframes).toEqual([1, 2, 3, 5, 10, 15, 30]);
    for (const id of ['trend_donchian', 'momentum_pullback', 'mean_reversion']) {
      expect(getStrategy(id).holdsOvernight).toBe(true);
      expect(getStrategy(id).timeframes).toContain(1440);
    }
  });
});

/* ───────────────────────── Präfix-Konsistenz & Determinismus ───────────────────────── */

interface Variant {
  id: string;
  over: Partial<Params>;
  bars: BarSeries;
  tf: TimeframeMin;
  /** Korb-Rang für Querschnitts-Strategien — ohne ihn steigen sie nie ein. */
  rank?: KorbRang;
}

const variants: Variant[] = [
  { id: 'trend_donchian', over: {}, bars: randomDaily(300, 21), tf: 1440 },
  { id: 'trend_donchian', over: { allowShort: 1, rrMult: 2, useBenchmarkFilter: 0, trailMult: 1 }, bars: randomDaily(300, 22), tf: 1440 },
  { id: 'momentum_pullback', over: {}, bars: randomDaily(300, 23), tf: 1440 },
  { id: 'momentum_pullback', over: { allowShort: 1, exitOnRsi: 1, trailMult: 2, rsiLen: 2 }, bars: randomDaily(300, 24), tf: 1440 },
  { id: 'mean_reversion', over: {}, bars: randomDaily(300, 25), tf: 1440 },
  { id: 'mean_reversion', over: { useZ: 1, allowShort: 1, rsiLen: 6 }, bars: randomDaily(300, 26), tf: 1440 },
  { id: 'orb_breakout', over: {}, bars: randomIntraday(5, 27), tf: 5 },
  { id: 'orb_breakout', over: { allowShort: 1, volMult: 1, stopMode: 1, trailMult: 1, rangeMin: 15, entryWindowMin: 240 }, bars: randomIntraday(5, 28), tf: 5 },
  // Querschnitt: der Rang kommt live aus decide(); hier fest, damit Einstiege überhaupt möglich sind.
  { id: 'cross_sectional_momentum', over: {}, bars: randomDaily(300, 29), tf: 1440, rank: { pct: 0, rank: 1, of: 10 } },
  { id: 'regime_allocation', over: { lookback: 63, skip: 0, regimeLen: 50 }, bars: randomDaily(300, 30), tf: 1440, rank: { pct: 0, rank: 1, of: 10 } },
  { id: 'regime_allocation', over: { lookback: 84, skip: 21, regimeLen: 100, exitPct: 0.4 }, bars: randomDaily(300, 31), tf: 1440, rank: { pct: 0, rank: 1, of: 10 } },
];

describe('Präfix-Suite deckt jede registrierte Strategie', () => {
  it('keine Familie ohne Lookahead-Wächter (§0.2)', () => {
    expect([...new Set(variants.map((v) => v.id))].sort()).toEqual([...strategyIds()].sort());
  });
});

describe.each(variants.map((v) => [`${v.id} ${JSON.stringify(v.over)}`, v] as const))('Präfix-Konsistenz: %s', (_label, v) => {
  const s = getStrategy(v.id);
  const p = withParams(s, v.over);
  const snapV = (bars: BarSeries, i: number, pos: PositionState | null = null) => {
    const sn = snapAt(bars, i, v.tf, pos);
    return v.rank ? { ...sn, rank: v.rank } : sn;
  };
  const n = v.bars.length;
  const probes = [0, 1, 2, 13, 14, 15, 20, 21, 22, 77, 78, 79, 99, 100, 101, 155, 156, 199, 200, 201, 250, n - 2, n - 1].filter((i) => i < n);

  it('precompute: Wert an i hängt nur von Bars ≤ i ab', () => {
    const full = s.precompute(v.bars, p);
    expect(Object.keys(full).length).toBeGreaterThan(0);
    for (const i of probes) {
      const pre = s.precompute(v.bars.prefix(i + 1), p);
      expect(Object.keys(pre).sort()).toEqual(Object.keys(full).sort());
      for (const [k, arr] of Object.entries(full)) {
        expect(arr.length).toBe(n);
        const pa = pre[k]!;
        expect(pa.length).toBe(i + 1);
        expect(Object.is(pa[i], arr[i]), `${k}[${i}]: Präfix ${pa[i]} vs voll ${arr[i]}`).toBe(true);
      }
    }
  });

  it('decide: Entscheidung an i ist mit Präfix und voller Serie identisch (ohne und mit Position)', () => {
    const full = s.precompute(v.bars, p);
    const start = s.warmupBars(p) - 1;
    let entries = 0;
    for (let i = start; i < n; i++) {
      const pre = v.bars.prefix(i + 1);
      const indPre = s.precompute(pre, p);
      const a = s.decide(snapV(v.bars, i), full, p);
      const b = s.decide(snapV(pre, i), indPre, p);
      expect(b).toEqual(a);
      if (s.crossScore) expect(s.crossScore(snapV(pre, i), indPre, p)).toEqual(s.crossScore(snapV(v.bars, i), full, p));
      if (a.kind === 'enter') entries++;
      // Synthetische Position: Einstieg vor fünf Bars, Hochwasser seither.
      const entry = v.bars.c[i - 5]!;
      let hw = entry;
      for (let k = i - 4; k <= i; k++) hw = Math.max(hw, v.bars.c[k]!);
      const pos = longPos({ entryPrice: entry, stop: entry * 0.97, initialStop: entry * 0.97, highWater: hw, barsHeld: 5 });
      const c = s.decide(snapV(v.bars, i, pos), full, p);
      const d = s.decide(snapV(pre, i, pos), indPre, p);
      expect(d).toEqual(c);
      expect(c.kind).not.toBe('enter');
    }
    // Der Test darf nicht leer laufen: über 300 Zufallsbars gibt es Einstiege — sonst misst er nichts.
    if (v.id !== 'orb_breakout') expect(entries).toBeGreaterThan(0);
  });

  it('Determinismus: zweimal precompute ⇒ identische Arrays', () => {
    expect(s.precompute(v.bars, p)).toEqual(s.precompute(v.bars, p));
  });

  it('jeder Einstieg hat einen Stop auf der Verlustseite und ein Ziel jenseits des Kurses', () => {
    const full = s.precompute(v.bars, p);
    for (let i = s.warmupBars(p) - 1; i < n; i++) {
      const d = s.decide(snapV(v.bars, i), full, p);
      if (d.kind !== 'enter') continue;
      const close = v.bars.c[i]!;
      expect(Number.isFinite(d.stop)).toBe(true);
      if (d.side === 'long') {
        expect(d.stop).toBeLessThan(close);
        if (d.target !== undefined) expect(d.target).toBeGreaterThan(close);
      } else {
        expect(d.stop).toBeGreaterThan(close);
        if (d.target !== undefined) expect(d.target).toBeLessThan(close);
      }
      if (p.allowShort === 0) expect(d.side).toBe('long');
    }
  });
});

/* ───────────────────────── trend_donchian ───────────────────────── */

describe('trend_donchian', () => {
  const s = getStrategy('trend_donchian');
  const p = withParams(s, { useBenchmarkFilter: 0 });
  const pRr = withParams(s, { useBenchmarkFilter: 0, rrMult: 2 });

  it('Ausbruch über das 20-Bar-Hoch im Aufwärtstrend ⇒ enter long mit Stop < Close (und Ziel > Close mit rrMult)', () => {
    const closes = ramp(150, 100, 0.1);
    closes.push(120);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    const i = 150;
    const d = s.decide(snapAt(bars, i, 1440), ind, p);
    expect(d.kind).toBe('enter');
    if (d.kind !== 'enter') return;
    expect(d.side).toBe('long');
    expect(d.stop).toBeLessThan(120);
    expect(d.stop).toBeCloseTo(120 - 2.5 * ind.atr![i]!, 9);
    expect(d.target).toBeUndefined();
    expect(d.reason).toMatch(/Donchian/);
    const d2 = s.decide(snapAt(bars, i, 1440), ind, pRr);
    expect(d2.kind === 'enter' && d2.target !== undefined && d2.target > 120).toBe(true);
    if (d2.kind === 'enter') expect(d2.target).toBeCloseTo(120 + 2 * 2.5 * ind.atr![i]!, 9);
  });

  it('kein Ausbruch, wenn der Close nur das eigene Hoch schlägt (Fenster exklusive aktueller Bar)', () => {
    const bars = dailyFromCloses(ramp(151, 100, 0.1));
    const ind = s.precompute(bars, p);
    // Close 114.9 liegt unter dem Vortages-Hoch 115.1 — ein normaler Trend-Tag, kein Ausbruch.
    expect(s.decide(snapAt(bars, 149, 1440), ind, p)).toEqual({ kind: 'hold' });
  });

  it('kein Enter ohne Trendfilter: Ausbruch über das 20-Bar-Hoch unter der EMA100 bleibt hold', () => {
    const closes = ramp(150, 200, -100 / 149);
    closes.push(115);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    const i = 150;
    expect(bars.c[i]!).toBeGreaterThan(ind.entryHigh![i]!); // Ausbruch liegt vor …
    expect(bars.c[i]!).toBeLessThan(ind.trend![i]!); // … aber unter dem Trend
    expect(s.decide(snapAt(bars, i, 1440), ind, p)).toEqual({ kind: 'hold' });
  });

  it('Benchmark-Filter: Long nur, wenn die Benchmark über ihrer SMA(benchLen) schließt', () => {
    const closes = ramp(250, 100, 0.1);
    closes.push(130);
    const bars = dailyFromCloses(closes);
    const pb = withParams(s, { useBenchmarkFilter: 1, benchLen: 100 });
    const ind = s.precompute(bars, pb);
    const i = 250;
    const benchUp = dailyFromCloses(ramp(251, 50, 0.2));
    const benchDown = dailyFromCloses(ramp(251, 300, -0.5));
    expect(s.decide(snapAt(bars, i, 1440, null, { bars: benchUp, i }), ind, pb).kind).toBe('enter');
    expect(s.decide(snapAt(bars, i, 1440, null, { bars: benchDown, i }), ind, pb)).toEqual({ kind: 'hold' });
    // Ohne Benchmark im Snapshot greift der Filter nicht.
    expect(s.decide(snapAt(bars, i, 1440), ind, pb).kind).toBe('enter');
    // Benchmark noch in der Aufwärmphase ⇒ kein Einstieg.
    expect(s.decide(snapAt(bars, i, 1440, null, { bars: benchUp.prefix(50), i: 49 }), ind, pb)).toEqual({ kind: 'hold' });
  });

  it('Exit-Signal nur beim Trendbruch (Close unter 10-Bar-Tief)', () => {
    const closes = ramp(160, 100, 0.1);
    closes.push(100);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    const pos = longPos({ entryPrice: 110, stop: 105, highWater: 115.9 });
    const d = s.decide(snapAt(bars, 160, 1440, pos), ind, p);
    expect(d.kind).toBe('exit');
    if (d.kind === 'exit') expect(d.reason).toMatch(/Trendbruch/);
    // Normaler Trend-Tag: kein Exit, kein Gegensignal.
    expect(s.decide(snapAt(bars, 159, 1440, longPos({ entryPrice: 110, stop: 105, highWater: 110 })), ind, p)).toEqual({ kind: 'hold' });
  });

  it('Trailing bewegt den Stop nur enger und nur im Plus', () => {
    const bars = dailyFromCloses(ramp(151, 100, 0.1));
    const ind = s.precompute(bars, p);
    const i = 149;
    const close = bars.c[i]!;
    const atrNow = ind.atr![i]!;
    // Nicht im Plus ⇒ hold.
    expect(s.decide(snapAt(bars, i, 1440, longPos({ entryPrice: 110, stop: 108, highWater: 110 })), ind, p)).toEqual({ kind: 'hold' });
    // Im Plus, Kandidat enger ⇒ move_stop auf highWater − 3·ATR.
    const d = s.decide(snapAt(bars, i, 1440, longPos({ entryPrice: 110, stop: 108, highWater: close })), ind, p);
    expect(d.kind).toBe('move_stop');
    if (d.kind === 'move_stop') {
      expect(d.stop).toBeCloseTo(close - 3 * atrNow, 9);
      expect(d.stop).toBeGreaterThan(108);
      expect(d.stop).toBeLessThan(close);
    }
    // Bestehender Stop bereits enger ⇒ hold.
    expect(s.decide(snapAt(bars, i, 1440, longPos({ entryPrice: 110, stop: close - 0.1, highWater: close })), ind, p)).toEqual({ kind: 'hold' });
    // Trailing aus ⇒ hold.
    const pOff = withParams(s, { useBenchmarkFilter: 0, trailMult: 0 });
    expect(s.decide(snapAt(bars, i, 1440, longPos({ entryPrice: 110, stop: 108, highWater: close })), ind, pOff)).toEqual({ kind: 'hold' });
  });

  it('Shorts nur mit allowShort = 1 (gespiegelt: Ausbruch unter das 20-Bar-Tief im Abwärtstrend)', () => {
    const closes = ramp(150, 200, -0.1);
    closes.push(180);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    expect(s.decide(snapAt(bars, 150, 1440), ind, p)).toEqual({ kind: 'hold' });
    const pS = withParams(s, { useBenchmarkFilter: 0, allowShort: 1, rrMult: 1 });
    const d = s.decide(snapAt(bars, 150, 1440), ind, pS);
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') {
      expect(d.side).toBe('short');
      expect(d.stop).toBeGreaterThan(180);
      expect(d.target).toBeLessThan(180);
    }
    // Short-Exit beim Trendbruch nach oben
    const up = ramp(160, 200, -0.1);
    up.push(200);
    const bars2 = dailyFromCloses(up);
    const ind2 = s.precompute(bars2, pS);
    const sp = longPos({ side: 'short', entryPrice: 190, stop: 195, highWater: 184.1 });
    expect(s.decide(snapAt(bars2, 160, 1440, sp), ind2, pS).kind).toBe('exit');
  });
});

/* ───────────────────────── momentum_pullback ───────────────────────── */

describe('momentum_pullback', () => {
  const s = getStrategy('momentum_pullback');
  const p = withParams(s, { useBenchmarkFilter: 0 });

  /** Aufwärtstrend, drei Rücksetzer-Bars, dann Erholungs-Bar — RSI(6) kreuzt 40 von unten. */
  function pullbackSeries(base: number, slope: number): BarSeries {
    const closes = ramp(150, base, slope);
    const last = closes[closes.length - 1]!;
    closes.push(last - 0.5, last - 1.0, last - 1.5, last - 1.5 + 1.2);
    return dailyFromCloses(closes);
  }

  it('Einstieg, wenn RSI im Aufwärtstrend von unter 40 auf ≥ 40 kreuzt; Ziel = 2 R', () => {
    const bars = pullbackSeries(100, 0.1);
    const ind = s.precompute(bars, p);
    const i = 153;
    expect(ind.rsi![i - 1]!).toBeLessThan(40);
    expect(ind.rsi![i]!).toBeGreaterThanOrEqual(40);
    // Die Bar davor: RSI unter 40, aber keine Kreuzung ⇒ hold.
    expect(s.decide(snapAt(bars, i - 1, 1440), ind, p)).toEqual({ kind: 'hold' });
    const d = s.decide(snapAt(bars, i, 1440), ind, p);
    expect(d.kind).toBe('enter');
    if (d.kind !== 'enter') return;
    const close = bars.c[i]!;
    const atrNow = ind.atr![i]!;
    expect(d.side).toBe('long');
    expect(d.stop).toBeCloseTo(close - 2.5 * atrNow, 9);
    expect(d.target).toBeCloseTo(close + 2 * 2.5 * atrNow, 9);
    expect(d.reason).toMatch(/Rücksetzer/);
  });

  it('kein Enter ohne Trend: dieselbe RSI-Kreuzung im Abwärtstrend bleibt hold', () => {
    const bars = pullbackSeries(200, -0.1);
    const ind = s.precompute(bars, p);
    const i = 153;
    expect(ind.rsi![i - 1]!).toBeLessThan(40);
    expect(ind.rsi![i]!).toBeGreaterThanOrEqual(40);
    expect(ind.emaFast![i]!).toBeLessThan(ind.emaSlow![i]!);
    expect(s.decide(snapAt(bars, i, 1440), ind, p)).toEqual({ kind: 'hold' });
  });

  it('Exit-Signal: EMA-Kreuzung nach unten; RSI-Exit nur mit exitOnRsi', () => {
    const down = dailyFromCloses(ramp(160, 200, -0.1));
    const indDown = s.precompute(down, p);
    const pos = longPos({ entryPrice: 190, stop: 185, highWater: 190 });
    const d = s.decide(snapAt(down, 159, 1440, pos), indDown, p);
    expect(d.kind).toBe('exit');
    if (d.kind === 'exit') expect(d.reason).toMatch(/Trendbruch/);

    const up = dailyFromCloses(ramp(160, 100, 0.1));
    const indUp = s.precompute(up, p);
    expect(indUp.rsi![159]!).toBeGreaterThan(75);
    const posUp = longPos({ entryPrice: 110, stop: 105, highWater: 110 });
    expect(s.decide(snapAt(up, 159, 1440, posUp), indUp, p)).toEqual({ kind: 'hold' });
    const pRsi = withParams(s, { useBenchmarkFilter: 0, exitOnRsi: 1 });
    const d2 = s.decide(snapAt(up, 159, 1440, posUp), indUp, pRsi);
    expect(d2.kind).toBe('exit');
    if (d2.kind === 'exit') expect(d2.reason).toMatch(/überkauft/);
  });

  it('Trailing nur im Plus und nur enger (trailMult = 2)', () => {
    const up = dailyFromCloses(ramp(160, 100, 0.1));
    const pT = withParams(s, { useBenchmarkFilter: 0, trailMult: 2 });
    const ind = s.precompute(up, pT);
    const i = 159;
    const close = up.c[i]!;
    expect(s.decide(snapAt(up, i, 1440, longPos({ entryPrice: 112, stop: 108, highWater: 112 })), ind, pT)).toEqual({ kind: 'hold' });
    const d = s.decide(snapAt(up, i, 1440, longPos({ entryPrice: 112, stop: 108, highWater: close })), ind, pT);
    expect(d.kind).toBe('move_stop');
    if (d.kind === 'move_stop') expect(d.stop).toBeCloseTo(close - 2 * ind.atr![i]!, 9);
  });

  it('Shorts nur mit allowShort = 1 (Erholung im Abwärtstrend endet, RSI kreuzt 60 von oben)', () => {
    const closes = ramp(150, 200, -0.1);
    const last = closes[closes.length - 1]!;
    closes.push(last + 0.5, last + 1.0, last + 1.5, last + 1.5 - 1.2);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    const i = 153;
    expect(ind.rsi![i - 1]!).toBeGreaterThan(60);
    expect(ind.rsi![i]!).toBeLessThanOrEqual(60);
    expect(s.decide(snapAt(bars, i, 1440), ind, p)).toEqual({ kind: 'hold' });
    const pS = withParams(s, { useBenchmarkFilter: 0, allowShort: 1 });
    const d = s.decide(snapAt(bars, i, 1440), ind, pS);
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') {
      expect(d.side).toBe('short');
      expect(d.stop).toBeGreaterThan(bars.c[i]!);
      expect(d.target).toBeLessThan(bars.c[i]!);
    }
  });
});

/* ───────────────────────── mean_reversion ───────────────────────── */

describe('mean_reversion', () => {
  const s = getStrategy('mean_reversion');
  const p = s.defaults;

  /** Aufwärtstrend über 250 Bars, dann drei Verlust-Bars ⇒ RSI(2) = 0, Close noch über SMA200. */
  function dipSeries(): BarSeries {
    const closes = ramp(250, 100, 0.1);
    const last = closes[closes.length - 1]!;
    closes.push(last - 1, last - 2, last - 3);
    return dailyFromCloses(closes);
  }

  it('Einstieg long: RSI(2) < 10 über der SMA200; Stop weit (3 ATR), kein Ziel', () => {
    const bars = dipSeries();
    const ind = s.precompute(bars, p);
    const i = 252;
    expect(bars.c[i]!).toBeGreaterThan(ind.regime![i]!);
    expect(ind.rsi![i]!).toBeLessThan(10);
    const d = s.decide(snapAt(bars, i, 1440), ind, p);
    expect(d.kind).toBe('enter');
    if (d.kind !== 'enter') return;
    expect(d.side).toBe('long');
    expect(d.stop).toBeCloseTo(bars.c[i]! - 3 * ind.atr![i]!, 9);
    expect(d.target).toBeUndefined();
    expect(d.reason).toMatch(/Überverkauft/);
  });

  it('nur long über der Regime-SMA: derselbe Rücksetzer unter der SMA200 bleibt hold', () => {
    const closes = ramp(250, 200, -0.1);
    const last = closes[closes.length - 1]!;
    closes.push(last - 1, last - 2, last - 3);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    const i = 252;
    expect(ind.rsi![i]!).toBeLessThan(10);
    expect(bars.c[i]!).toBeLessThan(ind.regime![i]!);
    expect(s.decide(snapAt(bars, i, 1440), ind, p)).toEqual({ kind: 'hold' });
    expect(s.decide(snapAt(bars, i, 1440), ind, withParams(s, { allowShort: 1 }))).toEqual({ kind: 'hold' });
  });

  it('z-Score-Einstieg nur mit useZ = 1 (RSI(6) fällt nicht unter 10, z < −2 schon)', () => {
    const closes = ramp(250, 100, 0.1);
    closes.push(closes[closes.length - 1]! - 2.5);
    const bars = dailyFromCloses(closes);
    const i = 250;
    const pOff = withParams(s, { rsiLen: 6, useZ: 0 });
    const pOn = withParams(s, { rsiLen: 6, useZ: 1 });
    const ind = s.precompute(bars, pOn);
    expect(ind.rsi![i]!).toBeGreaterThanOrEqual(10);
    expect(ind.z![i]!).toBeLessThan(-2);
    expect(s.decide(snapAt(bars, i, 1440), s.precompute(bars, pOff), pOff)).toEqual({ kind: 'hold' });
    const d = s.decide(snapAt(bars, i, 1440), ind, pOn);
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') expect(d.reason).toMatch(/z -?\d/);
  });

  it('Exit: Rückkehr zum Mittel, RSI-Erholung oder Zeitstopp — sonst hold (kein Trailing)', () => {
    const bars = dipSeries();
    const ind = s.precompute(bars, p);
    const i = 252;
    const close = bars.c[i]!;
    expect(close).toBeLessThan(ind.mean![i]!);
    const pos = longPos({ entryPrice: close + 1, stop: close - 5, highWater: close + 1 });
    expect(s.decide(snapAt(bars, i, 1440, pos), ind, p)).toEqual({ kind: 'hold' });
    const timed = s.decide(snapAt(bars, i, 1440, { ...pos, barsHeld: 7 }), ind, p);
    expect(timed.kind).toBe('exit');
    if (timed.kind === 'exit') expect(timed.reason).toMatch(/Zeitstopp/);
    // Im laufenden Aufwärtstrend liegt der Close über der SMA20 ⇒ Rückkehr-Exit.
    const back = s.decide(snapAt(bars, 200, 1440, longPos({ entryPrice: 115, stop: 110, highWater: 120 })), ind, p);
    expect(back.kind).toBe('exit');
    if (back.kind === 'exit') expect(back.reason).toMatch(/Rückkehr zum Mittel/);
    // Kein Trailing: auch weit im Plus bleibt der Stop, wo er ist.
    const pos2 = longPos({ entryPrice: 100, stop: 95, highWater: bars.c[249]! });
    const d2 = s.decide(snapAt(bars, 249, 1440, pos2), ind, p);
    expect(d2.kind).toBe('exit'); // Close > SMA20 im Trend — Rückkehr-Exit, nie move_stop
  });

  it('Shorts nur mit allowShort = 1 (RSI(2) > 90 unter der SMA200)', () => {
    const closes = ramp(250, 200, -0.1);
    const last = closes[closes.length - 1]!;
    closes.push(last + 1, last + 2, last + 3);
    const bars = dailyFromCloses(closes);
    const ind = s.precompute(bars, p);
    const i = 252;
    expect(ind.rsi![i]!).toBeGreaterThan(90);
    expect(s.decide(snapAt(bars, i, 1440), ind, p)).toEqual({ kind: 'hold' });
    const d = s.decide(snapAt(bars, i, 1440), ind, withParams(s, { allowShort: 1 }));
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') {
      expect(d.side).toBe('short');
      expect(d.stop).toBeGreaterThan(bars.c[i]!);
    }
  });
});

/* ───────────────────────── orb_breakout ───────────────────────── */

describe('orb_breakout', () => {
  const s = getStrategy('orb_breakout');
  const p = s.defaults;
  const TF = 5;
  const PER_DAY = 78;

  /** Ein 5-Minuten-Tag: die ersten sechs Bars (30 min) spannen die Range 99..101, danach Closes per Skript. */
  function scriptedDay(day: string, closeAt: Record<number, number>, volAt: Record<number, number> = {}): Bar[] {
    const [y, m, d] = ymd(day);
    const open = msFromET(y, m, d, 9, 30);
    const out: Bar[] = [];
    let prev = 100;
    for (let k = 0; k < PER_DAY; k++) {
      const t = open + k * TF * MIN;
      const v = volAt[k] ?? 1000;
      if (k < 6) {
        out.push({ t, o: 100, h: 101, l: 99, c: 100, v });
        continue;
      }
      const c = closeAt[k] ?? prev;
      out.push({ t, o: prev, h: Math.max(prev, c) + 0.1, l: Math.min(prev, c) - 0.1, c, v });
      prev = c;
    }
    return out;
  }

  const days = tradingDays('2026-03-02', 6);
  const series = BarSeries.from([
    // Tag 0: Ausbruch bei Bar 8 (40 min), Rückfall, zweiter Ausbruch bei Bar 10 — nur der erste zählt.
    ...scriptedDay(days[0]!, { 6: 100.5, 7: 100.8, 8: 101.5, 9: 100.9, 10: 101.7, 11: 101.2 }),
    // Tag 1: erster Ausbruch erst bei Bar 40 (200 min) — außerhalb des 150-Minuten-Fensters.
    ...scriptedDay(days[1]!, { 40: 102, 41: 102.5 }),
    // Tag 2: Ausbruch genau an der ersten Bar nach der Range (Bar 6, 30 min).
    ...scriptedDay(days[2]!, { 6: 101.5, 7: 101.8 }),
    // Tag 3: erst Ausbruch nach unten (Bar 7), dann nach oben (Bar 9).
    ...scriptedDay(days[3]!, { 7: 98.5, 8: 100.2, 9: 101.4 }),
    // Tag 4: Ausbruch bei Bar 8 mit Mini-Volumen, erneut bei Bar 12 mit hohem Volumen.
    ...scriptedDay(days[4]!, { 8: 101.5, 9: 100.5, 10: 100.7, 12: 101.6 }, { 8: 100, 12: 5000 }),
    // Tag 5: ruhig.
    ...scriptedDay(days[5]!, {}),
  ]);
  const idx = (day: number, k: number): number => day * PER_DAY + k;

  it('markiert genau die erste Ausbruchs-Bar je Tag, nur im Fenster', () => {
    const ind = s.precompute(series, p);
    const flagged: number[] = [];
    for (let i = 0; i < series.length; i++) if (ind.entryLong![i] === 1) flagged.push(i);
    expect(flagged).toEqual([idx(0, 8), idx(2, 6), idx(3, 9), idx(4, 8)]);
    expect(Array.from(ind.entryShort!).every((x) => x === 0)).toBe(true);
    // ORB-Werte gelten erst ab der ersten Bar nach der Range.
    expect(Number.isNaN(ind.orbHigh![idx(0, 5)]!)).toBe(true);
    expect(ind.orbHigh![idx(0, 6)]).toBe(101);
    expect(ind.orbLow![idx(0, 6)]).toBe(99);
  });

  it('decide: Einstieg mit Stop am ORB-Tief und Ziel = 2 R; danach hold für den Rest des Tages', () => {
    const ind = s.precompute(series, p);
    const i = idx(0, 8);
    const d = s.decide(snapAt(series, i, TF), ind, p);
    expect(d).toEqual({ kind: 'enter', side: 'long', stop: 99, target: 101.5 + 2 * (101.5 - 99), reason: expect.stringMatching(/ORB30/) });
    expect(s.decide(snapAt(series, idx(0, 10), TF), ind, p)).toEqual({ kind: 'hold' });
    expect(s.decide(snapAt(series, idx(0, 7), TF), ind, p)).toEqual({ kind: 'hold' });
    // Tag 1: kein Einstieg außerhalb des Fensters — an keiner Bar des Tages.
    for (let k = 0; k < PER_DAY; k++) expect(s.decide(snapAt(series, idx(1, k), TF), ind, p)).toEqual({ kind: 'hold' });
    // Mit offener Position an der Ausbruchs-Bar: kein zweiter Einstieg, Trailing aus ⇒ hold.
    expect(s.decide(snapAt(series, i, TF, longPos()), ind, p)).toEqual({ kind: 'hold' });
  });

  it('Fenster und Range sind Minuten-basiert: entryWindowMin 240 nimmt den Tag-1-Ausbruch bei 200 min mit', () => {
    const pw = withParams(s, { entryWindowMin: 240 });
    const ind = s.precompute(series, pw);
    expect(ind.entryLong![idx(1, 40)]).toBe(1);
    expect(ind.entryLong![idx(1, 41)]).toBe(0);
    // rangeMin 60: die Range umfasst 12 Bars; Tag-2-Ausbruch bei Bar 6 liegt noch IN der Range.
    const pr = withParams(s, { rangeMin: 60 });
    const ind2 = s.precompute(series, pr);
    expect(ind2.entryLong![idx(2, 6)]).toBe(0);
    expect(Number.isNaN(ind2.orbHigh![idx(2, 11)]!)).toBe(true);
    expect(ind2.orbHigh![idx(2, 12)]).toBeCloseTo(101.9, 9);
  });

  it('Volumen-Filter: Ausbruch mit Volumen unter volMult × SMA20 der Vorbars zählt nicht', () => {
    const pv = withParams(s, { volMult: 1.5 });
    const ind = s.precompute(series, pv);
    expect(ind.entryLong![idx(4, 8)]).toBe(0);
    expect(ind.entryLong![idx(4, 12)]).toBe(1);
    // Normalvolumen 1000 gegen SMA20 = 1000: 1000 > 1.5·1000 ist falsch ⇒ auch Tag 0 fällt durch den Filter.
    expect(ind.entryLong![idx(0, 8)]).toBe(0);
  });

  it('stopMode 1: Stop = Close − atrMult·ATR', () => {
    const pa = withParams(s, { stopMode: 1, atrMult: 1.5 });
    const ind = s.precompute(series, pa);
    const i = idx(2, 6);
    const d = s.decide(snapAt(series, i, TF), ind, pa);
    expect(d.kind).toBe('enter');
    if (d.kind === 'enter') {
      expect(d.stop).toBeCloseTo(101.5 - 1.5 * ind.atr![i]!, 9);
      expect(d.target).toBeCloseTo(101.5 + 2 * (101.5 - d.stop), 9);
    }
  });

  it('Shorts nur mit allowShort = 1 — und der Abwärts-Ausbruch verbraucht dann den Tages-Einstieg', () => {
    const ind = s.precompute(series, p);
    expect(s.decide(snapAt(series, idx(3, 7), TF), ind, p)).toEqual({ kind: 'hold' });
    const ps = withParams(s, { allowShort: 1 });
    const indS = s.precompute(series, ps);
    expect(indS.entryShort![idx(3, 7)]).toBe(1);
    expect(indS.entryLong![idx(3, 9)]).toBe(0);
    const d = s.decide(snapAt(series, idx(3, 7), TF), indS, ps);
    expect(d).toEqual({ kind: 'enter', side: 'short', stop: 101, target: 98.5 - 2 * (101 - 98.5), reason: expect.stringMatching(/ORB30/) });
  });

  it('Trailing mit trailMult = 1: nur im Plus, nur enger', () => {
    const pt = withParams(s, { trailMult: 1 });
    const ind = s.precompute(series, pt);
    const i = idx(2, 20);
    const close = series.c[i]!;
    const atrNow = ind.atr![i]!;
    expect(s.decide(snapAt(series, i, TF, longPos({ entryPrice: 101.5, stop: 99, highWater: 101.5 })), ind, pt)).toEqual({ kind: 'hold' });
    const d = s.decide(snapAt(series, i, TF, longPos({ entryPrice: 101.5, stop: 99, highWater: 101.8 })), ind, pt);
    expect(d.kind).toBe('move_stop');
    if (d.kind === 'move_stop') {
      expect(d.stop).toBeCloseTo(101.8 - atrNow, 9);
      expect(d.stop).toBeLessThan(close);
    }
  });

  it('Decision-Objekte sind frisch (hold ist kein geteiltes Objekt)', () => {
    const ind = s.precompute(series, p);
    const a: Decision = s.decide(snapAt(series, 3, TF), ind, p);
    const b: Decision = s.decide(snapAt(series, 3, TF), ind, p);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
