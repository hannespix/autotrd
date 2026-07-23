/**
 * Tuner-Sicherheits-Tests (Port-Parität zu ai_tuner._safely_expand_grids):
 * Vorschläge MÜSSEN in den harten Bounds bleiben, dürfen NIE Live-Params
 * berühren und ein manipuliertes meta-Doc darf keine Out-of-Bounds-Werte
 * ins Shadow-Gitter schieben (Doppel-Clampung in mergeGrids).
 */
import { describe, expect, it } from 'vitest';
import {
  HARD_LOOKBACK,
  HARD_WEIGHT,
  buildTunerPrompt,
  clampGridProposals,
  mergeGrids,
  parseTunerResponse,
} from '../src/core/tuner.js';

describe('clampGridProposals — harte Bounds', () => {
  it('clampt Lookbacks auf [5, 60] und trunkiert Floats wie int()', () => {
    const exp = clampGridProposals(
      { expandLookback: [4, 5, 30.7, 60, 61, Number.NaN], expandWeight: [] },
      [10, 20],
      [0, 0.5],
    );
    expect(exp.extraLookbacks).toEqual([5, 30, 60]);
    expect(exp.applied).toEqual(['lookback+=5', 'lookback+=30', 'lookback+=60']);
  });

  it('clampt Gewichte auf [0, 1.5] und rundet auf 3 Stellen', () => {
    const exp = clampGridProposals(
      { expandLookback: [], expandWeight: [-0.1, 0.1234, 1.5, 1.501] },
      [10],
      [0, 0.5],
    );
    expect(exp.extraWeights).toEqual([0.123, 1.5]);
    expect(exp.applied).toEqual(['w+=0.123', 'w+=1.5']);
  });

  it('dedupliziert gegen das aktuelle Gitter UND innerhalb des Vorschlags', () => {
    const exp = clampGridProposals(
      { expandLookback: [10, 15, 15], expandWeight: [0.5, 0.75, 0.75] },
      [10, 20, 30],
      [0, 0.25, 0.5],
    );
    expect(exp.extraLookbacks).toEqual([15]);
    expect(exp.extraWeights).toEqual([0.75]);
  });

  it('leerer Vorschlag → keine Erweiterung', () => {
    const exp = clampGridProposals({ expandLookback: [], expandWeight: [] }, [10], [0.5]);
    expect(exp.extraLookbacks).toEqual([]);
    expect(exp.extraWeights).toEqual([]);
    expect(exp.applied).toEqual([]);
  });
});

describe('mergeGrids — Doppel-Clampung gegen manipulierte meta-Docs', () => {
  it('vereint Basis + Extras sortiert', () => {
    const g = mergeGrids([0, 0.5, 1], [10, 20, 30], {
      extraWeights: [0.75, 0.25],
      extraLookbacks: [15, 45],
    });
    expect(g.weightGrid).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(g.lookbackGrid).toEqual([10, 15, 20, 30, 45]);
  });

  it('wirft Out-of-Bounds- und Nicht-Zahlen-Werte aus dem meta-Doc raus', () => {
    const g = mergeGrids([0.5], [20], {
      extraWeights: [99, -1, 'evil', null, 1.5],
      extraLookbacks: [0, 1000, 'x', 60],
    });
    expect(g.weightGrid).toEqual([0.5, 1.5]);
    expect(g.lookbackGrid).toEqual([20, 60]);
  });

  it('fehlendes tuning-Feld → reine Basis-Gitter', () => {
    const g = mergeGrids([0, 1], [10, 20], undefined);
    expect(g.weightGrid).toEqual([0, 1]);
    expect(g.lookbackGrid).toEqual([10, 20]);
  });
});

describe('parseTunerResponse', () => {
  it('parst JSON auch mitten in Prosa', () => {
    const p = parseTunerResponse(
      'Gern! {"diagnosis": "Läuft.", "suggestions": ["mehr Daten"], ' +
        '"expand_lookback": [15, "40"], "expand_weight": [0.6]} — fertig.',
    );
    expect(p).not.toBeNull();
    expect(p!.diagnosis).toBe('Läuft.');
    expect(p!.suggestions).toEqual(['mehr Daten']);
    expect(p!.expandLookback).toEqual([15, 40]);
    expect(p!.expandWeight).toEqual([0.6]);
  });

  it('ohne diagnosis oder ohne JSON → null', () => {
    expect(parseTunerResponse('{"suggestions": []}')).toBeNull();
    expect(parseTunerResponse('kein json hier')).toBeNull();
    expect(parseTunerResponse(null)).toBeNull();
  });
});

describe('buildTunerPrompt', () => {
  it('enthält Statistik, Gitter und das JSON-Format', () => {
    const prompt = buildTunerPrompt(
      { scored: 42, dirAccuracy: 55.5, best: { w: 0.5, lookback: 20 }, topCombos: [] },
      [0, 0.5],
      [10, 20],
    );
    expect(prompt).toContain('"scored":42');
    expect(prompt).toContain('w ∈ [0, 0.5]');
    expect(prompt).toContain('lookback ∈ [10, 20]');
    expect(prompt).toContain('expand_lookback');
  });
});

describe('harte Bounds selbst', () => {
  it('entsprechen der Referenz (_HARD_LOOKBACK=(5,60), _HARD_WEIGHT=(0,1.5))', () => {
    expect(HARD_LOOKBACK).toEqual({ min: 5, max: 60 });
    expect(HARD_WEIGHT).toEqual({ min: 0, max: 1.5 });
  });
});
