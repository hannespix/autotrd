/** Sweep-Planung (M11): Gitter-Clamps, Kombi-Deckel, saubere Anwendung. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY } from '../../shared/src/index.js';
import { applySweepPoint, buildSweepPlan, MAX_COMBOS } from '../src/core/sweep.js';

describe('buildSweepPlan', () => {
  it('baut das Kreuzprodukt zweier Achsen', () => {
    const plan = buildSweepPlan('rsiBuy', [25, 30, 35], 'minConfluence', [1, 2]);
    expect(plan).toHaveLength(6);
    expect(plan[0]).toEqual({ x: 25, y: 1 });
    expect(plan[5]).toEqual({ x: 35, y: 2 });
  });

  it('1D-Sweep ohne Y-Achse → y=null', () => {
    expect(buildSweepPlan('rsiSell', [65, 75])).toEqual([
      { x: 65, y: null },
      { x: 75, y: null },
    ]);
  });

  it('clampt Werte hart auf die Parameter-Bounds', () => {
    const plan = buildSweepPlan('rsiBuy', [-10, 30, 999]);
    expect(plan.map((p) => p.x)).toEqual([5, 30, 45]);
  });

  it('dedupliziert (auch nach Clamp) und sortiert', () => {
    const plan = buildSweepPlan('minConfluence', [9, 5, 2, 2, 7]);
    expect(plan.map((p) => p.x)).toEqual([2, 5]);
  });

  it('lehnt unbekannte Parameter ab', () => {
    expect(() => buildSweepPlan('hebel', [1, 2])).toThrow(/Unbekannter Sweep-Parameter/);
  });

  it('lehnt identische X-/Y-Parameter ab', () => {
    expect(() => buildSweepPlan('rsiBuy', [20], 'rsiBuy', [30])).toThrow(/verschieden/);
  });

  it(`deckelt bei ${MAX_COMBOS} Kombinationen`, () => {
    const eleven = Array.from({ length: 11 }, (_, i) => 5 + i);
    const seven = Array.from({ length: 7 }, (_, i) => 55 + i);
    expect(() => buildSweepPlan('rsiBuy', eleven, 'rsiSell', seven)).toThrow(/Zu viele Kombinationen/);
  });

  it('lehnt leere/unbrauchbare Wertelisten ab', () => {
    expect(() => buildSweepPlan('rsiBuy', [Number.NaN])).toThrow(/Keine gültigen Werte/);
  });
});

describe('applySweepPoint', () => {
  it('schreibt beide Achsen in eine Kopie — Basis bleibt unberührt', () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_STRATEGY));
    const out = applySweepPoint(base, 'rsiBuy', 22, 'minConfluence', 3);
    expect(out.indicators.rsi.thresholdBuy).toBe(22);
    expect(out.signals.minConfluence).toBe(3);
    expect(base.indicators.rsi.thresholdBuy).toBe(DEFAULT_STRATEGY.indicators.rsi.thresholdBuy);
    expect(base.signals.minConfluence).toBe(DEFAULT_STRATEGY.signals.minConfluence);
  });

  it('forecastWeight 0 schaltet useForecast ab, >0 an', () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_STRATEGY));
    expect(applySweepPoint(base, 'forecastWeight', 0).signals.useForecast).toBe(false);
    expect(applySweepPoint(base, 'forecastWeight', 2).signals.useForecast).toBe(true);
  });
});
