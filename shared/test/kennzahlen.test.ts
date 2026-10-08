/**
 * Task 19 (08.10.): Kennzahlen aus dem Yahoo-Chart-Abruf — pur.
 *
 * Die beiden Fallen aus der Bestandsaufnahme sind hier festgenagelt:
 * `chartPreviousClose` ist kein Vortag (AAPL 5d: 330,32 statt 336,67), und
 * Volumen 0 (FX, Indizes) heißt unbekannt, nicht null.
 */
import { describe, expect, it } from 'vitest';
import {
  VOL_DURCHSCHNITT_MIN,
  VOL_DURCHSCHNITT_TAGE,
  durchschnittsVolumen,
  kennzahlenAus,
  kennzahlenFelder,
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
    expect(k).toMatchObject({ tagHoch: 341.2, tagTief: 337.9, w52Hoch: 345.34, w52Tief: 243.42, volumen: 16_500_000, name: 'Apple Inc.', boerse: 'NasdaqGS', waehrung: 'USD', updatedAt: '2026-10-08T14:00:00.000Z' });
    expect(k.volDurchschnitt3M).toBeNull(); // 4 abgeschlossene Tage < Mindestzahl
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

describe('kennzahlenFelder — der 5d-Abruf überschreibt das Ø-Volumen des Scans nicht', () => {
  it('lässt volDurchschnitt3M weg, wenn null; sonst bleibt alles', () => {
    const k = kennzahlenAus({ regularMarketVolume: 5 }, [bar(1), bar(2)], 'x');
    expect(k.volDurchschnitt3M).toBeNull();
    expect(kennzahlenFelder(k)).not.toHaveProperty('volDurchschnitt3M');
    expect(kennzahlenFelder({ ...k, volDurchschnitt3M: 123 })).toMatchObject({ volDurchschnitt3M: 123, vortag: 1 });
    // keine undefined-Werte — Firestore lehnt sie ab
    for (const v of Object.values(kennzahlenFelder(k))) expect(v).not.toBeUndefined();
  });
});
