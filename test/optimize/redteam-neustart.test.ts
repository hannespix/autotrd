import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision } from '../../src/core/types.ts';
import { durchgehendeKette, foldPlanForBars, simulateWindow } from '../../src/optimize/walkForward.ts';
import { baseConfig, seriesOf, strategyOf } from '../backtest/helpers.ts';
import { testConfig } from './fakes.ts';

/**
 * Prüfer (Red-Team, 18.09.2026, `pruefungen/2026-09-18-red-team-durchgehende-kette.md`, Befund M1):
 *
 * Die Vorregistrierung erwartete, dass die durchgehende Kette SCHLECHTER
 * aussieht als die Fold-Läufe (Buchgewinne an Fold-Enden fallen weg). Sie hat
 * den zweiten Fehler der Fold-Läufe nicht bedacht: Jeder Fold beginnt mit
 * leerem Buch UND unverzinster Kasse. Tag 1 hat die Rendite 0, das Parken
 * wird erst entschieden und füllt am Tag 2 mit Kosten. Ein Kandidat, der GAR
 * NICHTS tut, sieht je Fold deshalb schlechter aus als in der einen Kette —
 * der Neustart hat einen Preis, strategieunabhängig, an jeder Fold-Grenze.
 * Gemessen hier: 88,58 $ je Grenze bei 100 000 $ (Park-Kauf 5 bp auf 98 %
 * der Equity ≈ 49 $, zwei Tage entgangener Zins ≈ 39 $). Mit der
 * Plattform-Config (E₀ 25 000 $, ≈ 80 % Kasse in BIL, 5 bp, ≈ 4,5 % p. a.,
 * 17 Grenzen) sind das grob 15–20 $ je Grenze ⇒ ≈ 250–350 $ je Kette, bevor
 * die Strategie überhaupt gehandelt hat.
 */

const E0 = 100_000;
const cfg = baseConfig({
  timeframe: 1440,
  risk: { riskPerTradePct: 5, maxPositionPct: 100, cashParking: { enabled: true, symbol: 'BIL', bandPct: 5, bufferPct: 2 } },
});
const optimizer = testConfig().optimizer;

/** Werktags-Tagesbars ab dem 1.1.2024, Schluss = close(k), o = h = l = c. */
function tage(n: number, close: (k: number) => number): Bar[] {
  const out: Bar[] = [];
  const d0 = Date.UTC(2024, 0, 1);
  for (let d = 0; out.length < n; d++) {
    const dt = new Date(d0 + d * 86_400_000);
    const dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const c = close(out.length);
    out.push({ t: msFromET(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 9, 30), o: c, h: c, l: c, c, v: 1_000 });
  }
  return out;
}

describe('Der Neustart je Fold hat einen Preis, den die Kette nicht zahlt (Befund M1)', () => {
  const korb = seriesOf(tage(400, () => 100));
  // Geldmarktpapier: 0,02 % je Handelstag ≈ 5 % p. a., stetig.
  const bil = seriesOf(tage(400, (k) => 100 * Math.pow(1.0002, k)));
  const plan = foldPlanForBars(korb, optimizer);
  const folds = plan.folds;
  const nichts = strategyOf({ timeframes: [1440], decide: (): Decision => ({ kind: 'hold' }) });
  const args = { symbol: 'AAA', strategy: nichts, params: {}, bars: korb, config: cfg, initialEquity: E0, simulate, parkBars: bil };

  it('hat mehr als zwei Folds', () => {
    expect(folds.length).toBeGreaterThan(2);
  });

  it('WÄCHTER (M1): je Fold-Lauf ist Tag 1 eine Null-Rendite mit unverzinster Kasse und Tag 2 der Park-Kauf mit Kosten; die Kette parkt durchgehend', () => {
    const jeFold = folds.map((f) => simulateWindow({ ...args, range: { start: f.oosStart, end: f.oosEnd } }));
    const kette = durchgehendeKette({ ...args, folds: folds.map((fold) => ({ fold, params: {} })) });
    expect(kette.gesamt.trades).toEqual([]);
    for (let i = 0; i < folds.length; i++) {
      const pf = jeFold[i]!;
      expect(pf.trades, `Fold ${i + 1}`).toEqual([]);
      expect(pf.dailyReturns[0], `Fold ${i + 1} Tag 1 (leer, unverzinst)`).toBe(0);
      expect(pf.dailyReturns[1], `Fold ${i + 1} Tag 2 (Park-Kauf mit Kosten)`).toBeLessThan(0);
      expect(pf.dailyReturns[2], `Fold ${i + 1} Tag 3 (geparkt)`).toBeGreaterThan(0);
      if (i > 0) {
        const s = kette.scheiben[i]!;
        expect(s.dailyReturns[0], `Scheibe ${i + 1} Tag 1 (durchgehend geparkt)`).toBeGreaterThan(0);
        expect(s.metrics.netProfit, `Scheibe ${i + 1} gegen Fold-Lauf ${i + 1}`).toBeGreaterThan(pf.metrics.netProfit);
      }
    }
    // Scheibe 1 = Fold-Lauf 1 (beide beginnen leer) — bitgleich, wie der Wächter in test/backtest/kette.test.ts verlangt.
    expect(kette.scheiben[0]!.dailyReturns).toEqual(jeFold[0]!.dailyReturns);
    const summeJeFold = jeFold.reduce((s, r) => s + r.metrics.netProfit, 0);
    const summeKette = kette.scheiben.reduce((s, r) => s + r.metrics.netProfit, 0);
    expect(summeKette).toBeGreaterThan(summeJeFold);
    // Zum Protokoll: der Preis des Neustarts je Grenze in dieser Konfiguration (100 000 $, 5 bp, 0,02 %/Tag).
    console.log(`M1: Σ je Fold ${summeJeFold.toFixed(2)} $, Σ Kette ${summeKette.toFixed(2)} $ — Neustart kostet ${((summeKette - summeJeFold) / (folds.length - 1)).toFixed(2)} $ je Grenze bei einem Kandidaten, der nichts tut`);
  });
});
