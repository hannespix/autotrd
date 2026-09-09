/**
 * Basis-Allokation — die zweite Latte, ganz im Code (Prüfbefund K1, K2, M6,
 * 09.09.2026): Ein Festkandidat mit `tier: basis` wird in EINER durchgehenden
 * Simulation über die OOS-Kette gemessen und an der Gate-Gruppe `basis`
 * gegen den liegengelassenen Korb geprüft — nie an den zehn Alpha-Gates, nie
 * als Alpha-Champion.
 *
 * Was diese Tests festhalten:
 *  (a) Schema: `tier` fällt auf alpha zurück, `optimizer.basis` trägt die
 *      vorregistrierten Schwellen; höchstens ein Basis-Kandidat.
 *  (b) Die durchgehende Simulation nutzt GENAU eine Range vom ersten
 *      oosStart bis zum letzten oosEnd (plus Stress und Holdout) — keine
 *      IS-Ranges, keine Fold-Fenster (Spion auf simulate).
 *  (c) Die Fold-Scheiben aus der einen Kurve summieren sich zum Kettennetto —
 *      für Basis, Korb und SPY.
 *  (d) Jedes der vier Gates einmal rot und einmal grün.
 *  (e) WÄCHTER (K2): Eine Basis, die die halbe Zeit in Kasse steht und
 *      deshalb einen kleinen rohen MaxDD hat, fällt bei `basis_drawdown`
 *      durch, wenn ihr exposure-normierter MaxDD nicht ≤ 0,75 × Korb ist.
 *  (f) WÄCHTER: Ein Basis-Kandidat wird nie Alpha-Champion und erscheint
 *      nicht in der Alpha-Tabelle — auch wenn er alles besteht.
 *  (g) Champion-Datei: `basis`-Block geschrieben, gelesen, bei stay_notrade
 *      behalten, ohne Basis-Kandidat geräumt; alte Datei ohne Block lädt.
 *  (h) Korb je Fold ⇒ klarer Fehler, keine Basis.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { ConfigError, parseConfig, type OptimizerInput } from '../../src/core/config.ts';
import { Journal, homePaths } from '../../src/core/journal.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike, EquityPoint, SimResult, Strategy, Trade } from '../../src/core/types.ts';
import { emptyChampionFile, loadChampion, saveChampion } from '../../src/optimize/promote.ts';
import { basisGates, type BasisGateInput } from '../../src/optimize/robustness.ts';
import { nichtsGemessen, runOptimization, type OptimizeRunInput } from '../../src/optimize/run.ts';
import { basisKennzahlen, basisScheiben, basisSimulation, foldPlanForBars, handelstageZwischen, type SimulateFn } from '../../src/optimize/walkForward.ts';
import { NOISE_PROFILE, REWARD_PROFILE, T0, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig, type FakeSimOptions } from './fakes.ts';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const tag = (i: number, c: number): Bar => ({ t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1_000 });
/** Korb mit Auf und Ab: Der liegengelassene Korb hat einen Drawdown (≈ 18 %) und einen rechenbaren Sharpe. */
const zickzack = BarSeries.from(Array.from({ length: 400 }, (_, i) => tag(i, 100 + 10 * Math.sin(i / 5))));
/** Dasselbe mit Umsatz, den die Universumswahl (Korb je Fold) als liquide gelten lässt. */
const liquide = BarSeries.from(Array.from({ length: 400 }, (_, i) => ({ ...tag(i, 100 + 10 * Math.sin(i / 5)), v: 1_000_000 })));

/** Die Basis trägt eine eigene Strategie-ID, damit der Spion ihre Simulationsaufrufe von den gesuchten trennen kann. */
const BASIS_PROFILE: FakeSimOptions = { ...REWARD_PROFILE, exposure: 0.8 };
const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), noise: fakeStrategy('noise'), basisS: fakeStrategy('basisS') };
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE, basisS: BASIS_PROFILE };
const getStrategy = (id: string): Strategy => {
  const s = strategies[id];
  if (!s) throw new Error(`unbekannte Strategie ${id}`);
  return s;
};
const BASIS = { strategy: 'basisS', params: { a: 10, b: 2 }, label: 'Basis V2', tier: 'basis' as const };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'autotrd-basis-'));
  dirs.push(d);
  return d;
};

function input(
  home: string,
  over: Partial<OptimizeRunInput> & { symbols?: string[]; strategies?: string[]; optimizer?: Partial<OptimizerInput>; bars?: BarSeriesLike; benchmark?: BarSeriesLike; candidates?: string[] } = {},
): OptimizeRunInput {
  const symbols = over.symbols ?? ['AAA'];
  const { optimizer, bars, benchmark, candidates, ...rest } = over;
  const cfg = testConfig({
    symbols,
    home,
    optimizer: { seed: 7, fixedCandidates: [BASIS], ...optimizer },
    ...(benchmark ? { benchmark: 'BENCH' } : {}),
    ...(candidates ? { candidates, maxSymbols: 3 } : {}),
  });
  const serie = bars ?? zickzack;
  return {
    config: cfg,
    symbols,
    strategies: over.strategies ?? ['noise'],
    barsFor: () => serie,
    ...(benchmark ? { benchmark } : {}),
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
    ...rest,
  };
}

const gateOf = (gates: readonly { name: string; pass: boolean; value: number | null; threshold: number | null; note: string }[], name: string) => {
  const g = gates.find((x) => x.name === name);
  if (!g) throw new Error(`Gate ${name} fehlt`);
  return g;
};

/* ───────────────────────── (a) Schema ───────────────────────── */

describe('(a) Schema: tier und optimizer.basis', () => {
  it('tier fällt auf alpha zurück; optimizer.basis trägt die vorregistrierten Schwellen', () => {
    const cfg = parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { fixedCandidates: [{ strategy: 'edge' }, { strategy: 'edge', tier: 'basis', label: 'B' }] } });
    expect(cfg.optimizer.fixedCandidates.map((fc) => fc.tier)).toEqual(['alpha', 'basis']);
    expect(cfg.optimizer.basis).toEqual({ minDrawdownReduction: 0.25, minSharpeRatio: 0.9, maxCostShare: 0.1 });
    expect(testConfig().optimizer.basis).toEqual({ minDrawdownReduction: 0.25, minSharpeRatio: 0.9, maxCostShare: 0.1 });
    const eigene = parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { basis: { minDrawdownReduction: 0.5 } } });
    expect(eigene.optimizer.basis).toEqual({ minDrawdownReduction: 0.5, minSharpeRatio: 0.9, maxCostShare: 0.1 });
  });

  it('unbekannte Stufe und Schwellen außerhalb [0, 1] sind Config-Fehler', () => {
    expect(() => parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { fixedCandidates: [{ strategy: 'edge', tier: 'gold' }] } })).toThrow(/tier/);
    expect(() => parseConfig({ universe: { symbols: ['AAA'] }, optimizer: { basis: { minDrawdownReduction: 1.5 } } })).toThrow(/minDrawdownReduction/);
  });

  it('höchstens EIN Basis-Kandidat — zwei wären eine Suche durch die Hintertür', () => {
    const zwei = { universe: { symbols: ['AAA'] }, optimizer: { fixedCandidates: [{ strategy: 'edge', tier: 'basis' }, { strategy: 'noise', tier: 'basis' }] } };
    expect(() => parseConfig(zwei)).toThrow(ConfigError);
    expect(() => parseConfig(zwei)).toThrow(/höchstens EIN Festkandidat mit tier: basis/);
  });
});

/* ───────────────────────── (b) Eine Range ───────────────────────── */

describe('(b) durchgehende Simulation: genau eine Range vom ersten oosStart bis zum letzten oosEnd', () => {
  it('Spion: drei Aufrufe der Basis-Strategie — Kette, Kette bei Stress, Holdout; keine IS-Range, kein Fold-Fenster', () => {
    const home = tmp();
    const sim = makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE);
    const out = runOptimization(input(home, { simulate: sim }));
    const r = out.runs[0]!;
    expect(r.errors).toEqual([]);
    expect(r.basis).toBeDefined();
    const plan = foldPlanForBars(zickzack, testConfig().optimizer);
    const first = plan.folds[0]!;
    const last = plan.folds[plan.folds.length - 1]!;
    const kette = { start: first.oosStart, end: last.oosEnd };
    expect(r.basis!.range).toEqual(kette);
    expect(r.basis!.kennzahlen.days).toBe(8 * 30);

    const calls = sim.calls.filter((c) => c.strategyId === 'basisS');
    expect(calls.map((c) => [c.range, c.costMultiplier])).toEqual([
      [kette, 1],
      [kette, 1.5],
      [{ start: plan.holdout!.start, end: plan.holdout!.end }, 1],
    ]);
    // Kein Aufruf der Basis auf einem IS-Fenster oder einem einzelnen OOS-Fold.
    for (const c of calls) {
      for (const f of plan.folds) {
        expect(c.range).not.toEqual({ start: f.isStart, end: f.isEnd });
        expect(c.range).not.toEqual({ start: f.oosStart, end: f.oosEnd });
      }
    }
    // Die gesuchte Strategie läuft weiter in Folds — die Basis hat das nicht geändert.
    expect(sim.calls.filter((c) => c.strategyId === 'noise' && c.range?.start === first.oosStart && c.range.end === first.oosEnd).length).toBeGreaterThan(0);
    // Die Range ist der Bericht: die Kette des Fold-Plans, Positionen über Fold-Grenzen.
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('### AAA · Basis-Allokation (Festkandidat, durchgehende Simulation)');
    expect(text).toContain(`EIN Simulationslauf ${new Date(kette.start).toISOString().slice(0, 10)} … ${new Date(kette.end).toISOString().slice(0, 10)}`);
  });

  it('basisSimulation direkt: Warmup ist alles vor der Range — der Simulator bekommt die ganze Serie, entscheidet ab oosStart des ersten Folds', () => {
    const cfg = testConfig();
    const sim = makeFakeSimulate(BASIS_PROFILE);
    const b = basisSimulation({
      symbol: 'AAA',
      strategy: strategies.basisS!,
      params: { a: 10, b: 2 },
      bars: zickzack,
      config: simConfigOf(cfg),
      initialEquity: 10_000,
      simulate: sim,
      optimizer: cfg.optimizer,
      sharpeRatio: fakeMetricsFns.sharpeRatio,
      periodsPerYear: 365,
    });
    const plan = foldPlanForBars(zickzack, cfg.optimizer);
    expect(b.range).toEqual({ start: plan.folds[0]!.oosStart, end: plan.folds[plan.folds.length - 1]!.oosEnd });
    expect(b.folds.length).toBe(plan.folds.length);
    // Ein Trade je Bar in der Range: 240 Bars ⇒ 240 Trades, nichts vor der Range.
    expect(b.result.trades.length).toBe(240);
    expect(b.result.trades.every((t) => t.entryTime >= b.range.start && t.entryTime < b.range.end)).toBe(true);
    expect(b.kennzahlen.trades).toBe(240);
    expect(b.kennzahlen.tradesPerMonth).toBeCloseTo(240 / (240 / 30.44), 9);
    expect(b.kennzahlen.avgExposure).toBeCloseTo(0.8, 12);
    expect(b.kennzahlen.exposureNormMaxDD).toBeCloseTo(b.kennzahlen.maxDrawdownPct / 0.8, 9);
    expect(b.holdout!.start).toBe(plan.holdout!.start);
    expect(b.dataRange).toEqual({ start: zickzack.t[0]!, end: zickzack.t[399]! + 1 });
  });
});

/* ───────────────────────── (c) Scheiben ───────────────────────── */

describe('(c) Scheiben aus der einen Kurve summieren sich zum Kettennetto', () => {
  it('Basis, Korb und SPY: Σ Scheiben = Netto der Range; Scheiben decken genau die Folds', () => {
    const home = tmp();
    const bench = BarSeries.from(Array.from({ length: 400 }, (_, i) => tag(i, 50 + i * 0.1 + 3 * Math.sin(i / 7))));
    const out = runOptimization(input(home, { benchmark: bench }));
    const b = out.runs[0]!.basis!;
    const plan = foldPlanForBars(zickzack, testConfig().optimizer);
    expect(b.scheiben.map((s) => s.fold)).toEqual(plan.folds);
    const summe = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    expect(summe(b.scheiben.map((s) => s.basis))).toBeCloseTo(b.kennzahlen.netProfit, 6);
    expect(b.korb).not.toBeNull();
    expect(b.scheiben.every((s) => s.korb !== null && s.spy !== null)).toBe(true);
    expect(summe(b.scheiben.map((s) => s.korb))).toBeCloseTo((10_000 * b.korb!.netReturnPct) / 100, 6);
    expect(b.spy!.symbol).toBe('BENCH');
    expect(summe(b.scheiben.map((s) => s.spy))).toBeCloseTo((10_000 * b.spy!.bezug!.netReturnPct) / 100, 6);
    expect(b.positiveScheibenShare).toBeCloseTo(b.scheiben.filter((s) => s.basis > 0).length / b.scheiben.length, 12);
    // Der Bericht trägt die Scheiben-Tabelle mit allen drei Spalten.
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('| Fold-Scheibe | Netto Basis | Netto Korb | Netto BENCH |');
    expect(text.split('\n').filter((l) => /^\| \d+: \d{4}-\d{2}-\d{2} … \d{4}-\d{2}-\d{2} \| [+-]/.test(l)).length).toBe(plan.folds.length);
  });

  it('basisScheiben: telescopisch, auch bei unsortierter Kurve und Scheiben ohne Punkte', () => {
    const f = (k: number, start: number, end: number) => ({ index: k, isStart: start - 10, isEnd: start, oosStart: start, oosEnd: end });
    const folds = [f(0, 10, 20), f(1, 20, 30), f(2, 30, 40)];
    // Punkte nur in Scheibe 1 und 3; Scheibe 2 leer ⇒ 0, Summe = letzter Stand − Start.
    const kurve: EquityPoint[] = [
      { t: 35, equity: 1_300 },
      { t: 12, equity: 1_050 },
      { t: 18, equity: 1_100 },
    ];
    const sch = basisScheiben(kurve, folds, 1_000);
    expect(sch.map((s) => s.netProfit)).toEqual([100, 0, 200]);
    expect(sch.reduce((s, x) => s + x.netProfit, 0)).toBe(300);
  });
});

/* ───────────────────────── (d) Gates rot und grün ───────────────────────── */

describe('(d) basisGates: jedes Gate einmal rot, einmal grün', () => {
  const gruen: BasisGateInput = {
    basis: { minDrawdownReduction: 0.25, minSharpeRatio: 0.9, maxCostShare: 0.1 },
    stressCostMultiplier: 1.5,
    kennzahlen: { netProfit: 1_000, stressNetProfit: 900, sharpe: 1.0, maxDrawdownPct: 8, avgExposure: 0.8, exposureNormMaxDD: 10, fees: 50 },
    korb: { sharpe: 1.0, maxDrawdownPct: 20 },
  };
  const mit = (k: Partial<BasisGateInput['kennzahlen']>, korb: BasisGateInput['korb'] = gruen.korb) => basisGates({ ...gruen, kennzahlen: { ...gruen.kennzahlen, ...k }, korb });

  it('alles grün: vier Gates, alle bestanden, in fester Reihenfolge', () => {
    const g = basisGates(gruen);
    expect(g.gates.map((x) => x.name)).toEqual(['basis_net_profit', 'basis_drawdown', 'basis_sharpe', 'basis_costs']);
    expect(g.gates.every((x) => x.pass)).toBe(true);
    expect(g.pass).toBe(true);
  });

  it('basis_net_profit: Netto > 0 UND Stress-Netto > 0', () => {
    expect(gateOf(mit({ netProfit: 1_000, stressNetProfit: 1 }).gates, 'basis_net_profit').pass).toBe(true);
    expect(gateOf(mit({ netProfit: -1 }).gates, 'basis_net_profit').pass).toBe(false);
    // Bei Idealkosten positiv, bei Stress negativ ⇒ rot — das Stress-Netto ist Teil des Gates.
    const g = mit({ netProfit: 1_000, stressNetProfit: -5 });
    expect(gateOf(g.gates, 'basis_net_profit').pass).toBe(false);
    expect(gateOf(g.gates, 'basis_net_profit').note).toContain('bei Kosten ×1.5: -5.00');
    expect(g.pass).toBe(false);
  });

  it('basis_drawdown: MaxDD/Exposure ≤ (1 − 0,25) × Korb-MaxDD; Schwelle steht am Gate', () => {
    const ok = gateOf(mit({ exposureNormMaxDD: 15 }).gates, 'basis_drawdown');
    expect(ok.pass).toBe(true);
    expect(ok.threshold).toBeCloseTo(15, 12);
    expect(ok.value).toBe(15);
    expect(gateOf(mit({ exposureNormMaxDD: 15.01 }).gates, 'basis_drawdown').pass).toBe(false);
    // Ohne Exposure (Fake ohne Kurve) oder Exposure 0: nicht bewertbar, nie bestanden.
    const ohne = gateOf(mit({ avgExposure: null, exposureNormMaxDD: null }).gates, 'basis_drawdown');
    expect(ohne.pass).toBe(false);
    expect(ohne.note).toMatch(/nicht bewertbar \(mittlere Exposure unbekannt\)/);
    const kasse = gateOf(mit({ avgExposure: 0, exposureNormMaxDD: null, maxDrawdownPct: 0 }).gates, 'basis_drawdown');
    expect(kasse.pass).toBe(false);
    expect(kasse.note).toMatch(/nicht bewertbar \(mittlere Exposure 0\)/);
    // Ohne Korb-Kurse gibt es keine Latte — und keine vakante Latte.
    const ohneKorb = mit({}, null);
    expect(gateOf(ohneKorb.gates, 'basis_drawdown').pass).toBe(false);
    expect(gateOf(ohneKorb.gates, 'basis_sharpe').pass).toBe(false);
    expect(ohneKorb.pass).toBe(false);
  });

  it('basis_sharpe: ≥ 0,9 × Korb-Sharpe; Korb ≤ 0 oder nicht berechenbar ⇒ Basis > 0 genügt, die Notiz sagt es', () => {
    expect(gateOf(mit({ sharpe: 0.9 }).gates, 'basis_sharpe').pass).toBe(true);
    expect(gateOf(mit({ sharpe: 0.89 }).gates, 'basis_sharpe').pass).toBe(false);
    const negKorb = gateOf(mit({ sharpe: 0.05 }, { sharpe: -0.3, maxDrawdownPct: 20 }).gates, 'basis_sharpe');
    expect(negKorb.pass).toBe(true);
    expect(negKorb.threshold).toBe(0);
    expect(negKorb.note).toContain('setzt keine Latte');
    expect(gateOf(mit({ sharpe: 0 }, { sharpe: -0.3, maxDrawdownPct: 20 }).gates, 'basis_sharpe').pass).toBe(false);
    const nullKorb = gateOf(mit({ sharpe: 0.05 }, { sharpe: null, maxDrawdownPct: 20 }).gates, 'basis_sharpe');
    expect(nullKorb.pass).toBe(true);
    expect(nullKorb.note).toContain('nicht berechenbar');
    expect(gateOf(mit({ sharpe: null }).gates, 'basis_sharpe').pass).toBe(false);
  });

  it('basis_costs: Gebühren / |Netto| ≤ 0,10; Netto 0 ⇒ nicht bestanden', () => {
    expect(gateOf(mit({ fees: 100, netProfit: 1_000 }).gates, 'basis_costs').pass).toBe(true);
    expect(gateOf(mit({ fees: 100.01, netProfit: 1_000 }).gates, 'basis_costs').pass).toBe(false);
    const nullNetto = gateOf(mit({ fees: 0, netProfit: 0, stressNetProfit: 0 }).gates, 'basis_costs');
    expect(nullNetto.pass).toBe(false);
    expect(nullNetto.value).toBeNull();
    // Negatives Netto: Der Betrag zählt — das Gate misst Kosten, das Vorzeichen prüft basis_net_profit.
    expect(gateOf(mit({ fees: 50, netProfit: -1_000 }).gates, 'basis_costs').pass).toBe(true);
  });
});

/* ───────────────────────── (e) WÄCHTER K2 ───────────────────────── */

describe('(e) WÄCHTER K2: halb in Kasse ⇒ kleiner roher MaxDD, aber je Einheit Exposure gemessen', () => {
  it('Gate: roher MaxDD 10 % gegen Korb 24 % sähe gut aus — bei Exposure 0,5 sind es 20 % > 18 %: durchgefallen; bei Exposure 1,0 bestanden', () => {
    const basis = { minDrawdownReduction: 0.25, minSharpeRatio: 0.9, maxCostShare: 0.1 };
    const k = { netProfit: 1_000, stressNetProfit: 900, sharpe: 1.2, maxDrawdownPct: 10, fees: 20 };
    const korb = { sharpe: 0.8, maxDrawdownPct: 24 };
    const halb = basisGates({ basis, stressCostMultiplier: 1.5, kennzahlen: { ...k, avgExposure: 0.5, exposureNormMaxDD: 10 / 0.5 }, korb });
    const dd = gateOf(halb.gates, 'basis_drawdown');
    expect(dd.pass).toBe(false);
    expect(dd.value).toBeCloseTo(20, 12);
    expect(dd.threshold).toBeCloseTo(18, 12);
    expect(dd.note).toContain('MaxDD 10.00 % / mittlere Exposure 50.0 % = 20.00 %');
    expect(halb.pass).toBe(false);
    const voll = basisGates({ basis, stressCostMultiplier: 1.5, kennzahlen: { ...k, avgExposure: 1, exposureNormMaxDD: 10 }, korb });
    expect(gateOf(voll.gates, 'basis_drawdown').pass).toBe(true);
    expect(voll.pass).toBe(true);
  });

  it('Kennzahlen: die Normierung kommt aus der Equity-Kurve — halbe Exposure verdoppelt den MaxDD je Einheit', () => {
    const achse = dailyBars(10);
    const kurve = (exposure: number): SimResult => {
      const eq = [100, 110, 99, 105, 120].map((e, i) => ({ t: T0 + i * DAY, equity: e * 100, exposure }));
      return {
        trades: [],
        equity: eq,
        dailyReturns: [0.1, -0.1, 0.06, 0.14],
        metrics: { netProfit: 2_000, netReturnPct: 20, cagrPct: null, sharpe: 1, sortino: 1, maxDrawdownPct: 10, profitFactor: null, winRatePct: null, expectancy: null, avgR: null, trades: 0, exposurePct: 100, feeShare: null, days: 5 },
        finalEquity: 12_000,
        notes: [],
      };
    };
    const args = { stressNetProfit: 1_900, range: { start: T0, end: T0 + 5 * DAY }, achse, assetClass: 'crypto' as const, sharpeRatio: fakeMetricsFns.sharpeRatio, periodsPerYear: 365 };
    const halb = basisKennzahlen({ ...args, result: kurve(0.5) });
    const voll = basisKennzahlen({ ...args, result: kurve(1) });
    expect(halb.avgExposure).toBe(0.5);
    expect(halb.exposureNormMaxDD).toBeCloseTo(20, 12);
    expect(voll.exposureNormMaxDD).toBeCloseTo(10, 12);
    expect(halb.maxDrawdownPct).toBe(voll.maxDrawdownPct);
    // Ohne Exposure-Angabe: null — und damit „nicht bewertbar", nie bestanden.
    const ohne = basisKennzahlen({ ...args, result: { ...kurve(1), equity: kurve(1).equity.map(({ t, equity }) => ({ t, equity })) } });
    expect(ohne.avgExposure).toBeNull();
    expect(ohne.exposureNormMaxDD).toBeNull();
    expect(ohne.flatDaysShare).toBeNull();
  });

  it('Ende-zu-Ende: dieselbe Kurve, einmal mit Exposure 0,5, einmal mit 1,0 — nur die volle besteht basis_drawdown', () => {
    // Korb: 100 → 125 → 95 ⇒ MaxDD 24 %, Latte 18 %.
    const closes = Array.from({ length: 400 }, (_, i) => (i < 200 ? 100 : i < 300 ? 125 : 95));
    const korb = BarSeries.from(closes.map((c, i) => tag(i, c)));
    const gebaut = (exposure: number): SimulateFn => (inp) => {
      const start = inp.range?.start ?? T0;
      const end = inp.range?.end ?? T0 + 400 * DAY;
      const equity: EquityPoint[] = [];
      const trades: Trade[] = [];
      const dailyReturns: number[] = [];
      let prev = inp.initialEquity;
      let i = 0;
      // Verlauf: +5 %, dann −10 % vom Hoch, dann Erholung auf +10 % — roher MaxDD 10 %.
      for (let t = start; t < end; t += DAY, i++) {
        const faktor = i < 30 ? 1.05 : i < 60 ? 0.945 : 1.1;
        const eq = inp.initialEquity * faktor;
        equity.push({ t, equity: eq, exposure });
        dailyReturns.push(eq / prev - 1);
        prev = eq;
        if (i % 40 === 0) {
          trades.push({ symbol: 'AAA', side: 'long', qty: 1, entryTime: t, entryPrice: 100, exitTime: t + DAY, exitPrice: 101, grossPnl: 10, fees: 1, netPnl: 9, rMultiple: null, exitReason: 'signal', strategy: 'basisS', barsHeld: 1, mae: null, mfe: null });
        }
      }
      const fin = equity[equity.length - 1]!.equity;
      return {
        trades,
        equity,
        dailyReturns,
        metrics: { netProfit: fin - inp.initialEquity, netReturnPct: (fin / inp.initialEquity - 1) * 100, cagrPct: null, sharpe: 1, sortino: 1, maxDrawdownPct: 10, profitFactor: null, winRatePct: null, expectancy: null, avgR: null, trades: trades.length, exposurePct: 100, feeShare: null, days: i },
        finalEquity: fin,
        notes: [],
      };
    };
    const lauf = (exposure: number) => {
      const home = tmp();
      const out = runOptimization(input(home, { bars: korb, strategies: [], simulate: gebaut(exposure) }));
      return out.runs[0]!;
    };
    const halb = lauf(0.5);
    const voll = lauf(1);
    expect(halb.basis!.korb!.maxDrawdownPct).toBeCloseTo(24, 9);
    expect(halb.basis!.kennzahlen.maxDrawdownPct).toBe(10);
    expect(gateOf(halb.basis!.gates, 'basis_drawdown').pass).toBe(false);
    expect(gateOf(halb.basis!.gates, 'basis_drawdown').value).toBeCloseTo(20, 9);
    expect(gateOf(voll.basis!.gates, 'basis_drawdown').pass).toBe(true);
    expect(gateOf(voll.basis!.gates, 'basis_drawdown').value).toBeCloseTo(10, 9);
    // Beide bestehen das Netto-Gate — der Unterschied ist allein die Exposure.
    expect(gateOf(halb.basis!.gates, 'basis_net_profit').pass).toBe(true);
    expect(halb.basis!.pass).toBe(false);
    expect(halb.basis!.kennzahlen.flatDaysShare).toBe(0);
  });
});

/* ───────────────────────── (f) WÄCHTER: nie Alpha-Champion ───────────────────────── */

describe('(f) WÄCHTER: ein Basis-Kandidat wird nie Alpha-Champion und steht nicht in der Alpha-Tabelle', () => {
  it('Basis besteht ihre Latte, die gesuchte Strategie fällt ⇒ stay_notrade, symbols leer, basis.pass true', () => {
    const home = tmp();
    const logs: string[] = [];
    const out = runOptimization(input(home, { log: (m) => logs.push(m) }));
    const r = out.runs[0]!;
    expect(r.errors).toEqual([]);
    // Nicht in der Alpha-Liste, nicht gewählt, nicht befördert — obwohl die Kante des Fakes jedes Alpha-Gate bestünde.
    expect(r.results.map((s) => s.strategyId)).toEqual(['noise']);
    expect(r.results.some((s) => s.strategyId === 'basisS' || s.label === 'Basis V2')).toBe(false);
    expect(r.decision.action).toBe('stay_notrade');
    expect(r.chosen).toBeNull();
    expect(out.champion.symbols).toEqual({});
    expect(Object.keys(out.champion.noTrade)).toEqual(['AAA']);
    // … aber gemessen und bestanden, als eigener Block.
    expect(r.basis!.pass).toBe(true);
    expect(r.basis!.gates.map((g) => g.name)).toEqual(['basis_net_profit', 'basis_drawdown', 'basis_sharpe', 'basis_costs']);
    expect(out.champion.basis).toMatchObject({ version: 1, strategy: 'basisS', params: { a: 10, b: 2 }, symbols: ['AAA'], label: 'Basis V2', timeframe: 1440, pass: true, measuredAt: NOW });
    expect(logs.some((m) => /basisS · Basis: Basis V2: Basis-Latte bestanden/.test(m))).toBe(true);

    const text = readFileSync(out.reportPath, 'utf8');
    // Zusammenfassungstabelle: nur die gesuchte Strategie; eigene Basis-Zeile darunter.
    const zusammenfassung = text.slice(text.indexOf('## Zusammenfassung'), text.indexOf('## AAA'));
    expect(zusammenfassung).toContain('| AAA | stay_notrade | — (kein Handel) |');
    expect(zusammenfassung).not.toMatch(/\| AAA \| promote/);
    expect(zusammenfassung).toContain('Basis AAA: Basis V2 — bestanden');
    // Alpha-Tabelle des Symbols ohne die Basis; die Basis hat ihren eigenen Abschnitt mit der Gate-Gruppe.
    const alphaTabelle = text.slice(text.indexOf('## AAA'), text.indexOf('**Entscheidung: stay_notrade**'));
    expect(alphaTabelle).toContain('| noise |');
    expect(alphaTabelle).not.toContain('basisS');
    expect(text).toContain('### AAA · Basis-Allokation (Festkandidat, durchgehende Simulation)');
    expect(text).toContain('**Basis-Latte: bestanden**');
    expect(text).toMatch(/\| basis_net_profit \| ✔ \|/);
    expect(text).toMatch(/\| basis_drawdown \| ✔ \|/);
    expect(text).toContain('Korb liegenlassen (1 Symbol, gleichgewichtet, ohne Kosten) — der Maßstab');
    expect(text).toContain('mittlere Exposure 80.0 %');
    expect(text).toContain('- Basis-Allokation (Festkandidat tier: basis, EINE durchgehende Simulation über die OOS-Kette, nie Alpha-Champion): basisS {"a":10,"b":2} „Basis V2"');
  });

  it('auch wenn KEINE gesuchte Strategie läuft: Basis allein ist eine Messung, aber kein Champion', () => {
    const home = tmp();
    const out = runOptimization(input(home, { strategies: [] }));
    const r = out.runs[0]!;
    expect(r.results).toEqual([]);
    expect(r.decision.action).toBe('stay_notrade');
    expect(out.champion.symbols).toEqual({});
    expect(out.champion.basis?.pass).toBe(true);
    expect(nichtsGemessen(out.runs)).toBe(false); // gemessen wurde — nur eben keine Alpha-Kante
  });

  it('gepoolt: der Korb ist die Einheit — basis.symbols trägt alle Symbole, der Maßstab alle Kurse', () => {
    const home = tmp();
    const out = runOptimization(input(home, { symbols: ['AAA', 'BBB'], optimizer: { pooled: true } }));
    const r = out.runs[0]!;
    expect(r.errors).toEqual([]);
    expect(r.basis!.korb!.symbole).toBe(2);
    expect(out.champion.basis!.symbols).toEqual(['AAA', 'BBB']);
    expect(out.champion.symbols).toEqual({});
  });

  it('ungepoolt mit mehreren Symbolen: mehrere Einheiten, ein Block — klarer Fehler, keine Basis', () => {
    const home = tmp();
    const out = runOptimization(input(home, { symbols: ['AAA', 'BBB'] }));
    for (const r of out.runs) {
      expect(r.basis).toBeUndefined();
      expect(r.errors.some((e) => /Basis nur auf EINER Einheit/.test(e))).toBe(true);
    }
    expect(out.champion.basis).toBeUndefined();
  });

  it('ungültige Parameter des Basis-Kandidaten: Fehler-Eintrag, keine Basis, der Alpha-Pfad läuft weiter', () => {
    const home = tmp();
    const out = runOptimization(input(home, { strategies: ['edge'], optimizer: { fixedCandidates: [{ ...BASIS, params: { a: 99 } }] } }));
    const r = out.runs[0]!;
    expect(r.basis).toBeUndefined();
    expect(r.errors).toEqual(['basisS · Basis: Basis V2: Parameter ungültig: "a" = 99 außerhalb [0, 10]']);
    expect(r.decision.action).toBe('promote');
    expect(out.champion.basis).toBeUndefined();
    expect(readFileSync(out.reportPath, 'utf8')).toContain('Basis AAA: Basis V2 — nicht gemessen (siehe Fehler unter AAA)');
  });
});

/* ───────────────────────── (g) Champion-Datei ───────────────────────── */

describe('(g) Champion-Datei: basis-Block geschrieben, gelesen, behalten, geräumt', () => {
  it('geschrieben mit Urteil und Gates; loadChampion liest ihn zurück; stay_notrade räumt ihn nicht', () => {
    const home = tmp();
    const out = runOptimization(input(home, { configCommit: 'abc1234' }));
    const paths = homePaths(home);
    const file = loadChampion(paths.champion)!;
    expect(file).toEqual(out.champion);
    expect(file.basis).toMatchObject({ version: 1, strategy: 'basisS', label: 'Basis V2', pass: true, configCommit: 'abc1234' });
    expect(file.basis!.gates.length).toBe(4);
    expect(file.noTrade.AAA).toBeDefined(); // stay_notrade im selben Lauf — und der Block steht trotzdem
    const events = new Journal(paths.journal).readAll().filter((ev) => ev.kind === 'champion');
    expect(events.map((ev) => ev.action)).toEqual(['stay_notrade', 'basis_measured']);
    expect(events[1]).toMatchObject({ symbol: 'AAA', basisPass: true, basisFailed: [], label: 'Basis V2' });
  });

  it('nicht bestanden wird ebenfalls geschrieben — pass: false, die gerissenen Gates im Journal', () => {
    const home = tmp();
    // Flacher Korb: kein Drawdown, keine Latte — die Basis mit Rauschen reißt basis_drawdown.
    const out = runOptimization(input(home, { bars: dailyBars(400) }));
    const b = out.champion.basis!;
    expect(b.pass).toBe(false);
    expect(b.gates.find((g) => g.name === 'basis_drawdown')!.pass).toBe(false);
    const ev = new Journal(homePaths(home).journal).readAll().find((e) => e.action === 'basis_measured')!;
    expect(ev.basisPass).toBe(false);
    expect(ev.basisFailed).toContain('basis_drawdown');
    expect(readFileSync(out.reportPath, 'utf8')).toMatch(/Basis AAA: Basis V2 — nicht bestanden \(basis_drawdown/);
  });

  it('kein Basis-Kandidat mehr in der Config ⇒ der Block wird geräumt (kein veralteter Block überlebt)', () => {
    const home = tmp();
    runOptimization(input(home));
    expect(loadChampion(homePaths(home).champion)!.basis).toBeDefined();
    const second = runOptimization(input(home, { optimizer: { fixedCandidates: [] }, now: () => NOW + 1 }));
    expect(second.champion.basis).toBeUndefined();
    expect(loadChampion(homePaths(home).champion)!.basis).toBeUndefined();
    const ev = new Journal(homePaths(home).journal).readAll().find((e) => e.action === 'basis_removed')!;
    expect(ev).toMatchObject({ symbol: 'AAA', basisPass: null });
    expect(String(ev.reason)).toContain('geräumt');
  });

  it('Basis konfiguriert, aber nicht messbar ⇒ der alte Block bleibt (kein Beleg dagegen), der Fehler steht im Bericht', () => {
    const home = tmp();
    runOptimization(input(home));
    const second = runOptimization(input(home, { optimizer: { fixedCandidates: [{ ...BASIS, params: { a: 99 } }] }, now: () => NOW + 1 }));
    expect(second.champion.basis).toMatchObject({ label: 'Basis V2', measuredAt: NOW });
    expect(second.runs[0]!.errors.length).toBe(1);
  });

  it('alte Datei ohne basis lädt; der Alpha-Pfad (symbols/noTrade) bleibt unverändert', () => {
    const home = tmp();
    const paths = homePaths(home);
    saveChampion(paths.champion, { ...emptyChampionFile(1), noTrade: { AAA: { reason: 'alt', decidedAt: 1, bestScore: null } } });
    const alt = loadChampion(paths.champion)!;
    expect(alt.basis).toBeUndefined();
    expect(alt.noTrade.AAA!.reason).toBe('alt');
    // Ein Lauf ohne Basis-Kandidat auf dieser Datei: kein Block, nichts geräumt, Alpha-Pfad wie immer.
    const out = runOptimization(input(home, { strategies: ['edge'], optimizer: { fixedCandidates: [] } }));
    expect(out.champion.basis).toBeUndefined();
    expect(out.champion.symbols.AAA!.strategy).toBe('edge');
    expect(out.champion.noTrade).toEqual({});
  });

  it('eine fremde Basis-Version wird nicht geraten', () => {
    const home = tmp();
    const paths = homePaths(home);
    saveChampion(paths.champion, { ...emptyChampionFile(1), basis: { version: 2 } as never });
    expect(() => loadChampion(paths.champion)).toThrow(/unbekannte Basis-Version 2/);
  });
});

/* ───────────────────────── (h) Korb je Fold ───────────────────────── */

describe('(h) Korb je Fold ⇒ Fehler, keine Basis', () => {
  it('basisSimulation wirft bei membership', () => {
    const cfg = testConfig();
    expect(() =>
      basisSimulation({
        symbol: 'AAA',
        strategy: strategies.basisS!,
        params: { a: 10, b: 2 },
        bars: new Map([['AAA', zickzack]]),
        config: simConfigOf(cfg),
        initialEquity: 10_000,
        simulate: makeFakeSimulate(BASIS_PROFILE),
        optimizer: cfg.optimizer,
        sharpeRatio: fakeMetricsFns.sharpeRatio,
        periodsPerYear: 365,
        membership: () => new Set(['AAA']),
      }),
    ).toThrow(/Basis nur auf festem Korb/);
  });

  it('im Lauf mit point_in_time und Kandidatenpool: Fehler-Eintrag, keine Basis, kein Block', () => {
    const home = tmp();
    const sim = makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE);
    const out = runOptimization(
      input(home, {
        symbols: ['AAA', 'BBB'],
        candidates: ['CCC'],
        optimizer: { pooled: true, foldMembership: 'point_in_time' },
        bars: liquide,
        candidateBarsFor: () => liquide,
        simulate: sim,
      }),
    );
    const r = out.runs[0]!;
    expect(r.korb).not.toBeNull(); // Korb je Fold ist aktiv
    expect(r.basis).toBeUndefined();
    expect(r.errors).toContain('basisS · Basis: Basis V2: Basis nur auf festem Korb: Korb je Fold ist für die durchgehende Simulation nicht zulässig — optimizer.foldMembership: fixed setzen oder den Kandidatenpool weglassen');
    expect(sim.calls.some((c) => c.strategyId === 'basisS')).toBe(false);
    expect(out.champion.basis).toBeUndefined();
  });

  it('mit foldMembership: fixed läuft die Basis trotz Kandidatenpool — auf dem festen Korb', () => {
    const home = tmp();
    const out = runOptimization(
      input(home, { symbols: ['AAA', 'BBB'], candidates: ['CCC'], optimizer: { pooled: true, foldMembership: 'fixed' }, bars: liquide, candidateBarsFor: () => liquide }),
    );
    const r = out.runs[0]!;
    expect(r.korb).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.basis!.korb!.symbole).toBe(2);
    expect(out.champion.basis!.symbols).toEqual(['AAA', 'BBB']);
  });
});

/* ───────────────────────── Haltedauer in Handelstagen ───────────────────────── */

describe('handelstageZwischen: Handelstage der Zeitachse zwischen Ein- und Ausstieg', () => {
  const achse = dailyBars(10);
  it('gleiche Bar ⇒ 0; nächste Bar ⇒ 1; Lücken der Achse zählen nicht', () => {
    expect(handelstageZwischen(achse, T0, T0, 'crypto')).toBe(0);
    expect(handelstageZwischen(achse, T0, T0 + DAY, 'crypto')).toBe(1);
    expect(handelstageZwischen(achse, T0, T0 + 5 * DAY, 'crypto')).toBe(5);
    const luecke = BarSeries.from([tag(0, 100), tag(1, 100), tag(4, 100), tag(5, 100)]);
    expect(handelstageZwischen(luecke, T0, T0 + 5 * DAY, 'crypto')).toBe(3);
  });

  it('Kennzahlen: mittlere Haltedauer aus den Trades, Tage ohne Position aus der Kurve', () => {
    const trade = (entry: number, exit: number): Trade => ({ symbol: 'AAA', side: 'long', qty: 1, entryTime: T0 + entry * DAY, entryPrice: 100, exitTime: T0 + exit * DAY, exitPrice: 100, grossPnl: 0, fees: 1, netPnl: -1, rMultiple: null, exitReason: 'signal', strategy: 's', barsHeld: exit - entry, mae: null, mfe: null });
    const equity: EquityPoint[] = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, equity: 10_000, exposure: i >= 2 && i < 6 ? 0.5 : 0 }));
    const k = basisKennzahlen({
      result: { trades: [trade(2, 6), trade(7, 9)], equity, dailyReturns: [], metrics: { netProfit: -2, netReturnPct: 0, cagrPct: null, sharpe: null, sortino: null, maxDrawdownPct: 0, profitFactor: null, winRatePct: null, expectancy: null, avgR: null, trades: 2, exposurePct: 0, feeShare: null, days: 10 }, finalEquity: 9_998, notes: ['Offen am Ende: AAA long 1 @ 100 (unrealisiert 0.00, ohne Exit-Kosten)'] },
      stressNetProfit: -3,
      range: { start: T0, end: T0 + 10 * DAY },
      achse,
      assetClass: 'crypto',
      sharpeRatio: fakeMetricsFns.sharpeRatio,
      periodsPerYear: 365,
    });
    expect(k.avgHoldingDays).toBe(3); // (4 + 2) / 2
    expect(k.flatDaysShare).toBeCloseTo(0.6, 12); // 6 von 10 Tagen ohne Position
    expect(k.avgExposure).toBeCloseTo(0.2, 12);
    expect(k.fees).toBe(2);
    expect(k.openAtEnd).toBe(1);
    expect(k.sharpe).toBeNull();
  });
});
