import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/backtest/metrics.ts';
import { DAY, HOUR } from '../../src/core/time.ts';
import type { Trade } from '../../src/core/types.ts';
import { aggregateOos, type OosPiece } from '../../src/optimize/walkForward.ts';
import { assessReadiness } from '../../src/readiness.ts';

/**
 * Gebührenanteil — EINE Definition an allen drei Stellen, die ihn rechnen:
 * Σ Gebühren / Σ Brutto-Ergebnis ALLER Trades.
 *
 * Bis 18.09.2026 gab es zwei: `computeMetrics` (je Fenster) und `readiness`
 * (Live-Reife) teilten durch die Bruttogewinne der GEWINNER, die OOS-Kette
 * (`aggregateOos`, Gate `fee_share`) durch das Brutto aller Trades. Der
 * Prüfer vom 09.09.2026 (Befund 4, redteam-basis-v1) hatte die Kette
 * festgelegt. Die mildere Definition hätte den Vorgänger (3 049 $ Gebühren
 * auf 1 456 $ brutto, CLAUDE.md §2) mit ~30 % durchgewinkt — und sie saß in
 * der Echtgeld-Kette (`readiness`).
 */

const T0 = Date.UTC(2026, 0, 5, 15, 0);
const NOW = T0 + 40 * DAY;

function trade(gross: number, fees: number, i = 0): Trade {
  return {
    symbol: 'SPY',
    side: 'long',
    qty: 1,
    entryTime: T0 + i * 3 * HOUR,
    entryPrice: 100,
    exitTime: T0 + i * 3 * HOUR + HOUR,
    exitPrice: 100 + gross,
    grossPnl: gross,
    fees,
    netPnl: gross - fees,
    rMultiple: null,
    exitReason: 'signal',
    strategy: 'test',
    barsHeld: 1,
    mae: null,
    mfe: null,
  };
}

function fenster(trades: Trade[]) {
  return computeMetrics({ trades, equity: [], dailyReturns: [], initialEquity: 10_000, periodsPerYear: 252, days: 30, exposurePct: 50 });
}

function kette(trades: Trade[]): OosPiece {
  return { metrics: fenster(trades), trades, dailyReturns: [0.01], equity: [{ t: 0, equity: 10_000 }], finalEquity: 10_000 };
}

const reife = (trades: Trade[]) => assessReadiness(trades, NOW, { minTrades: 1, minDays: 0 }).checks.find((c) => c.name === 'feeShare')!;

describe('Gebührenanteil: eine Definition für Fenster, Kette und Live-Reife', () => {
  // drei Gewinner (brutto 30, 20, 10), zwei Verlierer (brutto −25, −15): Σ brutto = 20, Σ Gebühren = 5
  const gemischt = [trade(30, 1, 0), trade(-25, 1, 1), trade(20, 1, 2), trade(-15, 1, 3), trade(10, 1, 4)];

  it('alle drei Stellen liefern denselben Wert — Σ Gebühren / Σ brutto ALLER Trades', () => {
    const erwartet = 5 / 20;
    expect(fenster(gemischt).feeShare).toBeCloseTo(erwartet, 12);
    expect(aggregateOos([kette(gemischt)], 'sharpe', 10_000).feeShare).toBeCloseTo(erwartet, 12);
    expect(reife(gemischt).value).toBeCloseTo(erwartet, 12);
    // und NICHT die mildere Rechnung über die Gewinner allein (5 / 60)
    expect(fenster(gemischt).feeShare).not.toBeCloseTo(5 / 60, 6);
  });

  it('Σ brutto ≤ 0 trotz Gewinnern ⇒ an allen drei Stellen null, und die Reife fällt durch', () => {
    // zwei Gewinner (brutto 12, 8), ein Verlierer (brutto −25): zusammen −5 — die Vakanz von E2 #70 / tsmom #71
    const verlierend = [trade(12, 2, 0), trade(8, 2, 1), trade(-25, 2, 2)];
    expect(fenster(verlierend).feeShare).toBeNull();
    expect(aggregateOos([kette(verlierend)], 'sharpe', 10_000).feeShare).toBeNull();
    expect(reife(verlierend).value).toBeNull();
    expect(reife(verlierend).pass).toBe(false);
  });

  it('Nahtwächter: keine Stelle rechnet mehr über die Gewinner allein, und das Gate liest null nie als bestanden', () => {
    const metrics = readFileSync('src/backtest/metrics.ts', 'utf8');
    const readiness = readFileSync('src/readiness.ts', 'utf8');
    const robustness = readFileSync('src/optimize/robustness.ts', 'utf8');
    expect(metrics).not.toMatch(/if \(t\.grossPnl > 0\) sum/);
    expect(readiness).not.toMatch(/grossWins/);
    // Das Gate: `pass: oos.feeShare !== null && …` — die alte Form `=== null ||` wäre wieder „vakant ⇒ bestanden".
    const gate = robustness.slice(robustness.indexOf("name: 'fee_share'"), robustness.indexOf("name: 'fee_share'") + 400);
    expect(gate).toMatch(/pass: oos\.feeShare !== null && oos\.feeShare <= FEE_SHARE_MAX/);
    expect(gate).not.toMatch(/feeShare === null \|\|/);
  });
});
