/**
 * index_reversal — überverkauft kaufen, aber nur im Aufwärtstrend.
 *
 * Geprüft wird durch `decide()` in core/logic.ts, wie live: Der Rang kommt
 * aus dem Kern, die Stückzahl aus dem Risiko-Budget. Der teuerste Fehler
 * dieser Familie hat einen eigenen Test — ins fallende Messer greifen. Am
 * Ende läuft sie einmal durch den echten Simulator.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { addDays, isTradingDay, msFromET, parseDay } from '../../src/core/time.ts';
import type { Bar, HaltState, PositionState, SessionInfo } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import { baseConfig } from '../backtest/helpers.ts';

const s = getStrategy('index_reversal');
const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const params = resolveParams(s, {});

/* ───────────────────────── Serien ───────────────────────── */

function handelstage(n: number, von = '2024-01-02'): string[] {
  const out: string[] = [];
  for (let d = von; out.length < n; d = addDays(d, 1)) {
    if (isTradingDay(d, 'us_equity')) out.push(d);
  }
  return out;
}

/** Tagesbars aus Schlusskursen: Open = Vorschluss, Hoch/Tief ±0,3 um beide. */
function serie(closes: readonly number[]): BarSeries {
  const tage = handelstage(closes.length);
  const bars: Bar[] = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    const { y, m, d } = parseDay(tage[i]!);
    return { t: msFromET(y, m, d, 9, 30), o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 500_000 };
  });
  return BarSeries.from(bars);
}

/** `nUp` Bars mit +0,15 % je Bar, danach `nDown` Bars mit `dn`. */
function rampe(nUp: number, nDown: number, dn = 0.98, start = 100): number[] {
  const cl: number[] = [];
  let p = start;
  for (let i = 0; i < nUp; i++) {
    cl.push(p);
    p *= 1.0015;
  }
  for (let i = 0; i < nDown; i++) {
    p *= dn;
    cl.push(p);
  }
  return cl;
}

const okSession: SessionInfo = { isRegularSession: true, minutesToClose: 0, minutesSinceOpen: 390, barsSinceOpen: 1, isLastBarOfDay: true, day: '2024-11-01' };
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

function input(symbol: string, bars: BarSeries, position: PositionState | null = null): SymbolInput {
  const i = bars.length - 1;
  return { snap: { symbol, bars, i, position, session: okSession }, strategy: s, params, ind: s.precompute(bars, params) };
}

function ctx(over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: Date.UTC(2024, 10, 1, 21, 0),
    today: '2024-11-01',
    nextTradingDay: '2024-11-04',
    account: { equity: 1_000_000, cash: 1_000_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: cfg.risk,
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 1440,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}

function position(entryPrice: number, barsHeld = 1, highWater = entryPrice): PositionState {
  return {
    symbol: 'AAA',
    side: 'long',
    qty: 10,
    entryPrice,
    entryTime: 0,
    stop: entryPrice * 0.95,
    target: null,
    initialStop: entryPrice * 0.95,
    highWater,
    strategy: s.id,
    barsHeld,
    entryDay: '2024-10-30',
  };
}

const urteil = (bars: BarSeries, pos: PositionState | null = null): string => {
  const c = ctx(pos ? { positions: new Map([['AAA', pos]]) } : {});
  return decide(c, [input('AAA', bars, pos)]).intents[0]?.kind ?? 'hold';
};

/* ───────────────────────── Einstieg ───────────────────────── */

describe('index_reversal: Einstieg', () => {
  it('kauft den Rücksetzer im Aufwärtstrend (RSI(2) unter 10, Close über SMA(200))', () => {
    const bars = serie(rampe(220, 1));
    const ind = s.precompute(bars, params);
    const i = bars.length - 1;
    expect(ind.rsi![i]!).toBeLessThan(10);
    expect(bars.c[i]!).toBeGreaterThan(ind.trend![i]!);
    expect(urteil(bars)).toBe('enter');
  });

  it('greift NICHT ins fallende Messer: überverkauft UNTER dem SMA(200) bleibt unangetastet', () => {
    // Derselbe Rücksetzer, aber in einem Abwärtstrend — der Fall, in dem diese
    // Familie Geld verliert, wenn der Trendfilter fehlt.
    const cl: number[] = [];
    let p = 200;
    for (let i = 0; i < 220; i++) {
      cl.push(p);
      p *= 0.9985;
    }
    for (let i = 0; i < 3; i++) {
      p *= 0.98;
      cl.push(p);
    }
    const bars = serie(cl);
    const ind = s.precompute(bars, params);
    const i = bars.length - 1;
    expect(ind.rsi![i]!).toBeLessThan(10);
    expect(bars.c[i]!).toBeLessThan(ind.trend![i]!);
    expect(urteil(bars)).toBe('hold');
  });

  it('kauft NICHT ohne Extrem: im ruhigen Aufwärtstrend passiert nichts', () => {
    const bars = serie(rampe(221, 0));
    const ind = s.precompute(bars, params);
    expect(ind.rsi![bars.length - 1]!).toBeGreaterThan(10);
    expect(urteil(bars)).toBe('hold');
  });

  it('der Stop liegt 4 ATR unter dem Einstand, es gibt kein Ziel, und die Stückzahl folgt dem Risiko-Budget', () => {
    const bars = serie(rampe(220, 1));
    const ind = s.precompute(bars, params);
    const i = bars.length - 1;
    const r = decide(ctx({ risk: { ...cfg.risk, maxPositionPct: 100 } }), [input('AAA', bars)]);
    const e = r.intents[0];
    if (e?.kind !== 'enter') throw new Error('kein Einstieg');
    expect(e.side).toBe('long');
    expect(e.target).toBeNull();
    expect(e.stop).toBeCloseTo(bars.c[i]! - 4 * ind.atr![i]!, 9);
    const risiko = e.qty * (e.refPrice - e.stop);
    const budget = (1_000_000 * cfg.risk.riskPerTradePct) / 100;
    expect(risiko).toBeLessThanOrEqual(budget);
    expect(risiko).toBeGreaterThan(budget - (e.refPrice - e.stop));
  });
});

/* ───────────────────────── Ausstieg ───────────────────────── */

describe('index_reversal: Ausstieg', () => {
  it('steigt bei der ersten Stärke aus: Schluss über dem Vortageshoch', () => {
    const cl = rampe(220, 3);
    cl.push(cl.at(-1)! * 1.03);
    const bars = serie(cl);
    const ind = s.precompute(bars, params);
    const i = bars.length - 1;
    expect(ind.rsi![i]!).toBeLessThan(70); // NICHT der RSI-Exit
    expect(bars.c[i]!).toBeGreaterThan(ind.prevHigh![i]!);
    const r = decide(ctx({ positions: new Map([['AAA', position(130)]]) }), [input('AAA', bars, position(130))]);
    expect(r.intents[0]?.kind).toBe('exit');
    expect(r.notes.some((n) => /erste Stärke/.test(n.text))).toBe(true);
  });

  it('steigt aus, wenn der RSI über 70 dreht', () => {
    const cl = rampe(220, 3);
    cl.push(cl.at(-1)! * 1.035);
    cl.push(cl.at(-1)! * 1.035);
    const bars = serie(cl);
    const ind = s.precompute(bars, params);
    expect(ind.rsi![bars.length - 1]!).toBeGreaterThan(70);
    const r = decide(ctx({ positions: new Map([['AAA', position(130)]]) }), [input('AAA', bars, position(130))]);
    expect(r.intents[0]?.kind).toBe('exit');
    expect(r.notes.some((n) => /RSI2 8\d\.\d über 70/.test(n.text))).toBe(true);
  });

  it('der Zeitstopp ist Pflicht: nach fünf Bars ist Schluss, auch wenn die These nicht aufgegangen ist', () => {
    const bars = serie(rampe(220, 3)); // weiter tief, kein Signal-Exit
    const ind = s.precompute(bars, params);
    const i = bars.length - 1;
    expect(ind.rsi![i]!).toBeLessThan(70);
    expect(bars.c[i]!).toBeLessThan(ind.prevHigh![i]!);
    expect(urteil(bars, position(140, 4))).toBe('hold');
    const r = decide(ctx({ positions: new Map([['AAA', position(140, 5)]]) }), [input('AAA', bars, position(140, 5))]);
    expect(r.intents[0]?.kind).toBe('exit');
    expect(r.notes.some((n) => /Zeitstopp: 5 Bars ≥ 5/.test(n.text))).toBe(true);
  });

  it('zieht den Stop NIE nach — ein Trailing würde die Erholung abschneiden (T8/F1)', () => {
    const bars = serie(rampe(220, 3));
    for (let i = s.warmupBars(params) - 1; i < bars.length; i++) {
      const pre = bars.prefix(i + 1);
      const ind = s.precompute(pre, params);
      // Position deutlich im Plus: genau die Lage, in der jede Trailing-Regel zuschlägt.
      const pos = position(bars.c[i]! * 0.9, 1, bars.c[i]!);
      expect(s.decide({ symbol: 'AAA', bars: pre, i, position: pos, session: okSession }, ind, params).kind).not.toBe('move_stop');
    }
  });
});

/* ───────────────────────── Querschnitt: der tiefste Rücksetzer zuerst ───────────────────────── */

describe('index_reversal: knappe Plätze gehen an den tiefsten Rücksetzer', () => {
  const flach = serie(rampe(220, 1)); // RSI ≈ 7,5
  const tief = serie(rampe(218, 3)); // RSI ≈ 1,1

  it('die Rangkennzahl ist −RSI: überverkaufter heißt weiter vorn', () => {
    const iF = flach.length - 1;
    const iT = tief.length - 1;
    const sF = s.crossScore!({ symbol: 'FLACH', bars: flach, i: iF, position: null, session: okSession }, s.precompute(flach, params), params);
    const sT = s.crossScore!({ symbol: 'TIEF', bars: tief, i: iT, position: null, session: okSession }, s.precompute(tief, params), params);
    expect(sT!).toBeGreaterThan(sF!);
  });

  it('bei einem freien Platz gewinnt der tiefere Rücksetzer, bei zwei kommen beide', () => {
    const korb = [input('FLACH', flach), input('TIEF', tief)];
    const einer = decide(ctx({ risk: { ...cfg.risk, maxPositions: 1 } }), korb);
    expect(einer.intents.filter((i) => i.kind === 'enter').map((i) => i.symbol)).toEqual(['TIEF']);
    const zwei = decide(ctx({ risk: { ...cfg.risk, maxPositions: 2 } }), korb);
    expect(
      zwei.intents
        .filter((i) => i.kind === 'enter')
        .map((i) => i.symbol)
        .sort(),
    ).toEqual(['FLACH', 'TIEF']);
  });

  it('die Strategie selbst liest den Rang NICHT — ohne Rang entscheidet sie genauso', () => {
    const bars = serie(rampe(220, 1));
    const ind = s.precompute(bars, params);
    const i = bars.length - 1;
    const ohne = s.decide({ symbol: 'AAA', bars, i, position: null, session: okSession }, ind, params);
    const mit = s.decide({ symbol: 'AAA', bars, i, position: null, session: okSession, rank: { pct: 1, rank: 9, of: 9 } }, ind, params);
    expect(mit).toEqual(ohne);
    expect(ohne.kind).toBe('enter');
  });
});

/* ───────────────────────── Vertrag & Simulator ───────────────────────── */

describe('index_reversal: Vertrag und Simulator', () => {
  it('nur Tagesbars, hält über Nacht, Warmup deckt den 200er-Trendfilter', () => {
    expect(s.timeframes).toEqual([1440]);
    expect(s.holdsOvernight).toBe(true);
    expect(s.warmupBars(params)).toBe(202);
  });

  it('handelt den Sägezahn: viele kurze Trades, alle im Aufwärtstrend, Haltedauer ≤ 5 Bars', () => {
    // Aufwärtstrend mit regelmäßigen Dreitage-Rücksetzern — die Lage, für die
    // die Familie gebaut ist.
    const cl: number[] = [];
    let p = 100;
    for (let i = 0; i < 220; i++) {
      cl.push(p);
      p *= 1.0015;
    }
    while (cl.length < 520) {
      for (let i = 0; i < 3; i++) {
        p *= 0.98;
        cl.push(p);
      }
      for (let i = 0; i < 6; i++) {
        p *= 1.012;
        cl.push(p);
      }
    }
    const bars = serie(cl.slice(0, 520));
    const ind = s.precompute(bars, params);
    const res = simulate({
      bars: new Map([['SPY', bars]]),
      strategyFor: () => ({ strategy: s, params }),
      config: baseConfig({ timeframe: 1440, risk: { maxPositions: 4 } }),
      initialEquity: 100_000,
    });
    expect(res.trades.length).toBeGreaterThanOrEqual(20);
    for (const t of res.trades) {
      expect(t.side).toBe('long');
      expect(t.barsHeld).toBeLessThanOrEqual(5);
      // Der Einstieg wurde an der Bar VOR dem Fill entschieden: dort lag der
      // Kurs über dem Trendmittel und der RSI unter 10.
      const iFill = bars.t.findIndex((x) => x === t.entryTime);
      expect(iFill).toBeGreaterThan(0);
      expect(ind.rsi![iFill - 1]!).toBeLessThan(10);
      expect(bars.c[iFill - 1]!).toBeGreaterThan(ind.trend![iFill - 1]!);
    }
  });
});
