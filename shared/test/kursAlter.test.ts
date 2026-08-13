/**
 * Kurs-Zeitdeckel (Audit 13.08., B-2): `quote.updatedAt` wurde geschrieben
 * und von keinem Leser geprüft — die Handeingabe führte zum Wochen-alten
 * Kurs aus, wenn ein Symbol aus der Beobachtung fiel.
 *
 * Die Kunst ist die Marktzeiten-Bewusstheit: Der Scan versorgt nur OFFENE
 * Klassen, ein Freitags-Schluss ist am Samstag also nicht „veraltet". Zu
 * alt ist ein Kurs bei offenem Markt nach 30 min — und IMMER nach 5 Tagen.
 */
import { describe, expect, it } from 'vitest';
import {
  KURS_DECKEL_MAX_TAGE,
  KURS_DECKEL_OFFEN_MIN,
  kursZuAlt,
} from '../src/kursAlter.js';

/** Mittwoch 15:00 ET (Sommer, UTC−4) — US-Markt offen. */
const MARKT_OFFEN = new Date('2026-08-12T19:00:00Z');
/** Samstag 12:00 UTC — US-Markt zu. */
const SAMSTAG = new Date('2026-08-15T12:00:00Z');

const vorMin = (basis: Date, min: number): string =>
  new Date(basis.getTime() - min * 60_000).toISOString();

describe('kursZuAlt — offener Markt', () => {
  it('frisch innerhalb des Deckels, zu alt darüber', () => {
    expect(kursZuAlt(vorMin(MARKT_OFFEN, 10), 'stocks_us', MARKT_OFFEN).zuAlt).toBe(false);
    const alt = kursZuAlt(vorMin(MARKT_OFFEN, KURS_DECKEL_OFFEN_MIN + 15), 'stocks_us', MARKT_OFFEN);
    expect(alt.zuAlt).toBe(true);
    expect(alt.grund).toContain('offen');
  });

  it('Krypto handelt rund um die Uhr — der 30-min-Deckel gilt immer', () => {
    expect(kursZuAlt(vorMin(SAMSTAG, 10), 'crypto', SAMSTAG).zuAlt).toBe(false);
    expect(kursZuAlt(vorMin(SAMSTAG, 45), 'crypto', SAMSTAG).zuAlt).toBe(true);
  });
});

describe('kursZuAlt — geschlossener Markt', () => {
  it('der Freitags-Schluss ist am Samstag KEIN veralteter Kurs', () => {
    // ~20 Stunden alt, aber der US-Markt war seither durchgehend zu.
    expect(kursZuAlt(vorMin(SAMSTAG, 20 * 60), 'stocks_us', SAMSTAG).zuAlt).toBe(false);
  });

  it('die Reißleine greift auch bei geschlossenem Markt', () => {
    const b = kursZuAlt(vorMin(SAMSTAG, (KURS_DECKEL_MAX_TAGE + 1) * 24 * 60), 'stocks_us', SAMSTAG);
    expect(b.zuAlt).toBe(true);
    expect(b.grund).toContain('nicht mehr beobachtet');
  });
});

describe('kursZuAlt — Ränder', () => {
  it('fehlender oder unlesbarer Zeitstempel zählt als zu alt', () => {
    expect(kursZuAlt(undefined, 'stocks_us', MARKT_OFFEN).zuAlt).toBe(true);
    expect(kursZuAlt('kaputt', 'stocks_us', MARKT_OFFEN).zuAlt).toBe(true);
    expect(kursZuAlt(12345, 'stocks_us', MARKT_OFFEN).zuAlt).toBe(true);
  });

  it('marktOffen-Übersteuerung schlägt den Kalender (z. B. Feiertag laut Börsenuhr)', () => {
    // Kalender sagt „offen" (Mittwoch 15:00 ET), die Uhr weiß: Feiertag.
    expect(
      kursZuAlt(vorMin(MARKT_OFFEN, 45), 'stocks_us', MARKT_OFFEN, false).zuAlt,
    ).toBe(false);
    expect(
      kursZuAlt(vorMin(SAMSTAG, 45), 'stocks_us', SAMSTAG, true).zuAlt,
    ).toBe(true);
  });
});
