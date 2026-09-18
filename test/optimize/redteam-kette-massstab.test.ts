import { describe, expect, it } from 'vitest';
import { marktKette, marktKetteAufAchse } from '../../src/backtest/marktbezug.ts';
import { sharpeRatio, tagesachse } from '../../src/backtest/metrics.ts';
import { simulate } from '../../src/backtest/simulator.ts';
import { dayKeyFor, msFromET } from '../../src/core/time.ts';
import type { Bar, Decision } from '../../src/core/types.ts';
import { marktReihe } from '../../src/optimize/run.ts';
import { durchgehendeKette, foldPlanForBars } from '../../src/optimize/walkForward.ts';
import { baseConfig, seriesOf, strategyOf } from '../backtest/helpers.ts';
import { hashUnit, testConfig } from './fakes.ts';

/**
 * Prüfer (Red-Team, 18.09.2026, `pruefungen/2026-09-18-red-team-durchgehende-kette.md`, Befund M2):
 *
 * Seit die OOS-Kette EINE durchgehende Simulation ist, hat die Strategie an
 * jedem Fold-Übergang eine echte Tagesrendite (Schluss des letzten Tages von
 * Fold k → Schluss des ersten Tages von Fold k+1). Der Maßstab für
 * `beats_market` (`marktKette`/`marktReihe`) kauft dagegen JEDES Fenster
 * frisch und kennt die Übergangsrendite nicht: Je Fenster liefert
 * `wertreihe` (Handelstage − 1) Renditen. Über k Fenster fehlen dem Markt
 * genau k Tage — die ersten Tage jedes Fensters —, die die Strategie hat.
 * Zwei Sharpe-Werte über verschiedene Tagesmengen stehen dann in einem Gate.
 */

const E0 = 100_000;
const cfg = baseConfig({
  timeframe: 1440,
  risk: { riskPerTradePct: 5, maxPositionPct: 100 },
  costs: { slippageBps: 0, spreadBps: 0, secFeeRate: 0, finraTafPerShare: 0, finraTafMax: 0 },
});
const optimizer = testConfig().optimizer;

/** Werktags-Tagesbars ab dem 1.1.2024, deterministischer Zufallspfad (o = c). */
function zufallsTage(n: number): Bar[] {
  const out: Bar[] = [];
  const d0 = Date.UTC(2024, 0, 1);
  let c = 100;
  for (let d = 0; out.length < n; d++) {
    const dt = new Date(d0 + d * 86_400_000);
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    c *= 1 + (hashUnit(`spy|${out.length}`) * 2 - 1) * 0.01;
    out.push({ t: msFromET(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 9, 30), o: c, h: c, l: c, c, v: 1_000 });
  }
  return out;
}

describe('beats_market: Strategie-Kette durchgehend, Markt-Kette je Fenster (Befund M2 — der alte per_fold-Maßstab) und auf der Tagesachse (Nachtrag)', () => {
  const bars = zufallsTage(400);
  const series = seriesOf(bars);
  const plan = foldPlanForBars(series, optimizer);
  const folds = plan.folds;
  const ranges = folds.map((f) => ({ start: f.oosStart, end: f.oosEnd }));
  const first = folds[0]!;
  const last = folds.at(-1)!;
  const kettenBars = bars.filter((b) => b.t >= first.oosStart && b.t < last.oosEnd);
  const N = kettenBars.length;

  it('hat mehr als zwei Folds, sonst prüft dieser Test nichts', () => {
    expect(folds.length).toBeGreaterThan(2);
    expect(N).toBeGreaterThan(folds.length * 10);
  });

  it('WÄCHTER (M2): die Strategie-Kette hat N Tagesrenditen, der Markt N − k — es fehlen genau die ersten Tage jedes Fensters', () => {
    // Kaufen und halten als STRATEGIE durch den echten Simulator: Einstieg am ersten OOS-Tag, nie raus.
    const halten = strategyOf({
      timeframes: [1440],
      decide: (snap): Decision => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.5, reason: 'halten' }),
    });
    const k = durchgehendeKette({ symbol: 'SPY', strategy: halten, bars: series, config: cfg, initialEquity: E0, simulate, folds: folds.map((fold) => ({ fold, params: {} })) });
    expect(k.gesamt.dailyReturns).toHaveLength(N);

    const markt = marktReihe({ bars: new Map([['SPY', series]]), ranges, assetClass: 'us_equity' });
    expect(markt).not.toBeNull();
    expect(markt!.dailyReturns).toHaveLength(N - folds.length);

    // Welche Tage fehlen dem Markt? Genau der erste Handelstag jedes OOS-Fensters.
    const strategieTage = tagesachse(k.gesamt.equity, 'us_equity');
    const marktTage = new Set(markt!.dayKeys);
    const fehlend = strategieTage.filter((d) => !marktTage.has(d));
    const ersteTage = folds.map((f) => dayKeyFor(bars.find((b) => b.t >= f.oosStart)!.t, 'us_equity'));
    expect(fehlend).toEqual(ersteTage);
  });

  it('WÄCHTER (Nachtrag, M2 behoben): der Maßstab auf der Tagesachse der Kette hat N Renditen, dieselben dayKeys, Tag 1 = 0 und den Sharpe der durchgehenden Kursreihe', () => {
    const halten = strategyOf({
      timeframes: [1440],
      decide: (snap): Decision => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.5, reason: 'halten' }),
    });
    const k = durchgehendeKette({ symbol: 'SPY', strategy: halten, bars: series, config: cfg, initialEquity: E0, simulate, folds: folds.map((fold) => ({ fold, params: {} })) });
    const achse = tagesachse(k.gesamt.equity, 'us_equity');
    const m = marktKetteAufAchse({ bars: new Map([['SPY', series]]), dayKeys: achse, assetClass: 'us_equity', periodsPerYear: 252 })!;
    expect(m).not.toBeNull();
    expect(m.dailyReturns).toHaveLength(N);
    expect(m.dayKeys).toEqual(achse);
    expect(m.dailyReturns[0]).toBe(0);
    // Ab Tag 2 die Kursrendite gegen den Vortag — auch über die Fold-Grenzen hinweg.
    const i0 = bars.findIndex((b) => b.t >= first.oosStart);
    const erwartet = [0];
    for (let i = i0 + 1; i < i0 + N; i++) erwartet.push(bars[i]!.c / bars[i - 1]!.c - 1);
    m.dailyReturns.forEach((r, i) => expect(r).toBeCloseTo(erwartet[i]!, 12));
    expect(m.sharpe).toBeCloseTo(sharpeRatio(erwartet, 252)!, 12);
    // Fehlt dem Benchmark ein Tag der Achse, gilt sein letzter Kurs — Rendite 0, Achse unverändert.
    const luecke = seriesOf(bars.filter((_, i) => i !== i0 + 5));
    const ml = marktKetteAufAchse({ bars: new Map([['SPY', luecke]]), dayKeys: achse, assetClass: 'us_equity', periodsPerYear: 252 })!;
    expect(ml.dayKeys).toEqual(achse);
    expect(ml.dailyReturns[5]).toBe(0);
    expect(ml.dailyReturns[6]).toBeCloseTo(bars[i0 + 6]!.c / bars[i0 + 4]!.c - 1, 12);
    // Kein Kurs am ersten Tag der Achse ⇒ null (Survivorship-Regel wie `wertreihe`).
    expect(marktKetteAufAchse({ bars: new Map([['SPY', seriesOf(bars.slice(i0 + 1))]]), dayKeys: achse, assetClass: 'us_equity', periodsPerYear: 252 })).toBeNull();
  });

  it('WÄCHTER (M2, dokumentiert): der Markt-Sharpe je Fenster ist NICHT der Sharpe derselben Kursreihe durchgehend — die k Übergangsrenditen sind weder null noch vernachlässigbar', () => {
    const latte = marktKette({ bars: new Map([['SPY', series]]), ranges, assetClass: 'us_equity', periodsPerYear: 252 });
    expect(latte).not.toBeNull();
    // Dieselbe Kursreihe als EINE Kette: jede Tagesrendite gegen den Vortag, auch über die Fold-Grenzen.
    const i0 = bars.findIndex((b) => b.t >= first.oosStart);
    const durchgehend: number[] = [];
    for (let i = i0; i < i0 + N; i++) durchgehend.push(bars[i]!.c / bars[i - 1]!.c - 1);
    const srDurchgehend = sharpeRatio(durchgehend, 252)!;
    // Die Übergangsrenditen (erster Tag jedes Fensters gegen den letzten des vorigen) sind echte Kurstage.
    const uebergaenge = folds.map((f) => {
      const i = bars.findIndex((b) => b.t >= f.oosStart);
      return bars[i]!.c / bars[i - 1]!.c - 1;
    });
    expect(uebergaenge.some((r) => Math.abs(r) > 1e-4)).toBe(true);
    expect(Math.abs(latte!.sharpe! - srDurchgehend)).toBeGreaterThan(1e-6);
    // Zum Protokoll: Größenordnung des Versatzes bei diesem Pfad.
    console.log(`M2: Markt-Sharpe je Fenster ${latte!.sharpe!.toFixed(4)} vs. durchgehend ${srDurchgehend.toFixed(4)} (${folds.length} Übergangsrenditen fehlen, Σ ${(uebergaenge.reduce((s, r) => s + r, 0) * 100).toFixed(2)} %)`);
  });
});
