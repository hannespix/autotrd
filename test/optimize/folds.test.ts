import { describe, expect, it } from 'vitest';
import { DAY } from '../../src/core/time.ts';
import {
  buildFolds,
  candidateRange,
  dataRangeOf,
  embargoBarsFor,
  embargoedEnd,
  foldPlanForBars,
  lowerBound,
} from '../../src/optimize/walkForward.ts';
import { dailyBars, fakeStrategy, testConfig } from './fakes.ts';

describe('buildFolds', () => {
  const base = { dataStart: 0, dataEnd: 400 * DAY, isDays: 120, oosDays: 30, stepDays: 30, holdoutDays: 30 };

  it('IS und OOS überlappen nie; IS endet genau am OOS-Start', () => {
    const { folds } = buildFolds(base);
    expect(folds.length).toBe(8);
    for (const f of folds) {
      expect(f.isStart).toBeLessThan(f.isEnd);
      expect(f.isEnd).toBe(f.oosStart);
      expect(f.oosStart).toBeLessThan(f.oosEnd);
      expect(f.isEnd - f.isStart).toBe(120 * DAY);
      expect(f.oosEnd - f.oosStart).toBe(30 * DAY);
      expect(f.isStart).toBeGreaterThanOrEqual(base.dataStart);
    }
    expect(folds.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('bei step = oos ist die OOS-Kette lückenlos', () => {
    const { folds } = buildFolds(base);
    for (let k = 1; k < folds.length; k++) {
      expect(folds[k]!.oosStart).toBe(folds[k - 1]!.oosEnd);
    }
  });

  it('step < oos wird auf oos gesetzt (disjunkte Kette) und vermerkt; step > oos wird abgewiesen', () => {
    const plan = buildFolds({ ...base, stepDays: 15 });
    expect(plan.stepDays).toBe(30);
    expect(plan.notes.length).toBe(1);
    expect(plan.notes[0]).toMatch(/stepDays 15 < oosDays 30/);
    for (let k = 1; k < plan.folds.length; k++) expect(plan.folds[k]!.oosStart).toBe(plan.folds[k - 1]!.oosEnd);
    expect(plan.folds.length).toBe(8);
    expect(buildFolds(base).notes).toEqual([]);
    expect(buildFolds(base).stepDays).toBe(30);
    expect(() => buildFolds({ ...base, stepDays: 31 })).toThrow(/Lücken/);
  });

  it('der Holdout am Ende ist für alle Folds tabu', () => {
    const { folds, holdout } = buildFolds(base);
    expect(holdout).toEqual({ start: 370 * DAY, end: 400 * DAY });
    for (const f of folds) expect(f.oosEnd).toBeLessThanOrEqual(holdout!.start);
    expect(folds[folds.length - 1]!.oosEnd).toBe(holdout!.start);
  });

  it('ohne Holdout endet der letzte Fold am Datenende', () => {
    const { folds, holdout } = buildFolds({ ...base, holdoutDays: 0 });
    expect(holdout).toBeNull();
    expect(folds[folds.length - 1]!.oosEnd).toBe(base.dataEnd);
  });

  it('weniger als 3 Folds ⇒ Fehler mit klarer Meldung', () => {
    expect(() => buildFolds({ ...base, dataEnd: 200 * DAY })).toThrow(/mindestens 3 Folds/);
    expect(() => buildFolds({ ...base, dataEnd: 200 * DAY })).toThrow(/lookbackDays/);
    // 3 Folds brauchen genau is + oos + 2·step + holdout Tage
    expect(() => buildFolds({ ...base, dataEnd: (120 + 30 + 60 + 30) * DAY })).not.toThrow();
    expect(() => buildFolds({ ...base, dataEnd: (120 + 30 + 60 + 30) * DAY - 1 })).toThrow(/möglich: 2/);
  });

  it('ungültige Fenster werden abgewiesen', () => {
    expect(() => buildFolds({ ...base, isDays: 0 })).toThrow(/ungültige Fenster/);
    expect(() => buildFolds({ ...base, dataEnd: 0 })).toThrow(/dataEnd/);
  });
});

describe('Embargo', () => {
  const bars = dailyBars(400);

  it('lowerBound zählt die Bars vor einem Zeitpunkt', () => {
    expect(lowerBound(bars.t, bars.t[0]!)).toBe(0);
    expect(lowerBound(bars.t, bars.t[10]!)).toBe(10);
    expect(lowerBound(bars.t, bars.t[10]! + 1)).toBe(11);
    expect(lowerBound(bars.t, bars.t[399]! + DAY)).toBe(400);
  });

  it('verkürzt das IS-Ende um genau embargoBars Bars', () => {
    const isStart = bars.t[100]!;
    const isEnd = bars.t[200]!;
    expect(embargoedEnd(bars, isStart, isEnd, 0)).toBe(isEnd);
    expect(embargoedEnd(bars, isStart, isEnd, 10)).toBe(bars.t[190]!);
    expect(embargoedEnd(bars, isStart, isEnd, 1)).toBe(bars.t[199]!);
    // Anzahl entscheidbarer Bars im Fenster sinkt exakt um das Embargo
    const cut = embargoedEnd(bars, isStart, isEnd, 10);
    expect(lowerBound(bars.t, cut) - lowerBound(bars.t, isStart)).toBe(90);
  });

  it('ein Embargo, das das ganze Fenster frisst, liefert ein leeres Fenster — candidateRange wirft', () => {
    const isStart = bars.t[100]!;
    const isEnd = bars.t[200]!;
    expect(embargoedEnd(bars, isStart, isEnd, 100)).toBe(isStart);
    expect(embargoedEnd(bars, isStart, isEnd, 500)).toBe(isStart);
    const strategy = fakeStrategy('s', { warmup: 90 });
    const cfg = testConfig();
    // automatisch: 90 + 20 = 110 Bars > 100 Bars Fenster
    expect(() => candidateRange(bars, { start: isStart, end: isEnd }, strategy, strategy.defaults, cfg.optimizer, true)).toThrow(/Embargo/);
    // ohne Embargo am Ende bleibt das Fenster unverändert
    expect(candidateRange(bars, { start: isStart, end: isEnd }, strategy, strategy.defaults, cfg.optimizer, false)).toEqual({ start: isStart, end: isEnd });
  });

  it('embargoBarsFor: konfiguriert schlägt automatisch (Warmup + 20)', () => {
    const strategy = fakeStrategy('s', { warmup: 7 });
    expect(embargoBarsFor(strategy, strategy.defaults, testConfig().optimizer)).toBe(27);
    expect(embargoBarsFor(strategy, strategy.defaults, testConfig({ optimizer: { embargoBars: 3 } }).optimizer)).toBe(3);
  });

  it('foldPlanForBars nutzt den Datenbereich der Serie', () => {
    const cfg = testConfig();
    const range = dataRangeOf(bars);
    expect(range).toEqual({ start: bars.t[0]!, end: bars.t[399]! + 1 });
    const plan = foldPlanForBars(bars, cfg.optimizer);
    expect(plan.holdout).toEqual({ start: range.end - 30 * DAY, end: range.end });
    expect(plan.folds.length).toBe(8);
    // Holdout enthält genau die letzten 30 Bars
    expect(lowerBound(bars.t, plan.holdout!.start)).toBe(370);
  });
});
