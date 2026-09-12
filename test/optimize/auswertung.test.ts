/**
 * Die Auswertung je Kandidat im Lauf: Exit-Anatomie, MFE/MAE, Aktivität und
 * die Korrelationsmatrix im Bericht.
 *
 * Festgehalten wird:
 *  1. Jeder Kandidat (gesucht und fest) trägt die Auswertung; ihre Trades sind
 *     DIE Trades des Walk-Forward — keine zweite Zählung.
 *  2. Der Auswertungslauf läuft auf denselben OOS-Fenstern und sieht den
 *     Holdout nicht. Kein Blick nach vorn, auch nicht für eine Messung.
 *  3. Weicht er vom Walk-Forward ab, sagt `konsistent` das laut — die Zahlen
 *     werden nicht still ausgeliefert.
 *  4. Der Bericht enthält die drei Blöcke, die Korrelationsmatrix und die
 *     Durchschnittskorrelation; „Trades je Monat" steht genau EINMAL gerechnet
 *     im Bericht (dieselbe Zahl wie in der Maßstab-Zeile).
 *  5. Kein Gate liest eine dieser Zahlen.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BarSeriesLike, SimResult, Strategy, Trade } from '../../src/core/types.ts';
import { auswertungFuer, runOptimization, type OptimizeRunInput, type StrategyRun, type SymbolRun } from '../../src/optimize/run.ts';
import { foldPlanForBars, zeitachseVon } from '../../src/optimize/walkForward.ts';
import { NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const bars = dailyBars(400);

const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), noise: fakeStrategy('noise') };
const getStrategy = (id: string): Strategy => {
  const s = strategies[id];
  if (!s) throw new Error(`unbekannte Strategie ${id}`);
  return s;
};

describe('Auswertung je Kandidat', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'autotrd-auswertung-'));
    dirs.push(d);
    return d;
  };

  const profiles = (exposure?: number): Record<string, FakeSimOptions> => ({
    edge: exposure === undefined ? REWARD_PROFILE : { ...REWARD_PROFILE, exposure },
    noise: exposure === undefined ? NOISE_PROFILE : { ...NOISE_PROFILE, exposure },
  });

  function input(home: string, over: { exposure?: number; symbols?: string[]; barsFor?: (s: string) => BarSeriesLike } = {}): OptimizeRunInput {
    const p = profiles(over.exposure);
    const symbols = over.symbols ?? ['AAA'];
    return {
      config: testConfig({ symbols, home, optimizer: { seed: 7, fixedCandidates: [{ strategy: 'edge', params: { a: 10, b: 2 }, label: 'Zehn' }] } }),
      symbols,
      strategies: ['edge', 'noise'],
      barsFor: over.barsFor ?? (() => bars),
      home,
      initialEquity: 10_000,
      simulate: makeFakeSimulate((id) => p[id] ?? NOISE_PROFILE),
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    };
  }

  it('jeder Kandidat trägt sie; Trades der Anatomie = OOS-Trades des Walk-Forward (keine zweite Zählung)', () => {
    const out = runOptimization(input(tmp()));
    const r = out.runs[0]!;
    expect(r.results.length).toBe(3);
    for (const s of r.results) {
      const a = s.auswertung;
      expect(a).not.toBeNull();
      expect(a!.konsistent).toBe(true);
      expect(a!.hinweis).toBeNull();
      expect(a!.anatomie.trades).toBe(s.wfa.oos.trades);
      expect(a!.aktivitaet.trades).toBe(s.wfa.oos.trades);
      expect(a!.anatomie.netto).toBeCloseTo(
        s.wfa.folds.reduce((sum, f) => sum + f.best.oosTrades.reduce((x, t) => x + t.netPnl, 0), 0),
        9,
      );
      expect(a!.oosDays).toBe(s.massstab.oosDays);
      expect(a!.renditen.tage.length).toBeGreaterThan(0);
      expect(a!.renditen.tage.length).toBe(a!.renditen.renditen.length);
    }
  });

  it('der Fake liefert keine Kursextreme ⇒ MFE/MAE sagt „nicht gemessen" statt 0', () => {
    const out = runOptimization(input(tmp()));
    const a = out.runs[0]!.results[0]!.auswertung!;
    expect(a.exkursion.gemessen).toBe(0);
    expect(a.exkursion.ohneDaten).toBe(a.anatomie.trades);
    expect(a.exkursion.alle.mfePct).toBeNull();
  });

  it('Exposure des Simulators landet im gebundenen Kapital; ohne Exposure bleibt es „nicht bewertbar"', () => {
    const mit = runOptimization(input(tmp(), { exposure: 0.4 })).runs[0]!.results[0]!.auswertung!;
    expect(mit.aktivitaet.mittlereExposurePct).toBeCloseTo(40, 6);
    expect(mit.aktivitaet.zeitImMarktQuelle).toBe('exposure');
    const ohne = runOptimization(input(tmp())).runs[0]!.results[0]!.auswertung!;
    expect(ohne.aktivitaet.mittlereExposurePct).toBeNull();
  });

  it('der Auswertungslauf bleibt in den OOS-Fenstern und sieht den Holdout nicht', () => {
    const home = tmp();
    const inp = input(home);
    const sim = inp.simulate as ReturnType<typeof makeFakeSimulate>;
    runOptimization(inp);
    const plan = foldPlanForBars(zeitachseVon(new Map([['AAA', bars]])), inp.config.optimizer);
    const holdout = plan.holdout!;
    // Jenseits des Holdout-Beginns darf ausschließlich der Holdout-Lauf des
    // Walk-Forward selbst liegen (je Kandidat einer, nur Bericht) — und genau
    // so viele gibt es: Der Auswertungslauf fügt keinen hinzu.
    const jenseits = sim.calls.filter((c) => c.range && c.range.end > holdout.start);
    for (const c of jenseits) expect(c.range).toEqual({ start: holdout.start, end: holdout.end });
    expect(jenseits.length).toBe(3);
    // Jedes OOS-Fenster wird mindestens zweimal gefahren: einmal im
    // Walk-Forward, einmal für die Auswertung. Mehr Fenster gibt es nicht.
    for (const f of plan.folds) {
      const treffer = sim.calls.filter((c) => c.range?.start === f.oosStart && c.range.end === f.oosEnd && c.strategyId === 'edge');
      expect(treffer.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('kein Gate liest die Auswertung — die Gate-Liste bleibt unverändert', () => {
    const out = runOptimization(input(tmp()));
    for (const s of out.runs[0]!.results) {
      const namen = s.gates.map((g) => g.name);
      for (const verboten of ['exit_anatomie', 'mfe', 'mae', 'aktivitaet', 'korrelation', 'nachlauf']) {
        expect(namen).not.toContain(verboten);
      }
    }
  });
});

describe('auswertungFuer: Abweichung des Auswertungslaufs wird laut, nicht still', () => {
  const home = mkdtempSync(join(tmpdir(), 'autotrd-auswertung-k-'));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** Ein echter Lauf, aus dem wir das WfaResult nehmen. */
  const lauf = (): StrategyRun => {
    const inp: OptimizeRunInput = {
      config: testConfig({ symbols: ['AAA'], home, optimizer: { seed: 7 } }),
      symbols: ['AAA'],
      strategies: ['edge'],
      barsFor: () => bars,
      home,
      initialEquity: 10_000,
      simulate: makeFakeSimulate(() => REWARD_PROFILE),
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    };
    return runOptimization(inp).runs[0]!.results[0]!;
  };

  const leer = (trades: number, netProfit: number): SimResult => ({
    trades: [] as Trade[],
    equity: [],
    dailyReturns: [],
    metrics: {
      netProfit,
      netReturnPct: 0,
      cagrPct: null,
      sharpe: null,
      sortino: null,
      maxDrawdownPct: 0,
      profitFactor: null,
      winRatePct: null,
      expectancy: null,
      avgR: null,
      trades,
      exposurePct: 0,
      feeShare: null,
      days: 0,
    },
    finalEquity: 10_000,
    notes: [],
  });

  it('falsche Trade-Zahl je Fold ⇒ konsistent false, Hinweis nennt den Fold', () => {
    const s = lauf();
    const teile = s.wfa.folds.map(() => leer(999, 0));
    const a = auswertungFuer({ wfa: s.wfa, teile, korb: new Map([['AAA', bars]]), initialEquity: 10_000, assetClass: 'crypto' });
    expect(a.konsistent).toBe(false);
    expect(a.hinweis).toContain('Fold 1');
    expect(a.hinweis).toContain('999');
  });

  it('fehlender Lauf ⇒ konsistent false mit eigener Begründung', () => {
    const s = lauf();
    const a = auswertungFuer({ wfa: s.wfa, teile: [], korb: new Map([['AAA', bars]]), initialEquity: 10_000, assetClass: 'crypto' });
    expect(a.konsistent).toBe(false);
    expect(a.hinweis).toContain('kein Auswertungslauf');
  });

  it('passende Läufe ⇒ konsistent; die Trades stammen weiter aus dem Walk-Forward', () => {
    const s = lauf();
    const teile = s.wfa.folds.map((f) => leer(f.best.oosMetrics.trades, f.best.oosMetrics.netProfit));
    const a = auswertungFuer({ wfa: s.wfa, teile, korb: new Map([['AAA', bars]]), initialEquity: 10_000, assetClass: 'crypto' });
    expect(a.konsistent).toBe(true);
    expect(a.anatomie.trades).toBe(s.wfa.oos.trades);
  });
});

describe('Bericht: die drei Blöcke und die Korrelationsmatrix', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'autotrd-auswertung-b-'));
    dirs.push(d);
    return d;
  };

  const lauf = (symbols: string[]): { text: string; runs: SymbolRun[] } => {
    const home = tmp();
    const out = runOptimization({
      config: testConfig({ symbols, home, optimizer: { seed: 7, pooled: false, fixedCandidates: [{ strategy: 'edge', params: { a: 10, b: 2 }, label: 'Zehn' }] } }),
      symbols,
      strategies: ['edge', 'noise'],
      barsFor: () => bars,
      home,
      initialEquity: 10_000,
      simulate: makeFakeSimulate((id) => (id === 'edge' ? { ...REWARD_PROFILE, exposure: 0.4 } : { ...NOISE_PROFILE, exposure: 0.2 })),
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    });
    return { text: readFileSync(out.reportPath, 'utf8'), runs: out.runs };
  };

  it('nennt Exit-Anatomie, MFE/MAE und Aktivität je Kandidat mit Einheiten', () => {
    const { text, runs } = lauf(['AAA']);
    const kandidaten = runs[0]!.results.length;
    expect(kandidaten).toBe(3);
    expect(text.split('**Exit-Anatomie**').length - 1).toBe(kandidaten);
    expect(text.split('**Saßen Stop und Ziel richtig?**').length - 1).toBe(kandidaten);
    expect(text.split('**Aktivität über die OOS-Kette**').length - 1).toBe(kandidaten);
    // Einheiten und Lesehilfen stehen dabei — der Bericht wird um 7 Uhr morgens gelesen.
    expect(text).toContain('Netto Σ ($)');
    expect(text).toContain('% vom Einstand');
    expect(text).toContain('Round-Trips je 30,44 Kalendertage');
    expect(text).toContain('Längste Phase ohne Einstieg');
    expect(text).toContain('Signal (Strategie sagt raus)');
    // Der Nachlauf ist ausdrücklich als Was-wäre-wenn und als Obergrenze markiert.
    expect(text).toMatch(/Nachlauf nach Stop-Ausstiegen/);
  });

  it('Trades je Monat steht mit der Zahl der Maßstab-Zeile in der Aktivitätstabelle (eine Rechnung, eine Zahl)', () => {
    const { text, runs } = lauf(['AAA']);
    for (const s of runs[0]!.results) {
      const erwartet = s.massstab.tradesPerMonth!.toFixed(1);
      expect(text).toContain(`| Trades je Monat | ${erwartet} |`);
      expect(text).toContain(`Trades je Monat ${erwartet} ·`);
    }
  });

  it('die Aktivitätstabelle nennt die gemessene Exposure des Kandidaten', () => {
    const { text } = lauf(['AAA']);
    expect(text).toContain('| Gebundenes Kapital | 40.0 % |');
    expect(text).toContain('| Gebundenes Kapital | 20.0 % |');
  });

  it('Korrelationsmatrix mit Kürzel-Legende, Diagonale 1 und Durchschnittszeile', () => {
    const { text } = lauf(['AAA', 'BBB']);
    expect(text).toContain('## Korrelationsmatrix der Tagesrenditen');
    expect(text).toContain('| Kürzel | Kandidat |');
    expect(text).toContain('| K1 | AAA · edge |');
    expect(text).toMatch(/\*\*Durchschnittskorrelation: [−\-\d.]+\*\*/);
    // Beide Regeln der Legende stehen da — sonst hält jemand die Zahl für eine bedingte Korrelation.
    expect(text).toContain('GEMEINSAMEN Handelstagen');
    expect(text).toContain('nicht investiert heißt kein Ertrag');
    // Diagonale: 6 Kandidaten (2 Symbole × 3) ⇒ 6×6-Matrix.
    expect(text).toContain('|  | K1 | K2 | K3 | K4 | K5 | K6 |');
    expect(text).toMatch(/\| K1 \| 1 \|/);
  });

  it('nur ein Kandidat mit Reihe ⇒ ausdrücklich „keine Matrix", keine leere Tabelle', () => {
    const home = tmp();
    const out = runOptimization({
      config: testConfig({ symbols: ['AAA'], home, optimizer: { seed: 7 } }),
      symbols: ['AAA'],
      strategies: ['edge'],
      barsFor: () => bars,
      home,
      initialEquity: 10_000,
      simulate: makeFakeSimulate(() => REWARD_PROFILE),
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    });
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('## Korrelationsmatrix der Tagesrenditen');
    expect(text).toContain('keine Matrix');
  });
});
