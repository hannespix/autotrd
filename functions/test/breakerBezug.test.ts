/**
 * Audit-Befund 11.08. (A6): `vortagEquityAm` wurde geschrieben und nie
 * gelesen.
 *
 * Die reine Logik prüft `shared/test/bezugAlter.test.ts`. Hier steht, dass
 * beide Handelspfade das Datum auch liefern — sonst bliebe das Feld genau
 * das, was es vorher war: mitgeschrieben und ungenutzt, nur diesmal mit einer
 * Funktion daneben, die niemand füttert.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const breakerAufruf = (text: string): string => {
  const ab = text.indexOf('pruefeBreaker(');
  expect(ab, 'pruefeBreaker-Aufruf nicht gefunden').toBeGreaterThan(0);
  return text.slice(ab, text.indexOf('\n      },', ab));
};

describe('Beide Handelspfade liefern das Alter der Bezugsgröße', () => {
  // Seit dem 13.08. steht das Breaker-Gate der Handeingabe (und des
  // Momentum-Laufs) zentral in core/kontoTore.ts — EIN pruefeBreaker-Aufruf
  // für alle Pfade außerhalb des Scans, statt Kopien, die auseinanderlaufen.
  for (const [name, pfad] of [
    ['Scan', ['scheduled', 'scanMarket.ts']],
    ['Konto-Tore (Handeingabe + Momentum)', ['core', 'kontoTore.ts']],
  ] as const) {
    it(`${name}: reicht vortagEquityAm durch`, () => {
      expect(breakerAufruf(quelle(...pfad))).toContain("risk.vortagEquityAm");
    });

    it(`${name}: nennt den heutigen Handelstag in New York`, () => {
      /* Nicht UTC. Sonst zählte der Abend nach 20:00 ET schon als neuer Tag
       * und die Bezugsgröße sähe einen Tag älter aus, als sie ist — dieselbe
       * Falle, die beim Breaker-Marker am 11.08. schon zuschlug. */
      expect(breakerAufruf(quelle(...pfad))).toContain('handelstagET(');
    });
  }

  it('beide benutzen DIESELBE Handelstag-Funktion', () => {
    // Zwei Ableitungen wären zwei Gelegenheiten, sie verschieden zu machen —
    // und dann behauptete der eine Pfad ein anderes Alter als der andere.
    expect(quelle('core', 'kontoTore.ts')).toContain(
      "from '../scheduled/scanMarket.js'",
    );
    // Und die Handeingabe hängt wirklich an den Toren — sonst wäre die
    // zentrale Stelle nur eine weitere Funktion, die niemand ruft.
    expect(quelle('callable', 'trade.ts')).toContain("from '../core/kontoTore.js'");
  });
});
