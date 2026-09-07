import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSecret, setLogSink } from '../../src/core/log.ts';
import { startStatusServer, type StatusServer } from '../../src/status/http.ts';

let srv: StatusServer | null = null;
const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  setLogSink((l) => {
    lines.push(l);
  });
});

afterEach(async () => {
  if (srv) await srv.close();
  srv = null;
  setLogSink((l) => process.stdout.write(l + '\n'));
});

const base = (s: StatusServer): string => `http://${s.host}:${s.port}`;

describe('startStatusServer', () => {
  it('bindet an 127.0.0.1 und einen zufälligen Port bei port 0', async () => {
    srv = startStatusServer({ port: 0, status: () => ({}) });
    expect(srv.port).toBe(0); // noch nicht gebunden
    await srv.ready;
    expect(srv.host).toBe('127.0.0.1');
    expect(srv.port).toBeGreaterThan(0);
  });

  it('GET /health ⇒ 200 {ok:true, ts}', async () => {
    srv = startStatusServer({ port: 0, status: () => ({}) });
    await srv.ready;
    const r = await fetch(`${base(srv)}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const j = (await r.json()) as { ok: boolean; ts: string };
    expect(j.ok).toBe(true);
    expect(typeof j.ts).toBe('string');
    expect(Number.isNaN(Date.parse(j.ts))).toBe(false);
  });

  it('GET /status ⇒ JSON des Providers, bei jedem Aufruf frisch, Secrets geschwärzt', async () => {
    registerSecret('geheimer-status-token');
    let n = 0;
    srv = startStatusServer({
      port: 0,
      status: () => ({
        mode: 'paper',
        calls: ++n,
        equity: 100_000.5,
        apiKey: 'PKABCDEFGHIJKLMNOPQRSTUV',
        token: 'geheimer-status-token',
        nested: { positions: [{ symbol: 'SPY', qty: 3 }] },
      }),
    });
    await srv.ready;
    const r1 = await fetch(`${base(srv)}/status?x=1`);
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as Record<string, unknown>;
    expect(j1.mode).toBe('paper');
    expect(j1.calls).toBe(1);
    expect(j1.equity).toBe(100_000.5);
    expect(j1.apiKey).toBe('PK«geschwärzt»');
    expect(j1.token).toBe('«geschwärzt»');
    expect(j1.nested).toEqual({ positions: [{ symbol: 'SPY', qty: 3 }] });

    const j2 = (await (await fetch(`${base(srv)}/status`)).json()) as Record<string, unknown>;
    expect(j2.calls).toBe(2);
  });

  it('andere Pfade ⇒ 404, andere Methoden ⇒ 405', async () => {
    srv = startStatusServer({ port: 0, status: () => ({}) });
    await srv.ready;
    expect((await fetch(`${base(srv)}/`)).status).toBe(404);
    expect((await fetch(`${base(srv)}/foo`)).status).toBe(404);
    const post = await fetch(`${base(srv)}/status`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect((await fetch(`${base(srv)}/health`, { method: 'DELETE' })).status).toBe(405);
  });

  it('ein werfender Provider ergibt 500, der Server läuft weiter', async () => {
    let fail = true;
    srv = startStatusServer({
      port: 0,
      status: () => {
        if (fail) throw new Error('Buch nicht geladen');
        return { ok: 1 };
      },
    });
    await srv.ready;
    const r = await fetch(`${base(srv)}/status`);
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toContain('Buch nicht geladen');
    expect(lines.some((l) => l.includes('Status-Provider fehlgeschlagen'))).toBe(true);

    fail = false;
    expect((await fetch(`${base(srv)}/health`)).status).toBe(200);
    expect(((await (await fetch(`${base(srv)}/status`)).json()) as { ok: number }).ok).toBe(1);
  });

  it('close() beendet den Server; danach ist der Port zu', async () => {
    const s = startStatusServer({ port: 0, status: () => ({}) });
    await s.ready;
    expect((await fetch(`${base(s)}/health`)).status).toBe(200);
    await s.close();
    await expect(fetch(`${base(s)}/health`)).rejects.toThrow();
  });

  it('belegter Port ⇒ ready lehnt ab, Fehler ist geloggt, close() löst trotzdem', async () => {
    srv = startStatusServer({ port: 0, status: () => ({}) });
    await srv.ready;
    const second = startStatusServer({ port: srv.port, status: () => ({}) });
    await expect(second.ready).rejects.toThrow(/EADDRINUSE/);
    expect(lines.some((l) => l.includes('Status-Endpunkt konnte nicht starten') && l.includes('"level":"error"'))).toBe(true);
    await expect(second.close()).resolves.toBeUndefined();
    // der erste Server ist davon unberührt
    expect((await fetch(`${base(srv)}/health`)).status).toBe(200);
  });

  it('ein Bind auf alle Schnittstellen wird gewarnt (nicht verhindert)', async () => {
    srv = startStatusServer({ port: 0, status: () => ({}), host: '0.0.0.0' });
    await srv.ready;
    expect(lines.some((l) => l.includes('allen Schnittstellen') && l.includes('"level":"warn"'))).toBe(true);
  });
});
