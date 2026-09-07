import { describe, expect, it } from 'vitest';
import { fillCosts, regulatoryFees } from '../../src/backtest/costs.ts';
import { simulate, type SimInput } from '../../src/backtest/simulator.ts';
import { randomWalkBars } from '../../src/backtest/synthetic.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { dayKeyFor, msFromET } from '../../src/core/time.ts';
import type { Decision, Strategy, Trade } from '../../src/core/types.ts';
import { baseConfig, barsMap, dayBars5, flat, fullDay5, strategyOf, type Ohlc } from './helpers.ts';

const D1 = '2026-09-01'; // Dienstag
const D2 = '2026-09-02';
const D3 = '2026-09-03';
const cfg = baseConfig();
const C = cfg.costs;

function run(over: Partial<SimInput> & { bars: SimInput['bars']; strategy: Strategy }): ReturnType<typeof simulate> {
  const { strategy, ...rest } = over;
  return simulate({
    strategyFor: () => ({ strategy, params: {} }),
    config: cfg,
    initialEquity: 100_000,
    ...rest,
  });
}

/** Steigt an Bar `at` long ein (Stop/Ziel relativ zum Close), Exit per Signal ab `exitAt`. */
function enterAt(at: number, opts: { stop?: number; target?: number; exitAt?: number; side?: 'long' | 'short' } = {}): Strategy {
  return strategyOf({
    decide: (snap) => {
      const c = snap.bars.c[snap.i]!;
      if (!snap.position && snap.i === at) {
        const side = opts.side ?? 'long';
        const stop = opts.stop ?? (side === 'long' ? c - 5 : c + 5);
        const d: Decision = { kind: 'enter', side, stop, reason: 'test' };
        if (opts.target !== undefined) return { ...d, target: opts.target };
        return d;
      }
      if (snap.position && opts.exitAt !== undefined && snap.i >= opts.exitAt) return { kind: 'exit', reason: 'test' };
      return { kind: 'hold' };
    },
  });
}

const byTime = (a: Trade, b: Trade) => a.entryTime - b.entryTime;

describe('Kein Lookahead', () => {
  it('eine Strategie, die bars.c[i+1] liest, bekommt undefined und steigt nie ein; die Sicht endet bei i', () => {
    let calls = 0;
    let peekedFinite = 0;
    const strategy = strategyOf({
      decide: (snap) => {
        calls++;
        expect(snap.bars.length).toBe(snap.i + 1);
        const next = snap.bars.c[snap.i + 1];
        if (typeof next === 'number' && Number.isFinite(next)) {
          peekedFinite++;
          return { kind: 'enter', side: 'long', stop: next * 0.9, reason: 'lookahead' };
        }
        return { kind: 'hold' };
      },
    });
    const res = run({ bars: barsMap({ AAA: dayBars5(D1, flat(20, 100)) }), strategy });
    expect(calls).toBe(20);
    expect(peekedFinite).toBe(0);
    expect(res.trades).toHaveLength(0);
    expect(res.finalEquity).toBe(100_000);
  });

  it('Einstieg wird am Open der Folgebar gefüllt — nie zum Close der Entscheidungs-Bar', () => {
    const ohlc: Ohlc[] = [...flat(3, 100), [102, 103, 101, 102], ...flat(2, 102), [104, 105, 103, 104], ...flat(3, 104)];
    const res = run({ bars: barsMap({ AAA: dayBars5(D1, ohlc) }), strategy: enterAt(2, { exitAt: 5 }) });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    const bars = dayBars5(D1, ohlc);
    expect(t.entryTime).toBe(bars[3]!.t);
    expect(t.entryPrice).toBe(102);
    expect(t.exitTime).toBe(bars[6]!.t);
    expect(t.exitPrice).toBe(104);
    expect(t.exitReason).toBe('signal');
    // Sizing: 0,5 % von 100k = 500 USD Risiko / 5 USD Distanz ⇒ 100 Stück
    expect(t.qty).toBe(100);
    expect(t.grossPnl).toBeCloseTo(200, 9);
    const expectedFees =
      fillCosts({ side: 'buy', qty: 100, price: 102, assetClass: 'us_equity', costs: C, multiplier: 1 }).total +
      fillCosts({ side: 'sell', qty: 100, price: 104, assetClass: 'us_equity', costs: C, multiplier: 1 }).total;
    expect(t.fees).toBeCloseTo(expectedFees, 9);
    expect(t.netPnl).toBeCloseTo(200 - expectedFees, 9);
    expect(t.rMultiple).toBeCloseTo((200 - expectedFees) / (100 * (102 - 95)), 9);
    expect(t.barsHeld).toBe(3);
    expect(res.finalEquity).toBeCloseTo(100_000 + t.netPnl, 6);
  });
});

describe('Stop und Ziel', () => {
  const setup = (bar3: Ohlc, bar2: Ohlc = [100, 101, 99, 100]) => {
    const ohlc: Ohlc[] = [...flat(2, 100), bar2, bar3, ...flat(2, 100)];
    const bars = dayBars5(D1, ohlc);
    const res = run({ bars: barsMap({ AAA: bars }), strategy: enterAt(1, { stop: 95, target: 105 }) });
    return { res, bars };
  };

  it('Stop UND Ziel in einer Bar ⇒ Stop (pessimistisch), Marktorder mit Slippage', () => {
    const { res, bars } = setup([100, 106, 94, 100]);
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('stop');
    expect(t.exitPrice).toBe(95);
    expect(t.exitTime).toBe(bars[3]!.t);
    const fees =
      fillCosts({ side: 'buy', qty: 100, price: 100, assetClass: 'us_equity', costs: C, multiplier: 1 }).total +
      fillCosts({ side: 'sell', qty: 100, price: 95, assetClass: 'us_equity', costs: C, multiplier: 1 }).total;
    expect(t.fees).toBeCloseTo(fees, 9);
    expect(t.mae).toBe(94);
    expect(t.mfe).toBe(106);
  });

  it('Gap unter den Stop ⇒ Fill am Open', () => {
    const { res } = setup([90, 91, 89, 90]);
    expect(res.trades[0]!.exitReason).toBe('stop');
    expect(res.trades[0]!.exitPrice).toBe(90);
  });

  it('Ziel erreicht ⇒ Limit-Fill ohne Slippage, nur Gebühren', () => {
    const { res } = setup([100, 106, 99, 100]);
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('target');
    expect(t.exitPrice).toBe(105);
    const fees =
      fillCosts({ side: 'buy', qty: 100, price: 100, assetClass: 'us_equity', costs: C, multiplier: 1 }).total +
      regulatoryFees({ side: 'sell', qty: 100, price: 105, assetClass: 'us_equity', costs: C, multiplier: 1 });
    expect(t.fees).toBeCloseTo(fees, 9);
    expect(t.grossPnl).toBeCloseTo(500, 9);
  });

  it('Gap über das Ziel ⇒ Limit füllt am Open (besser als das Ziel)', () => {
    const { res } = setup([107, 108, 106, 107]);
    expect(res.trades[0]!.exitReason).toBe('target');
    expect(res.trades[0]!.exitPrice).toBe(107);
  });

  describe('Bracket-Beine sind ab dem Fill aktiv — Prüfung schon im Einstiegs-Bar', () => {
    it('Stop im Einstiegs-Bar gerissen ⇒ Trade mit barsHeld 0, Ein- und Ausstieg in derselben Bar', () => {
      const { res, bars } = setup([100, 101, 99, 100], [100, 101, 94, 100]);
      expect(res.trades).toHaveLength(1);
      const t = res.trades[0]!;
      expect(t.exitReason).toBe('stop');
      expect(t.exitPrice).toBe(95);
      expect(t.entryPrice).toBe(100);
      expect(t.entryTime).toBe(bars[2]!.t);
      expect(t.exitTime).toBe(bars[2]!.t);
      expect(t.barsHeld).toBe(0);
      expect(t.mae).toBe(94);
      expect(res.notes.some((n) => n.startsWith('Offen am Ende'))).toBe(false);
      expect(res.finalEquity).toBeCloseTo(100_000 + t.netPnl, 6);
    });

    it('Open des Einstiegs-Bars liegt schon unter dem Stop ⇒ Stop-Fill am Open (Brutto 0, nur Kosten)', () => {
      const { res } = setup([100, 101, 99, 100], [94, 95, 93, 94]);
      expect(res.trades).toHaveLength(1);
      const t = res.trades[0]!;
      expect(t.exitReason).toBe('stop');
      expect(t.entryPrice).toBe(94);
      expect(t.exitPrice).toBe(94);
      expect(t.grossPnl).toBe(0);
      expect(t.netPnl).toBeLessThan(0);
      expect(t.barsHeld).toBe(0);
    });

    it('Ziel im Einstiegs-Bar erreicht ⇒ Limit-Fill am Ziel, barsHeld 0', () => {
      const { res } = setup([100, 101, 99, 100], [100, 106, 99, 100]);
      expect(res.trades).toHaveLength(1);
      expect(res.trades[0]!.exitReason).toBe('target');
      expect(res.trades[0]!.exitPrice).toBe(105);
      expect(res.trades[0]!.barsHeld).toBe(0);
    });

    it('beides im Einstiegs-Bar ⇒ Stop (pessimistisch)', () => {
      const { res } = setup([100, 101, 99, 100], [100, 106, 94, 100]);
      expect(res.trades[0]!.exitReason).toBe('stop');
      expect(res.trades[0]!.barsHeld).toBe(0);
    });

    it('Short gespiegelt: Hoch über dem Stop im Einstiegs-Bar', () => {
      const cfgShort = baseConfig({ risk: { allowShort: true } });
      const ohlc: Ohlc[] = [...flat(2, 100), [100, 106, 99, 100], ...flat(3, 100)];
      const res = simulate({
        bars: barsMap({ AAA: dayBars5(D1, ohlc) }),
        strategyFor: () => ({ strategy: enterAt(1, { side: 'short', stop: 105, target: 95 }), params: {} }),
        config: cfgShort,
        initialEquity: 100_000,
      });
      expect(res.trades).toHaveLength(1);
      expect(res.trades[0]!.exitReason).toBe('stop');
      expect(res.trades[0]!.exitPrice).toBe(105);
      expect(res.trades[0]!.barsHeld).toBe(0);
    });
  });

  it('Short gespiegelt: Stop oben, Ziel unten; beides ⇒ Stop', () => {
    const cfgShort = baseConfig({ risk: { allowShort: true } });
    const ohlc: Ohlc[] = [...flat(3, 100), [100, 106, 94, 100], ...flat(2, 100)];
    const res = simulate({
      bars: barsMap({ AAA: dayBars5(D1, ohlc) }),
      strategyFor: () => ({ strategy: enterAt(1, { side: 'short', stop: 105, target: 95 }), params: {} }),
      config: cfgShort,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.side).toBe('short');
    expect(res.trades[0]!.exitReason).toBe('stop');
    expect(res.trades[0]!.exitPrice).toBe(105);
    expect(res.trades[0]!.grossPnl).toBeCloseTo(-500, 9);
  });
});

describe('EOD-Flatten', () => {
  const alwaysLong = (holdsOvernight: boolean) =>
    strategyOf({
      holdsOvernight,
      decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.9, reason: 'always' }),
    });
  const bars = [...fullDay5(D1, 100), ...fullDay5(D2, 100)];

  it('holdsOvernight=false: Exit „eod" vor Schluss, keine Übernacht-Position, am nächsten Tag neu', () => {
    const res = run({ bars: barsMap({ AAA: bars }), strategy: alwaysLong(false) });
    expect(res.trades).toHaveLength(2);
    for (const t of res.trades) {
      expect(t.exitReason).toBe('eod');
      expect(dayKeyFor(t.entryTime, 'us_equity')).toBe(dayKeyFor(t.exitTime, 'us_equity'));
    }
    // flattenBeforeCloseMin=5: Entscheidung an der 15:50-Bar (Ende 15:55), Fill am Open der 15:55-Bar.
    const { y, m, d } = { y: 2026, m: 9, d: 1 };
    expect(res.trades[0]!.exitTime).toBe(msFromET(y, m, d, 15, 55));
    expect(res.trades[0]!.entryTime).toBe(msFromET(y, m, d, 9, 35));
    expect(res.notes.some((n) => n.startsWith('Offen am Ende'))).toBe(false);
  });

  it('holdsOvernight=true: Position bleibt über Nacht, Haltedauer läuft weiter', () => {
    const res = run({ bars: barsMap({ AAA: bars }), strategy: alwaysLong(true) });
    expect(res.trades).toHaveLength(0);
    expect(res.notes.some((n) => n.startsWith('Offen am Ende: AAA long'))).toBe(true);
    // Exposure: ab Bar 1 (Fill) bis zum Ende ⇒ 155 von 156 Zeitpunkten
    expect(res.metrics.exposurePct).toBeCloseTo((155 / 156) * 100, 9);
  });

  it('Exit an der letzten Tagesbar füllt am Open des nächsten Handelstags (Übernacht-Gap) — nie am Close', () => {
    // flattenBeforeCloseMin=0 ⇒ EOD-Entscheidung erst an der 15:55-Bar; live geht die Order nach 16:00 raus.
    const cfg0 = baseConfig({ session: { flattenBeforeCloseMin: 0, noEntryLastMin: 30 } });
    const res = simulate({
      bars: barsMap({ AAA: [...fullDay5(D1, 100, { 77: [100, 101, 99, 101] }), ...fullDay5(D2, 95)] }),
      strategyFor: () => ({ strategy: alwaysLong(false), params: {} }),
      config: cfg0,
      initialEquity: 100_000,
    });
    expect(res.trades.length).toBeGreaterThanOrEqual(1);
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('eod');
    expect(t.exitPrice).toBe(95);
    expect(t.exitTime).toBe(msFromET(2026, 9, 2, 9, 30));
    expect(dayKeyFor(t.entryTime, 'us_equity')).toBe(D1);
    const sumNet = res.trades.reduce((a, x) => a + x.netPnl, 0);
    const open = res.notes.some((n) => n.startsWith('Offen am Ende'));
    if (!open) expect(res.finalEquity).toBeCloseTo(100_000 + sumNet, 6);
  });

  it('Signal-Exit an der letzten Tagesbar ohne Folgetag: kein Fill, Position bleibt offen (Notiz)', () => {
    const cfg0 = baseConfig({ session: { flattenBeforeCloseMin: 0 } });
    const res = simulate({
      bars: barsMap({ AAA: fullDay5(D1, 100) }),
      strategyFor: () => ({ strategy: alwaysLong(false), params: {} }),
      config: cfg0,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(0);
    expect(res.notes.some((n) => n.includes('Exit AAA (eod) ohne Folgebar'))).toBe(true);
    expect(res.notes.some((n) => n.includes('ohne Exit-Kosten'))).toBe(true);
  });

  it('Tagesbars: Signal-Exit füllt am Open des Folgetags, nicht am Close der Entscheidungs-Bar', () => {
    const days = [D1, D2, D3, '2026-09-04'];
    const bars = days.map((day, k) => {
      const { y, m, d } = { y: 2026, m: 9, d: Number(day.slice(-2)) };
      const [o, c] = k === 2 ? [100, 110] : [100, 100];
      return { t: msFromET(y, m, d, 9, 30), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1_000 };
    });
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: enterAt(0, { stop: 50, exitAt: 2 }), params: {} }),
      config: baseConfig({ timeframe: 1440 }),
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.exitTime).toBe(msFromET(2026, 9, 4, 9, 30));
    expect(res.trades[0]!.exitPrice).toBe(100);
  });
});

describe('Tages-Notbremse (kill_switch)', () => {
  it('Absturz ⇒ Exit kill_switch, keine Einstiege bis zum nächsten Handelstag, danach wieder', () => {
    const cfgRisk = baseConfig({ risk: { riskPerTradePct: 5, maxPositionPct: 100, maxDailyLossPct: 2 } });
    const strategy = strategyOf({
      decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: 90, reason: 'always' }),
    });
    const day1: Ohlc[] = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 95, 95], ...flat(10, 95)];
    const bars = [...dayBars5(D1, day1), ...dayBars5(D2, flat(4, 95))];
    const res = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy, params: {} }), config: cfgRisk, initialEquity: 100_000 });
    expect(res.trades.length).toBeGreaterThanOrEqual(1);
    const t0 = res.trades[0]!;
    expect(t0.qty).toBe(500); // 5 % × 100k / 10 USD Distanz
    expect(t0.exitReason).toBe('kill_switch');
    expect(t0.exitTime).toBe(msFromET(2026, 9, 1, 9, 45)); // Entscheidung an Bar 2, Fill am Open von Bar 3
    expect(t0.exitPrice).toBe(95);
    // Tag 1: kein weiterer Einstieg; Tag 2: wieder erlaubt
    const day1Entries = res.trades.filter((t) => dayKeyFor(t.entryTime, 'us_equity') === D1);
    expect(day1Entries).toHaveLength(1);
    const openNote = res.notes.find((n) => n.startsWith('Offen am Ende: AAA'));
    const day2Entries = res.trades.filter((t) => dayKeyFor(t.entryTime, 'us_equity') === D2);
    expect(day2Entries.length + (openNote ? 1 : 0)).toBe(1);
    expect(res.notes.some((n) => n.includes('Halt: Tagesverlust'))).toBe(true);
    expect(res.notes.some((n) => n.includes('Halt aktiv'))).toBe(true);
  });
});

describe('Buchhaltung', () => {
  const intraday = strategyOf({
    holdsOvernight: false,
    decide: (snap) => {
      const c = snap.bars.c[snap.i]!;
      if (snap.position) return snap.position.barsHeld >= 4 ? { kind: 'exit', reason: 'time' } : { kind: 'hold' };
      if (snap.i % 7 === 3) return { kind: 'enter', side: 'long', stop: c * 0.99, target: c * 1.015, reason: 'l' };
      if (snap.i % 7 === 5) return { kind: 'enter', side: 'short', stop: c * 1.01, target: c * 0.985, reason: 's' };
      return { kind: 'hold' };
    },
  });
  const start = msFromET(2026, 9, 1, 9, 30);

  it('flach am Ende: equity = initialEquity + Σ netPnl (auch mit Shorts)', () => {
    const cfgShort = baseConfig({ risk: { allowShort: true, maxPositions: 3 } });
    const res = simulate({
      bars: barsMap({
        AAA: randomWalkBars({ seed: 1, n: 234, start, tf: 5, assetClass: 'us_equity', volPerBar: 0.004 }),
        BBB: randomWalkBars({ seed: 2, n: 234, start, tf: 5, assetClass: 'us_equity', startPrice: 50, volPerBar: 0.004 }),
      }),
      strategyFor: () => ({ strategy: intraday, params: {} }),
      config: cfgShort,
      initialEquity: 100_000,
    });
    expect(res.trades.length).toBeGreaterThan(10);
    expect(res.trades.some((t) => t.side === 'short')).toBe(true);
    // Auch Stops im Einstiegs-Bar (barsHeld 0) kommen vor und halten die Invariante.
    expect(res.trades.some((t) => t.barsHeld === 0 && t.exitReason === 'stop')).toBe(true);
    expect(res.notes.some((n) => n.startsWith('Offen am Ende'))).toBe(false);
    const sumNet = res.trades.reduce((s, t) => s + t.netPnl, 0);
    expect(res.finalEquity).toBeCloseTo(100_000 + sumNet, 6);
    expect(res.equity[res.equity.length - 1]!.equity).toBe(res.finalEquity);
    for (const t of res.trades) {
      expect(t.fees).toBeGreaterThan(0);
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees, 9);
    }
    expect(res.dailyReturns).toHaveLength(3);
    const compounded = res.dailyReturns.reduce((e, r) => e * (1 + r), 100_000);
    expect(compounded).toBeCloseTo(res.finalEquity, 6);
    expect(res.metrics.trades).toBe(res.trades.length);
    expect(res.metrics.days).toBe(3);
  });

  it('Gap-Open über dem Entscheidungs-Close: Stückzahl wird gegen das Bargeld am Fill nachgesizet', () => {
    const ohlc = flat(78, 100);
    ohlc[1] = [120, 121, 119, 120];
    const strategy = strategyOf({
      decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.95, reason: 'always' }),
    });
    const res = simulate({
      bars: barsMap({ AAA: dayBars5(D1, ohlc) }),
      strategyFor: () => ({ strategy, params: {} }),
      config: baseConfig({ risk: { riskPerTradePct: 5, maxPositionPct: 100, maxGrossExposurePct: 100 } }),
      initialEquity: 10_000,
    });
    const t = res.trades[0]!;
    expect(t.entryPrice).toBe(120);
    // 10 000 / (120 + 120·5 bps) = 83,29 ⇒ 83 Stück; das Bargeld bleibt ≥ 0.
    expect(t.qty).toBe(83);
    expect(83 * 120 + fillCosts({ side: 'buy', qty: 83, price: 120, assetClass: 'us_equity', costs: C, multiplier: 1 }).total).toBeLessThanOrEqual(10_000);
    expect(res.notes.some((n) => n.startsWith('Stückzahl am Fill reduziert (Bargeld): AAA ×1'))).toBe(true);
    const sumNet = res.trades.reduce((a, x) => a + x.netPnl, 0);
    expect(res.finalEquity).toBeCloseTo(10_000 + sumNet, 6);
  });

  it('reicht das Bargeld am Fill für kein einziges Stück ⇒ kein Fill, Notiz', () => {
    const ohlc = flat(6, 100);
    ohlc[2] = [30_000, 30_000, 30_000, 30_000];
    const res = run({ bars: barsMap({ AAA: dayBars5(D1, ohlc) }), strategy: enterAt(1, { stop: 95 }), initialEquity: 10_000 });
    expect(res.trades).toHaveLength(0);
    expect(res.notes.some((n) => n.startsWith('Bargeld reicht am Fill nicht: AAA ×1'))).toBe(true);
    expect(res.finalEquity).toBe(10_000);
  });

  it('costMultiplier 2 verdoppelt die Kosten identischer Trades', () => {
    const bars = barsMap({ AAA: randomWalkBars({ seed: 3, n: 78, start, tf: 5, assetClass: 'us_equity', volPerBar: 0.001 }) });
    const one = simulate({ bars, strategyFor: () => ({ strategy: intraday, params: {} }), config: cfg, initialEquity: 100_000 });
    const two = simulate({ bars, strategyFor: () => ({ strategy: intraday, params: {} }), config: cfg, initialEquity: 100_000, costMultiplier: 2 });
    expect(one.trades.length).toBeGreaterThan(0);
    expect(two.trades).toHaveLength(one.trades.length);
    // Gleiche Bars und Kurse; die Stückzahl darf abweichen (Sizing folgt der Equity), die Kosten JE STÜCK verdoppeln sich.
    for (let i = 0; i < one.trades.length; i++) {
      const a = one.trades[i]!;
      const b = two.trades[i]!;
      expect(b.entryPrice).toBe(a.entryPrice);
      expect(b.exitPrice).toBe(a.exitPrice);
      expect(b.fees / b.qty).toBeCloseTo((2 * a.fees) / a.qty, 9);
    }
  });
});

describe('Short-Leihe', () => {
  it('über das Wochenende: 3 Kalendertage Leihe auf den Marktwert, Buchhaltung bleibt konsistent', () => {
    const cfgShort = baseConfig({ risk: { allowShort: true } });
    const fri = '2026-09-04';
    const mon = '2026-09-07'; // Labor Day ⇒ Feiertag, also Dienstag 08.09.
    const tue = '2026-09-08';
    expect(dayKeyFor(msFromET(2026, 9, 7, 12, 0), 'us_equity')).toBe(mon);
    const strategy = strategyOf({
      decide: (snap) =>
        !snap.position && snap.i === 1
          ? { kind: 'enter', side: 'short', stop: 110, reason: 's' }
          : snap.position && snap.i >= 20
            ? { kind: 'exit', reason: 'done' }
            : { kind: 'hold' },
    });
    const bars = [...dayBars5(fri, flat(10, 100)), ...dayBars5(tue, flat(15, 100))];
    const res = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy, params: {} }), config: cfgShort, initialEquity: 100_000 });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    expect(t.side).toBe('short');
    expect(t.qty).toBe(50); // 500 USD / 10 USD Distanz
    const fills =
      fillCosts({ side: 'sell', qty: 50, price: 100, assetClass: 'us_equity', costs: C, multiplier: 1 }).total +
      fillCosts({ side: 'buy', qty: 50, price: 100, assetClass: 'us_equity', costs: C, multiplier: 1 }).total;
    const borrow = ((5_000 * 0.01) / 365) * 4; // Freitag → Dienstag = 4 Kalendertage
    expect(t.fees).toBeCloseTo(fills + borrow, 9);
    expect(res.finalEquity).toBeCloseTo(100_000 + t.netPnl, 6);
  });
});

describe('PDT', () => {
  const scalper = strategyOf({
    holdsOvernight: false,
    decide: (snap) => {
      if (snap.position) return snap.position.barsHeld >= 1 ? { kind: 'exit', reason: 'quick' } : { kind: 'hold' };
      return snap.i % 4 === 0 ? { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! - 1, reason: 'go' } : { kind: 'hold' };
    },
  });
  const bars = barsMap({ AAA: dayBars5(D1, flat(40, 100)) });

  it('Konto < 25k: nach drei Daytrades ist der vierte Intraday-Einstieg blockiert (Notiz)', () => {
    const res = run({ bars, strategy: scalper, initialEquity: 10_000 });
    expect(res.trades).toHaveLength(3);
    expect(res.notes.some((n) => n.includes('PDT'))).toBe(true);
  });

  it('Konto ≥ 25k: keine Sperre', () => {
    const res = run({ bars, strategy: scalper, initialEquity: 30_000 });
    expect(res.trades.length).toBeGreaterThanOrEqual(4);
    expect(res.notes.some((n) => n.includes('PDT'))).toBe(false);
  });

  it('das 5-Tage-Fenster rollt: nach fünf Handelstagen ist wieder Platz', () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10'];
    const all = days.flatMap((d) => dayBars5(d, flat(12, 100)));
    const res = run({ bars: barsMap({ AAA: all }), strategy: scalper, initialEquity: 10_000 });
    const perDay = new Map<string, number>();
    for (const t of res.trades) {
      const d = dayKeyFor(t.entryTime, 'us_equity');
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    // Tag 1: drei Daytrades (Bars 0/4/8), Tage 2–5 gesperrt, am sechsten Handelstag (09.09.) fällt Tag 1 aus dem Fenster.
    expect(perDay.get('2026-09-01')).toBe(3);
    expect(perDay.get('2026-09-02') ?? 0).toBe(0);
    expect(perDay.get('2026-09-08') ?? 0).toBe(0);
    expect(perDay.get('2026-09-09')).toBe(3);
  });
});

describe('Portfolio', () => {
  it('zwei Symbole, maxPositions=1 ⇒ zweiter Einstieg am selben Zeitpunkt blockiert; nie zwei offen', () => {
    const cfg1 = baseConfig({ risk: { maxPositions: 1 } });
    // AAA will genau einmal (an Bar 1) einsteigen, BBB immer — beide wollen an Bar 1, nur eines darf.
    const once = enterAt(1, { exitAt: 3 });
    const greedy = strategyOf({
      decide: (snap) => {
        if (snap.position) return snap.position.barsHeld >= 2 ? { kind: 'exit', reason: 'x' } : { kind: 'hold' };
        return snap.i >= 1 ? { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! - 5, reason: 'e' } : { kind: 'hold' };
      },
    });
    const res = simulate({
      bars: barsMap({ AAA: dayBars5(D1, flat(30, 100)), BBB: dayBars5(D1, flat(30, 50)) }),
      strategyFor: (sym) => ({ strategy: sym === 'AAA' ? once : greedy, params: {} }),
      config: cfg1,
      initialEquity: 100_000,
    });
    expect(res.trades.length).toBeGreaterThanOrEqual(4);
    expect(res.trades[0]!.symbol).toBe('AAA');
    expect(res.trades.filter((t) => t.symbol === 'AAA')).toHaveLength(1);
    // BBB kommt erst an dem Zeitpunkt zum Zug, an dem AAAs Exit gefüllt ist (Bar 4 ⇒ Fill Bar 5).
    expect(res.trades[1]!.symbol).toBe('BBB');
    expect(res.trades[1]!.entryTime).toBe(msFromET(2026, 9, 1, 9, 55));
    expect(res.trades.some((t) => t.symbol === 'BBB')).toBe(true);
    const sorted = [...res.trades].sort(byTime);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.entryTime).toBeGreaterThanOrEqual(sorted[i - 1]!.exitTime);
    expect(res.notes.some((n) => n.includes('Positionslimit'))).toBe(true);
  });

  it('Symbole mit strategyFor=null werden nicht gehandelt und liefern keine Zeitpunkte', () => {
    const res = simulate({
      bars: barsMap({ AAA: dayBars5(D1, flat(10, 100)), ZZZ: dayBars5(D2, flat(10, 100)) }),
      strategyFor: (sym) => (sym === 'AAA' ? { strategy: enterAt(1, { exitAt: 4 }), params: {} } : null),
      config: cfg,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.equity).toHaveLength(10);
  });

  it('gemeinsame Equity: Exposure-Budget wird über Symbole hinweg verbraucht', () => {
    const cfgX = baseConfig({ risk: { maxGrossExposurePct: 25, maxPositionPct: 20, riskPerTradePct: 5 } });
    const strategy = strategyOf({
      decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.9, reason: 'big' }),
    });
    const res = simulate({
      bars: barsMap({ AAA: dayBars5(D1, flat(6, 100)), BBB: dayBars5(D1, flat(6, 100)) }),
      strategyFor: () => ({ strategy, params: {} }),
      config: cfgX,
      initialEquity: 100_000,
    });
    // AAA bekommt 20 % (200 Stück), BBB nur die restlichen 5 % (50 Stück).
    const open = res.notes.filter((n) => n.startsWith('Offen am Ende'));
    expect(open.some((n) => n.includes('AAA long 200'))).toBe(true);
    expect(open.some((n) => n.includes('BBB long 50'))).toBe(true);
  });
});

describe('Zeitfenster (range) und Warmup', () => {
  it('Warmup-Bars liefern Indikatoren, aber keine Entscheidungen; Bars ≥ end werden ignoriert', () => {
    const strategy = strategyOf({
      warmup: 10,
      precompute: (bars) => {
        const sma = new Float64Array(bars.length);
        for (let i = 0; i < bars.length; i++) sma[i] = i >= 9 ? bars.c.subarray(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10 : Number.NaN;
        return { sma };
      },
      decide: (snap, ind) => {
        expect(Number.isFinite(ind.sma![snap.i]!)).toBe(true);
        if (snap.position) return snap.position.barsHeld >= 3 ? { kind: 'exit', reason: 'x' } : { kind: 'hold' };
        return { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! - 5, reason: 'e' };
      },
    });
    const bars = [...fullDay5(D1, 100), ...fullDay5(D2, 100), ...fullDay5(D3, 100)];
    const start = msFromET(2026, 9, 2, 0, 0);
    const end = msFromET(2026, 9, 3, 0, 0);
    const res = run({ bars: barsMap({ AAA: bars }), strategy, range: { start, end } });
    expect(res.trades.length).toBeGreaterThan(5);
    for (const t of res.trades) {
      expect(dayKeyFor(t.entryTime, 'us_equity')).toBe(D2);
      expect(dayKeyFor(t.exitTime, 'us_equity')).toBe(D2);
    }
    expect(res.equity[0]!.t).toBeGreaterThanOrEqual(start);
    expect(res.equity).toHaveLength(78);
    expect(res.metrics.days).toBe(1);
    expect(res.dailyReturns).toHaveLength(1);
    // Die erste Entscheidung im Fenster kann sofort handeln (Warmup aus Tag 1) ⇒ Fill an Bar 2 des Tages.
    expect(res.trades[0]!.entryTime).toBe(msFromET(2026, 9, 2, 9, 35));
  });

  it('offene Position am Fensterende bleibt unrealisiert in finalEquity (Notiz)', () => {
    const bars = [...fullDay5(D1, 100), ...fullDay5(D2, 110)];
    const res = run({
      bars: barsMap({ AAA: bars }),
      strategy: enterAt(2, { stop: 90 }),
      range: { start: msFromET(2026, 9, 1, 0, 0), end: msFromET(2026, 9, 2, 0, 0) },
    });
    expect(res.trades).toHaveLength(0);
    expect(res.notes.some((n) => n.startsWith('Offen am Ende: AAA long 50'))).toBe(true);
    const entryCost = fillCosts({ side: 'buy', qty: 50, price: 100, assetClass: 'us_equity', costs: C, multiplier: 1 }).total;
    expect(res.finalEquity).toBeCloseTo(100_000 - entryCost, 9);
  });
});

describe('move_stop', () => {
  it('nachgezogener Stop wirkt ab der nächsten Bar', () => {
    const strategy = strategyOf({
      decide: (snap) => {
        if (!snap.position && snap.i === 1) return { kind: 'enter', side: 'long', stop: 90, reason: 'e' };
        if (snap.position && snap.i === 3) return { kind: 'move_stop', stop: 99, reason: 'trail' };
        return { kind: 'hold' };
      },
    });
    const ohlc: Ohlc[] = [...flat(3, 100), [100, 101, 98.5, 100], [100, 101, 98.5, 100], ...flat(2, 100)];
    const bars = dayBars5(D1, ohlc);
    const res = run({ bars: barsMap({ AAA: bars }), strategy });
    // Bar 3 (l=98,5) läuft noch mit Stop 90; Bar 4 mit Stop 99 ⇒ Stop-Fill an Bar 4.
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.exitReason).toBe('stop');
    expect(res.trades[0]!.exitPrice).toBe(99);
    expect(res.trades[0]!.exitTime).toBe(bars[4]!.t);
  });
});

describe('Benchmark und Krypto', () => {
  it('Benchmark-Sicht endet bei der letzten Benchmark-Bar mit t ≤ jetzt', () => {
    const benchBars = dayBars5(D1, flat(20, 400), 5); // um 5 min versetzt
    const bench = BarSeries.from(benchBars);
    let checks = 0;
    const strategy = strategyOf({
      decide: (snap) => {
        const b = snap.benchmark;
        const t = snap.bars.t[snap.i]!;
        if (snap.i === 0) expect(b).toBeUndefined();
        else {
          expect(b).toBeDefined();
          expect(b!.bars.length).toBe(b!.i + 1);
          expect(b!.bars.t[b!.i]!).toBeLessThanOrEqual(t);
          if (b!.i + 1 < bench.length) expect(bench.t[b!.i + 1]!).toBeGreaterThan(t);
          checks++;
        }
        return { kind: 'hold' };
      },
    });
    run({ bars: barsMap({ AAA: dayBars5(D1, flat(20, 100)) }), strategy, benchmark: bench });
    expect(checks).toBe(19);
  });

  it('Krypto: keine Sitzungstore, Taker-Gebühren, 365 Perioden/Jahr', () => {
    const cfgC = baseConfig({ assetClass: 'crypto', timeframe: 60 });
    const bars = randomWalkBars({ seed: 4, n: 72, start: Date.UTC(2026, 0, 3, 0, 0), tf: 60, assetClass: 'crypto', startPrice: 50_000, volPerBar: 0.002 });
    const strategy = strategyOf({
      decide: (snap) => {
        if (snap.position) return snap.position.barsHeld >= 5 ? { kind: 'exit', reason: 'x' } : { kind: 'hold' };
        return snap.i % 10 === 0 ? { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.98, reason: 'e' } : { kind: 'hold' };
      },
    });
    const res = simulate({ bars: barsMap({ 'BTC/USD': bars }), strategyFor: () => ({ strategy, params: {} }), config: cfgC, initialEquity: 100_000 });
    expect(res.trades.length).toBeGreaterThanOrEqual(6);
    // Einstieg am Samstag um 01:00 UTC — für Krypto erlaubt.
    expect(res.trades[0]!.entryTime).toBe(Date.UTC(2026, 0, 3, 1, 0));
    for (const t of res.trades) {
      expect(Math.abs(t.qty * 10_000 - Math.round(t.qty * 10_000))).toBeLessThan(1e-6); // Stückelung 0,0001
      const taker = (t.qty * t.entryPrice * 0.0025) + (t.qty * t.exitPrice * 0.0025);
      expect(t.fees).toBeGreaterThan(taker);
    }
    expect(res.dailyReturns.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Datenende', () => {
  it('Intent ohne Folgebar: Einstieg verworfen, Exit bleibt offen — jeweils mit Notiz', () => {
    const resEnter = run({ bars: barsMap({ AAA: dayBars5(D1, flat(6, 100)) }), strategy: enterAt(5) });
    expect(resEnter.trades).toHaveLength(0);
    expect(resEnter.notes.some((n) => n.includes('Einstieg AAA ohne Folgebar'))).toBe(true);
    const resExit = run({ bars: barsMap({ AAA: dayBars5(D1, flat(6, 100)) }), strategy: enterAt(1, { exitAt: 5 }) });
    expect(resExit.trades).toHaveLength(0);
    expect(resExit.notes.some((n) => n.includes('Exit AAA (signal) ohne Folgebar'))).toBe(true);
    expect(resExit.notes.some((n) => n.startsWith('Offen am Ende'))).toBe(true);
  });

  it('leere Eingabe ⇒ leeres, wohldefiniertes Ergebnis', () => {
    const res = run({ bars: new Map(), strategy: enterAt(0) });
    expect(res.trades).toEqual([]);
    expect(res.equity).toEqual([]);
    expect(res.finalEquity).toBe(100_000);
    expect(res.metrics.days).toBe(0);
    expect(res.metrics.exposurePct).toBe(0);
  });
});
