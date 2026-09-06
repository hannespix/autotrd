/**
 * SECREVIEW3 — M10 `OrderExecutor.tradeFees` (orders.ts L212-218) bucht live NUR regulatorische Gebühren
 * (SEC/TAF), der Simulator (simulator.ts L346, L372-377) bucht in `Trade.fees` zusätzlich Slippage + halben
 * Spread beider Marktseiten (und Leihkosten). Live steckt die Slippage im Fill-Kurs, also in `grossPnl`.
 *
 * Folge für die Messung: `feeShare = Σ fees / Σ Brutto-Gewinne` (readiness.ts L144) ist live um mehr als
 * eine Größenordnung kleiner als dieselbe Zahl im Optimierer-Gate (`feeShare ≤ 0,5`, CLAUDE.md §2) — das
 * Reife-Kriterium „Gebührenanteil" misst live bei Aktien praktisch nichts. Kein Bug im Code, aber zwei
 * verschiedene Zahlen unter einem Namen. Dieser Test ist GRÜN und belegt den Faktor.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AlpacaOrder } from '../../src/alpaca/types.ts';
import { fillCosts, regulatoryFees } from '../../src/backtest/costs.ts';
import { Journal } from '../../src/core/journal.ts';
import { MIN } from '../../src/core/time.ts';
import { Book } from '../../src/engine/book.ts';
import { OrderExecutor } from '../../src/engine/orders.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';
import { DAY1, OPEN1, testConfig, tmpHome } from '../fakes/harness.ts';

describe('secreview3: Gebührenanteil live vs. Simulator', () => {
  it('Live-Trade.fees = nur SEC/TAF; Simulator-Trade.fees = Slippage + Spread + SEC/TAF ⇒ feeShare nicht vergleichbar', () => {
    const cfg = testConfig();
    const book = new Book();
    book.open({ symbol: 'AAPL', side: 'long', qty: 199, entryPrice: 100.4, entryTime: OPEN1 + 10 * MIN, stop: 98.36, target: 104.38, initialStop: 98.36, highWater: 100.4, strategy: 't', barsHeld: 3, entryDay: DAY1 });
    const journal = new Journal(join(tmpHome(), 'journal.jsonl'));
    const executor = new OrderExecutor({ client: new FakeAlpaca(), book, journal, mode: 'paper', assetClass: 'us_equity', timeframe: 5, holdsOvernightFor: () => false, costs: cfg.costs });
    const order: AlpacaOrder = {
      id: 'x1', clientOrderId: 'atd-paper-AAPL-1-x', symbol: 'AAPL', side: 'sell', type: 'market', timeInForce: 'day', orderClass: 'simple',
      qty: 199, notional: null, filledQty: 199, filledAvgPrice: 101.4, limitPrice: null, stopPrice: null, status: 'filled',
      submittedAt: OPEN1 + 20 * MIN, filledAt: OPEN1 + 20 * MIN, canceledAt: null, legs: [], hwm: null,
    };
    expect(executor.applyExitFill(order, { ts: OPEN1 + 20 * MIN, reason: 'signal' })).toBe(true);
    const live = journal.trades()[0]!;

    const args = { qty: 199, assetClass: 'us_equity' as const, costs: cfg.costs, multiplier: 1 };
    const nurRegulatorisch = regulatoryFees({ ...args, side: 'buy', price: 100.4 }) + regulatoryFees({ ...args, side: 'sell', price: 101.4 });
    const simulator = fillCosts({ ...args, side: 'buy', price: 100.4 }).total + fillCosts({ ...args, side: 'sell', price: 101.4 }).total;

    expect(live.fees).toBeCloseTo(nurRegulatorisch, 6);
    expect(live.grossPnl).toBeCloseTo(199, 6);
    // Dieselbe Runde, dieselbe Kostenkonfiguration: Simulator-Gebühren > 10 × Live-Gebühren.
    expect(simulator / live.fees).toBeGreaterThan(10);
    // feeShare dieser Runde: live < 1 %, Simulator > 5 % — das Gate „≤ 0,5" ist live ein anderes Kriterium.
    expect(live.fees / live.grossPnl).toBeLessThan(0.01);
    expect(simulator / live.grossPnl).toBeGreaterThan(0.05);
  });
});
