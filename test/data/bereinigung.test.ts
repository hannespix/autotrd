/**
 * Bereinigte und rohe Tagesbars dürfen sich nie mischen.
 *
 * Drei Dinge, die hier Geld kosten würden:
 *  1. Ein bestehender Roh-Cache wandert bei `raw` auf einen anderen Pfad —
 *     jede Installation lüde alles neu, und der Engine-Start fände nichts.
 *  2. `fetch` mit `all` schreibt in den Roh-Cache (oder umgekehrt): Dann
 *     stünden in EINER Datei Bars zweier Kursbasen, und der Sprung an der
 *     Nahtstelle sähe aus wie ein Trend.
 *  3. Ein bereinigter Cache wird inkrementell fortgeschrieben: Bereinigte
 *     Kurse sind relativ zum Abrufdatum — mit jeder Ausschüttung nach dem
 *     letzten Vollabruf hielte die Historie einen anderen Stand als die
 *     neuen Bars. Nach einem Jahr TLT wären das rund 3 % im Momentum,
 *     unsichtbar und genau der Fehler, den der Schalter beheben soll.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AlpacaError } from '../../src/alpaca/types.ts';
import { bootstrap } from '../../src/app.ts';
import { setLogSink } from '../../src/core/log.ts';
import { DAY } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { backfill, backfillAdjustment } from '../../src/data/backfill.ts';
import { adjustmentInRoot, BarStore, barStoreRoot } from '../../src/data/store.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';

setLogSink(() => undefined);

const dir = mkdtempSync(join(tmpdir(), 'autotrd-bereinigung-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 8, 1, 13, 30);
const bar = (t: number, c = 100): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1 });
const tage = (von: number, bis: number, c: number): Bar[] => Array.from({ length: bis - von + 1 }, (_, i) => bar(T0 + (von + i) * DAY, c));
const frisch = () => mkdtempSync(join(dir, 'bars-'));

describe('barStoreRoot', () => {
  it('raw ist der bisherige Pfad — bestehende Caches bleiben gültig', () => {
    const alt = join(dir, 'us_equity', 'iex');
    expect(barStoreRoot(dir, 'us_equity', 'iex')).toBe(alt);
    expect(barStoreRoot(dir, 'us_equity', 'iex', 'raw')).toBe(alt);
    expect(barStoreRoot(dir, 'crypto', 'sip')).toBe(join(dir, 'crypto', 'sip'));
  });

  it('jede andere Bereinigung ist eine Geschwister-Wurzel, kein Unterordner des Roh-Caches', () => {
    const roh = barStoreRoot(dir, 'us_equity', 'iex');
    for (const adj of ['split', 'dividend', 'all'] as const) {
      const w = barStoreRoot(dir, 'us_equity', 'iex', adj);
      expect(w).toBe(join(dir, 'us_equity', `iex-adj-${adj}`));
      expect(w).not.toBe(roh);
      expect(w.startsWith(roh + sep)).toBe(false);
      expect(adjustmentInRoot(w)).toBe(adj);
    }
    expect(adjustmentInRoot(roh)).toBeNull();
    expect(barStoreRoot(dir, 'us_equity', 'sip', 'all')).not.toBe(barStoreRoot(dir, 'us_equity', 'iex', 'all'));
  });

  it('der Store liest seine Bereinigung aus der Wurzel und weigert sich bei Widerspruch', () => {
    const w = barStoreRoot(frisch(), 'us_equity', 'iex', 'all');
    expect(new BarStore(w).adjustment).toBe('all');
    expect(new BarStore(w, 'all').adjustment).toBe('all');
    expect(new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex')).adjustment).toBe('raw');
    expect(() => new BarStore(w, 'raw')).toThrow(/mischen/);
    expect(() => new BarStore(w, 'dividend')).toThrow(/mischen/);
  });
});

describe('backfill mit Bereinigung', () => {
  it('Tagesbars: die Bereinigung geht an den Broker; Minutenbars aus demselben Store: nie', async () => {
    const s = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex', 'all'));
    const fake = new FakeAlpaca();
    fake.bars.set('TLT', tage(0, 1, 100));
    await backfill({ client: fake, store: s, symbols: ['TLT'], tf: '1Day', from: T0, to: T0 + DAY, feed: 'iex', adjustment: 'all' });
    expect(fake.barRequests).toHaveLength(1);
    expect(fake.barRequests[0]).toMatchObject({ timeframe: '1Day', adjustment: 'all', feed: 'iex' });
    expect(s.load('TLT', '1Day')).toHaveLength(2);
    await backfill({ client: fake, store: s, symbols: ['TLT'], tf: '1Min', from: T0, to: T0 + DAY, feed: 'iex', adjustment: 'all', maxGapRanges: 0 });
    expect(fake.barRequests).toHaveLength(2);
    expect(fake.barRequests[1]?.timeframe).toBe('1Min');
    expect('adjustment' in fake.barRequests[1]!).toBe(false);
  });

  it('ohne Angabe gilt die Bereinigung des Stores — roh bleibt roh und inkrementell (bisheriges Verhalten)', async () => {
    const roh = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex'));
    roh.upsert('TLT', '1Day', tage(-2, 0, 100));
    const fake = new FakeAlpaca();
    fake.bars.set('TLT', tage(-2, 1, 100));
    await backfill({ client: fake, store: roh, symbols: ['TLT'], tf: '1Day', from: T0 - 2 * DAY, to: T0 + DAY, feed: 'iex' });
    // Genau eine Anfrage, ab der letzten Bar (nicht ab `from`): kein Vollabruf im Roh-Betrieb.
    expect(fake.barRequests).toHaveLength(1);
    expect(fake.barRequests[0]).toMatchObject({ start: T0, end: T0 + DAY, adjustment: 'raw' });

    const adj = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex', 'all'));
    const fake2 = new FakeAlpaca();
    fake2.bars.set('TLT', tage(0, 1, 100));
    await backfill({ client: fake2, store: adj, symbols: ['TLT'], tf: '1Day', from: T0, to: T0 + DAY, feed: 'iex' });
    expect(fake2.barRequests[0]?.adjustment).toBe('all');
  });

  it('weigert sich, eine andere Bereinigung in den Cache zu schreiben als die des Stores — und fragt dann auch nichts an', async () => {
    const roh = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex'));
    const adj = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex', 'all'));
    expect(() => backfillAdjustment({ store: adj, adjustment: 'raw' })).toThrow(/mischen/);
    expect(() => backfillAdjustment({ store: roh, adjustment: 'all' })).toThrow(/mischen/);
    expect(backfillAdjustment({ store: adj })).toBe('all');
    expect(backfillAdjustment({ store: roh })).toBe('raw');
    const fake = new FakeAlpaca();
    fake.bars.set('TLT', tage(0, 1, 100));
    await expect(backfill({ client: fake, store: roh, symbols: ['TLT'], tf: '1Day', from: T0, to: T0 + DAY, feed: 'iex', adjustment: 'all' })).rejects.toThrow(/mischen/);
    expect(fake.barRequests).toHaveLength(0);
    expect(roh.load('TLT', '1Day')).toEqual([]);
  });

  it('bereinigte Tagesbars werden IMMER vollständig neu geladen — der Cache trägt einen einzigen Bereinigungsstand', async () => {
    const s = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex', 'all'));
    // Alter Stand: fünf Tage, Kursbasis 100 (vor einer Ausschüttung abgerufen).
    s.save('TLT', '1Day', tage(-4, 0, 100));
    // Der Broker liefert heute alles auf Basis 90 — plus einen neuen Tag.
    const fake = new FakeAlpaca();
    fake.bars.set('TLT', tage(-4, 1, 90));
    // `from` liegt INNERHALB des Caches: Ein inkrementeller Backfill nähme nur den neuen Tag.
    const res = await backfill({ client: fake, store: s, symbols: ['TLT'], tf: '1Day', from: T0 - DAY, to: T0 + DAY, feed: 'iex', adjustment: 'all' });
    expect(fake.barRequests).toHaveLength(1);
    // Angefragt wird der GANZE Bestand: ab der ersten gecachten Bar bis `to`.
    expect(fake.barRequests[0]).toMatchObject({ start: T0 - 4 * DAY, end: T0 + DAY, adjustment: 'all' });
    const stand = s.load('TLT', '1Day');
    expect(stand).toHaveLength(6);
    expect(stand.every((b) => b.c === 90), 'alte Kursbasis überlebt im Cache').toBe(true);
    // Die Rückgabe bleibt wie beim inkrementellen Pfad auf `from` geschnitten.
    expect(res.get('TLT')?.map((b) => b.t)).toEqual([T0 - DAY, T0, T0 + DAY]);
    // Und die Datei liest sich in einer neuen Instanz genauso.
    expect(new BarStore(s.root).load('TLT', '1Day').every((b) => b.c === 90)).toBe(true);
  });

  it('ein fehlgeschlagener Block lässt den alten Stand stehen und meldet es; ein Symbol ohne Bars bleibt ebenfalls', async () => {
    const s = new BarStore(barStoreRoot(frisch(), 'us_equity', 'iex', 'all'));
    s.save('TLT', '1Day', tage(-2, 0, 100));
    s.save('IEF', '1Day', tage(-2, 0, 50));
    const fake = new FakeAlpaca();
    fake.bars.set('TLT', tage(-2, 1, 90));
    fake.throwOn('getBars', new AlpacaError('boom', 500, null, true), 1);
    const logs: string[] = [];
    await backfill({ client: fake, store: s, symbols: ['TLT', 'IEF'], tf: '1Day', from: T0 - 2 * DAY, to: T0 + DAY, feed: 'iex', adjustment: 'all', log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes('fehlgeschlagen'))).toBe(true);
    expect(s.load('TLT', '1Day').map((b) => b.c)).toEqual([100, 100, 100]);
    // Zweiter Lauf ohne Fehler: TLT neu, IEF (Broker liefert nichts) bleibt stehen.
    await backfill({ client: fake, store: s, symbols: ['TLT', 'IEF'], tf: '1Day', from: T0 - 2 * DAY, to: T0 + DAY, feed: 'iex', adjustment: 'all', log: (m) => logs.push(m) });
    expect(s.load('TLT', '1Day').map((b) => b.c)).toEqual([90, 90, 90, 90]);
    expect(s.load('IEF', '1Day').map((b) => b.c)).toEqual([50, 50, 50]);
    expect(logs.some((l) => l.includes('ohne Bars'))).toBe(true);
  });
});

describe('Wächter: fetch mit all schreibt nie in den Roh-Cache', () => {
  const env = join(dir, 'keine.env');

  function configDatei(name: string, brokerZeilen: string): string {
    const pfad = join(dir, name);
    writeFileSync(pfad, `broker:\n${brokerZeilen}universe:\n  symbols: [TLT, SPY]\n  benchmark: SPY\ntimeframe: 1440\n`, 'utf8');
    return pfad;
  }

  it('bootstrap mit broker.adjustment=all: Store in der adj-Wurzel; nach dem Backfill wie in `fetch` ist die Roh-Wurzel leer', async () => {
    const home = join(dir, 'home-all');
    const app = bootstrap({ config: configDatei('all.yaml', '  adjustment: all\n'), env, home });
    expect(app.config.broker.adjustment).toBe('all');
    expect(app.store.adjustment).toBe('all');
    expect(app.store.root).toBe(barStoreRoot(app.paths.bars, 'us_equity', 'iex', 'all'));
    const fake = new FakeAlpaca();
    fake.bars.set('TLT', tage(-1, 0, 90));
    // Genau so ruft `fetch` den Backfill: Store und Bereinigung aus der App, nicht aus einer globalen Variablen.
    await backfill({ client: fake, store: app.store, symbols: ['TLT'], tf: '1Day', from: T0 - DAY, to: T0, feed: app.config.broker.feed, adjustment: app.config.broker.adjustment });
    expect(fake.barRequests[0]?.adjustment).toBe('all');
    expect(existsSync(app.store.pathFor('TLT', '1Day'))).toBe(true);
    const roh = barStoreRoot(app.paths.bars, 'us_equity', 'iex');
    expect(existsSync(roh), 'Roh-Wurzel wurde angelegt').toBe(false);
    expect(new BarStore(roh).load('TLT', '1Day')).toEqual([]);
  });

  it('bootstrap ohne den Schalter: dieselbe Wurzel wie bisher (bestehende Caches bleiben)', () => {
    const home = join(dir, 'home-raw');
    const app = bootstrap({ config: configDatei('raw.yaml', '  feed: iex\n'), env, home });
    expect(app.config.broker.adjustment).toBe('raw');
    expect(app.store.adjustment).toBe('raw');
    expect(app.store.root).toBe(join(app.paths.bars, 'us_equity', 'iex'));
  });
});
