import { beforeAll, describe, expect, it } from 'vitest';
import { setLogSink } from '../../src/core/log.ts';
import { AlpacaError, type NewOrder } from '../../src/alpaca/types.ts';
import {
  buildOrderBody,
  createAlpacaClient,
  formatQty,
  isOnPriceGrid,
  roundLimitPrice,
  roundStopPrice,
  type AlpacaClientOptions,
} from '../../src/alpaca/rest.ts';

beforeAll(() => {
  // Retry-/Nachschlag-Warnungen gehören nicht in die Testausgabe.
  setLogSink(() => {});
});

/* ───────────────────────── Mock-fetch ───────────────────────── */

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type Responder = (call: Call, index: number) => Response | Promise<Response>;

function makeFetch(responder: Responder): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      url: new URL(urlStr),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number): Response => new Response(null, { status });

const KEY = 'PKTESTKEY0000000001';
const SECRET = 'test-secret-value-0123456789';

function makeClient(responder: Responder, over: Partial<AlpacaClientOptions> = {}) {
  const { fetchFn, calls } = makeFetch(responder);
  const sleeps: number[] = [];
  const client = createAlpacaClient({
    mode: 'paper',
    keyId: KEY,
    secret: SECRET,
    feed: 'iex',
    assetClass: 'us_equity',
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  });
  return { client, calls, sleeps };
}

function orderRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord-1',
    client_order_id: 'cid-1',
    submitted_at: '2024-05-06T13:31:00.000Z',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    qty: '10',
    filled_qty: '0',
    order_class: '',
    type: 'market',
    side: 'buy',
    time_in_force: 'day',
    status: 'accepted',
    legs: null,
    ...over,
  };
}

const BRACKET: NewOrder = {
  symbol: 'AAPL',
  side: 'buy',
  qty: 10,
  type: 'limit',
  timeInForce: 'day',
  clientOrderId: 'cid-bracket',
  limitPrice: 150.005,
  orderClass: 'bracket',
  takeProfit: { limitPrice: 160.004 },
  stopLoss: { stopPrice: 145.006, limitPrice: 144.999 },
  extendedHours: false,
};

const ACCOUNT_RAW = { id: 'acc', status: 'ACTIVE', equity: '1000.5', cash: '500', daytrade_count: 1 };

/* ───────────────────────── Basis: URLs & Header ───────────────────────── */

describe('Basis-URL und Header', () => {
  it('paper → paper-api, live → api; Key-Header und Accept immer, Content-Type nur mit Body', async () => {
    const paper = makeClient(() => json(ACCOUNT_RAW));
    await paper.client.getAccount();
    const call = paper.calls[0]!;
    expect(call.url.origin).toBe('https://paper-api.alpaca.markets');
    expect(call.url.pathname).toBe('/v2/account');
    expect(call.method).toBe('GET');
    expect(call.headers['APCA-API-KEY-ID']).toBe(KEY);
    expect(call.headers['APCA-API-SECRET-KEY']).toBe(SECRET);
    expect(call.headers['Accept']).toBe('application/json');
    expect(call.headers['Content-Type']).toBeUndefined();

    const live = makeClient(() => json(orderRaw()), { mode: 'live' });
    // exactOptionalPropertyTypes: Felder weglassen statt auf undefined setzen
    const { orderClass: _oc, takeProfit: _tp, stopLoss: _sl, ...simple } = BRACKET;
    await live.client.submitOrder(simple);
    expect(live.client.mode).toBe('live');
    expect(live.calls[0]!.url.origin).toBe('https://api.alpaca.markets');
    expect(live.calls[0]!.method).toBe('POST');
    expect(live.calls[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('Marktdaten gehen an data.alpaca.markets', async () => {
    const { client, calls } = makeClient(() => json({ bars: {} }));
    await client.getBars({ symbols: ['AAPL'], timeframe: '1Min', start: Date.UTC(2024, 4, 6) });
    expect(calls[0]!.url.origin).toBe('https://data.alpaca.markets');
  });
});

/* ───────────────────────── Order-Body ───────────────────────── */

describe('Order-Body', () => {
  it('Bracket: snake_case, qty als String, Preise gerundet nach Seite', () => {
    const body = buildOrderBody(BRACKET, 'us_equity');
    expect(body).toEqual({
      symbol: 'AAPL',
      qty: '10',
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      client_order_id: 'cid-bracket',
      // Buy-Limit zum Kurs hin = aufrunden
      limit_price: '150.01',
      order_class: 'bracket',
      // Take-Profit ist das Sell-Bein: abrunden
      take_profit: { limit_price: '160.00' },
      // Stop-Loss ist ein Sell-Stop: vom Kurs weg = abrunden; sein Limit ebenfalls Sell-Limit
      stop_loss: { stop_price: '145.00', limit_price: '144.99' },
      extended_hours: false,
    });
  });

  it('Short-Bracket: Beine sind Buy-Seite und runden auf', () => {
    const body = buildOrderBody(
      {
        symbol: 'TSLA',
        side: 'sell',
        qty: 3,
        type: 'market',
        timeInForce: 'day',
        clientOrderId: 'cid-short',
        orderClass: 'bracket',
        takeProfit: { limitPrice: 180.001 },
        stopLoss: { stopPrice: 205.001 },
      },
      'us_equity',
    );
    expect(body.take_profit).toEqual({ limit_price: '180.01' });
    expect(body.stop_loss).toEqual({ stop_price: '205.01' });
    expect(body.limit_price).toBeUndefined();
    expect(body.extended_hours).toBeUndefined();
  });

  it('Bruchteile und Stop-Entry: qty ohne Rauschen, Buy-Stop rundet auf', () => {
    const body = buildOrderBody(
      { symbol: 'BTC/USD', side: 'buy', qty: 0.1 + 0.2, type: 'stop', timeInForce: 'gtc', clientOrderId: 'c', stopPrice: 61000.001 },
      'crypto',
    );
    expect(body.qty).toBe('0.3');
    expect(body.stop_price).toBe('61000.01');
    expect(formatQty(10)).toBe('10');
    expect(formatQty(0.000000001)).toBe('0.000000001');
    expect(() => formatQty(0)).toThrow(/Menge/);
    expect(() => formatQty(Number.NaN)).toThrow(/Menge/);
  });

  it('submitOrder schickt genau diesen Body per POST /v2/orders', async () => {
    const { client, calls } = makeClient(() => json(orderRaw({ client_order_id: 'cid-bracket', order_class: 'bracket' })));
    const order = await client.submitOrder(BRACKET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/v2/orders');
    expect(calls[0]!.body).toEqual(buildOrderBody(BRACKET, 'us_equity'));
    expect(order.orderClass).toBe('bracket');
    expect(order.clientOrderId).toBe('cid-bracket');
  });
});

/* ───────────────────────── Rundung ───────────────────────── */

describe('Preisrundung', () => {
  it('Stops vom Kurs weg: Sell abrunden, Buy aufrunden (2 Dezimalen ab 1 $)', () => {
    expect(roundStopPrice(145.006, 'sell')).toBe(145.0);
    expect(roundStopPrice(145.006, 'buy')).toBe(145.01);
    expect(roundStopPrice(145.001, 'buy')).toBe(145.01);
  });
  it('Limits zum Kurs hin: Sell abrunden, Buy aufrunden', () => {
    expect(roundLimitPrice(160.004, 'sell')).toBe(160.0);
    expect(roundLimitPrice(160.004, 'buy')).toBe(160.01);
    expect(roundLimitPrice(159.999, 'sell')).toBe(159.99);
  });
  it('unter 1 $: vier Dezimalen; Krypto: sechs unter 1, zwei darüber', () => {
    expect(roundStopPrice(0.12345, 'sell')).toBe(0.1234);
    expect(roundStopPrice(0.12345, 'buy')).toBe(0.1235);
    expect(roundLimitPrice(0.98765, 'buy')).toBe(0.9877);
    expect(roundLimitPrice(0.1234567, 'sell', 'crypto')).toBe(0.123456);
    expect(roundLimitPrice(0.1234561, 'buy', 'crypto')).toBe(0.123457);
    expect(roundStopPrice(61000.123, 'sell', 'crypto')).toBe(61000.12);
  });
  it('Gleitkomma-Rauschen kostet keinen Cent: Werte auf dem Raster bleiben', () => {
    expect(roundStopPrice(4.35, 'sell')).toBe(4.35);
    expect(roundLimitPrice(1.005, 'sell')).toBe(1.0);
    expect(roundStopPrice(0.29, 'sell')).toBe(0.29);
    expect(roundLimitPrice(150.25, 'buy')).toBe(150.25);
    expect(isOnPriceGrid(4.35)).toBe(true);
    expect(isOnPriceGrid(4.351)).toBe(false);
  });
  it('ungültige Preise werden abgewiesen', () => {
    expect(() => roundStopPrice(0, 'sell')).toThrow(/Preis/);
    expect(() => roundLimitPrice(Number.NaN, 'buy')).toThrow(/Preis/);
  });
});

/* ───────────────────────── Retry ───────────────────────── */

describe('Retry-Politik', () => {
  it('GET: 500 → 200 mit einem Backoff-Schlaf', async () => {
    const { client, calls, sleeps } = makeClient((_c, i) => (i === 0 ? json({ message: 'boom' }, 500) : json(ACCOUNT_RAW)));
    const acc = await client.getAccount();
    expect(acc.equity).toBe(1000.5);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThan(750);
  });

  it('GET: 429 zählt als wiederholbar; Backoff verdoppelt sich', async () => {
    const { client, calls, sleeps } = makeClient((_c, i) => (i < 2 ? json({ message: 'slow down' }, 429) : json(ACCOUNT_RAW)));
    await client.getAccount();
    expect(calls).toHaveLength(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeLessThan(1250);
  });

  it('GET: nach drei Versuchen ist Schluss — AlpacaError mit status und retryable', async () => {
    const { client, calls } = makeClient(() => json({ code: 50010001, message: 'internal' }, 503));
    const err = await client.getAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlpacaError);
    const ae = err as AlpacaError;
    expect(ae.status).toBe(503);
    expect(ae.code).toBe(50010001);
    expect(ae.retryable).toBe(true);
    expect(ae.message).toContain('HTTP 503');
    expect(ae.message).toContain('internal');
    expect(calls).toHaveLength(3);
  });

  it.each([400, 403, 422])('KEIN Retry bei %d', async (status) => {
    const { client, calls, sleeps } = makeClient(() => json({ code: 40010001, message: 'nope' }, status));
    const err = await client.getAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlpacaError);
    expect((err as AlpacaError).status).toBe(status);
    expect((err as AlpacaError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('Netzfehler: Retry, danach Erfolg', async () => {
    const { client, calls } = makeClient((_c, i) => {
      if (i === 0) throw new TypeError('fetch failed');
      return json(ACCOUNT_RAW);
    });
    await client.getAccount();
    expect(calls).toHaveLength(2);
  });

  it('Netzfehler dauerhaft: AlpacaError status 0, retryable, Nachricht nennt den Netzfehler', async () => {
    const { client } = makeClient(() => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    });
    const err = (await client.getClock().catch((e: unknown) => e)) as AlpacaError;
    expect(err).toBeInstanceOf(AlpacaError);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Netzfehler/);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('Timeout bricht den Call ab und wird wiederholt', async () => {
    const { client, calls } = makeClient(
      (_c, i) => {
        if (i === 0) {
          // hängt, bis das Signal abbricht
          return new Promise<Response>((_resolve, reject) => {
            // das Signal steckt im init — wir bekommen es hier nicht; der Client bricht per AbortController ab
            setTimeout(() => reject(new DOMException('aborted', 'TimeoutError')), 5);
          });
        }
        return json(ACCOUNT_RAW);
      },
      { timeoutMs: 30 },
    );
    await client.getAccount();
    expect(calls).toHaveLength(2);
  });

  it('echter Timeout über AbortSignal: Nachricht nennt Timeout', async () => {
    const { fetchFn } = makeFetch(() => empty(200));
    const hanging = ((input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        void fetchFn(input, init);
      })) as typeof fetch;
    const client = createAlpacaClient({
      mode: 'paper',
      keyId: KEY,
      secret: SECRET,
      feed: 'iex',
      assetClass: 'us_equity',
      fetchFn: hanging,
      timeoutMs: 10,
      sleep: async () => {},
    });
    const err = (await client.getClock().catch((e: unknown) => e)) as AlpacaError;
    expect(err).toBeInstanceOf(AlpacaError);
    expect(err.message).toMatch(/Timeout/);
    expect(err.retryable).toBe(true);
  });
});

/* ───────────────────────── Order-Idempotenz ───────────────────────── */

describe('submitOrder: nie blind wiederholen', () => {
  const NEW: NewOrder = { symbol: 'AAPL', side: 'buy', qty: 1, type: 'market', timeInForce: 'day', clientOrderId: 'cid-net' };

  it('Netzfehler ⇒ Nachschlag per client_order_id; existiert ⇒ zurückgeben, kein zweiter POST', async () => {
    const { client, calls } = makeClient((c) => {
      if (c.method === 'POST') throw new TypeError('fetch failed');
      expect(c.url.pathname).toBe('/v2/orders:by_client_order_id');
      expect(c.url.searchParams.get('client_order_id')).toBe('cid-net');
      return json(orderRaw({ client_order_id: 'cid-net' }));
    });
    const order = await client.submitOrder(NEW);
    expect(order.clientOrderId).toBe('cid-net');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('Netzfehler, Nachschlag 404 ⇒ genau EIN zweiter POST', async () => {
    let posts = 0;
    const { client, calls, sleeps } = makeClient((c) => {
      if (c.method === 'POST') {
        posts++;
        if (posts === 1) throw new TypeError('fetch failed');
        return json(orderRaw({ client_order_id: 'cid-net' }));
      }
      return json({ code: 40410000, message: 'order not found' }, 404);
    });
    const order = await client.submitOrder(NEW);
    expect(order.id).toBe('ord-1');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
    expect(sleeps).toHaveLength(1);
  });

  it('zweimal Netzfehler, zweimal 404 ⇒ Fehler, nie ein dritter POST', async () => {
    const { client, calls } = makeClient((c) => {
      if (c.method === 'POST') throw new TypeError('fetch failed');
      return empty(404);
    });
    const err = await client.submitOrder(NEW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlpacaError);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
  });

  it('422 „client_order_id must be unique" ⇒ Nachschlag statt Fehler', async () => {
    const { client, calls } = makeClient((c) =>
      c.method === 'POST'
        ? json({ code: 40010001, message: 'client_order_id must be unique' }, 422)
        : json(orderRaw({ client_order_id: 'cid-net', status: 'filled' })),
    );
    const order = await client.submitOrder(NEW);
    expect(order.status).toBe('filled');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  it('anderer 422 ⇒ sofort Fehler, kein Nachschlag, kein Retry', async () => {
    const { client, calls } = makeClient(() => json({ code: 40310000, message: 'insufficient buying power' }, 422));
    const err = (await client.submitOrder(NEW).catch((e: unknown) => e)) as AlpacaError;
    expect(err).toBeInstanceOf(AlpacaError);
    expect(err.status).toBe(422);
    expect(err.code).toBe(40310000);
    expect(err.message).toContain('insufficient buying power');
    expect(calls).toHaveLength(1);
  });

  it('5xx beim POST ⇒ Nachschlag; existiert ⇒ zurück, sonst ein zweiter Versuch', async () => {
    let posts = 0;
    const { client, calls } = makeClient((c) => {
      if (c.method === 'POST') {
        posts++;
        return posts === 1 ? json({ message: 'internal' }, 500) : json(orderRaw({ client_order_id: 'cid-net' }));
      }
      return empty(404);
    });
    await client.submitOrder(NEW);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
  });
});

/* ───────────────────────── Schwärzung ───────────────────────── */

describe('Schwärzung', () => {
  it('Key und Secret erscheinen nie in error.message, auch wenn Alpaca sie zurückspiegelt', async () => {
    const { client } = makeClient(() =>
      json({ code: 40110000, message: `forbidden: APCA-API-KEY-ID: ${KEY} secret ${SECRET} rejected` }, 403),
    );
    const err = (await client.getAccount().catch((e: unknown) => e)) as AlpacaError;
    expect(err).toBeInstanceOf(AlpacaError);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('geschwärzt');
    expect(err.message).toContain('HTTP 403');
  });

  it('Body-Auszug ist auf 300 Zeichen begrenzt', async () => {
    const { client } = makeClient(() => new Response('x'.repeat(2000), { status: 502 }));
    const err = (await client.getAccount().catch((e: unknown) => e)) as AlpacaError;
    expect(err.message.length).toBeLessThan(400);
  });
});

/* ───────────────────────── Bars ───────────────────────── */

describe('getBars', () => {
  const T0 = Date.UTC(2024, 4, 6, 13, 30);
  const bar = (min: number, sym = 'AAPL') => ({ t: new Date(T0 + min * 60_000).toISOString(), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 + min, n: 1, vw: 1.2, S: sym });

  it('paginiert über page_token, führt je Symbol zusammen und sortiert nach t', async () => {
    const { client, calls } = makeClient((c, i) => {
      expect(c.url.pathname).toBe('/v2/stocks/bars');
      const p = c.url.searchParams;
      expect(p.get('symbols')).toBe('AAPL,MSFT');
      expect(p.get('timeframe')).toBe('1Min');
      expect(p.get('start')).toBe(new Date(T0).toISOString());
      expect(p.get('end')).toBe(new Date(T0 + 3 * 60_000).toISOString());
      expect(p.get('feed')).toBe('iex');
      expect(p.get('adjustment')).toBe('raw');
      expect(p.get('sort')).toBe('asc');
      expect(p.get('limit')).toBe('10000');
      if (i === 0) {
        expect(p.get('page_token')).toBeNull();
        return json({ bars: { AAPL: [bar(0), bar(1)], MSFT: [bar(0, 'MSFT')] }, next_page_token: 'seite-2' });
      }
      expect(p.get('page_token')).toBe('seite-2');
      return json({ bars: { AAPL: [bar(3), bar(2)], MSFT: [bar(1, 'MSFT')] }, next_page_token: null });
    });
    const res = await client.getBars({ symbols: ['AAPL', 'MSFT'], timeframe: '1Min', start: T0, end: T0 + 3 * 60_000 });
    expect(calls).toHaveLength(2);
    expect(res.get('AAPL')!.map((b) => b.t)).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 180_000]);
    expect(res.get('AAPL')![0]).toEqual({ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, n: 1, vw: 1.2 });
    expect(res.get('MSFT')).toHaveLength(2);
  });

  it('Krypto: v1beta3-Pfad ohne feed/adjustment; Schlüssel BTC/USD; leeres Symbol ⇒ []', async () => {
    const { client, calls } = makeClient(() => json({ bars: { 'BTC/USD': [bar(0, 'BTC/USD')] } }), { assetClass: 'crypto' });
    const res = await client.getBars({ symbols: ['BTC/USD', 'ETH/USD'], timeframe: '1Day', start: T0 });
    const p = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe('/v1beta3/crypto/us/bars');
    expect(p.get('symbols')).toBe('BTC/USD,ETH/USD');
    expect(p.get('feed')).toBeNull();
    expect(p.get('adjustment')).toBeNull();
    expect(p.get('end')).toBeNull();
    expect(res.get('BTC/USD')).toHaveLength(1);
    expect(res.get('ETH/USD')).toEqual([]);
  });

  it('mehr als 50 Symbole ⇒ Blöcke; doppelte Zeitstempel werden zusammengeführt', async () => {
    const symbols = Array.from({ length: 60 }, (_v, i) => `S${i}`);
    const { client, calls } = makeClient(() => json({ bars: { S0: [bar(1), bar(1)] } }));
    const res = await client.getBars({ symbols, timeframe: '1Min', start: T0, pageLimit: 50_000 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get('symbols')!.split(',')).toHaveLength(50);
    expect(calls[1]!.url.searchParams.get('symbols')!.split(',')).toHaveLength(10);
    expect(calls[0]!.url.searchParams.get('limit')).toBe('10000');
    expect(res.get('S0')).toHaveLength(1);
  });

  it('latest bars / quotes: Pfade, feed und Mapping', async () => {
    const { client, calls } = makeClient((c) =>
      c.url.pathname.includes('quotes')
        ? json({ quotes: { AAPL: { t: '2024-05-06T13:00:00Z', bp: 150.1, ap: 150.2, bs: 3, as: 5 } } })
        : json({ bars: { AAPL: bar(0) } }),
    );
    const bars = await client.getLatestBars(['AAPL']);
    const quotes = await client.getLatestQuotes(['AAPL']);
    expect(calls[0]!.url.pathname).toBe('/v2/stocks/bars/latest');
    expect(calls[0]!.url.searchParams.get('feed')).toBe('iex');
    expect(calls[1]!.url.pathname).toBe('/v2/stocks/quotes/latest');
    expect(bars.get('AAPL')?.t).toBe(T0);
    expect(quotes.get('AAPL')).toEqual({ symbol: 'AAPL', bid: 150.1, ask: 150.2, bidSize: 3, askSize: 5, t: Date.UTC(2024, 4, 6, 13) });
  });
});

/* ───────────────────────── Positionen & Orders ───────────────────────── */

describe('Positionen', () => {
  it('Mapping: Short mit negativer qty, Krypto BTCUSD → BTC/USD', async () => {
    const { client } = makeClient(() =>
      json([
        { symbol: 'TSLA', asset_class: 'us_equity', qty: '-5', side: 'short', avg_entry_price: '200', current_price: '190', market_value: '-950', unrealized_pl: '50' },
        { symbol: 'BTCUSD', asset_class: 'crypto', qty: '0.25', side: 'long', avg_entry_price: '60000', current_price: '61000', market_value: '15250', unrealized_pl: '250' },
      ]),
    );
    const positions = await client.listPositions();
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ symbol: 'TSLA', side: 'short', qty: 5, avgEntryPrice: 200 });
    expect(positions[1]).toMatchObject({ symbol: 'BTC/USD', side: 'long', qty: 0.25, assetClass: 'crypto' });
  });

  it('closePosition: Order-JSON zurück, qty als Parameter; 404 ⇒ null', async () => {
    const { client, calls } = makeClient((c) => (c.url.pathname.includes('MSFT') ? empty(404) : json(orderRaw({ side: 'sell' }))));
    const order = await client.closePosition('AAPL', 2.5);
    expect(order?.side).toBe('sell');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url.pathname).toBe('/v2/positions/AAPL');
    expect(calls[0]!.url.searchParams.get('qty')).toBe('2.5');
    expect(await client.closePosition('MSFT')).toBeNull();
    expect(calls[1]!.url.searchParams.get('qty')).toBeNull();
  });

  it('closePosition Krypto: kodierter Pfad, bei 404 zweiter Versuch in Bestands-Schreibweise', async () => {
    const { client, calls } = makeClient((c) => (c.url.pathname === '/v2/positions/BTCUSD' ? json(orderRaw({ symbol: 'BTC/USD', asset_class: 'crypto', side: 'sell' })) : empty(404)), {
      assetClass: 'crypto',
    });
    const order = await client.closePosition('BTC/USD');
    expect(calls[0]!.url.pathname).toBe('/v2/positions/BTC%2FUSD');
    expect(calls[1]!.url.pathname).toBe('/v2/positions/BTCUSD');
    expect(order?.symbol).toBe('BTC/USD');
  });

  it('closeAllPositions: cancel_orders-Flag, 207 ohne Wurf', async () => {
    const { client, calls } = makeClient(() => json([{ symbol: 'AAPL', status: 200 }, { symbol: 'MSFT', status: 500, body: { message: 'x' } }], 207));
    await client.closeAllPositions(true);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url.pathname).toBe('/v2/positions');
    expect(calls[0]!.url.searchParams.get('cancel_orders')).toBe('true');
  });

  it('getAsset: Pfad kodiert, 404 ⇒ null', async () => {
    const { client, calls } = makeClient((c) => (c.url.pathname.endsWith('NOPE') ? empty(404) : json({ class: 'crypto', symbol: 'BTC/USD', status: 'active', tradable: true })));
    const asset = await client.getAsset('BTC/USD');
    expect(calls[0]!.url.pathname).toBe('/v2/assets/BTC%2FUSD');
    expect(asset?.tradable).toBe(true);
    expect(await client.getAsset('NOPE')).toBeNull();
  });
});

describe('Orders', () => {
  it('cancelOrder: 204 und 404 sind erfüllt; 422 wirft AlpacaError 422', async () => {
    const { client, calls } = makeClient((c) => {
      if (c.url.pathname.endsWith('/gone')) return empty(404);
      if (c.url.pathname.endsWith('/filled')) return json({ code: 42210000, message: 'order is already filled' }, 422);
      return empty(204);
    });
    await expect(client.cancelOrder('open')).resolves.toBeUndefined();
    await expect(client.cancelOrder('gone')).resolves.toBeUndefined();
    const err = (await client.cancelOrder('filled').catch((e: unknown) => e)) as AlpacaError;
    expect(err).toBeInstanceOf(AlpacaError);
    expect(err.status).toBe(422);
    expect(calls.every((c) => c.method === 'DELETE')).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('cancelAllOrders: DELETE /v2/orders, 207-Body wird nicht als Fehler gewertet', async () => {
    const { client, calls } = makeClient(() => json([{ id: 'a', status: 200 }], 207));
    await client.cancelAllOrders();
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url.pathname).toBe('/v2/orders');
  });

  it('getOrder / getOrderByClientId: 404 ⇒ null', async () => {
    const { client, calls } = makeClient((c) => (c.url.search.includes('missing') || c.url.pathname.endsWith('/missing') ? empty(404) : json(orderRaw())));
    expect(await client.getOrder('missing')).toBeNull();
    expect((await client.getOrder('ord-1'))?.id).toBe('ord-1');
    expect(await client.getOrderByClientId('missing')).toBeNull();
    expect((await client.getOrderByClientId('cid-1'))?.clientOrderId).toBe('cid-1');
    expect(calls[0]!.url.pathname).toBe('/v2/orders/missing');
    expect(calls[2]!.url.pathname).toBe('/v2/orders:by_client_order_id');
  });

  it('listOrders: Parameter, Deckel 500 und Paginierung über after = submitted_at der letzten Order', async () => {
    const t0 = Date.UTC(2024, 4, 6, 13, 30);
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_v, i) => orderRaw({ id: `o-${from + i}`, submitted_at: new Date(t0 + (from + i) * 1000).toISOString() }));
    const { client, calls } = makeClient((c, i) => {
      const p = c.url.searchParams;
      expect(p.get('status')).toBe('all');
      expect(p.get('limit')).toBe('500');
      expect(p.get('direction')).toBe('asc');
      expect(p.get('nested')).toBe('true');
      expect(p.get('symbols')).toBe('AAPL,MSFT');
      if (i === 0) {
        expect(p.get('after')).toBe(new Date(t0 - 1000).toISOString());
        return json(page(0, 500));
      }
      if (i === 1) {
        expect(p.get('after')).toBe(new Date(t0 + 499 * 1000).toISOString());
        // `after` inklusiv simuliert: die Grenz-Order kommt noch einmal mit
        return json([...page(499, 1), ...page(500, 499)]);
      }
      return json(page(999, 100));
    });
    const orders = await client.listOrders({ status: 'all', symbols: ['AAPL', 'MSFT'], after: t0 - 1000, limit: 1050, nested: true });
    expect(calls).toHaveLength(3);
    expect(orders).toHaveLength(1050);
    expect(new Set(orders.map((o) => o.id)).size).toBe(1050);
    expect(orders[0]!.id).toBe('o-0');
    expect(orders[1049]!.id).toBe('o-1049');
  });

  it('listOrders ohne limit: kurze Seite beendet die Schleife', async () => {
    const { client, calls } = makeClient(() => json([orderRaw({ id: 'a' }), orderRaw({ id: 'b' })]));
    const orders = await client.listOrders({ status: 'open' });
    expect(orders.map((o) => o.id)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('nested')).toBeNull();
    expect(calls[0]!.url.searchParams.get('symbols')).toBeNull();
  });

  it('replaceOrder: Preise auf dem Raster ⇒ nur PATCH; daneben ⇒ erst Seite der Order holen', async () => {
    const { client, calls } = makeClient((c) => (c.method === 'GET' ? json(orderRaw({ side: 'sell', type: 'stop', stop_price: '145' })) : json(orderRaw({ side: 'sell', stop_price: '144.99' }))));
    await client.replaceOrder('ord-1', { stopPrice: 145.5, qty: 5 });
    expect(calls.map((c) => c.method)).toEqual(['PATCH']);
    expect(calls[0]!.url.pathname).toBe('/v2/orders/ord-1');
    expect(calls[0]!.body).toEqual({ qty: '5', stop_price: '145.50' });

    await client.replaceOrder('ord-1', { stopPrice: 144.996, clientOrderId: 'cid-2' });
    expect(calls.slice(1).map((c) => c.method)).toEqual(['GET', 'PATCH']);
    // Sell-Stop ⇒ vom Kurs weg = abrunden
    expect(calls[2]!.body).toEqual({ client_order_id: 'cid-2', stop_price: '144.99' });
  });

  it('Kalender', async () => {
    const { client, calls } = makeClient(() => json([{ date: '2024-07-03', open: '09:30', close: '13:00' }]));
    const days = await client.getCalendar('2024-07-01', '2024-07-05');
    expect(calls[0]!.url.pathname).toBe('/v2/calendar');
    expect(calls[0]!.url.searchParams.get('start')).toBe('2024-07-01');
    expect(days).toEqual([{ date: '2024-07-03', open: '09:30', close: '13:00' }]);
  });
});
