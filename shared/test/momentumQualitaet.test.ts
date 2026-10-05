/**
 * Qualitätsfilter der Momentum-Rangliste (Befund 05.10.): Der Sockel kaufte
 * auf allen Konten Kleinwerte und gehebelte ETFs. Gepinnt wird, was als
 * Hebelprodukt gilt (mit echten Alpaca-Namen), wann ein Kandidat fällt und
 * dass der Filter die Rangliste nur kürzt, nie umsortiert.
 */
import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_MIN_DOLLAR_UMSATZ,
  filtereRangliste,
  istHebelProdukt,
  medianDollarUmsatz,
  qualitaetsMangel,
} from '../src/index.js';

describe('istHebelProdukt', () => {
  it.each([
    'Direxion Daily Semiconductor Bull 3X Shares',
    'Direxion Daily Small Cap Bear 3X Shares',
    'ProShares UltraPro QQQ',
    'ProShares Ultra Bloomberg Crude Oil',
    'ProShares UltraShort 20+ Year Treasury',
    'ProShares Short S&P500',
    'T-Rex 2X Long MU Daily Target ETF',
    'GraniteShares 2x Long NVDA Daily ETF',
    'MicroSectors FANG+ Index -3X Inverse Leveraged ETN',
  ])('erkennt %s', (name) => {
    expect(istHebelProdukt(name)).toBe(true);
  });

  it.each([
    'Vanguard Short-Term Bond ETF',
    'iShares Short Treasury Bond ETF',
    'Apple Inc. Common Stock',
    'SPDR S&P 500 ETF Trust',
    'Bullfrog AI Holdings, Inc. Common Stock',
    'Invesco QQQ Trust, Series 1',
  ])('lässt %s durch', (name) => {
    expect(istHebelProdukt(name)).toBe(false);
  });
});

describe('qualitaetsMangel', () => {
  const gut = { imKatalog: false, name: 'Apple Inc.', letzterKurs: 200, medianDollarUmsatz: 1e9 };

  it('Katalog-Symbole laufen ungeprüft durch — auch ohne Daten', () => {
    expect(qualitaetsMangel({ imKatalog: true, name: '', letzterKurs: null, medianDollarUmsatz: null })).toBeNull();
  });
  it('ein liquider Universums-Wert ist zugelassen', () => {
    expect(qualitaetsMangel(gut)).toBeNull();
  });
  it('Hebelprodukt → hebel', () => {
    expect(qualitaetsMangel({ ...gut, name: 'ProShares UltraPro QQQ' })).toBe('hebel');
  });
  it('unter 5 $ oder ohne Kurs → preis', () => {
    expect(qualitaetsMangel({ ...gut, letzterKurs: 4.99 })).toBe('preis');
    expect(qualitaetsMangel({ ...gut, letzterKurs: null })).toBe('preis');
  });
  it('Umsatz unbekannt → keine_daten (nicht stillschweigend zugelassen)', () => {
    expect(qualitaetsMangel({ ...gut, medianDollarUmsatz: null })).toBe('keine_daten');
  });
  it('zu wenig Umsatz → umsatz (der CCG-Fall: ~6 $, dünn gehandelt)', () => {
    expect(qualitaetsMangel({ ...gut, letzterKurs: 6.5, medianDollarUmsatz: MOMENTUM_MIN_DOLLAR_UMSATZ - 1 })).toBe('umsatz');
  });
});

describe('medianDollarUmsatz', () => {
  it('Median aus Kurs × Volumen der letzten 20 Tage', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ close: 10, volume: i < 10 ? 1 : 1_000_000 }));
    expect(medianDollarUmsatz(bars)).toBe(10_000_000);
  });
  it('unter 10 brauchbaren Tagen → null', () => {
    expect(medianDollarUmsatz([{ close: 10, volume: 100 }])).toBeNull();
  });
  it('Tage ohne Volumen zählen nicht', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ close: 10, volume: i % 2 === 0 ? 0 : 500_000 }));
    expect(medianDollarUmsatz(bars)).toBe(5_000_000);
  });
});

describe('filtereRangliste', () => {
  it('kürzt die Liste, behält die Reihenfolge und nennt jeden Grund', () => {
    const ranked = [{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }, { symbol: 'D' }];
    const r = filtereRangliste(ranked, (s) => (s === 'B' ? 'hebel' : s === 'D' ? 'umsatz' : null));
    expect(r.zugelassen.map((x) => x.symbol)).toEqual(['A', 'C']);
    expect(r.verworfen).toEqual([
      { symbol: 'B', grund: 'hebel' },
      { symbol: 'D', grund: 'umsatz' },
    ]);
  });
});
