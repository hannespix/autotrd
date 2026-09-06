import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../src/core/types.ts';
import { objectiveValue } from '../../src/optimize/objective.ts';
import {
  DSR_MIN_RETURNS,
  deflatedSharpeOos,
  neighborhoodTest,
  robustnessGates,
  stressTest,
  type GateInput,
} from '../../src/optimize/robustness.ts';
import { mulberry32, neighbors } from '../../src/optimize/search.ts';
import { walkForward, type WfaResult } from '../../src/optimize/walkForward.ts';
import { NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from './fakes.ts';

const cfg = testConfig();

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    netProfit: 100,
    netReturnPct: 1,
    cagrPct: null,
    sharpe: 1,
    sortino: 1,
    maxDrawdownPct: 2,
    profitFactor: 1.5,
    winRatePct: 55,
    expectancy: 1,
    avgR: null,
    trades: 20,
    exposurePct: 50,
    feeShare: 0.2,
    days: 30,
    ...over,
  };
}

/** Handgebautes WFA-Ergebnis, das alle Gates besteht. */
function wfaFixture(over: Partial<WfaResult['oos']> = {}, foldReturns?: number[][]): WfaResult {
  const returns = foldReturns ?? Array.from({ length: 5 }, (_, k) => Array.from({ length: 30 }, (_, i) => 0.01 + 0.004 * Math.sin(i + k)));
  const folds = returns.map((r, k) => ({
    fold: { index: k, isStart: k, isEnd: k + 1, oosStart: k + 1, oosEnd: k + 2 },
    evaluated: 50,
    best: {
      params: { a: 5, b: 2 },
      isMetrics: metrics(),
      oosMetrics: metrics(),
      oosTrades: [],
      isObjective: 1,
      oosObjective: 1,
      oosDailyReturns: r,
    },
  }));
  return {
    strategyId: 's',
    symbol: 'AAA',
    timeframe: 1440,
    folds,
    oos: {
      objectiveMedian: 1,
      objectiveMean: 1,
      positiveFoldShare: 0.8,
      trades: 100,
      netProfit: 500,
      netReturnPct: 5,
      maxDrawdownPct: 3,
      dailyReturns: returns.flat(),
      profitFactor: 1.5,
      feeShare: 0.2,
      ...over,
    },
    finalParams: { a: 5, b: 2 },
    finalIsMetrics: metrics(),
    finalWindow: { start: 0, end: 10, embargoAtEnd: true },
    trials: 250,
    holdout: null,
    dataRange: { start: 0, end: 10 },
    embargoBars: 25,
  };
}

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    wfa: wfaFixture(),
    optimizer: cfg.optimizer,
    stressOos: { netProfit: 200, objectiveMedian: 0.8 },
    neighborhood: { medianObjective: 0.8, bestObjective: 1, positiveShare: 0.75 },
    dsr: 0.99,
    metricsFns: fakeMetricsFns,
    ...over,
  };
}

const failing = (r: ReturnType<typeof robustnessGates>) => r.gates.filter((g) => !g.pass).map((g) => g.name);

describe('robustnessGates', () => {
  it('bestehen alle Gates, ist pass = true', () => {
    const r = robustnessGates(gateInput());
    expect(r.pass).toBe(true);
    expect(r.gates.length).toBe(7);
    expect(r.gates.map((g) => g.name)).toEqual([
      'oos_trades',
      'fold_positive_share',
      'oos_net_profit',
      'stress_costs',
      'neighborhood_plateau',
      'deflated_sharpe',
      'fee_share',
    ]);
    for (const g of r.gates) expect(g.note.length).toBeGreaterThan(0);
  });

  it('(1) zu wenige OOS-Trades', () => {
    const r = robustnessGates(gateInput({ wfa: wfaFixture({ trades: 59 }) }));
    expect(r.pass).toBe(false);
    expect(failing(r)).toEqual(['oos_trades']);
    const g = r.gates[0]!;
    expect(g.value).toBe(59);
    expect(g.threshold).toBe(60);
  });

  it('(2) zu wenige positive Folds', () => {
    const r = robustnessGates(gateInput({ wfa: wfaFixture({ positiveFoldShare: 0.5 }) }));
    expect(failing(r)).toEqual(['fold_positive_share']);
    expect(robustnessGates(gateInput({ wfa: wfaFixture({ positiveFoldShare: 0.6 }) })).pass).toBe(true);
  });

  it('(3) OOS netto nicht positiv', () => {
    expect(failing(robustnessGates(gateInput({ wfa: wfaFixture({ netProfit: 0 }) })))).toEqual(['oos_net_profit']);
    expect(failing(robustnessGates(gateInput({ wfa: wfaFixture({ netProfit: -1 }) })))).toEqual(['oos_net_profit']);
  });

  it('(4) Stress: bei verteuerten Kosten kippt das Netto', () => {
    const r = robustnessGates(gateInput({ stressOos: { netProfit: -5, objectiveMedian: -0.1 } }));
    expect(failing(r)).toEqual(['stress_costs']);
    expect(r.gates[3]!.note).toContain('×1.5');
  });

  it('(5) Spitze statt Plateau: Nachbar-Median < 0,5 × Bestwert oder zu wenige positive Nachbarn', () => {
    expect(failing(robustnessGates(gateInput({ neighborhood: { medianObjective: 0.49, bestObjective: 1, positiveShare: 1 } })))).toEqual(['neighborhood_plateau']);
    expect(failing(robustnessGates(gateInput({ neighborhood: { medianObjective: 0.9, bestObjective: 1, positiveShare: 0.5 } })))).toEqual(['neighborhood_plateau']);
    expect(robustnessGates(gateInput({ neighborhood: { medianObjective: 0.5, bestObjective: 1, positiveShare: 0.6 } })).pass).toBe(true);
    const r = robustnessGates(gateInput({ neighborhood: { medianObjective: 0.3, bestObjective: 1, positiveShare: 1 } }));
    expect(r.gates[4]!.threshold).toBe(0.5);
    expect(r.gates[4]!.value).toBe(0.3);
  });

  it('(6) DSR < 0,95 oder nicht berechenbar', () => {
    expect(failing(robustnessGates(gateInput({ dsr: 0.949 })))).toEqual(['deflated_sharpe']);
    const r = robustnessGates(gateInput({ dsr: null }));
    expect(failing(r)).toEqual(['deflated_sharpe']);
    expect(r.gates[5]!.value).toBeNull();
    expect(r.gates[5]!.note).toMatch(/nicht berechenbar/);
    expect(robustnessGates(gateInput({ dsr: 0.95 })).pass).toBe(true);
  });

  it('(7) Gebühren fressen mehr als die Hälfte — nicht berechenbar ist kein Urteil', () => {
    expect(failing(robustnessGates(gateInput({ wfa: wfaFixture({ feeShare: 0.51 }) })))).toEqual(['fee_share']);
    expect(robustnessGates(gateInput({ wfa: wfaFixture({ feeShare: 0.5 }) })).pass).toBe(true);
    const r = robustnessGates(gateInput({ wfa: wfaFixture({ feeShare: null }) }));
    expect(r.pass).toBe(true);
    expect(r.gates[6]!.note).toMatch(/kein Urteil/);
  });

  it('mehrere Verstöße werden alle gemeldet', () => {
    const r = robustnessGates(gateInput({ wfa: wfaFixture({ trades: 1, netProfit: -1, feeShare: 0.9 }), dsr: 0.1 }));
    expect(failing(r)).toEqual(['oos_trades', 'oos_net_profit', 'deflated_sharpe', 'fee_share']);
  });
});

describe('deflatedSharpeOos', () => {
  it('starke, stabile OOS-Renditen ⇒ DSR nahe 1', () => {
    const r = deflatedSharpeOos({ wfa: wfaFixture(), metricsFns: fakeMetricsFns });
    expect(r.dsr).not.toBeNull();
    expect(r.dsr!).toBeGreaterThan(0.99);
    expect(r.psr!).toBeGreaterThan(0.99);
    expect(r.n).toBe(150);
    expect(r.nTrials).toBe(250);
    expect(r.varSr).toBeGreaterThanOrEqual(0);
    expect(r.note).toMatch(/Trials=250/);
  });

  it('Renditen mit Erwartungswert 0 ⇒ DSR klein', () => {
    const rng = mulberry32(3);
    const returns = Array.from({ length: 5 }, () => Array.from({ length: 30 }, () => (rng() - 0.5) * 0.02));
    const r = deflatedSharpeOos({ wfa: wfaFixture({}, returns), metricsFns: fakeMetricsFns });
    expect(r.dsr).not.toBeNull();
    expect(r.dsr!).toBeLessThan(0.5);
  });

  it('zu wenige Renditen ⇒ null mit Notiz', () => {
    const returns = [[0.01, 0.02], [0.01, 0.02], [0.01, 0.02]];
    const r = deflatedSharpeOos({ wfa: wfaFixture({}, returns), metricsFns: fakeMetricsFns });
    expect(r.dsr).toBeNull();
    expect(r.note).toMatch(new RegExp(`${DSR_MIN_RETURNS}`));
  });

  it('konstante Renditen (Varianz 0) ⇒ null', () => {
    // 0.25 ist exakt darstellbar — 0.01 hätte durch Rundungsreste eine Scheinvarianz
    const returns = Array.from({ length: 3 }, () => Array.from({ length: 40 }, () => 0.25));
    const r = deflatedSharpeOos({ wfa: wfaFixture({}, returns), metricsFns: fakeMetricsFns });
    expect(r.dsr).toBeNull();
    expect(r.note).toMatch(/nicht berechenbar/);
  });

  it('bei weniger als 2 Fold-Sharpes gilt der Fallback varSr = 0,01', () => {
    const returns = [Array.from({ length: 40 }, (_, i) => 0.01 + 0.002 * Math.sin(i)), [0.01], [0.01]];
    const r = deflatedSharpeOos({ wfa: wfaFixture({}, returns), metricsFns: fakeMetricsFns });
    expect(r.varSr).toBe(0.01);
  });
});

describe('stressTest & neighborhoodTest (mit Fake-Simulator)', () => {
  const bars = dailyBars(400);
  const strategy = fakeStrategy('edge');
  const common = { symbol: 'AAA', strategy, bars, config: simConfigOf(cfg), initialEquity: 10_000 };

  function wfaOf(simulate: ReturnType<typeof makeFakeSimulate>) {
    return walkForward({ ...common, optimizer: cfg.optimizer, simulate, rng: mulberry32(1) });
  }

  it('Stress simuliert die OOS-Kette mit dem Kostenfaktor — Netto sinkt, bleibt bei echter Kante positiv', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const wfa = wfaOf(simulate);
    simulate.calls.length = 0;
    const s = stressTest({ ...common, simulate, wfa, costMultiplier: 1.5, objective: 'sortino' });
    expect(simulate.calls.length).toBe(8);
    for (const c of simulate.calls) expect(c.costMultiplier).toBe(1.5);
    expect(simulate.calls.map((c) => c.range)).toEqual(wfa.folds.map((f) => ({ start: f.fold.oosStart, end: f.fold.oosEnd })));
    expect(s.netProfit).toBeLessThan(wfa.oos.netProfit);
    expect(s.netProfit).toBeGreaterThan(0);
    expect(s.trades).toBe(240);
    expect(s.costMultiplier).toBe(1.5);
  });

  it('Stress mit ruinösem Faktor kippt das Netto', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const wfa = wfaOf(simulate);
    const s = stressTest({ ...common, simulate, wfa, costMultiplier: 100, objective: 'sortino' });
    expect(s.netProfit).toBeLessThan(0);
  });

  it('Nachbarschaft bewertet genau die ±1-Nachbarn auf dem finalen Fenster', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const wfa = wfaOf(simulate);
    simulate.calls.length = 0;
    const n = neighborhoodTest({ ...common, simulate, wfa, optimizer: cfg.optimizer });
    const expected = neighbors(wfa.finalParams, strategy.paramSpace);
    expect(n.evaluated).toBe(expected.length);
    expect(simulate.calls.map((c) => c.params)).toEqual(expected);
    for (const c of simulate.calls) {
      expect(c.range!.start).toBe(wfa.finalWindow.start);
      expect(c.range!.end).toBeLessThan(wfa.finalWindow.end);
    }
    expect(n.bestObjective).toBe(objectiveValue('sortino', wfa.finalIsMetrics));
    // a = 9 statt 10 und b ± 1: echte Kante ⇒ Plateau
    expect(n.medianObjective).toBeGreaterThan(0.5 * n.bestObjective);
    expect(n.positiveShare).toBe(1);
  });

  it('Rauschen: die Nachbarn eines Zufallsoptimums sind kein Plateau', () => {
    const simulate = makeFakeSimulate(NOISE_PROFILE);
    const wfa = wfaOf(simulate);
    const n = neighborhoodTest({ ...common, simulate, wfa, optimizer: cfg.optimizer });
    expect(n.medianObjective).toBeLessThan(n.bestObjective);
  });

  it('ein Raum ohne Nachbarn gilt als Plateau', () => {
    const single = fakeStrategy('one', { space: [{ name: 'a', min: 1, max: 1, step: 1, kind: 'int' }], defaults: { a: 1 } });
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const wfa = walkForward({ ...common, strategy: single, optimizer: cfg.optimizer, simulate, rng: mulberry32(1) });
    const n = neighborhoodTest({ ...common, simulate, strategy: single, wfa, optimizer: cfg.optimizer });
    expect(n.evaluated).toBe(0);
    expect(n.positiveShare).toBe(1);
    expect(n.medianObjective).toBe(n.bestObjective);
  });
});
