/** Auto-Auflösung (Chart): 5m-Bars zu größeren Kerzen bündeln. */
import { describe, expect, it } from 'vitest';
import { aggregateBars, type AggBar } from '../src/indicators.js';

const bar = (time: number, o: number, h: number, l: number, c: number, v = 1): AggBar => ({
  time,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('aggregateBars', () => {
  it('bündelt 5m-Bars OHLCV-korrekt zu 15m-Kerzen', () => {
    const t0 = 1_753_395_300; // beliebiger 5m-Rasterpunkt
    const base = Math.floor(t0 / 900) * 900;
    const out = aggregateBars(
      [bar(base, 10, 12, 9, 11, 100), bar(base + 300, 11, 15, 11, 14, 50), bar(base + 600, 14, 14, 8, 9, 25)],
      15,
    );
    expect(out).toEqual([bar(base, 10, 15, 8, 9, 175)]);
  });

  it('startet neue Kerzen an Bucket-Grenzen (auch mit Lücken)', () => {
    const out = aggregateBars([bar(0, 1, 1, 1, 1), bar(900, 2, 2, 2, 2), bar(7200, 3, 3, 3, 3)], 15);
    expect(out.map((b) => b.time)).toEqual([0, 900, 7200]);
  });

  it('minutes ≤ 0 lässt die Bars unangetastet (Kopie)', () => {
    const src = [bar(1, 1, 2, 0, 1)];
    const out = aggregateBars(src, 0);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(aggregateBars([], 15)).toEqual([]);
  });
});
