/**
 * Vertrag der Alpaca-Anbindung. Die Engine programmiert gegen DIESE
 * Schnittstelle (und testet gegen einen Fake); `rest.ts`/`stream.ts`
 * implementieren sie. Alle Zahlen sind hier bereits Zahlen (Alpaca liefert
 * Strings), Zeiten Epoch-ms, Mengen positiv mit expliziter Richtung.
 *
 * Symbole: Kanonisch ist überall die Alpaca-Trading-Schreibweise
 * (Aktien "AAPL", "BRK.B"; Krypto "BTC/USD"). `symbols.ts` übersetzt an
 * der API-Grenze (Bestand liefert Krypto als "BTCUSD").
 */
import type { Bar, Ms } from '../core/types.ts';
import type { CalendarDay } from '../core/time.ts';

export type AlpacaMode = 'paper' | 'live';

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  equity: number;
  lastEquity: number;
  cash: number;
  buyingPower: number;
  daytradingBuyingPower: number;
  multiplier: number;
  daytradeCount: number;
  patternDayTrader: boolean;
  tradingBlocked: boolean;
  accountBlocked: boolean;
  /** Alpaca `shorting_enabled`. */
  shortingEnabled: boolean;
}

export interface AlpacaClock {
  timestamp: Ms;
  isOpen: boolean;
  nextOpen: Ms;
  nextClose: Ms;
}

export interface AlpacaAsset {
  symbol: string;
  assetClass: 'us_equity' | 'crypto';
  status: string;
  tradable: boolean;
  shortable: boolean;
  easyToBorrow: boolean;
  fractionable: boolean;
  marginable: boolean;
  minOrderSize: number | null;
  priceIncrement: number | null;
}

export interface AlpacaPosition {
  /** Kanonische Schreibweise (siehe Kopf). */
  symbol: string;
  side: 'long' | 'short';
  /** Positiv; Richtung in `side`. */
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  assetClass: 'us_equity' | 'crypto';
}

export type OrderStatus =
  | 'new'
  | 'partially_filled'
  | 'filled'
  | 'done_for_day'
  | 'canceled'
  | 'expired'
  | 'replaced'
  | 'pending_cancel'
  | 'pending_replace'
  | 'accepted'
  | 'pending_new'
  | 'accepted_for_bidding'
  | 'stopped'
  | 'rejected'
  | 'suspended'
  | 'calculated'
  | 'held';

export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  'new',
  'partially_filled',
  'pending_cancel',
  'pending_replace',
  'accepted',
  'pending_new',
  'accepted_for_bidding',
  'calculated',
  'held',
];

export function isOpenStatus(s: OrderStatus): boolean {
  return OPEN_ORDER_STATUSES.includes(s);
}

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
export type TimeInForce = 'day' | 'gtc' | 'ioc' | 'fok' | 'opg' | 'cls';
export type OrderClass = 'simple' | 'bracket' | 'oco' | 'oto';

export interface AlpacaOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: OrderType;
  timeInForce: TimeInForce;
  orderClass: OrderClass;
  qty: number | null;
  notional: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  status: OrderStatus;
  submittedAt: Ms | null;
  filledAt: Ms | null;
  canceledAt: Ms | null;
  /** Bracket/OCO-Beine (nur bei nested=true). */
  legs: AlpacaOrder[];
  /** Für Trailing-Stops. */
  hwm: number | null;
}

export interface NewOrder {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type: OrderType;
  timeInForce: TimeInForce;
  clientOrderId: string;
  limitPrice?: number;
  stopPrice?: number;
  orderClass?: OrderClass;
  takeProfit?: { limitPrice: number };
  stopLoss?: { stopPrice: number; limitPrice?: number };
  extendedHours?: boolean;
}

export interface ReplaceOrder {
  qty?: number;
  limitPrice?: number;
  stopPrice?: number;
  clientOrderId?: string;
}

export type TradeUpdateEvent =
  | 'new'
  | 'fill'
  | 'partial_fill'
  | 'canceled'
  | 'expired'
  | 'rejected'
  | 'replaced'
  | 'pending_new'
  | 'pending_cancel'
  | 'pending_replace'
  | 'accepted'
  | 'stopped'
  | 'suspended'
  | 'calculated'
  | 'done_for_day'
  | 'order_replace_rejected'
  | 'order_cancel_rejected'
  | 'held';

export interface TradeUpdate {
  event: TradeUpdateEvent;
  order: AlpacaOrder;
  /** Ausführungspreis dieses Fills. */
  price: number | null;
  /** Menge dieses Fills. */
  qty: number | null;
  /** Position nach dem Fill (vorzeichenbehaftet). */
  positionQty: number | null;
  timestamp: Ms;
  executionId: string | null;
}

export interface LatestQuote {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  t: Ms;
}

/**
 * Bereinigung der Bars (Alpaca `adjustment`): `raw` = Kurse, wie sie
 * gehandelt wurden; `split` = Aktiensplits herausgerechnet; `dividend` =
 * Ausschüttungen herausgerechnet; `all` = beides. Der Client sendet sie nur
 * für Tagesbars (`rest.ts`); Minutenbars bleiben roh.
 */
export const BAR_ADJUSTMENTS = ['raw', 'split', 'dividend', 'all'] as const;
export type BarAdjustment = (typeof BAR_ADJUSTMENTS)[number];

export interface BarsRequest {
  symbols: string[];
  timeframe: '1Min' | '1Day';
  start: Ms;
  end?: Ms;
  feed?: 'iex' | 'sip';
  /** Seitengröße (max. 10000). */
  pageLimit?: number;
  /** Nur für `1Day` wirksam; Default `raw`. Bei `1Min` wird immer roh geladen, egal was hier steht. */
  adjustment?: BarAdjustment;
}

/** Fehler der Alpaca-API — Nachricht ist bereits geschwärzt. */
export class AlpacaError extends Error {
  override name = 'AlpacaError';
  readonly status: number;
  readonly code: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Trading + Market Data. Jede Methode: Timeout, Retry bei 429/5xx/Netz, Nachricht geschwärzt. */
export interface AlpacaClient {
  readonly mode: AlpacaMode;
  getAccount(): Promise<AlpacaAccount>;
  getClock(): Promise<AlpacaClock>;
  /** Handelstage im Bereich (inklusive), Datum YYYY-MM-DD. */
  getCalendar(start: string, end: string): Promise<CalendarDay[]>;
  getAsset(symbol: string): Promise<AlpacaAsset | null>;
  listPositions(): Promise<AlpacaPosition[]>;
  listOrders(opts: {
    status: 'open' | 'closed' | 'all';
    symbols?: string[];
    after?: Ms;
    limit?: number;
    nested?: boolean;
  }): Promise<AlpacaOrder[]>;
  getOrder(id: string): Promise<AlpacaOrder | null>;
  getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null>;
  submitOrder(order: NewOrder): Promise<AlpacaOrder>;
  replaceOrder(id: string, patch: ReplaceOrder): Promise<AlpacaOrder>;
  /** 204/404 ⇒ erfüllt; 422 (nicht stornierbar, z. B. schon gefüllt) ⇒ AlpacaError status 422. */
  cancelOrder(id: string): Promise<void>;
  cancelAllOrders(): Promise<void>;
  /** Marktorder zum Schließen; null, wenn keine Position. */
  closePosition(symbol: string, qty?: number): Promise<AlpacaOrder | null>;
  closeAllPositions(cancelOrders: boolean): Promise<void>;
  /** Vollständig paginiert; Symbole in kanonischer Schreibweise. */
  getBars(req: BarsRequest): Promise<Map<string, Bar[]>>;
  getLatestBars(symbols: string[]): Promise<Map<string, Bar>>;
  getLatestQuotes(symbols: string[]): Promise<Map<string, LatestQuote>>;
}

export type StreamStatus = 'connecting' | 'connected' | 'authenticated' | 'subscribed' | 'disconnected' | 'error';

export interface StreamStatusEvent {
  status: StreamStatus;
  detail?: string;
  at: Ms;
}

/** Minuten-Bars aus dem Datenstrom (wss://stream.data.alpaca.markets). */
export interface DataStream {
  connect(): Promise<void>;
  subscribeBars(symbols: string[]): Promise<void>;
  onBar(cb: (symbol: string, bar: Bar) => void): void;
  onStatus(cb: (ev: StreamStatusEvent) => void): void;
  /** Zeit der letzten empfangenen Nachricht (Frische). */
  lastMessageAt(): Ms | null;
  close(): Promise<void>;
}

/** Order-Ereignisse (wss://…/stream, trade_updates). */
export interface TradeStream {
  connect(): Promise<void>;
  onUpdate(cb: (u: TradeUpdate) => void): void;
  onStatus(cb: (ev: StreamStatusEvent) => void): void;
  lastMessageAt(): Ms | null;
  close(): Promise<void>;
}
