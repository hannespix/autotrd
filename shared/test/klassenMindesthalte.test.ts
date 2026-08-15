/**
 * Klassen-Mindesthalte (Hebel 1c, Owner 15.08. „rund um die Uhr").
 *
 * Krypto stirbt am Umschlag: 146 Trades zahlten 1.316 $ Gebühren auf +691 $
 * brutto. Der Klassen-Boden (2 Kalendertage) bremst den Signal-Ausstieg und
 * halbiert damit die maximale Roundtrip-Frequenz — Stop, Trailing und Ziel
 * bleiben in jedem Scan scharf.
 *
 * Die Tests kodieren vor allem die RICHTUNG: Der Boden darf den User-Wert
 * nur ANHEBEN, nie senken — und Klassen ohne Boden bleiben byte-gleich beim
 * User-Wert (auch 0 = „Signal-Ausstieg sofort erlaubt").
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  KLASSEN_MINDESTHALTE,
  wirksameMindesthalte,
} from '../src/strategy.js';

describe('wirksameMindesthalte', () => {
  it('hebt Krypto auf den Klassen-Boden an', () => {
    expect(wirksameMindesthalte(60, 'crypto')).toBe(2880);
    expect(wirksameMindesthalte(1440, 'crypto')).toBe(2880);
    // Auch „aus" (0/fehlend) wird angehoben — genau der Fall, in dem der
    // Umschlag am schnellsten wäre.
    expect(wirksameMindesthalte(0, 'crypto')).toBe(2880);
    expect(wirksameMindesthalte(undefined, 'crypto')).toBe(2880);
  });

  it('senkt einen höheren User-Wert NIEMALS', () => {
    expect(wirksameMindesthalte(4000, 'crypto')).toBe(4000);
  });

  it('lässt Klassen ohne Boden exakt beim User-Wert — auch bei 0', () => {
    expect(wirksameMindesthalte(60, 'stocks_us')).toBe(60);
    expect(wirksameMindesthalte(0, 'stocks_us')).toBe(0);
    expect(wirksameMindesthalte(undefined, 'etf_thematic')).toBe(0);
    expect(wirksameMindesthalte(1440, undefined)).toBe(1440);
  });

  it('ist unempfindlich gegen Schreibweise und Unsinn', () => {
    expect(wirksameMindesthalte(60, 'CRYPTO')).toBe(2880);
    expect(wirksameMindesthalte(Number.NaN, 'crypto')).toBe(2880);
    expect(wirksameMindesthalte(-5, 'stocks_us')).toBe(0);
  });

  it('Invariante: nur anhebend, für jede Klasse und jeden User-Wert', () => {
    for (const klasse of ['crypto', 'stocks_us', 'forex', 'unbekannt', undefined]) {
      for (const user of [0, 30, 60, 1440, 5000]) {
        expect(wirksameMindesthalte(user, klasse)).toBeGreaterThanOrEqual(user);
      }
    }
  });
});

describe('KLASSEN_MINDESTHALTE — die Böden selbst', () => {
  it('jeder Boden liegt ÜBER dem globalen Default, sonst wäre er wirkungslos', () => {
    for (const [klasse, boden] of Object.entries(KLASSEN_MINDESTHALTE)) {
      expect(boden, klasse).toBeGreaterThan(DEFAULT_STRATEGY.engine.minHoldMin ?? 0);
    }
  });

  it('Krypto hat einen Boden — die gebührenteuerste Klasse braucht ihn zuerst', () => {
    expect(KLASSEN_MINDESTHALTE['crypto']).toBe(2880);
  });
});
