/**
 * Tests der Tages-Notbremse.
 *
 * Sie ist eine Sperre, und Sperren haben zwei Versagensarten: Sie greifen
 * nicht, wenn sie sollen (teuer), oder sie greifen, wenn sie nicht sollen
 * (ärgerlich, aber harmlos). Die Tests decken beide ab — mit Schwerpunkt
 * auf der ersten.
 */

import { describe, expect, it } from 'vitest';
import {
  BREAKER_MAX_PCT,
  klemmeBreaker,
  pruefeBreaker,
} from '../src/circuitBreaker.js';

const lage = (vortag: number, jetzt: number, ausgeloest = false) => ({
  vortagEquity: vortag,
  jetztEquity: jetzt,
  bereitsAusgeloest: ausgeloest,
});

describe('pruefeBreaker — wann sie greift', () => {
  it('sperrt Einstiege, sobald die Grenze erreicht ist', () => {
    const b = pruefeBreaker(lage(10_000, 9_700), { dailyLossLimitPct: 3 });
    expect(b.stufe).toBe('gesperrt');
    expect(b.einstiegErlaubt).toBe(false);
    expect(b.verlustPct).toBe(3);
  });

  it('lässt knapp darunter durch', () => {
    const b = pruefeBreaker(lage(10_000, 9_701), { dailyLossLimitPct: 3 });
    expect(b.einstiegErlaubt).toBe(true);
    expect(b.verlustPct).toBe(2.99);
  });

  it('zählt BUCHVERLUSTE mit', () => {
    // Sonst löst die Bremse nie aus, solange niemand verkauft — und genau
    // das Verhalten (Verlierer laufen lassen) soll sie bremsen.
    const b = pruefeBreaker(lage(10_000, 9_000), { dailyLossLimitPct: 5 });
    expect(b.einstiegErlaubt).toBe(false);
    expect(b.verlustPct).toBe(10);
  });

  it('greift nicht bei Gewinn', () => {
    const b = pruefeBreaker(lage(10_000, 11_000), { dailyLossLimitPct: 3 });
    expect(b.einstiegErlaubt).toBe(true);
    expect(b.verlustPct).toBe(-10); // negativer „Verlust" = Gewinn
  });

  it('bleibt ausgelöst, bis sie zurückgesetzt wird', () => {
    // Eine Bremse, die sich löst, sobald der Kurs kurz zurückkommt, hätte
    // an genau dem Tag nichts verhindert, an dem sie gebraucht wird.
    const b = pruefeBreaker(lage(10_000, 10_100, true), { dailyLossLimitPct: 3 });
    expect(b.einstiegErlaubt).toBe(false);
    expect(b.grund).toContain('zurückgesetzt');
  });
});

describe('pruefeBreaker — wann sie NICHT greift', () => {
  it('ist bei Grenze 0 aus', () => {
    const b = pruefeBreaker(lage(10_000, 1_000), { dailyLossLimitPct: 0 });
    expect(b.einstiegErlaubt).toBe(true);
    expect(b.grenzePct).toBeNull();
  });

  it('sperrt nicht ohne Vortagswert', () => {
    // Ein frisches Konto hat keinen Bezugspunkt — es hat aber auch noch
    // nichts verloren. Sperren wäre hier eine Sperre aus Unwissen.
    const b = pruefeBreaker(lage(0, -500), { dailyLossLimitPct: 3 });
    expect(b.einstiegErlaubt).toBe(true);
    expect(b.verlustPct).toBeNull();
  });

  it('ist bei fehlender Konfiguration aus', () => {
    expect(pruefeBreaker(lage(10_000, 1), {}).einstiegErlaubt).toBe(true);
  });
});

describe('Glattstellen ist die AUSNAHME', () => {
  it('sperrt standardmäßig nur Einstiege', () => {
    const b = pruefeBreaker(lage(10_000, 9_000), { dailyLossLimitPct: 3 });
    expect(b.stufe).toBe('gesperrt');
    expect(b.grund).toContain('Ausstiege laufen weiter');
  });

  it('stellt nur glatt, wenn es ausdrücklich verlangt ist', () => {
    const b = pruefeBreaker(lage(10_000, 9_000), {
      dailyLossLimitPct: 3,
      flattenOnBreach: true,
    });
    expect(b.stufe).toBe('glattstellen');
  });
});

describe('klemmeBreaker — gegen Tippfehler', () => {
  it('deckelt bei 25 %', () => {
    // 250 statt 2,5 wäre ohne Deckel eine still abgeschaltete Bremse.
    expect(klemmeBreaker(250)).toBe(BREAKER_MAX_PCT);
  });

  it('macht aus Unsinn ein sauberes Aus', () => {
    for (const v of [undefined, Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) {
      expect(klemmeBreaker(v as number | undefined)).toBe(0);
    }
  });

  it('lässt vernünftige Werte durch', () => {
    expect(klemmeBreaker(2.5)).toBe(2.5);
    expect(klemmeBreaker(25)).toBe(25);
  });

  it('greift auch im Befund, nicht nur beim Speichern', () => {
    // Eine geklemmte Grenze muss auch die PRÜFUNG benutzen — sonst wäre der
    // Deckel Dekoration. Mit „250 %" wörtlich genommen bliebe ein Konto mit
    // 30 % Tagesverlust frei; geklemmt auf 25 % greift die Bremse.
    const b = pruefeBreaker(lage(10_000, 7_000), { dailyLossLimitPct: 250 });
    expect(b.grenzePct).toBe(BREAKER_MAX_PCT);
    expect(b.verlustPct).toBe(30);
    expect(b.einstiegErlaubt).toBe(false);
  });
});
