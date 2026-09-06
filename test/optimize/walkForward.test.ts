import { describe, expect, it } from 'vitest';
import { median, objectiveValue } from '../../src/optimize/objective.ts';
import { mulberry32 } from '../../src/optimize/search.ts';
import { aggregateOos, fixedParamsWfa, foldPlanForBars, lowerBound, oosScoreOnFolds, walkForward, type OosPiece } from '../../src/optimize/walkForward.ts';
import { REWARD_PROFILE, dailyBars, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from './fakes.ts';

const bars = dailyBars(400);
const cfg = testConfig();
const strategy = fakeStrategy('edge');

function runWfa(seed = 1) {
  const simulate = makeFakeSimulate(REWARD_PROFILE);
  const wfa = walkForward({
    symbol: 'AAA',
    strategy,
    bars,
    config: simConfigOf(cfg),
    optimizer: cfg.optimizer,
    initialEquity: 10_000,
    simulate,
    rng: mulberry32(seed),
  });
  return { wfa, simulate };
}

describe('walkForward', () => {
  const { wfa, simulate } = runWfa();
  const plan = foldPlanForBars(bars, cfg.optimizer);

  it('wählt je Fold die Params mit maximaler Kante (a = 10)', () => {
    expect(wfa.folds.length).toBe(8);
    for (const f of wfa.folds) {
      expect(f.best.params.a).toBe(10);
      expect(f.evaluated).toBe(55); // Gitter (55) ≤ samples (60) ⇒ erschöpfend
      expect(f.best.isObjective).toBeGreaterThan(0);
    }
    expect(wfa.finalParams.a).toBe(10);
    expect(wfa.strategyId).toBe('edge');
    expect(wfa.symbol).toBe('AAA');
    expect(wfa.timeframe).toBe(1440);
  });

  it('zählt alle bewerteten Parametersätze als Trials; finale Suche liefert IS-Renditen und Trial-Sharpes', () => {
    expect(wfa.trials).toBe(8 * 55 + 55);
    expect(wfa.finalEvaluated).toBe(55);
    // finales Fenster: 150 Bars minus 25 Embargo ⇒ 125 Tagesrenditen von finalParams
    expect(wfa.finalIsDailyReturns.length).toBe(150 - 25);
    expect(wfa.finalTrialSharpes.length).toBe(55);
    for (const s of wfa.finalTrialSharpes) expect(Number.isFinite(s)).toBe(true);
    // a = 10 hat die stärkste Kante ⇒ der größte Trial-Sharpe liegt über dem Median
    expect(Math.max(...wfa.finalTrialSharpes)).toBeGreaterThan(median(wfa.finalTrialSharpes));
  });

  it('IS-Läufe enden vor isEnd − Embargo, OOS-Läufe decken genau [oosStart, oosEnd)', () => {
    const embargo = strategy.warmupBars(strategy.defaults) + 20; // 25
    for (const f of wfa.folds) {
      // 120 IS-Bars minus 25 Embargo ⇒ 95 Entscheidungen; OOS 30 Bars ⇒ 30 Trades
      expect(f.best.isMetrics.trades).toBe(120 - embargo);
      expect(f.best.oosMetrics.trades).toBe(30);
      expect(f.best.oosTrades.length).toBe(30);
      expect(f.best.oosDailyReturns.length).toBe(30);
      // Der OOS-Lauf eines Folds ist eindeutig (Range exakt [oosStart, oosEnd));
      // die 55 Aufrufe davor sind die IS-Suche dieses Folds.
      const oosIdx = simulate.calls.findIndex((c) => c.range && c.range.start === f.fold.oosStart && c.range.end === f.fold.oosEnd);
      expect(oosIdx).toBeGreaterThanOrEqual(55);
      expect(simulate.calls.filter((c) => c.range && c.range.start === f.fold.oosStart && c.range.end === f.fold.oosEnd).length).toBe(1);
      expect(simulate.calls[oosIdx]!.params).toEqual(f.best.params);
      const isCalls = simulate.calls.slice(oosIdx - 55, oosIdx);
      for (const c of isCalls) {
        expect(c.costMultiplier).toBe(1);
        expect(c.range!.start).toBe(f.fold.isStart);
        expect(c.range!.end).toBeLessThan(f.fold.isEnd);
        expect(lowerBound(bars.t, f.fold.isEnd) - lowerBound(bars.t, c.range!.end)).toBe(embargo);
      }
    }
  });

  it('der Holdout wird genau einmal berührt — durch den Berichtslauf, nie durch die Auswahl', () => {
    const holdout = plan.holdout!;
    const touching = simulate.calls.filter((c) => c.range && c.range.end > holdout.start);
    expect(touching.length).toBe(1);
    expect(touching[0]!.range).toEqual({ start: holdout.start, end: holdout.end });
    expect(touching[0]!.params).toEqual(wfa.finalParams);
    expect(wfa.holdout).not.toBeNull();
    expect(wfa.holdout!.start).toBe(holdout.start);
    expect(wfa.holdout!.metrics.trades).toBe(30);
  });

  it('die finale Suche läuft auf dem letzten Fenster (IS + OOS des letzten Folds) mit Embargo vor dem Holdout', () => {
    const last = plan.folds[plan.folds.length - 1]!;
    expect(wfa.finalWindow).toEqual({ start: last.isStart, end: last.oosEnd, embargoAtEnd: true });
    const finalCalls = simulate.calls.filter((c) => c.range && c.range.start === last.isStart && c.range.end > last.isEnd);
    expect(finalCalls.length).toBe(55);
    for (const c of finalCalls) expect(c.range!.end).toBeLessThan(last.oosEnd);
    expect(wfa.finalIsMetrics.trades).toBe(150 - 25);
  });

  it('aggregiert OOS korrekt: Median, positiver Anteil, Summen, verkettete Renditen', () => {
    const objectives = wfa.folds.map((f) => f.best.oosObjective);
    expect(wfa.oos.objectiveMedian).toBe(median(objectives));
    expect(wfa.oos.objectiveMean).toBeCloseTo(objectives.reduce((s, x) => s + x, 0) / objectives.length, 12);
    expect(wfa.oos.positiveFoldShare).toBe(wfa.folds.filter((f) => f.best.oosMetrics.netProfit > 0).length / 8);
    expect(wfa.oos.trades).toBe(240);
    expect(wfa.oos.netProfit).toBeCloseTo(wfa.folds.reduce((s, f) => s + f.best.oosMetrics.netProfit, 0), 6);
    const chained = wfa.folds.reduce((s, f) => s * (1 + f.best.oosMetrics.netReturnPct / 100), 1);
    expect(wfa.oos.netReturnPct).toBeCloseTo((chained - 1) * 100, 6);
    expect(wfa.oos.dailyReturns.length).toBe(240);
    expect(wfa.oos.dailyReturns).toEqual(wfa.folds.flatMap((f) => f.best.oosDailyReturns));
    expect(wfa.oos.maxDrawdownPct).toBeGreaterThanOrEqual(Math.max(...wfa.folds.map((f) => f.best.oosMetrics.maxDrawdownPct)) - 1e-9);
    expect(wfa.oos.feeShare).toBeGreaterThan(0);
    expect(wfa.oos.feeShare).toBeLessThan(0.5);
    expect(wfa.oos.profitFactor).toBeGreaterThan(1);
    for (const f of wfa.folds) expect(f.best.oosObjective).toBe(objectiveValue('sortino', f.best.oosMetrics));
  });

  it('ist bei gleichem Seed identisch', () => {
    const a = runWfa(5).wfa;
    const b = runWfa(5).wfa;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('erreicht kein Kandidat die IS-Mindesttrades, gewinnt der mit den meisten Trades (deterministisch)', () => {
    // 1000 Bars je Trade ⇒ 0 Trades überall ⇒ erster Kandidat (Defaults)
    const simulate = makeFakeSimulate({ ...REWARD_PROFILE, barsPerTrade: 1000 });
    const w = walkForward({
      symbol: 'AAA',
      strategy,
      bars,
      config: simConfigOf(cfg),
      optimizer: cfg.optimizer,
      initialEquity: 10_000,
      simulate,
      rng: mulberry32(1),
    });
    for (const f of w.folds) expect(f.best.params).toEqual(strategy.defaults);
    expect(w.finalParams).toEqual(strategy.defaults);
    expect(w.oos.trades).toBe(0);
    expect(w.oos.objectiveMedian).toBe(-Infinity);
  });

  it('Champion-Params im include werden immer mitbewertet', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const small = testConfig({ optimizer: { samples: 4 } });
    walkForward({
      symbol: 'AAA',
      strategy,
      bars,
      config: simConfigOf(small),
      optimizer: small.optimizer,
      initialEquity: 10_000,
      simulate,
      rng: mulberry32(1),
      include: [{ a: 9, b: 4 }],
    });
    const first = simulate.calls.slice(0, 4).map((c) => c.params);
    expect(first[0]).toEqual(strategy.defaults);
    expect(first[1]).toEqual({ a: 9, b: 4 });
  });

  it('zu wenig Historie ⇒ klarer Fehler', () => {
    expect(() =>
      walkForward({
        symbol: 'AAA',
        strategy,
        bars: dailyBars(200),
        config: simConfigOf(cfg),
        optimizer: cfg.optimizer,
        initialEquity: 10_000,
        simulate: makeFakeSimulate(REWARD_PROFILE),
        rng: mulberry32(1),
      }),
    ).toThrow(/mindestens 3 Folds/);
  });
});

describe('aggregateOos', () => {
  const piece = (netReturnPct: number, equityPath: number[], trades: OosPiece['trades'] = []): OosPiece => ({
    metrics: {
      netProfit: netReturnPct * 10,
      netReturnPct,
      cagrPct: null,
      sharpe: 1,
      sortino: netReturnPct / 10,
      maxDrawdownPct: 0,
      profitFactor: null,
      winRatePct: null,
      expectancy: null,
      avgR: null,
      trades: 10,
      exposurePct: 100,
      feeShare: null,
      days: 30,
    },
    trades,
    dailyReturns: [netReturnPct / 100],
    equity: equityPath.map((e, i) => ({ t: i, equity: e })),
    finalEquity: 1000 * (1 + netReturnPct / 100),
  });

  it('kettet Folds multiplikativ und misst den Drawdown über die Kette', () => {
    // Fold 1: +10 % (Pfad ohne DD), Fold 2: −10 % mit Zwischentief bei 850
    const agg = aggregateOos([piece(10, [1000, 1050, 1100]), piece(-10, [1000, 850, 900])], 'sortino', 1000);
    expect(agg.netReturnPct).toBeCloseTo((1.1 * 0.9 - 1) * 100, 9);
    // Kette: 1.1 → 1.1·0.85 = 0.935 ⇒ DD = 15 %
    expect(agg.maxDrawdownPct).toBeCloseTo(15, 9);
    expect(agg.positiveFoldShare).toBe(0.5);
    expect(agg.trades).toBe(20);
    expect(agg.objectiveMedian).toBe(0);
    expect(agg.dailyReturns).toEqual([0.1, -0.1]);
    expect(agg.profitFactor).toBeNull();
    expect(agg.feeShare).toBeNull();
  });

  it('Profit-Faktor und Gebührenanteil aus den OOS-Trades', () => {
    const t = (netPnl: number, fees: number) =>
      ({ symbol: 'A', side: 'long', qty: 1, entryTime: 0, entryPrice: 1, exitTime: 1, exitPrice: 1, grossPnl: netPnl + fees, fees, netPnl, rMultiple: null, exitReason: 'signal', strategy: 's', barsHeld: 1, mae: null, mfe: null }) as const;
    const agg = aggregateOos([piece(1, [1000], [t(30, 2), t(-10, 2), t(20, 2)])], 'sortino', 1000);
    expect(agg.profitFactor).toBeCloseTo(50 / 10, 9);
    expect(agg.feeShare).toBeCloseTo(6 / 46, 9);
  });

  it('leere Liste ⇒ schlechtester Wert, keine Division durch null', () => {
    const agg = aggregateOos([], 'sharpe', 1000);
    expect(agg.objectiveMedian).toBe(-Infinity);
    expect(agg.positiveFoldShare).toBe(0);
    expect(agg.maxDrawdownPct).toBe(0);
  });
});

describe('oosScoreOnFolds', () => {
  it('bewertet feste Params auf denselben OOS-Fenstern wie die WFA', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const folds = foldPlanForBars(bars, cfg.optimizer).folds;
    const agg = oosScoreOnFolds({
      symbol: 'AAA',
      strategy,
      params: { a: 10, b: 0 },
      bars,
      config: simConfigOf(cfg),
      initialEquity: 10_000,
      simulate,
      folds,
      objective: 'sortino',
    });
    expect(simulate.calls.length).toBe(8);
    expect(simulate.calls.map((c) => c.range)).toEqual(folds.map((f) => ({ start: f.oosStart, end: f.oosEnd })));
    // dieselben Params wie die WFA-Folds (a = 10, gemeinsames Rauschen) ⇒ identischer OOS-Median
    expect(agg.objectiveMedian).toBe(runWfa().wfa.oos.objectiveMedian);
  });
});

describe('fixedParamsWfa (Amtsinhaber ohne Suche)', () => {
  it('bewertet feste Params nur auf den übergebenen Folds — ohne Trials, mit IS-Lauf für die Nachbarschaft', () => {
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const plan = foldPlanForBars(bars, cfg.optimizer);
    const clean = plan.folds.slice(5); // z. B. nur die letzten 3 Folds sind sauber
    const w = fixedParamsWfa({
      symbol: 'AAA',
      strategy,
      params: { a: 10, b: 0 },
      bars,
      config: simConfigOf(cfg),
      initialEquity: 10_000,
      simulate,
      folds: clean,
      optimizer: cfg.optimizer,
      holdout: plan.holdout,
    });
    expect(w.folds.length).toBe(3);
    expect(w.folds.map((f) => f.fold.index)).toEqual([5, 6, 7]);
    expect(w.trials).toBe(0);
    expect(w.finalEvaluated).toBe(0);
    expect(w.finalTrialSharpes).toEqual([]);
    expect(w.finalParams).toEqual({ a: 10, b: 0 });
    expect(w.oos.trades).toBe(90);
    expect(w.finalWindow).toEqual({ start: clean[2]!.isStart, end: clean[2]!.oosEnd, embargoAtEnd: true });
    expect(w.finalIsDailyReturns.length).toBe(150 - 25);
    expect(w.holdout).toBeNull();
    // OOS-Aufrufe exakt auf den sauberen Fenstern, nie davor
    const oosCalls = simulate.calls.filter((c) => clean.some((f) => c.range!.start === f.oosStart && c.range!.end === f.oosEnd));
    expect(oosCalls.length).toBe(3);
    for (const c of simulate.calls) expect(c.range!.start).toBeGreaterThanOrEqual(clean[0]!.isStart);
    // gleicher OOS-Median wie die reine Fold-Bewertung
    const agg = oosScoreOnFolds({ symbol: 'AAA', strategy, params: { a: 10, b: 0 }, bars, config: simConfigOf(cfg), initialEquity: 10_000, simulate, folds: clean, objective: 'sortino' });
    expect(w.oos.objectiveMedian).toBe(agg.objectiveMedian);
    expect(() => fixedParamsWfa({ symbol: 'AAA', strategy, params: { a: 1, b: 1 }, bars, config: simConfigOf(cfg), initialEquity: 10_000, simulate, folds: [], optimizer: cfg.optimizer, holdout: null })).toThrow(/keine Folds/);
  });
});
