/**
 * vigilant_allocation — die Familie, die im Bärenmarkt etwas verdienen soll,
 * statt nur nicht zu verlieren.
 *
 * Der wichtigste Test dieser Datei ist der zweite Block: Er zeigt mit
 * Zahlen, WARUM es sie gibt. `regime_allocation` rangiert nach `mom / rvol`;
 * ein Geldmarkt-Papier hat eine Volatilität nahe null und stünde damit auch
 * im Bullenmarkt auf Rang 1. Eine Familie, die in den Geldmarkt rotieren
 * soll, braucht deshalb eine Kennzahl ohne diese Normierung — 13612W. Wer
 * diesen Test löscht, löscht die Begründung der Familie.
 *
 * Geprüft wird durch `decide()` in core/logic.ts, wie live: Der Rang kommt
 * aus dem Kern (§0.2), die Stückzahl aus dem Risiko-Budget.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { decide, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { addDays, isTradingDay, msFromET, parseDay } from '../../src/core/time.ts';
import type { Bar, HaltState, PositionState, SessionInfo } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';
import { MIN_KORB_VIGILANT, MOM_GEWICHTE, MOM_HORIZONTE, momentum13612w } from '../../src/strategy/vigilantAllocation.ts';

const s = getStrategy('vigilant_allocation');
const regime = getStrategy('regime_allocation');
const cfg = parseConfig({ universe: { symbols: ['AAA'] }, timeframe: 1440 });
const params = resolveParams(s, {});

/* ───────────────────────── Serien auf echten Handelstagen ───────────────────────── */

function handelstage(n: number, von = '2024-01-02'): string[] {
  const out: string[] = [];
  for (let d = von; out.length < n; d = addDays(d, 1)) {
    if (isTradingDay(d, 'us_equity')) out.push(d);
  }
  return out;
}
const TAGE = handelstage(400);

function serie(kurs: (k: number) => number, n = 400): BarSeries {
  const bars: Bar[] = TAGE.slice(0, n).map((day, k) => {
    const c = kurs(k);
    const { y, m, d } = parseDay(day);
    return { t: msFromET(y, m, d, 9, 30), o: c, h: c * 1.002, l: c * 0.998, c, v: 500_000 };
  });
  return BarSeries.from(bars);
}

/** Erster Tag eines Rebalance-Fensters deutlich nach der Aufwärmphase (255 Bars). */
const REBAL = 273; // 2025-02-03, erster Handelstag des Monats
const KEIN_REBAL = 255; // 2025-01-07, mitten im Monat

/** Geldmarkt-Surrogat: +1,5 % über 400 Bars, praktisch ohne Schwankung (BIL, bereinigt). */
const geldmarkt = (k: number): number => 100 * (1 + 0.0000375 * k) * (1 + (k % 2 === 0 ? 0.0001 : -0.0001));
/** Aktien-ETF: `gesamt` über 400 Bars, 1 % Zickzack. */
const aktie =
  (gesamt: number) =>
  (k: number): number =>
    100 * (1 + (gesamt * k) / 400) * (1 + (k % 2 === 0 ? 0.01 : -0.01));

const okSession: SessionInfo = { isRegularSession: true, minutesToClose: 0, minutesSinceOpen: 390, barsSinceOpen: 1, isLastBarOfDay: true, day: '2025-02-03' };
const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

function input(symbol: string, bars: BarSeries, position: PositionState | null = null): SymbolInput {
  const i = bars.length - 1;
  return { snap: { symbol, bars, i, position, session: okSession }, strategy: s, params, ind: s.precompute(bars, params) };
}

function ctx(over: Partial<LogicContext> = {}): LogicContext {
  return {
    now: Date.UTC(2025, 1, 3, 21, 0),
    today: '2025-02-03',
    nextTradingDay: '2025-02-04',
    account: { equity: 1_000_000, cash: 1_000_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
    positions: new Map(),
    pendingEntries: new Set(),
    halt: noHalt,
    risk: { ...cfg.risk, maxPositions: 50, maxPositionPct: 100 },
    session: cfg.session,
    assetClass: 'us_equity',
    timeframe: 1440,
    dataFresh: true,
    localDayTrades: 0,
    assetFacts: () => ({ tradable: true, shortable: true }),
    ...over,
  };
}

function position(symbol: string, entryPrice: number): PositionState {
  return {
    symbol,
    side: 'long',
    qty: 10,
    entryPrice,
    entryTime: 0,
    stop: entryPrice * 0.8,
    target: null,
    initialStop: entryPrice * 0.8,
    highWater: entryPrice,
    strategy: s.id,
    barsHeld: 25,
    entryDay: '2025-01-02',
  };
}

const einstiege = (r: ReturnType<typeof decide>): string[] =>
  r.intents
    .filter((i) => i.kind === 'enter')
    .map((i) => i.symbol)
    .sort();

/** Korb aus n Aktien-ETFs mit absteigender Stärke, Serie bis Index `bis`. */
function korb(bis: number, n = 9, ab = 0.6): SymbolInput[] {
  return Array.from({ length: n }, (_, k) => input(`S${String(k).padStart(2, '0')}`, serie(aktie(ab - k * 0.05), bis + 1)));
}

/* ───────────────────────── 1. Die Kennzahl ───────────────────────── */

describe('vigilant_allocation: 13612W', () => {
  it('gewichtet die vier Horizonte wie die Quelle (12/4/2/1 über 21/63/126/252 Bars)', () => {
    expect([...MOM_HORIZONTE]).toEqual([21, 63, 126, 252]);
    expect([...MOM_GEWICHTE]).toEqual([12, 4, 2, 1]);
    const n = 301;
    const cl = new Float64Array(n).fill(90);
    const I = 300;
    cl[I] = 120;
    cl[I - 21] = 100; // r1 = 0,20
    cl[I - 63] = 96; // r3 = 0,25
    cl[I - 126] = 80; // r6 = 0,50
    cl[I - 252] = 60; // r12 = 1,00
    // 12·0,20 + 4·0,25 + 2·0,50 + 1·1,00 = 5,4
    expect(momentum13612w(cl)[I]!).toBeCloseTo(5.4, 12);
  });

  it('ist NaN, solange der Zwölf-Monats-Horizont nicht vollständig in der Vergangenheit liegt', () => {
    const bars = serie(aktie(0.5));
    const ind = s.precompute(bars, params);
    expect(ind.mom![251]!).toBeNaN();
    expect(Number.isFinite(ind.mom![252]!)).toBe(true);
    expect(s.warmupBars(params)).toBe(255);
  });

  it('der jüngste Monat wiegt am schwersten — die Kennzahl dreht schnell', () => {
    // Zwölf Monate +30 %, dann ein Monat −12 %: Das Jahresmomentum ist noch
    // positiv, 13612W schon negativ. Genau das ist der Zweck des Gewichts 12.
    const n = 300;
    const cl = new Float64Array(n);
    for (let i = 0; i < n; i++) cl[i] = i <= n - 22 ? 100 * (1 + (0.3 * i) / (n - 22)) : 130 * (1 - (0.12 * (i - (n - 22))) / 21);
    const I = n - 1;
    expect(cl[I]! / cl[I - 252]! - 1).toBeGreaterThan(0); // Jahresrendite positiv
    expect(momentum13612w(cl)[I]!).toBeLessThan(0); // 13612W negativ
  });
});

/* ───────────────────────── 2. Warum es die Familie gibt ───────────────────────── */

describe('vigilant_allocation: warum nicht regime_allocation auf demselben Korb', () => {
  const geld = serie(geldmarkt);
  const spy = serie(aktie(0.25));
  const i = geld.length - 1;
  const snapOf = (bars: BarSeries) => ({ symbol: 'X', bars, i, position: null, session: okSession });

  it('regime_allocation setzt das Geldmarkt-Papier auch im Bullenmarkt auf Rang 1 — mom/rvol dividiert durch fast null', () => {
    const pr = resolveParams(regime, {});
    const scoreGeld = regime.crossScore!(snapOf(geld), regime.precompute(geld, pr), pr)!;
    const scoreSpy = regime.crossScore!(snapOf(spy), regime.precompute(spy, pr), pr)!;
    expect(scoreGeld).toBeGreaterThan(scoreSpy);
    // Der Grund, nachrechenbar: 0,3 % Schwankung p. a. gegen 32 %.
    expect(regime.precompute(geld, pr).rvol![i]!).toBeLessThan(0.01);
    expect(regime.precompute(spy, pr).rvol![i]!).toBeGreaterThan(0.1);
  });

  it('vigilant_allocation setzt es dort auf den letzten Platz — 13612W ist nicht volatilitätsnormiert', () => {
    const scoreGeld = s.crossScore!(snapOf(geld), s.precompute(geld, params), params)!;
    const scoreSpy = s.crossScore!(snapOf(spy), s.precompute(spy, params), params)!;
    expect(scoreGeld).toBeLessThan(scoreSpy);
    expect(scoreGeld).toBeGreaterThan(0); // positiv bleibt es: im Bärenmarkt trägt genau das
  });
});

/* ───────────────────────── 3. Die Rotation ───────────────────────── */

describe('vigilant_allocation: Rotation statt Kasse', () => {
  it('im Bullenmarkt kauft sie die stärksten Aktien-ETFs, nicht den Geldmarkt', () => {
    const k = [input('GELD', serie(geldmarkt, REBAL + 1)), ...korb(REBAL, 8)];
    expect(einstiege(decide(ctx(), k))).toEqual(['S00', 'S01']);
  });

  it('fällt alles außer dem Geldmarkt, kauft sie NUR den Geldmarkt — ein Fold im Geldmarkt ist positiv, ein Fold in Kasse nicht', () => {
    const fallend = Array.from({ length: 8 }, (_, k) => input(`S${String(k).padStart(2, '0')}`, serie(aktie(-0.2 - k * 0.05), REBAL + 1)));
    const k = [input('GELD', serie(geldmarkt, REBAL + 1)), ...fallend];
    // topN = 2, aber nur ein Papier hat positives 13612W: Dual Momentum lässt
    // den zweiten Platz leer, statt den am wenigsten Fallenden zu kaufen.
    expect(einstiege(decide(ctx(), k))).toEqual(['GELD']);
  });

  it('ohne Geldmarkt-Papier im Korb bleibt im Bärenmarkt nur Kasse — deshalb gehört BIL/SHY in den Korb', () => {
    const fallend = Array.from({ length: 9 }, (_, k) => input(`S${String(k).padStart(2, '0')}`, serie(aktie(-0.2 - k * 0.05), REBAL + 1)));
    expect(einstiege(decide(ctx(), fallend))).toEqual([]);
  });

  it('kauft NICHT den relativ Stärksten eines fallenden Korbs (Dual Momentum)', () => {
    const fallend = Array.from({ length: 9 }, (_, k) => input(`S${String(k).padStart(2, '0')}`, serie(aktie(-0.05 - k * 0.05), REBAL + 1)));
    const r = decide(ctx(), fallend);
    const ind = s.precompute(serie(aktie(-0.05), REBAL + 1), params);
    expect(ind.mom![REBAL]!).toBeLessThan(0); // auch der Beste ist negativ
    expect(einstiege(r)).toEqual([]);
  });

  it('rührt sich nicht, wenn zu wenige Papiere rangieren (MIN_KORB_VIGILANT)', () => {
    expect(MIN_KORB_VIGILANT).toBe(5);
    expect(decide(ctx(), korb(REBAL, MIN_KORB_VIGILANT - 1)).intents).toHaveLength(0);
    expect(decide(ctx(), korb(REBAL, MIN_KORB_VIGILANT)).intents.length).toBeGreaterThan(0);
  });
});

/* ───────────────────────── 4. Fenster und Ausstiege ───────────────────────── */

describe('vigilant_allocation: Monatsrhythmus', () => {
  it('außerhalb des Fensters entscheidet sie nichts — weder Einstieg noch Ausstieg', () => {
    const c = ctx({ now: Date.UTC(2025, 0, 7, 21, 0), today: '2025-01-07' });
    expect(decide(c, korb(KEIN_REBAL)).intents).toHaveLength(0);
    // Position in einem fallenden Papier: im Fenster wäre das ein Ausstieg.
    const fallend = serie(aktie(-0.3), KEIN_REBAL + 1);
    const pos = position('S00', fallend.c[KEIN_REBAL]! * 1.2);
    const r = decide({ ...c, positions: new Map([['S00', pos]]) }, [input('S00', fallend, pos), ...korb(KEIN_REBAL).slice(1)]);
    expect(r.intents).toHaveLength(0);
  });

  it('im Fenster steigt sie aus, wenn das eigene 13612W negativ ist', () => {
    const fallend = serie(aktie(-0.3), REBAL + 1);
    const pos = position('S00', fallend.c[REBAL]! * 1.2);
    const r = decide(ctx({ positions: new Map([['S00', pos]]) }), [input('S00', fallend, pos), ...korb(REBAL).slice(1)]);
    expect(r.intents.some((i) => i.kind === 'exit' && i.symbol === 'S00')).toBe(true);
    expect(r.notes.some((n) => n.symbol === 'S00' && /13612W negativ/.test(n.text))).toBe(true);
  });

  it('im Fenster steigt sie aus, wenn der Rang schlechter als exitRank ist — bei positivem Momentum', () => {
    const k = korb(REBAL, 9);
    const schwach = k[8]!; // Rang 9 von 9 > exitRank 4
    const ind = s.precompute(schwach.snap.bars as BarSeries, params);
    expect(ind.mom![REBAL]!).toBeGreaterThan(0); // nicht der Momentum-Exit
    const pos = position('S08', schwach.snap.bars.c[REBAL]!);
    const r = decide(ctx({ positions: new Map([['S08', pos]]) }), [...k.slice(0, 8), { ...schwach, snap: { ...schwach.snap, position: pos } }]);
    expect(r.notes.some((n) => n.symbol === 'S08' && /relative Stärke verloren: Rang 9\/9/.test(n.text))).toBe(true);
  });

  it('hält im Fenster, was stark und positiv bleibt', () => {
    const k = korb(REBAL, 9);
    const stark = k[0]!;
    const pos = position('S00', stark.snap.bars.c[REBAL]! * 0.9);
    const r = decide(ctx({ positions: new Map([['S00', pos]]) }), [{ ...stark, snap: { ...stark.snap, position: pos } }, ...k.slice(1)]);
    expect(r.intents.filter((i) => i.symbol === 'S00')).toHaveLength(0);
  });
});

/* ───────────────────────── 5. Stop, Sizing, Vertrag ───────────────────────── */

describe('vigilant_allocation: Stop, Sizing, Vertrag', () => {
  it('der Katastrophen-Stop liegt 20 % unter dem Einstand, ohne Ziel, und trägt das Risiko-Budget', () => {
    const r = decide(ctx(), korb(REBAL));
    const e = r.intents.find((i) => i.kind === 'enter' && i.symbol === 'S00');
    if (e?.kind !== 'enter') throw new Error('kein Einstieg');
    expect(e.stop).toBeCloseTo(e.refPrice * 0.8, 9);
    expect(e.target).toBeNull();
    const risiko = e.qty * (e.refPrice - e.stop);
    const budget = (1_000_000 * cfg.risk.riskPerTradePct) / 100;
    expect(risiko).toBeLessThanOrEqual(budget);
    expect(risiko).toBeGreaterThan(budget - (e.refPrice - e.stop));
  });

  it('zieht den Stop NIE nach (T8: weiter Katastrophen-Stop, kein Trailing)', () => {
    const bars = serie(aktie(0.6));
    for (let i = s.warmupBars(params) - 1; i < bars.length; i++) {
      const pre = bars.prefix(i + 1);
      const ind = s.precompute(pre, params);
      const pos = position('AAA', bars.c[i]! * 0.8);
      const d = s.decide({ symbol: 'AAA', bars: pre, i, position: { ...pos, highWater: bars.c[i]! }, session: okSession, rank: { pct: 0, rank: 1, of: 9 } }, ind, params);
      expect(d.kind).not.toBe('move_stop');
    }
  });

  it('nur Tagesbars, hält über Nacht, kein Short — und der Monatsrhythmus stammt aus derselben Funktion wie regime_allocation', () => {
    expect(s.timeframes).toEqual([1440]);
    expect(s.holdsOvernight).toBe(true);
    const bars = serie(aktie(0.3));
    expect([...s.precompute(bars, params).rebal!]).toEqual([...regime.precompute(bars, resolveParams(regime, {})).rebal!]);
  });
});
