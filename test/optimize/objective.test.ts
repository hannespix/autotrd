import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../src/core/types.ts';
import { OBJECTIVE_CAP, PERFECT_WINDOW_BASE, median, objectiveValue } from '../../src/optimize/objective.ts';

function m(over: Partial<Metrics>): Metrics {
  return {
    netProfit: 100,
    netReturnPct: 1,
    cagrPct: null,
    sharpe: 1,
    sortino: 1,
    maxDrawdownPct: 2,
    profitFactor: null,
    winRatePct: null,
    expectancy: null,
    avgR: null,
    trades: 10,
    exposurePct: 50,
    feeShare: null,
    days: 30,
    ...over,
  };
}

describe('objectiveValue', () => {
  it('0 Trades ⇒ −∞, unabhängig vom Ziel', () => {
    for (const id of ['sortino', 'sharpe', 'return_over_dd'] as const) expect(objectiveValue(id, m({ trades: 0, sortino: 5, sharpe: 5 }))).toBe(-Infinity);
  });

  it('sortino/sharpe/return_over_dd lesen ihre Kennzahl; null/NaN ⇒ −∞', () => {
    expect(objectiveValue('sortino', m({ sortino: 2.5 }))).toBe(2.5);
    expect(objectiveValue('sharpe', m({ sharpe: 1.25 }))).toBe(1.25);
    expect(objectiveValue('sharpe', m({ sharpe: null }))).toBe(-Infinity);
    expect(objectiveValue('sharpe', m({ sharpe: NaN }))).toBe(-Infinity);
    expect(objectiveValue('return_over_dd', m({ netReturnPct: 10, maxDrawdownPct: 4 }))).toBe(2.5);
    // Drawdown unter 1 % auf 1 % gedeckelt
    expect(objectiveValue('return_over_dd', m({ netReturnPct: 10, maxDrawdownPct: 0.01 }))).toBe(10);
  });

  it('Sortino null ohne Verlusttag ⇒ perfektes Fenster rangiert ÜBER jedem endlichen Sortino, geordnet nach Sharpe', () => {
    const perfect = objectiveValue('sortino', m({ sortino: null, sharpe: 100 }));
    const perfectBetter = objectiveValue('sortino', m({ sortino: null, sharpe: 120 }));
    const good = objectiveValue('sortino', m({ sortino: 263 }));
    expect(Number.isFinite(perfect)).toBe(true);
    expect(perfect).toBe(PERFECT_WINDOW_BASE + 100);
    expect(perfect).toBeGreaterThan(good);
    expect(perfectBetter).toBeGreaterThan(perfect);
    expect(perfect).toBeLessThanOrEqual(OBJECTIVE_CAP);
  });

  it('Sortino und Sharpe null: Netto entscheidet (Cap bzw. −∞)', () => {
    expect(objectiveValue('sortino', m({ sortino: null, sharpe: null, netProfit: 5 }))).toBe(OBJECTIVE_CAP);
    expect(objectiveValue('sortino', m({ sortino: null, sharpe: null, netProfit: 0 }))).toBe(-Infinity);
    expect(objectiveValue('sortino', m({ sortino: null, sharpe: null, netProfit: -5 }))).toBe(-Infinity);
    // negativer Sharpe ohne Sortino: ehrlich negativ
    expect(objectiveValue('sortino', m({ sortino: null, sharpe: -0.5 }))).toBe(-0.5);
    expect(objectiveValue('sortino', m({ sortino: Infinity, sharpe: 3 }))).toBe(PERFECT_WINDOW_BASE + 3);
  });

  it('klemmt endliche Werte auf ±OBJECTIVE_CAP', () => {
    expect(objectiveValue('sortino', m({ sortino: 5e6 }))).toBe(OBJECTIVE_CAP);
    expect(objectiveValue('sortino', m({ sortino: -5e6 }))).toBe(-OBJECTIVE_CAP);
    expect(objectiveValue('sharpe', m({ sharpe: 5e6 }))).toBe(OBJECTIVE_CAP);
  });

  it('Fold-Median: ein perfekter Fold zieht den Median nicht nach unten', () => {
    const perfect = objectiveValue('sortino', m({ sortino: null, sharpe: 100 }));
    const good = objectiveValue('sortino', m({ sortino: 263 }));
    const bad = objectiveValue('sortino', m({ sortino: -50 }));
    expect(median([perfect, good, bad])).toBe(good);
  });
});
