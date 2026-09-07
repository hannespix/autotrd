/**
 * RED-TEAM: Sizing gegen Cash am Entscheidungs-Close, Fill am Folge-Open.
 *
 * sizing.ts begrenzt Long-Stückzahl mit cash/price zum Close der
 * Entscheidungs-Bar; simulator.ts openFromIntent (Z. 314-335) füllt die
 * volle Stückzahl am Folge-Open OHNE Cash-Prüfung. Bei Gap-up wird das
 * Konto negativ — ungedeckte Hebelung ohne Marginzins, ohne Ablehnung.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { barsMap, baseConfig, dayBars5, flat, strategyOf } from '../backtest/helpers.ts';

describe('RED-TEAM Cash negativ', () => {
  it('Long-Fill darf das Bargeld nicht überschreiten', () => {
    const ohlc = flat(78, 100);
    ohlc[1] = [120, 121, 119, 120]; // Gap-up am Fill-Open
    const bars = dayBars5('2026-09-01', ohlc);
    const strategy = strategyOf({
      decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.95, reason: 'always' }),
    });
    const initialEquity = 10_000;
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy, params: {} }),
      config: baseConfig({ risk: { riskPerTradePct: 5, maxPositionPct: 100, maxGrossExposurePct: 100 } }),
      initialEquity,
    });
    // Die Position wird danach von der Tages-Notbremse geschlossen (Equity 7 994 nach Rückfall auf 100) — sie steht in trades.
    const t = res.trades[0]!;
    expect(t.entryPrice).toBe(120);
    // Behoben: Am Fill wird gegen das Bargeld nachgesized (100 Stück zum Close ⇒ 83 zum Gap-Open).
    expect(t.qty).toBeLessThan(100);
    expect(t.qty).toBeGreaterThan(0);
    expect(t.qty * t.entryPrice + t.fees).toBeLessThanOrEqual(initialEquity);
    expect(res.notes.some((n) => /Bargeld reicht am Fill nicht|nachgesized|reduziert/i.test(n))).toBe(true);
  });
});
