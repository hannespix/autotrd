import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  deflatedSharpe,
  expectedMaxSharpe,
  kurtosis,
  maxDrawdownPct,
  normalCdf,
  normalInv,
  probabilisticSharpe,
  sharpeRatio,
  skewness,
  sortinoRatio,
} from '../../src/backtest/metrics.ts';
import type { Trade } from '../../src/core/types.ts';

describe('Sharpe / Sortino / MaxDD (handgerechnet)', () => {
  it('Sharpe: Mittel 0.01, σ (n−1) = 0.01 ⇒ 1·√252', () => {
    // [0.02, 0.00]: Mittel 0.01, Abweichungen ±0.01, Varianz (n−1) = 0.0002/1 ⇒ σ = 0.014142
    const r = [0.02, 0.0];
    expect(sharpeRatio(r, 252)).toBeCloseTo((0.01 / Math.sqrt(0.0002)) * Math.sqrt(252), 9);
    expect(sharpeRatio([0.01], 252)).toBeNull();
    expect(sharpeRatio([0.01, 0.01, 0.01], 252)).toBeNull();
  });
  it('Sortino: Downside-Deviation gegen 0 über alle Perioden', () => {
    const r = [0.03, -0.01, 0.02, -0.02];
    const mean = 0.005;
    const dd = Math.sqrt((0.0001 + 0.0004) / 4);
    expect(sortinoRatio(r, 252)).toBeCloseTo((mean / dd) * Math.sqrt(252), 9);
    expect(sortinoRatio([0.01, 0.02], 252)).toBeNull();
  });
  it('MaxDD: 100 → 120 → 90 → 130 ⇒ 25 %', () => {
    expect(maxDrawdownPct([100, 120, 90, 130])).toBeCloseTo(25, 9);
    expect(maxDrawdownPct([100, 110, 120])).toBe(0);
    expect(maxDrawdownPct([])).toBe(0);
  });
});

describe('Momente', () => {
  it('symmetrische Serie: Schiefe 0; Kurtosis roh (zweipunktig = 1)', () => {
    expect(skewness([-1, 1, -1, 1])).toBeCloseTo(0, 12);
    expect(kurtosis([-1, 1, -1, 1])).toBeCloseTo(1, 12);
  });
  it('rechtsschief ⇒ Schiefe > 0; entartet ⇒ 0 / 3', () => {
    expect(skewness([0, 0, 0, 10])).toBeGreaterThan(0);
    expect(skewness([1, 1, 1])).toBe(0);
    expect(kurtosis([1, 1, 1, 1])).toBe(3);
  });
});

describe('Normalverteilung', () => {
  it('Φ an Stützstellen', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 14);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 10);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145707, 12);
    expect(normalCdf(-9)).toBe(0);
    expect(normalCdf(9)).toBe(1);
  });
  it('normalInv(normalCdf(x)) ≈ x auf [−4, 4]', () => {
    for (let x = -4; x <= 4; x += 0.25) {
      expect(normalInv(normalCdf(x))).toBeCloseTo(x, 8);
    }
    expect(normalInv(0.5)).toBeCloseTo(0, 12);
    expect(normalInv(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normalInv(1)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(normalInv(1.5))).toBe(true);
  });
});

describe('PSR / DSR', () => {
  it('sr = 0 ⇒ PSR 0.5 für beliebiges n', () => {
    expect(probabilisticSharpe({ sr: 0, n: 2, skew: 0, kurt: 3 })).toBeCloseTo(0.5, 12);
    expect(probabilisticSharpe({ sr: 0, n: 500, skew: -1, kurt: 6 })).toBeCloseTo(0.5, 12);
    expect(probabilisticSharpe({ sr: 0, n: 1, skew: 0, kurt: 3 })).toBeCloseTo(0.5, 12);
  });
  it('PSR steigt mit n und fällt mit schweren Rändern / Linksschiefe', () => {
    const base = probabilisticSharpe({ sr: 0.1, n: 100, skew: 0, kurt: 3 });
    expect(base).toBeCloseTo(normalCdf((0.1 * Math.sqrt(99)) / Math.sqrt(1 + 0.5 * 0.01)), 12);
    expect(probabilisticSharpe({ sr: 0.1, n: 400, skew: 0, kurt: 3 })).toBeGreaterThan(base);
    expect(probabilisticSharpe({ sr: 0.1, n: 100, skew: -2, kurt: 9 })).toBeLessThan(base);
  });
  it('expectedMaxSharpe: 0 bei einem Versuch, wächst mit N', () => {
    expect(expectedMaxSharpe(1, 0.01)).toBe(0);
    expect(expectedMaxSharpe(10, 0)).toBe(0);
    const e10 = expectedMaxSharpe(10, 0.01);
    const e100 = expectedMaxSharpe(100, 0.01);
    expect(e10).toBeGreaterThan(0);
    expect(e100).toBeGreaterThan(e10);
    // Formel nachgerechnet
    const g = 0.5772156649015329;
    expect(e10).toBeCloseTo(0.1 * ((1 - g) * normalInv(1 - 1 / 10) + g * normalInv(1 - 1 / (10 * Math.E))), 12);
  });
  it('DSR sinkt mit nTrials und ist ohne Auswahl gleich PSR', () => {
    const args = { sr: 0.15, n: 250, skew: -0.3, kurt: 4 };
    const d1 = deflatedSharpe({ ...args, nTrials: 1, varSr: 0.004 });
    const d10 = deflatedSharpe({ ...args, nTrials: 10, varSr: 0.004 });
    const d1000 = deflatedSharpe({ ...args, nTrials: 1000, varSr: 0.004 });
    expect(d1).toBeCloseTo(probabilisticSharpe(args), 12);
    expect(d10).toBeLessThan(d1);
    expect(d1000).toBeLessThan(d10);
  });
});

function trade(net: number, gross = net, fees = gross - net, r: number | null = null): Trade {
  return {
    symbol: 'X',
    side: 'long',
    qty: 1,
    entryTime: 0,
    entryPrice: 100,
    exitTime: 1,
    exitPrice: 100 + gross,
    grossPnl: gross,
    fees,
    netPnl: net,
    rMultiple: r,
    exitReason: 'signal',
    strategy: 's',
    barsHeld: 1,
    mae: null,
    mfe: null,
  };
}

describe('computeMetrics', () => {
  it('PF, Winrate, Expectancy, avgR, feeShare, Rendite, CAGR', () => {
    const trades = [trade(100, 110, 10, 2), trade(-50, -45, 5, -1), trade(30, 35, 5, null)];
    const m = computeMetrics({
      trades,
      equity: [
        { t: 0, equity: 10_100 },
        { t: 1, equity: 10_050 },
        { t: 2, equity: 10_080 },
      ],
      dailyReturns: [0.01, -0.00495, 0.003],
      initialEquity: 10_000,
      periodsPerYear: 252,
      days: 365,
      exposurePct: 40,
    });
    expect(m.trades).toBe(3);
    expect(m.netProfit).toBeCloseTo(80, 9);
    expect(m.netReturnPct).toBeCloseTo(0.8, 9);
    expect(m.cagrPct).toBeCloseTo(0.8, 6);
    expect(m.profitFactor).toBeCloseTo(130 / 50, 9);
    expect(m.winRatePct).toBeCloseTo((2 / 3) * 100, 9);
    expect(m.expectancy).toBeCloseTo(80 / 3, 9);
    expect(m.avgR).toBeCloseTo(0.5, 9);
    expect(m.feeShare).toBeCloseTo(20 / 145, 9);
    expect(m.exposurePct).toBe(40);
    expect(m.days).toBe(365);
    // Drawdown beginnt beim Startkapital: 10100 → 10050 = 0,495 %
    expect(m.maxDrawdownPct).toBeCloseTo((50 / 10_100) * 100, 9);
  });
  it('ohne Trades: null-Felder statt NaN', () => {
    const m = computeMetrics({ trades: [], equity: [], dailyReturns: [], initialEquity: 1000, periodsPerYear: 252, days: 0, exposurePct: 0 });
    expect(m.profitFactor).toBeNull();
    expect(m.winRatePct).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.avgR).toBeNull();
    expect(m.feeShare).toBeNull();
    expect(m.sharpe).toBeNull();
    expect(m.cagrPct).toBeNull();
    expect(m.netProfit).toBe(0);
  });
  it('nur Gewinner ⇒ Profitfaktor null (kein Nenner), feeShare aus Brutto', () => {
    const m = computeMetrics({ trades: [trade(10, 12, 2)], equity: [], dailyReturns: [], initialEquity: 1000, periodsPerYear: 252, days: 1, exposurePct: 0 });
    expect(m.profitFactor).toBeNull();
    expect(m.feeShare).toBeCloseTo(2 / 12, 12);
  });
});
