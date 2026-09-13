/**
 * EIN Maßstab für alle Gates: Überschuss über dem risikolosen Zins.
 *
 * Vorregistrierung `docs/wissen/vorregistrierung/2026-09-13-gates-auf-ueberschuss.md`.
 *
 * Der Fehler, gegen den diese Wächter stehen, ist in Lauf #48 (13.09.2026)
 * wirklich passiert: Seit die Treasury brachliegende Kasse in den Geldmarkt
 * legt, verdient das KONTO den kurzen Zins, auch wenn die Strategie keinen
 * einzigen Trade macht. Bei `mean_reversion` zählten deshalb drei Quartale
 * OHNE EINEN TRADE als positive Folds:
 *
 *   | Fold | OOS-Trades | OOS-Netto |
 *   |------|-----------:|----------:|
 *   |    2 |          0 |   +95,93  |
 *   |   11 |          0 |  +134,31  |
 *   |   13 |          0 |  +227,50  |
 *
 * `fold_positive_share` stand bei 16 von 16 — während
 * `probabilistic_sharpe_oos` und `beats_market`, die schon auf Überschuss
 * rechneten, bei jedem Kandidaten durchfielen. Genau diese Zahlen stehen
 * unten im Fixture.
 */
import { describe, expect, it } from 'vitest';
import type { Metrics } from '../../src/core/types.ts';
import { ROHES_NETTO_NOTE } from '../../src/backtest/metrics.ts';
import {
  probabilisticSharpeOos,
  robustnessGates,
  ueberschussKette,
  type DsrResult,
  type GateInput,
  type GateRiskFree,
} from '../../src/optimize/robustness.ts';
import type { WfaResult } from '../../src/optimize/walkForward.ts';
import { fakeMetricsFns, testConfig } from './fakes.ts';

const cfg = testConfig();

/* ───────────────────────── Die Welt des Laufs #48 ───────────────────────── */

const E0 = 100_000;
/** 16 Folds à 90 Kalendertage ⇒ rund 62 Handelstage je Fold. */
const FOLDS = 16;
const TAGE = 62;
/** 4 % p. a. — der kurze Zins des Messzeitraums; je Fold rund 986 $ auf 100 000 $. */
const ZINS_PA = 0.04;
const RF_TAG = ZINS_PA / 252;
const zinsReihe = Array.from({ length: FOLDS * TAGE }, () => RF_TAG);

/** Der Betrag, den ein Geldmarktpapier über ein Quartal auf `E0` abwirft. */
const ZINS_JE_FOLD = E0 * (Math.pow(1 + RF_TAG, TAGE) - 1);

/** Konstante Tagesrendite, die über `TAGE` Tage genau `netto` auf `E0` ergibt. */
function konstanteRendite(netto: number): number {
  return Math.pow(1 + netto / E0, 1 / TAGE) - 1;
}

/** Netto, das `konstanteRendite` wirklich erzeugt — bitgleich zur Rechnung der Gates. */
function nettoAus(r: number): number {
  let f = 1;
  for (let i = 0; i < TAGE; i++) f *= 1 + r;
  return E0 * (f - 1);
}

interface FoldSpec {
  /** Rohes Netto dieses Folds (Konto-Sicht, so wie der Bericht von #48 es zeigt). */
  netto: number;
  trades: number;
}

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    netProfit: 0,
    netReturnPct: 0,
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
    days: 90,
    ...over,
  };
}

/**
 * WFA-Ergebnis, dessen OOS-Kette per Bauart die Verkettung der Fold-Reihen
 * ist — genau die Invariante, auf die sich `ueberschussKette` stützt (und die
 * sie prüft, statt sie zu glauben).
 */
function wfaAus(specs: readonly FoldSpec[]): WfaResult {
  const folds = specs.map((s, k) => {
    const r = konstanteRendite(s.netto);
    const netto = nettoAus(r);
    return {
      fold: { index: k, isStart: k, isEnd: k + 1, oosStart: k + 1, oosEnd: k + 2 },
      evaluated: 50,
      best: {
        params: { a: 5 },
        isMetrics: metrics({ netProfit: netto, trades: s.trades }),
        oosMetrics: metrics({ netProfit: netto, netReturnPct: (netto / E0) * 100, trades: s.trades }),
        oosTrades: [],
        isObjective: 1,
        oosObjective: 1,
        oosDailyReturns: Array.from({ length: TAGE }, () => r),
      },
    };
  });
  const dailyReturns = folds.flatMap((f) => f.best.oosDailyReturns);
  const netProfit = folds.reduce((s, f) => s + f.best.oosMetrics.netProfit, 0);
  const positiv = folds.filter((f) => f.best.oosMetrics.netProfit > 0).length;
  return {
    strategyId: 'mean_reversion',
    symbol: 'KORB',
    timeframe: 1440,
    folds,
    oos: {
      objectiveMedian: 1,
      objectiveMean: 1,
      positiveFoldShare: positiv / folds.length,
      trades: specs.reduce((s, x) => s + x.trades, 0),
      netProfit,
      netReturnPct: (netProfit / E0) * 100,
      maxDrawdownPct: 4.34,
      dailyReturns,
      profitFactor: 1.5,
      feeShare: 0.2,
    },
    finalParams: { a: 5 },
    finalIsMetrics: metrics(),
    finalWindow: { start: 0, end: 10, embargoAtEnd: true },
    trials: 1,
    finalEvaluated: 1,
    finalIsDailyReturns: dailyReturns,
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
  n: FOLDS * TAGE,
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

const riskFree = (over: Partial<GateRiskFree> = {}): GateRiskFree => ({
  strategie: zinsReihe,
  quelle: 'BIL über dieselben Tage (992 von 992 belegt)',
  ...over,
});

/** Der Lauf, wie ihn der Optimierer macht: erst PSR, dann Gates. */
function lauf(
  specs: readonly FoldSpec[],
  opts: { riskFree?: GateRiskFree | undefined; initialEquity?: number | undefined; stress?: GateInput['stressOos'] | undefined } = {},
) {
  const wfa = wfaAus(specs);
  const psr = probabilisticSharpeOos({ wfa, metricsFns: fakeMetricsFns, ...(opts.riskFree ? { riskFree: opts.riskFree } : {}) });
  const input: GateInput = {
    wfa,
    optimizer: cfg.optimizer,
    stressOos: opts.stress ?? { netProfit: wfa.oos.netProfit, objectiveMedian: 0.8 },
    neighborhood: { medianObjective: 0.8, bestObjective: 1, positiveShare: 0.75 },
    dsr,
    psr,
    metricsFns: fakeMetricsFns,
    periodsPerYear: 252,
    fixed: true,
    initialEquity: 'initialEquity' in opts ? opts.initialEquity : E0,
    ...(opts.riskFree ? { riskFree: opts.riskFree } : {}),
  };
  const r = robustnessGates(input);
  const gate = (name: string) => {
    const g = r.gates.find((x) => x.name === name);
    if (!g) throw new Error(`Gate ${name} fehlt`);
    return g;
  };
  return { ...r, wfa, gate, durchgefallen: r.gates.filter((g) => !g.pass).map((g) => g.name) };
}

/** 16 Folds: drei ohne Trade (die Zahlen aus #48), dreizehn handelnde. */
const LAUF48: FoldSpec[] = Array.from({ length: FOLDS }, (_, i) => {
  if (i === 1) return { netto: 95.93, trades: 0 };
  if (i === 10) return { netto: 134.31, trades: 0 };
  if (i === 12) return { netto: 227.5, trades: 0 };
  // Handelnde Folds: deutlich über dem Zins, damit sie auch im Überschuss positiv bleiben.
  return { netto: 2500 + i * 10, trades: 8 };
});

/* ───────────────────────── Die Wächter ───────────────────────── */

describe('Lauf #48: drei Quartale ohne einen Trade', () => {
  it('ROH (kein Zins): alle 16 Folds gelten als positiv — der Fehler, so wie er passiert ist', () => {
    const r = lauf(LAUF48);
    expect(r.gate('fold_positive_share').value).toBe(1);
    expect(r.gate('fold_positive_share').pass).toBe(true);
    expect(r.gate('fold_positive_share').note).toContain('16 von 16 Folds netto positiv');
    expect(r.gate('fold_positive_share').note).toContain(ROHES_NETTO_NOTE);
  });

  it('WÄCHTER: ein Fold ohne Trade zählt im Überschuss NICHT als positiv (13 von 16 statt 16 von 16)', () => {
    const r = lauf(LAUF48, { riskFree: riskFree() });
    expect(r.gate('fold_positive_share').value).toBeCloseTo(13 / 16, 12);
    expect(r.gate('fold_positive_share').note).toContain('13 von 16 Folds im Überschuss positiv');
    expect(r.gate('fold_positive_share').note).toContain('roh wären es 16');
    // Die drei Artefakt-Folds sind es, die wegfallen — und zwar deutlich, nicht knapp:
    // ein Geldmarktpapier hätte je Quartal rund 986 $ abgeworfen.
    const k = ueberschussKette({ wfa: r.wfa, riskFree: zinsReihe, initialEquity: E0 });
    if ('fehler' in k) throw new Error(k.fehler);
    expect(ZINS_JE_FOLD).toBeGreaterThan(900);
    // Der Überschuss wird AUFGEZINST, nicht subtrahiert (Π(1+r−r_f) statt
    // Π(1+r) − Π(1+r_f)) — deshalb liegt er nahe bei „Netto minus Zins", aber
    // nicht exakt darauf. Entscheidend ist das Vorzeichen, und es ist eindeutig.
    for (const [i, netto] of [[1, 95.93], [10, 134.31], [12, 227.5]] as const) {
      expect(k.folds[i]!, `Fold ${i + 1} muss im Überschuss negativ sein`).toBeLessThan(0);
      expect(Math.abs(k.folds[i]! - (netto - ZINS_JE_FOLD)), `Fold ${i + 1} nahe an Netto − Zins`).toBeLessThan(20);
    }
  });

  it('ein perfekt geparkter Fold OHNE Trade hat den Überschuss exakt 0 — und 0 ist nicht positiv', () => {
    // Das Konto verdient genau den Zins: rohes Netto ≈ +986 $, Leistung: keine.
    const nurZins: FoldSpec[] = Array.from({ length: FOLDS }, (_, i) => (i < 8 ? { netto: ZINS_JE_FOLD, trades: 0 } : { netto: 2500, trades: 8 }));
    const r = lauf(nurZins, { riskFree: riskFree() });
    const k = ueberschussKette({ wfa: r.wfa, riskFree: zinsReihe, initialEquity: E0 });
    if ('fehler' in k) throw new Error(k.fehler);
    for (let i = 0; i < 8; i++) expect(k.folds[i]!).toBeCloseTo(0, 6);
    // 8 von 16 = 0,5 < Schwelle 0,6 ⇒ das Gate fällt, obwohl roh alle 16 positiv wären.
    expect(r.gate('fold_positive_share').value).toBeCloseTo(0.5, 12);
    expect(r.gate('fold_positive_share').pass).toBe(false);
    expect(lauf(nurZins).gate('fold_positive_share').pass).toBe(true);
  });
});

describe('Dieselbe Umstellung in den übrigen Geld-Gates', () => {
  it('oos_net_profit zählt den Überschuss, nicht das Konto-Netto', () => {
    const roh = lauf(LAUF48).gate('oos_net_profit');
    const mit = lauf(LAUF48, { riskFree: riskFree() }).gate('oos_net_profit');
    expect(roh.value!).toBeGreaterThan(mit.value!);
    // 16 Folds × rund 986 $ Zins weniger (aufgezinst, daher nicht exakt).
    expect(roh.value! - mit.value!).toBeGreaterThan(0.95 * FOLDS * ZINS_JE_FOLD);
    expect(roh.value! - mit.value!).toBeLessThan(1.05 * FOLDS * ZINS_JE_FOLD);
    expect(mit.note).toContain('OOS Überschuss');
    expect(mit.note).toContain('Maßstab: Überschuss über den Zins');
  });

  it('der MaxDD bleibt ROH und sagt es — eine Kapitalgröße, nicht mit dem Überschuss verrechenbar', () => {
    const mit = lauf(LAUF48, { riskFree: riskFree() }).gate('oos_net_profit');
    expect(mit.note).toContain('MaxDD 4.34 % (roh, Kapitalsicht)');
  });

  it('fold_concentration wird strenger: der Zins trifft den Zähler einmal, den Nenner 16-mal', () => {
    const roh = lauf(LAUF48).gate('fold_concentration');
    const mit = lauf(LAUF48, { riskFree: riskFree() }).gate('fold_concentration');
    expect(mit.value!).toBeGreaterThan(roh.value!);
    expect(mit.note).toContain('des OOS-Überschusses');
  });

  it('stress_costs liest den Überschuss des STRESS-Laufs, nicht den des Normallaufs', () => {
    const g = lauf(LAUF48, {
      riskFree: riskFree(),
      // Roh positiv (Zinsertrag), im Überschuss negativ: genau der Fall, in dem
      // das Gate vor der Umstellung grün war und die Strategie nichts verdiente.
      stress: { netProfit: 1200, ueberschussNetProfit: -14_000, objectiveMedian: 0.2, zins: 'Maßstab: Überschuss über BIL' },
    }).gate('stress_costs');
    expect(g.value).toBe(-14_000);
    expect(g.pass).toBe(false);
    expect(g.note).toContain('OOS Überschuss bei Kosten');
    expect(g.note).toContain('roh 1200.00');
  });

  it('ohne Überschusszahl des Stress-Laufs bleibt das Gate roh — und die Notiz sagt es laut', () => {
    const g = lauf(LAUF48, { riskFree: riskFree(), stress: { netProfit: 1200, objectiveMedian: 0.2 } }).gate('stress_costs');
    expect(g.value).toBe(1200);
    expect(g.note).toContain(ROHES_NETTO_NOTE);
  });
});

describe('Was sich NICHT ändern darf', () => {
  it('oos_trades und fee_share sind zinsfrei: identische Werte mit und ohne Zinsreihe', () => {
    const roh = lauf(LAUF48);
    const mit = lauf(LAUF48, { riskFree: riskFree() });
    for (const name of ['oos_trades', 'fee_share']) {
      expect(mit.gate(name).value, name).toEqual(roh.gate(name).value);
      expect(mit.gate(name).threshold, name).toEqual(roh.gate(name).threshold);
      expect(mit.gate(name).pass, name).toEqual(roh.gate(name).pass);
    }
    // Und die Notiz sagt, warum: Gebühren und Bruttogewinn stammen aus TRADES.
    expect(mit.gate('fee_share').note).toContain('zinsfrei');
  });

  it('ohne Zinsreihe ist alles bitgleich zur Rechnung von vorher', () => {
    const r = lauf(LAUF48);
    expect(r.gate('fold_positive_share').value).toBe(r.wfa.oos.positiveFoldShare);
    expect(r.gate('oos_net_profit').value).toBe(r.wfa.oos.netProfit);
    expect(r.gate('fold_concentration').value!).toBeCloseTo(Math.max(...r.wfa.folds.map((f) => f.best.oosMetrics.netProfit)) / r.wfa.oos.netProfit, 12);
  });

  it('die Umstellung macht kein einziges Gate leichter', () => {
    const roh = lauf(LAUF48);
    const mit = lauf(LAUF48, { riskFree: riskFree() });
    for (const g of roh.gates) {
      const m = mit.gate(g.name);
      if (g.pass) continue;
      expect(m.pass, `${g.name} war rot und darf durch den Zins nicht grün werden`).toBe(false);
    }
    expect(mit.durchgefallen.length).toBeGreaterThanOrEqual(roh.durchgefallen.length);
  });
});

describe('Die Rechnung wird geprüft, nicht geglaubt', () => {
  it('passt die Fold-Kette nicht zur OOS-Kette, gibt es KEINE Überschusszahl — und die Notiz nennt den Grund', () => {
    const wfa = wfaAus(LAUF48);
    // Eine Kette, die länger ist als die Summe der Folds: genau die Lage, in
    // der ein Schnitt die Zinsreihe um Tage verschieben würde.
    wfa.oos.dailyReturns = [...wfa.oos.dailyReturns, RF_TAG];
    const psr = probabilisticSharpeOos({ wfa, metricsFns: fakeMetricsFns });
    const g = robustnessGates({
      wfa,
      optimizer: cfg.optimizer,
      stressOos: { netProfit: 1, objectiveMedian: 0.8 },
      neighborhood: { medianObjective: 0.8, bestObjective: 1, positiveShare: 0.75 },
      dsr,
      psr,
      metricsFns: fakeMetricsFns,
      periodsPerYear: 252,
      fixed: true,
      initialEquity: E0,
      riskFree: riskFree({ strategie: [...zinsReihe, RF_TAG] }),
    }).gates.find((x) => x.name === 'fold_positive_share')!;
    expect(g.note).toContain('Maßstab: rohes Netto —');
    expect(g.note).toContain('ergeben nicht die OOS-Kette');
  });

  it('passt das aufgezinste Netto nicht zur Kennzahl des Folds, wird die Reihe verworfen', () => {
    const wfa = wfaAus(LAUF48);
    // Ein Fold, dessen gemeldetes Netto nicht zu seinen Renditen passt: Die
    // Renditereihe gehört dann nicht zu diesem Fenster, und jede Zahl daraus
    // sähe plausibel aus.
    wfa.folds[3]!.best.oosMetrics = { ...wfa.folds[3]!.best.oosMetrics, netProfit: 99_999 };
    const k = ueberschussKette({ wfa, riskFree: zinsReihe, initialEquity: E0 });
    expect('fehler' in k && k.fehler).toContain('Renditereihe passt nicht zum Netto');
  });

  it('ohne Startkapital gibt es keinen Überschuss in Geld — geraten wird nichts', () => {
    const r = lauf(LAUF48, { riskFree: riskFree(), initialEquity: undefined });
    expect(r.gate('oos_net_profit').value).toBe(r.wfa.oos.netProfit);
    expect(r.gate('oos_net_profit').note).toContain('kein Startkapital übergeben');
  });
});
