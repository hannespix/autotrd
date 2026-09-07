import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyState, Journal, type EngineState } from '../../src/core/journal.ts';
import { openPosition } from '../../src/core/logic.ts';
import { MIN } from '../../src/core/time.ts';
import type { Trade } from '../../src/core/types.ts';
import { Book } from '../../src/engine/book.ts';
import { stopClientId } from '../../src/engine/ids.ts';
import { OrderExecutor } from '../../src/engine/orders.ts';
import { BLOCKED_NOTE, reconcile } from '../../src/engine/reconcile.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';
import { DAY1, OPEN1, testConfig, tmpHome } from '../fakes/harness.ts';

const NOW = OPEN1 + 60 * MIN;

function setup(onOrphan: 'halt' | 'adopt' = 'halt') {
  const fake = new FakeAlpaca({ now: () => NOW });
  const book = new Book();
  const journal = new Journal(join(tmpHome(), 'journal.jsonl'));
  const config = testConfig({ engine: { onOrphan } });
  const state: EngineState = emptyState('paper', DAY1, 100_000);
  const notifications: string[] = [];
  const executor = new OrderExecutor({ client: fake, book, journal, mode: 'paper', assetClass: 'us_equity', timeframe: 5, holdsOvernightFor: () => true, now: () => NOW, sleep: async () => undefined });
  const run = () =>
    reconcile({
      client: fake,
      book,
      journal,
      config,
      state,
      now: NOW,
      notify: async (_l, t) => {
        notifications.push(t);
      },
      lastPriceOf: () => 99.5,
      ensureStops: () => executor.ensureProtectiveStops(),
    });
  return { fake, book, journal, state, run, notifications };
}

const bookPos = (symbol = 'AAPL', qty = 10, entryTime = NOW - 60 * MIN) =>
  openPosition({ symbol, side: 'long', qty, fillPrice: 100, fillTime: entryTime, stop: 98, target: null, strategy: 's', entryDay: DAY1 });

describe('reconcile', () => {
  it('Buch hat Position, Broker nicht ⇒ Buch bereinigt, Trade "reconcile", laut im Journal', async () => {
    const s = setup();
    s.book.open(bookPos());
    const r = await s.run();
    expect(r.missing).toEqual(['AAPL']);
    expect(r.orphans).toEqual([]);
    expect(r.haltReason).toBeNull();
    expect(s.book.positions.size).toBe(0);
    const trade = s.journal.trades()[0]!;
    expect(trade).toMatchObject<Partial<Trade>>({ symbol: 'AAPL', exitReason: 'reconcile', exitPrice: 99.5, qty: 10 });
    expect(s.journal.readAll().some((e) => e.kind === 'reconcile' && e.action === 'missing')).toBe(true);
    expect(s.notifications.some((t) => t.includes('nicht beim Broker'))).toBe(true);
    expect(r.account.equity).toBe(100_000);
  });

  it('frische Buch-Position (Fill-Latenz) wird noch nicht bereinigt', async () => {
    const s = setup();
    s.book.open(bookPos('AAPL', 10, NOW - 5_000));
    const r = await s.run();
    expect(r.missing).toEqual([]);
    expect(s.book.positions.size).toBe(1);
  });

  it('Fremdbestand mit onOrphan=halt ⇒ Halt "reconcile", der von selbst fällt, wenn der Bestand weg ist', async () => {
    const s = setup('halt');
    s.fake.setPosition('MSFT', 'long', 5, 300);
    const r = await s.run();
    expect(r.orphans).toEqual(['MSFT']);
    expect(r.haltReason).toBe('reconcile');
    expect(s.state.halt).toMatchObject({ halted: true, reason: 'reconcile' });
    expect(s.book.positions.size).toBe(0);
    expect(s.notifications.some((t) => t.includes('Fremdbestand'))).toBe(true);
    // Zweiter Lauf: Halt bleibt, wird nicht erneut ausgelöst.
    await s.run();
    expect(s.journal.readAll().filter((e) => e.kind === 'halt')).toHaveLength(1);
    s.fake.positions.delete('MSFT');
    const r3 = await s.run();
    expect(r3.haltReason).toBeNull();
    expect(s.state.halt.halted).toBe(false);
    expect(s.journal.readAll().some((e) => e.kind === 'resume')).toBe(true);
  });

  it('Fremdbestand mit onOrphan=adopt ⇒ übernommen mit Schutz-Stop 3 % unter dem Kurs, Stop beim Broker gesetzt', async () => {
    const s = setup('adopt');
    s.fake.setPosition('MSFT', 'long', 5, 300, 310);
    const r = await s.run();
    expect(r.orphans).toEqual(['MSFT']);
    expect(r.haltReason).toBeNull();
    expect(r.fixed).toEqual(['MSFT']);
    const pos = s.book.positions.get('MSFT')!;
    expect(pos).toMatchObject({ side: 'long', qty: 5, entryPrice: 300, stop: 300.7, strategy: 'adopted', entryDay: DAY1 });
    const stop = s.fake.find(stopClientId('paper', 'MSFT', pos.entryTime))!;
    expect(stop).toMatchObject({ type: 'stop', side: 'sell', qty: 5, stopPrice: 300.7, timeInForce: 'gtc' });
    expect(s.state.halt.halted).toBe(false);
  });

  it('Mengenabweichung ⇒ Broker-Menge gilt; Seitenwechsel ⇒ Buch bereinigt und Bestand als Fremdbestand', async () => {
    const s = setup('halt');
    s.book.open(bookPos('AAPL', 10));
    s.fake.setPosition('AAPL', 'long', 8, 100);
    const r = await s.run();
    expect(r.fixed).toContain('AAPL');
    expect(s.book.positions.get('AAPL')?.qty).toBe(8);
    s.fake.setPosition('AAPL', 'short', 3, 100);
    const r2 = await s.run();
    expect(r2.missing).toEqual(['AAPL']);
    expect(r2.orphans).toEqual(['AAPL']);
    expect(s.state.halt.reason).toBe('reconcile');
  });

  it('fehlender Schutz-Stop ⇒ ensureProtectiveStops setzt einen (Regel 5)', async () => {
    const s = setup();
    s.book.open(bookPos('AAPL', 10));
    s.fake.setPosition('AAPL', 'long', 10, 100);
    const r = await s.run();
    expect(r.fixed).toEqual(['AAPL']);
    const stop = s.fake.openOrders('AAPL')[0]!;
    expect(stop).toMatchObject({ type: 'stop', side: 'sell', qty: 10, stopPrice: 98 });
    expect(s.book.protectiveOrders.get('AAPL')?.orderId).toBe(stop.id);
    const r2 = await s.run();
    expect(r2.fixed).toEqual([]);
  });

  it('gesperrtes Konto ⇒ Halt "errors" (fail-closed), Freigabe hebt ihn auf', async () => {
    const s = setup();
    s.fake.account.tradingBlocked = true;
    const r = await s.run();
    expect(r.haltReason).toBe('errors');
    expect(r.account.tradingBlocked).toBe(true);
    expect(s.state.halt).toMatchObject({ halted: true, reason: 'errors', note: BLOCKED_NOTE });
    s.fake.account.tradingBlocked = false;
    await s.run();
    expect(s.state.halt.halted).toBe(false);
  });
});
