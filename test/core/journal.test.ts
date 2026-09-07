import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, StateStore, emptyState, homePaths, readJson, writeJsonAtomic } from '../../src/core/journal.ts';
import { redact, registerSecret, safeStringify, setLogSink, logger } from '../../src/core/log.ts';
import type { Trade } from '../../src/core/types.ts';

const trade: Trade = {
  symbol: 'AAPL',
  side: 'long',
  qty: 1,
  entryTime: 1,
  entryPrice: 100,
  exitTime: 2,
  exitPrice: 101,
  grossPnl: 1,
  fees: 0.1,
  netPnl: 0.9,
  rMultiple: 0.45,
  exitReason: 'target',
  strategy: 's',
  barsHeld: 1,
  mae: null,
  mfe: null,
};

describe('Journal', () => {
  it('hängt an, liest zurück und überspringt kaputte Zeilen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atd-'));
    const j = new Journal(join(dir, 'sub', 'journal.jsonl'));
    j.append('start', { mode: 'paper' }, 10);
    appendFileSync(j.path, '{kaputt\n');
    j.append('trade_closed', { trade }, 20);
    const all = j.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.kind).toBe('start');
    expect(j.trades()).toEqual([trade]);
  });

  it('schwärzt registrierte Secrets beim Schreiben', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atd-'));
    const j = new Journal(join(dir, 'journal.jsonl'));
    registerSecret('PKTOPSECRET123456789');
    j.append('error', { message: 'auth PKTOPSECRET123456789 failed' });
    expect(j.readAll()[0]!.message).not.toContain('PKTOPSECRET123456789');
  });
});

describe('State', () => {
  it('schreibt atomar und lädt zurück', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atd-'));
    const store = new StateStore(join(dir, 'state.json'));
    expect(store.load()).toBeNull();
    const s = emptyState('paper', '2026-09-04', 10_000);
    store.save(s);
    const back = store.load()!;
    expect(back.dayStartEquity).toBe(10_000);
    expect(back.halt.halted).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('writeJsonAtomic legt Verzeichnisse an; readJson liefert null bei leerer Datei', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atd-'));
    const p = join(dir, 'a', 'b', 'x.json');
    writeJsonAtomic(p, { a: 1 });
    expect(existsSync(p)).toBe(true);
    expect(readJson<{ a: number }>(p)!.a).toBe(1);
    appendFileSync(join(dir, 'leer.json'), '');
    expect(readJson(join(dir, 'leer.json'))).toBeNull();
  });

  it('homePaths', () => {
    const p = homePaths('/x');
    expect(p.state).toBe('/x/state.json');
    expect(p.haltFlag).toBe('/x/HALT');
  });
});

describe('Log-Schwärzung', () => {
  it('entfernt Secrets, Header-Werte und Key-Muster', () => {
    registerSecret('geheim-secret-xyz');
    expect(redact('a geheim-secret-xyz b')).not.toContain('geheim-secret-xyz');
    expect(redact('APCA-API-KEY-ID: PKABCDEFGHIJKLMNOPQR')).not.toContain('PKABCDEFGHIJKLMNOPQR');
    expect(redact('key AKABCDEFGHIJKLMNOPQR1234')).toBe('key AK«geschwärzt»');
    expect(safeStringify({ k: 'geheim-secret-xyz' })).not.toContain('geheim-secret-xyz');
  });

  it('logger schreibt JSON-Zeilen in die Senke', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    logger.warn('hallo', { n: 1 });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'hallo', n: 1 });
  });
});
