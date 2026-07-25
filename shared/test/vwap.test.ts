/**
 * Session-VWAP (Chart-Vision): kumulativ je Handelstag, Reset bei
 * Session-Lücken > 60 min, robust bei Null-Volumen.
 */
import { describe, expect, it } from 'vitest';
import { vwapSessions, type VwapBar } from '../src/indicators.js';

const bar = (time: number, price: number, volume: number): VwapBar => ({
  time,
  high: price + 1,
  low: price - 1,
  close: price,
  volume,
});
// typischer Preis von bar(t, p, v) = ((p+1) + (p−1) + p) / 3 = p

describe('vwapSessions', () => {
  it('kumuliert typischen Preis × Volumen innerhalb der Session', () => {
    const v = vwapSessions([bar(0, 100, 10), bar(300, 110, 30), bar(600, 90, 0)]);
    expect(v[0]).toBeCloseTo(100);
    // (100·10 + 110·30) / 40 = 107.5
    expect(v[1]).toBeCloseTo(107.5);
    // Null-Volumen schreibt den letzten VWAP fort
    expect(v[2]).toBeCloseTo(107.5);
  });

  it('setzt bei einer Lücke > 60 min auf die neue Session zurück', () => {
    const v = vwapSessions([
      bar(0, 100, 10),
      bar(300, 120, 10),
      bar(300 + 5 * 3600, 50, 10), // nächster Handelstag
      bar(600 + 5 * 3600, 60, 10),
    ]);
    expect(v[1]).toBeCloseTo(110);
    expect(v[2]).toBeCloseTo(50); // frisch, ohne Vortages-Gewicht
    expect(v[3]).toBeCloseTo(55);
  });

  it('bleibt null, solange die Session kein Volumen hat', () => {
    const v = vwapSessions([bar(0, 100, 0), bar(300, 101, 0), bar(600, 102, 5)]);
    expect(v[0]).toBeNull();
    expect(v[1]).toBeNull();
    expect(v[2]).toBeCloseTo(102);
    expect(vwapSessions([])).toEqual([]);
  });
});
