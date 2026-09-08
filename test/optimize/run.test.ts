import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal, homePaths } from '../../src/core/journal.ts';
import type { Strategy } from '../../src/core/types.ts';
import { loadChampion, saveChampion, emptyChampionFile, type ChampionEntry } from '../../src/optimize/promote.ts';
import { runOptimization, type OptimizeRunInput } from '../../src/optimize/run.ts';
import { paramKey } from '../../src/optimize/search.ts';
import { foldPlanForBars } from '../../src/optimize/walkForward.ts';
import { DEAD_PROFILE, NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const bars = dailyBars(400);
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

const strategies: Record<string, Strategy> = {
  edge: fakeStrategy('edge'),
  noise: fakeStrategy('noise'),
  dead: fakeStrategy('dead'),
  intraday: fakeStrategy('intraday', { timeframes: [5] }),
};
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE, dead: DEAD_PROFILE, intraday: REWARD_PROFILE };
const getStrategy = (id: string): Strategy => {
  const s = strategies[id];
  if (!s) throw new Error(`unbekannte Strategie ${id}`);
  return s;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'autotrd-run-'));
  dirs.push(d);
  return d;
};

function input(home: string, over: Partial<OptimizeRunInput> & { seed?: number; symbols?: string[]; strategies?: string[]; samples?: number } = {}): OptimizeRunInput {
  const symbols = over.symbols ?? ['AAA', 'BBB'];
  const cfg = testConfig({ symbols, home, optimizer: { seed: over.seed ?? 7, ...(over.samples ? { samples: over.samples } : {}) } });
  return {
    config: cfg,
    symbols,
    strategies: over.strategies ?? ['edge', 'noise'],
    barsFor: () => bars,
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
    ...over,
  };
}

/** Veralteter Champion-Eintrag (ohne fitEnd, alte Datei). */
function staleEntry(strategy: string, params: Record<string, number>, extra: Partial<ChampionEntry> = {}): ChampionEntry {
  return {
    strategy,
    params,
    timeframe: 1440,
    score: 2,
    oos: { objectiveMedian: 2, objectiveMean: 2, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
    gates: [],
    decidedAt: 1,
    trials: 1,
    dataRange: { start: 0, end: 1 },
    ...extra,
  };
}

describe('runOptimization (Ende-zu-Ende)', () => {
  it('befördert die Strategie mit echter Kante, schreibt Champion (mit fitEnd), Journal und Bericht', () => {
    const home = tmp();
    const out = runOptimization(input(home));

    expect(out.runs.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    for (const r of out.runs) {
      expect(r.decision.action).toBe('promote');
      expect(r.chosen!.strategy).toBe('edge');
      expect(r.chosen!.params.a).toBe(10);
      expect(r.results.length).toBe(2);
      expect(r.results[0]!.strategyId).toBe('edge'); // absteigend nach Score
      expect(r.results[0]!.pass).toBe(true);
      expect(r.results[1]!.strategyId).toBe('noise');
      expect(r.results[1]!.pass).toBe(false);
      expect(r.errors).toEqual([]);
      expect(r.incumbent).toBeNull();
      expect(r.incumbentEval).toBeNull();
    }

    // Champion-Datei
    const paths = homePaths(home);
    expect(existsSync(paths.champion)).toBe(true);
    const file = loadChampion(paths.champion)!;
    expect(file).toEqual(out.champion);
    expect(file.version).toBe(1);
    expect(file.updatedAt).toBe(NOW);
    expect(Object.keys(file.symbols).sort()).toEqual(['AAA', 'BBB']);
    expect(file.noTrade).toEqual({});
    const e = file.symbols.AAA!;
    expect(e.strategy).toBe('edge');
    expect(e.timeframe).toBe(1440);
    expect(e.score).toBeGreaterThan(0);
    expect(e.gates.every((g) => g.pass)).toBe(true);
    expect(e.trials).toBe(8 * 55 + 55);
    expect(e.dataRange).toEqual({ start: bars.t[0]!, end: bars.t[399]! + 1 });
    const plan = foldPlanForBars(bars, out.runs[0]!.results[0]!.wfa.folds.length ? testConfig().optimizer : testConfig().optimizer);
    expect(e.fitEnd).toBe(plan.folds[plan.folds.length - 1]!.oosEnd);

    // Journal
    const events = new Journal(paths.journal).readAll();
    expect(events.filter((ev) => ev.kind === 'champion').length).toBe(2);
    expect(events[0]).toMatchObject({ kind: 'champion', symbol: 'AAA', action: 'promote', strategy: 'edge', fitEnd: e.fitEnd });

    // Bericht
    expect(out.reportPath).toBe(join(paths.reports, 'optimize-2026-09-06.md'));
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('# Optimierung 2026-09-06');
    expect(text).toContain('| Strategie | OOS-Objective (Median) |');
    expect(text).toContain('| Gate | Ergebnis | Wert | Schwelle | Notiz |');
    expect(text).toContain('nur Bericht, nicht Auswahl');
    expect(text).toContain('**Entscheidung: promote**');
    expect(text).toContain('## AAA');
    expect(text).toContain('## BBB');
    expect(text).toContain('finalParams: `{"a":10');
    expect(text).toMatch(/\| noise \|[^\n]*✘/);
    expect(text).toMatch(/\| edge \|[^\n]*✔ 9\/9/);
    expect(text).toContain('PSR (OOS): PSR ');
    expect(text).toContain('DSR (IS): DSR ');
    expect(text).toContain('(alle Folds)');
    expect(text).toContain('nur finale Suche');
    // Maßstab unter dem Holdout. Ohne ihn liest ein Mensch Marktbewegung als
    // Kante — die Zahl muss deshalb im Bericht ANKOMMEN, nicht nur berechnet
    // werden. Sie entscheidet nichts und darf in keiner Gate-Tabelle stehen.
    expect(text).toContain('Maßstab im selben Fenster');
    expect(text).toContain('| Referenz | Rendite | MaxDD | Sharpe |');
    expect(text).toMatch(/\| Kaufen und Halten \(\d+ Symbole?, gleichgewichtet\) \|/);
    expect(out.runs[0]!.holdoutMarkt).not.toBeNull();
    expect(out.runs[0]!.holdoutMarkt!.range).toEqual({ start: out.runs[0]!.results[0]!.wfa.holdout!.start, end: out.runs[0]!.results[0]!.wfa.holdout!.end });
  });

  it('Folgelauf am selben Tag: kein sauberes OOS nach fitEnd ⇒ Beförderungs-Score gilt, Kandidat schlägt die Marge nicht ⇒ keep', () => {
    const home = tmp();
    const first = runOptimization(input(home));
    const second = runOptimization(input(home, { now: () => NOW + 1 }));
    for (const r of second.runs) {
      expect(r.incumbent).not.toBeNull();
      expect(r.incumbentEval).not.toBeNull();
      expect(r.incumbentEval!.pass).toBeNull();
      expect(r.incumbentEval!.cleanFolds).toBe(0);
      expect(r.incumbentEval!.note).toMatch(/zu wenig sauberes OOS/);
      expect(r.incumbentRescore).toBe(r.incumbent!.score);
      expect(r.decision.action).toBe('keep');
      expect(r.decision.reason).toMatch(/Marge nicht erreicht/);
      expect(r.chosen).toEqual(r.incumbent);
    }
    expect(second.champion.symbols).toEqual(first.champion.symbols);
    const text = readFileSync(second.reportPath, 'utf8');
    expect(text).toContain('Sauberes OOS nach Fit-Ende: 0 von 8 Folds');
    expect(text).toContain('Fit-Ende ');
  });

  it('Incumbent-Params fließen NICHT mehr in die Kandidatensuche ein (Leck: gefittet auf Kandidaten-OOS)', () => {
    const home = tmp();
    const paths = homePaths(home);
    const incParams = { a: 3, b: 1 };
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: staleEntry('edge', incParams, { decidedAt: 1 }) } });
    const simulate = makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE);
    runOptimization(input(home, { symbols: ['AAA'], strategies: ['edge'], samples: 4, simulate }));
    // Die ersten 4 Aufrufe sind die IS-Suche des ersten Folds: Defaults zuerst, danach Zufall — nie der Incumbent an Position 2.
    const first = simulate.calls.slice(0, 4).map((c) => paramKey(c.params));
    expect(first[0]).toBe(paramKey(strategies.edge!.defaults));
    expect(first[1]).not.toBe(paramKey(incParams));
  });

  it('reines Rauschen (Erwartungswert 0, Kosten > 0) wird NIE befördert — über mehrere Seeds und Symbole', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const home = tmp();
      const out = runOptimization(input(home, { seed, symbols: ['AAA', 'BBB', 'CCC'], strategies: ['noise'] }));
      for (const r of out.runs) {
        expect(r.decision.action).toBe('stay_notrade');
        expect(r.chosen).toBeNull();
        expect(r.results[0]!.pass).toBe(false);
        expect(r.results[0]!.gates.some((g) => g.name === 'probabilistic_sharpe_oos' && !g.pass)).toBe(true);
      }
      expect(out.champion.symbols).toEqual({});
      expect(Object.keys(out.champion.noTrade).sort()).toEqual(['AAA', 'BBB', 'CCC']);
      expect(out.champion.noTrade.AAA!.reason).toMatch(/fällt durch die Gates/);
      expect(out.champion.noTrade.AAA!.decidedAt).toBe(NOW);
    }
  });

  it('ein Champion ohne Kante wird auf sauberem OOS durch die Gates geprüft und degradiert', () => {
    const home = tmp();
    const paths = homePaths(home);
    // alte Datei ohne fitEnd ⇒ fitEnd = decidedAt = 1 ⇒ alle 8 Folds sauber
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: staleEntry('dead', { a: 3, b: 1 }) } });
    const out = runOptimization(input(home, { symbols: ['AAA'], strategies: ['dead'] }));
    const r = out.runs[0]!;
    const ev = r.incumbentEval!;
    expect(ev.cleanFolds).toBe(8);
    expect(ev.totalFolds).toBe(8);
    expect(ev.cleanDays).toBe(240);
    expect(ev.pass).toBe(false);
    expect(ev.gates.length).toBe(9);
    expect(ev.gates.find((g) => g.name === 'deflated_sharpe_is')!.note).toMatch(/nicht anwendbar/);
    expect(r.incumbentRescore).toBe(ev.score);
    expect(r.incumbentRescore!).toBeLessThanOrEqual(0);
    expect(r.decision.action).toBe('demote_to_notrade');
    expect(r.decision.reason).toMatch(/reißt die Gates/);
    expect(out.champion.symbols.AAA).toBeUndefined();
    expect(out.champion.noTrade.AAA!.reason).toMatch(/kein Handel/);
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('**Entscheidung: demote_to_notrade**');
    expect(text).toContain('Amtierender Champion: dead');
    expect(text).toContain('Sauberes OOS nach Fit-Ende: 8 von 8 Folds, 240 Tage');
    expect(text).toContain('Gates gerissen');
  });

  it('ein Champion mit zu wenig sauberem OOS wird NICHT degradiert — auch wenn seine Params heute nichts taugen', () => {
    const home = tmp();
    const paths = homePaths(home);
    const plan = foldPlanForBars(bars, testConfig().optimizer);
    // fitEnd nach dem 6. Fold ⇒ nur 2 saubere Folds (< 3)
    const fitEnd = plan.folds[5]!.oosEnd;
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: staleEntry('dead', { a: 3, b: 1 }, { fitEnd, score: 0.7 }) } });
    const out = runOptimization(input(home, { symbols: ['AAA'], strategies: ['dead'] }));
    const r = out.runs[0]!;
    expect(r.incumbentEval!.cleanFolds).toBe(2);
    expect(r.incumbentEval!.pass).toBeNull();
    expect(r.incumbentRescore).toBe(0.7);
    expect(r.decision.action).toBe('keep');
    expect(r.decision.reason).toMatch(/ungeprüft/);
    expect(out.champion.symbols.AAA).toBeDefined();
  });

  it('ein Kandidat mit Kante ersetzt einen Champion, der die Gates auf sauberem OOS reißt', () => {
    const home = tmp();
    const paths = homePaths(home);
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: staleEntry('dead', { a: 3, b: 1 }) } });
    const out = runOptimization(input(home, { symbols: ['AAA'], strategies: ['edge', 'dead'] }));
    const r = out.runs[0]!;
    expect(r.incumbentEval!.pass).toBe(false);
    expect(r.decision.action).toBe('promote');
    expect(r.decision.reason).toMatch(/reißt die Gates/);
    expect(out.champion.symbols.AAA!.strategy).toBe('edge');
    expect(out.champion.symbols.AAA!.fitEnd).toBeDefined();
  });

  it('Strategien ohne passenden Zeitrahmen werden übersprungen; ohne Kandidat bleibt es bei kein Handel', () => {
    const home = tmp();
    const logs: string[] = [];
    const out = runOptimization(input(home, { symbols: ['AAA'], strategies: ['intraday'], log: (m) => logs.push(m) }));
    const r = out.runs[0]!;
    expect(r.results).toEqual([]);
    expect(r.decision.action).toBe('stay_notrade');
    expect(r.decision.reason).toMatch(/kein bewertbarer Kandidat/);
    expect(logs.some((m) => /intraday.*Zeitrahmen/.test(m))).toBe(true);
    expect(readFileSync(out.reportPath, 'utf8')).toContain('_Keine bewertbare Strategie._');
  });

  it('unbekannte Strategie-ID ist ein Config-Fehler', () => {
    expect(() => runOptimization(input(tmp(), { strategies: ['gibt_es_nicht'] }))).toThrow(/unbekannte Strategie/);
  });

  it('zu wenig Historie ⇒ Symbol nicht bewertbar, Champion unverändert, Fehler im Bericht', () => {
    const home = tmp();
    const out = runOptimization(input(home, { symbols: ['AAA'], barsFor: () => dailyBars(100) }));
    const r = out.runs[0]!;
    expect(r.results).toEqual([]);
    expect(r.errors.length).toBe(2);
    expect(r.decision.action).toBe('stay_notrade');
    expect(r.decision.reason).toMatch(/nicht bewertbar/);
    expect(readFileSync(out.reportPath, 'utf8')).toContain('mindestens 3 Folds');
  });

  it('ohne Injektion scheitert der Lauf laut', () => {
    expect(() => runOptimization({ ...input(tmp()), simulate: undefined })).toThrow(/simulate nicht injiziert/);
  });

  it('ist bei gleichem Seed vollständig deterministisch (Ergebnis und Bericht)', () => {
    const a = runOptimization(input(tmp(), { seed: 11 }));
    const b = runOptimization(input(tmp(), { seed: 11 }));
    expect(JSON.stringify(a.runs)).toBe(JSON.stringify(b.runs));
    expect(JSON.stringify(a.champion)).toBe(JSON.stringify(b.champion));
    expect(readFileSync(a.reportPath, 'utf8')).toBe(readFileSync(b.reportPath, 'utf8'));
    const c = runOptimization(input(tmp(), { seed: 12 }));
    // anderer Seed ⇒ andere Stichprobe für das Rauschen (die Kante gewinnt trotzdem)
    expect(c.runs[0]!.chosen!.strategy).toBe('edge');
  });
});
