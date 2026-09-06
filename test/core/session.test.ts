import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { buildSessionInfo } from '../../src/core/session.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';

function day5min(d: number, untilMinute = 15 * 60 + 55): Bar[] {
  const out: Bar[] = [];
  for (let m = 9 * 60 + 30; m <= untilMinute; m += 5) {
    out.push({ t: msFromET(2026, 9, d, Math.floor(m / 60), m % 60), o: 1, h: 2, l: 0.5, c: 1, v: 1 });
  }
  return out;
}

describe('buildSessionInfo (Aktien, 5 min)', () => {
  const s = BarSeries.from([...day5min(3), ...day5min(4)]);
  const perDay = 78;

  it('erste Bar des Tages', () => {
    const si = buildSessionInfo(s, perDay, 5, 'us_equity');
    expect(si.day).toBe('2026-09-04');
    expect(si.barsSinceOpen).toBe(1);
    expect(si.minutesSinceOpen).toBe(5);
    expect(si.minutesToClose).toBe(385);
    expect(si.isLastBarOfDay).toBe(false);
    expect(si.isRegularSession).toBe(true);
  });

  it('vorletzte und letzte Bar des Tages', () => {
    const prev = buildSessionInfo(s, s.length - 2, 5, 'us_equity');
    expect(prev.minutesToClose).toBe(5);
    expect(prev.isLastBarOfDay).toBe(false);
    const last = buildSessionInfo(s, s.length - 1, 5, 'us_equity');
    expect(last.minutesToClose).toBe(0);
    expect(last.isLastBarOfDay).toBe(true);
    expect(last.barsSinceOpen).toBe(perDay);
  });

  it('ein abgeschnittener Tag endet mit der letzten vorhandenen Bar, wenn ein neuer Tag folgt', () => {
    const cut = BarSeries.from([...day5min(3, 12 * 60), ...day5min(4)]);
    const idx = day5min(3, 12 * 60).length - 1;
    expect(buildSessionInfo(cut, idx, 5, 'us_equity').isLastBarOfDay).toBe(true);
  });

  it('Frühschluss laut Kalender', () => {
    const cal = new Map([['2026-09-04', { date: '2026-09-04', open: '09:30', close: '13:00' }]]);
    const s2 = BarSeries.from(day5min(4, 12 * 60 + 55));
    const si = buildSessionInfo(s2, s2.length - 1, 5, 'us_equity', cal);
    expect(si.minutesToClose).toBe(0);
    expect(si.isLastBarOfDay).toBe(true);
  });

  it('Tagesbars sind immer letzte Bar des Tages', () => {
    const daily = BarSeries.from([
      { t: msFromET(2026, 9, 3, 9, 30), o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: msFromET(2026, 9, 4, 9, 30), o: 1, h: 1, l: 1, c: 1, v: 1 },
    ]);
    expect(buildSessionInfo(daily, 1, 1440, 'us_equity').isLastBarOfDay).toBe(true);
    expect(buildSessionInfo(daily, 1, 1440, 'us_equity').minutesToClose).toBe(0);
  });
});

describe('buildSessionInfo (Krypto)', () => {
  it('kennt keinen Schluss', () => {
    const s = BarSeries.from([{ t: Date.UTC(2026, 8, 6, 0, 0), o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    const si = buildSessionInfo(s, 0, 5, 'crypto');
    expect(si.minutesToClose).toBeNull();
    expect(si.isRegularSession).toBe(true);
    expect(si.isLastBarOfDay).toBe(false);
  });
});
