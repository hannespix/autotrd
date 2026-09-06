import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal, homePaths } from '../../src/core/journal.ts';
import type { Strategy } from '../../src/core/types.ts';
import { loadChampion, saveChampion, emptyChampionFile, type ChampionEntry } from '../../src/optimize/promote.ts';
import { runOptimization, type OptimizeRunInput } from '../../src/optimize/run.ts';
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

function input(home: string, over: Partial<OptimizeRunInput> & { seed?: number; symbols?: string[]; strategies?: string[] } = {}): OptimizeRunInput {
  const symbols = over.symbols ?? ['AAA', 'BBB'];
  const cfg = testConfig({ symbols, home, optimizer: { seed: over.seed ?? 7 } });
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

describe('runOptimization (Ende-zu-Ende)', () => {
  it('befördert die Strategie mit echter Kante, schreibt Champion, Journal und Bericht', () => {
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

    // Journal
    const events = new Journal(paths.journal).readAll();
    expect(events.filter((ev) => ev.kind === 'champion').length).toBe(2);
    expect(events[0]).toMatchObject({ kind: 'champion', symbol: 'AAA', action: 'promote', strategy: 'edge' });

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
    expect(text).toMatch(/\| edge \|[^\n]*✔ 8\/8/);
    expect(text).toContain('PSR (OOS): PSR ');
    expect(text).toContain('DSR (IS): DSR ');
  });

  it('zweiter Lauf mit demselben Champion: Kandidat schlägt die Marge nicht ⇒ keep, Datei unverändert', () => {
    const home = tmp();
    const first = runOptimization(input(home));
    const second = runOptimization(input(home, { now: () => NOW + 1 }));
    for (const r of second.runs) {
      expect(r.incumbent).not.toBeNull();
      expect(r.incumbentRescore).toBeGreaterThan(0);
      expect(r.decision.action).toBe('keep');
      expect(r.decision.reason).toMatch(/Marge nicht erreicht/);
      expect(r.chosen).toEqual(r.incumbent);
    }
    expect(second.champion.symbols).toEqual(first.champion.symbols);
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

  it('ein Champion ohne Kante wird auf denselben Folds re-bewertet und degradiert', () => {
    const home = tmp();
    const paths = homePaths(home);
    const stale: ChampionEntry = {
      strategy: 'dead',
      params: { a: 3, b: 1 },
      timeframe: 1440,
      score: 2,
      oos: { objectiveMedian: 2, objectiveMean: 2, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
      gates: [],
      decidedAt: 1,
      trials: 1,
      dataRange: { start: 0, end: 1 },
    };
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: stale } });
    const out = runOptimization(input(home, { symbols: ['AAA'], strategies: ['dead'] }));
    const r = out.runs[0]!;
    expect(r.incumbentRescore).not.toBeNull();
    expect(r.incumbentRescore!).toBeLessThanOrEqual(0);
    expect(r.decision.action).toBe('demote_to_notrade');
    expect(out.champion.symbols.AAA).toBeUndefined();
    expect(out.champion.noTrade.AAA!.reason).toMatch(/kein Handel/);
    const text = readFileSync(out.reportPath, 'utf8');
    expect(text).toContain('**Entscheidung: demote_to_notrade**');
    expect(text).toContain('Amtierender Champion: dead');
  });

  it('ein Kandidat mit Kante ersetzt einen Champion ohne Kante', () => {
    const home = tmp();
    const paths = homePaths(home);
    const stale: ChampionEntry = {
      strategy: 'dead',
      params: { a: 3, b: 1 },
      timeframe: 1440,
      score: 2,
      oos: { objectiveMedian: 2, objectiveMean: 2, positiveFoldShare: 1, trades: 100, netProfit: 1, netReturnPct: 1, maxDrawdownPct: 1, dailyReturns: [], profitFactor: null, feeShare: null },
      gates: [],
      decidedAt: 1,
      trials: 1,
      dataRange: { start: 0, end: 1 },
    };
    saveChampion(paths.champion, { ...emptyChampionFile(1), symbols: { AAA: stale } });
    const out = runOptimization(input(home, { symbols: ['AAA'], strategies: ['edge', 'dead'] }));
    const r = out.runs[0]!;
    expect(r.decision.action).toBe('promote');
    expect(out.champion.symbols.AAA!.strategy).toBe('edge');
    expect(r.decision.reason).toMatch(/≤ 0/);
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
