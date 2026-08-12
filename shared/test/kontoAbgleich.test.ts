/**
 * Kontoabgleich gegen den Broker.
 *
 * Der Anlassfall steht als eigener Test drin: Wenn der jemals wieder grün
 * durchginge, wäre die Prüfung wertlos.
 */
import { describe, expect, it } from 'vitest';

import {
  KONTO_MELDE_SCHWELLE,
  KONTO_SPERR_ANTEIL,
  kontoAbgleich,
  sicheresKapital,
} from '../src/kontoAbgleich.js';

describe('sicheresKapital', () => {
  it('nimmt den kleineren der beiden Werte', () => {
    expect(sicheresKapital(39_311.17, -45_286.34)).toBe(-45_286.34);
    expect(sicheresKapital(1_000, 5_000)).toBe(1_000);
  });

  it('bleibt ohne Broker beim Buch — ein reines Buch-Konto ist kein Fehler', () => {
    expect(sicheresKapital(2_500, null)).toBe(2_500);
    expect(sicheresKapital(2_500, undefined)).toBe(2_500);
    expect(sicheresKapital(2_500, Number.NaN)).toBe(2_500);
  });

  it('gibt bei kaputtem Buchwert 0 zurück statt NaN weiterzureichen', () => {
    expect(sicheresKapital(Number.NaN, 100)).toBe(0);
  });
});

describe('kontoAbgleich', () => {
  const buch = { cash: 10_000, equity: 50_000 };

  it('meldet nichts bei kleinen Verrechnungsdifferenzen', () => {
    const b = kontoAbgleich(buch, { cash: 10_000 - 40, equity: 50_000 - 40 });
    expect(b.zustand).toBe('sauber');
    expect(b.sperre).toBe(false);
    expect(b.grund).toBeUndefined();
  });

  it('meldet Drift oberhalb der Schwelle, ohne zu sperren', () => {
    const b = kontoAbgleich(buch, { cash: 10_000 - 900, equity: 50_000 - 900 });
    expect(b.zustand).toBe('drift');
    expect(b.cashDiff).toBe(-900);
    expect(b.sperre).toBe(false);
    expect(b.grund).toContain('Cash -900.00');
  });

  it('sperrt Einstiege ab dem Sperr-Anteil der Broker-Equity', () => {
    // 5 % von 50 000 = 2 500
    const knappDrunter = kontoAbgleich(buch, { cash: 10_000 - 2_400, equity: 50_000 });
    expect(knappDrunter.sperre).toBe(false);
    expect(knappDrunter.zustand).toBe('drift');

    const drueber = kontoAbgleich(buch, { cash: 10_000 - 2_600, equity: 50_000 });
    expect(drueber.sperre).toBe(true);
    expect(drueber.zustand).toBe('grob');
    expect(drueber.grund).toContain('Einstiege gesperrt');
  });

  it('rechnet den Anteil gegen die BROKER-Equity, nicht gegen das Buch', () => {
    // Ein kaputtes Buch darf nicht auch noch den Maßstab stellen: Mit der
    // Buch-Equity (500 000) als Bezug wären 20 000 nur 4 % und blieben unter
    // der Sperrschwelle.
    const b = kontoAbgleich({ cash: 20_000, equity: 500_000 }, { cash: 0, equity: 50_000 });
    expect(b.cashDiffPct).toBe(0.4);
    expect(b.sperre).toBe(true);
  });

  it('ist ohne Broker-Zahlen nicht geprüft und sperrt nicht', () => {
    for (const broker of [null, undefined, { cash: Number.NaN, equity: 1 }]) {
      const b = kontoAbgleich(buch, broker);
      expect(b.geprueft).toBe(false);
      expect(b.zustand).toBe('kein_broker');
      expect(b.sperre).toBe(false);
    }
    expect(kontoAbgleich(null, { cash: 1, equity: 1 }).geprueft).toBe(false);
  });

  it('erkennt auch eine reine Depotwert-Differenz bei stimmendem Cash', () => {
    // Gleicher Cash, anderer Depotwert: Positionen, die das Buch nicht kennt.
    const b = kontoAbgleich(buch, { cash: 10_000, equity: 90_000 });
    expect(b.cashDiff).toBe(0);
    expect(b.equityDiff).toBe(40_000);
    expect(b.zustand).not.toBe('sauber');
  });

  it('kommt mit Broker-Equity ≤ 0 zurecht (leergeräumtes Konto)', () => {
    const b = kontoAbgleich(buch, { cash: -5_000, equity: 0 });
    expect(Number.isFinite(b.cashDiffPct)).toBe(true);
    expect(b.cashDiffPct).toBe(0);
    // Ohne Bezugsgröße greift nur die absolute Schwelle × 20.
    expect(b.sperre).toBe(true);
  });

  it('liefert das sichere Kapital immer mit', () => {
    const b = kontoAbgleich({ cash: 500, equity: 1_000 }, { cash: 5_000, equity: 9_000 });
    expect(b.sicheresCash).toBe(500); // Buch tiefer ⇒ Buch zählt
  });

  it('reproduziert den Anlassfall vom 12.08. und sperrt', () => {
    // Owner-Screenshot: autotrd gegen Alpaca, dasselbe Paper-Konto.
    const b = kontoAbgleich(
      { cash: 39_311.17, equity: 99_861.08 },
      { cash: -45_286.34, equity: 100_543.75 },
    );
    expect(b.geprueft).toBe(true);
    expect(b.zustand).toBe('grob');
    expect(b.cashDiff).toBe(-84_597.51);
    expect(b.equityDiff).toBe(682.67);
    // 84 % der Broker-Equity — weit über der 5-%-Sperrschwelle.
    expect(b.cashDiffPct).toBeGreaterThan(0.8);
    expect(b.sperre).toBe(true);
    // Und das Entscheidende: Gerechnet wird mit −45 286, nicht mit +39 311.
    // Genau diese Zahl gab bisher immer neue Käufe frei.
    expect(b.sicheresCash).toBe(-45_286.34);
  });

  it('respektiert eigene Schwellen', () => {
    const streng = kontoAbgleich(buch, { cash: 9_950, equity: 50_000 }, 10, 0.001);
    expect(streng.zustand).toBe('grob');
    const locker = kontoAbgleich(buch, { cash: 9_950, equity: 50_000 }, 100_000, 0.9);
    expect(locker.zustand).toBe('sauber');
  });

  it('hat Schwellenwerte, die eine Meldung nicht zur Dauermeldung machen', () => {
    expect(KONTO_MELDE_SCHWELLE).toBeGreaterThan(0);
    expect(KONTO_SPERR_ANTEIL).toBeGreaterThan(0);
    expect(KONTO_SPERR_ANTEIL).toBeLessThan(1);
  });
});
