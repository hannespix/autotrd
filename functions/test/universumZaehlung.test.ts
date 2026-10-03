/**
 * Die Zählung ist der einzige Betriebsblick auf ein Universum mit
 * mehreren tausend Zeilen.
 *
 * Bei 132 handverlesenen Symbolen konnte man die Liste lesen. Bei Tausenden
 * ist die Zählung die einzige Stelle, an der ein Filterfehler auffällt —
 * „sieht plausibel aus" ist dort keine Prüfung mehr. Deshalb steht sie als
 * eigene reine Funktion da und wird hier festgenagelt.
 */
import { describe, expect, it } from 'vitest';
import { BLOCK, UNIVERSUM_SYNC_V, zaehlung } from '../src/scheduled/universumSync.js';
import type { UniversumEintrag } from '../src/core/alpacaUniversum.js';

const e = (ueber: Partial<UniversumEintrag>): UniversumEintrag => ({
  symbol: 'X',
  name: 'X',
  klasse: 'us_equity',
  fractionable: false,
  shortable: false,
  ...ueber,
});

const AT = '2026-08-11T00:30:00.000Z';

describe('zaehlung', () => {
  it('zählt Gesamt, Klassen und Eigenschaften getrennt', () => {
    const eintraege = [
      e({ symbol: 'AAPL', fractionable: true, shortable: true }),
      e({ symbol: 'MSFT', fractionable: true }),
      e({ symbol: 'PENNY' }),
      e({ symbol: 'BTC-USD', klasse: 'crypto', fractionable: true }),
    ];
    expect(zaehlung(eintraege, AT)).toEqual({
      v: UNIVERSUM_SYNC_V,
      at: AT,
      gesamt: 4,
      aktien: 3,
      krypto: 1,
      fractionable: 3,
      shortable: 1,
    });
  });

  it('zählt ein leeres Universum als null, statt zu werfen', () => {
    expect(zaehlung([], AT)).toMatchObject({ gesamt: 0, aktien: 0, krypto: 0 });
  });

  it('trägt die Fassung mit — sonst weiß niemand, welcher Filter das war', () => {
    // Eine Zahl ohne Filterstand ist nicht vergleichbar: „gestern 3.412,
    // heute 1.180" kann eine Marktbewegung sein oder eine Regeländerung.
    expect(zaehlung([], AT).v).toBe(UNIVERSUM_SYNC_V);
  });
});

describe('Blockgröße', () => {
  it('bleibt sicher unter dem Firestore-Dokumentlimit', () => {
    // Ein Dokument fasst 1 MB. Ein Eintrag (Symbol, Name, Klasse, zwei
    // Flags) liegt bei rund 100 Byte; 2.000 davon sind ~200 KB.
    expect(BLOCK * 100).toBeLessThan(900_000);
  });

  it('hält die Zahl der Blöcke bei zehntausend Symbolen einstellig', () => {
    expect(Math.ceil(10_000 / BLOCK)).toBeLessThan(10);
  });
});
