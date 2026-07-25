/**
 * Prognose 2.0 Teil 4: genauigkeitsgewichtetes Forecast-Vote — Kante über
 * den Münzwurf skaliert das Stimmgewicht, Evidenz-Gate davor.
 */
import { describe, expect, it } from 'vitest';
import { MIN_TOTAL_SCORES, accuracyWeightedVote } from '../src/forecast.js';

describe('accuracyWeightedVote', () => {
  it('ohne Evidenz (scored < Minimum): Basisgewicht unverändert, factor null', () => {
    const v = accuracyWeightedVote(2, { scored: MIN_TOTAL_SCORES - 1, dirAccuracy: 90 });
    expect(v).toEqual({ weight: 2, factor: null });
  });

  it('fehlende/kaputte Statistik: Basisgewicht unverändert', () => {
    expect(accuracyWeightedVote(3, null).weight).toBe(3);
    expect(accuracyWeightedVote(3, { scored: 50, dirAccuracy: null }).factor).toBeNull();
    expect(accuracyWeightedVote(3, { scored: 50, dirAccuracy: Number.NaN }).factor).toBeNull();
  });

  it('50 % Trefferquote = Münzwurf ⇒ Stimme 0', () => {
    const v = accuracyWeightedVote(2, { scored: 40, dirAccuracy: 50 });
    expect(v.weight).toBe(0);
    expect(v.factor).toBe(0);
  });

  it('unter 50 % ⇒ ebenfalls 0 — NIE contrarian', () => {
    expect(accuracyWeightedVote(2, { scored: 40, dirAccuracy: 35 }).weight).toBe(0);
  });

  it('75 % ⇒ halbes Gewicht, 100 % ⇒ volles Gewicht', () => {
    expect(accuracyWeightedVote(2, { scored: 40, dirAccuracy: 75 })).toEqual({ weight: 1, factor: 0.5 });
    expect(accuracyWeightedVote(2, { scored: 40, dirAccuracy: 100 })).toEqual({ weight: 2, factor: 1 });
  });

  it('nicht-ganzzahliges Basisgewicht wird wie die Konfluenz getrunct', () => {
    expect(accuracyWeightedVote(2.9, { scored: 40, dirAccuracy: 100 }).weight).toBe(2);
  });
});
