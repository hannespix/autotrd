/**
 * Task 19 (08.10.): Kennzahlen aus dem Yahoo-Chart-Abruf — pur.
 *
 * Die beiden Fallen aus der Bestandsaufnahme sind hier festgenagelt:
 * `chartPreviousClose` ist kein Vortag (AAPL 5d: 330,32 statt 336,67), und
 * Volumen 0 (FX, Indizes) heißt unbekannt, nicht null.
 */
import { describe, expect, it } from 'vitest';
import {
  VOL_DURCHSCHNITT_FRISCH_TAGE,
  VOL_DURCHSCHNITT_MIN,
  VOL_DURCHSCHNITT_TAGE,
  durchschnittsVolumen,
  kennzahlenAus,
  kennzahlenFelder,
  volDurchschnittFrisch,
} from '../src/kennzahlen.js';

const bar = (close: number, volume = 1000, open = close - 1, high = close + 1, low = close - 2) => ({ open, high, low, close, volume });

describe('kennzahlenAus', () => {
  it('Vortag ist die VORLETZTE Kerze — nie chartPreviousClose (AAPL-Messung 5d)', () => {
    const bars = [bar(330.32), bar(333), bar(335), bar(336.67), bar(339.7)];
    const k = kennzahlenAus(
      { regularMarketDayHigh: 341.2, regularMarketDayLow: 337.9, fiftyTwoWeekHigh: 345.34, fiftyTwoWeekLow: 243.42, regularMarketVolume: 16_500_000, longName: 'Apple Inc.', fullExchangeName: 'NasdaqGS', currency: 'USD' },
      bars,
      '2026-10-08T14:00:00.000Z',
    );
    expect(k.vortag).toBe(336.67);
    expect(k.oeffnen).toBe(338.7);
    // Volumen aus der KERZE (letzte: 1000) — Meta ist nur Rückfall (Red-Team M4: Indizes messen in Meta anders)
    expect(k).toMatchObject({ tagHoch: 341.2, tagTief: 337.9, w52Hoch: 345.34, w52Tief: 243.42, volumen: 1000, name: 'Apple Inc.', boerse: 'NasdaqGS', waehrung: 'USD', updatedAt: '2026-10-08T14:00:00.000Z' });
    expect(k.volDurchschnitt3M).toBeNull(); // 4 abgeschlossene Tage < Mindestzahl
    expect(k.volDurchschnittAt).toBeNull();
  });

  it('Index: Volumen aus der Kerze, nicht aus Meta (^NDX: Meta 805 M gegen Kerzen 7,9 Mrd.)', () => {
    const bars = [bar(100, 7_900_000_000), bar(101, 8_100_000_000)];
    expect(kennzahlenAus({ regularMarketVolume: 805_181_993 }, bars, 'x').volumen).toBe(8_100_000_000);
    // Kerze ohne Volumen → Meta als Rückfall
    expect(kennzahlenAus({ regularMarketVolume: 805_181_993 }, [bar(100, 0), bar(101, 0)], 'x').volumen).toBe(805_181_993);
  });

  it('Wochenende/Vorbörse: die letzte Kerze ist die letzte SESSION, „Vortag" der Tag davor — wie Yahoos Previous Close', () => {
    // Samstag: Freitag ist die letzte Kerze, Donnerstag der Vortag
    const bars = [bar(100), bar(102), bar(105 /* Do */), bar(107 /* Fr */)];
    const k = kennzahlenAus({}, bars, '2026-10-10T09:00:00.000Z');
    expect(k.vortag).toBe(105);
    expect(k.oeffnen).toBe(106); // Eröffnung der Freitags-Session
  });

  it('Namen werden getrimmt (SAP.DE shortName mit Füllzeichen), Ø trägt seinen Zeitstempel', () => {
    const bars = Array.from({ length: 70 }, () => bar(10, 1_000));
    const k = kennzahlenAus({ shortName: 'SAP SE                        I' }, bars, '2026-10-08T14:00:00.000Z');
    expect(k.name).toBe('SAP SE                        I'.trim());
    expect(k.volDurchschnitt3M).toBe(1000);
    expect(k.volDurchschnittAt).toBe('2026-10-08T14:00:00.000Z');
  });

  it('FX/Index: Volumen 0 → null; Tagesspanne fällt auf die letzte Kerze zurück; Name aus shortName/exchangeName', () => {
    const bars = [bar(1.08, 0), bar(1.09, 0, 1.085, 1.095, 1.08)];
    const k = kennzahlenAus({ regularMarketVolume: 0, shortName: 'EUR/USD', exchangeName: 'CCY', currency: 'USD' }, bars, 'x');
    expect(k.volumen).toBeNull();
    expect(k.tagHoch).toBe(1.095);
    expect(k.tagTief).toBe(1.08);
    expect(k.w52Hoch).toBeNull();
    expect(k.name).toBe('EUR/USD');
    expect(k.boerse).toBe('CCY');
  });

  it('eine einzige Kerze: kein Vortag, kein Absturz; leere Serie ebenso', () => {
    expect(kennzahlenAus({}, [bar(5)], 'x').vortag).toBeNull();
    expect(kennzahlenAus({}, [], 'x')).toMatchObject({ vortag: null, oeffnen: null, tagHoch: null, volumen: null, name: null });
  });

  it('kaputte Meta-Werte (NaN, negativ, leere Strings) werden null', () => {
    const k = kennzahlenAus({ regularMarketDayHigh: Number.NaN, fiftyTwoWeekLow: -1, longName: '', currency: '' }, [bar(10), bar(11)], 'x');
    expect(k.tagHoch).toBe(12); // Rückfall auf die Kerze
    expect(k.w52Tief).toBeNull();
    expect(k.name).toBeNull();
    expect(k.waehrung).toBeNull();
  });
});

describe('durchschnittsVolumen', () => {
  it('nimmt die letzten 63 ABGESCHLOSSENEN Tage (die laufende Kerze zählt nicht) und braucht mindestens 40 mit Volumen', () => {
    expect(VOL_DURCHSCHNITT_TAGE).toBe(63);
    expect(VOL_DURCHSCHNITT_MIN).toBe(40);
    const alt = Array.from({ length: 100 }, () => bar(10, 1_000_000));
    const fenster = Array.from({ length: 63 }, () => bar(10, 2_000_000));
    const heute = [bar(10, 99_000_000)];
    expect(durchschnittsVolumen([...alt, ...fenster, ...heute])).toBe(2_000_000);
    // 39 Tage mit Volumen: zu wenig
    const wenig = [...Array.from({ length: 39 }, () => bar(10, 500)), bar(10, 500)];
    expect(durchschnittsVolumen(wenig)).toBeNull();
    const genug = [...Array.from({ length: 40 }, () => bar(10, 500)), bar(10, 500)];
    expect(durchschnittsVolumen(genug)).toBe(500);
    // Tage ohne Volumen (FX) zählen weder in den Nenner noch in die Mindestzahl
    expect(durchschnittsVolumen(Array.from({ length: 80 }, () => bar(1, 0)))).toBeNull();
  });
});

describe('kennzahlenFelder — der 5d-Abruf überschreibt NICHTS mit null (Red-Team M2)', () => {
  it('lässt JEDES null-Feld weg, nicht nur das Ø; undefined-Eingabe ergibt {}', () => {
    const k = kennzahlenAus({ regularMarketVolume: 5 }, [bar(1)], 'x'); // eine Kerze: kein Vortag, kein 52W, kein Ø
    const f = kennzahlenFelder(k);
    expect(f).not.toHaveProperty('volDurchschnitt3M');
    expect(f).not.toHaveProperty('vortag');
    expect(f).not.toHaveProperty('w52Hoch');
    expect(f).not.toHaveProperty('name');
    expect(f).toMatchObject({ updatedAt: 'x' });
    expect(Object.values(f).some((v) => v === null || v === undefined)).toBe(false);
    expect(kennzahlenFelder({ ...k, volDurchschnitt3M: 123, volDurchschnittAt: 'y' })).toMatchObject({ volDurchschnitt3M: 123, volDurchschnittAt: 'y' });
    expect(kennzahlenFelder(undefined)).toEqual({});
    expect(kennzahlenFelder(null)).toEqual({});
  });
});

describe('volDurchschnittFrisch', () => {
  it('frisch bis VOL_DURCHSCHNITT_FRISCH_TAGE, danach „—"', () => {
    expect(VOL_DURCHSCHNITT_FRISCH_TAGE).toBe(4);
    const jetzt = Date.parse('2026-10-12T12:00:00.000Z');
    expect(volDurchschnittFrisch('2026-10-09T20:00:00.000Z', jetzt)).toBe(true); // Freitag → Montag
    expect(volDurchschnittFrisch('2026-10-07T20:00:00.000Z', jetzt)).toBe(false);
    expect(volDurchschnittFrisch(null, jetzt)).toBe(false);
    expect(volDurchschnittFrisch('kaputt', jetzt)).toBe(false);
  });
});
