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

  // Echte ISO-Daten für die Forecast-Tests: die Prognose projiziert Werktage
  // ab dem Bar-Datum — synthetische Strings („D000") ergäben leere Horizonte.
  const isoDate = (i: number): string =>
    new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

  it('Forecast-Regeln greifen im Backtest (kausaler forecastPct je Bar)', () => {
    // Stetiger Anstieg ⇒ die Drift-Prognose ist positiv ⇒ die forecast-Regel
    // löst Käufe aus. Vor Teil 4 war forecastPct null und die Regel tot.
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 60; i++) bars.push({ date: isoDate(i), close: 100 + i });
    const spec: StrategySpec = {
      buy: { type: 'forecast', direction: 'up', minAbsPct: 0.1 },
      sell: { type: 'forecast', direction: 'down', minAbsPct: 99 }, // nie
    };
    const r = backtestSpec(spec, bars, { commissionPct: 0, slippageBps: 0 });
    expect(r.numTrades).toBeGreaterThan(0);
  });

  it('KAUSALITÄT: forecastPct an Bar i ändert sich nicht, wenn die Zukunft variiert', () => {
    // Adversarial: gleiche Vergangenheit, radikal andere Zukunft — die
    // Trades bis zum Verzweigungstag MÜSSEN identisch sein. Jede Abweichung
    // wäre ein Zukunfts-Leck in der Forecast-Serie.
    const past: BacktestBar[] = [];
    for (let i = 0; i < 45; i++) past.push({ date: isoDate(i), close: 100 + i * 0.5 });
    const futureUp = [...past, { date: isoDate(45), close: 200 }, { date: isoDate(46), close: 250 }];
    const futureDown = [...past, { date: isoDate(45), close: 50 }, { date: isoDate(46), close: 25 }];
    const spec: StrategySpec = {
      buy: { type: 'forecast', direction: 'up', minAbsPct: 0.1 },
      sell: { type: 'forecast', direction: 'down', minAbsPct: 0.1 },
    };
    const up = backtestSpec(spec, futureUp, { commissionPct: 0, slippageBps: 0 });
    const down = backtestSpec(spec, futureDown, { commissionPct: 0, slippageBps: 0 });
    const cutoff = isoDate(45);
    const before = (t: { entryDate: string }): boolean => t.entryDate < cutoff;
    expect(up.trades.filter(before).map((t) => t.entryDate))
      .toEqual(down.trades.filter(before).map((t) => t.entryDate));
  });
});
