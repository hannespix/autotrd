import { describe, expect, it } from 'vitest';
import { borrowCost, fillCosts, regulatoryFees, slippedPrice } from '../../src/backtest/costs.ts';
import { baseConfig } from './helpers.ts';

const costs = baseConfig().costs; // slippage 3 bps, spread 2 bps, SEC 0.0000278, TAF 0.000166 (max 8.3), Krypto 0.25 %

describe('slippedPrice', () => {
  it('Kauf teurer, Verkauf billiger — um Slippage + halben Spread', () => {
    expect(slippedPrice({ side: 'buy', price: 100, assetClass: 'us_equity', costs, multiplier: 1 })).toBeCloseTo(100.05, 10);
    expect(slippedPrice({ side: 'sell', price: 100, assetClass: 'us_equity', costs, multiplier: 1 })).toBeCloseTo(99.95, 10);
  });
  it('Stressfaktor skaliert die Basispunkte', () => {
    expect(slippedPrice({ side: 'buy', price: 100, assetClass: 'us_equity', costs, multiplier: 2 })).toBeCloseTo(100.1, 10);
  });
});

describe('fillCosts (Aktien)', () => {
  it('Kauf: nur Slippage, keine Gebühren', () => {
    const c = fillCosts({ side: 'buy', qty: 100, price: 100, assetClass: 'us_equity', costs, multiplier: 1 });
    expect(c.slippage).toBeCloseTo(5, 9);
    expect(c.fees).toBe(0);
    expect(c.total).toBeCloseTo(5, 9);
  });
  it('Verkauf: Slippage + SEC auf Erlös + TAF je Stück', () => {
    const c = fillCosts({ side: 'sell', qty: 100, price: 100, assetClass: 'us_equity', costs, multiplier: 1 });
    expect(c.slippage).toBeCloseTo(5, 9);
    expect(c.fees).toBeCloseTo(10_000 * 0.0000278 + 100 * 0.000166, 9);
    expect(c.total).toBeCloseTo(c.slippage + c.fees, 12);
  });
  it('TAF ist gedeckelt', () => {
    const fees = regulatoryFees({ side: 'sell', qty: 1_000_000, price: 1, assetClass: 'us_equity', costs, multiplier: 1 });
    expect(fees).toBeCloseTo(1_000_000 * 0.0000278 + 8.3, 9);
  });
  it('Round-Trip = Erwartung aus bps + SEC/TAF; Faktor 2 verdoppelt alles', () => {
    const rt = (m: number) =>
      fillCosts({ side: 'buy', qty: 50, price: 200, assetClass: 'us_equity', costs, multiplier: m }).total +
      fillCosts({ side: 'sell', qty: 50, price: 210, assetClass: 'us_equity', costs, multiplier: m }).total;
    const expected = 50 * 200 * 0.0005 + 50 * 210 * 0.0005 + 50 * 210 * 0.0000278 + 50 * 0.000166;
    expect(rt(1)).toBeCloseTo(expected, 9);
    expect(rt(2)).toBeCloseTo(2 * expected, 9);
  });
});

describe('fillCosts (Krypto)', () => {
  it('Taker-Prozent auf beiden Seiten plus Slippage', () => {
    const buy = fillCosts({ side: 'buy', qty: 0.5, price: 40_000, assetClass: 'crypto', costs, multiplier: 1 });
    const sell = fillCosts({ side: 'sell', qty: 0.5, price: 40_000, assetClass: 'crypto', costs, multiplier: 1 });
    expect(buy.fees).toBeCloseTo(20_000 * 0.0025, 9);
    expect(sell.fees).toBeCloseTo(20_000 * 0.0025, 9);
    expect(buy.slippage).toBeCloseTo(20_000 * 0.0005, 9);
  });
});

describe('borrowCost', () => {
  it('p. a. taggenau über 365 Tage, mit Faktor', () => {
    expect(borrowCost({ notional: 36_500, days: 1, costs, multiplier: 1 })).toBeCloseTo(1, 9);
    expect(borrowCost({ notional: 36_500, days: 3, costs, multiplier: 1.5 })).toBeCloseTo(4.5, 9);
    expect(borrowCost({ notional: 36_500, days: 0, costs, multiplier: 1 })).toBe(0);
  });
});
