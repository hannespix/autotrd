import { describe, expect, it } from 'vitest';
import {
  mapAccount,
  mapAsset,
  mapBar,
  mapCalendarDay,
  mapClock,
  mapOrder,
  mapPosition,
  mapQuote,
  mapTradeUpdate,
  toMs,
  toNum,
} from '../../src/alpaca/raw.ts';

const ORDER_RAW = {
  id: '61e69015-8549-4bfd-b9c3-01e75843f47d',
  client_order_id: 'autotrd-AAPL-1',
  created_at: '2021-03-16T18:38:01.942282Z',
  updated_at: '2021-03-16T18:38:01.942282Z',
  submitted_at: '2021-03-16T18:38:01.937734Z',
  filled_at: null,
  expired_at: null,
  canceled_at: null,
  asset_id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: 'AAPL',
  asset_class: 'us_equity',
  notional: null,
  qty: '10',
  filled_qty: '0',
  filled_avg_price: null,
  order_class: 'bracket',
  order_type: 'limit',
  type: 'limit',
  side: 'buy',
  time_in_force: 'day',
  limit_price: '150.25',
  stop_price: null,
  status: 'accepted',
  extended_hours: false,
  legs: [
    {
      id: 'leg-tp',
      client_order_id: 'autotrd-AAPL-1-tp',
      symbol: 'AAPL',
      side: 'sell',
      type: 'limit',
      time_in_force: 'gtc',
      qty: '10',
      filled_qty: '0',
      limit_price: '160',
      status: 'held',
      order_class: 'bracket',
      legs: null,
    },
    {
      id: 'leg-sl',
      client_order_id: 'autotrd-AAPL-1-sl',
      symbol: 'AAPL',
      side: 'sell',
      type: 'stop',
      time_in_force: 'gtc',
      qty: '10',
      filled_qty: '0',
      stop_price: '145',
      status: 'held',
      order_class: 'bracket',
      legs: null,
    },
  ],
  trail_percent: null,
  trail_price: null,
  hwm: null,
};

describe('Primitive', () => {
  it('toNum/toMs glätten Strings, null und Unsinn', () => {
    expect(toNum('150.25')).toBe(150.25);
    expect(toNum(3)).toBe(3);
    expect(toNum(null)).toBeNull();
    expect(toNum('')).toBeNull();
    expect(toNum('abc')).toBeNull();
    expect(toMs('2021-02-22T19:15:00Z')).toBe(Date.UTC(2021, 1, 22, 19, 15));
    expect(toMs('2021-03-16T18:38:01.937734Z')).toBe(Date.UTC(2021, 2, 16, 18, 38, 1, 937));
    expect(toMs(null)).toBeNull();
    expect(toMs('kein datum')).toBeNull();
  });
});

describe('mapAccount / mapClock', () => {
  it('Account: Strings → Zahlen, Flags → Booleans', () => {
    const acc = mapAccount({
      id: 'acc-1',
      status: 'ACTIVE',
      currency: 'USD',
      equity: '100000.5',
      last_equity: '99000',
      cash: '50000',
      buying_power: '200000',
      daytrading_buying_power: '400000',
      multiplier: '4',
      daytrade_count: 2,
      pattern_day_trader: false,
      trading_blocked: false,
      account_blocked: false,
      shorting_enabled: true,
    });
    expect(acc).toEqual({
      id: 'acc-1',
      status: 'ACTIVE',
      currency: 'USD',
      equity: 100000.5,
      lastEquity: 99000,
      cash: 50000,
      buyingPower: 200000,
      daytradingBuyingPower: 400000,
      multiplier: 4,
      daytradeCount: 2,
      patternDayTrader: false,
      tradingBlocked: false,
      accountBlocked: false,
      shortingEnabled: true,
    });
  });

  it('Account ohne id wirft mit klarer Meldung; optionale Felder fehlen still', () => {
    expect(() => mapAccount({ status: 'ACTIVE' })).toThrow(/Pflichtfeld "id"/);
    const acc = mapAccount({ id: 'x' });
    expect(acc.equity).toBe(0);
    expect(acc.multiplier).toBe(1);
    expect(acc.patternDayTrader).toBe(false);
  });

  it('Clock: ISO → ms', () => {
    const clock = mapClock({
      timestamp: '2024-05-06T13:00:00.123Z',
      is_open: true,
      next_open: '2024-05-07T13:30:00Z',
      next_close: '2024-05-06T20:00:00Z',
    });
    expect(clock.timestamp).toBe(Date.UTC(2024, 4, 6, 13, 0, 0, 123));
    expect(clock.isOpen).toBe(true);
    expect(clock.nextOpen).toBe(Date.UTC(2024, 4, 7, 13, 30));
    expect(clock.nextClose).toBe(Date.UTC(2024, 4, 6, 20));
    expect(() => mapClock({ is_open: true })).toThrow(/timestamp/);
  });
});

describe('mapAsset', () => {
  it('Aktie und Krypto (Symbol kanonisch)', () => {
    const a = mapAsset({
      id: 'a1',
      class: 'us_equity',
      symbol: 'AAPL',
      status: 'active',
      tradable: true,
      marginable: true,
      shortable: true,
      easy_to_borrow: true,
      fractionable: true,
      min_order_size: null,
      price_increment: null,
    });
    expect(a.assetClass).toBe('us_equity');
    expect(a.shortable).toBe(true);
    expect(a.minOrderSize).toBeNull();
    const c = mapAsset({ class: 'crypto', symbol: 'BTCUSD', status: 'active', tradable: true, min_order_size: '0.0001', price_increment: '0.01' });
    expect(c.symbol).toBe('BTC/USD');
    expect(c.assetClass).toBe('crypto');
    expect(c.minOrderSize).toBe(0.0001);
    expect(c.priceIncrement).toBe(0.01);
    expect(c.shortable).toBe(false);
  });
});

describe('mapPosition', () => {
  it('Short: negative qty ⇒ side short, qty positiv', () => {
    const p = mapPosition({
      symbol: 'TSLA',
      asset_class: 'us_equity',
      qty: '-10',
      side: 'short',
      avg_entry_price: '200.5',
      current_price: '190',
      market_value: '-1900',
      unrealized_pl: '105',
    });
    expect(p.side).toBe('short');
    expect(p.qty).toBe(10);
    expect(p.avgEntryPrice).toBe(200.5);
    expect(p.marketValue).toBe(-1900);
    expect(p.unrealizedPl).toBe(105);
  });

  it('Krypto aus dem Bestand: BTCUSD → BTC/USD', () => {
    const p = mapPosition({ symbol: 'BTCUSD', asset_class: 'crypto', qty: '0.5', side: 'long', avg_entry_price: '60000' });
    expect(p.symbol).toBe('BTC/USD');
    expect(p.assetClass).toBe('crypto');
    expect(p.side).toBe('long');
    expect(p.qty).toBe(0.5);
  });

  it('asset_class fehlt ⇒ Fallback des Clients', () => {
    expect(mapPosition({ symbol: 'ETHUSD', qty: '1' }, 'crypto').symbol).toBe('ETH/USD');
    expect(mapPosition({ symbol: 'ETHUSD', qty: '1' }).symbol).toBe('ETHUSD');
  });
});

describe('mapOrder', () => {
  it('vollständige Bracket-Order inkl. Beine', () => {
    const o = mapOrder(ORDER_RAW);
    expect(o.id).toBe(ORDER_RAW.id);
    expect(o.clientOrderId).toBe('autotrd-AAPL-1');
    expect(o.symbol).toBe('AAPL');
    expect(o.side).toBe('buy');
    expect(o.type).toBe('limit');
    expect(o.timeInForce).toBe('day');
    expect(o.orderClass).toBe('bracket');
    expect(o.qty).toBe(10);
    expect(o.notional).toBeNull();
    expect(o.filledQty).toBe(0);
    expect(o.filledAvgPrice).toBeNull();
    expect(o.limitPrice).toBe(150.25);
    expect(o.stopPrice).toBeNull();
    expect(o.status).toBe('accepted');
    expect(o.submittedAt).toBe(Date.UTC(2021, 2, 16, 18, 38, 1, 937));
    expect(o.filledAt).toBeNull();
    expect(o.canceledAt).toBeNull();
    expect(o.hwm).toBeNull();
    expect(o.legs).toHaveLength(2);
    expect(o.legs[0]?.id).toBe('leg-tp');
    expect(o.legs[0]?.limitPrice).toBe(160);
    expect(o.legs[1]?.stopPrice).toBe(145);
    expect(o.legs[1]?.legs).toEqual([]);
  });

  it('fehlende Felder → null/0/Defaults; order_class "" ⇒ simple; Krypto-Symbol kanonisch', () => {
    const o = mapOrder({ id: 'o1', symbol: 'BTCUSD', asset_class: 'crypto', side: 'sell', status: 'filled', order_class: '', filled_avg_price: '61000.5' });
    expect(o.symbol).toBe('BTC/USD');
    expect(o.orderClass).toBe('simple');
    expect(o.type).toBe('market');
    expect(o.timeInForce).toBe('day');
    expect(o.qty).toBeNull();
    expect(o.filledQty).toBe(0);
    expect(o.filledAvgPrice).toBe(61000.5);
    expect(o.legs).toEqual([]);
    expect(o.submittedAt).toBeNull();
    expect(o.clientOrderId).toBe('');
  });

  it('Pflichtfelder: id, symbol, side, status', () => {
    expect(() => mapOrder({ symbol: 'AAPL', side: 'buy', status: 'new' })).toThrow(/Pflichtfeld "id"/);
    expect(() => mapOrder({ id: 'x', side: 'buy', status: 'new' })).toThrow(/Pflichtfeld "symbol"/);
    expect(() => mapOrder({ id: 'x', symbol: 'AAPL', status: 'new' })).toThrow(/"side"/);
    expect(() => mapOrder({ id: 'x', symbol: 'AAPL', side: 'buy' })).toThrow(/Pflichtfeld "status"/);
    expect(() => mapOrder(null)).toThrow(/JSON-Objekt/);
  });
});

describe('mapTradeUpdate', () => {
  it('Fill mit Preis/Menge/Position und Zeitstempel', () => {
    const u = mapTradeUpdate({
      event: 'fill',
      execution_id: 'exec-1',
      price: '150.3',
      qty: '10',
      position_qty: '10',
      timestamp: '2021-03-16T18:38:02.5Z',
      order: { ...ORDER_RAW, status: 'filled', filled_qty: '10', filled_avg_price: '150.3', legs: null },
    });
    expect(u.event).toBe('fill');
    expect(u.price).toBe(150.3);
    expect(u.qty).toBe(10);
    expect(u.positionQty).toBe(10);
    expect(u.executionId).toBe('exec-1');
    expect(u.timestamp).toBe(Date.UTC(2021, 2, 16, 18, 38, 2, 500));
    expect(u.order.status).toBe('filled');
    expect(u.order.filledAvgPrice).toBe(150.3);
  });

  it('ohne timestamp ⇒ Fallback (Empfangszeit)', () => {
    const u = mapTradeUpdate({ event: 'new', order: { id: 'o', symbol: 'AAPL', side: 'buy', status: 'new' } }, 123_456);
    expect(u.timestamp).toBe(123_456);
    expect(u.price).toBeNull();
    expect(u.executionId).toBeNull();
  });
});

describe('mapBar / mapQuote / mapCalendarDay', () => {
  it('Bar: ISO-t → ms, Zahlen, optionale n/vw nur wenn vorhanden', () => {
    const bar = mapBar({ t: '2021-02-22T19:15:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 100, n: 10, vw: 1.2 });
    expect(bar).toEqual({ t: Date.UTC(2021, 1, 22, 19, 15), o: 1, h: 2, l: 0.5, c: 1.5, v: 100, n: 10, vw: 1.2 });
    const lean = mapBar({ t: '2021-02-22T19:16:00Z', o: '1', h: '2', l: '0.5', c: '1.5' });
    expect(lean.v).toBe(0);
    expect('n' in lean).toBe(false);
    expect('vw' in lean).toBe(false);
    expect(() => mapBar({ o: 1, h: 2, l: 0.5, c: 1.5 })).toThrow(/"t"/);
    expect(() => mapBar({ t: '2021-02-22T19:16:00Z', o: 1, h: 2, l: 0.5 })).toThrow(/"c"/);
  });

  it('Quote und Kalendertag', () => {
    const q = mapQuote('AAPL', { t: '2024-05-06T13:00:00Z', bp: 150.1, ap: 150.2, bs: 3, as: 5, ax: 'V', bx: 'V' });
    expect(q).toEqual({ symbol: 'AAPL', bid: 150.1, ask: 150.2, bidSize: 3, askSize: 5, t: Date.UTC(2024, 4, 6, 13) });
    expect(mapCalendarDay({ date: '2024-07-03', open: '09:30', close: '13:00', session_open: '0400' })).toEqual({
      date: '2024-07-03',
      open: '09:30',
      close: '13:00',
    });
    expect(() => mapCalendarDay({ open: '09:30' })).toThrow(/"date"/);
  });
});
