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
  toPosition,
  toSignalRow,
  toStrategyRow,
  toTradeRow,
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

describe('toPosition', () => {
  const P = {
    symbol: 'AAPL',
    side: 'long' as const,
    qty: '12.00000000',
    avg_entry: '187.4500',
    stop_loss: '180.0000',
    take_profit: '210.0000',
    high_water: '195.2000',
    low_water: null,
    opened_at: '2026-07-20T14:31:00.000Z',
  };

  it('wandelt Text-Zahlen und Spaltennamen um', () => {
    const p = toPosition(P);
    expect(p.qty).toBe(12);
    expect(p.avgEntry).toBe(187.45);
    expect(p.stopLoss).toBe(180);
    expect(p.takeProfit).toBe(210);
    expect(p.highWater).toBe(195.2);
    expect(p.openedAt).toBe('2026-07-20T14:31:00.000Z');
  });

  it('setzt side NUR bei Short — fehlend heißt long', () => {
    // Altbestand vor dem Short-Feature hat kein side; die Engine liest das
    // fehlende Feld als long. Ein gesetztes `undefined` würde das kippen.
    expect('side' in toPosition(P)).toBe(false);
    expect(toPosition({ ...P, side: 'short' }).side).toBe('short');
  });

  it('lässt fehlende Wasserstände WEG statt sie auf 0 zu setzen', () => {
    // 0 als Bezugspunkt eines Trailing-Stops wäre fatal: Der Stop läge
    // sofort weit unter jedem realen Kurs. Fehlt der Wert, startet das
    // Trailing bewusst konservativ am Einstand.
    const p = toPosition({ ...P, high_water: null, low_water: null });
    expect('highWater' in p).toBe(false);
    expect('lowWater' in p).toBe(false);
  });

  it('reicht fehlende Exits als null durch (Position ohne Stop)', () => {
    const p = toPosition({ ...P, stop_loss: null, take_profit: null });
    expect(p.stopLoss).toBeNull();
    expect(p.takeProfit).toBeNull();
  });
});

describe('toTradeRow', () => {
  const T = {
    symbol: 'BTC-USD',
    side: 'sell' as const,
    qty: '0.25000000',
    price: '64000.0000',
    executed_at: '2026-07-27T12:00:00.000Z',
    source: 'engine' as const,
    pnl: '-125.5000',
    risk_exit: 'stop_loss',
  };

  it('wandelt Text-Zahlen um und behält das Vorzeichen', () => {
    const t = toTradeRow(T);
    expect(t.qty).toBe(0.25);
    expect(t.price).toBe(64000);
    expect(t.pnl).toBe(-125.5);
    expect(t.riskExit).toBe('stop_loss');
    expect(t.executedAt).toBe('2026-07-27T12:00:00.000Z');
  });

  it('lässt pnl bei einem eröffnenden Trade ganz weg', () => {
    // 0 hieße „glatt raus"; ein Kauf hat aber gar kein Ergebnis. Die
    // Trade-Liste färbt nach diesem Feld.
    const t = toTradeRow({ ...T, side: 'buy', pnl: null, risk_exit: null });
    expect('pnl' in t).toBe(false);
    expect('riskExit' in t).toBe(false);
  });

  it('behält eine echte 0 als 0', () => {
    expect(toTradeRow({ ...T, pnl: '0.0000' }).pnl).toBe(0);
  });
});

describe('toStrategyRow', () => {
  const S = {
    id: 'abc-123',
    name: 'Momentum',
    draft: { buy: null, sell: null } as never,
    compiled: null,
    status: 'draft' as const,
    mode: 'paper' as const,
    symbols: ['AAPL', 'MSFT'],
    shadow: null,
    version: 0,
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-27T10:00:00.000Z',
  };

  it('benennt die Spalten auf die Frontend-Form um', () => {
    const r = toStrategyRow(S);
    expect(r.id).toBe('abc-123');
    expect(r.doc.name).toBe('Momentum');
    expect(r.doc.symbols).toEqual(['AAPL', 'MSFT']);
    expect(r.doc.createdAt).toBe('2026-07-01T10:00:00.000Z');
    expect(r.doc.updatedAt).toBe('2026-07-27T10:00:00.000Z');
  });

  it('nimmt ohne created_at das Änderungsdatum statt 1970', () => {
    const { created_at: _weg, ...ohne } = S;
    expect(toStrategyRow(ohne).doc.createdAt).toBe('2026-07-27T10:00:00.000Z');
  });

  it('macht aus fehlenden Symbolen eine leere Liste, nicht null', () => {
    expect(toStrategyRow({ ...S, symbols: null }).doc.symbols).toEqual([]);
  });

  it('setzt shadow nur, wenn es eines gibt', () => {
    expect('shadow' in toStrategyRow(S).doc).toBe(false);
  });
});
