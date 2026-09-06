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
 * `port: 0` ⇒ das Betriebssystem wählt einen freien Port (Tests); der
 * echte Port steht im Rückgabewert. Weil `listen` asynchron ist, ist die
 * Funktion asynchron — ein belegter Port scheitert damit beim Start, nicht
 * still im Hintergrund.
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
  readonly port: number;
  readonly host: string;
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

export async function startStatusServer(a: StatusServerOptions): Promise<StatusServer> {
  const host = a.host ?? DEFAULT_STATUS_HOST;
  if (host === '' || host === '0.0.0.0' || host === '::') {
    logger.warn('Status-Endpunkt lauscht auf allen Schnittstellen — Kontodaten sind damit im Netz sichtbar', { host });
  }
  const server = createServer((req, res) => handleStatusRequest(a.status, req, res));
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(a.port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (e) => logger.error('Status-Endpunkt: Fehler', { error: errMsg(e) }));

  const addr = server.address();
  const port = addr !== null && typeof addr === 'object' ? addr.port : a.port;
  logger.info('Status-Endpunkt bereit', { host, port });

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
