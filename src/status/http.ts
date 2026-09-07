/**
 * Minimaler Status-Endpunkt auf `node:http` (keine Abhängigkeit).
 *
 *   GET /health → 200 {"ok":true,"ts":"…"}
 *   GET /status → 200 JSON aus dem StatusProvider — durch `safeStringify`,
 *                 also mit geschwärzten Secrets
 *   andere Pfade → 404, andere Methoden → 405
 *
 * Bindet standardmäßig an 127.0.0.1: Der Status enthält Kontodaten und
 * gehört nicht ins Netz. Wer ihn von außen braucht, tunnelt (`ssh -L`).
 * Ein Bind auf alle Schnittstellen wird geloggt, nicht verhindert.
 *
 * Die Funktion kehrt sofort zurück (die Engine wartet nicht auf den
 * Status-Endpunkt). `listen` ist asynchron: `ready` wird erfüllt, sobald
 * der Server lauscht, und abgelehnt, wenn der Port nicht zu binden ist —
 * der Fehler ist dann geloggt, die Engine läuft weiter. Bei `port: 0`
 * wählt das Betriebssystem einen freien Port (Tests); `port` liefert ihn
 * nach `await ready`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errMsg, logger, safeStringify } from '../core/log.ts';

export interface StatusProvider {
  (): Record<string, unknown>;
}

export interface StatusServerOptions {
  port: number;
  status: StatusProvider;
  /** Default 127.0.0.1. */
  host?: string;
}

export interface StatusServer {
  /** Tatsächlicher Port — bei `port: 0` erst nach `await ready` gültig. */
  readonly port: number;
  readonly host: string;
  /** Erfüllt, sobald der Server lauscht; abgelehnt, wenn der Port nicht zu binden ist. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_STATUS_HOST = '127.0.0.1';

function reply(res: ServerResponse, statusCode: number, body: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function handleStatusRequest(status: StatusProvider, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    reply(res, 405, '{"error":"nur GET"}', { allow: 'GET' });
    return;
  }
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    reply(res, 400, '{"error":"ungültige URL"}');
    return;
  }
  if (path === '/health') {
    reply(res, 200, JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }
  if (path === '/status') {
    let body: string;
    try {
      body = safeStringify(status());
    } catch (e) {
      logger.error('Status-Provider fehlgeschlagen', { error: errMsg(e) });
      reply(res, 500, safeStringify({ error: errMsg(e) }));
      return;
    }
    reply(res, 200, body);
    return;
  }
  reply(res, 404, '{"error":"nicht gefunden"}');
}

export function startStatusServer(a: StatusServerOptions): StatusServer {
  const host = a.host ?? DEFAULT_STATUS_HOST;
  if (host === '' || host === '0.0.0.0' || host === '::') {
    logger.warn('Status-Endpunkt lauscht auf allen Schnittstellen — Kontodaten sind damit im Netz sichtbar', { host });
  }
  const server = createServer((req, res) => handleStatusRequest(a.status, req, res));
  server.keepAliveTimeout = 5_000;

  let bound = a.port;
  const ready = new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => {
      logger.error('Status-Endpunkt konnte nicht starten', { host, port: a.port, error: errMsg(e) });
      reject(e);
    };
    server.once('error', onError);
    server.listen(a.port, host, () => {
      server.off('error', onError);
      server.on('error', (e) => logger.error('Status-Endpunkt: Fehler', { error: errMsg(e) }));
      const addr = server.address();
      if (addr !== null && typeof addr === 'object') bound = addr.port;
      logger.info('Status-Endpunkt bereit', { host, port: bound });
      resolve();
    });
  });
  // Ohne Beobachter darf ein Bind-Fehler den Prozess nicht als „unhandled rejection" beenden — er ist geloggt.
  ready.catch(() => undefined);

  return {
    get port() {
      return bound;
    },
    host,
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
