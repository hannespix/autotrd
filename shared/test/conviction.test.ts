/**
 * Überzeugungs-Sizing — zentral sind zwei Eigenschaften: Über 1,25 kommt
 * NUR bewiesene Kante (realisierte Steckbrief-Trades), und nachweislich
 * schwache Sorten werden gedämpft, bevor der harte Block greift.
 */

import { describe, expect, it } from 'vitest';
import {
  CONVICTION_MAX,
  CONVICTION_MIN,
  CONVICTION_MIN_SAMPLES,
  convictionFactor,
} from '../src/conviction.js';
import { updateBucket, type BucketStat } from '../src/tradeFilter.js';

const fuellen = (pnls: number[]): BucketStat =>
  pnls.reduce<BucketStat>((s, p) => updateBucket(s, p), { n: 0, wins: 0, pnlSum: 0, pnlSqSum: 0 });

/** n Trades mit klar positivem Erwartungswert (t deutlich > 1,5). */
const gewinner = (n: number): BucketStat =>
  fuellen(Array.from({ length: n }, (_, i) => (i % 4 === 0 ? -2 : 3)));

/** n Trades mit klar negativem Erwartungswert. */
const verlierer = (n: number): BucketStat =>
  fuellen(Array.from({ length: n }, (_, i) => (i % 4 === 0 ? 2 : -3)));

describe('convictionFactor', () => {
  it('Grenzsignal ohne Evidenz ⇒ genau 1 (Basiseinsatz)', () => {
    expect(convictionFactor({ konfluenz: 2, requiredConfluence: 2 })).toBe(1);
    expect(convictionFactor({ konfluenz: 2, requiredConfluence: 2, bucket: null })).toBe(1);
  });

  it('Konfluenz-Überschuss hebt an — aber höchstens auf 1,25', () => {
    expect(convictionFactor({ konfluenz: 3, requiredConfluence: 2 })).toBe(1.125);
    expect(convictionFactor({ konfluenz: 6, requiredConfluence: 2 })).toBe(1.25);
    // Enthusiasmus allein erreicht NIE das Maximum — dafür braucht es Beweise
    expect(convictionFactor({ konfluenz: 99, requiredConfluence: 2 })).toBeLessThan(CONVICTION_MAX);
  });

  it('bewiesene Kante (t ≥ 1,5 über ≥ 15 Trades) schaltet die Verstärkung frei', () => {
    const f = convictionFactor({ konfluenz: 6, requiredConfluence: 2, bucket: gewinner(30) });
    expect(f).toBe(CONVICTION_MAX);
  });

  it('unter MIN_SAMPLES zählt auch eine Gewinnserie nicht', () => {
    const f = convictionFactor({
      konfluenz: 2,
      requiredConfluence: 2,
      bucket: gewinner(CONVICTION_MIN_SAMPLES - 1),
    });
    expect(f).toBe(1);
  });

  it('nachweislich schwache Sorte wird halbiert — vor dem harten Block', () => {
    expect(convictionFactor({ konfluenz: 2, requiredConfluence: 2, bucket: verlierer(20) })).toBe(0.5);
  });

  it('Dämpfung endet nie unter dem Boden (0,25) — null ist Sache des Blocks', () => {
    const f = convictionFactor({ konfluenz: 0, requiredConfluence: 2, bucket: verlierer(200) });
    expect(f).toBeGreaterThanOrEqual(CONVICTION_MIN);
  });

  it('Überschuss und schwache Evidenz verrechnen sich ehrlich', () => {
    // 1,25 × 0,5 = 0,625 — die Dämpfung wirkt auf den GESAMTEN Einsatz,
    // Enthusiasmus kauft sich nicht an bewiesener Schwäche vorbei.
    expect(convictionFactor({ konfluenz: 6, requiredConfluence: 2, bucket: verlierer(20) })).toBe(0.625);
  });

  it('kaputte Eingaben ⇒ neutraler Faktor 1', () => {
    expect(convictionFactor({ konfluenz: Number.NaN, requiredConfluence: 2 })).toBe(1);
  });
});
