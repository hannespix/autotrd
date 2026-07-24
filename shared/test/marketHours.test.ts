import { describe, expect, it } from 'vitest';
import { marketOpenForClass } from '../src/index.js';

// Referenzzeiten (UTC), Juli = EDT (UTC−4), Januar = EST (UTC−5)
const WED_NOON_ET = new Date('2026-07-22T16:00:00Z'); // Mi 12:00 EDT
const WED_NIGHT_ET = new Date('2026-07-22T03:00:00Z'); // Di 23:00 EDT
const SAT = new Date('2026-07-25T15:00:00Z'); // Sa 11:00 EDT
const SUN_MORNING = new Date('2026-07-26T15:00:00Z'); // So 11:00 EDT
const SUN_EVENING = new Date('2026-07-26T22:00:00Z'); // So 18:00 EDT
const FRI_EVENING = new Date('2026-07-24T22:00:00Z'); // Fr 18:00 EDT

describe('marketOpenForClass (Depot-Vision: je Klasse)', () => {
  it('crypto handelt 24/7 — auch Samstag nachts', () => {
    expect(marketOpenForClass('crypto', SAT)).toBe(true);
    expect(marketOpenForClass('crypto', WED_NIGHT_ET)).toBe(true);
    expect(marketOpenForClass('crypto', SUN_MORNING)).toBe(true);
  });

  it('forex/commodities: ~24/5 mit Wochenend-Pause Fr 17:00 → So 17:00 ET', () => {
    for (const cls of ['forex', 'commodities']) {
      expect(marketOpenForClass(cls, WED_NIGHT_ET), `${cls} Wochentag-Nacht`).toBe(true);
      expect(marketOpenForClass(cls, FRI_EVENING), `${cls} Fr-Abend`).toBe(false);
      expect(marketOpenForClass(cls, SAT), `${cls} Samstag`).toBe(false);
      expect(marketOpenForClass(cls, SUN_MORNING), `${cls} So-Vormittag`).toBe(false);
      expect(marketOpenForClass(cls, SUN_EVENING), `${cls} So-Abend`).toBe(true);
    }
  });

  it('Aktien/ETFs/Indizes/Unbekanntes: US-Börsenzeiten', () => {
    for (const cls of ['stocks_us', 'stocks_global', 'indices', 'etf_sectors', 'rates_bonds', 'unbekannt']) {
      expect(marketOpenForClass(cls, WED_NOON_ET), `${cls} Mi-Mittag`).toBe(true);
      expect(marketOpenForClass(cls, WED_NIGHT_ET), `${cls} Nacht`).toBe(false);
      expect(marketOpenForClass(cls, SAT), `${cls} Samstag`).toBe(false);
    }
    // Randminuten (DST-korrekt im Januar geprüft: 14:30 UTC = 09:30 EST)
    expect(marketOpenForClass('stocks_us', new Date('2026-01-21T14:30:00Z'))).toBe(true);
    expect(marketOpenForClass('stocks_us', new Date('2026-01-21T14:29:00Z'))).toBe(false);
    expect(marketOpenForClass('stocks_us', new Date('2026-07-22T19:59:00Z'))).toBe(true); // 15:59 EDT
    expect(marketOpenForClass('stocks_us', new Date('2026-07-22T20:00:00Z'))).toBe(false); // 16:00 EDT
  });
});
