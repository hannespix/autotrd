import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setLogSink } from '../../src/core/log.ts';
import { MIN } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { BarStore, barFileName, barStoreRoot, mergeBars } from '../../src/data/store.ts';

setLogSink(() => undefined);

const T0 = Date.UTC(2026, 8, 1, 13, 30);
const bar = (i: number, c = 100 + i): Bar => ({ t: T0 + i * MIN, o: c, h: c + 1, l: c - 1, c, v: 10 + i });

function freshStore(): BarStore {
  return new BarStore(barStoreRoot(mkdtempSync(join(tmpdir(), 'autotrd-store-')), 'us_equity', 'iex'));
}

describe('BarStore', () => {
  it('liefert leer, wenn nichts gespeichert ist, und meldet lastTime null', () => {
    const s = freshStore();
    expect(s.load('AAPL', '1Min')).toEqual([]);
    expect(s.lastTime('AAPL', '1Min')).toBeNull();
  });

  it('upsert: merge nach t, spätere Version gewinnt, sortiert, Gesamtstand zurück', () => {
    const s = freshStore();
    s.upsert('AAPL', '1Min', [bar(0), bar(1), bar(2)]);
    const merged = s.upsert('AAPL', '1Min', [bar(2, 999), bar(4), bar(3)]);
    expect(merged.map((b) => b.t)).toEqual([0, 1, 2, 3, 4].map((i) => T0 + i * MIN));
    expect(merged[2]?.c).toBe(999);
    expect(s.lastTime('AAPL', '1Min')).toBe(T0 + 4 * MIN);
    // Neue Instanz liest von Platte dasselbe.
    const again = new BarStore(s.root);
    expect(again.load('AAPL', '1Min')).toEqual(merged);
  });

  it('speichert atomar im kolumnaren Format, ohne Temp-Reste, mit / → - im Dateinamen', () => {
    const s = freshStore();
    s.save('BTC/USD', '1Min', [bar(1), bar(0)]);
    const path = s.pathFor('BTC/USD', '1Min');
    expect(path.endsWith(join('us_equity', 'iex', 'BTC-USD_1Min.json'))).toBe(true);
    expect(barFileName('BRK.B', '1Day')).toBe('BRK.B_1Day.json');
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(s.root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version: number; symbol: string; tf: string; t: number[]; c: number[] };
    expect(raw.version).toBe(1);
    expect(raw.symbol).toBe('BTC/USD');
    expect(raw.tf).toBe('1Min');
    expect(raw.t).toEqual([T0, T0 + MIN]);
    expect(raw.c).toEqual([100, 101]);
  });

  it('prune entfernt ältere Bars und schreibt zurück', () => {
    const s = freshStore();
    s.upsert('AAPL', '1Day', [bar(0), bar(1), bar(2)]);
    s.prune('AAPL', '1Day', T0 + MIN);
    expect(s.load('AAPL', '1Day').map((b) => b.t)).toEqual([T0 + MIN, T0 + 2 * MIN]);
    expect(new BarStore(s.root).load('AAPL', '1Day')).toHaveLength(2);
  });

  it('behandelt eine kaputte Datei als leer statt zu sterben', () => {
    const s = freshStore();
    s.save('AAPL', '1Min', [bar(0)]);
    writeFileSync(s.pathFor('AAPL', '1Min'), '{ kaputt');
    const fresh = new BarStore(s.root);
    expect(fresh.load('AAPL', '1Min')).toEqual([]);
    expect(fresh.upsert('AAPL', '1Min', [bar(5)])).toHaveLength(1);
  });

  it('mergeBars: Anhängen ohne Sortierung, sonst Map-Merge', () => {
    expect(mergeBars([bar(0)], [bar(1), bar(2)]).map((b) => b.t)).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
    expect(mergeBars([bar(1)], [bar(0), bar(1, 7)]).map((b) => b.c)).toEqual([100, 7]);
    expect(mergeBars([], [])).toEqual([]);
  });
});
