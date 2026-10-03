/** Heikin-Ashi (TV-Parität): Glättung, Kausalität, Hüll-Eigenschaften. */
import { describe, expect, it } from 'vitest';
import { heikinAshi } from '../src/indicators.js';

const bar = (o: number, h: number, l: number, c: number) => ({ open: o, high: h, low: l, close: c });

describe('heikinAshi', () => {
  it('erste Kerze: haOpen = (O+C)/2, haClose = OHLC-Mittel', () => {
    const [ha] = heikinAshi([bar(10, 14, 8, 12)]);
    expect(ha!.open).toBe(11);
    expect(ha!.close).toBe(11);
  });

  it('haOpen folgt KAUSAL aus der vorherigen HA-Kerze', () => {
    const out = heikinAshi([bar(10, 14, 8, 12), bar(12, 16, 11, 15)]);
    expect(out[1]!.open).toBe((out[0]!.open + out[0]!.close) / 2);
  });

  it('High/Low umschließen Original-Extreme und HA-Körper', () => {
    const out = heikinAshi([bar(10, 14, 8, 12), bar(12, 16, 11, 15), bar(15, 15.5, 13, 13.5)]);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!.high).toBeGreaterThanOrEqual(Math.max(out[i]!.open, out[i]!.close));
      expect(out[i]!.low).toBeLessThanOrEqual(Math.min(out[i]!.open, out[i]!.close));
    }
  });

  it('Zusatz-Felder (Zeit, Volumen) bleiben erhalten', () => {
    const out = heikinAshi([{ ...bar(10, 14, 8, 12), date: '2026-01-02', volume: 5 }]);
    expect(out[0]).toMatchObject({ date: '2026-01-02', volume: 5 });
  });

  it('leere Eingabe → leer', () => {
    expect(heikinAshi([])).toEqual([]);
  });
});
