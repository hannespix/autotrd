import { describe, expect, it } from 'vitest';
import {
  boersenOffenLautUhr,
  marketOpenForClass,
  usSessionClass,
  type BoersenUhr,
} from '../src/index.js';

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

describe('usSessionClass', () => {
  it('genau die Klassen mit US-Kassamarkt-Fenster', () => {
    for (const cls of ['stocks_us', 'stocks_global', 'indices', 'etf_sectors', 'rates_bonds', 'unbekannt']) {
      expect(usSessionClass(cls), cls).toBe(true);
    }
    for (const cls of ['crypto', 'forex', 'commodities']) {
      expect(usSessionClass(cls), cls).toBe(false);
    }
  });
});

/* ── Börsen-Uhr (Alpaca /v2/clock) ──────────────────────────────────────────
 *
 * Zeitlogik ist hochriskant (CLAUDE.md §5) — deshalb echte Datumsgrenzen:
 * Heiligabend 2026 ist ein HALBTAG (Schluss 13:00 ET = 18:00 UTC), den die
 * eigene Kalenderrechnung nicht kennt. Genau dieser Fall — „die Engine hält
 * über einen Schluss, den sie nicht kommen sah" — ist der Grund für die Uhr.
 */
describe('boersenOffenLautUhr', () => {
  const T = (iso: string): number => Date.parse(iso);

  // Ablesung am Halbtag-Vormittag: offen, Schluss 13:00 ET (18:00 UTC),
  // nächste Öffnung erst am 28.12. (Montag; 25.–27. Feiertag + Wochenende).
  const HALBTAG: BoersenUhr = {
    isOpen: true,
    nextClose: '2026-12-24T18:00:00Z',
    nextOpen: '2026-12-28T14:30:00Z',
    at: '2026-12-24T16:00:00Z',
  };

  it('offen bleibt offen — bis zum ECHTEN Schluss des Halbtags', () => {
    expect(boersenOffenLautUhr(HALBTAG, T('2026-12-24T17:59:00Z'))).toBe(true);
    // 13:00 ET: Die eigene Rechnung sagt hier noch 3 Stunden „offen" —
    // die Uhr kennt den Halbtag und schließt.
    expect(boersenOffenLautUhr(HALBTAG, T('2026-12-24T18:00:00Z'))).toBe(false);
    expect(boersenOffenLautUhr(HALBTAG, T('2026-12-25T15:00:00Z'))).toBe(false); // Feiertag
  });

  it('nach der nächsten Öffnung ist das Wissen der Ablesung erschöpft → null', () => {
    // 28.12., 14:31 UTC: laut Ablesung „wieder offen", aber der ZUGEHÖRIGE
    // Schluss ist unbekannt — und die Ablesung ist ohnehin >24 h alt.
    expect(boersenOffenLautUhr(HALBTAG, T('2026-12-28T14:31:00Z'))).toBeNull();
  });

  it('geschlossen bleibt geschlossen bis zur Öffnung, dann offen bis zum Schluss', () => {
    // Ablesung am frühen Freitagmorgen nach Thanksgiving 2026: noch zu,
    // Öffnung 14:30 UTC mit HALBTAGS-Schluss 18:00 UTC (13:00 ET).
    const FEIERTAG: BoersenUhr = {
      isOpen: false,
      nextOpen: '2026-11-27T14:30:00Z',
      nextClose: '2026-11-27T18:00:00Z',
      at: '2026-11-27T08:00:00Z',
    };
    expect(boersenOffenLautUhr(FEIERTAG, T('2026-11-27T13:00:00Z'))).toBe(false); // vor Öffnung
    expect(boersenOffenLautUhr(FEIERTAG, T('2026-11-27T14:30:00Z'))).toBe(true);  // Fr offen
    expect(boersenOffenLautUhr(FEIERTAG, T('2026-11-27T17:59:00Z'))).toBe(true);
    expect(boersenOffenLautUhr(FEIERTAG, T('2026-11-27T18:00:00Z'))).toBeNull();  // Wissen zu Ende
  });

  it('eine Ablesung älter als 24 h ist verbraucht', () => {
    expect(boersenOffenLautUhr(HALBTAG, T('2026-12-25T16:01:00Z'))).toBeNull();
  });

  it('fehlende oder kaputte Ablesungen liefern null statt einer Vermutung', () => {
    expect(boersenOffenLautUhr(null, T('2026-12-24T17:00:00Z'))).toBeNull();
    expect(boersenOffenLautUhr(undefined, T('2026-12-24T17:00:00Z'))).toBeNull();
    expect(
      boersenOffenLautUhr({ isOpen: true, nextOpen: '', nextClose: '', at: '2026-12-24T16:00:00Z' }, T('2026-12-24T17:00:00Z')),
    ).toBeNull();
    expect(
      boersenOffenLautUhr({ isOpen: true, nextOpen: 'kaputt', nextClose: 'kaputt', at: 'kaputt' }, T('2026-12-24T17:00:00Z')),
    ).toBeNull();
  });
});
