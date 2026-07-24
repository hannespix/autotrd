/**
 * Tests der Backtest-Engine (M11): Metriken auf handrechenbarer Serie,
 * Determinismus — und die ADVERSARIALE Lookahead-Fixture: ein Sprung, den
 * man nur mit Blick in die Zukunft vor dem Sprung-Tag handeln könnte.
 */
import { describe, expect, it } from 'vitest';
import type { StrategySpec } from '../../shared/src/index.js';
import { backtestSpec, type BacktestBar } from '../src/core/backtest.js';

function flatThenJump(): BacktestBar[] {
  // 40 Bars exakt flach bei 100, dann EIN Sprung auf 130, danach flach.
  const bars: BacktestBar[] = [];
  for (let i = 0; i < 40; i++) bars.push({ date: `D${String(i).padStart(3, '0')}`, close: 100 });
  for (let i = 40; i < 50; i++) bars.push({ date: `D${String(i).padStart(3, '0')}`, close: 130 });
  return bars;
}

describe('backtestSpec', () => {
  it('Lookahead-Fixture: der Sprung ist erst AM Sprung-Tag sichtbar, nie davor', () => {
    // „Kaufe, wenn der letzte Bar ≥ 20 % gestiegen ist" — kausal kann das
    // frühestens der Sprung-Tag D040 selbst sein. Jedes Zukunfts-Leck würde
    // schon D039 kaufen und den Gewinn des Sprungs einstreichen.
    const spec: StrategySpec = {
      buy: { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
      sell: { type: 'changePct', lookbackBars: 1, op: 'lte', pct: -99 }, // nie
    };
    const r = backtestSpec(spec, flatThenJump(), { commissionPct: 0, slippageBps: 0 });
    expect(r.numTrades).toBe(1);
    expect(r.trades[0]!.entryDate).toBe('D040'); // NICHT D039
    // Entry zum Close 130 ⇒ der 30-%-Sprung ist NICHT im PnL (kein Leck)
    expect(r.trades[0]!.pnl).toBe(0);
    expect(r.totalReturnPct).toBe(0);
  });

  it('Metriken auf handrechenbarer Serie (ohne Kosten)', () => {
    // Kauf bei 100 (RSI-frei via priceLevel), Verkauf über 120 ⇒ +20 % Trade.
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 30; i++) bars.push({ date: `A${i}`, close: 100 });
    for (let i = 0; i < 10; i++) bars.push({ date: `B${i}`, close: 100 + (i + 1) * 3 });
    const spec: StrategySpec = {
      buy: { type: 'priceLevel', level: 101, side: 'below' },
      sell: { type: 'priceLevel', level: 120, side: 'above' },
    };
    const r = backtestSpec(spec, bars, { initialCapital: 10_000, commissionPct: 0, slippageBps: 0 });
    expect(r.numTrades).toBe(1);
    expect(r.trades[0]!.pnl).toBeGreaterThan(1900); // 100 Stück × ~+21
    expect(r.winRatePct).toBe(100);
    expect(r.maxDrawdownPct).toBe(0); // nie unter Wasser
    expect(r.finalEquity).toBeCloseTo(10_000 + r.trades[0]!.pnl, 1);
    expect(r.buyHoldPct).toBeCloseTo(30, 5);
    expect(r.equityCurve.length).toBeLessThanOrEqual(200);
  });

  it('Kosten drücken den PnL (Kommission + Slippage je Seite)', () => {
    const bars = flatThenJump();
    const spec: StrategySpec = {
      buy: { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
      sell: { type: 'changePct', lookbackBars: 1, op: 'lte', pct: -99 },
    };
    const free = backtestSpec(spec, bars, { commissionPct: 0, slippageBps: 0 });
    const paid = backtestSpec(spec, bars, { commissionPct: 0.001, slippageBps: 5 });
    expect(paid.finalEquity).toBeLessThan(free.finalEquity);
  });

  it('ist deterministisch', () => {
    const bars = flatThenJump();
    const spec: StrategySpec = {
      buy: { type: 'changePct', lookbackBars: 1, op: 'gte', pct: 20 },
      sell: { type: 'position', state: 'open', minUnrealizedPct: 50 },
    };
    expect(backtestSpec(spec, bars)).toEqual(backtestSpec(spec, bars));
  });
});
