/**
 * Bereinigte Tagesbars im Takt (Prüfbefund M7 gilt live genauso, CLAUDE.md §0.1):
 *
 *  1. `scripts/module/engineConfig.mjs` trägt `broker.adjustment` nach
 *     `meta/engineConfig`, und der Takt-Leser (`globalConfigRaw` →
 *     `buildUserConfig`) kommt mit derselben Bereinigung heraus wie
 *     config/platform.yaml — sonst misst der Optimierer bereinigt und die
 *     Engine handelt roh.
 *  2. Der Takt bildet mit `adjustment: all` eine EIGENE Cache-Wurzel
 *     (`…/iex-adj-all`), fordert die Tagesbars bereinigt an und legt keine
 *     Roh-Wurzel an; die Nutzer-Sicht (`SharedBarStoreView`) trägt dieselbe
 *     Bereinigung wie der geteilte Cache.
 *  3. Rohe und bereinigte Tagesbars mischen sich nie: Ein Backfill mit
 *     anderer Bereinigung gegen den geteilten Cache bricht ab.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs ohne Typen
import { engineConfigDocFrom } from '../../../scripts/module/engineConfig.mjs';
import { parseConfig } from '../../../src/core/config.ts';
import { addDays, DAY, MIN, msFromET, parseDay } from '../../../src/core/time.ts';
import type { Bar } from '../../../src/core/types.ts';
import { backfill } from '../../../src/data/backfill.ts';
import { barStoreRoot } from '../../../src/data/store.ts';
import { FakeAlpaca } from '../../../test/fakes/fakeAlpaca.ts';
import { CLOSE1, DAY1, OPEN1, scriptedStrategy, weekdayCalendar } from '../../../test/fakes/harness.ts';
import { buildUserConfig, globalConfigRaw } from '../../src/engine/config.ts';
import { resetSharedCaches, SharedBarStoreView, sharedStoreFor } from '../../src/engine/sharedData.ts';
import { runEngineTick, type TickDeps } from '../../src/engine/tick.ts';
import { FakeFirestore, FakeTimestamp } from '../fakes/firestore.ts';

const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const T1 = OPEN1 + 10 * MIN + 25_000;

/** Tagesbars der letzten `n` Werktage bis inkl. `bisTag` (Zeitstempel = Sitzungseröffnung ET). */
function tagesbars(n: number, bisTag: string, c = 100): Bar[] {
  const out: Bar[] = [];
  let day = bisTag;
  while (out.length < n) {
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const { y, m, d } = parseDay(day);
      out.unshift({ t: msFromET(y, m, d, 9, 30), o: c, h: c + 1, l: c - 1, c, v: 1_000 });
    }
    day = addDays(day, -1);
  }
  return out;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('meta/engineConfig trägt die Bereinigung', () => {
  it('engineConfigDocFrom ⇒ globalConfigRaw ⇒ buildUserConfig: dieselbe Bereinigung wie die Plattform-Config', () => {
    for (const adjustment of ['raw', 'all', 'split'] as const) {
      const cfg = parseConfig({ universe: { symbols: ['SPY', 'TLT'], benchmark: 'SPY' }, timeframe: 1440, broker: { adjustment } });
      const doc = engineConfigDocFrom(cfg) as Record<string, unknown>;
      const { config } = buildUserConfig(globalConfigRaw(doc), undefined);
      expect(config.broker.adjustment, adjustment).toBe(adjustment);
      expect(config.broker.feed).toBe('iex');
    }
    // Ein Doc von vor der Bereinigung (ohne das Feld) bleibt roh — kein stiller Wechsel der Datenbasis.
    expect(buildUserConfig(globalConfigRaw({ broker: { feed: 'iex' } }), undefined).config.broker.adjustment).toBe('raw');
  });
});

describe('Takt mit adjustment: all', () => {
  it('eigene Cache-Wurzel iex-adj-all, bereinigte Tagesbar-Abrufe, keine Roh-Wurzel; die Nutzer-Sicht trägt die Bereinigung', async () => {
    resetSharedCaches();
    const db = new FakeFirestore();
    db.seed('meta/engineConfig', { broker: { mode: 'paper', feed: 'iex', adjustment: 'all' }, universe: { symbols: ['AAPL'], benchmark: 'SPY' }, timeframe: 1440, engine: { barGraceSec: 4 } });
    db.seed('meta/champion', {
      version: 1,
      updatedAt: 1,
      symbols: { AAPL: { strategy: 'test_enter', params: {}, timeframe: 1440, score: 1, oos: {}, gates: [], decidedAt: 1, trials: 1, dataRange: {} } },
      noTrade: {},
    });
    db.seed('users/u1', { settings: { strategy: { engine: { running: true }, signals: { allowShort: false }, broker: { mode: 'paper' } } }, wallet: { paperBalance: 0, currency: 'USD', updatedAt: 'x' } });
    const data = new FakeAlpaca({ now: () => T1 });
    data.bars.set('AAPL', tagesbars(80, addDays(DAY1, -1)));
    data.bars.set('SPY', tagesbars(80, addDays(DAY1, -1)));
    data.calendarDays = weekdayCalendar(addDays(DAY1, -200), addDays(DAY1, 60));
    data.clock = { timestamp: T1, isOpen: true, nextOpen: OPEN1 + 24 * 60 * MIN, nextClose: CLOSE1 };
    const trading = new FakeAlpaca({ now: () => T1 });
    trading.calendarDays = data.calendarDays;
    const tmpRoot = mkdtempSync(join(tmpdir(), 'autotrd-fn-adj-'));
    dirs.push(tmpRoot);
    const deps: TickDeps = {
      db,
      dataClientFor: () => data,
      brokerZugang: async () => ({ verbindung: { mode: 'paper', schluessel: { keyId: 'PKu1', secret: 'geheim' } }, sperre: null }),
      clientFor: () => trading,
      fx: async (at) => ({ fxRate: 1.1, fxDate: at.slice(0, 10), fxSource: 'ecb' }),
      getStrategy: () => scriptedStrategy({ enterAt: 1, holdsOvernight: true }),
      tmpRoot,
      log: SILENT,
      timestampNow: () => FakeTimestamp.now(),
    };
    const r = await runEngineTick(deps, T1);
    expect(r.failed).toEqual([]);
    expect(r.users).toBe(1);
    expect(r.ok).toBe(1);
    // Jeder Tagesbar-Abruf ist bereinigt angefordert — kein einziger roh.
    const anfragen = data.barRequests;
    expect(anfragen.length).toBeGreaterThan(0);
    for (const req of anfragen) {
      expect(req.timeframe).toBe('1Day');
      expect(req.adjustment).toBe('all');
    }
    // Die geteilte Wurzel trägt die Bereinigung; die Roh-Wurzel existiert nicht.
    const adjRoot = barStoreRoot(join(tmpRoot, 'shared', 'bars'), 'us_equity', 'iex', 'all');
    const rohRoot = barStoreRoot(join(tmpRoot, 'shared', 'bars'), 'us_equity', 'iex');
    expect(adjRoot.endsWith('iex-adj-all')).toBe(true);
    expect(existsSync(adjRoot)).toBe(true);
    expect(existsSync(rohRoot)).toBe(false);
    expect(sharedStoreFor(adjRoot, 'all').load('AAPL', '1Day').length).toBeGreaterThan(0);
    expect(r.symbolsOk).toBe(2);
  });

  it('WÄCHTER: rohe und bereinigte Tagesbars mischen sich nie — Nutzer-Sicht erbt die Bereinigung, fremder Backfill bricht ab', async () => {
    resetSharedCaches();
    const tmpRoot = mkdtempSync(join(tmpdir(), 'autotrd-fn-adj-'));
    dirs.push(tmpRoot);
    const root = barStoreRoot(join(tmpRoot, 'shared', 'bars'), 'us_equity', 'iex', 'all');
    const shared = sharedStoreFor(root, 'all');
    expect(shared.adjustment).toBe('all');
    const view = new SharedBarStoreView(shared);
    expect(view.adjustment).toBe('all');
    expect(view.root).toBe(root);
    const fake = new FakeAlpaca({ now: () => T1 });
    fake.bars.set('AAPL', tagesbars(5, DAY1));
    await expect(backfill({ client: fake, store: view, symbols: ['AAPL'], tf: '1Day', from: T1 - 10 * DAY, to: T1, feed: 'iex', adjustment: 'raw' })).rejects.toThrow(/mischen/);
    await expect(backfill({ client: fake, store: shared, symbols: ['AAPL'], tf: '1Day', from: T1 - 10 * DAY, to: T1, feed: 'iex', adjustment: 'raw' })).rejects.toThrow(/mischen/);
    expect(fake.barRequests).toHaveLength(0);
    // Ein zweiter Store mit anderer Bereinigung ist eine ANDERE Wurzel — nie dieselbe Datei.
    const roh = sharedStoreFor(barStoreRoot(join(tmpRoot, 'shared', 'bars'), 'us_equity', 'iex'), 'raw');
    expect(roh.root).not.toBe(shared.root);
    expect(roh.adjustment).toBe('raw');
  });
});
