import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaError, type AlpacaOrder } from '../../src/alpaca/types.ts';
import { emptyState, Journal } from '../../src/core/journal.ts';
import { MIN } from '../../src/core/time.ts';
import type { AssetClass, OrderIntent, Trade } from '../../src/core/types.ts';
import { Book } from '../../src/engine/book.ts';
import { entryClientId, exitClientId, stopClientId } from '../../src/engine/ids.ts';
import { OrderExecutor, cryptoStopLimitFor, fallbackStopFor, roundQtyFor, roundStopFor, roundTargetFor } from '../../src/engine/orders.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';
import { OPEN1, tmpHome } from '../fakes/harness.ts';

const T = OPEN1 + 10 * MIN + 5_000;

function setup(o: { assetClass?: AssetClass; holdsOvernight?: boolean; book?: Book; fake?: FakeAlpaca } = {}) {
  const assetClass = o.assetClass ?? 'us_equity';
  let now = T;
  const fake = o.fake ?? new FakeAlpaca({ assetClass, now: () => now });
  fake.now = () => now;
  const book = o.book ?? new Book();
  const journal = new Journal(join(tmpHome(), 'journal.jsonl'));
  const sleeps: number[] = [];
  const executor = new OrderExecutor({
    client: fake,
    book,
    journal,
    mode: 'paper',
    assetClass,
    timeframe: 5,
    holdsOvernightFor: () => o.holdsOvernight ?? false,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    strategyIdFor: () => 'restored',
  });
  return { fake, book, journal, executor, sleeps, setNow: (ms: number) => (now = ms), now: () => now };
}

const enter = (over: Partial<Extract<OrderIntent, { kind: 'enter' }>> = {}): OrderIntent => ({
  kind: 'enter',
  symbol: 'AAPL',
  side: 'long',
  qty: 199,
  stop: 98.3626,
  target: 104.3848,
  refPrice: 100.37,
  reason: 'test',
  strategy: 'test_enter',
  decidedAt: T,
  ...over,
});
const exit = (reason: 'signal' | 'eod' | 'kill_switch' = 'signal'): OrderIntent => ({ kind: 'exit', symbol: 'AAPL', reason, decidedAt: T });

async function filledEntry(s: ReturnType<typeof setup>, price = 100.4): Promise<AlpacaOrder> {
  await s.executor.execute([enter()]);
  const parent = s.fake.ordersFor('AAPL')[0]!;
  const u = s.fake.fill(parent.id, price);
  await s.executor.handleTradeUpdate(u);
  return s.fake.find(parent.id)!;
}

describe('Rundung', () => {
  it('Stops vom Kurs weg, Ziele zum Kurs hin, Sub-Dollar mit vier Stellen', () => {
    expect(roundStopFor(98.3626, 'long')).toBe(98.36);
    expect(roundStopFor(102.3746, 'short')).toBe(102.38);
    expect(roundTargetFor(104.3848, 'long')).toBe(104.38);
    expect(roundTargetFor(96.3552, 'short')).toBe(96.36);
    expect(roundStopFor(0.123456, 'long')).toBe(0.1234);
    expect(roundStopFor(0.123456, 'short')).toBe(0.1235);
    expect(roundStopFor(98.36, 'long')).toBe(98.36); // Gleitkomma-Rauschen kostet keinen Cent
    expect(roundQtyFor(0.12345678, 'crypto')).toBe(0.1234);
    expect(roundQtyFor(199.9, 'us_equity')).toBe(199);
    expect(cryptoStopLimitFor(100, 'long')).toBe(99);
    expect(fallbackStopFor(100, 'long')).toBe(97);
    expect(fallbackStopFor(100, 'short')).toBe(103);
  });
});

describe('OrderExecutor — Einstieg', () => {
  it('sendet eine Bracket-Marktorder und ist über die Kennung idempotent', async () => {
    const s = setup();
    const first = await s.executor.execute([enter()]);
    const second = await s.executor.execute([enter()]);
    expect(s.fake.callsOf('submitOrder')).toHaveLength(1);
    expect(first[0]?.ok).toBe(true);
    expect(second[0]?.ok).toBe(true);
    expect(second[0]?.note).toMatch(/bereits offen/);
    const o = s.fake.ordersFor('AAPL')[0]!;
    expect(o.clientOrderId).toBe(entryClientId('paper', 'AAPL', OPEN1 + 10 * MIN));
    expect(o.legs.map((l) => [l.type, l.stopPrice, l.limitPrice])).toEqual([
      ['stop', 98.36, null],
      ['limit', null, 104.38],
    ]);
    // Zweiter Executor (Neustart ohne Pending) ⇒ Broker kennt die Kennung ⇒ nicht erneut senden.
    const submitsBefore = s.fake.callsOf('submitOrder').length;
    const s2 = setup({ fake: s.fake });
    const res = await s2.executor.execute([enter()]);
    expect(res[0]?.note).toMatch(/existiert bereits/);
    expect(s2.fake.callsOf('submitOrder')).toHaveLength(submitsBefore);
    expect(s2.book.pendingEntries.get('AAPL')?.clientId).toBe(o.clientOrderId);
  });

  it('Short: Stop aufgerundet, Ziel aufgerundet; ohne Ziel kein takeProfit', async () => {
    const s = setup({ holdsOvernight: true });
    await s.executor.execute([enter({ side: 'short', stop: 102.3746, target: 96.3552 }), enter({ symbol: 'MSFT', target: null })]);
    const aapl = s.fake.ordersFor('AAPL')[0]!;
    expect(aapl.side).toBe('sell');
    expect(aapl.timeInForce).toBe('gtc');
    expect(aapl.legs.map((l) => [l.type, l.stopPrice, l.limitPrice])).toEqual([
      ['stop', 102.38, null],
      ['limit', null, 96.36],
    ]);
    const msft = s.fake.ordersFor('MSFT')[0]!;
    expect(msft.legs.map((l) => l.type)).toEqual(['stop']);
  });

  it('Teilfill: Position mit gefüllter Menge, Pending bleibt bis zur Vollständigkeit', async () => {
    const s = setup();
    await s.executor.execute([enter()]);
    const parent = s.fake.ordersFor('AAPL')[0]!;
    await s.executor.handleTradeUpdate(s.fake.fill(parent.id, 100.4, 100));
    expect(s.book.positions.get('AAPL')?.qty).toBe(100);
    expect(s.book.pendingEntries.has('AAPL')).toBe(true);
    await s.executor.handleTradeUpdate(s.fake.fill(parent.id, 100.6, 99));
    const pos = s.book.positions.get('AAPL')!;
    expect(pos.qty).toBe(199);
    expect(pos.entryPrice).toBeCloseTo((100 * 100.4 + 99 * 100.6) / 199);
    expect(s.book.pendingEntries.has('AAPL')).toBe(false);
    expect(s.book.protectiveOrders.get('AAPL')?.orderId).toBe(`${parent.id}-sl`);
  });

  it('abgelehnter Einstieg ⇒ Pending weg, kein Buch-Eintrag', async () => {
    const s = setup();
    await s.executor.execute([enter()]);
    const parent = s.fake.find(entryClientId('paper', 'AAPL', OPEN1 + 10 * MIN))!;
    parent.status = 'rejected';
    await s.executor.handleTradeUpdate({ event: 'rejected', order: { ...parent, legs: [] }, price: null, qty: null, positionQty: 0, timestamp: T, executionId: null });
    expect(s.book.pendingEntries.size).toBe(0);
    expect(s.book.positions.size).toBe(0);
  });

  it('Neustart: syncOrders rekonstruiert Stop/Ziel aus den Beinen und nimmt die Strategie-ID aus strategyIdFor', async () => {
    const s = setup();
    await s.executor.execute([enter()]);
    const parent = s.fake.ordersFor('AAPL')[0]!;
    s.fake.fill(parent.id, 100.4);
    const state = { ...emptyState('paper', '2026-09-01', 100_000), ...s.book.toState() };
    const restored = Book.fromState(state);
    expect(restored.pendingEntries.get('AAPL')?.intent).toBeNull();
    const s2 = setup({ book: restored, fake: s.fake });
    await s2.executor.syncOrders();
    const pos = restored.positions.get('AAPL')!;
    expect(pos).toMatchObject({ qty: 199, entryPrice: 100.4, stop: 98.36, target: 104.38, strategy: 'restored' });
    expect(restored.pendingEntries.size).toBe(0);
  });
});

describe('OrderExecutor — Exit', () => {
  it('Reihenfolge: Beine stornieren → warten → Marktorder mit Exit-Kennung; Fill schließt den Trade mit Intent-Grund', async () => {
    const s = setup();
    const parent = await filledEntry(s);
    const before = s.fake.calls.length;
    const res = await s.executor.execute([exit('signal')]);
    expect(res[0]?.ok).toBe(true);
    const calls = s.fake.calls.slice(before).map((c) => c.method);
    const cancels = calls.map((m, i) => (m === 'cancelOrder' ? i : -1)).filter((i) => i >= 0);
    const submit = calls.indexOf('submitOrder');
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe('listOrders');
    expect(Math.max(...cancels)).toBeLessThan(submit);
    expect(calls.slice(Math.max(...cancels) + 1, submit)).toContain('listOrders'); // warten = erneut listen
    expect(s.fake.find(`${parent.id}-sl`)?.status).toBe('canceled');
    expect(s.fake.find(`${parent.id}-tp`)?.status).toBe('canceled');
    const pos = s.book.positions.get('AAPL')!;
    const exitOrder = s.fake.find(exitClientId('paper', 'AAPL', pos.entryTime))!;
    expect(exitOrder).toMatchObject({ side: 'sell', qty: 199, type: 'market', timeInForce: 'day' });
    expect(s.book.pendingExits.get('AAPL')?.orderId).toBe(exitOrder.id);
    // Idempotenz: zweiter Exit-Intent sendet nichts Neues.
    await s.executor.execute([exit('signal')]);
    expect(s.fake.callsOf('submitOrder')).toHaveLength(2);
    await s.executor.handleTradeUpdate(s.fake.fill(exitOrder.id, 101));
    const trades = s.journal.trades();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject<Partial<Trade>>({ exitReason: 'signal', exitPrice: 101, qty: 199 });
    expect(s.book.positions.size).toBe(0);
    expect(s.book.pendingExits.size).toBe(0);
  });

  it('wartet auf pending_cancel, bevor die Marktorder geht', async () => {
    const s = setup();
    await filledEntry(s);
    s.fake.cancelDelayPolls = 2;
    const res = await s.executor.execute([exit('eod')]);
    expect(res[0]?.ok).toBe(true);
    expect(s.sleeps.length).toBeGreaterThanOrEqual(1);
    expect(s.fake.callsOf('submitOrder')).toHaveLength(2);
    expect(s.fake.openOrders('AAPL').every((o) => o.type === 'market')).toBe(true);
  });

  it('Cancel-422 mit gefülltem Bein ⇒ Trade "stop" gebucht, KEIN Verkauf', async () => {
    const s = setup();
    const parent = await filledEntry(s);
    // Das Stop-Bein füllt genau in dem Moment, in dem der Storno rausgeht ⇒ Alpaca antwortet 422.
    s.fake.onCall('cancelOrder', () => {
      s.fake.fill(`${parent.id}-sl`, 98.3);
    });
    const res = await s.executor.execute([exit('signal')]);
    expect(res[0]?.ok).toBe(true);
    expect(res[0]?.note).toMatch(/kein Verkauf/);
    expect(s.fake.callsOf('submitOrder')).toHaveLength(1);
    expect(s.fake.positions.has('AAPL')).toBe(false);
    expect(s.book.positions.size).toBe(0);
    const t = s.journal.trades()[0]!;
    expect(t.exitReason).toBe('stop');
    expect(t.exitPrice).toBe(98.3);
  });

  it('Bein schon VOR dem Listen gefüllt (kein Storno-422 möglich) ⇒ trotzdem kein Verkauf', async () => {
    const s = setup();
    const parent = await filledEntry(s);
    s.fake.fill(`${parent.id}-tp`, 104.38); // ohne Stream-Ereignis — das Buch weiß noch nichts
    const res = await s.executor.execute([exit('signal')]);
    expect(res[0]?.note).toMatch(/kein Verkauf/);
    expect(s.fake.callsOf('submitOrder')).toHaveLength(1);
    expect(s.journal.trades()[0]?.exitReason).toBe('target');
    expect(s.book.positions.size).toBe(0);
  });

  it('Teilfill beim Schließen: nur der gefüllte Teil wird gebucht, Rest bleibt im Buch', async () => {
    const s = setup();
    await filledEntry(s);
    await s.executor.execute([exit('signal')]);
    const exitOrder = s.fake.openOrders('AAPL')[0]!;
    await s.executor.handleTradeUpdate(s.fake.fill(exitOrder.id, 101, 50));
    expect(s.book.positions.get('AAPL')?.qty).toBe(149);
    expect(s.journal.trades()[0]).toMatchObject({ qty: 50, exitPrice: 101 });
    await s.executor.handleTradeUpdate(s.fake.fill(exitOrder.id, 101.5));
    expect(s.book.positions.size).toBe(0);
    expect(s.journal.trades()).toHaveLength(2);
    expect(s.journal.trades()[1]?.qty).toBe(149);
  });

  it('gescheiterter Exit wird beim nächsten Wiederholungsaufruf erneut versucht', async () => {
    const s = setup();
    await filledEntry(s);
    s.fake.throwOn('submitOrder', new AlpacaError('Alpaca 503', 503, null, true), 1);
    const res = await s.executor.execute([exit('signal')]);
    expect(res[0]?.ok).toBe(false);
    expect(s.book.pendingExits.get('AAPL')?.lastError).toMatch(/503/);
    expect(await s.executor.retryPendingExits()).toHaveLength(0); // gedrosselt
    s.setNow(T + 6_000);
    const retry = await s.executor.retryPendingExits();
    expect(retry[0]?.ok).toBe(true);
    expect(s.fake.openOrders('AAPL').some((o) => o.type === 'market' && o.side === 'sell')).toBe(true);
  });

  it('flattenAll: alles stornieren, alles schließen, Trades mit dem Grund buchen', async () => {
    const s = setup();
    await filledEntry(s);
    await s.executor.flattenAll('kill_switch');
    expect(s.fake.callsOf('cancelAllOrders')).toHaveLength(1);
    expect(s.fake.callsOf('closeAllPositions')).toHaveLength(1);
    expect(s.fake.positions.size).toBe(0);
    expect(s.book.positions.size).toBe(0);
    expect(s.journal.trades()[0]?.exitReason).toBe('kill_switch');
  });
});

describe('OrderExecutor — Stops', () => {
  it('move_stop ⇒ replaceOrder mit gerundetem stop_price, Buch aktualisiert', async () => {
    const s = setup();
    const parent = await filledEntry(s);
    const res = await s.executor.execute([{ kind: 'move_stop', symbol: 'AAPL', stop: 99.1234, reason: 'trail', decidedAt: T }]);
    expect(res[0]?.ok).toBe(true);
    const call = s.fake.callsOf('replaceOrder')[0]!;
    expect(call.args[0]).toBe(`${parent.id}-sl`);
    expect(call.args[1]).toEqual({ stopPrice: 99.12 });
    expect(s.book.positions.get('AAPL')?.stop).toBe(99.12);
    expect(s.book.positions.get('AAPL')?.initialStop).toBe(98.36);
    const prot = s.book.protectiveOrders.get('AAPL')!;
    expect(prot.orderId).not.toBe(`${parent.id}-sl`);
    expect(s.fake.find(prot.orderId!)?.stopPrice).toBe(99.12);
    expect(s.fake.find(`${parent.id}-sl`)?.status).toBe('replaced');
    // Gleiche Marke erneut ⇒ kein zweites Replace.
    await s.executor.execute([{ kind: 'move_stop', symbol: 'AAPL', stop: 99.12, reason: 'trail', decidedAt: T }]);
    expect(s.fake.callsOf('replaceOrder')).toHaveLength(1);
  });

  it('Replace scheitert ⇒ Storno + eigene Stop-Order mit Stop-Kennung', async () => {
    const s = setup();
    const parent = await filledEntry(s);
    s.fake.throwOn('replaceOrder', new AlpacaError('Alpaca 422: not replaceable', 422, null, false), 1);
    const res = await s.executor.execute([{ kind: 'move_stop', symbol: 'AAPL', stop: 99.5, reason: 'trail', decidedAt: T }]);
    expect(res[0]?.ok).toBe(true);
    expect(s.fake.find(`${parent.id}-sl`)?.status).toBe('canceled');
    const pos = s.book.positions.get('AAPL')!;
    const stop = s.fake.find(stopClientId('paper', 'AAPL', pos.entryTime))!;
    expect(stop).toMatchObject({ type: 'stop', side: 'sell', qty: 199, stopPrice: 99.5, timeInForce: 'gtc' });
    expect(pos.stop).toBe(99.5);
  });

  it('ensureProtectiveStops setzt einen fehlenden Stop (einmal) und lässt Positionen ohne Broker-Bestand in Ruhe', async () => {
    const s = setup();
    const parent = await filledEntry(s);
    s.fake.orders.delete(`${parent.id}-sl`);
    s.fake.orders.delete(`${parent.id}-tp`);
    s.book.protectiveOrders.delete('AAPL');
    expect(await s.executor.ensureProtectiveStops()).toEqual(['AAPL']);
    const pos = s.book.positions.get('AAPL')!;
    const stop = s.fake.find(stopClientId('paper', 'AAPL', pos.entryTime))!;
    expect(stop).toMatchObject({ type: 'stop', side: 'sell', qty: 199, stopPrice: 98.36, timeInForce: 'gtc' });
    expect(await s.executor.ensureProtectiveStops()).toEqual([]);
    expect(s.fake.callsOf('submitOrder')).toHaveLength(2);
    // Position im Buch, aber nicht beim Broker ⇒ kein Stop (das wäre ein Leerverkaufs-Auslöser); der Abgleich klärt.
    s.fake.positions.delete('AAPL');
    s.fake.orders.delete(stop.id);
    s.book.protectiveOrders.delete('AAPL');
    expect(await s.executor.ensureProtectiveStops()).toEqual([]);
  });
});

describe('OrderExecutor — Krypto', () => {
  it('kein Bracket: Marktorder gtc mit 4-Dezimal-Menge, danach eigene stop_limit-Order', async () => {
    const s = setup({ assetClass: 'crypto' });
    s.fake.autoFillMarket = true;
    const res = await s.executor.execute([enter({ symbol: 'BTC/USD', qty: 0.12345678, stop: 58_000.123, target: 62_000, refPrice: 60_000 })]);
    expect(res[0]?.ok).toBe(true);
    const orders = s.fake.ordersFor('BTC/USD');
    expect(orders).toHaveLength(2);
    const [market, stop] = orders;
    expect(market).toMatchObject({ type: 'market', orderClass: 'simple', timeInForce: 'gtc', qty: 0.1234, side: 'buy' });
    expect(market?.clientOrderId).toBe(entryClientId('paper', 'BTC/USD', Math.floor(T / (5 * MIN)) * 5 * MIN));
    expect(market?.legs).toEqual([]);
    const pos = s.book.positions.get('BTC/USD')!;
    expect(pos.qty).toBe(0.1234);
    expect(stop).toMatchObject({ type: 'stop_limit', side: 'sell', qty: 0.1234, timeInForce: 'gtc', stopPrice: 58_000.12 });
    expect(stop?.limitPrice).toBe(roundStopFor(58_000.12 * 0.99, 'long'));
    expect(stop?.clientOrderId).toBe(stopClientId('paper', 'BTC/USD', pos.entryTime));
    expect(s.book.protectiveOrders.get('BTC/USD')?.orderId).toBe(stop?.id);
    // Exit: Marktorder gtc (Krypto kennt kein day).
    await s.executor.execute([{ kind: 'exit', symbol: 'BTC/USD', reason: 'signal', decidedAt: T }]);
    const exitOrder = s.fake.find(exitClientId('paper', 'BTC/USD', pos.entryTime))!;
    expect(exitOrder.timeInForce).toBe('gtc');
    expect(s.fake.find(stop!.id)?.status).toBe('canceled');
  });
});
