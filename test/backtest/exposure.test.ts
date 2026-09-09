/**
 * `EquityPoint.exposure`: Brutto-Exposure je Bar der Range als Anteil der
 * Equity — die Größe, mit der die Basis-Latte den Drawdown normiert
 * (Prüfbefund K2: eine Basis, die halb in Kasse steht, hat sonst automatisch
 * den halben Drawdown). Geprüft wird, dass der Simulator sie je Bar setzt,
 * dass sie aus Stück × Schluss / Equity entsteht und in Kasse 0 ist.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { baseConfig, barsMap, strategyOf } from './helpers.ts';

/** Handelstage ohne Feiertag (Labor Day 2026-09-07 ausgelassen). */
const TAGE = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09'];
const tagesbars = (closes: readonly number[]): Bar[] =>
  closes.map((c, k) => {
    const [y, m, d] = TAGE[k]!.split('-').map(Number) as [number, number, number];
    return { t: msFromET(y, m, d, 9, 30), o: c, h: c, l: c, c, v: 1_000 };
  });

describe('Exposure je Bar der Equity-Kurve', () => {
  // Risiko 1 % von 10 000 = 100 $ bei Stop-Distanz 10 ⇒ 10 Stück ⇒ 1 000 $ Marktwert.
  const cfg = baseConfig({ timeframe: 1440, risk: { riskPerTradePct: 1, maxPositionPct: 20 } });
  const strategy = strategyOf({
    decide: (snap) => {
      if (!snap.position && snap.i === 0) return { kind: 'enter', side: 'long', stop: 90, reason: 'test' };
      if (snap.position && snap.i >= 3) return { kind: 'exit', reason: 'test' };
      return { kind: 'hold' };
    },
  });

  it('0 in Kasse, Stück × Schluss / Equity mit Position — Fill am Folge-Open, Exit am Folge-Open', () => {
    const res = simulate({ bars: barsMap({ AAA: tagesbars([100, 100, 100, 100, 100, 100]) }), strategyFor: () => ({ strategy, params: {} }), config: cfg, initialEquity: 10_000 });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.qty).toBe(10);
    expect(res.equity).toHaveLength(6);
    expect(res.equity.every((p) => p.exposure !== undefined)).toBe(true);
    // Bar 0: entschieden, noch nichts im Buch. Bars 1–3: Position (Fill am Open von Bar 1, Exit-Signal an Bar 3).
    // Bar 4: Exit am Open ⇒ wieder Kasse. Bar 5: Kasse.
    expect(res.equity.map((p) => p.exposure === 0)).toEqual([true, false, false, false, true, true]);
    for (const p of res.equity.slice(1, 4)) expect(p.exposure).toBe(1_000 / p.equity);
    // Die Kosten des Einstiegs drücken die Equity unter 10 000 ⇒ Exposure knapp über 10 %.
    expect(res.equity[1]!.exposure!).toBeGreaterThan(0.1);
    expect(res.equity[1]!.exposure!).toBeLessThan(0.1001);
  });

  it('folgt dem Schlusskurs: Kurs verdoppelt ⇒ Marktwert und Equity steigen, Exposure wächst gegen 2 000 / Equity', () => {
    const res = simulate({ bars: barsMap({ AAA: tagesbars([100, 100, 200, 200, 200, 200]) }), strategyFor: () => ({ strategy, params: {} }), config: cfg, initialEquity: 10_000 });
    const p2 = res.equity[2]!;
    expect(p2.exposure).toBe(2_000 / p2.equity);
    expect(p2.equity).toBeGreaterThan(10_900); // +1 000 $ unrealisiert minus Einstiegskosten
    expect(p2.exposure!).toBeCloseTo(2_000 / p2.equity, 12);
  });

  it('Bars vor der Range (Warmup) tragen keinen Punkt; die Punkte der Range tragen Exposure', () => {
    const bars = tagesbars([100, 100, 100, 100, 100, 100]);
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: strategyOf({ decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: 90, reason: 'e' }) }), params: {} }),
      config: cfg,
      initialEquity: 10_000,
      range: { start: bars[2]!.t, end: bars[5]!.t },
    });
    expect(res.equity.map((p) => p.t)).toEqual([bars[2]!.t, bars[3]!.t, bars[4]!.t]);
    expect(res.equity.map((p) => p.exposure === 0)).toEqual([true, false, false]);
  });
});
