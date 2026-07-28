/**
 * Welche Symbole der 1-Minuten-Puls abfragt.
 *
 * Die Auswahl ist sicherheitsrelevant und ihr Bruch ist unsichtbar: Fällt
 * ein Symbol heraus, verliert eine OFFENE Position ihren schnellen Ausstieg.
 * Nichts schlägt dabei fehl — der Stop greift dann eben erst beim nächsten
 * 5-min-Scan, und niemand merkt, dass es hätte schneller gehen können.
 */

import { describe, expect, it } from 'vitest';
import { PULSE_MAX_SYMBOLS, pulseSymbols } from '../src/scheduled/riskPulse.js';

/** Krypto handelt rund um die Uhr, US-Aktien nicht. */
const nurKrypto = (s: string): boolean => s.endsWith('-USD');
const allesOffen = (): boolean => true;

describe('pulseSymbols', () => {
  it('nimmt genau die Symbole mit offenen Positionen', () => {
    expect(pulseSymbols(['BTC-USD', 'ETH-USD'], allesOffen)).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('lässt geschlossene Märkte weg — dort kann kein Stop auslösen', () => {
    // Der Kurs steht bis zur Eröffnung. Ihn abzufragen wäre bezahlte Arbeit
    // für eine garantiert unveränderte Antwort.
    expect(pulseSymbols(['AAPL', 'BTC-USD', 'TSLA'], nurKrypto)).toEqual(['BTC-USD']);
  });

  it('dedupliziert — mehrere Konten halten dasselbe Symbol', () => {
    // Die Collection-Group-Abfrage liefert je Konto eine Zeile. Ohne Dedup
    // stünde dasselbe Symbol mehrfach im Spark-Request und verbrauchte
    // Plätze im 20er-Bündel.
    expect(pulseSymbols(['BTC-USD', 'BTC-USD', 'ETH-USD'], allesOffen)).toEqual([
      'BTC-USD',
      'ETH-USD',
    ]);
  });

  it('deckelt die Menge — der Puls bleibt ein Wächter, kein zweiter Scan', () => {
    const viele = Array.from({ length: 200 }, (_, i) => `S${i}-USD`);
    expect(pulseSymbols(viele, allesOffen).length).toBe(PULSE_MAX_SYMBOLS);
  });

  it('zählt beim Deckel nur OFFENE Symbole, nicht die geschlossenen davor', () => {
    // Der scharfe Fall: Stünden 60 geschlossene Aktien vorn, wäre der Deckel
    // erreicht, bevor auch nur eine handelbare Krypto-Position drankommt —
    // der Puls liefe dann ins Leere, ohne dass etwas fehlschlägt.
    const gemischt = [
      ...Array.from({ length: 100 }, (_, i) => `EQ${i}`),
      ...Array.from({ length: 5 }, (_, i) => `C${i}-USD`),
    ];
    const out = pulseSymbols(gemischt, nurKrypto);
    expect(out.length).toBe(5);
    expect(out[0]).toBe('C0-USD');
  });

  it('ignoriert leere Symbolnamen', () => {
    expect(pulseSymbols(['', 'BTC-USD', ''], allesOffen)).toEqual(['BTC-USD']);
  });

  it('ohne Positionen ⇒ leere Liste, kein Fetch', () => {
    expect(pulseSymbols([], allesOffen)).toEqual([]);
  });
});
