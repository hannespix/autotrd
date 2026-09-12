/**
 * Der Faktor des Vola-Ziels im Sizing (src/risk/sizing.ts).
 *
 * Hier bewegt der Faktor Geld: Er skaliert das BUDGET beider Semantiken. Die
 * Wächter sind deshalb die Fälle, in denen ein Skalierungsfehler Geld kostet:
 *
 *  (a) Ein Faktor 2,0 darf `maxPositionPct` NICHT aushebeln — sonst stünde
 *      nach einer ruhigen Phase die doppelte Position im Depot, die der
 *      Nutzer nie erlaubt hat.
 *  (b) Dasselbe für Exposure-Budget und Bargeld: Ein Faktor darf kein
 *      Margin-Konto erfinden.
 *  (c) Ein Faktor 0 oder Unsinn (NaN, negativ) darf nicht heimlich zu einer
 *      RIESIGEN Position führen (Division, Vorzeichen) — 0 heißt keine
 *      Position, Unsinn heißt Faktor 1.
 *  (d) Ohne Faktor (Vorgabe) ist die Stückzahl auf den Cent dieselbe wie
 *      vorher — das Feld darf kein Messergebnis still verschieben.
 */
import { describe, expect, it } from 'vitest';
import { sizePosition } from '../../src/risk/sizing.ts';

const base = {
  equity: 10_000,
  cash: 10_000,
  price: 100,
  stop: 98,
  side: 'long' as const,
  riskPct: 0.5,
  maxPositionPct: 100,
  exposureBudget: 10_000,
  qtyStep: 1,
};

describe('sizePosition mit volFaktor', () => {
  it('WÄCHTER (d): kein Faktor ⇒ exakt wie ohne das Feld', () => {
    const ohne = sizePosition(base);
    expect(sizePosition({ ...base, volFaktor: 1 }).qty).toBe(ohne.qty);
    expect(sizePosition({ ...base, volFaktor: undefined }).qty).toBe(ohne.qty);
    expect(ohne.qty).toBe(25); // 10 000 × 0,5 % / 2 $
  });

  it('skaliert das Risiko-Budget', () => {
    expect(sizePosition({ ...base, volFaktor: 2 }).qty).toBe(50);
    expect(sizePosition({ ...base, volFaktor: 0.5 }).qty).toBe(12); // 12,5 ⇒ abgerundet
  });

  it('skaliert das Allokations-Budget der Basis-Stufe', () => {
    const alloc = { ...base, stop: 80, sizing: { mode: 'allocation' as const, positionPct: 20 } };
    expect(sizePosition(alloc).qty).toBe(20);
    expect(sizePosition({ ...alloc, volFaktor: 1.5 }).qty).toBe(30);
    expect(sizePosition({ ...alloc, volFaktor: 0.25 }).qty).toBe(5);
  });

  it('WÄCHTER (a): der Positionsdeckel des Nutzers schlägt den Faktor', () => {
    // Budget mit Faktor 2: 50 Stück. Deckel 20 % = 2 000 $ = 20 Stück.
    const r = sizePosition({ ...base, maxPositionPct: 20, volFaktor: 2 });
    expect(r.qty).toBe(20);
    expect(r.notional).toBe(2_000);
    // Auch in der Allokations-Semantik: 20 % × 2 = 40 % gewollt, Deckel 25 %.
    const alloc = sizePosition({ ...base, stop: 80, maxPositionPct: 25, sizing: { mode: 'allocation', positionPct: 20 }, volFaktor: 2 });
    expect(alloc.qty).toBe(25);
  });

  it('WÄCHTER (b): Exposure-Budget und Bargeld schlagen den Faktor', () => {
    expect(sizePosition({ ...base, exposureBudget: 1_000, volFaktor: 2 }).qty).toBe(10);
    expect(sizePosition({ ...base, cash: 700, volFaktor: 2 }).qty).toBe(7);
    // Short braucht kein Bargeld, aber das Exposure-Budget gilt.
    expect(sizePosition({ ...base, side: 'short', stop: 102, cash: 0, exposureBudget: 900, volFaktor: 2 }).qty).toBe(9);
  });

  it('WÄCHTER (c): Faktor 0 ⇒ keine Position; Unsinn ⇒ Faktor 1, nie eine riesige', () => {
    const null0 = sizePosition({ ...base, volFaktor: 0 });
    expect(null0.qty).toBe(0);
    expect(null0.reason).toMatch(/Risiko-Budget/);
    for (const kaputt of [Number.NaN, Number.POSITIVE_INFINITY, -2]) {
      expect(sizePosition({ ...base, volFaktor: kaputt }).qty).toBe(25);
    }
  });

  it('ohne Stop auf der Verlustseite gibt es auch mit Faktor keine Stückzahl', () => {
    expect(sizePosition({ ...base, stop: 101, volFaktor: 2 }).qty).toBe(0);
    expect(sizePosition({ ...base, equity: 0, volFaktor: 2 }).qty).toBe(0);
  });
});
