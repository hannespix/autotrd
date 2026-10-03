/**
 * Was die Teilen-Karte behaupten darf.
 *
 * Der Anlassfall vom 12.08. steht als erster Test: grüne 0,00 % neben
 * Profit-Faktor 0,12. Diese Grafik verlässt die App — hier zu irren heißt,
 * eine falsche Aussage in die Welt zu schicken.
 */
import { describe, expect, it } from 'vitest';

import { kartenAussage, tonVon, type AussageEingabe } from '../src/shareAussage.js';

const basis = (ueber: Partial<AussageEingabe> = {}): AussageEingabe => ({
  kurventage: 0,
  renditePct: 0,
  ergebnis: 0,
  trades: 0,
  tradeBilanz: 0,
  betraege: true,
  waehrung: 'USD',
  ...ueber,
});

describe('tonVon — eine Null ist nicht grün', () => {
  it('färbt exakt null neutral', () => {
    // Der Kern des Anlassfalls: `>= 0` machte aus „keine Aussage" ein
    // Gewinn-Grün.
    expect(tonVon(0)).toBe('neutral');
    expect(tonVon(-0)).toBe('neutral');
  });

  it('färbt echte Werte nach Vorzeichen', () => {
    expect(tonVon(0.01)).toBe('gruen');
    expect(tonVon(-0.01)).toBe('rot');
  });

  it('färbt Unfug neutral statt grün', () => {
    expect(tonVon(Number.NaN)).toBe('neutral');
    expect(tonVon(Number.POSITIVE_INFINITY)).toBe('neutral');
  });
});

describe('kartenAussage', () => {
  it('reproduziert den Anlassfall: 9 Trades, keine Kurve ⇒ KEINE Prozentzahl', () => {
    const a = kartenAussage(
      basis({
        kurventage: 0,
        renditePct: 0,
        trades: 9,
        tradeBilanz: -1_719.54,
        vonTag: '2026-08-10',
        bisTag: '2026-08-12',
      }),
    );
    expect(a.haupt).not.toContain('%');
    expect(a.haupt).not.toBe('+0,00 %');
    expect(a.haupt).toContain('−1.719,54'.replace('.', '')); // −1719,54 USD
    expect(a.ton).toBe('rot');
    expect(a.unter).toContain('9 Trades');
    expect(a.unter).toContain('über 3 Tage');
    expect(a.teilbar).toBe(true);
  });

  it('zeigt die Rendite, sobald eine Kurve da ist', () => {
    const a = kartenAussage(
      basis({
      kurventage: 5,
      renditePct: -1.4,
      ergebnis: -140,
      tradeBilanz: -140,
      vonTag: '2026-08-08',
      bisTag: '2026-08-12',
    }),
    );
    expect(a.haupt).toBe('−1,40 %');
    expect(a.ton).toBe('rot');
    expect(a.unter).toContain('2026-08-08 → 2026-08-12');
    expect(a.teilbar).toBe(true);
  });

  it('färbt eine echte Null-Rendite neutral, nicht grün', () => {
    const a = kartenAussage(basis({ kurventage: 3, renditePct: 0, vonTag: '2026-08-10', bisTag: '2026-08-12' }));
    expect(a.haupt).toBe('0,00 %');
    expect(a.ton).toBe('neutral');
  });

  it('behauptet nichts und verweigert das Teilen, wenn nichts da ist', () => {
    const a = kartenAussage(basis());
    expect(a.haupt).toBe('—');
    expect(a.ton).toBe('neutral');
    expect(a.teilbar).toBe(false);
    expect(a.grund).toContain('mindestens einen abgeschlossenen Trade');
  });

  it('nennt ohne Beträge die Trade-Zahl statt einer Summe', () => {
    const a = kartenAussage(
      basis({ trades: 9, tradeBilanz: -1_719.54, betraege: false, vonTag: '2026-08-10', bisTag: '2026-08-12' }),
    );
    expect(a.haupt).toBe('9 Trades');
    expect(a.haupt).not.toContain('USD');
    expect(a.unter).toContain('Beträge ausgeblendet');
    // Die Farbe darf die Richtung trotzdem verraten — das ist keine Zahl.
    expect(a.ton).toBe('rot');
  });

  it('kommt mit einem einzigen Handelstag zurecht', () => {
    const a = kartenAussage(
      basis({ trades: 1, tradeBilanz: 12.5, vonTag: '2026-08-12', bisTag: '2026-08-12' }),
    );
    expect(a.unter).toContain('1 Trade');
    expect(a.unter).toContain('über 1 Tag');
    expect(a.unter).not.toContain('1 Tage');
    expect(a.ton).toBe('gruen');
  });

  it('erfindet keinen Zeitraum, wenn die Tage fehlen', () => {
    const a = kartenAussage(basis({ trades: 4, tradeBilanz: -20 }));
    expect(a.unter).not.toContain('über');
    expect(a.teilbar).toBe(true);
  });

  it('lässt eine kaputte Rendite nicht als Prozentzahl durch', () => {
    const a = kartenAussage(basis({ kurventage: 5, renditePct: Number.NaN, trades: 2, tradeBilanz: -5 }));
    expect(a.haupt).not.toContain('%');
    expect(a.ton).toBe('rot');
  });

  it('verweigert eine verkehrte Datumsspanne statt sie zu rechnen', () => {
    const a = kartenAussage(
      basis({ trades: 3, tradeBilanz: -30, vonTag: '2026-08-12', bisTag: '2026-08-10' }),
    );
    expect(a.unter).not.toContain('über -');
    expect(a.unter).not.toContain('über 0');
  });
});
