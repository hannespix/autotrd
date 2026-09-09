import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../src/core/types.ts';
import { objectiveValue } from '../../src/optimize/objective.ts';
import type { OptimizerConfig } from '../../src/core/config.ts';
import {
  DSR_MIN_RETURNS,
  deflatedSharpeIs,
  gateOptions,
  neighborhoodTest,
  probabilisticSharpeOos,
  robustnessGates,
  stressTest,
  type DsrResult,
  type GateInput,
  type PsrResult,
} from '../../src/optimize/robustness.ts';
import { mulberry32, neighbors } from '../../src/optimize/search.ts';
import { walkForward, type WfaResult } from '../../src/optimize/walkForward.ts';
import { NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig } from './fakes.ts';

const cfg = testConfig();

/** Optimierer-Config mit den Gate-Schaltern (Schema zieht die Felder nach; bis dahin per Cast). */
function withGateFlags(flags: { dsrIsGate?: boolean; minPsrOos?: number }): OptimizerConfig {
  return { ...cfg.optimizer, ...flags } as OptimizerConfig;
}

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

const strongReturns = (n: number, k = 0) => Array.from({ length: n }, (_, i) => 0.01 + 0.004 * Math.sin(i + k));

/** Handgebautes WFA-Ergebnis, das alle Gates besteht. */
function wfaFixture(over: Partial<WfaResult['oos']> = {}, foldReturns?: number[][], extra: Partial<WfaResult> = {}): WfaResult {
  const returns = foldReturns ?? Array.from({ length: 5 }, (_, k) => strongReturns(30, k));
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
    finalEvaluated: 50,
    // IS-Sharpe ≈ 0,7 je Periode — moderat genug, dass die Deflation sichtbar bleibt
    // (bei Sharpe ≈ 3,5 sättigt Φ auf exakt 1 und jeder Vergleich wird blind)
    finalIsDailyReturns: Array.from({ length: 120 }, (_, i) => 0.01 + 0.02 * Math.sin(i + 7)),
    // enges Plateau: alle Trials nahe beieinander
    finalTrialSharpes: Array.from({ length: 50 }, (_, i) => 0.6 + 0.004 * i),
    holdout: null,
    dataRange: { start: 0, end: 10 },
    embargoBars: 25,
    ...extra,
  };
}

function dsrOf(value: number | null): DsrResult {
  return {
    dsr: value,
    dsrFinalOnly: value,
    sr: 1,
    n: 120,
    nTrials: 250,
    nTrialsFinal: 50,
    varSr: 0.01,
    varSrSource: 'trial_sharpes',
    varSrTrials: 0.01,
    varSrFolds: 0.05,
    skew: 0,
    kurt: 3,
    note: `DSR ${value ?? 'null'} (Fixture)`,
  };
}

function psrOf(value: number | null): PsrResult {
  return { psr: value, sr: 0.5, n: 150, skew: 0, kurt: 3, note: `PSR ${value ?? 'null'} (Fixture)` };
}

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    wfa: wfaFixture(),
    optimizer: cfg.optimizer,
    stressOos: { netProfit: 200, objectiveMedian: 0.8 },
    neighborhood: { medianObjective: 0.8, bestObjective: 1, positiveShare: 0.75 },
    dsr: dsrOf(0.99),
    psr: psrOf(0.99),
    metricsFns: fakeMetricsFns,
    ...over,
  };
}

const failing = (r: ReturnType<typeof robustnessGates>) => r.gates.filter((g) => !g.pass).map((g) => g.name);
/**
 * Gate über den NAMEN holen, nie über die Position: Ein neues Gate schob
 * sonst elf Tests gleichzeitig auf die falsche Zeile, ohne dass an ihnen
 * etwas falsch gewesen wäre.
 */
const gate = (r: ReturnType<typeof robustnessGates>, name: string) => {
  const g = r.gates.find((x) => x.name === name);
  if (!g) throw new Error(`Gate ${name} fehlt — vorhanden: ${r.gates.map((x) => x.name).join(', ')}`);
  return g;
};

describe('robustnessGates', () => {
  /**
   * Der Fall, der das Gate nötig gemacht hat.
   *
   * TSLA am 07.09.2026: 103 OOS-Trades, +958,46 $, 5 von 7 Folds positiv,
   * PSR 0,950, Gebührenanteil 32 % — alle acht damaligen Gates bestanden,
   * befördert. Von den +958,46 $ stammten aber +919,34 $ aus Fold 7. Ohne
   * ihn blieben +39,12 $ über 91 Trades. Der Holdout, der die Auswahl nie
   * beeinflusst hat, war danach −232,43 $ bei PF 0,73.
   *
   * Kein damaliges Gate schaute darauf: `fold_positive_share` zählt Folds,
   * nicht ihr Gewicht; PSR misst die Renditereihe, nicht ihre Verteilung
   * über die Fenster.
   */
  it('(9) Konzentration: ein einzelner Fold trägt fast das ganze OOS-Netto (Fall TSLA)', () => {
    const tslaFolds = [117.23, 102.97, -360.37, 76.18, 150.73, -47.62, 919.34];
    const wfa = wfaFixture({ netProfit: 958.46, positiveFoldShare: 5 / 7, trades: 103 });
    const mitNetto = {
      ...wfa,
      folds: wfa.folds.slice(0, 1).concat(),
    } as typeof wfa;
    // Folds mit den echten Netto-Werten nachbauen.
    mitNetto.folds = tslaFolds.map((netto, k) => ({
      fold: { index: k, isStart: k, isEnd: k + 1, oosStart: k + 1, oosEnd: k + 2 },
      evaluated: 50,
      best: {
        params: { a: 5, b: 2 },
        isMetrics: metrics(),
        oosMetrics: metrics({ netProfit: netto }),
        oosTrades: [],
        isObjective: 1,
        oosObjective: 1,
        oosDailyReturns: strongReturns(30, k),
      },
    }));

    const r = robustnessGates(gateInput({ wfa: mitNetto }));
    const g = gate(r, 'fold_concentration');
    expect(g.pass, 'ein Ergebnis aus einem einzigen Monat ist keine Kante').toBe(false);
    expect(g.value).toBeCloseTo(919.34 / 958.46, 3);
    expect(g.note).toContain('96 %');
    expect(g.note).toContain('ohne ihn blieben 39.12');
    expect(failing(r)).toContain('fold_concentration');
  });

  it('(9b) gleichmäßig verteilte Folds bestehen', () => {
    const r = robustnessGates(gateInput());
    const g = gate(r, 'fold_concentration');
    expect(g.pass).toBe(true);
    // Fünf gleich große Folds ⇒ jeder trägt ein Fünftel.
    expect(g.value).toBeCloseTo(0.2, 6);
  });

  it('(9c) bei nicht positivem OOS-Netto urteilt das Gate nicht — dafür ist oos_net_profit da', () => {
    const wfa = wfaFixture();
    wfa.folds = wfa.folds.map((f) => ({ ...f, best: { ...f.best, oosMetrics: metrics({ netProfit: -50 }) } }));
    const g = gate(robustnessGates(gateInput({ wfa })), 'fold_concentration');
    expect(g.pass).toBe(true);
    expect(g.note).toContain('nicht aussagekräftig');
  });

  it('bestehen alle Gates, ist pass = true', () => {
    const r = robustnessGates(gateInput());
    expect(r.pass).toBe(true);
    expect(r.gates.length).toBe(10);
    expect(r.gates.map((g) => g.name)).toEqual([
      'oos_trades',
      'fold_positive_share',
      'oos_net_profit',
      'fold_concentration',
      'stress_costs',
      'neighborhood_plateau',
      'probabilistic_sharpe_oos',
      'deflated_sharpe_is',
      'fee_share',
      'beats_market',
    ]);
    for (const g of r.gates) expect(g.note.length).toBeGreaterThan(0);
  });

  /*
   * beats_market — das Gate, das am 08.09.2026 gefehlt hat: momentum_pullback
   * bestand alle neun anderen und verfehlte im folgenden Halbjahr den Korb um
   * 21.8 Prozentpunkte (+1.9 % gegen +23.7 %). Keines der neun hatte gefragt,
   * ob Nichtstun besser gewesen wäre.
   */
  describe('beats_market', () => {
    /** OOS-Sharpe der Fixture, damit die Latte gezielt darüber/darunter liegt. */
    const srDerFixture = (): number => {
      const v = gate(robustnessGates(gateInput()), 'beats_market').value;
      if (v === null) throw new Error('OOS-Sharpe der Fixture nicht berechenbar');
      return v;
    };

    it('über der Latte ⇒ bestanden, Latte steht als Schwelle im Bericht', () => {
      const latte = srDerFixture() - 0.5;
      const g = gate(robustnessGates(gateInput({ markt: { sharpe: latte, quelle: 'SPY kaufen und halten über 5 OOS-Fenster' } })), 'beats_market');
      expect(g.pass).toBe(true);
      expect(g.threshold).toBeCloseTo(latte, 9);
      expect(g.note).toContain('SPY kaufen und halten über 5 OOS-Fenster');
    });

    it('unter der Latte ⇒ durchgefallen, auch wenn alles andere stimmt', () => {
      const r = robustnessGates(gateInput({ markt: { sharpe: srDerFixture() + 0.5, quelle: 'SPY kaufen und halten über 5 OOS-Fenster' } }));
      expect(r.pass).toBe(false);
      expect(failing(r)).toEqual(['beats_market']);
      expect(gate(r, 'beats_market').note).toContain('kaufen und liegenlassen war besser');
    });

    it('genau auf der Latte reicht nicht — gleich gut ist nicht besser', () => {
      const g = gate(robustnessGates(gateInput({ markt: { sharpe: srDerFixture(), quelle: 'SPY' } })), 'beats_market');
      expect(g.pass).toBe(false);
    });

    it('ohne Maßstab gilt die Kasse (Latte 0) — das Gate wird nie vakant', () => {
      // Sonst schaffte man es ab, indem man die Benchmark aus der Config nimmt.
      const g = gate(robustnessGates(gateInput()), 'beats_market');
      expect(g.threshold).toBe(0);
      expect(g.note).toContain('kein Maßstab konfiguriert — Latte 0 (Kasse)');
      expect(g.pass).toBe(true); // die Fixture hat positiven OOS-Sharpe
    });

    it('nicht berechenbarer Maßstab fällt auf die Kasse zurück — bleibt aber unterscheidbar vom Fall ohne Benchmark', () => {
      const g = gate(robustnessGates(gateInput({ markt: { sharpe: null, quelle: 'SPY über 8 OOS-Fenster' } })), 'beats_market');
      expect(g.threshold).toBe(0);
      expect(g.pass).toBe(true);
      // Ein Datenproblem darf im Bericht nicht wie eine Konfigurationsentscheidung aussehen.
      expect(g.note).toContain('SPY über 8 OOS-Fenster, Sharpe nicht berechenbar');
      expect(g.note).not.toContain('kein Maßstab konfiguriert');
    });

    it('nicht berechenbarer OOS-Sharpe gilt als durchgefallen, nie als bestanden', () => {
      const stumpf = { ...fakeMetricsFns, sharpeRatio: () => null };
      const g = gate(robustnessGates(gateInput({ metricsFns: stumpf })), 'beats_market');
      expect(g.pass).toBe(false);
      expect(g.note).toContain('gilt als durchgefallen');
    });
  });

  it('(1) zu wenige OOS-Trades', () => {
    const r = robustnessGates(gateInput({ wfa: wfaFixture({ trades: 59 }) }));
    expect(r.pass).toBe(false);
    expect(failing(r)).toEqual(['oos_trades']);
    const g = gate(r, 'oos_trades');
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
    expect(gate(r, 'stress_costs').note).toContain('×1.5');
  });

  it('(5) Spitze statt Plateau: Nachbar-Median < 0,5 × Bestwert oder zu wenige positive Nachbarn', () => {
    expect(failing(robustnessGates(gateInput({ neighborhood: { medianObjective: 0.49, bestObjective: 1, positiveShare: 1 } })))).toEqual(['neighborhood_plateau']);
    expect(failing(robustnessGates(gateInput({ neighborhood: { medianObjective: 0.9, bestObjective: 1, positiveShare: 0.5 } })))).toEqual(['neighborhood_plateau']);
    expect(robustnessGates(gateInput({ neighborhood: { medianObjective: 0.5, bestObjective: 1, positiveShare: 0.6 } })).pass).toBe(true);
    const r = robustnessGates(gateInput({ neighborhood: { medianObjective: 0.3, bestObjective: 1, positiveShare: 1 } }));
    expect(gate(r, 'neighborhood_plateau').threshold).toBe(0.5);
    expect(gate(r, 'neighborhood_plateau').value).toBe(0.3);
  });

  it('(6) PSR (OOS) < 0,90 oder nicht berechenbar', () => {
    expect(failing(robustnessGates(gateInput({ psr: psrOf(0.899) })))).toEqual(['probabilistic_sharpe_oos']);
    const r = robustnessGates(gateInput({ psr: psrOf(null) }));
    expect(failing(r)).toEqual(['probabilistic_sharpe_oos']);
    expect(gate(r, 'probabilistic_sharpe_oos').value).toBeNull();
    expect(gate(r, 'probabilistic_sharpe_oos').threshold).toBe(0.9);
    expect(gate(r, 'probabilistic_sharpe_oos').note).toMatch(/nicht berechenbar/);
    expect(robustnessGates(gateInput({ psr: psrOf(0.9) })).pass).toBe(true);
    expect(gate(r, 'probabilistic_sharpe_oos').note).toMatch(/Sharpe p\. a\./);
  });

  it('(7) DSR (IS) blockiert NICHT, solange dsrIsGate=false — der Wert bleibt sichtbar', () => {
    expect(gateOptions(cfg.optimizer)).toEqual({ minPsrOos: 0.9, dsrIsGate: false });
    const low = robustnessGates(gateInput({ dsr: dsrOf(0.1) }));
    expect(low.pass).toBe(true);
    expect(failing(low)).toEqual([]);
    const g = gate(low, 'deflated_sharpe_is');
    expect(g.name).toBe('deflated_sharpe_is');
    expect(g.value).toBe(0.1);
    expect(g.threshold).toBe(0.95);
    expect(g.note).toMatch(/^informativ \(dsrIsGate=false\)/);
    expect(g.note).toMatch(/würde als Gate durchfallen/);
    const nul = robustnessGates(gateInput({ dsr: dsrOf(null) }));
    expect(nul.pass).toBe(true);
    expect(gate(nul, 'deflated_sharpe_is').note).toMatch(/informativ/);
    const ok = robustnessGates(gateInput({ dsr: dsrOf(0.99) }));
    expect(gate(ok, 'deflated_sharpe_is').note).not.toMatch(/durchfallen/);
  });

  it('(7b) DSR (IS) < 0,95 oder nicht berechenbar blockiert mit dsrIsGate=true', () => {
    const on = withGateFlags({ dsrIsGate: true });
    expect(gateOptions(on).dsrIsGate).toBe(true);
    expect(failing(robustnessGates(gateInput({ optimizer: on, dsr: dsrOf(0.949) })))).toEqual(['deflated_sharpe_is']);
    const r = robustnessGates(gateInput({ optimizer: on, dsr: dsrOf(null) }));
    expect(failing(r)).toEqual(['deflated_sharpe_is']);
    expect(gate(r, 'deflated_sharpe_is').value).toBeNull();
    expect(gate(r, 'deflated_sharpe_is').note).toMatch(/nicht berechenbar/);
    expect(gate(r, 'deflated_sharpe_is').note).not.toMatch(/informativ/);
    expect(robustnessGates(gateInput({ optimizer: on, dsr: dsrOf(0.95) })).pass).toBe(true);
  });

  it('Amtsinhaber-Modus: Trade-Schwelle anteilig zu den sauberen Folds, DSR nicht anwendbar', () => {
    const half = { cleanFolds: 4, totalFolds: 8 };
    const ok = robustnessGates(gateInput({ incumbent: half, wfa: wfaFixture({ trades: 30 }), dsr: dsrOf(0.1) }));
    expect(ok.pass).toBe(true);
    expect(gate(ok, 'oos_trades').threshold).toBe(30);
    expect(gate(ok, 'oos_trades').note).toMatch(/anteilig 30 von 60/);
    expect(gate(ok, 'deflated_sharpe_is').pass).toBe(true);
    expect(gate(ok, 'deflated_sharpe_is').note).toMatch(/nicht anwendbar/);
    // auch mit dsrIsGate=true bleibt der DSR beim Amtsinhaber außen vor (keine Suche, keine Trials)
    expect(robustnessGates(gateInput({ optimizer: withGateFlags({ dsrIsGate: true }), incumbent: half, wfa: wfaFixture({ trades: 30 }), dsr: dsrOf(null) })).pass).toBe(true);
    const tooFew = robustnessGates(gateInput({ incumbent: half, wfa: wfaFixture({ trades: 29 }) }));
    expect(failing(tooFew)).toEqual(['oos_trades']);
    // alle Folds sauber ⇒ volle Schwelle
    expect(robustnessGates(gateInput({ incumbent: { cleanFolds: 8, totalFolds: 8 }, wfa: wfaFixture({ trades: 59 }) })).pass).toBe(false);
  });

  it('(6b) PSR-Schwelle kommt aus optimizer.minPsrOos', () => {
    const strict = withGateFlags({ minPsrOos: 0.99 });
    const r = robustnessGates(gateInput({ optimizer: strict, psr: psrOf(0.95) }));
    expect(failing(r)).toEqual(['probabilistic_sharpe_oos']);
    expect(gate(r, 'probabilistic_sharpe_oos').threshold).toBe(0.99);
    expect(robustnessGates(gateInput({ optimizer: withGateFlags({ minPsrOos: 0.5 }), psr: psrOf(0.6) })).pass).toBe(true);
  });

  it('(8) Gebühren fressen mehr als die Hälfte — nicht berechenbar ist kein Urteil', () => {
    expect(failing(robustnessGates(gateInput({ wfa: wfaFixture({ feeShare: 0.51 }) })))).toEqual(['fee_share']);
    expect(robustnessGates(gateInput({ wfa: wfaFixture({ feeShare: 0.5 }) })).pass).toBe(true);
    const r = robustnessGates(gateInput({ wfa: wfaFixture({ feeShare: null }) }));
    expect(r.pass).toBe(true);
    expect(gate(r, 'fee_share').note).toMatch(/kein Urteil/);
  });

  it('mehrere Verstöße werden alle gemeldet', () => {
    const r = robustnessGates(gateInput({ optimizer: withGateFlags({ dsrIsGate: true }), wfa: wfaFixture({ trades: 1, netProfit: -1, feeShare: 0.9 }), dsr: dsrOf(0.1), psr: psrOf(0.2) }));
    expect(failing(r)).toEqual(['oos_trades', 'oos_net_profit', 'probabilistic_sharpe_oos', 'deflated_sharpe_is', 'fee_share']);
    // ohne dsrIsGate bleibt DSR-IS informativ
    const soft = robustnessGates(gateInput({ wfa: wfaFixture({ trades: 1, netProfit: -1, feeShare: 0.9 }), dsr: dsrOf(0.1), psr: psrOf(0.2) }));
    expect(failing(soft)).toEqual(['oos_trades', 'oos_net_profit', 'probabilistic_sharpe_oos', 'fee_share']);
  });
});

describe('probabilisticSharpeOos', () => {
  it('starke, stabile OOS-Renditen ⇒ PSR nahe 1 (sr0 = 0)', () => {
    const r = probabilisticSharpeOos({ wfa: wfaFixture(), metricsFns: fakeMetricsFns });
    expect(r.psr!).toBeGreaterThan(0.99);
    expect(r.n).toBe(150);
    expect(r.sr!).toBeGreaterThan(0);
    expect(r.note).toMatch(/OOS-SR\/Periode/);
    expect(r.note).toMatch(/sr0=0/);
  });

  it('Renditen mit Erwartungswert 0 ⇒ PSR nahe 0,5, negative ⇒ klein', () => {
    const rng = mulberry32(3);
    const zero = Array.from({ length: 5 }, () => Array.from({ length: 30 }, () => (rng() - 0.5) * 0.02));
    const r0 = probabilisticSharpeOos({ wfa: wfaFixture({}, zero), metricsFns: fakeMetricsFns });
    expect(r0.psr!).toBeLessThan(0.9);
    const neg = zero.map((f) => f.map((x) => x - 0.005));
    const rNeg = probabilisticSharpeOos({ wfa: wfaFixture({}, neg), metricsFns: fakeMetricsFns });
    expect(rNeg.psr!).toBeLessThan(0.1);
  });

  it('zu wenige Renditen oder Varianz 0 ⇒ null mit Notiz', () => {
    const few = probabilisticSharpeOos({ wfa: wfaFixture({}, [[0.01, 0.02], [0.01, 0.02], [0.01, 0.02]]), metricsFns: fakeMetricsFns });
    expect(few.psr).toBeNull();
    expect(few.note).toMatch(new RegExp(`${DSR_MIN_RETURNS}`));
    // 0.25 ist exakt darstellbar — 0.01 hätte durch Rundungsreste eine Scheinvarianz
    const flat = probabilisticSharpeOos({ wfa: wfaFixture({}, Array.from({ length: 3 }, () => Array.from({ length: 40 }, () => 0.25))), metricsFns: fakeMetricsFns });
    expect(flat.psr).toBeNull();
    expect(flat.note).toMatch(/nicht berechenbar/);
  });
});

describe('deflatedSharpeIs', () => {
  it('deflationiert die IS-Zahl von finalParams mit allen Trials und der Streuung der finalen Suche', () => {
    const wfa = wfaFixture();
    const r = deflatedSharpeIs({ wfa, metricsFns: fakeMetricsFns });
    expect(r.n).toBe(120);
    expect(r.nTrials).toBe(250);
    expect(r.varSrSource).toBe('trial_sharpes');
    expect(r.varSr).toBe(r.varSrTrials);
    // Stichprobenvarianz von 1.5 + 0.004·i, i = 0…49 ⇒ 0.004² · Var(i) = 1.6e-5 · 212.5
    expect(r.varSrTrials).toBeCloseTo(0.0034, 4);
    expect(r.sr!).toBeGreaterThan(0.6);
    expect(r.sr!).toBeLessThan(0.8);
    expect(r.dsr!).toBeGreaterThan(0.99);
    expect(r.note).toMatch(/IS-SR\/Periode/);
    expect(r.note).toMatch(/aus trial_sharpes/);
    expect(r.note).toMatch(/Schiefe/);
  });

  it('große Trial-Streuung deflationiert dieselbe IS-Zahl bis zum Durchfallen', () => {
    const narrow = deflatedSharpeIs({ wfa: wfaFixture(), metricsFns: fakeMetricsFns });
    // Trials, die von 0 bis zum Maximum streuen: das Maximum von 250 Rausch-Trials läge dann ähnlich hoch
    const wide = deflatedSharpeIs({ wfa: wfaFixture({}, undefined, { finalTrialSharpes: Array.from({ length: 50 }, (_, i) => (i / 49) * 2.2) }), metricsFns: fakeMetricsFns });
    expect(wide.sr).toBe(narrow.sr);
    expect(wide.varSr).toBeGreaterThan(narrow.varSr);
    expect(wide.dsr!).toBeLessThan(narrow.dsr!);
    expect(wide.dsr!).toBeLessThan(0.95);
  });

  it('mehr Trials bei gleicher Streuung ⇒ kleinerer DSR', () => {
    const spread = Array.from({ length: 50 }, (_, i) => i / 49);
    const few = deflatedSharpeIs({ wfa: wfaFixture({}, undefined, { trials: 10, finalTrialSharpes: spread }), metricsFns: fakeMetricsFns });
    const many = deflatedSharpeIs({ wfa: wfaFixture({}, undefined, { trials: 100_000, finalTrialSharpes: spread }), metricsFns: fakeMetricsFns });
    expect(few.dsr!).toBeGreaterThan(0.9);
    expect(many.dsr!).toBeLessThan(0.5);
  });

  it('weist die Variante mit nTrials = Samples der finalen Suche aus (milder als über alle Folds)', () => {
    const spread = Array.from({ length: 50 }, (_, i) => i / 49);
    const r = deflatedSharpeIs({ wfa: wfaFixture({}, undefined, { trials: 500, finalEvaluated: 10, finalTrialSharpes: spread }), metricsFns: fakeMetricsFns });
    expect(r.nTrials).toBe(500);
    expect(r.nTrialsFinal).toBe(10);
    expect(r.dsrFinalOnly!).toBeGreaterThan(r.dsr!);
    expect(r.note).toMatch(/Trials=500 \(alle Folds\)/);
    expect(r.note).toMatch(/nTrials=10 \(nur finale Suche\)/);
  });

  it("varSrSource 'fold_sharpes' nimmt die OOS-Fold-Streuung; beide Werte stehen in der Notiz", () => {
    const wfa = wfaFixture();
    const trials = deflatedSharpeIs({ wfa, metricsFns: fakeMetricsFns });
    const folds = deflatedSharpeIs({ wfa, metricsFns: fakeMetricsFns, varSrSource: 'fold_sharpes' });
    expect(folds.varSrSource).toBe('fold_sharpes');
    expect(folds.varSr).toBe(folds.varSrFolds);
    expect(folds.varSrFolds).toBe(trials.varSrFolds);
    expect(folds.varSrTrials).toBe(trials.varSrTrials);
    expect(folds.note).toMatch(/aus fold_sharpes/);
    expect(trials.note).toMatch(/Trials .* Folds/);
    expect(folds.sr).toBe(trials.sr);
  });

  it('zu wenige IS-Renditen ⇒ null; weniger als 2 Trial-Sharpes ⇒ Fallback varSr = 0,01', () => {
    const few = deflatedSharpeIs({ wfa: wfaFixture({}, undefined, { finalIsDailyReturns: [0.01, 0.02] }), metricsFns: fakeMetricsFns });
    expect(few.dsr).toBeNull();
    expect(few.note).toMatch(/zu wenige IS-Tagesrenditen/);
    const one = deflatedSharpeIs({ wfa: wfaFixture({}, undefined, { finalTrialSharpes: [1] }), metricsFns: fakeMetricsFns });
    expect(one.varSr).toBe(0.01);
    expect(one.dsr).not.toBeNull();
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

  it('WÄCHTER: die tote Achse allowShort zählt bei gesperrtem Short nicht als Nachbar', () => {
    // §5a.15: Der ±1-Nachbar entlang einer Achse, die decide() ohnehin
    // sperrt, hat exakt den Bestwert — und schmeichelte dem Plateau.
    const mitShort = fakeStrategy('short', {
      space: [...strategy.paramSpace, { name: 'allowShort', min: 0, max: 1, step: 1, kind: 'int' }],
      defaults: { ...strategy.defaults, allowShort: 0 },
    });
    const gesperrt = simConfigOf(cfg);
    expect(gesperrt.risk.allowShort).toBe(false);
    const simulate = makeFakeSimulate(REWARD_PROFILE);
    const wfa = walkForward({ ...common, strategy: mitShort, config: gesperrt, optimizer: cfg.optimizer, simulate, rng: mulberry32(1) });
    simulate.calls.length = 0;
    const n = neighborhoodTest({ ...common, strategy: mitShort, config: gesperrt, simulate, wfa, optimizer: cfg.optimizer });
    const ohneAchse = neighbors(wfa.finalParams, strategy.paramSpace);
    expect(n.evaluated).toBe(ohneAchse.length);
    for (const c of simulate.calls) expect(c.params.allowShort).toBe(0);

    // Mit erlaubtem Short ist die Achse echt und hat genau einen Nachbarn mehr.
    const erlaubt = { ...gesperrt, risk: { ...gesperrt.risk, allowShort: true } };
    const wfa2 = walkForward({ ...common, strategy: mitShort, config: erlaubt, optimizer: cfg.optimizer, simulate, rng: mulberry32(1) });
    const n2 = neighborhoodTest({ ...common, strategy: mitShort, config: erlaubt, simulate, wfa: wfa2, optimizer: cfg.optimizer });
    expect(n2.evaluated).toBe(neighbors(wfa2.finalParams, strategy.paramSpace).length + 1);
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

  it('echte Kante mit Plateau: PSR (OOS) und DSR (IS) bestehen; Rauschen fällt an beiden', () => {
    const edge = wfaOf(makeFakeSimulate(REWARD_PROFILE));
    expect(probabilisticSharpeOos({ wfa: edge, metricsFns: fakeMetricsFns }).psr!).toBeGreaterThan(0.9);
    expect(deflatedSharpeIs({ wfa: edge, metricsFns: fakeMetricsFns }).dsr!).toBeGreaterThan(0.95);
    const noise = wfaOf(makeFakeSimulate(NOISE_PROFILE));
    expect(probabilisticSharpeOos({ wfa: noise, metricsFns: fakeMetricsFns }).psr!).toBeLessThan(0.9);
    expect(deflatedSharpeIs({ wfa: noise, metricsFns: fakeMetricsFns }).dsr!).toBeLessThan(0.95);
  });
});
