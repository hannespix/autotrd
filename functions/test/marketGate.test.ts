/**
 * US-Marktzeiten-Gate (Port von reference/deploy/run_scan.sh):
 * Mo–Fr, 09:30 ≤ t < 16:00 in America/New_York. Feste Zeitpunkte inkl.
 * DST-Fall — im Sommer ist 13:30 UTC = 09:30 EDT, im Winter 14:30 UTC.
 */
import { describe, expect, it } from 'vitest';
import { isUsMarketOpen } from '../src/scheduled/scanMarket.js';

describe('isUsMarketOpen', () => {
  it('Mittwoch 12:00 ET (Sommer) → offen', () => {
    expect(isUsMarketOpen(new Date('2026-07-22T16:00:00Z'))).toBe(true); // 12:00 EDT
  });

  it('Handelsbeginn 09:30 ET inklusiv, 09:29 ET nicht', () => {
    expect(isUsMarketOpen(new Date('2026-07-22T13:30:00Z'))).toBe(true); // 09:30 EDT
    expect(isUsMarketOpen(new Date('2026-07-22T13:29:00Z'))).toBe(false); // 09:29 EDT
  });

  it('Handelsschluss 16:00 ET exklusiv', () => {
    expect(isUsMarketOpen(new Date('2026-07-22T19:59:00Z'))).toBe(true); // 15:59 EDT
    expect(isUsMarketOpen(new Date('2026-07-22T20:00:00Z'))).toBe(false); // 16:00 EDT
  });

  it('Wochenende → zu', () => {
    expect(isUsMarketOpen(new Date('2026-07-25T15:00:00Z'))).toBe(false); // Samstag
    expect(isUsMarketOpen(new Date('2026-07-26T15:00:00Z'))).toBe(false); // Sonntag
  });

  it('DST-Winter: 14:00 UTC ist erst 09:00 EST → zu; 14:30 UTC = 09:30 → offen', () => {
    expect(isUsMarketOpen(new Date('2026-01-21T14:00:00Z'))).toBe(false);
    expect(isUsMarketOpen(new Date('2026-01-21T14:30:00Z'))).toBe(true);
  });
});
