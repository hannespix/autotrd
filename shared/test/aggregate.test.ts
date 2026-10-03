/** Auto-Auflösung (Chart): 5m-Bars zu größeren Kerzen bündeln. */
import { describe, expect, it } from 'vitest';
import {
  aggregateBars,
  aggregateDailyBars,
  wochenMontag,
  type AggBar,
  type DailyAggBar,
} from '../src/indicators.js';

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

const tag = (date: string, o: number, h: number, l: number, c: number, v = 1): DailyAggBar => ({
  date,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('wochenMontag', () => {
  it('findet den Montag der ISO-Woche', () => {
    expect(wochenMontag('2026-08-06')).toBe('2026-08-03'); // Do → Mo derselben Woche
    expect(wochenMontag('2026-08-03')).toBe('2026-08-03'); // Mo bleibt Mo
    expect(wochenMontag('2026-08-09')).toBe('2026-08-03'); // So gehört noch zur Woche
    expect(wochenMontag('2026-01-01')).toBe('2025-12-29'); // Jahreswechsel-Woche
  });
});

describe('aggregateDailyBars', () => {
  // Mo 03.08. – Fr 07.08. + Mo 10.08. (zwei ISO-Wochen)
  const woche = [
    tag('2026-08-03', 10, 12, 9, 11, 100),
    tag('2026-08-04', 11, 15, 11, 14, 50),
    tag('2026-08-06', 14, 14, 8, 9, 25), // Mi fehlt (Feiertag) — egal
    tag('2026-08-07', 9, 10, 9, 10, 10),
    tag('2026-08-10', 10, 11, 10, 11, 5),
  ];

  it('bündelt Handelstage OHLCV-korrekt zu Wochenkerzen', () => {
    const out = aggregateDailyBars(woche, 'week');
    expect(out).toEqual([tag('2026-08-03', 10, 15, 8, 10, 185), tag('2026-08-10', 10, 11, 10, 11, 5)]);
  });

  it('Wochenkerze trägt den ERSTEN Handelstag, nicht den Kalender-Montag', () => {
    // Woche beginnt erst am Dienstag (Montag = Feiertag)
    const out = aggregateDailyBars([tag('2026-08-04', 1, 2, 1, 2), tag('2026-08-05', 2, 3, 2, 3)], 'week');
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2026-08-04');
  });

  it('bündelt nach Kalendermonat', () => {
    const out = aggregateDailyBars(
      [tag('2026-07-30', 1, 2, 1, 2, 3), tag('2026-07-31', 2, 4, 2, 3, 3), tag('2026-08-03', 3, 3, 1, 1, 3)],
      'month',
    );
    expect(out).toEqual([tag('2026-07-30', 1, 4, 1, 3, 6), tag('2026-08-03', 3, 3, 1, 1, 3)]);
  });

  it('leere Eingabe bleibt leer', () => {
    expect(aggregateDailyBars([], 'week')).toEqual([]);
  });
});
