/**
 * Wächter: `sessionInfoIncremental` (O(1) im Simulator) muss für JEDE Bar
 * exakt dasselbe liefern wie `buildSessionInfo(series.prefix(i+1), i, …)`
 * — die Sicht der Live-Engine. Weicht core/session.ts irgendwann ab,
 * wird dieser Test rot, bevor der Backtest etwas anderes misst als live.
 */
import { describe, expect, it } from 'vitest';
import { sessionInfoIncremental } from '../../src/backtest/simulator.ts';
import { randomWalkBars } from '../../src/backtest/synthetic.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { buildSessionInfo } from '../../src/core/session.ts';
import { dayKeyFor, msFromET, sessionBounds, type Calendar } from '../../src/core/time.ts';
import type { AssetClass, TimeframeMin } from '../../src/core/types.ts';

function compare(tf: TimeframeMin, assetClass: AssetClass, n: number, start: number, calendar?: Calendar): void {
  const series = BarSeries.from(randomWalkBars({ seed: 11, n, start, tf, assetClass, calendar }));
  let prevDay = '';
  let barsSinceOpen = 0;
  for (let i = 0; i < series.length; i++) {
    const t = series.t[i]!;
    const day = dayKeyFor(t, assetClass);
    barsSinceOpen = day === prevDay ? barsSinceOpen + 1 : 1;
    prevDay = day;
    const bounds = assetClass === 'crypto' ? null : sessionBounds(day, assetClass, calendar);
    const fast = sessionInfoIncremental({ t, day, barsSinceOpen, tf, assetClass, bounds });
    const ref = buildSessionInfo(series.prefix(i + 1), i, tf, assetClass, calendar);
    expect(fast).toEqual(ref);
  }
}

describe('sessionInfoIncremental ≡ buildSessionInfo (Präfix-Sicht)', () => {
  const start = msFromET(2025, 7, 2, 9, 30); // über Frühschluss 03.07., Feiertag 04.07., Wochenende
  it('5 min Aktien', () => compare(5, 'us_equity', 400, start));
  it('1 min Aktien', () => compare(1, 'us_equity', 1_200, start));
  it('60 min Aktien (verkürzter letzter Bucket)', () => compare(60, 'us_equity', 40, start));
  it('Tagesbars', () => compare(1440, 'us_equity', 12, start));
  it('Krypto 60 min über UTC-Tageswechsel', () => compare(60, 'crypto', 100, Date.UTC(2025, 6, 4, 20, 0)));
  it('mit Broker-Kalender (abweichender Frühschluss)', () => {
    const cal: Calendar = new Map([
      ['2025-07-02', { date: '2025-07-02', open: '09:30', close: '16:00' }],
      ['2025-07-03', { date: '2025-07-03', open: '09:30', close: '12:00' }],
      ['2025-07-07', { date: '2025-07-07', open: '09:30', close: '16:00' }],
    ]);
    compare(15, 'us_equity', 60, start, cal);
  });
});
