/**
 * Harness der Secreview-2-Gegenbeispiele (kein Test): Fake-Firestore,
 * Fake-Broker je Nutzer, Skript-Strategie — dieselbe Welt wie in
 * `functions/test/engine/tick.test.ts`, plus Hilfen zum Vorbelegen eines
 * Engine-States mit offener Position und Schutz-Stop beim Broker.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineState } from '../../../src/core/journal.ts';
import { addDays, MIN } from '../../../src/core/time.ts';
import type { OrderIntent, PositionState } from '../../../src/core/types.ts';
import { stopClientId } from '../../../src/engine/ids.ts';
import { FakeAlpaca } from '../../../test/fakes/fakeAlpaca.ts';
import { CLOSE1, DAY1, minuteBars, OPEN1, scriptedStrategy, TEN_CLOSES, weekdayCalendar } from '../../../test/fakes/harness.ts';
import { resetSharedCaches } from '../../src/engine/sharedData.ts';
import { engineStatePath } from '../../src/engine/state.ts';
import { runEngineTick, type TickDeps, type TickResult } from '../../src/engine/tick.ts';
import { FakeFirestore, FakeTimestamp } from '../fakes/firestore.ts';

/** 09:40:25 ET — Bucket 09:35 ist seit 25 s zu (Takt-Karenz mindestens 20 s, `globalConfigRaw` klemmt kleinere Werte). */
export const T1 = OPEN1 + 10 * MIN + 25_000;
export const iso = (ms: number): string => new Date(ms).toISOString();
export const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
export const USER_SETTINGS = {
  strategy: { engine: { running: true, maxPositionPct: 20, riskPerTradePct: 0.5, maxOpenPositions: 4 }, signals: { allowShort: false }, broker: { mode: 'paper' } },
};

export interface Welt {
  db: FakeFirestore;
  data: FakeAlpaca;
  trading: FakeAlpaca;
  deps: TickDeps;
  tmpRoot: string;
  run: (t: number) => Promise<TickResult>;
  aufraeumen: () => void;
}

export interface WeltOptionen {
  champion?: boolean;
  extraUsers?: Record<string, FakeAlpaca>;
  dataClient?: boolean;
  /** Order-Pfad dieser uids ist verriegelt (Echtgeld-Kette offen): Zugang mit Sperrgrund, keine Einstiege. */
  verriegelt?: string[];
  /** Diese uids haben keinen Broker (Zugang null). */
  ohneBroker?: string[];
  parallel?: number;
  userBudgetMs?: number;
}

export function welt(o: WeltOptionen = {}): Welt {
  resetSharedCaches();
  const db = new FakeFirestore();
  db.seed('meta/engineConfig', { universe: { symbols: ['AAPL'], benchmark: 'SPY' }, timeframe: 5, engine: { barGraceSec: 4, maxConsecutiveErrors: 3 } });
  if (o.champion !== false) {
    db.seed('meta/champion', {
      version: 1,
      updatedAt: 1,
      symbols: { AAPL: { strategy: 'test_enter', params: {}, timeframe: 5, score: 1, oos: {}, gates: [], decidedAt: 1, trials: 1, dataRange: {} } },
      noTrade: {},
    });
  }
  db.seed('users/u1', { settings: USER_SETTINGS, wallet: { paperBalance: 0, currency: 'USD', updatedAt: 'x' } });
  let now = T1;
  const nowFn = () => now;
  const data = new FakeAlpaca({ now: nowFn });
  data.bars.set('AAPL', minuteBars(OPEN1, TEN_CLOSES));
  data.bars.set('SPY', minuteBars(OPEN1, TEN_CLOSES));
  data.calendarDays = weekdayCalendar(addDays(DAY1, -60), addDays(DAY1, 60));
  data.clock = { timestamp: T1, isOpen: true, nextOpen: OPEN1 + 24 * 60 * MIN, nextClose: CLOSE1 };
  const trading = new FakeAlpaca({ now: nowFn });
  trading.calendarDays = data.calendarDays;
  const clients: Record<string, FakeAlpaca> = { u1: trading, ...(o.extraUsers ?? {}) };
  for (const c of Object.values(clients)) c.now = nowFn;
  const tmpRoot = mkdtempSync(join(tmpdir(), 'autotrd-secreview2-'));
  const strategy = scriptedStrategy({ enterAt: 1 });
  const verriegelt = new Set(o.verriegelt ?? []);
  const ohneBroker = new Set(o.ohneBroker ?? []);
  const deps: TickDeps = {
    db,
    dataClientFor: () => (o.dataClient === false ? null : data),
    brokerZugang: async (uid) =>
      uid in clients && !ohneBroker.has(uid)
        ? { verbindung: { mode: verriegelt.has(uid) ? 'live' : 'paper', schluessel: { keyId: `${verriegelt.has(uid) ? 'AK' : 'PK'}${uid}`, secret: 'geheim' } }, sperre: verriegelt.has(uid) ? 'Kill-Switch aktiv' : null }
        : null,
    clientFor: (v) => clients[v.schluessel.keyId.slice(2)]!,
    fx: async (at) => ({ fxRate: 1.1, fxDate: at.slice(0, 10), fxSource: 'ecb' }),
    getStrategy: (id) => {
      if (id === 'test_enter') return strategy;
      throw new Error(`unbekannte Strategie ${id}`);
    },
    tmpRoot,
    log: SILENT,
    timestampNow: () => FakeTimestamp.now(),
    ...(o.parallel !== undefined ? { parallel: o.parallel } : {}),
    ...(o.userBudgetMs !== undefined ? { userBudgetMs: o.userBudgetMs } : {}),
  };
  return {
    db,
    data,
    trading,
    deps,
    tmpRoot,
    run: (t) => {
      now = t;
      return runEngineTick(deps, t);
    },
    aufraeumen: () => rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

export const ENTRY_TIME = OPEN1 + 5 * MIN;

export function position(over: Partial<PositionState> = {}): PositionState {
  return { symbol: 'AAPL', side: 'long', qty: 199, entryPrice: 100.4, entryTime: ENTRY_TIME, stop: 98.36, target: 104.38, initialStop: 98.36, highWater: 100.4, strategy: 'test_enter', barsHeld: 1, entryDay: DAY1, ...over };
}

export type StateDoc = EngineState & { deferredIntents: Record<string, OrderIntent> };

/** Engine-State mit einer offenen Long-Position AAPL (199 @ 100.4) und bekanntem Schutz-Stop. */
export function stateMitPosition(over: Partial<StateDoc> = {}, mode: 'paper' | 'live' = 'paper'): StateDoc {
  const pos = position();
  return {
    version: 1,
    mode,
    updatedAt: ENTRY_TIME,
    day: DAY1,
    dayStartEquity: 100_000,
    peakEquity: 100_000,
    halt: { halted: false, reason: null, since: null, until: null, note: null },
    positions: { AAPL: pos },
    pendingEntries: {},
    protectiveOrders: { AAPL: stopClientId(mode, 'AAPL', ENTRY_TIME, 0) },
    consecutiveErrors: 0,
    dayTrades: {},
    lastBarAt: { AAPL: OPEN1 + 5 * MIN },
    deferredIntents: {},
    ...over,
  };
}

/** Position und passenden GTC-Schutz-Stop beim Fake-Broker anlegen (wie nach einem echten Fill). */
export async function brokerMitPosition(trading: FakeAlpaca, pos: PositionState = position(), mode: 'paper' | 'live' = 'paper'): Promise<string> {
  trading.setPosition(pos.symbol, pos.side, pos.qty, pos.entryPrice, pos.entryPrice);
  const stop = await trading.submitOrder({
    symbol: pos.symbol,
    side: pos.side === 'long' ? 'sell' : 'buy',
    qty: pos.qty,
    type: 'stop',
    timeInForce: 'gtc',
    clientOrderId: stopClientId(mode, pos.symbol, pos.entryTime, 0),
    stopPrice: pos.stop ?? 98.36,
  });
  return stop.id;
}

export function stateDoc(db: FakeFirestore, uid = 'u1'): StateDoc | undefined {
  return db.get(engineStatePath(uid)) as StateDoc | undefined;
}

export function engineSpiegel(db: FakeFirestore, uid = 'u1'): Record<string, unknown> {
  return (db.get(`users/${uid}`)?.engine ?? {}) as Record<string, unknown>;
}

export { engineStatePath };
