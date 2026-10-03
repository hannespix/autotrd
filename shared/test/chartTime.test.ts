/**
 * Zeitzonen-Brücke der Chart-Anzeige (04.08.).
 *
 * Warum eigene Tests: Der Fehler, den diese Funktionen beheben, war für
 * niemanden als Fehler erkennbar — das Chart zeigte eine plausible Uhrzeit,
 * nur eben eine andere als die Kurszeile zwei Zentimeter darüber. Eine
 * Vorzeichen-Verwechslung hier stellt genau diesen Zustand wieder her,
 * ohne dass irgendetwas kaputt aussieht.
 *
 * `getTimezoneOffset()` ist in JS positiv WESTLICH von Greenwich: Berlin im
 * Sommer liefert −120, New York −240 (Sommerzeit) bzw. +300 im Winter.
 */

import { describe, expect, it } from 'vitest';
import { alsOrtszeit, ausOrtszeit, lokalerTag, tagesPraefix, zonenKuerzel } from '../src/chartTime.js';

/** US-Handelsstart am 04.08.2026: 13:30 UTC = 15:30 deutscher Sommerzeit. */
const US_OPEN = Date.parse('2026-08-04T13:30:00.000Z') / 1000;
const BERLIN_SOMMER = -120;
const BERLIN_WINTER = -60;

/** Wie Lightweight Charts den Zeitstempel rendert: stur als UTC. */
const alsUtcGelesen = (sek: number): string => new Date(sek * 1000).toISOString().slice(11, 16);

describe('alsOrtszeit', () => {
  it('lässt die US-Eröffnung in Berlin als 15:30 erscheinen', () => {
    expect(alsUtcGelesen(alsOrtszeit(US_OPEN, BERLIN_SOMMER))).toBe('15:30');
  });

  it('zeigt denselben Zeitpunkt in der Winterzeit als 14:30', () => {
    expect(alsUtcGelesen(alsOrtszeit(US_OPEN, BERLIN_WINTER))).toBe('14:30');
  });

  it('lässt UTC-Nutzer unverändert', () => {
    expect(alsOrtszeit(US_OPEN, 0)).toBe(US_OPEN);
    expect(alsUtcGelesen(alsOrtszeit(US_OPEN, 0))).toBe('13:30');
  });

  it('verschiebt westlich von Greenwich zurück (New York: 09:30)', () => {
    // getTimezoneOffset ist dort POSITIV (240 im Sommer) — das Vorzeichen ist
    // die eigentliche Falle dieser Funktion.
    expect(alsUtcGelesen(alsOrtszeit(US_OPEN, 240))).toBe('09:30');
  });

  it('hält den Abstand zweier Bars exakt ein', () => {
    const a = alsOrtszeit(US_OPEN, BERLIN_SOMMER);
    const b = alsOrtszeit(US_OPEN + 300, BERLIN_SOMMER);
    expect(b - a).toBe(300);
  });
});

describe('ausOrtszeit', () => {
  it('macht die Verschiebung exakt rückgängig', () => {
    for (const off of [-120, -60, 0, 240, 330, -780]) {
      expect(ausOrtszeit(alsOrtszeit(US_OPEN, off), off)).toBe(US_OPEN);
    }
  });

  it('kommt auch mit halbstündigen Zonen klar (Indien: +5:30)', () => {
    // −330 = UTC+5:30. Ganzzahlige Stunden anzunehmen wäre hier falsch.
    expect(alsUtcGelesen(alsOrtszeit(US_OPEN, -330))).toBe('19:00');
  });
});

describe('tagesPraefix', () => {
  it('schweigt, wenn der Bar von heute ist', () => {
    expect(tagesPraefix('2026-08-04', '2026-08-04')).toBe('');
  });

  it('sagt „gestern" beim US-Schluss vor der heutigen Eröffnung', () => {
    // Der Owner-Fall: 04.08. um 15:15, jüngste Kerze ist der Schluss vom 03.
    expect(tagesPraefix('2026-08-03', '2026-08-04')).toBe('gestern');
  });

  it('nennt bei älteren Bars das Datum', () => {
    expect(tagesPraefix('2026-07-31', '2026-08-04')).toBe('31.07.');
  });

  it('kommt über Monats- und Jahresgrenzen (Montag nach Neujahr)', () => {
    expect(tagesPraefix('2026-12-31', '2027-01-01')).toBe('gestern');
    expect(tagesPraefix('2026-12-30', '2027-01-01')).toBe('30.12.');
  });

  it('bleibt bei unbrauchbarer Eingabe stumm statt zu raten', () => {
    expect(tagesPraefix('kaputt', '2026-08-04')).toBe('');
  });
});

describe('lokalerTag', () => {
  it('liest den Kalendertag OHNE UTC-Versatz', () => {
    // Der springende Punkt: Um 01:30 Berliner Zeit ist es UTC noch der
    // Vortag. Ein `toISOString().slice(0,10)` läge hier um einen Tag daneben
    // und würde „gestern" an eine Kerze von heute schreiben.
    const d = new Date(2026, 7, 4, 1, 30);
    expect(lokalerTag(d)).toBe('2026-08-04');
  });

  it('füllt Monat und Tag zweistellig auf', () => {
    expect(lokalerTag(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });
});

describe('zonenKuerzel', () => {
  it('liefert ein nicht-leeres Kürzel', () => {
    expect(zonenKuerzel(new Date(US_OPEN * 1000)).length).toBeGreaterThan(0);
  });

  it('bleibt auch ohne Intl-Kurznamen brauchbar', () => {
    // Der Fallback baut den UTC-Versatz selbst — er darf nie leer sein,
    // sonst stünde im Chart eine Uhrzeit ohne Bezug.
    const s = zonenKuerzel(new Date(US_OPEN * 1000), 'xx-XX');
    expect(s).toMatch(/\S/);
  });
});
