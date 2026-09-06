/**
 * In-Memory-Broker für Tests: implementiert `AlpacaClient` mit Konto,
 * Positionen, Orders samt Status-Maschine, Bracket-Beinen (OCO) und per
 * `fill()` auslösbaren Fills. Zeichnet jeden Aufruf auf (`calls`), damit
 * Tests die REIHENFOLGE prüfen können (Storno → Warten → Marktorder), und
 * erlaubt per `throwOn()` gezielte Fehlerserien.
 */
import {
  AlpacaError,
  isOpenStatus,
  type AlpacaAccount,
  type AlpacaAsset,
  type AlpacaClient,
  type AlpacaClock,
  type AlpacaOrder,
  type AlpacaPosition,
  type BarsRequest,
  type LatestQuote,
  type NewOrder,
  type OrderStatus,
  type ReplaceOrder,
  type TradeUpdate,
  type TradeUpdateEvent,
} from '../../src/alpaca/types.ts';
import { DAY, HOUR, type CalendarDay } from '../../src/core/time.ts';
import type { Bar, Ms } from '../../src/core/types.ts';

interface OrderMeta {
  parentId: string | null;
  /** Geschwister-Bein (OCO): wird storniert, wenn dieses Bein füllt. */
  ocoId: string | null;
  pendingCancelPolls: number;
}

export interface FakeAlpacaOptions {
  mode?: 'paper' | 'live';
  equity?: number;
  cash?: number;
  assetClass?: 'us_equity' | 'crypto';
  now?: () => Ms;
}

export class FakeAlpaca implements AlpacaClient {
  readonly mode: 'paper' | 'live';
  account: AlpacaAccount;
  readonly assetClass: 'us_equity' | 'crypto';
  readonly positions = new Map<string, AlpacaPosition>();
  /** Alle Orders inkl. Beine, in Einfügereihenfolge (interne Objekte — Rückgaben sind Kopien). */
  readonly orders = new Map<string, AlpacaOrder>();
  readonly prices = new Map<string, number>();
  readonly bars = new Map<string, Bar[]>();
  readonly assets = new Map<string, AlpacaAsset>();
  calendarDays: CalendarDay[] = [];
  clock: AlpacaClock | null = null;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly barRequests: BarsRequest[] = [];
  /** Marktorders beim Absenden sofort füllen (Paper-Verhalten). */
  autoFillMarket = false;
  /** Ein Storno bleibt so viele Abfragen lang `pending_cancel`. */
  cancelDelayPolls = 0;
  now: () => Ms;
  private seq = 0;
  private readonly meta = new Map<string, OrderMeta>();
  private readonly failures = new Map<string, { error: unknown; times: number }>();
  private readonly listeners: Array<(u: TradeUpdate) => void> = [];

  constructor(opts: FakeAlpacaOptions = {}) {
    this.mode = opts.mode ?? 'paper';
    this.assetClass = opts.assetClass ?? 'us_equity';
    this.now = opts.now ?? (() => Date.now());
    const equity = opts.equity ?? 100_000;
    const cash = opts.cash ?? equity;
    this.account = {
      id: 'fake',
      status: 'ACTIVE',
      currency: 'USD',
      equity,
      lastEquity: equity,
      cash,
      buyingPower: cash * 2,
      daytradingBuyingPower: cash * 4,
      multiplier: 2,
      daytradeCount: 0,
      patternDayTrader: false,
      tradingBlocked: false,
      accountBlocked: false,
      shortingEnabled: true,
    };
  }

  /* ───────────── Test-Steuerung ───────────── */

  /** Methode `times`-mal (Default: immer) mit `error` scheitern lassen. */
  throwOn(method: keyof AlpacaClient, error: unknown, times = Number.POSITIVE_INFINITY): void {
    this.failures.set(method, { error, times });
  }

  clearFailures(): void {
    this.failures.clear();
  }

  onTradeUpdate(cb: (u: TradeUpdate) => void): void {
    this.listeners.push(cb);
  }

  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
    const p = this.positions.get(symbol);
    if (p) this.positions.set(symbol, this.withPrice(p, price));
  }

  /** Fremdbestand direkt setzen (ohne Order). */
  setPosition(symbol: string, side: 'long' | 'short', qty: number, avgEntryPrice: number, currentPrice = avgEntryPrice): void {
    this.positions.set(symbol, this.withPrice({ symbol, side, qty, avgEntryPrice, currentPrice, marketValue: 0, unrealizedPl: 0, assetClass: this.assetClass }, currentPrice));
  }

  callsOf(method: string): Array<{ method: string; args: unknown[] }> {
    return this.calls.filter((c) => c.method === method);
  }

  ordersFor(symbol: string): AlpacaOrder[] {
    return [...this.orders.values()].filter((o) => o.symbol === symbol).map((o) => this.view(o));
  }

  openOrders(symbol?: string): AlpacaOrder[] {
    return [...this.orders.values()].filter((o) => isOpenStatus(o.status) && (!symbol || o.symbol === symbol)).map((o) => this.view(o));
  }

  /** Order (ID oder client_order_id) über die Beine hinweg finden. */
  find(idOrClientId: string): AlpacaOrder | null {
    const byId = this.orders.get(idOrClientId);
    if (byId) return byId;
    for (const o of this.orders.values()) if (o.clientOrderId === idOrClientId) return o;
    return null;
  }

  /** Fill auslösen (Voll- oder Teilfill); Positionen, Bracket-Beine (OCO) und Ereignisse folgen. */
  fill(idOrClientId: string, price?: number, qty?: number): TradeUpdate {
    const order = this.find(idOrClientId);
    if (!order) throw new Error(`FakeAlpaca.fill: Order ${idOrClientId} unbekannt`);
    if (!isOpenStatus(order.status)) throw new Error(`FakeAlpaca.fill: Order ${order.id} ist ${order.status}`);
    const px = price ?? this.prices.get(order.symbol) ?? order.limitPrice ?? order.stopPrice ?? 100;
    const total = order.qty ?? 0;
    const remaining = total - order.filledQty;
    const q = Math.min(qty ?? remaining, remaining);
    if (!(q > 0)) throw new Error(`FakeAlpaca.fill: nichts mehr zu füllen bei ${order.id}`);
    const prev = order.filledQty;
    order.filledAvgPrice = ((order.filledAvgPrice ?? 0) * prev + px * q) / (prev + q);
    order.filledQty = prev + q;
    const complete = order.filledQty >= total - 1e-9;
    order.status = complete ? 'filled' : 'partially_filled';
    if (complete) order.filledAt = this.now();
    this.applyToPosition(order.symbol, order.side, q, px);
    const update = this.makeUpdate(complete ? 'fill' : 'partial_fill', order, px, q);
    this.emit(update);
    if (complete) {
      for (const leg of this.children(order.id)) if (leg.status === 'held') leg.status = 'new';
      const m = this.meta.get(order.id);
      const sib = m?.ocoId ? this.orders.get(m.ocoId) : undefined;
      if (sib && isOpenStatus(sib.status)) this.doCancel(sib);
    }
    return update;
  }

  /* ───────────── AlpacaClient ───────────── */

  async getAccount(): Promise<AlpacaAccount> {
    this.guard('getAccount');
    return { ...this.account };
  }

  async getClock(): Promise<AlpacaClock> {
    this.guard('getClock');
    if (this.clock) return { ...this.clock };
    const now = this.now();
    return { timestamp: now, isOpen: false, nextOpen: now + DAY, nextClose: now + DAY + 6.5 * HOUR };
  }

  async getCalendar(start: string, end: string): Promise<CalendarDay[]> {
    this.guard('getCalendar', start, end);
    return this.calendarDays.filter((d) => d.date >= start && d.date <= end).map((d) => ({ ...d }));
  }

  async getAsset(symbol: string): Promise<AlpacaAsset | null> {
    this.guard('getAsset', symbol);
    const a = this.assets.get(symbol);
    if (a) return { ...a };
    return {
      symbol,
      assetClass: this.assetClass,
      status: 'active',
      tradable: true,
      shortable: this.assetClass === 'us_equity',
      easyToBorrow: this.assetClass === 'us_equity',
      fractionable: this.assetClass === 'crypto',
      marginable: this.assetClass === 'us_equity',
      minOrderSize: null,
      priceIncrement: null,
    };
  }

  async listPositions(): Promise<AlpacaPosition[]> {
    this.guard('listPositions');
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  async listOrders(opts: { status: 'open' | 'closed' | 'all'; symbols?: string[]; after?: Ms; limit?: number; nested?: boolean }): Promise<AlpacaOrder[]> {
    this.guard('listOrders', opts);
    this.tickPendingCancels();
    const match = (o: AlpacaOrder): boolean =>
      (opts.status === 'all' || (opts.status === 'open' ? isOpenStatus(o.status) : !isOpenStatus(o.status))) &&
      (!opts.symbols || opts.symbols.includes(o.symbol)) &&
      (opts.after === undefined || (o.submittedAt ?? 0) >= opts.after);
    let out: AlpacaOrder[] = [];
    if (opts.nested) {
      for (const o of this.orders.values()) {
        if (this.meta.get(o.id)?.parentId !== null) continue;
        const kids = this.children(o.id);
        if (match(o) || kids.some(match)) out.push(this.view(o));
      }
    } else {
      out = [...this.orders.values()].filter(match).map((o) => ({ ...o, legs: [] }));
    }
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out;
  }

  async getOrder(id: string): Promise<AlpacaOrder | null> {
    this.guard('getOrder', id);
    this.tickPendingCancels();
    const o = this.orders.get(id);
    return o ? this.view(o) : null;
  }

  async getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    this.guard('getOrderByClientId', clientOrderId);
    this.tickPendingCancels();
    for (const o of this.orders.values()) if (o.clientOrderId === clientOrderId) return this.view(o);
    return null;
  }

  async submitOrder(order: NewOrder): Promise<AlpacaOrder> {
    this.guard('submitOrder', order);
    for (const o of this.orders.values()) {
      if (o.clientOrderId === order.clientOrderId) throw new AlpacaError('client_order_id must be unique', 422, 40010001, false);
    }
    if (!(order.qty > 0)) throw new AlpacaError('qty must be > 0', 422, 42210000, false);
    if (this.assetClass === 'us_equity' && order.orderClass === 'bracket' && !Number.isInteger(order.qty)) {
      throw new AlpacaError('bracket orders require whole shares', 422, 42210000, false);
    }
    const id = this.nextId();
    const now = this.now();
    const o: AlpacaOrder = {
      id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      timeInForce: order.timeInForce,
      orderClass: order.orderClass ?? 'simple',
      qty: order.qty,
      notional: null,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: order.limitPrice ?? null,
      stopPrice: order.stopPrice ?? null,
      status: 'new',
      submittedAt: now,
      filledAt: null,
      canceledAt: null,
      legs: [],
      hwm: null,
    };
    this.orders.set(id, o);
    this.meta.set(id, { parentId: null, ocoId: null, pendingCancelPolls: 0 });
    if (order.orderClass === 'bracket') {
      if (!order.stopLoss) throw new AlpacaError('bracket orders require stop_loss', 422, 42210000, false);
      const legSide = order.side === 'buy' ? 'sell' : 'buy';
      const sl = this.createLeg(o, {
        side: legSide,
        type: order.stopLoss.limitPrice !== undefined ? 'stop_limit' : 'stop',
        stopPrice: order.stopLoss.stopPrice,
        limitPrice: order.stopLoss.limitPrice ?? null,
        suffix: 'sl',
      });
      if (order.takeProfit) {
        const tp = this.createLeg(o, { side: legSide, type: 'limit', stopPrice: null, limitPrice: order.takeProfit.limitPrice, suffix: 'tp' });
        this.meta.get(sl.id)!.ocoId = tp.id;
        this.meta.get(tp.id)!.ocoId = sl.id;
      }
    }
    this.emit(this.makeUpdate('new', o, null, null));
    if (this.autoFillMarket && order.type === 'market') this.fill(id);
    return this.view(o);
  }

  async replaceOrder(id: string, patch: ReplaceOrder): Promise<AlpacaOrder> {
    this.guard('replaceOrder', id, patch);
    const old = this.orders.get(id);
    if (!old) throw new AlpacaError(`order ${id} not found`, 404, 40410000, false);
    if (!isOpenStatus(old.status)) throw new AlpacaError(`order ${id} is not replaceable (${old.status})`, 422, 42210000, false);
    const newId = this.nextId();
    const fresh: AlpacaOrder = {
      ...old,
      id: newId,
      clientOrderId: patch.clientOrderId ?? `r-${newId}`,
      qty: patch.qty ?? old.qty,
      stopPrice: patch.stopPrice ?? old.stopPrice,
      limitPrice: patch.limitPrice ?? old.limitPrice,
      submittedAt: this.now(),
      legs: [],
    };
    const m = this.meta.get(id)!;
    old.status = 'replaced';
    this.orders.set(newId, fresh);
    this.meta.set(newId, { parentId: m.parentId, ocoId: m.ocoId, pendingCancelPolls: 0 });
    if (m.ocoId) {
      const sibMeta = this.meta.get(m.ocoId);
      if (sibMeta) sibMeta.ocoId = newId;
    }
    this.emit(this.makeUpdate('replaced', old, null, null));
    this.emit(this.makeUpdate('new', fresh, null, null));
    return this.view(fresh);
  }

  async cancelOrder(id: string): Promise<void> {
    this.guard('cancelOrder', id);
    const o = this.orders.get(id);
    if (!o) return; // 404 ⇒ erledigt
    if (!isOpenStatus(o.status)) throw new AlpacaError(`order ${id} is not cancelable (${o.status})`, 422, 42210000, false);
    if (this.cancelDelayPolls > 0) {
      o.status = 'pending_cancel';
      this.meta.get(id)!.pendingCancelPolls = this.cancelDelayPolls;
      return;
    }
    this.doCancel(o);
  }

  async cancelAllOrders(): Promise<void> {
    this.guard('cancelAllOrders');
    for (const o of [...this.orders.values()]) if (isOpenStatus(o.status)) this.doCancel(o);
  }

  async closePosition(symbol: string, qty?: number): Promise<AlpacaOrder | null> {
    this.guard('closePosition', symbol, qty);
    const p = this.positions.get(symbol);
    if (!p) return null;
    const id = this.nextId();
    const o: AlpacaOrder = {
      id,
      clientOrderId: `close-${id}`,
      symbol,
      side: p.side === 'long' ? 'sell' : 'buy',
      type: 'market',
      timeInForce: 'day',
      orderClass: 'simple',
      qty: qty ?? p.qty,
      notional: null,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: null,
      stopPrice: null,
      status: 'new',
      submittedAt: this.now(),
      filledAt: null,
      canceledAt: null,
      legs: [],
      hwm: null,
    };
    this.orders.set(id, o);
    this.meta.set(id, { parentId: null, ocoId: null, pendingCancelPolls: 0 });
    this.fill(id, this.prices.get(symbol) ?? p.currentPrice);
    return this.view(o);
  }

  async closeAllPositions(cancelOrders: boolean): Promise<void> {
    this.guard('closeAllPositions', cancelOrders);
    if (cancelOrders) for (const o of [...this.orders.values()]) if (isOpenStatus(o.status)) this.doCancel(o);
    for (const sym of [...this.positions.keys()]) await this.closePosition(sym);
  }

  async getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
    this.guard('getBars', req);
    this.barRequests.push({ ...req, symbols: [...req.symbols] });
    const out = new Map<string, Bar[]>();
    for (const s of req.symbols) {
      const all = this.bars.get(s) ?? [];
      out.set(
        s,
        all.filter((b) => b.t >= req.start && (req.end === undefined || b.t <= req.end)).map((b) => ({ ...b })),
      );
    }
    return out;
  }

  async getLatestBars(symbols: string[]): Promise<Map<string, Bar>> {
    this.guard('getLatestBars', symbols);
    const out = new Map<string, Bar>();
    for (const s of symbols) {
      const all = this.bars.get(s) ?? [];
      const last = all[all.length - 1];
      if (last) out.set(s, { ...last });
    }
    return out;
  }

  async getLatestQuotes(symbols: string[]): Promise<Map<string, LatestQuote>> {
    this.guard('getLatestQuotes', symbols);
    const out = new Map<string, LatestQuote>();
    for (const s of symbols) {
      const p = this.prices.get(s);
      if (p !== undefined) out.set(s, { symbol: s, bid: p - 0.01, ask: p + 0.01, bidSize: 100, askSize: 100, t: this.now() });
    }
    return out;
  }

  /* ───────────── intern ───────────── */

  private guard(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const f = this.failures.get(method);
    if (f && f.times > 0) {
      f.times--;
      if (f.times <= 0) this.failures.delete(method);
      throw f.error instanceof Error ? f.error : new Error(String(f.error));
    }
  }

  private nextId(): string {
    return `o-${++this.seq}`;
  }

  private children(parentId: string): AlpacaOrder[] {
    const out: AlpacaOrder[] = [];
    for (const o of this.orders.values()) if (this.meta.get(o.id)?.parentId === parentId) out.push(o);
    return out;
  }

  private view(o: AlpacaOrder): AlpacaOrder {
    return { ...o, legs: this.children(o.id).map((c) => ({ ...c, legs: [] })) };
  }

  private createLeg(parent: AlpacaOrder, a: { side: 'buy' | 'sell'; type: AlpacaOrder['type']; stopPrice: number | null; limitPrice: number | null; suffix: string }): AlpacaOrder {
    const id = `${parent.id}-${a.suffix}`;
    const leg: AlpacaOrder = {
      id,
      clientOrderId: `leg-${id}`,
      symbol: parent.symbol,
      side: a.side,
      type: a.type,
      timeInForce: parent.timeInForce,
      orderClass: 'bracket',
      qty: parent.qty,
      notional: null,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: a.limitPrice,
      stopPrice: a.stopPrice,
      status: 'held',
      submittedAt: parent.submittedAt,
      filledAt: null,
      canceledAt: null,
      legs: [],
      hwm: null,
    };
    this.orders.set(id, leg);
    this.meta.set(id, { parentId: parent.id, ocoId: null, pendingCancelPolls: 0 });
    return leg;
  }

  private doCancel(o: AlpacaOrder): void {
    if (!isOpenStatus(o.status)) return;
    o.status = 'canceled';
    o.canceledAt = this.now();
    this.emit(this.makeUpdate('canceled', o, null, null));
    for (const leg of this.children(o.id)) this.doCancel(leg);
    const m = this.meta.get(o.id);
    const sib = m?.ocoId ? this.orders.get(m.ocoId) : undefined;
    if (sib) this.doCancel(sib);
  }

  private tickPendingCancels(): void {
    for (const [id, m] of this.meta) {
      if (m.pendingCancelPolls <= 0) continue;
      m.pendingCancelPolls--;
      if (m.pendingCancelPolls === 0) {
        const o = this.orders.get(id);
        if (o && o.status === 'pending_cancel') {
          o.status = 'new';
          this.doCancel(o);
        }
      }
    }
  }

  private withPrice(p: AlpacaPosition, price: number): AlpacaPosition {
    const signed = p.side === 'long' ? p.qty : -p.qty;
    return { ...p, currentPrice: price, marketValue: signed * price, unrealizedPl: signed * (price - p.avgEntryPrice) };
  }

  private applyToPosition(symbol: string, side: 'buy' | 'sell', qty: number, price: number): void {
    const p = this.positions.get(symbol);
    const cur = p ? (p.side === 'long' ? p.qty : -p.qty) : 0;
    const next = cur + (side === 'buy' ? qty : -qty);
    this.prices.set(symbol, price);
    if (Math.abs(next) < 1e-9) {
      this.positions.delete(symbol);
      return;
    }
    let avg = p?.avgEntryPrice ?? price;
    const sameDirection = cur === 0 || Math.sign(next) === Math.sign(cur);
    if (cur === 0 || !sameDirection) avg = price;
    else if (Math.abs(next) > Math.abs(cur)) avg = (Math.abs(cur) * avg + qty * price) / Math.abs(next);
    const pos: AlpacaPosition = { symbol, side: next > 0 ? 'long' : 'short', qty: Math.abs(next), avgEntryPrice: avg, currentPrice: price, marketValue: 0, unrealizedPl: 0, assetClass: this.assetClass };
    this.positions.set(symbol, this.withPrice(pos, price));
  }

  private makeUpdate(event: TradeUpdateEvent, o: AlpacaOrder, price: number | null, qty: number | null): TradeUpdate {
    const p = this.positions.get(o.symbol);
    const positionQty = p ? (p.side === 'long' ? p.qty : -p.qty) : 0;
    return { event, order: this.view(o), price, qty, positionQty, timestamp: this.now(), executionId: price === null ? null : `x-${++this.seq}` };
  }

  private emit(u: TradeUpdate): void {
    for (const cb of this.listeners) cb(u);
  }
}

export function orderStatusOf(fake: FakeAlpaca, idOrClientId: string): OrderStatus | null {
  return fake.find(idOrClientId)?.status ?? null;
}
