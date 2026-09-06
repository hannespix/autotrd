/**
 * Alpaca WebSocket-Streams: Minuten-Bars (Daten-API) und trade_updates
 * (Trading-API). Beide teilen sich den Verbindungskern (Verbinden, Auth,
 * Reconnect mit Backoff, Frische, sichere Callbacks); nur das Protokoll
 * unterscheidet sich und steckt in je einem Adapter.
 *
 * Reconnect-Regeln:
 *  - close/error ⇒ neu verbinden nach 1 s → 2 s → … → maxBackoffMs (30 s),
 *    danach erneut auth + subscribe/listen. Jeder Übergang geht an onStatus.
 *  - Auth-Fehler (Code 401/402/403 bzw. „unauthorized") zählen; nach drei
 *    Stück ist Schluss (Status 'error' mit Detail) — falsche Keys werden
 *    durch Wiederholen nicht richtig.
 *  - close() beendet endgültig, ohne Reconnect.
 *  - Callbacks laufen in try/catch: Ein werfender Callback darf den Strom
 *    nicht abreißen lassen.
 *
 * Nachrichten kommen als String, ArrayBuffer oder Blob (Node-WebSocket:
 * Binärframes als Blob); alles wird als UTF-8-JSON gelesen und in
 * Empfangsreihenfolge verarbeitet.
 */
import type { AssetClass, Bar, Ms } from '../core/types.ts';
import { errMsg, logger } from '../core/log.ts';
import type { DataStream, StreamStatus, StreamStatusEvent, TradeStream, TradeUpdate } from './types.ts';
import { isObject, mapBar, mapTradeUpdate, toStr, type RawObject } from './raw.ts';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (ev: unknown) => void): void;
  readyState?: number;
}

export interface StreamOptions {
  keyId: string;
  secret: string;
  /** Injizierbar für Tests; Default: globales WebSocket (Node ≥ 22). */
  wsFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Obergrenze des Reconnect-Backoffs (Default 30 000). */
  maxBackoffMs?: number;
}

export type DataStreamOptions = StreamOptions & { feed: 'iex' | 'sip'; assetClass: AssetClass };
export type TradeStreamOptions = StreamOptions & { mode: 'paper' | 'live' };

export const DATA_STREAM_URL = {
  us_equity: (feed: 'iex' | 'sip'): string => `wss://stream.data.alpaca.markets/v2/${feed}`,
  crypto: (): string => 'wss://stream.data.alpaca.markets/v1beta3/crypto/us',
} as const;

export const TRADE_STREAM_URL: Record<'paper' | 'live', string> = {
  paper: 'wss://paper-api.alpaca.markets/stream',
  live: 'wss://api.alpaca.markets/stream',
};

const BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const JITTER_MS = 500;
const MAX_AUTH_FAILURES = 3;
/** Daten-Stream-Fehlercodes, die Auth bedeuten (401 nicht authentifiziert, 402 Auth fehlgeschlagen, 403 bereits authentifiziert). */
const AUTH_ERROR_CODES = new Set([401, 402, 403]);

/* ───────────────────────── Verbindungskern ───────────────────────── */

/** Was der Protokoll-Adapter am Kern bedienen darf. */
interface Session {
  send(frame: unknown): void;
  /** Auth bestätigt: Backoff und Auth-Zähler zurücksetzen. */
  authenticated(): void;
  /** Subscribe/Listen bestätigt. */
  subscribed(): void;
  /** Der Strom ist für den Aufrufer benutzbar — löst connect() ein. */
  ready(): void;
  /** Auth-Fehler: zählt; ab dem dritten endgültig. Schließt die Verbindung. */
  authFailed(detail: string): void;
  /** Sonstiger Protokollfehler: nur melden — ob die Verbindung fällt, entscheidet der Server. */
  protocolError(detail: string): void;
}

interface ProtocolAdapter {
  url: string;
  /** Socket ist offen. */
  onOpen(session: Session): void;
  /** Eine geparste Nachricht (Arrays bereits entpackt). */
  onMessage(msg: RawObject, session: Session): void;
  /** Verbindung ist weg (vor einem etwaigen Reconnect). */
  onDisconnect(): void;
}

interface CoreOptions {
  wsFactory: (url: string) => WebSocketLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  maxBackoffMs: number;
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

interface StreamCore {
  connect(): Promise<void>;
  close(): Promise<void>;
  onStatus(cb: (ev: StreamStatusEvent) => void): void;
  lastMessageAt(): Ms | null;
  /** Aktueller Socket, falls authentifiziert — sonst null. */
  session(): Session | null;
}

async function decodeMessageData(data: unknown): Promise<string | null> {
  if (typeof data === 'string') return data;
  // Buffer statt TextDecoder: dessen Typen streiten mit den Node-Deklarationen von ArrayBufferView.
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (isObject(data) && typeof data.text === 'function') {
    return await (data as { text(): Promise<string> }).text();
  }
  return null;
}

function describeClose(ev: unknown): string {
  if (!isObject(ev)) return 'Verbindung geschlossen';
  const code = typeof ev.code === 'number' ? ev.code : null;
  const reason = toStr(ev.reason);
  return `Verbindung geschlossen${code !== null ? ` (Code ${code})` : ''}${reason ? `: ${reason}` : ''}`;
}

function describeError(ev: unknown): string {
  if (!isObject(ev)) return 'Socket-Fehler';
  const msg = toStr(ev.message) ?? (ev.error instanceof Error ? ev.error.message : null);
  return `Socket-Fehler${msg ? `: ${msg}` : ''}`;
}

function createCore(name: string, adapter: ProtocolAdapter, opts: CoreOptions): StreamCore {
  let ws: WebSocketLike | null = null;
  let closedByUser = false;
  let fatal = false;
  let started = false;
  let generation = 0; // Zähler je Socket — Ereignisse alter Sockets werden ignoriert
  let reconnectAttempt = 0;
  let authFailures = 0;
  let isAuthenticated = false;
  let everReady = false;
  let lastMsgAt: Ms | null = null;
  let queue: Promise<void> = Promise.resolve(); // Nachrichten strikt in Empfangsreihenfolge
  const statusCbs: ((ev: StreamStatusEvent) => void)[] = [];
  const connectWaiters: Waiter[] = [];

  function safeCall(fn: () => void, what: string): void {
    try {
      fn();
    } catch (e) {
      logger.error(`${name}: ${what} warf`, { err: errMsg(e) });
    }
  }

  function emitStatus(status: StreamStatus, detail?: string): void {
    const ev: StreamStatusEvent = detail === undefined ? { status, at: opts.now() } : { status, detail, at: opts.now() };
    logger.debug(`${name}: ${status}`, detail === undefined ? {} : { detail });
    for (const cb of statusCbs) safeCall(() => cb(ev), 'Status-Callback');
  }

  function settleWaiters(err: Error | null): void {
    const waiters = connectWaiters.splice(0);
    for (const w of waiters) {
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  function currentSession(gen: number, sock: WebSocketLike): Session {
    return {
      send(frame) {
        if (gen !== generation) return;
        try {
          sock.send(JSON.stringify(frame));
        } catch (e) {
          logger.warn(`${name}: Senden fehlgeschlagen`, { err: errMsg(e) });
        }
      },
      authenticated() {
        if (gen !== generation) return;
        isAuthenticated = true;
        authFailures = 0;
        reconnectAttempt = 0;
        emitStatus('authenticated');
      },
      subscribed() {
        if (gen !== generation) return;
        emitStatus('subscribed');
      },
      ready() {
        if (gen !== generation) return;
        everReady = true;
        settleWaiters(null);
      },
      authFailed(detail) {
        if (gen !== generation) return;
        authFailures++;
        if (authFailures >= MAX_AUTH_FAILURES) {
          fatal = true;
          const msg = `Auth endgültig gescheitert (${authFailures}×): ${detail}`;
          teardown(gen, sock, null);
          emitStatus('error', msg);
          settleWaiters(new Error(`${name}: ${msg}`));
          return;
        }
        emitStatus('error', `Auth fehlgeschlagen (${authFailures}/${MAX_AUTH_FAILURES}): ${detail}`);
        // Der Server trennt nach Auth-Fehlern ohnehin; wir warten nicht darauf.
        teardown(gen, sock, detail);
      },
      protocolError(detail) {
        if (gen !== generation) return;
        logger.warn(`${name}: Protokollfehler`, { detail });
        emitStatus('error', detail);
      },
    };
  }

  /**
   * Verbindung abbauen. `disconnectDetail` ≠ null ⇒ Status 'disconnected'
   * melden und (sofern erlaubt) Reconnect planen; null ⇒ still (endgültige
   * Fälle, bei denen der Aufrufer selbst den Abschluss-Status setzt).
   */
  function teardown(gen: number, sock: WebSocketLike | null, disconnectDetail: string | null): void {
    if (gen !== generation) return;
    generation++;
    ws = null;
    isAuthenticated = false;
    if (sock) {
      try {
        sock.close();
      } catch (e) {
        logger.debug(`${name}: close() warf`, { err: errMsg(e) });
      }
    }
    safeCall(() => adapter.onDisconnect(), 'onDisconnect');
    if (disconnectDetail !== null) {
      emitStatus('disconnected', disconnectDetail);
      if (!closedByUser && !fatal) void reconnectLater();
    }
  }

  async function reconnectLater(): Promise<void> {
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** reconnectAttempt + Math.floor(Math.random() * JITTER_MS), opts.maxBackoffMs);
    reconnectAttempt++;
    logger.info(`${name}: Reconnect in ${delay} ms`, { attempt: reconnectAttempt });
    await opts.sleep(delay);
    if (closedByUser || fatal) return;
    openSocket();
  }

  function openSocket(): void {
    const gen = ++generation;
    emitStatus('connecting');
    let sock: WebSocketLike;
    try {
      sock = opts.wsFactory(adapter.url);
    } catch (e) {
      // Fabrik-Fehler (z. B. DNS) behandeln wie einen Abriss: melden, später erneut.
      generation++;
      emitStatus('disconnected', `WebSocket konnte nicht erzeugt werden: ${errMsg(e)}`);
      if (!closedByUser && !fatal) void reconnectLater();
      return;
    }
    ws = sock;
    const session = currentSession(gen, sock);
    sock.addEventListener('open', () => {
      if (gen !== generation) return;
      emitStatus('connected');
      safeCall(() => adapter.onOpen(session), 'onOpen');
    });
    sock.addEventListener('message', (ev) => {
      if (gen !== generation) return;
      lastMsgAt = opts.now();
      const data = isObject(ev) ? ev.data : ev;
      queue = queue.then(() => handleData(gen, session, data)).catch((e) => {
        logger.error(`${name}: Nachricht nicht verarbeitbar`, { err: errMsg(e) });
      });
    });
    sock.addEventListener('error', (ev) => {
      if (gen !== generation) return;
      const detail = describeError(ev);
      emitStatus('error', detail);
      // Ein 'close' folgt normalerweise — aber nicht bei jeder Implementierung. Wir bauen selbst ab.
      teardown(gen, sock, detail);
    });
    sock.addEventListener('close', (ev) => {
      if (gen !== generation) return;
      teardown(gen, sock, describeClose(ev));
    });
  }

  async function handleData(gen: number, session: Session, data: unknown): Promise<void> {
    const text = await decodeMessageData(data);
    if (gen !== generation || text === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn(`${name}: kein JSON`, { head: text.slice(0, 120) });
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (gen !== generation) return;
      if (!isObject(item)) continue;
      safeCall(() => adapter.onMessage(item, session), 'Nachrichten-Handler');
    }
  }

  return {
    connect(): Promise<void> {
      if (closedByUser) return Promise.reject(new Error(`${name}: bereits geschlossen`));
      if (fatal) return Promise.reject(new Error(`${name}: endgültig gescheitert`));
      if (everReady && ws) return Promise.resolve();
      const p = new Promise<void>((resolve, reject) => connectWaiters.push({ resolve, reject }));
      if (!started) {
        started = true;
        openSocket();
      }
      return p;
    },
    async close(): Promise<void> {
      if (closedByUser) return;
      closedByUser = true;
      const sock = ws;
      teardown(generation, sock, null);
      emitStatus('disconnected', 'close()');
      settleWaiters(new Error(`${name}: geschlossen`));
    },
    onStatus(cb) {
      statusCbs.push(cb);
    },
    lastMessageAt: () => lastMsgAt,
    session: () => (isAuthenticated && ws ? currentSession(generation, ws) : null),
  };
}

function defaultOptions(o: StreamOptions): CoreOptions {
  return {
    wsFactory: o.wsFactory ?? ((url) => new WebSocket(url)),
    now: o.now ?? Date.now,
    sleep: o.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    maxBackoffMs: o.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
  };
}

/* ───────────────────────── Daten-Stream (Bars) ───────────────────────── */

export function createDataStream(opts: DataStreamOptions): DataStream {
  const desired = new Set<string>();
  const barCbs: ((symbol: string, bar: Bar) => void)[] = [];
  let pendingSubscribes: (() => void)[] = [];
  let live: Session | null = null;

  const settleSubscribes = (): void => {
    const waiting = pendingSubscribes;
    pendingSubscribes = [];
    for (const resolve of waiting) resolve();
  };

  const sendSubscribe = (session: Session, symbols: readonly string[]): void => {
    if (symbols.length === 0) return;
    session.send({ action: 'subscribe', bars: [...symbols] });
  };

  const adapter: ProtocolAdapter = {
    url: opts.assetClass === 'crypto' ? DATA_STREAM_URL.crypto() : DATA_STREAM_URL.us_equity(opts.feed),
    onOpen() {
      // Auth erst nach der „connected"-Meldung des Servers — so verlangt es das Protokoll.
    },
    onMessage(msg, session) {
      const type = msg.T;
      if (type === 'success') {
        if (msg.msg === 'connected') {
          session.send({ action: 'auth', key: opts.keyId, secret: opts.secret });
        } else if (msg.msg === 'authenticated') {
          live = session;
          session.authenticated();
          session.ready();
          // Nach jedem (Re-)Connect alle gewünschten Symbole erneut abonnieren.
          sendSubscribe(session, [...desired]);
        }
        return;
      }
      if (type === 'subscription') {
        session.subscribed();
        settleSubscribes();
        return;
      }
      if (type === 'error') {
        const code = typeof msg.code === 'number' ? msg.code : null;
        const detail = `Alpaca-Fehler ${code ?? '?'}: ${toStr(msg.msg) ?? ''}`;
        if (code !== null && AUTH_ERROR_CODES.has(code)) session.authFailed(detail);
        else session.protocolError(detail);
        return;
      }
      if (type === 'b') {
        const symbol = toStr(msg.S);
        if (!symbol) return;
        let bar: Bar;
        try {
          bar = mapBar(msg);
        } catch (e) {
          logger.warn('DataStream: Bar unbrauchbar', { symbol, err: errMsg(e) });
          return;
        }
        for (const cb of barCbs) {
          try {
            cb(symbol, bar);
          } catch (e) {
            logger.error('DataStream: Bar-Callback warf', { symbol, err: errMsg(e) });
          }
        }
      }
      // 't'/'q'/'u'/'d' u. a. sind nicht abonniert — ignorieren.
    },
    onDisconnect() {
      live = null;
      // Wartende subscribeBars() nicht hängen lassen: Nach dem Reconnect wird ohnehin neu abonniert.
      settleSubscribes();
    },
  };

  const core = createCore('DataStream', adapter, defaultOptions(opts));

  return {
    connect: () => core.connect(),
    async subscribeBars(symbols: string[]): Promise<void> {
      const fresh = symbols.filter((s) => !desired.has(s));
      for (const s of symbols) desired.add(s);
      if (fresh.length === 0) return;
      const session = live ?? core.session();
      if (!session) return; // wird nach der Auth gesendet
      const acked = new Promise<void>((resolve) => pendingSubscribes.push(resolve));
      sendSubscribe(session, fresh);
      await acked;
    },
    onBar(cb) {
      barCbs.push(cb);
    },
    onStatus: (cb) => core.onStatus(cb),
    lastMessageAt: () => core.lastMessageAt(),
    close: () => core.close(),
  };
}

/* ───────────────────────── Trade-Stream (trade_updates) ───────────────────────── */

export function createTradeStream(opts: TradeStreamOptions): TradeStream {
  const updateCbs: ((u: TradeUpdate) => void)[] = [];
  const coreOpts = defaultOptions(opts);

  const adapter: ProtocolAdapter = {
    url: TRADE_STREAM_URL[opts.mode],
    onOpen(session) {
      session.send({ action: 'auth', key: opts.keyId, secret: opts.secret });
    },
    onMessage(msg, session) {
      const stream = msg.stream;
      const data = isObject(msg.data) ? msg.data : {};
      if (stream === 'authorization') {
        if (data.status === 'authorized') {
          session.authenticated();
          session.send({ action: 'listen', data: { streams: ['trade_updates'] } });
        } else {
          session.authFailed(`Trading-Stream: ${toStr(data.status) ?? 'unauthorized'}${data.message ? ` — ${String(data.message)}` : ''}`);
        }
        return;
      }
      if (stream === 'listening') {
        session.subscribed();
        // Erst jetzt kommen Updates an — deshalb löst erst das Listening connect() ein.
        session.ready();
        return;
      }
      if (stream === 'trade_updates') {
        let update: TradeUpdate;
        try {
          update = mapTradeUpdate(data, coreOpts.now());
        } catch (e) {
          logger.error('TradeStream: Update unbrauchbar', { err: errMsg(e), event: toStr(data.event) });
          return;
        }
        for (const cb of updateCbs) {
          try {
            cb(update);
          } catch (e) {
            logger.error('TradeStream: Update-Callback warf', { err: errMsg(e) });
          }
        }
        return;
      }
      if (stream === 'error' || msg.error !== undefined) {
        session.protocolError(`Trading-Stream: ${toStr(data.message) ?? toStr(msg.error) ?? 'Fehler'}`);
      }
    },
    onDisconnect() {
      // nichts zu verwerfen — listen wird nach dem Reconnect neu gesendet
    },
  };

  const core = createCore('TradeStream', adapter, coreOpts);

  return {
    connect: () => core.connect(),
    onUpdate(cb) {
      updateCbs.push(cb);
    },
    onStatus: (cb) => core.onStatus(cb),
    lastMessageAt: () => core.lastMessageAt(),
    close: () => core.close(),
  };
}
