import { describe, expect, it } from 'vitest';
import { mulberry32, randomWalkBars, sessionBucketTimes, trendingBars } from '../../src/backtest/synthetic.ts';
import { bucketStart, dayKeyFor, isTradingDay, msFromET, sessionBounds, toET, MIN } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';

function checkInvariants(bars: Bar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
    expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
    expect(b.v).toBeGreaterThan(0);
    expect(b.l).toBeGreaterThan(0);
    if (i > 0) expect(b.t).toBeGreaterThan(bars[i - 1]!.t);
  }
}

describe('mulberry32', () => {
  it('deterministisch je Seed, Werte in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
  });
});

describe('randomWalkBars (Aktien, 5 min)', () => {
  // Donnerstag 2025-07-03 (Frühschluss 13:00), Freitag 2025-07-04 Feiertag, dann Wochenende.
  const start = msFromET(2025, 7, 3, 9, 30);
  const bars = randomWalkBars({ seed: 1, n: 200, start, tf: 5, assetClass: 'us_equity' });

  it('liefert nur Sitzungs-Buckets 09:30–16:00 ET, keine Wochenenden/Feiertage', () => {
    expect(bars).toHaveLength(200);
    for (const b of bars) {
      const day = dayKeyFor(b.t, 'us_equity');
      expect(isTradingDay(day, 'us_equity')).toBe(true);
      const bounds = sessionBounds(day, 'us_equity')!;
      expect(bucketStart(b.t, 5, bounds)).toBe(b.t);
      const et = toET(b.t);
      expect(et.minuteOfDay).toBeGreaterThanOrEqual(570);
      expect(et.minuteOfDay).toBeLessThan(960);
      expect([0, 6]).not.toContain(et.weekday);
    }
    const days = [...new Set(bars.map((b) => dayKeyFor(b.t, 'us_equity')))];
    // 42 (Frühschluss 13:00) + 78 + 78 = 198 ⇒ zwei Bars laufen in den 09.07.
    expect(days).toEqual(['2025-07-03', '2025-07-07', '2025-07-08', '2025-07-09']);
    expect(bars.filter((b) => dayKeyFor(b.t, 'us_equity') === '2025-07-03')).toHaveLength(42);
    expect(bars.filter((b) => dayKeyFor(b.t, 'us_equity') === '2025-07-09')).toHaveLength(2);
  });

  it('h/l-Invarianten, Volumen > 0, streng steigend', () => {
    checkInvariants(bars);
  });

  it('deterministisch je Seed, verschieden bei anderem Seed', () => {
    const again = randomWalkBars({ seed: 1, n: 200, start, tf: 5, assetClass: 'us_equity' });
    expect(again).toEqual(bars);
    const other = randomWalkBars({ seed: 2, n: 200, start, tf: 5, assetClass: 'us_equity' });
    expect(other.map((b) => b.c)).not.toEqual(bars.map((b) => b.c));
  });

  it('Start mitten in der Sitzung beginnt mit dem enthaltenden Bucket', () => {
    const mid = msFromET(2025, 7, 7, 10, 3);
    const t = sessionBucketTimes({ start: mid, n: 3, tf: 5, assetClass: 'us_equity' });
    expect(t[0]).toBe(msFromET(2025, 7, 7, 10, 0));
    expect(t[1]).toBe(t[0]! + 5 * MIN);
  });

  it('Tagesbars: eine je Handelstag an der Eröffnung', () => {
    const d = randomWalkBars({ seed: 3, n: 5, start, tf: 1440, assetClass: 'us_equity' });
    expect(d.map((b) => dayKeyFor(b.t, 'us_equity'))).toEqual(['2025-07-03', '2025-07-07', '2025-07-08', '2025-07-09', '2025-07-10']);
    for (const b of d) expect(toET(b.t).minuteOfDay).toBe(570);
  });
});

describe('randomWalkBars (Krypto)', () => {
  it('rund um die Uhr, UTC-Tage, 60-min-Raster', () => {
    const start = Date.UTC(2025, 6, 5, 22, 0); // Samstag — Krypto handelt trotzdem
    const bars = randomWalkBars({ seed: 5, n: 30, start, tf: 60, assetClass: 'crypto' });
    expect(bars).toHaveLength(30);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!.t - bars[i - 1]!.t).toBe(60 * MIN);
    expect(bars[0]!.t).toBe(start);
    checkInvariants(bars);
  });
});

describe('trendingBars', () => {
  it('folgt der Geraden: positiver Slope ⇒ Ende deutlich über Start, negativer bleibt positiv', () => {
    const start = msFromET(2025, 7, 7, 9, 30);
    const up = trendingBars({ seed: 9, n: 300, start, tf: 5, assetClass: 'us_equity', startPrice: 100, slope: 0.1, volPerBar: 0.001 });
    checkInvariants(up);
    expect(up[299]!.c).toBeGreaterThan(120);
    const down = trendingBars({ seed: 9, n: 300, start, tf: 5, assetClass: 'us_equity', startPrice: 10, slope: -1, volPerBar: 0.001 });
    checkInvariants(down);
    expect(Math.min(...down.map((b) => b.l))).toBeGreaterThan(0);
  });
});
