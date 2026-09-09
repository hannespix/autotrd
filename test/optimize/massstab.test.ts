/**
 * Der Maßstab je Kandidat: dieselben OOS-Fenster, die Strategie neben
 * kaufen-und-halten der Benchmark — Sharpe, MaxDD, Trades je Monat. Er
 * entscheidet nichts (das tut `beats_market`), aber ohne ihn liest man einen
 * Sharpe von 0,8 als Kante, wo der Markt 1,2 gemacht hat.
 *
 * Festgehalten wird:
 *  1. `marktKette` misst den MaxDD über die VERKETTETE Wertreihe — ein
 *     Verlust im ersten Fenster zählt im zweiten weiter, wie bei der
 *     OOS-Kette der Strategie (`aggregateOos`).
 *  2. Jeder Kandidat (gesucht und fest) trägt die Struktur; Trades je Monat
 *     sind OOS-Trades durch OOS-Tage/30,44; der Sharpe ist die Zahl aus
 *     `beats_market`.
 *  3. Die Berichtszeile nennt alle drei Fälle unterscheidbar: Benchmark,
 *     Benchmark ohne Kurse, keine Benchmark (Kasse).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { kaufenUndHalten, marktKette } from '../../src/backtest/marktbezug.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar, BarSeriesLike, Strategy } from '../../src/core/types.ts';
import { TAGE_JE_MONAT, runOptimization, type OptimizeRunInput, type StrategyRun } from '../../src/optimize/run.ts';
import { NOISE_PROFILE, REWARD_PROFILE, T0, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const tag = (i: number, c: number): Bar => ({ t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1_000 });

describe('marktKette: MaxDD über die verkettete Wertreihe', () => {
  // Fenster 1 (Tage 0–2): 100 → 120 → 110; Fenster 2 (Tage 3–4): 100 → 95.
  const bars = new Map<string, BarSeriesLike>([['SPY', BarSeries.from([tag(0, 100), tag(1, 120), tag(2, 110), tag(3, 100), tag(4, 95)])]]);
  const f1 = { start: T0, end: T0 + 3 * DAY };
  const f2 = { start: T0 + 3 * DAY, end: T0 + 5 * DAY };
  const basis = { bars, assetClass: 'crypto' as const, periodsPerYear: 365 };

  it('ein Fenster: dieselben Zahlen wie kaufenUndHalten', () => {
    const k = marktKette({ ...basis, ranges: [f1] })!;
    const e = kaufenUndHalten({ ...basis, range: f1 })!;
    expect(k.fenster).toBe(1);
    expect(k.maxDrawdownPct).toBeCloseTo(e.maxDrawdownPct, 9); // 120 → 110: 8,33 %
    expect(k.netReturnPct).toBeCloseTo(e.netReturnPct, 9);
    expect(k.sharpe).toBeCloseTo(e.sharpe!, 9);
  });

  it('zwei Fenster: der Verlust des ersten zählt im zweiten weiter — größer als jeder Fenster-MaxDD', () => {
    const k = marktKette({ ...basis, ranges: [f1, f2] })!;
    expect(k.fenster).toBe(2);
    // Kette 1 → 1,2 → 1,1 → 1,045: vom Hoch 1,2 auf 1,045.
    expect(k.maxDrawdownPct).toBeCloseTo(((1.2 - 1.045) / 1.2) * 100, 9);
    expect(k.netReturnPct).toBeCloseTo(4.5, 9);
    const einzeln = [f1, f2].map((r) => kaufenUndHalten({ ...basis, range: r })!.maxDrawdownPct);
    expect(k.maxDrawdownPct).toBeGreaterThan(Math.max(...einzeln));
  });

  it('ohne Kurse in den Fenstern: null', () => {
    expect(marktKette({ ...basis, ranges: [{ start: T0 + 100 * DAY, end: T0 + 130 * DAY }] })).toBeNull();
  });
});

describe('Maßstab je Kandidat im Lauf', () => {
  const bars = dailyBars(400);
  const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
  const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), noise: fakeStrategy('noise') };
  const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, noise: NOISE_PROFILE };
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
    const d = mkdtempSync(join(tmpdir(), 'autotrd-massstab-'));
    dirs.push(d);
    return d;
  };
  /** Benchmark mit Auf und Ab, damit Sharpe rechenbar ist und ein Drawdown entsteht. */
  const zickzack = BarSeries.from(Array.from({ length: 400 }, (_, i) => tag(i, 100 + 10 * Math.sin(i / 5))));

  function input(home: string, over: { benchmark?: BarSeriesLike } = {}): OptimizeRunInput {
    return {
      config: testConfig({ symbols: ['AAA'], home, optimizer: { seed: 7, fixedCandidates: [{ strategy: 'edge', params: { a: 10, b: 2 }, label: 'Zehn' }] }, ...(over.benchmark ? { benchmark: 'BENCH' } : {}) }),
      symbols: ['AAA'],
      strategies: ['edge', 'noise'],
      barsFor: () => bars,
      ...(over.benchmark ? { benchmark: over.benchmark } : {}),
      home,
      initialEquity: 10_000,
      simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
      metricsFns: fakeMetricsFns,
      getStrategy,
      now: () => NOW,
    };
  }
  const gate = (s: StrategyRun, name: string) => s.gates.find((g) => g.name === name)!;
  const zeilen = (text: string) => text.split('\n').filter((l) => l.startsWith('Über dieselben OOS-Fenster: Strategie Sharpe p. a. '));

  it('jeder Kandidat — gesucht und fest — trägt den Maßstab; Trades je Monat = OOS-Trades / (OOS-Tage / 30,44); ohne Benchmark gilt die Kasse', () => {
    const home = tmp();
    const out = runOptimization(input(home));
    const r = out.runs[0]!;
    expect(r.results.length).toBe(3);
    for (const s of r.results) {
      const m = s.massstab;
      expect(m.oosDays).toBe(8 * 30);
      expect(m.tradesPerMonth).toBeCloseTo(s.wfa.oos.trades / (240 / TAGE_JE_MONAT), 9);
      expect(m.oosMaxDD).toBe(s.wfa.oos.maxDrawdownPct);
      // Dieselbe Zahl wie das Gate — nicht eine zweite, anders gerechnete.
      expect(m.oosSharpe).toBe(gate(s, 'beats_market').value);
      expect(m.oosSharpe).not.toBeNull();
      expect(m.marktSymbol).toBeNull();
      expect(m.marktSharpe).toBeNull();
      expect(m.marktMaxDD).toBeNull();
    }
    // Ein Symbol, ein Trade je Bar: 240 Trades auf 240 Tage ⇒ 30,44 je Monat.
    expect(r.results.find((s) => s.fixed)!.massstab.tradesPerMonth).toBeCloseTo(TAGE_JE_MONAT, 9);
    const text = readFileSync(out.reportPath, 'utf8');
    const z = zeilen(text);
    expect(z.length).toBe(3);
    for (const l of z) expect(l).toMatch(/, MaxDD [\d.]+ %, Trades je Monat 30\.4 · ohne Benchmark: Kasse \(Latte 0\)$/);
    // Direkt unter der Gates-Tabelle, vor der PSR-Zeile.
    const i = text.indexOf(z[0]!);
    expect(text.slice(0, i)).toMatch(/\| beats_market \|[^\n]*\n\n$/);
    expect(text.slice(i)).toMatch(/^[^\n]*\n\nPSR \(OOS\): /);
  });

  it('mit Benchmark: Markt-Sharpe ist die Latte von beats_market, Markt-MaxDD die verkettete Wertreihe über dieselben OOS-Fenster', () => {
    const home = tmp();
    const out = runOptimization(input(home, { benchmark: zickzack }));
    const r = out.runs[0]!;
    for (const s of r.results) {
      const m = s.massstab;
      expect(m.marktSymbol).toBe('BENCH');
      expect(m.marktSharpe).not.toBeNull();
      expect(m.marktSharpe).toBe(gate(s, 'beats_market').threshold);
      const k = marktKette({
        bars: new Map([['BENCH', zickzack]]),
        ranges: s.wfa.folds.map((f) => ({ start: f.fold.oosStart, end: f.fold.oosEnd })),
        assetClass: 'crypto',
        periodsPerYear: 365,
      })!;
      expect(m.marktMaxDD).toBe(k.maxDrawdownPct);
      expect(m.marktMaxDD!).toBeGreaterThan(0);
    }
    const z = zeilen(readFileSync(out.reportPath, 'utf8'));
    expect(z.length).toBe(3);
    for (const l of z) expect(l).toMatch(/ · BENCH kaufen-und-halten Sharpe -?[\d.]+, MaxDD [\d.]+ %$/);
  });

  it('Benchmark konfiguriert, aber ohne Kurse in den OOS-Fenstern ⇒ „nicht berechenbar" — nicht „ohne Benchmark"', () => {
    const home = tmp();
    // Zehn Tage ab T0 — jedes OOS-Fenster liegt später.
    const out = runOptimization(input(home, { benchmark: dailyBars(10) }));
    const r = out.runs[0]!;
    for (const s of r.results) {
      expect(s.massstab.marktSymbol).toBe('BENCH');
      expect(s.massstab.marktSharpe).toBeNull();
      expect(s.massstab.marktMaxDD).toBeNull();
      const g = gate(s, 'beats_market');
      expect(g.threshold).toBe(0);
      expect(g.note).toContain('BENCH kaufen und halten: keine Kurse in den OOS-Fenstern, Sharpe nicht berechenbar — Latte 0 (Kasse)');
      expect(g.note).not.toContain('kein Maßstab konfiguriert');
    }
    const z = zeilen(readFileSync(out.reportPath, 'utf8'));
    expect(z.length).toBe(3);
    for (const l of z) expect(l).toMatch(/ · BENCH kaufen-und-halten nicht berechenbar — Latte 0 \(Kasse\)$/);
  });
});
