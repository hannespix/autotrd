/**
 * Voller Takt gegen Fake-Firestore und Fake-Broker: Bars kommen vom
 * Plattform-Client in den geteilten Cache, die Nutzer-Engine entscheidet
 * mit der Skript-Strategie, die Bracket-Order landet beim Trading-Fake,
 * State/Journal/Spiegel/Herzschlag stehen in Firestore.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bewerteHerzschlag } from '../../../shared/src/wachhund.ts';
import { addDays, MIN } from '../../../src/core/time.ts';
import { entryClientId } from '../../../src/engine/ids.ts';
import { FakeAlpaca } from '../../../test/fakes/fakeAlpaca.ts';
import { CLOSE1, DAY1, minuteBars, OPEN1, scriptedStrategy, TEN_CLOSES, weekdayCalendar } from '../../../test/fakes/harness.ts';
import { commandsPath } from '../../src/engine/commands.ts';
import { resetSharedCaches } from '../../src/engine/sharedData.ts';
import { engineStatePath } from '../../src/engine/state.ts';
import { HEALTH_PATH, LEASE_PATH, runEngineTick, uidKurz, type TickDeps, type TickResult } from '../../src/engine/tick.ts';
import { FakeFirestore, FakeTimestamp } from '../fakes/firestore.ts';

/** 09:40:25 ET — Bucket 09:35 ist seit 25 s zu (Takt-Karenz mindestens 20 s, `globalConfigRaw` klemmt kleinere Werte). */
const T1 = OPEN1 + 10 * MIN + 25_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const USER_SETTINGS = { strategy: { engine: { running: true, maxPositionPct: 20, riskPerTradePct: 0.5, maxOpenPositions: 4 }, signals: { allowShort: false }, broker: { mode: 'paper' } } };

interface World {
  db: FakeFirestore;
  data: FakeAlpaca;
  trading: FakeAlpaca;
  deps: TickDeps;
  tmpRoot: string;
  run: (t: number) => Promise<TickResult>;
}

const worlds: World[] = [];

function world(o: { champion?: boolean; extraUsers?: Record<string, FakeAlpaca>; dataClient?: boolean } = {}): World {
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
  db.seed('users/u2', { settings: { strategy: { engine: { running: false } } } });
  db.seed('users/u3', { accessLevel: 'blocked', settings: { strategy: { engine: { running: true } } } });
  db.seed('users/u4', { settings: { strategy: { engine: { running: true } } } });
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
  const tmpRoot = mkdtempSync(join(tmpdir(), 'autotrd-fn-'));
  const strategy = scriptedStrategy({ enterAt: 1 });
  const deps: TickDeps = {
    db,
    dataClientFor: () => (o.dataClient === false ? null : data),
    brokerZugang: async (uid) => (uid in clients ? { verbindung: { mode: 'paper', schluessel: { keyId: `PK${uid}`, secret: 'geheim' } }, sperre: null } : null),
    clientFor: (v) => clients[v.schluessel.keyId.slice(2)]!,
    fx: async (at) => ({ fxRate: 1.1, fxDate: at.slice(0, 10), fxSource: 'ecb' }),
    getStrategy: (id) => {
      if (id === 'test_enter') return strategy;
      throw new Error(`unbekannte Strategie ${id}`);
    },
    tmpRoot,
    log: SILENT,
    timestampNow: () => FakeTimestamp.now(),
  };
  const w: World = {
    db,
    data,
    trading,
    deps,
    tmpRoot,
    run: (t) => {
      now = t;
      return runEngineTick(deps, t);
    },
  };
  worlds.push(w);
  return w;
}

function health(w: World) {
  const h = w.db.get(HEALTH_PATH)!;
  return {
    doc: h,
    urteil: bewerteHerzschlag({
      jetztMs: T1 + 60_000,
      lastRunAt: h.lastRunAt as string,
      lastRunSkipped: h.lastRunSkipped as string | null,
      symbolsOk: h.symbolsOk as number | undefined,
      symbolsFailed: h.symbolsFailed as number | undefined,
    }),
  };
}

afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.tmpRoot, { recursive: true, force: true });
});

describe('Engine-Takt — voller Lauf', () => {
  it('erster Takt: Bracket-Order beim Broker, State-Doc, Spiegel, Herzschlag ok; zweiter Takt ohne neue Bar sendet nichts', async () => {
    const w = world();
    const r = await w.run(T1);
    expect(r.skipped).toBeNull();
    expect(r.users).toBe(1);
    expect(r.ok).toBe(1);
    expect(r.failed).toEqual([]);
    expect(r.skippedUsers).toEqual(expect.arrayContaining([{ uid: 'u3', reason: 'zugang' }, { uid: 'u4', reason: 'kein_broker' }]));
    expect(r.fetchOk).toBe(true);
    expect(r.symbolsOk).toBe(2);
    expect(r.symbolsFailed).toBe(0);

    // Order beim Trading-Fake: Bracket mit bucket-stabiler Kennung, gerundete Beine
    expect(w.trading.callsOf('submitOrder')).toHaveLength(1);
    const parent = w.trading.ordersFor('AAPL').find((o) => o.orderClass === 'bracket')!;
    expect(parent.clientOrderId).toBe(entryClientId('paper', 'AAPL', OPEN1 + 10 * MIN));
    expect(parent.qty).toBe(199);
    expect(parent.legs.map((l) => l.type).sort()).toEqual(['limit', 'stop']);

    // Keine Datenaufrufe je Nutzer — Bars, Uhr, Kalender, Stammdaten nur über den Plattform-Client
    expect(w.trading.callsOf('getBars')).toHaveLength(0);
    expect(w.trading.callsOf('getClock')).toHaveLength(0);
    expect(w.trading.callsOf('getCalendar')).toHaveLength(0);
    expect(w.trading.callsOf('getAsset')).toHaveLength(0);
    expect(w.data.callsOf('getBars').length).toBeGreaterThan(0);
    expect(w.data.callsOf('getClock')).toHaveLength(1);
    expect(w.data.callsOf('submitOrder')).toHaveLength(0);

    // State-Doc in Firestore
    const state = w.db.get(engineStatePath('u1'))!;
    expect(state.mode).toBe('paper');
    expect((state.pendingEntries as Record<string, string>).AAPL).toBe(parent.clientOrderId);
    expect((state.lastBarAt as Record<string, number>).AAPL).toBe(OPEN1 + 5 * MIN);

    // Spiegel
    const u1 = w.db.get('users/u1')!;
    expect(u1.settings).toEqual(USER_SETTINGS);
    expect(u1.engine).toMatchObject({
      mode: 'paper',
      running: true,
      equity: 100_000,
      pendingEntries: ['AAPL'],
      deferred: [],
      lastError: null,
      lastTickAt: iso(T1),
      champion: { source: 'champion', symbols: ['AAPL'] },
      configSource: 'legacy',
      commandAt: null,
      halt: { halted: false },
    });
    expect((u1.wallet as Record<string, unknown>).paperBalance).toBe(100_000);
    expect(w.db.get('market/AAPL')?.quote).toMatchObject({ price: 100.37, updatedAt: iso(OPEN1 + 10 * MIN) });
    expect(w.db.get('market/SPY')?.quote).toBeDefined();
    expect(w.db.list('users/u1/positions')).toHaveLength(0);

    // Journal: Order, keine Takt-Rauschen-Docs
    const kinds = w.db.list('users/u1/journal').map((d) => d.data.kind);
    expect(kinds).toContain('order_submitted');
    expect(kinds).not.toContain('start');
    expect(kinds).not.toContain('stop');

    // Herzschlag: bewerteHerzschlag sagt ok; Lease wieder frei
    const { doc, urteil } = health(w);
    expect(urteil.ok).toBe(true);
    expect(doc).toMatchObject({ lastRunAt: iso(T1), lastRunSkipped: null, symbolsOk: 2, symbolsFailed: 0 });
    expect(doc.engine).toMatchObject({ users: 1, ok: 1, failed: [], fetchOk: true, symbols: 2 });
    expect(w.db.get(LEASE_PATH)).toMatchObject({ until: 0, holder: null });

    // Zweiter Takt im selben Bucket: dieselbe Kennung, nichts Neues beim Broker
    const r2 = await w.run(T1 + 1_000);
    expect(r2.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(1);
    expect(w.db.list('users/u1/journal').filter((d) => d.data.kind === 'order_submitted')).toHaveLength(1);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ lastTickAt: iso(T1 + 1_000), pendingEntries: ['AAPL'] });
  });

  it('Fill ⇒ Positions-Spiegel mit Schutz-Stop; Stop-Fill ⇒ Trade-Docs im alten Schema (FX eingefroren), Positions-Doc gelöscht', async () => {
    const w = world();
    await w.run(T1);
    const parent = w.trading.ordersFor('AAPL').find((o) => o.orderClass === 'bracket')!;
    w.trading.fill(parent.id, 100.4);

    await w.run(T1 + 60_000);
    expect(w.db.get('users/u1/positions/AAPL')).toMatchObject({
      symbol: 'AAPL',
      qty: 199,
      avgEntry: 100.4,
      stopLoss: 98.36,
      takeProfit: 104.38,
      side: 'long',
      broker: true,
      schutz: { orderId: `leg-${parent.id}-sl`, stopPreis: 98.36, qty: 199 },
      quelle: 'engine',
    });
    expect(w.db.get('users/u1')?.engine).toMatchObject({ positions: ['AAPL'], pendingEntries: [] });
    expect((w.db.get(engineStatePath('u1'))?.positions as Record<string, unknown>).AAPL).toMatchObject({ qty: 199, entryPrice: 100.4 });

    w.trading.fill(`${parent.id}-sl`, 98.3);
    await w.run(T1 + 120_000);
    expect(w.db.get('users/u1/positions/AAPL')).toBeUndefined();
    const trades = w.db.list('users/u1/trades').map((d) => d.data);
    expect(trades).toHaveLength(2);
    const buy = trades.find((t) => t.side === 'buy')!;
    const sell = trades.find((t) => t.side === 'sell')!;
    expect(buy).toMatchObject({ symbol: 'AAPL', qty: 199, price: 100.4, source: 'engine', paper: true, currency: 'USD', fxRate: 1.1, fxSource: 'ecb', strategy: 'test_enter' });
    expect(sell).toMatchObject({ symbol: 'AAPL', qty: 199, price: 98.3, riskExit: 'stop_loss', exitReason: 'stop', entryPrice: 100.4, acquiredAt: iso(T1), fxRate: 1.1, preisQuelle: 'broker' });
    // Netto nach Kostenmodell (Secreview 2, M10): brutto −417,90 $, SEC-Gebühr + FINRA TAF auf den Verkauf ≈ 0,58 $.
    expect(sell.pnl).toBeCloseTo(-418.48, 2);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ positions: [], pendingEntries: [], lastError: null });
    expect(w.db.list('users/u1/journal').some((d) => d.data.kind === 'trade_closed')).toBe(true);
  });

  it('Lease: ein zweiter Takt innerhalb der Frist wird übersprungen — kein Broker-Kontakt, Herzschlag lastRunSkipped=lease', async () => {
    const w = world();
    w.db.seed(LEASE_PATH, { until: T1 + 60_000, holder: 'anderer' });
    const r = await w.run(T1);
    expect(r.skipped).toBe('lease');
    expect(w.trading.callsOf('getAccount')).toHaveLength(0);
    expect(w.data.callsOf('getBars')).toHaveLength(0);
    expect(w.db.get(HEALTH_PATH)).toMatchObject({ lastRunAt: iso(T1), lastRunSkipped: 'lease' });
    expect(w.db.get(LEASE_PATH)?.holder).toBe('anderer');

    const r2 = await w.run(T1 + 61_000);
    expect(r2.skipped).toBeNull();
    expect(r2.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(1);
    expect(w.db.get(LEASE_PATH)).toMatchObject({ until: 0, holder: null });
  });

  it('Marktzeit-Gate: Aktienmarkt zu ⇒ nur Herzschlag; ein Kommando-Marker lässt den Nutzer trotzdem laufen', async () => {
    const w = world();
    w.data.clock = { timestamp: T1, isOpen: false, nextOpen: OPEN1 + 24 * 60 * MIN, nextClose: CLOSE1 + 24 * 60 * MIN };
    const r = await w.run(T1);
    expect(r.skipped).toBe('market_closed');
    expect(w.trading.callsOf('getAccount')).toHaveLength(0);
    expect(w.data.callsOf('getBars')).toHaveLength(0);
    expect(w.db.get(HEALTH_PATH)).toMatchObject({ lastRunSkipped: 'market_closed' });
    expect(w.db.get(engineStatePath('u1'))).toBeUndefined();

    await w.db.doc('users/u1').set({ engine: { commandAt: iso(T1) } }, { merge: true });
    w.db.seed(commandsPath('u1'), { halt: { at: iso(T1), reason: 'Nacht' } });
    const r2 = await w.run(T1 + 60_000);
    expect(r2.skipped).toBeNull();
    expect(r2.users).toBe(1);
    expect(r2.ok).toBe(1);
    expect(w.trading.callsOf('getAccount').length).toBeGreaterThan(0);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ commandAt: null, halt: { halted: true, reason: 'manual' } });
    expect(w.db.get(commandsPath('u1'))).toBeUndefined();
  });

  it('kein Champion ⇒ keine Einstiege, Notiz im Journal, Herzschlag trotzdem ok', async () => {
    const w = world({ champion: false });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    const texte = w.db.list('users/u1/journal').map((d) => String(d.data.text ?? ''));
    expect(texte.some((t) => t.includes('kein Champion'))).toBe(true);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ champion: { source: 'none', symbols: [] } });
    expect(health(w).urteil.ok).toBe(true);
  });

  it('halt-Kommando sperrt Einstiege über Takte hinweg (keine HALT-Datei); nach resume handelt die nächste Bar', async () => {
    const w = world();
    w.db.seed(commandsPath('u1'), { halt: { at: iso(T1), reason: 'Wartung' } });
    await w.run(T1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ halt: { halted: true, reason: 'manual' } });
    expect(w.db.get(commandsPath('u1'))).toBeUndefined();

    await w.run(T1 + 60_000);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ halt: { halted: true, reason: 'manual' } });

    w.db.seed(commandsPath('u1'), { resume: { at: iso(T1 + 90_000) } });
    await w.run(T1 + 120_000);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ halt: { halted: false } });

    // Nächster Bucket (09:40–09:45) schließt ⇒ Einstieg mit der Kennung dieses Buckets
    const more = [...TEN_CLOSES, 100.5, 100.6, 100.7, 100.8, 100.9];
    w.data.bars.set('AAPL', minuteBars(OPEN1, more));
    w.data.bars.set('SPY', minuteBars(OPEN1, more));
    await w.run(OPEN1 + 15 * MIN + 25_000);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(1);
    expect(w.trading.ordersFor('AAPL')[0]?.clientOrderId).toBe(entryClientId('paper', 'AAPL', OPEN1 + 15 * MIN));
    const texte = w.db.list('users/u1/journal').map((d) => String(d.data.text ?? ''));
    expect(texte.some((t) => t.startsWith('Kommando halt'))).toBe(true);
    expect(texte.some((t) => t.startsWith('Kommando resume'))).toBe(true);
  });

  it('Fehler je Nutzer: Broker-Fehler ⇒ failed (uid im öffentlichen Health nur gehasht), lastError im Spiegel, andere Nutzer laufen', async () => {
    const broken = new FakeAlpaca();
    broken.throwOn('getAccount', new Error('Alpaca HTTP 500'));
    const w = world({ extraUsers: { u5: broken } });
    w.db.seed('users/u5', { settings: { strategy: { engine: { running: true } } } });
    const r = await w.run(T1);
    expect(r.users).toBe(2);
    expect(r.ok).toBe(1);
    expect(r.failed).toEqual([{ uid: 'u5', error: expect.stringContaining('Alpaca HTTP 500') }]);
    const h = w.db.get(HEALTH_PATH)!;
    // Öffentliches Health-Doc: nur der Hash, kein Fehlertext (Secreview 2, M1) — der Fehler steht privat im Spiegel.
    const failed = (h.engine as { failed: Array<{ uid: string; error?: string }> }).failed;
    expect(failed).toEqual([{ uid: uidKurz('u5') }]);
    expect(uidKurz('u5')).toHaveLength(10);
    expect(JSON.stringify(h)).not.toContain('"u5"');
    expect(w.db.get('users/u5')?.engine).toMatchObject({ running: true, lastError: expect.stringContaining('Alpaca HTTP 500') });
    expect(w.db.list('users/u5/positions')).toHaveLength(0);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ lastError: null });
    expect(w.trading.callsOf('submitOrder')).toHaveLength(1);
  });

  it('ungültige Nutzer-Config ⇒ Nutzer übersprungen mit Fehler, kein Broker-Kontakt', async () => {
    const w = world();
    await w.db.doc('users/u1').set({ settings: { auto: { maxPositions: 0 } } }, { merge: true });
    const r = await w.run(T1);
    expect(r.users).toBe(0);
    expect(r.failed).toEqual([{ uid: 'u1', error: expect.stringContaining('risk.maxPositions') }]);
    expect(w.trading.callsOf('getAccount')).toHaveLength(0);
    expect(w.db.get('users/u1')?.engine).toMatchObject({ lastError: expect.stringContaining('Config') });
  });

  it('ohne Plattform-Datenkey: Engines laufen (Exits/Abgleich), aber keine Einstiege — Datenfrische fehlt', async () => {
    const w = world({ dataClient: false });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(r.fetchOk).toBe(false);
    expect(r.symbolsOk).toBe(0);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(w.trading.callsOf('getAccount').length).toBeGreaterThan(0);
    expect(w.db.get(HEALTH_PATH)?.engine).toMatchObject({ fetchOk: false });
  });
});
