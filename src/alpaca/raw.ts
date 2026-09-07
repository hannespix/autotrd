/**
 * Roh-JSON von Alpaca → typisierte Objekte aus `types.ts`.
 *
 * Alpaca liefert Zahlen als Strings ("150.25"), Zeiten als ISO-8601 und
 * lässt Felder je nach Endpunkt weg oder setzt sie auf null. Diese Mapper
 * sind die EINZIGE Stelle, an der das Format geglättet wird: Optionale
 * Felder werden nie zum Wurf, Pflichtfelder (z. B. `id`) melden klar,
 * was fehlt — ein stiller Default wäre hier gefährlicher als ein Fehler.
 */
import type { AssetClass, Bar, Ms } from '../core/types.ts';
import type { CalendarDay } from '../core/time.ts';
import type {
  AlpacaAccount,
  AlpacaAsset,
  AlpacaClock,
  AlpacaOrder,
  AlpacaPosition,
  LatestQuote,
  OrderClass,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradeUpdate,
  TradeUpdateEvent,
} from './types.ts';
import { fromPositionSymbol } from './symbols.ts';

export type RawObject = Record<string, unknown>;

/* ───────────────────────── Primitive Helfer ───────────────────────── */

export function isObject(v: unknown): v is RawObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Erzwingt ein JSON-Objekt; `what` benennt den Kontext in der Fehlermeldung. */
export function asObject(v: unknown, what: string): RawObject {
  if (!isObject(v)) throw new Error(`${what}: erwartet JSON-Objekt, bekommen ${describe(v)}`);
  return v;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'Array';
  return typeof v;
}

/** "12.5" | 12.5 → 12.5; null/undefined/""/NaN → null. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toNumOr(v: unknown, fallback: number): number {
  return toNum(v) ?? fallback;
}

export function toStr(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** true/"true"/1 → true; alles andere false. */
export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return false;
}

/** ISO-8601 (auch mit Nanosekunden, wie Alpaca sie sendet) oder Epoch-ms → Epoch-ms; ungültig → null. */
export function toMs(v: unknown): Ms | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export function requireStr(obj: RawObject, key: string, what: string): string {
  const s = toStr(obj[key]);
  if (s === null || s === '') throw new Error(`${what}: Pflichtfeld "${key}" fehlt`);
  return s;
}

function requireNum(obj: RawObject, key: string, what: string): number {
  const n = toNum(obj[key]);
  if (n === null) throw new Error(`${what}: Pflichtfeld "${key}" fehlt oder ist keine Zahl`);
  return n;
}

function requireMs(obj: RawObject, key: string, what: string): Ms {
  const ms = toMs(obj[key]);
  if (ms === null) throw new Error(`${what}: Pflichtfeld "${key}" fehlt oder ist kein Zeitstempel`);
  return ms;
}

function toAssetClass(v: unknown, fallback: AssetClass): AssetClass {
  if (v === 'crypto') return 'crypto';
  if (v === 'us_equity') return 'us_equity';
  return fallback;
}

/* ───────────────────────── Mapper ───────────────────────── */

export function mapAccount(raw: unknown): AlpacaAccount {
  const o = asObject(raw, 'Alpaca-Account');
  return {
    id: requireStr(o, 'id', 'Alpaca-Account'),
    status: toStr(o.status) ?? 'UNKNOWN',
    currency: toStr(o.currency) ?? 'USD',
    equity: toNumOr(o.equity, 0),
    lastEquity: toNumOr(o.last_equity, 0),
    cash: toNumOr(o.cash, 0),
    buyingPower: toNumOr(o.buying_power, 0),
    daytradingBuyingPower: toNumOr(o.daytrading_buying_power, 0),
    multiplier: toNumOr(o.multiplier, 1),
    daytradeCount: toNumOr(o.daytrade_count, 0),
    patternDayTrader: toBool(o.pattern_day_trader),
    tradingBlocked: toBool(o.trading_blocked),
    accountBlocked: toBool(o.account_blocked),
    shortingEnabled: toBool(o.shorting_enabled),
  };
}

export function mapClock(raw: unknown): AlpacaClock {
  const o = asObject(raw, 'Alpaca-Clock');
  // Alle vier Felder sind Pflicht: eine Uhr ohne Zeit hilft niemandem.
  return {
    timestamp: requireMs(o, 'timestamp', 'Alpaca-Clock'),
    isOpen: toBool(o.is_open),
    nextOpen: requireMs(o, 'next_open', 'Alpaca-Clock'),
    nextClose: requireMs(o, 'next_close', 'Alpaca-Clock'),
  };
}

export function mapAsset(raw: unknown): AlpacaAsset {
  const o = asObject(raw, 'Alpaca-Asset');
  const assetClass = toAssetClass(o.class, 'us_equity');
  return {
    symbol: fromPositionSymbol(requireStr(o, 'symbol', 'Alpaca-Asset'), assetClass),
    assetClass,
    status: toStr(o.status) ?? 'unknown',
    tradable: toBool(o.tradable),
    shortable: toBool(o.shortable),
    easyToBorrow: toBool(o.easy_to_borrow),
    fractionable: toBool(o.fractionable),
    marginable: toBool(o.marginable),
    minOrderSize: toNum(o.min_order_size),
    priceIncrement: toNum(o.price_increment),
  };
}

/**
 * Position aus /v2/positions. Alpaca meldet Shorts mit negativer `qty`
 * UND `side: "short"`; das Vorzeichen ist die verlässlichere Quelle.
 * `fallbackAssetClass` greift, wenn `asset_class` fehlt.
 */
export function mapPosition(raw: unknown, fallbackAssetClass: AssetClass = 'us_equity'): AlpacaPosition {
  const o = asObject(raw, 'Alpaca-Position');
  const assetClass = toAssetClass(o.asset_class, fallbackAssetClass);
  const signedQty = toNumOr(o.qty, 0);
  const side: 'long' | 'short' = signedQty < 0 || o.side === 'short' ? 'short' : 'long';
  return {
    symbol: fromPositionSymbol(requireStr(o, 'symbol', 'Alpaca-Position'), assetClass),
    side,
    qty: Math.abs(signedQty),
    avgEntryPrice: toNumOr(o.avg_entry_price, 0),
    currentPrice: toNumOr(o.current_price, 0),
    marketValue: toNumOr(o.market_value, 0),
    unrealizedPl: toNumOr(o.unrealized_pl, 0),
    assetClass,
  };
}

function toSide(v: unknown, what: string): 'buy' | 'sell' {
  if (v === 'buy' || v === 'sell') return v;
  // Eine Order ohne Richtung kann die Engine nicht buchen — lieber laut scheitern.
  throw new Error(`${what}: Pflichtfeld "side" fehlt oder ist ungültig (${String(v)})`);
}

export function mapOrder(raw: unknown): AlpacaOrder {
  const o = asObject(raw, 'Alpaca-Order');
  const what = 'Alpaca-Order';
  const assetClass = toAssetClass(o.asset_class, 'us_equity');
  const orderClass = toStr(o.order_class);
  const rawLegs = Array.isArray(o.legs) ? o.legs : [];
  return {
    id: requireStr(o, 'id', what),
    clientOrderId: toStr(o.client_order_id) ?? '',
    symbol: fromPositionSymbol(requireStr(o, 'symbol', what), assetClass),
    side: toSide(o.side, what),
    // Alpaca sendet `type` und (älter) `order_type` — beide gleichbedeutend.
    type: (toStr(o.type) ?? toStr(o.order_type) ?? 'market') as OrderType,
    timeInForce: (toStr(o.time_in_force) ?? 'day') as TimeInForce,
    // Einfache Orders tragen order_class "" — das ist "simple".
    orderClass: (orderClass && orderClass !== '' ? orderClass : 'simple') as OrderClass,
    qty: toNum(o.qty),
    notional: toNum(o.notional),
    filledQty: toNumOr(o.filled_qty, 0),
    filledAvgPrice: toNum(o.filled_avg_price),
    limitPrice: toNum(o.limit_price),
    stopPrice: toNum(o.stop_price),
    status: requireStr(o, 'status', what) as OrderStatus,
    submittedAt: toMs(o.submitted_at) ?? toMs(o.created_at),
    filledAt: toMs(o.filled_at),
    canceledAt: toMs(o.canceled_at),
    legs: rawLegs.map((leg) => mapOrder(leg)),
    hwm: toNum(o.hwm),
  };
}

/**
 * `data`-Teil einer trade_updates-Nachricht. `fallbackTs` (z. B. Empfangszeit)
 * greift nur, wenn Alpaca keinen Zeitstempel mitschickt.
 */
export function mapTradeUpdate(raw: unknown, fallbackTs?: Ms): TradeUpdate {
  const o = asObject(raw, 'Alpaca-TradeUpdate');
  const event = requireStr(o, 'event', 'Alpaca-TradeUpdate') as TradeUpdateEvent;
  const order = mapOrder(o.order);
  const timestamp = toMs(o.timestamp) ?? fallbackTs ?? order.filledAt ?? order.submittedAt ?? 0;
  return {
    event,
    order,
    price: toNum(o.price),
    qty: toNum(o.qty),
    positionQty: toNum(o.position_qty),
    timestamp,
    executionId: toStr(o.execution_id),
  };
}

/** Bar aus REST oder Stream: {t,o,h,l,c,v,n,vw} mit ISO-`t` → Epoch-ms. */
export function mapBar(raw: unknown): Bar {
  const o = asObject(raw, 'Alpaca-Bar');
  const what = 'Alpaca-Bar';
  const bar: Bar = {
    t: requireMs(o, 't', what),
    o: requireNum(o, 'o', what),
    h: requireNum(o, 'h', what),
    l: requireNum(o, 'l', what),
    c: requireNum(o, 'c', what),
    v: toNumOr(o.v, 0),
  };
  // Optionale Felder nur setzen, wenn vorhanden (exactOptionalPropertyTypes: kein explizites undefined).
  const vw = toNum(o.vw);
  if (vw !== null) bar.vw = vw;
  const n = toNum(o.n);
  if (n !== null) bar.n = n;
  return bar;
}

/** Latest-Quote: {bp, ap, bs, as, t}; das Symbol steht im Schlüssel der Antwort, nicht im Objekt. */
export function mapQuote(symbol: string, raw: unknown): LatestQuote {
  const o = asObject(raw, `Alpaca-Quote ${symbol}`);
  return {
    symbol,
    bid: toNumOr(o.bp, 0),
    ask: toNumOr(o.ap, 0),
    bidSize: toNumOr(o.bs, 0),
    askSize: toNumOr(o.as, 0),
    t: toMs(o.t) ?? 0,
  };
}

export function mapCalendarDay(raw: unknown): CalendarDay {
  const o = asObject(raw, 'Alpaca-Kalendertag');
  return {
    date: requireStr(o, 'date', 'Alpaca-Kalendertag'),
    open: toStr(o.open) ?? '09:30',
    close: toStr(o.close) ?? '16:00',
  };
}
