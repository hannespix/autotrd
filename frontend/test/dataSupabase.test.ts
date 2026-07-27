/**
 * Umwandler der Supabase-Datenschicht (MS2, Teil 2).
 *
 * Der wichtigste Prüfpunkt ist die Zahlen-als-Text-Falle: PostgREST liefert
 * `numeric(20,4)` als String ("123.4500"), damit unterwegs keine
 * Nachkommastellen verloren gehen. Genau so kommen die Werte in den Antworten
 * der echten Instanz an — ungeprüft durchgereicht würde aus `close - open`
 * eine String-Verkettung, und der Chart zeichnete Unsinn, ohne dass irgendwo
 * ein Fehler entstünde. Die Tests unten benutzen deshalb durchgehend die
 * String-Form.
 */

import { describe, expect, it } from 'vitest';
import {
  toBar,
  toIndicatorRow,
  toMarketDoc,
  toSignalRow,
  type BarRow,
  type SignalDbRow,
  type SymbolRow,
} from '../src/dataSupabase.js';

const SYM: SymbolRow = {
  symbol: 'BTC-USD',
  name: 'Bitcoin',
  asset_class: 'crypto',
  quote_price: '64123.4500',
  quote_change_pct: '-1.2345',
  quote_updated_at: '2026-07-27T13:37:42.694Z',
  sentiment: null,
  forecast: null,
  forecast_intraday: null,
};

describe('toMarketDoc', () => {
  it('macht aus Text-Zahlen echte Zahlen', () => {
    const d = toMarketDoc(SYM)!;
    expect(d.quote?.price).toBe(64123.45);
    expect(d.quote?.changePct).toBe(-1.2345);
    expect(typeof d.quote?.price).toBe('number');
    expect(d.quote?.updatedAt).toBe('2026-07-27T13:37:42.694Z');
    expect(d.name).toBe('Bitcoin');
    expect(d.assetClass).toBe('crypto');
  });

  it('lässt den Kurs WEG, wenn es keinen gibt — statt 0 zu behaupten', () => {
    // Ein Kurs von 0 wäre eine Aussage; „noch nicht gescannt" ist keine.
    // Die Oberfläche zeigt bei fehlendem Feld „--".
    const d = toMarketDoc({ ...SYM, quote_price: null })!;
    expect(d.quote).toBeUndefined();
    expect('quote' in d).toBe(false);
  });

  it('setzt fehlende Textfelder gar nicht erst (exactOptionalPropertyTypes)', () => {
    const d = toMarketDoc({ ...SYM, name: null, asset_class: null })!;
    expect('name' in d).toBe(false);
    expect('assetClass' in d).toBe(false);
  });

  it('reicht die Prognose-Felder als null durch, wenn sie fehlen', () => {
    const d = toMarketDoc(SYM)!;
    expect(d.forecast).toBeNull();
    expect(d.forecastIntraday).toBeNull();
  });

  it('liefert null für eine fehlende Zeile', () => {
    expect(toMarketDoc(null)).toBeNull();
  });
});

describe('toBar', () => {
  it('wandelt eine Tagesbar samt Text-Zahlen um', () => {
    const r: BarRow = {
      day: '2026-07-24',
      open: '100.0000',
      high: '105.5000',
      low: '99.2500',
      close: '104.1000',
      volume: '1234567',
    };
    expect(toBar(r)).toEqual({
      date: '2026-07-24',
      open: 100,
      high: 105.5,
      low: 99.25,
      close: 104.1,
      volume: 1234567,
    });
  });

  it('rechnet mit den Werten korrekt — der eigentliche Zweck der Umwandlung', () => {
    const b = toBar({ day: 'x', open: '100.0000', high: '1', low: '1', close: '104.1000', volume: null });
    expect(b.close - b.open).toBeCloseTo(4.1, 10); // nicht "104.1000100.0000"
  });

  it('nimmt bei 5-Minuten-Bars die Unix-Sekunde als Datum', () => {
    const b = toBar({ t: 1785157200, open: '1', high: '1', low: '1', close: '1', volume: null });
    expect(b.date).toBe('1785157200');
  });

  it('macht aus fehlendem Volumen 0, nicht NaN', () => {
    expect(toBar({ day: 'x', open: '1', high: '1', low: '1', close: '1', volume: null }).volume).toBe(0);
  });
});

const SIG: SignalDbRow = {
  direction: 'buy',
  confluence: 2,
  price: '431.2500',
  created_at: '2026-07-27T13:37:42.694Z',
  detail: { rsi: 28.4, macdHist: 0.42, bbPct: 0.03, votes: { rsi: 'buy', macd: 'buy', bollinger: 'hold' } },
};

describe('toSignalRow', () => {
  it('gewinnt Buy-/Sell-Stimmen aus den Einzelstimmen zurück', () => {
    // Die Tabelle speichert nur die Gewinnerzahl — die Aufschlüsselung muss
    // aus den Einzelstimmen kommen, sonst zeigt die Karte nach der Umstellung
    // andere Zahlen als vorher.
    const s = toSignalRow(SIG)!;
    expect(s.buyVotes).toBe(2);
    expect(s.sellVotes).toBe(0);
    expect(s.requiredConfluence).toBe(2);
    expect(s.direction).toBe('buy');
    expect(s.price).toBe(431.25);
  });

  it('kommt ohne detail-Feld zurecht', () => {
    const s = toSignalRow({ ...SIG, detail: null })!;
    expect(s.buyVotes).toBe(0);
    expect(s.sellVotes).toBe(0);
    expect(s.votes).toEqual({});
  });

  it('zählt Sell-Stimmen getrennt', () => {
    const s = toSignalRow({
      ...SIG,
      direction: 'sell',
      detail: { votes: { rsi: 'sell', macd: 'sell', bollinger: 'sell' } },
    })!;
    expect(s.sellVotes).toBe(3);
    expect(s.buyVotes).toBe(0);
  });

  it('liefert null ohne Zeile', () => {
    expect(toSignalRow(null)).toBeNull();
  });
});

describe('toIndicatorRow', () => {
  it('liest die Indikatoren aus dem Signal-Detail', () => {
    const i = toIndicatorRow(SIG)!;
    expect(i.rsi).toBe(28.4);
    expect(i.macd?.histogram).toBe(0.42);
    expect(i.bollinger?.pctB).toBe(0.03);
  });

  it('setzt fehlende Indikatoren auf null statt auf 0', () => {
    // 0 ist bei MACD-Histogramm und %B ein echter, aussagekräftiger Wert —
    // „nicht berechenbar" darf damit nicht verwechselt werden.
    const i = toIndicatorRow({ ...SIG, detail: { rsi: null, macdHist: null, bbPct: null } })!;
    expect(i.rsi).toBeNull();
    expect(i.macd).toBeNull();
    expect(i.bollinger).toBeNull();
  });

  it('behält eine echte 0 als 0', () => {
    const i = toIndicatorRow({ ...SIG, detail: { macdHist: 0, bbPct: 0 } })!;
    expect(i.macd?.histogram).toBe(0);
    expect(i.bollinger?.pctB).toBe(0);
  });

  it('liefert null, wenn gar kein Detail da ist', () => {
    expect(toIndicatorRow({ ...SIG, detail: null })).toBeNull();
    expect(toIndicatorRow(null)).toBeNull();
  });
});
