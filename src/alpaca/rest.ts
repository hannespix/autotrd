/**
 * Alpaca REST: Trading-API (paper/live) und Market-Data-API.
 *
 * Grundsätze:
 *  - Jeder Call hat einen Timeout. GET/DELETE sind idempotent und werden
 *    bei 429/5xx/Netzfehlern mit Backoff wiederholt.
 *  - POST /v2/orders wird NIE blind wiederholt: Ein Timeout heißt nicht
 *    „nicht angekommen". Erst per client_order_id nachschlagen, dann
 *    höchstens EIN zweiter Versuch — sonst kauft man doppelt.
 *  - Jede Fehlermeldung läuft durch redact(): Alpaca spiegelt gelegentlich
 *    den gesendeten Header zurück.
 *  - Preise gehen als Strings mit Alpaca-konformer Rundung raus; ein
 *    Sub-Penny-Preis wäre ein 422 mitten im Handel.
 */
import type { AssetClass, Bar, Ms } from '../core/types.ts';
import type { CalendarDay } from '../core/time.ts';
import { errMsg, logger, redact, registerSecret } from '../core/log.ts';
import {
  AlpacaError,
  type AlpacaAccount,
  type AlpacaAsset,
  type AlpacaClient,
  type AlpacaClock,
  type AlpacaMode,
  type AlpacaOrder,
  type AlpacaPosition,
  type BarsRequest,
  type LatestQuote,
  type NewOrder,
  type ReplaceOrder,
} from './types.ts';
import {
  asObject,
  isObject,
  mapAccount,
  mapAsset,
  mapBar,
  mapCalendarDay,
  mapClock,
  mapOrder,
  mapPosition,
  mapQuote,
  toStr,
} from './raw.ts';
import { encodePathSymbol, toPositionSymbol } from './symbols.ts';

export interface AlpacaClientOptions {
  mode: AlpacaMode;
  keyId: string;
  secret: string;
  feed: 'iex' | 'sip';
  assetClass: AssetClass;
  /** Injizierbar für Tests. */
  fetchFn?: typeof fetch;
  /** Default 15000. */
  timeoutMs?: number;
  /** Injizierbar (Retry-Backoff). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const TRADING_BASE_URL: Record<AlpacaMode, string> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
};
export const DATA_BASE_URL = 'https://data.alpaca.markets';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const JITTER_MS = 250;
const ORDERS_PAGE_MAX = 500;
const BARS_PAGE_MAX = 10_000;
const SYMBOLS_PER_REQUEST = 50;
const BODY_SNIPPET_MAX = 300;
const CLIENT_ID_TAKEN = /client_order_id must be unique/i;

/* ───────────────────────── Preise & Mengen ───────────────────────── */

/** Erlaubte Nachkommastellen: Aktien ≥ 1 $ zwei, darunter vier (Sub-Penny-Regel); Krypto ≥ 1 zwei, sonst sechs. */
export function priceDecimals(price: number, assetClass: AssetClass = 'us_equity'): number {
  if (assetClass === 'crypto') return price >= 1 ? 2 : 6;
  return price >= 1 ? 2 : 4;
}

function assertPrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Ungültiger Preis: ${price}`);
}

function roundDirected(price: number, decimals: number, dir: 'down' | 'up'): number {
  const factor = 10 ** decimals;
  const scaled = price * factor;
  const nearest = Math.round(scaled);
  // Gleitkomma-Rauschen (4.35 × 100 = 434.99999…) darf keinen Cent kosten:
  // Was schon auf dem Raster liegt, bleibt liegen.
  const onGrid = Math.abs(scaled - nearest) < 1e-6;
  const units = onGrid ? nearest : dir === 'down' ? Math.floor(scaled) : Math.ceil(scaled);
  return Number((units / factor).toFixed(decimals));
}

/** Liegt der Preis bereits auf dem erlaubten Raster? Dann ist die Rundungsrichtung egal. */
export function isOnPriceGrid(price: number, assetClass: AssetClass = 'us_equity'): boolean {
  assertPrice(price);
  const factor = 10 ** priceDecimals(price, assetClass);
  const scaled = price * factor;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * Stops werden VOM Kurs WEG gerundet: Ein Sell-Stop (Schutz einer
 * Long-Position) liegt unter dem Kurs → abrunden; ein Buy-Stop liegt darüber
 * → aufrunden. So löst die Rundung den Stop nie einen Tick zu früh aus.
 */
export function roundStopPrice(price: number, side: 'buy' | 'sell', assetClass: AssetClass = 'us_equity'): number {
  assertPrice(price);
  return roundDirected(price, priceDecimals(price, assetClass), side === 'sell' ? 'down' : 'up');
}

/**
 * Limits werden ZUM Kurs HIN gerundet: Ein Sell-Limit (Kursziel Long) liegt
 * über dem Kurs → abrunden; ein Buy-Limit darunter → aufrunden. Die Rundung
 * macht die Ausführung damit nie unwahrscheinlicher als geplant.
 */
export function roundLimitPrice(price: number, side: 'buy' | 'sell', assetClass: AssetClass = 'us_equity'): number {
  assertPrice(price);
  return roundDirected(price, priceDecimals(price, assetClass), side === 'sell' ? 'down' : 'up');
}

/** Gerundeter Preis als String mit genau den erlaubten Stellen ("150.25", "0.1234"). */
export function formatPrice(rounded: number, assetClass: AssetClass = 'us_equity'): string {
  return rounded.toFixed(priceDecimals(rounded, assetClass));
}

/** Menge als String; ganze Zahlen ohne Nachkommastellen, Bruchteile mit bis zu 9 Stellen (Alpaca-Maximum). */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Ungültige Menge: ${qty}`);
  if (Number.isInteger(qty)) return String(qty);
  return qty.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

/** Order → Alpaca-Body (snake_case). Bracket-Beine haben die Gegenseite des Einstiegs — das bestimmt ihre Rundung. */
export function buildOrderBody(order: NewOrder, assetClass: AssetClass): Record<string, unknown> {
  if (!order.symbol) throw new Error('Order ohne Symbol');
  if (!order.clientOrderId) throw new Error(`Order ${order.symbol} ohne client_order_id`);
  const legSide = order.side === 'buy' ? 'sell' : 'buy';
  const body: Record<string, unknown> = {
    symbol: order.symbol,
    qty: formatQty(order.qty),
    side: order.side,
    type: order.type,
    time_in_force: order.timeInForce,
    client_order_id: order.clientOrderId,
  };
  if (order.limitPrice !== undefined) {
    body.limit_price = formatPrice(roundLimitPrice(order.limitPrice, order.side, assetClass), assetClass);
  }
  if (order.stopPrice !== undefined) {
    body.stop_price = formatPrice(roundStopPrice(order.stopPrice, order.side, assetClass), assetClass);
  }
  if (order.orderClass !== undefined) body.order_class = order.orderClass;
  if (order.takeProfit) {
    body.take_profit = {
      limit_price: formatPrice(roundLimitPrice(order.takeProfit.limitPrice, legSide, assetClass), assetClass),
    };
  }
  if (order.stopLoss) {
    const stopLoss: Record<string, string> = {
      stop_price: formatPrice(roundStopPrice(order.stopLoss.stopPrice, legSide, assetClass), assetClass),
    };
    if (order.stopLoss.limitPrice !== undefined) {
      stopLoss.limit_price = formatPrice(roundLimitPrice(order.stopLoss.limitPrice, legSide, assetClass), assetClass);
    }
    body.stop_loss = stopLoss;
  }
  if (order.extendedHours !== undefined) body.extended_hours = order.extendedHours;
  return body;
}

/* ───────────────────────── HTTP-Schicht ───────────────────────── */

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type QueryParams = Record<string, string | number | boolean | undefined>;

interface HttpRequest {
  method: HttpMethod;
  url: string;
  body?: unknown;
  /** Statuscodes, die kein Fehler sind (z. B. 404 ⇒ null beim Aufrufer). */
  accept?: readonly number[];
  /** Nur idempotente Calls dürfen wiederholt werden. */
  retry: boolean;
}

interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

function buildUrl(base: string, path: string, params?: QueryParams): string {
  const url = new URL(path, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniq(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function iso(ms: Ms): string {
  return new Date(ms).toISOString();
}

function httpError(req: HttpRequest, res: HttpResult): AlpacaError {
  const snippet = redact(res.text).replace(/\s+/g, ' ').trim().slice(0, BODY_SNIPPET_MAX);
  const code = isObject(res.json) && typeof res.json.code === 'number' ? res.json.code : null;
  const retryable = res.status === 429 || res.status >= 500;
  const message = redact(`Alpaca ${req.method} ${pathOf(req.url)} → HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  return new AlpacaError(message, res.status, code, retryable);
}

function transportError(req: HttpRequest, e: unknown, timeoutMs: number): AlpacaError {
  const name = e instanceof Error ? e.name : '';
  let detail = errMsg(e);
  if (e instanceof Error && e.cause instanceof Error) detail += ` (${errMsg(e.cause)})`;
  const isTimeout = name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(detail);
  const kind = isTimeout ? `Timeout (${timeoutMs} ms)` : 'Netzfehler';
  return new AlpacaError(redact(`Alpaca ${req.method} ${pathOf(req.url)} → ${kind}: ${detail}`), 0, null, true);
}

/** Multi-Status-Antworten (207) von DELETE /v2/orders und /v2/positions: Teilfehler laut machen, nicht werfen. */
function warnMultiStatus(what: string, json: unknown): void {
  if (!Array.isArray(json)) return;
  for (const item of json) {
    if (!isObject(item)) continue;
    const status = typeof item.status === 'number' ? item.status : null;
    if (status !== null && !isOk(status)) {
      logger.warn(`Alpaca ${what}: Teilfehler`, { id: item.id ?? item.symbol ?? null, status, body: item.body ?? null });
    }
  }
}

/* ───────────────────────── Client ───────────────────────── */

export function createAlpacaClient(opts: AlpacaClientOptions): AlpacaClient {
  // Beide Keys schwärzen, bevor irgendetwas geloggt oder geworfen werden kann.
  registerSecret(opts.keyId);
  registerSecret(opts.secret);

  const mode = opts.mode;
  const assetClass = opts.assetClass;
  const feed = opts.feed;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const tradingBase = TRADING_BASE_URL[mode];
  const isCrypto = assetClass === 'crypto';

  const trading = (path: string, params?: QueryParams): string => buildUrl(tradingBase, path, params);
  const data = (path: string, params?: QueryParams): string => buildUrl(DATA_BASE_URL, path, params);

  async function attemptOnce(req: HttpRequest): Promise<HttpResult> {
    const headers: Record<string, string> = {
      'APCA-API-KEY-ID': opts.keyId,
      'APCA-API-SECRET-KEY': opts.secret,
      Accept: 'application/json',
    };
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout nach ${timeoutMs} ms`)), timeoutMs);
    init.signal = controller.signal;
    const started = now();
    try {
      const res = await fetchFn(req.url, init);
      // 204 hat keinen Body; sonst Text lesen und JSON nur versuchen (Proxy-Fehlerseiten sind HTML).
      const text = res.status === 204 ? '' : await res.text();
      let json: unknown;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      logger.debug('Alpaca-Call', { method: req.method, path: pathOf(req.url), status: res.status, ms: now() - started });
      return { status: res.status, text, json };
    } catch (e) {
      throw transportError(req, e, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  async function backoff(attempt: number, why: string): Promise<void> {
    const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * JITTER_MS);
    logger.warn('Alpaca: Wiederholung nach Fehler', { attempt: attempt + 1, delayMs: delay, why });
    await sleep(delay);
  }

  /** Ein Call mit Retry-Politik. Wirft AlpacaError; akzeptierte Statuscodes kommen als Ergebnis zurück. */
  async function send(req: HttpRequest): Promise<HttpResult> {
    for (let attempt = 0; ; attempt++) {
      const mayRetry = req.retry && attempt + 1 < MAX_ATTEMPTS;
      let res: HttpResult;
      try {
        res = await attemptOnce(req);
      } catch (e) {
        if (!mayRetry) throw e;
        await backoff(attempt, errMsg(e));
        continue;
      }
      if (isOk(res.status) || req.accept?.includes(res.status)) return res;
      const err = httpError(req, res);
      if (!(mayRetry && err.retryable)) throw err;
      await backoff(attempt, err.message);
    }
  }

  async function getJson(url: string, accept?: readonly number[]): Promise<HttpResult> {
    return send(accept ? { method: 'GET', url, accept, retry: true } : { method: 'GET', url, retry: true });
  }

  /* ── Konto & Stammdaten ── */

  async function getAccount(): Promise<AlpacaAccount> {
    return mapAccount((await getJson(trading('/v2/account'))).json);
  }

  async function getClock(): Promise<AlpacaClock> {
    return mapClock((await getJson(trading('/v2/clock'))).json);
  }

  async function getCalendar(start: string, end: string): Promise<CalendarDay[]> {
    const res = await getJson(trading('/v2/calendar', { start, end }));
    if (!Array.isArray(res.json)) throw new Error('Alpaca-Kalender: erwartet Array');
    return res.json.map((d) => mapCalendarDay(d));
  }

  async function getAsset(symbol: string): Promise<AlpacaAsset | null> {
    const res = await getJson(trading(`/v2/assets/${encodePathSymbol(symbol)}`), [404]);
    return res.status === 404 ? null : mapAsset(res.json);
  }

  async function listPositions(): Promise<AlpacaPosition[]> {
    const res = await getJson(trading('/v2/positions'));
    if (!Array.isArray(res.json)) throw new Error('Alpaca-Positionen: erwartet Array');
    return res.json.map((p) => mapPosition(p, assetClass));
  }

  /* ── Orders ── */

  async function listOrders(o: {
    status: 'open' | 'closed' | 'all';
    symbols?: string[];
    after?: Ms;
    limit?: number;
    nested?: boolean;
  }): Promise<AlpacaOrder[]> {
    // Ohne limit: alles. Alpaca deckelt je Seite bei 500, also über `after` weiterblättern.
    const want = o.limit ?? Number.POSITIVE_INFINITY;
    const pageSize = Math.min(want, ORDERS_PAGE_MAX);
    let after = o.after !== undefined ? iso(o.after) : undefined;
    const seen = new Set<string>();
    const out: AlpacaOrder[] = [];
    while (out.length < want) {
      const res = await getJson(
        trading('/v2/orders', {
          status: o.status,
          limit: pageSize,
          after,
          direction: 'asc',
          nested: o.nested === undefined ? undefined : o.nested ? 'true' : 'false',
          symbols: o.symbols && o.symbols.length > 0 ? o.symbols.join(',') : undefined,
        }),
      );
      if (!Array.isArray(res.json)) throw new Error('Alpaca-Orders: erwartet Array');
      let added = 0;
      for (const raw of res.json) {
        const order = mapOrder(raw);
        if (seen.has(order.id)) continue; // `after` kann inklusiv sein — Grenz-Order nicht doppelt
        seen.add(order.id);
        out.push(order);
        added++;
        if (out.length >= want) break;
      }
      if (res.json.length < pageSize || added === 0) break;
      const last = out[out.length - 1];
      if (!last || last.submittedAt === null) break;
      after = iso(last.submittedAt);
    }
    return out;
  }

  async function getOrder(id: string): Promise<AlpacaOrder | null> {
    const res = await getJson(trading(`/v2/orders/${encodeURIComponent(id)}`, { nested: 'true' }), [404]);
    return res.status === 404 ? null : mapOrder(res.json);
  }

  async function getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    const res = await getJson(trading('/v2/orders:by_client_order_id', { client_order_id: clientOrderId }), [404]);
    return res.status === 404 ? null : mapOrder(res.json);
  }

  async function submitOrder(order: NewOrder): Promise<AlpacaOrder> {
    const req: HttpRequest = { method: 'POST', url: trading('/v2/orders'), body: buildOrderBody(order, assetClass), retry: false };
    const lookup = (): Promise<AlpacaOrder | null> => getOrderByClientId(order.clientOrderId);
    // Höchstens zwei POSTs — und dazwischen IMMER der Blick ins Orderbuch.
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: HttpResult;
      try {
        res = await attemptOnce(req);
      } catch (e) {
        logger.warn('Alpaca: Order-POST ohne Antwort — Nachschlag per client_order_id', {
          symbol: order.symbol,
          clientOrderId: order.clientOrderId,
          why: errMsg(e),
        });
        const existing = await lookup();
        if (existing) return existing;
        if (attempt === 0) {
          await backoff(0, errMsg(e));
          continue;
        }
        throw e;
      }
      if (isOk(res.status)) return mapOrder(res.json);
      const err = httpError(req, res);
      if (res.status === 422 && CLIENT_ID_TAKEN.test(res.text)) {
        // Idempotenz: Diese client_order_id gibt es schon — das IST unsere Order (z. B. aus einem früheren Timeout).
        const existing = await lookup();
        if (existing) return existing;
        throw err;
      }
      if (err.retryable) {
        // 429/5xx: Alpaca könnte die Order trotzdem angenommen haben — gleiche Vorsicht wie beim Netzfehler.
        const existing = await lookup();
        if (existing) return existing;
        if (attempt === 0) {
          await backoff(0, err.message);
          continue;
        }
      }
      throw err;
    }
    throw new AlpacaError('Alpaca POST /v2/orders: kein Ergebnis nach zwei Versuchen', 0, null, false);
  }

  async function replaceOrder(id: string, patch: ReplaceOrder): Promise<AlpacaOrder> {
    const body: Record<string, unknown> = {};
    if (patch.qty !== undefined) body.qty = formatQty(patch.qty);
    if (patch.clientOrderId !== undefined) body.client_order_id = patch.clientOrderId;
    const prices = [patch.limitPrice, patch.stopPrice].filter((p): p is number => p !== undefined);
    if (prices.length > 0) {
      // Die Rundungsrichtung hängt an der Seite der Order. Der Nachschlag entfällt,
      // wenn die Preise ohnehin schon auf dem Raster liegen (der Normalfall).
      let side: 'buy' | 'sell' = 'sell';
      if (!prices.every((p) => isOnPriceGrid(p, assetClass))) {
        const current = await getOrder(id);
        if (!current) throw new AlpacaError(`Alpaca PATCH /v2/orders/${id}: Order nicht gefunden`, 404, null, false);
        side = current.side;
      }
      if (patch.limitPrice !== undefined) {
        body.limit_price = formatPrice(roundLimitPrice(patch.limitPrice, side, assetClass), assetClass);
      }
      if (patch.stopPrice !== undefined) {
        body.stop_price = formatPrice(roundStopPrice(patch.stopPrice, side, assetClass), assetClass);
      }
    }
    // PATCH erzeugt eine neue Order-ID; eine Wiederholung träfe die alte ID — also kein Retry.
    const res = await send({ method: 'PATCH', url: trading(`/v2/orders/${encodeURIComponent(id)}`), body, retry: false });
    return mapOrder(res.json);
  }

  async function cancelOrder(id: string): Promise<void> {
    // 204 = storniert, 404 = gibt es nicht (mehr) — beides ist „erledigt". 422 (schon gefüllt) wirft.
    await send({ method: 'DELETE', url: trading(`/v2/orders/${encodeURIComponent(id)}`), accept: [404], retry: true });
  }

  async function cancelAllOrders(): Promise<void> {
    const res = await send({ method: 'DELETE', url: trading('/v2/orders'), retry: true });
    warnMultiStatus('DELETE /v2/orders', res.json);
  }

  /* ── Positionen ── */

  async function closePosition(symbol: string, qty?: number): Promise<AlpacaOrder | null> {
    const params: QueryParams = qty !== undefined ? { qty: formatQty(qty) } : {};
    // Vollständiges Schließen ist idempotent (danach 404). Ein Teilschluss nicht:
    // Ein Timeout nach erfolgreicher Ausführung würde beim Retry ein zweites Mal schließen.
    const retry = qty === undefined;
    let res = await send({ method: 'DELETE', url: trading(`/v2/positions/${encodePathSymbol(symbol)}`, params), accept: [404], retry });
    if (res.status === 404 && isCrypto && symbol.includes('/')) {
      // Der Bestand kennt Krypto als "BTCUSD" — zweite Schreibweise probieren, bevor wir „keine Position" melden.
      res = await send({
        method: 'DELETE',
        url: trading(`/v2/positions/${encodePathSymbol(toPositionSymbol(symbol))}`, params),
        accept: [404],
        retry,
      });
    }
    return res.status === 404 ? null : mapOrder(res.json);
  }

  async function closeAllPositions(cancelOrders: boolean): Promise<void> {
    const res = await send({
      method: 'DELETE',
      url: trading('/v2/positions', { cancel_orders: cancelOrders ? 'true' : 'false' }),
      retry: true,
    });
    warnMultiStatus('DELETE /v2/positions', res.json);
  }

  /* ── Marktdaten ── */

  async function getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
    const out = new Map<string, Bar[]>();
    const symbols = uniq(req.symbols);
    for (const s of symbols) out.set(s, []);
    const pageLimit = Math.min(Math.max(1, Math.floor(req.pageLimit ?? BARS_PAGE_MAX)), BARS_PAGE_MAX);
    const path = isCrypto ? '/v1beta3/crypto/us/bars' : '/v2/stocks/bars';
    for (const group of chunk(symbols, SYMBOLS_PER_REQUEST)) {
      let pageToken: string | undefined;
      do {
        const params: QueryParams = {
          symbols: group.join(','),
          timeframe: req.timeframe,
          start: iso(req.start),
          end: req.end !== undefined ? iso(req.end) : undefined,
          limit: pageLimit,
          sort: 'asc',
          page_token: pageToken,
        };
        if (!isCrypto) {
          params.adjustment = req.adjustment ?? 'raw';
          params.feed = req.feed ?? feed;
        }
        const res = await getJson(data(path, params));
        const body = asObject(res.json, 'Alpaca-Bars');
        if (isObject(body.bars)) {
          for (const [symbol, list] of Object.entries(body.bars)) {
            if (!Array.isArray(list)) continue;
            let target = out.get(symbol);
            if (!target) {
              target = [];
              out.set(symbol, target);
            }
            for (const raw of list) target.push(mapBar(raw));
          }
        }
        pageToken = toStr(body.next_page_token) ?? undefined;
      } while (pageToken);
    }
    for (const [symbol, list] of out) {
      list.sort((a, b) => a.t - b.t);
      // Doppelte Zeitstempel (Seitenüberlappung) — die spätere Fassung gewinnt.
      const dedup: Bar[] = [];
      for (const bar of list) {
        const prev = dedup[dedup.length - 1];
        if (prev && prev.t === bar.t) dedup[dedup.length - 1] = bar;
        else dedup.push(bar);
      }
      out.set(symbol, dedup);
    }
    return out;
  }

  async function getLatestBars(symbols: string[]): Promise<Map<string, Bar>> {
    const out = new Map<string, Bar>();
    const path = isCrypto ? '/v1beta3/crypto/us/latest/bars' : '/v2/stocks/bars/latest';
    for (const group of chunk(uniq(symbols), SYMBOLS_PER_REQUEST)) {
      const params: QueryParams = { symbols: group.join(',') };
      if (!isCrypto) params.feed = feed;
      const body = asObject((await getJson(data(path, params))).json, 'Alpaca-LatestBars');
      if (!isObject(body.bars)) continue;
      for (const [symbol, raw] of Object.entries(body.bars)) {
        if (isObject(raw)) out.set(symbol, mapBar(raw));
      }
    }
    return out;
  }

  async function getLatestQuotes(symbols: string[]): Promise<Map<string, LatestQuote>> {
    const out = new Map<string, LatestQuote>();
    const path = isCrypto ? '/v1beta3/crypto/us/latest/quotes' : '/v2/stocks/quotes/latest';
    for (const group of chunk(uniq(symbols), SYMBOLS_PER_REQUEST)) {
      const params: QueryParams = { symbols: group.join(',') };
      if (!isCrypto) params.feed = feed;
      const body = asObject((await getJson(data(path, params))).json, 'Alpaca-LatestQuotes');
      if (!isObject(body.quotes)) continue;
      for (const [symbol, raw] of Object.entries(body.quotes)) {
        if (isObject(raw)) out.set(symbol, mapQuote(symbol, raw));
      }
    }
    return out;
  }

  return {
    mode,
    getAccount,
    getClock,
    getCalendar,
    getAsset,
    listPositions,
    listOrders,
    getOrder,
    getOrderByClientId,
    submitOrder,
    replaceOrder,
    cancelOrder,
    cancelAllOrders,
    closePosition,
    closeAllPositions,
    getBars,
    getLatestBars,
    getLatestQuotes,
  };
}
