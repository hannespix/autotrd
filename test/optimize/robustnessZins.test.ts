/**
 * Die Gates gegen den risikolosen Zins (Befund B2 vom 12.09.2026,
 * Vorregistrierung `docs/wissen/vorregistrierung/2026-09-13-sharpe-gegen-zins.md`).
 *
 * Drei Fragen, die hier beantwortet werden:
 * 1. Ändert sich per Vorgabe wirklich NICHTS? (Sonst verschöben sich alle
 *    bisherigen Messergebnisse still.)
 * 2. Verliert ein Kandidat, der nur Bargeld hält, die zwei Gates, die er
 *    gegen null geschenkt bekam — und nur diese zwei?
 * 3. Werden BEIDE Seiten von `beats_market` gleich gerechnet, und wird der
 *    Zins laut verworfen, sobald das nicht geht?
 *
 * Arbeitsteilung seit dem 13.09.2026 (zweite Änderung, Vorregistrierung
 * `2026-09-13-gates-auf-ueberschuss.md`): Diese Datei prüft die beiden
 * SHARPE-Gates. Die GELD-Gates (`fold_positive_share`, `oos_net_profit`,
 * `fold_concentration`, `stress_costs`) rechnen seither ebenfalls auf
 * Überschuss — ihre Wächter stehen in `gatesUeberschuss.test.ts`. Die Läufe
 * hier übergeben bewusst KEIN Startkapital: Ohne es lässt sich der Überschuss
 * nicht in Geld ausdrücken, die Geld-Gates bleiben roh, und der Unterschied
 * bleibt genau auf die zwei Sharpe-Gates isoliert.
 */
import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../src/core/types.ts';
import { ROHES_NETTO_NOTE } from '../../src/backtest/metrics.ts';
import { OHNE_ZINS_NOTE, probabilisticSharpeOos, robustnessGates, type DsrResult, type GateInput, type GateRiskFree } from '../../src/optimize/robustness.ts';
import type { WfaResult } from '../../src/optimize/walkForward.ts';
import { fakeMetricsFns, testConfig } from './fakes.ts';

const cfg = testConfig();

/* ── Reihen: ein Konto, das nur den Geldmarkt hält, und ein Aktienmarkt ── */

const N = 504;
const ZINS_PA = 0.04;
const zinsReihe = Array.from({ length: N }, (_, i) => ZINS_PA / 252 + 2e-5 * (i % 2 === 0 ? 1 : -1));
/** Rendite = Zins + mittelwertfreies Handelsrauschen: ohne Zins ein Wunder, mit Zins nichts. */
const nurGeldmarkt = zinsReihe.map((r, i) => r + 5e-5 * (Math.floor(i / 2) % 2 === 0 ? 1 : -1));
/** Aktienmarkt: 8 % p. a. bei ~16 % Schwankung ⇒ roh ≈ 0,50, im Überschuss ≈ 0,25. */
const marktReihe = Array.from({ length: N }, (_, i) => 0.08 / 252 + 0.01 * (i % 2 === 0 ? 1 : -1));

const riskFree = (over: Partial<GateRiskFree> = {}): GateRiskFree => ({
  strategie: zinsReihe,
  markt: zinsReihe,
  quelle: 'BIL über dieselben Tage (504 von 504 belegt)',
  ...over,
});

/* ── Fixtures ── */

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

/** WFA-Ergebnis, dessen OOS-Kette genau `returns` ist; alle Nicht-Sharpe-Gates bestehen. */
function wfaFixture(returns: readonly number[]): WfaResult {
  const folds = Array.from({ length: 4 }, (_, k) => ({
    fold: { index: k, isStart: k, isEnd: k + 1, oosStart: k + 1, oosEnd: k + 2 },
    evaluated: 50,
    best: {
      params: { a: 5 },
      isMetrics: metrics(),
      oosMetrics: metrics({ netProfit: 100 + k }),
      oosTrades: [],
      isObjective: 1,
      oosObjective: 1,
      oosDailyReturns: [...returns.slice(k * 10, k * 10 + 10)],
    },
  }));
  return {
    strategyId: 'geldmarkt',
    symbol: 'AAA',
    timeframe: 1440,
    folds,
    oos: {
      objectiveMedian: 1,
      objectiveMean: 1,
      positiveFoldShare: 1,
      trades: 100,
      netProfit: 406,
      netReturnPct: 1.6,
      maxDrawdownPct: 0.75,
      dailyReturns: [...returns],
      profitFactor: 1.5,
      feeShare: 0.2,
    },
    finalParams: { a: 5 },
    finalIsMetrics: metrics(),
    finalWindow: { start: 0, end: 10, embargoAtEnd: true },
    trials: 1,
    finalEvaluated: 1,
    finalIsDailyReturns: [...returns],
    finalTrialSharpes: [],
    holdout: null,
    dataRange: { start: 0, end: 10 },
    embargoBars: 0,
  };
}

const dsr: DsrResult = {
  dsr: null,
  dsrFinalOnly: null,
  sr: null,
  n: N,
  nTrials: 1,
  nTrialsFinal: 1,
  varSr: 0.01,
  varSrSource: 'trial_sharpes',
  varSrTrials: 0.01,
  varSrFolds: 0.01,
  skew: null,
  kurt: null,
  note: 'nicht anwendbar (Fixture)',
};

/** Der Lauf, wie ihn der Optimierer macht: erst PSR, dann Gates — beide mit oder beide ohne Zins. */
function lauf(opts: { riskFree?: GateRiskFree | undefined; markt?: GateInput['markt'] | null; psrOhneZins?: boolean } = {}) {
  const wfa = wfaFixture(nurGeldmarkt);
  const psr = probabilisticSharpeOos({
    wfa,
    metricsFns: fakeMetricsFns,
    ...(opts.psrOhneZins ? {} : opts.riskFree ? { riskFree: opts.riskFree } : {}),
  });
  const input: GateInput = {
    wfa,
    optimizer: cfg.optimizer,
    stressOos: { netProfit: 200, objectiveMedian: 0.8 },
    neighborhood: { medianObjective: 0.8, bestObjective: 1, positiveShare: 0.75 },
    dsr,
    psr,
    metricsFns: fakeMetricsFns,
    periodsPerYear: 252,
    fixed: true,
    // `markt: null` im Aufruf heißt „gar kein Maßstab konfiguriert".
    markt: opts.markt === undefined ? { sharpe: 0.5, quelle: 'SPY kaufen und halten über 4 OOS-Fenster', dailyReturns: marktReihe } : (opts.markt ?? undefined),
    ...(opts.riskFree ? { riskFree: opts.riskFree } : {}),
  };
  const r = robustnessGates(input);
  const gate = (name: string) => {
    const g = r.gates.find((x) => x.name === name);
    if (!g) throw new Error(`Gate ${name} fehlt`);
    return g;
  };
  return { ...r, psr, gate, durchgefallen: r.gates.filter((g) => !g.pass).map((g) => g.name) };
}

/* ───────────────────────── Die Tests ───────────────────────── */

describe('Vorgabe: ohne Geldmarkt-Symbol ändert sich nichts', () => {
  it('ein Konto, das nur Bargeld hält, besteht gegen sr0 = 0 ALLE zehn Gates', () => {
    const ohne = lauf();
    expect(ohne.durchgefallen).toEqual([]);
    expect(ohne.pass).toBe(true);
    // Der geschenkte Anteil, in Zahlen: Sharpe 46,7 gegen eine Latte von 0,50.
    expect(ohne.gate('beats_market').value!).toBeCloseTo(46.7, 1);
    expect(ohne.gate('beats_market').threshold!).toBeCloseTo(0.5, 2);
    expect(ohne.gate('probabilistic_sharpe_oos').value!).toBeCloseTo(1, 6);
  });

  it('und jede betroffene Notiz sagt LAUT, dass gegen null gerechnet wurde', () => {
    const ohne = lauf();
    expect(ohne.gate('beats_market').note).toContain(OHNE_ZINS_NOTE);
    expect(ohne.gate('probabilistic_sharpe_oos').note).toContain(OHNE_ZINS_NOTE);
    expect(ohne.psr.ueberschuss).toBe(false);
  });

  it('auch die GELD-Gates sagen laut, mit welchem Maßstab sie gerechnet haben', () => {
    const ohne = lauf();
    for (const name of ['fold_positive_share', 'oos_net_profit', 'fold_concentration', 'stress_costs']) {
      expect(ohne.gate(name).note, name).toContain(ROHES_NETTO_NOTE);
    }
  });
});

describe('Mit Zinsreihe: Bargeld ist keine Kante mehr', () => {
  it('genau zwei Gates kippen — probabilistic_sharpe_oos und beats_market', () => {
    const mit = lauf({ riskFree: riskFree() });
    expect(mit.durchgefallen).toEqual(['probabilistic_sharpe_oos', 'beats_market']);
    expect(mit.pass).toBe(false);
    // Sharpe 46,7 → 0,0; PSR 1,000 → 0,500.
    expect(mit.gate('beats_market').value!).toBeCloseTo(0, 6);
    expect(mit.gate('probabilistic_sharpe_oos').value!).toBeCloseTo(0.5, 6);
  });

  it('beide Seiten gleich: auch die Latte verliert den Zins (0,50 → 0,25)', () => {
    const mit = lauf({ riskFree: riskFree() });
    const latte = mit.gate('beats_market').threshold!;
    expect(latte).toBeCloseTo((0.08 - ZINS_PA) / (0.01 * Math.sqrt(252)), 2);
    expect(latte).toBeCloseTo(0.25, 2);
    expect(latte).toBeLessThan(0.5);
    expect(mit.gate('beats_market').note).toContain('(Überschuss)');
  });

  it('ohne Startkapital bleiben die Geld-Gates roh — und nennen genau diesen Grund', () => {
    const mit = lauf({ riskFree: riskFree() });
    expect(mit.gate('oos_net_profit').note).toContain('kein Startkapital übergeben');
  });

  it('die Notizen nennen Satz und Herkunft wörtlich', () => {
    const mit = lauf({ riskFree: riskFree() });
    expect(mit.gate('beats_market').note).toContain('Zins: BIL über dieselben Tage (504 von 504 belegt)');
    expect(mit.gate('probabilistic_sharpe_oos').note).toContain('BIL über dieselben Tage');
    expect(mit.gate('probabilistic_sharpe_oos').note).toContain('sr0=0 über dem Zins');
    expect(mit.psr.ueberschuss).toBe(true);
  });

  it('ohne Benchmark bleibt die Latte 0 — Kasse ist im Überschuss per Definition 0', () => {
    const mit = lauf({ riskFree: riskFree(), markt: null });
    const g = mit.gate('beats_market');
    expect(g.threshold).toBe(0);
    expect(g.note).toContain('im Überschuss per Definition 0');
    // Der Sharpe der Strategie ist im Überschuss ~0 und damit NICHT > 0.
    expect(g.pass).toBe(false);
  });
});

describe('Der Zins wird verworfen, statt gemischt zu rechnen', () => {
  it('Längenversatz auf der Strategieseite: beide Seiten gegen null, Grund in der Notiz', () => {
    const kurz = riskFree({ strategie: zinsReihe.slice(0, N - 1) });
    const r = lauf({ riskFree: kurz });
    expect(r.durchgefallen).toEqual([]);
    expect(r.gate('beats_market').value!).toBeCloseTo(46.7, 1);
    expect(r.gate('beats_market').note).toContain('nicht auf die OOS-Kette ausgerichtet (504 Renditen, 503 Sätze)');
    expect(r.gate('probabilistic_sharpe_oos').note).toContain('Zins: Reihe nicht auf die OOS-Kette ausgerichtet');
    expect(r.psr.ueberschuss).toBe(false);
  });

  it('PSR ohne Zins gerechnet ⇒ beats_market rechnet auch ohne (gemischt wäre schlimmer)', () => {
    const r = lauf({ riskFree: riskFree(), psrOhneZins: true });
    expect(r.gate('beats_market').note).toContain('PSR wurde ohne Zins gerechnet — gemischte Rechnung abgelehnt');
    expect(r.gate('beats_market').value!).toBeCloseTo(46.7, 1);
    expect(r.gate('beats_market').threshold!).toBeCloseTo(0.5, 2);
  });

  it('Markt-Latte ohne eigene Renditereihe ⇒ beide Seiten gegen null', () => {
    const r = lauf({ riskFree: riskFree(), markt: { sharpe: 0.5, quelle: 'SPY kaufen und halten über 4 OOS-Fenster' } });
    expect(r.gate('beats_market').note).toContain('Markt-Renditen fehlen');
    expect(r.gate('beats_market').note).toContain('beide Seiten gegen null gerechnet');
    expect(r.gate('beats_market').value!).toBeCloseTo(46.7, 1);
    expect(r.gate('beats_market').threshold!).toBeCloseTo(0.5, 2);
  });

  it('Markt-Sätze nicht ausgerichtet ⇒ beide Seiten gegen null', () => {
    const r = lauf({ riskFree: riskFree({ markt: zinsReihe.slice(0, 10) }) });
    expect(r.gate('beats_market').note).toContain('Sätze der Marktkette nicht ausgerichtet (504 Renditen, 10 Sätze)');
    expect(r.gate('beats_market').threshold!).toBeCloseTo(0.5, 2);
  });

  it('Benchmark ohne Kurse (Sharpe null): Latte 0, Strategie trotzdem mit Zins gerechnet', () => {
    const r = lauf({ riskFree: riskFree(), markt: { sharpe: null, quelle: 'SPY kaufen und halten: keine Kurse in den OOS-Fenstern' } });
    const g = r.gate('beats_market');
    expect(g.threshold).toBe(0);
    expect(g.value!).toBeCloseTo(0, 6);
    expect(g.note).toContain('Zins: BIL über dieselben Tage');
    expect(g.pass).toBe(false);
  });
});
