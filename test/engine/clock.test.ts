import { describe, expect, it } from 'vitest';
import { AlpacaError } from '../../src/alpaca/types.ts';
import { HOUR, msFromET } from '../../src/core/time.ts';
import { MarketClock } from '../../src/engine/clock.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';

describe('MarketClock', () => {
  it('Krypto ist immer offen', () => {
    const c = new MarketClock({ assetClass: 'crypto', calendar: undefined, client: null });
    expect(c.isOpen(Date.UTC(2026, 8, 5, 3, 0))).toBe(true);
    expect(c.today(Date.UTC(2026, 8, 5, 3, 0))).toBe('2026-09-05');
    expect(c.nextTradingDay(Date.UTC(2026, 8, 5, 3, 0))).toBe('2026-09-06');
  });

  it('rechnet ohne Broker über den Kalender (Werktag offen, Samstag zu, Feiertag zu)', () => {
    const c = new MarketClock({ assetClass: 'us_equity', calendar: undefined, client: null });
    expect(c.isOpen(msFromET(2026, 9, 1, 10, 0))).toBe(true);
    expect(c.isOpen(msFromET(2026, 9, 1, 16, 0))).toBe(false);
    expect(c.isOpen(msFromET(2026, 9, 5, 10, 0))).toBe(false);
    expect(c.isOpen(msFromET(2026, 9, 7, 10, 0))).toBe(false); // Labor Day
    expect(c.nextTradingDay(msFromET(2026, 9, 4, 10, 0))).toBe('2026-09-08');
    expect(c.sessionBoundsToday(msFromET(2026, 9, 1, 10, 0))?.minutes).toBe(390);
  });

  it('übersteuert mit /v2/clock, ersetzt den Kalender aber nicht bei Ausfall', async () => {
    const fake = new FakeAlpaca();
    const at = msFromET(2026, 9, 1, 10, 0);
    // Broker sagt: außerplanmäßig geschlossen bis 12:00, dann offen bis 13:00.
    fake.clock = { timestamp: at, isOpen: false, nextOpen: msFromET(2026, 9, 1, 12, 0), nextClose: msFromET(2026, 9, 1, 13, 0) };
    const c = new MarketClock({ assetClass: 'us_equity', calendar: undefined, client: fake, now: () => at });
    await c.refresh();
    expect(c.isOpen(at)).toBe(false);
    expect(c.isOpen(msFromET(2026, 9, 1, 12, 30))).toBe(true); // nach nextOpen: Kalender (Sitzung)
    // Frühschluss laut Broker, wenn offen: sessionBoundsToday übernimmt den früheren Schluss.
    fake.clock = { timestamp: at, isOpen: true, nextOpen: msFromET(2026, 9, 2, 9, 30), nextClose: msFromET(2026, 9, 1, 13, 0) };
    await c.refresh();
    expect(c.isOpen(msFromET(2026, 9, 1, 14, 0))).toBe(false);
    expect(c.sessionBoundsToday(at)?.close).toBe(msFromET(2026, 9, 1, 13, 0));
    expect(c.sessionBoundsToday(at)?.minutes).toBe(210);
    // Ausfall: letzter Stand bleibt, Kalender gilt für alles außerhalb des bekannten Fensters.
    fake.throwOn('getClock', new AlpacaError('down', 503, null, true));
    await c.refresh();
    expect(c.snapshot()?.nextClose).toBe(msFromET(2026, 9, 1, 13, 0));
    expect(c.isOpen(msFromET(2026, 9, 2, 10, 0))).toBe(true);
    expect(c.isOpen(at + 24 * HOUR + 7 * HOUR)).toBe(false);
  });
});
