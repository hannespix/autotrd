/**
 * RED-TEAM: Sortino-Objective bestraft Fenster OHNE Verlusttag maximal.
 *
 * metrics.ts sortinoRatio ⇒ null, wenn kein Tag < 0; objective.ts macht
 * daraus −Infinity. Ein OOS-Fold, der nur Gewinntage hat, zählt damit als
 * SCHLECHTESTER Fold — und ein IS-Kandidat ohne Verlusttag kann nie `best`
 * werden. Der Fake-Simulator der Tests regularisiert das weg
 * (test/optimize/fakes.ts: "leicht regularisiert, damit ein Fenster ohne
 * Verlusttag endlich bleibt") — die echte Metrik tut das nicht.
 */
import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/backtest/metrics.ts';
import { aggregateOos, type OosPiece } from '../../src/optimize/walkForward.ts';
import { objectiveValue } from '../../src/optimize/objective.ts';
import type { Trade } from '../../src/core/types.ts';

function pieceFrom(dailyReturns: number[]): OosPiece {
  let eq = 10_000;
  const equity = dailyReturns.map((r, k) => {
    eq *= 1 + r;
    return { t: k, equity: eq };
  });
  const trade: Trade = {
    symbol: 'AAA', side: 'long', qty: 1, entryTime: 0, entryPrice: 100, exitTime: 1, exitPrice: 101,
    grossPnl: eq - 10_000, fees: 0, netPnl: eq - 10_000, rMultiple: null, exitReason: 'signal', strategy: 's', barsHeld: 1, mae: null, mfe: null,
  };
  const metrics = computeMetrics({ trades: [trade], equity, dailyReturns, initialEquity: 10_000, periodsPerYear: 252, days: dailyReturns.length, exposurePct: 100 });
  return { metrics, trades: [trade], dailyReturns, equity, finalEquity: eq };
}

describe('RED-TEAM Sortino −∞', () => {
  const perfect = pieceFrom([0.01, 0.012, 0.008, 0.011, 0.009]); // nur Gewinntage
  const good = pieceFrom([0.01, -0.001, 0.008, 0.011, 0.009]);   // ein winziger Verlusttag
  const bad = pieceFrom([-0.01, -0.012, 0.001, -0.011, 0.002]);  // netto negativ

  it('ein Fenster ohne Verlusttag muss besser ranken als dasselbe Fenster mit einem Verlusttag', () => {
    const a = objectiveValue('sortino', perfect.metrics);
    const b = objectiveValue('sortino', good.metrics);
    expect(Number.isFinite(a)).toBe(true); // beobachtet: −Infinity
    expect(a).toBeGreaterThan(b);
  });

  it('Fold-Median: der beste Fold darf den Median nicht nach UNTEN ziehen', () => {
    const agg = aggregateOos([perfect, good, bad], 'sortino', 10_000);
    // Erwartet: Median = mittlerer Wert = good. Beobachtet: sortiert [−∞, bad, good] ⇒ Median = bad (< 0).
    expect(agg.objectiveMedian).toBeCloseTo(objectiveValue('sortino', good.metrics), 9);
    expect(agg.objectiveMedian).toBeGreaterThan(0);
  });
});
