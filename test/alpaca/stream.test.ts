import { beforeEach, describe, expect, it } from 'vitest';
import { setLogSink } from '../../src/core/log.ts';
import type { StreamStatusEvent, TradeUpdate } from '../../src/alpaca/types.ts';
import { createDataStream, createTradeStream, type WebSocketLike } from '../../src/alpaca/stream.ts';

/* ───────────────────────── Fake-WebSocket ───────────────────────── */

type EvType = 'open' | 'message' | 'close' | 'error';

class FakeWs implements WebSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  closeCalls = 0;
  private readonly handlers: Record<EvType, ((ev: unknown) => void)[]> = { open: [], message: [], close: [], error: [] };

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: EvType, handler: (ev: unknown) => void): void {
    this.handlers[type].push(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Wie ein echter Socket: close() löst (einmalig) ein close-Ereignis aus. */
  close(): void {
    this.closeCalls++;
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit('close', { code: 1000, reason: '' });
    }
  }

  emit(type: EvType, ev: unknown): void {
    for (const h of [...this.handlers[type]]) h(ev);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  serverSend(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  serverClose(code = 1006, reason = 'gone'): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const KEY = 'PKTESTKEY0000000001';
const SECRET = 'test-secret-value-0123456789';

function harness(maxBackoffMs = 30_000) {
  const sockets: FakeWs[] = [];
  const sleeps: number[] = [];
  const statuses: StreamStatusEvent[] = [];
  let clock = 1_700_000_000_000;
  const opts = {
    keyId: KEY,
    secret: SECRET,
    wsFactory: (url: string): WebSocketLike => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    },
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
    },
    now: (): number => clock,
    maxBackoffMs,
  };
  return {
    opts,
    sockets,
    sleeps,
    statuses,
    tick: (ms: number) => {
      clock += ms;
    },
    statusList: () => statuses.map((s) => s.status),
  };
}

/** Daten-Stream: Server meldet connected, Client authentifiziert, Server bestätigt. */
async function dataAuth(ws: FakeWs): Promise<void> {
  ws.open();
  ws.serverSend([{ T: 'success', msg: 'connected' }]);
  await flush();
  ws.serverSend([{ T: 'success', msg: 'authenticated' }]);
  await flush();
}

const logLines: string[] = [];
beforeEach(() => {
  logLines.length = 0;
  setLogSink((line) => logLines.push(line));
});

/* ───────────────────────── Daten-Stream ───────────────────────── */

describe('DataStream', () => {
  it('URL je Feed/Asset-Klasse', () => {
    const h = harness();
    createDataStream({ ...h.opts, feed: 'sip', assetClass: 'us_equity' }).connect().catch(() => {});
    createDataStream({ ...h.opts, feed: 'iex', assetClass: 'crypto' }).connect().catch(() => {});
    expect(h.sockets[0]!.url).toBe('wss://stream.data.alpaca.markets/v2/sip');
    expect(h.sockets[1]!.url).toBe('wss://stream.data.alpaca.markets/v1beta3/crypto/us');
  });

  it('Auth erst nach „connected", dann subscribe; Status-Reihenfolge; Ack löst subscribeBars ein', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    stream.onStatus((ev) => h.statuses.push(ev));
    const connected = stream.connect();
    const ws = h.sockets[0]!;
    ws.open();
    await flush();
    expect(ws.frames()).toEqual([]); // noch keine Auth — der Server hat sich noch nicht gemeldet
    ws.serverSend([{ T: 'success', msg: 'connected' }]);
    await flush();
    expect(ws.frames()).toEqual([{ action: 'auth', key: KEY, secret: SECRET }]);
    ws.serverSend([{ T: 'success', msg: 'authenticated' }]);
    await connected;

    let subscribed = false;
    const sub = stream.subscribeBars(['AAPL', 'MSFT']).then(() => {
      subscribed = true;
    });
    expect(ws.frames()[1]).toEqual({ action: 'subscribe', bars: ['AAPL', 'MSFT'] });
    await flush();
    expect(subscribed).toBe(false);
    ws.serverSend([{ T: 'subscription', trades: [], quotes: [], bars: ['AAPL', 'MSFT'] }]);
    await sub;
    expect(subscribed).toBe(true);
    expect(h.statusList()).toEqual(['connecting', 'connected', 'authenticated', 'subscribed']);
    // bereits abonnierte Symbole lösen keinen zweiten Frame aus
    await stream.subscribeBars(['AAPL']);
    expect(ws.frames()).toHaveLength(2);
  });

  it('Symbole, die vor der Auth gewünscht wurden, werden nach der Auth abonniert', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    await stream.subscribeBars(['AAPL']); // noch nicht verbunden ⇒ sofort erfüllt, gemerkt
    void stream.connect();
    await dataAuth(h.sockets[0]!);
    expect(h.sockets[0]!.frames()[1]).toEqual({ action: 'subscribe', bars: ['AAPL'] });
  });

  it('Bar-Parsing: t → ms, Zahlen, n/vw; String-, Blob- und Buffer-Frames', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    const bars: [string, unknown][] = [];
    stream.onBar((s, b) => bars.push([s, b]));
    void stream.connect();
    const ws = h.sockets[0]!;
    await dataAuth(ws);
    const raw = { T: 'b', S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.5, v: 100, t: '2021-02-22T19:15:00Z', n: 10, vw: 1.2 };
    ws.serverSend([raw, { ...raw, S: 'MSFT', t: '2021-02-22T19:16:00Z' }]);
    ws.emit('message', { data: new Blob([JSON.stringify([{ ...raw, S: 'BLOB' }])]) });
    ws.emit('message', { data: Buffer.from(JSON.stringify([{ ...raw, S: 'BUF' }])) });
    ws.emit('message', { data: new Uint8Array(Buffer.from(JSON.stringify([{ ...raw, S: 'U8' }]))).buffer });
    await flush();
    expect(bars.map(([s]) => s)).toEqual(['AAPL', 'MSFT', 'BLOB', 'BUF', 'U8']);
    expect(bars[0]![1]).toEqual({ t: Date.UTC(2021, 1, 22, 19, 15), o: 1, h: 2, l: 0.5, c: 1.5, v: 100, n: 10, vw: 1.2 });
    expect(bars[1]![1]).toMatchObject({ t: Date.UTC(2021, 1, 22, 19, 16) });
  });

  it('lastMessageAt folgt jeder Nachricht; Nicht-JSON und fremde Typen stören nicht', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    const bars: string[] = [];
    stream.onBar((s) => bars.push(s));
    expect(stream.lastMessageAt()).toBeNull();
    void stream.connect();
    const ws = h.sockets[0]!;
    await dataAuth(ws);
    h.tick(5000);
    ws.emit('message', { data: 'kein json' });
    ws.serverSend([{ T: 't', S: 'AAPL', p: 1 }, { T: 'q', S: 'AAPL' }]);
    await flush();
    expect(stream.lastMessageAt()).toBe(1_700_000_000_000 + 5000);
    expect(bars).toEqual([]);
  });

  it('Reconnect nach close: Backoff über sleep, erneut auth + subscribe aller Symbole', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    stream.onStatus((ev) => h.statuses.push(ev));
    void stream.connect();
    const ws1 = h.sockets[0]!;
    await dataAuth(ws1);
    const sub = stream.subscribeBars(['AAPL']);
    ws1.serverSend([{ T: 'subscription', bars: ['AAPL'] }]);
    await sub;
    const pendingSub = stream.subscribeBars(['MSFT']); // Ack kommt nie — Verbindung reißt ab
    await flush();
    ws1.serverClose(1006, 'gone');
    await pendingSub; // darf nicht hängen
    await flush();
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(h.sleeps[0]).toBeLessThan(1500);
    expect(h.sockets).toHaveLength(2);
    const ws2 = h.sockets[1]!;
    await dataAuth(ws2);
    expect(ws2.frames()).toEqual([
      { action: 'auth', key: KEY, secret: SECRET },
      { action: 'subscribe', bars: ['AAPL', 'MSFT'] },
    ]);
    expect(h.statusList()).toEqual([
      'connecting',
      'connected',
      'authenticated',
      'subscribed',
      'disconnected',
      'connecting',
      'connected',
      'authenticated',
    ]);
    expect(h.statuses[4]!.detail).toContain('1006');
    // Ereignisse des alten Sockets werden ignoriert
    ws1.serverSend([{ T: 'b', S: 'AAPL', o: 1, h: 1, l: 1, c: 1, v: 1, t: '2021-02-22T19:15:00Z' }]);
    await flush();
    expect(stream.lastMessageAt()).not.toBeNull();
  });

  it('Backoff wächst 1 s → 2 s → 4 s … und wird bei maxBackoffMs gedeckelt; Auth setzt ihn zurück', async () => {
    const h = harness(3000);
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    void stream.connect();
    for (let i = 0; i < 4; i++) {
      h.sockets[i]!.open();
      h.sockets[i]!.serverClose();
      await flush();
    }
    expect(h.sleeps).toHaveLength(4);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(2000);
    expect(h.sleeps[1]).toBeLessThan(2500);
    expect(h.sleeps[2]).toBe(3000);
    expect(h.sleeps[3]).toBe(3000);
    await dataAuth(h.sockets[4]!);
    h.sockets[4]!.serverClose();
    await flush();
    expect(h.sleeps[4]).toBeLessThan(1500);
  });

  it('error-Ereignis ohne close: Verbindung wird abgebaut und neu aufgebaut', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    stream.onStatus((ev) => h.statuses.push(ev));
    void stream.connect();
    const ws1 = h.sockets[0]!;
    ws1.open();
    ws1.emit('error', { message: 'ECONNRESET' });
    await flush();
    expect(ws1.closeCalls).toBe(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.statusList()).toEqual(['connecting', 'connected', 'error', 'disconnected', 'connecting']);
    expect(h.statuses[2]!.detail).toContain('ECONNRESET');
  });

  it('Auth-Fehler (402) dreimal ⇒ Status error, kein weiterer Reconnect, connect() lehnt ab', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    stream.onStatus((ev) => h.statuses.push(ev));
    const connected = stream.connect();
    let rejected: Error | null = null;
    connected.catch((e: Error) => {
      rejected = e;
    });
    for (let i = 0; i < 3; i++) {
      const ws = h.sockets[i]!;
      ws.open();
      ws.serverSend([{ T: 'success', msg: 'connected' }]);
      await flush();
      ws.serverSend([{ T: 'error', code: 402, msg: 'auth failed' }]);
      await flush();
    }
    await flush();
    expect(h.sockets).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    const last = h.statuses[h.statuses.length - 1]!;
    expect(last.status).toBe('error');
    expect(last.detail).toMatch(/endgültig/);
    expect(last.detail).toContain('auth failed');
    expect(rejected).not.toBeNull();
    expect(h.sockets[2]!.closeCalls).toBe(1);
    // Nicht-Auth-Fehler (406) werden gemeldet, ändern aber nichts an der Verbindung
    const h2 = harness();
    const s2 = createDataStream({ ...h2.opts, feed: 'iex', assetClass: 'us_equity' });
    s2.onStatus((ev) => h2.statuses.push(ev));
    void s2.connect();
    await dataAuth(h2.sockets[0]!);
    h2.sockets[0]!.serverSend([{ T: 'error', code: 406, msg: 'connection limit exceeded' }]);
    await flush();
    expect(h2.statusList()).toEqual(['connecting', 'connected', 'authenticated', 'error']);
    expect(h2.sockets[0]!.closeCalls).toBe(0);
  });

  it('werfender Callback tötet den Stream nicht — Fehler landet im Log', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    const seen: string[] = [];
    stream.onBar(() => {
      throw new Error('kaputter Callback');
    });
    stream.onBar((s) => seen.push(s));
    stream.onStatus(() => {
      throw new Error('kaputter Status-Callback');
    });
    void stream.connect();
    const ws = h.sockets[0]!;
    await dataAuth(ws);
    const bar = { T: 'b', S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.5, v: 100, t: '2021-02-22T19:15:00Z' };
    ws.serverSend([bar, { ...bar, S: 'MSFT' }]);
    await flush();
    expect(seen).toEqual(['AAPL', 'MSFT']);
    expect(logLines.some((l) => l.includes('kaputter Callback'))).toBe(true);
    expect(logLines.some((l) => l.includes('kaputter Status-Callback'))).toBe(true);
  });

  it('close(): Socket zu, Status disconnected, kein Reconnect', async () => {
    const h = harness();
    const stream = createDataStream({ ...h.opts, feed: 'iex', assetClass: 'us_equity' });
    stream.onStatus((ev) => h.statuses.push(ev));
    void stream.connect();
    const ws = h.sockets[0]!;
    await dataAuth(ws);
    await stream.close();
    await flush();
    expect(ws.closeCalls).toBe(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
    expect(h.statuses[h.statuses.length - 1]).toMatchObject({ status: 'disconnected', detail: 'close()' });
    await expect(stream.connect()).rejects.toThrow(/geschlossen/);
  });
});

/* ───────────────────────── Trade-Stream ───────────────────────── */

describe('TradeStream', () => {
  it('URL je Modus; auth sofort nach open; listen nach authorized; connect() erst nach listening', async () => {
    const h = harness();
    const stream = createTradeStream({ ...h.opts, mode: 'paper' });
    stream.onStatus((ev) => h.statuses.push(ev));
    let ready = false;
    const connected = stream.connect().then(() => {
      ready = true;
    });
    const ws = h.sockets[0]!;
    expect(ws.url).toBe('wss://paper-api.alpaca.markets/stream');
    ws.open();
    expect(ws.frames()).toEqual([{ action: 'auth', key: KEY, secret: SECRET }]);
    ws.serverSend({ stream: 'authorization', data: { action: 'authenticate', status: 'authorized' } });
    await flush();
    expect(ws.frames()[1]).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } });
    expect(ready).toBe(false);
    ws.serverSend({ stream: 'listening', data: { streams: ['trade_updates'] } });
    await connected;
    expect(h.statusList()).toEqual(['connecting', 'connected', 'authenticated', 'subscribed']);

    const live = harness();
    void createTradeStream({ ...live.opts, mode: 'live' }).connect().catch(() => {});
    expect(live.sockets[0]!.url).toBe('wss://api.alpaca.markets/stream');
  });

  it('Trade-Update-Parsing: Fill mit Zahlen, Order gemappt', async () => {
    const h = harness();
    const stream = createTradeStream({ ...h.opts, mode: 'paper' });
    const updates: TradeUpdate[] = [];
    stream.onUpdate((u) => updates.push(u));
    void stream.connect();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverSend({ stream: 'authorization', data: { status: 'authorized' } });
    ws.serverSend({ stream: 'listening', data: { streams: ['trade_updates'] } });
    ws.serverSend({
      stream: 'trade_updates',
      data: {
        event: 'fill',
        execution_id: 'exec-9',
        price: '150.25',
        qty: '10',
        position_qty: '10',
        timestamp: '2024-05-06T13:31:05.123456Z',
        order: {
          id: 'ord-9',
          client_order_id: 'cid-9',
          symbol: 'AAPL',
          side: 'buy',
          type: 'market',
          time_in_force: 'day',
          qty: '10',
          filled_qty: '10',
          filled_avg_price: '150.25',
          status: 'filled',
          filled_at: '2024-05-06T13:31:05Z',
          order_class: 'simple',
        },
      },
    });
    ws.serverSend({ stream: 'trade_updates', data: { event: 'new', order: { id: 'ord-10', symbol: 'MSFT', side: 'sell', status: 'new' } } });
    await flush();
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ event: 'fill', price: 150.25, qty: 10, positionQty: 10, executionId: 'exec-9', timestamp: Date.UTC(2024, 4, 6, 13, 31, 5, 123) });
    expect(updates[0]!.order).toMatchObject({ id: 'ord-9', clientOrderId: 'cid-9', status: 'filled', filledAvgPrice: 150.25, filledQty: 10 });
    // ohne timestamp ⇒ Empfangszeit aus now()
    expect(updates[1]).toMatchObject({ event: 'new', price: null, timestamp: 1_700_000_000_000 });
    // kaputtes Update (Order ohne id) landet im Log, nicht beim Callback
    ws.serverSend({ stream: 'trade_updates', data: { event: 'fill', order: { symbol: 'X' } } });
    await flush();
    expect(updates).toHaveLength(2);
    expect(logLines.some((l) => l.includes('Update unbrauchbar'))).toBe(true);
  });

  it('Reconnect nach close mit erneutem auth + listen', async () => {
    const h = harness();
    const stream = createTradeStream({ ...h.opts, mode: 'paper' });
    void stream.connect();
    const ws1 = h.sockets[0]!;
    ws1.open();
    ws1.serverSend({ stream: 'authorization', data: { status: 'authorized' } });
    ws1.serverSend({ stream: 'listening', data: { streams: ['trade_updates'] } });
    await flush();
    ws1.serverClose();
    await flush();
    expect(h.sockets).toHaveLength(2);
    const ws2 = h.sockets[1]!;
    ws2.open();
    expect(ws2.frames()).toEqual([{ action: 'auth', key: KEY, secret: SECRET }]);
    ws2.serverSend({ stream: 'authorization', data: { status: 'authorized' } });
    await flush();
    expect(ws2.frames()[1]).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } });
  });

  it('unauthorized dreimal ⇒ Schluss', async () => {
    const h = harness();
    const stream = createTradeStream({ ...h.opts, mode: 'paper' });
    stream.onStatus((ev) => h.statuses.push(ev));
    const connected = stream.connect();
    for (let i = 0; i < 3; i++) {
      const ws = h.sockets[i]!;
      ws.open();
      ws.serverSend({ stream: 'authorization', data: { action: 'authenticate', status: 'unauthorized' } });
      await flush();
    }
    await flush();
    expect(h.sockets).toHaveLength(3);
    expect(h.statuses[h.statuses.length - 1]).toMatchObject({ status: 'error' });
    await expect(connected).rejects.toThrow(/Auth/);
  });
});
