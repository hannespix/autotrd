import { describe, expect, it } from 'vitest';
import type { PositionState } from '../../../src/core/types.ts';
import type { EngineStatus } from '../../../src/engine/engine.ts';
import { engineFieldOf, mirrorError, mirrorPositions, mirrorQuotes, mirrorUser, positionDocOf } from '../../src/engine/mirror.ts';
import { FakeFirestore } from '../fakes/firestore.ts';

const NOW = Date.UTC(2026, 8, 1, 14, 0, 0);

function pos(over: Partial<PositionState> = {}): PositionState {
  return { symbol: 'AAPL', side: 'long', qty: 199, entryPrice: 100.4, entryTime: NOW - 60_000, stop: 98.36, target: 104.38, initialStop: 98.36, highWater: 100.4, strategy: 'test_enter', barsHeld: 0, entryDay: '2026-09-01', ...over };
}

function status(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    mode: 'paper',
    running: false,
    halt: { halted: false, reason: null, since: null, until: null, note: null },
    positions: [],
    pendingEntries: [],
    pendingExits: [],
    deferredIntents: [],
    protectiveOrders: {},
    lastBarAt: {},
    equity: 100_000,
    cash: 50_000.456,
    dayStartEquity: 100_000,
    peakEquity: 101_000,
    day: '2026-09-01',
    dayTradeCount: 1,
    localDayTrades: 0,
    patternDayTrader: false,
    streamStatus: { data: null, trade: null, dataLastMessageAt: null, tradeLastMessageAt: null },
    clock: null,
    consecutiveErrors: 0,
    startedAt: null,
    uptimeMs: 0,
    lastTickAt: null,
    lastReconcileAt: null,
    lastFlushAt: null,
    ...over,
  };
}

describe('Spiegel — Stufe der Position (G14)', () => {
  it('die Position trägt ihre Stufe selbst; die Wahl von heute ist nur Rückfall', () => {
    expect(positionDocOf(pos({ stufe: 'basis' }), undefined, NOW)).toMatchObject({ stufe: 'basis' });
    expect(positionDocOf(pos({ stufe: 'basis' }), undefined, NOW, 'champion')).toMatchObject({ stufe: 'basis' });
    expect(positionDocOf(pos(), undefined, NOW, 'champion')).toMatchObject({ stufe: 'champion' });
    expect('stufe' in positionDocOf(pos(), undefined, NOW)).toBe(false);
  });

  it('mirrorPositions: persistierte Stufe schlägt stufeFor — auch wenn die Wahl fehlt (Zwangs-Liquidation)', async () => {
    const db = new FakeFirestore();
    await mirrorPositions(db, 'u1', status({ positions: [pos({ stufe: 'basis' }), pos({ symbol: 'MSFT' })] }), NOW, () => undefined);
    expect(db.get('users/u1/positions/AAPL')).toMatchObject({ stufe: 'basis' });
    expect(db.get('users/u1/positions/MSFT')?.stufe).toBeUndefined();
  });
});

describe('Spiegel — Positionen', () => {
  it('schreibt das Buch im alten Schema, löscht geschlossene Docs, bildet BTC/USD auf BTC-USD ab', async () => {
    const db = new FakeFirestore();
    db.seed('users/u1/positions/OLD', { symbol: 'OLD', qty: 1 });
    db.seed('users/u1/positions/AAPL', { symbol: 'AAPL', qty: 1, avgEntry: 1 });
    const st = status({ positions: [pos(), pos({ symbol: 'BTC/USD', qty: 0.5, stop: null, initialStop: null })], protectiveOrders: { AAPL: 'atd-paper-AAPL-1-s' } });
    const r = await mirrorPositions(db, 'u1', st, NOW);
    expect(r).toEqual({ written: 2, deleted: 1 });
    expect(db.get('users/u1/positions/OLD')).toBeUndefined();
    expect(db.get('users/u1/positions/AAPL')).toMatchObject({
      symbol: 'AAPL',
      qty: 199,
      avgEntry: 100.4,
      stopLoss: 98.36,
      takeProfit: 104.38,
      openedAt: new Date(NOW - 60_000).toISOString(),
      highWater: 100.4,
      side: 'long',
      broker: true,
      schutz: { orderId: 'atd-paper-AAPL-1-s', stopPreis: 98.36, qty: 199 },
      quelle: 'engine',
    });
    const btc = db.get('users/u1/positions/BTC-USD');
    expect(btc).toMatchObject({ symbol: 'BTC/USD', qty: 0.5, stopLoss: null, schutz: null });
  });

  it('leeres Buch ⇒ alle Docs weg; nichts zu tun ⇒ kein Commit', async () => {
    const db = new FakeFirestore();
    db.seed('users/u1/positions/AAPL', { symbol: 'AAPL' });
    await mirrorPositions(db, 'u1', status(), NOW);
    expect(db.list('users/u1/positions')).toHaveLength(0);
    const commits = db.commits;
    await mirrorPositions(db, 'u1', status(), NOW);
    expect(db.commits).toBe(commits);
  });

  it('positionDocOf ohne Schutz-Stop-Kennung ⇒ schutz null', () => {
    expect(positionDocOf(pos(), undefined, NOW).schutz).toBeNull();
  });
});

describe('Spiegel — User-Doc', () => {
  it('wallet.paperBalance/updatedAt und engine per Merge; settings und übrige wallet-Felder bleiben', async () => {
    const db = new FakeFirestore();
    db.seed('users/u1', { settings: { strategy: { engine: { running: true } } }, wallet: { paperBalance: 1, currency: 'USD', resetAt: '2026-01-01', baseCapital: 25_000 }, engine: { commandAt: '2026-09-01T00:00:00.000Z', altesFeld: 1 } });
    await mirrorUser(db, 'u1', {
      mode: 'paper',
      status: status({ positions: [pos()], pendingEntries: ['MSFT'], deferredIntents: ['NVDA'], halt: { halted: true, reason: 'manual', since: 1, until: null, note: 'x' } }),
      now: NOW,
      lastError: null,
      champion: { source: 'champion', symbols: ['AAPL', 'MSFT'] },
      commandsSeen: true,
      configSource: 'legacy',
    });
    const u = db.get('users/u1')!;
    expect(u.settings).toEqual({ strategy: { engine: { running: true } } });
    expect(u.wallet).toEqual({ paperBalance: 50_000.46, currency: 'USD', resetAt: '2026-01-01', baseCapital: 25_000, updatedAt: new Date(NOW).toISOString() });
    expect(u.engine).toMatchObject({
      mode: 'paper',
      running: true,
      halt: { halted: true, reason: 'manual' },
      equity: 100_000,
      cash: 50_000.456,
      dayStartEquity: 100_000,
      peakEquity: 101_000,
      dayTradeCount: 1,
      positions: ['AAPL'],
      pendingEntries: ['MSFT'],
      deferred: ['NVDA'],
      lastTickAt: new Date(NOW).toISOString(),
      lastError: null,
      champion: { source: 'champion', symbols: ['AAPL', 'MSFT'] },
      configSource: 'legacy',
      commandAt: null,
      altesFeld: 1,
    });
  });

  it('ohne commandsSeen bleibt commandAt unangetastet', () => {
    const f = engineFieldOf({ mode: 'live', status: status(), now: NOW, lastError: null, champion: { source: 'none', symbols: [] }, commandsSeen: false });
    expect('commandAt' in f).toBe(false);
    expect(f.mode).toBe('live');
  });

  it('mirrorError setzt nur lastError/lastTickAt, Positions-Docs bleiben', async () => {
    const db = new FakeFirestore();
    db.seed('users/u1', { engine: { equity: 5 } });
    db.seed('users/u1/positions/AAPL', { symbol: 'AAPL' });
    await mirrorError(db, 'u1', 'Broker 500', NOW);
    expect(db.get('users/u1')?.engine).toEqual({ equity: 5, running: true, lastError: 'Broker 500', lastTickAt: new Date(NOW).toISOString() });
    expect(db.get('users/u1/positions/AAPL')).toBeDefined();
  });
});

describe('Spiegel — Kurse', () => {
  it('market/{symbol}.quote per Merge, vorhandene Felder bleiben; ungültige Kurse werden übersprungen', async () => {
    const db = new FakeFirestore();
    db.seed('market/AAPL', { name: 'Apple', quote: { price: 1, updatedAt: 'alt', extra: true } });
    const n = await mirrorQuotes(db, [
      { symbol: 'AAPL', price: 100.37, at: NOW },
      { symbol: 'BTC/USD', price: 60_000, at: NOW },
      { symbol: 'NIX', price: 0, at: NOW },
    ]);
    expect(n).toBe(2);
    expect(db.get('market/AAPL')).toEqual({ name: 'Apple', quote: { price: 100.37, updatedAt: new Date(NOW).toISOString(), quelle: 'engine', extra: true } });
    expect(db.get('market/BTC-USD')?.quote).toMatchObject({ price: 60_000 });
    expect(db.get('market/NIX')).toBeUndefined();
  });
});
