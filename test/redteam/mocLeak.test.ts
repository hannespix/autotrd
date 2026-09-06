/**
 * RED-TEAM: Market-on-Close-Fill am Close der Entscheidungs-Bar.
 *
 * Der Simulator füllt einen Exit an der letzten Bar des Tages SOFORT zum
 * Close dieser Bar (simulator.ts:535-537). Live ist die Bar erst um
 * 16:00:04 geschlossen (barGraceSec), die Marktorder (tif=day,
 * orders.ts:485) wird NACH Börsenschluss eingereicht und füllt am nächsten
 * Open. Der Backtest misst also einen Kurs, den die Engine nie bekommt.
 *
 * Betroffen: alle Exits an der letzten Tagesbar (jede Strategie, jeder
 * Zeitrahmen), alle EOD-Flattens bei tf ≥ 10 (kein Bucket endet in
 * (0, flattenBeforeCloseMin]) und ALLE Exits bei tf = 1440.
 */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { MIN, msFromET, parseDay } from '../../src/core/time.ts';
import type { Bar, TimeframeMin } from '../../src/core/types.ts';
import { barsMap, baseConfig, strategyOf } from '../backtest/helpers.ts';

type Ohlc = readonly [number, number, number, number];

function dayBars(day: string, tf: TimeframeMin, ohlc: readonly Ohlc[]): Bar[] {
  const { y, m, d } = parseDay(day);
  const open = msFromET(y, m, d, 9, 30);
  return ohlc.map(([o, h, l, c], k) => ({ t: open + k * tf * MIN, o, h, l, c, v: 1000 }));
}

const flat = (n: number, p: number): Ohlc[] => Array.from({ length: n }, () => [p, p, p, p] as const);

describe('RED-TEAM MOC-Leck', () => {
  it('tf=15, Intraday-Strategie: EOD-Exit füllt am 16:00-Close statt am nächsten erreichbaren Kurs (Folge-Open)', () => {
    // D1: 26 Buckets à 15 min, letzter (15:45–16:00) schließt bei 105. D2 eröffnet bei 95.
    const d1 = flat(26, 100);
    d1[25] = [100, 105, 100, 105];
    const d2 = flat(26, 95);
    const bars = [...dayBars('2026-09-01', 15, d1), ...dayBars('2026-09-02', 15, d2)];
    const strategy = strategyOf({
      holdsOvernight: false,
      decide: (snap) => (snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.8, reason: 'always' }),
    });
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy, params: {} }),
      config: baseConfig({ timeframe: 15 }), // flattenBeforeCloseMin=5 (Default) — bei tf=15 endet KEIN Bucket in (0,5]
      initialEquity: 100_000,
    });
    const t1 = res.trades[0]!;
    expect(t1.exitReason).toBe('eod');
    // Erreichbar ist frühestens das Open der Folgebar (D2 09:30 = 95). Beobachtet: 105 um 16:00 (D1).
    expect(t1.exitTime).toBeGreaterThanOrEqual(msFromET(2026, 9, 2, 9, 30));
    expect(t1.exitPrice).toBe(95);
  });

  it('tf=1440: Signal-Exit füllt am Close der Entscheidungs-Bar, nicht am Open des Folgetags', () => {
    // Tagesbars (t = Sitzungseröffnung). D3 schließt bei 110, D4 eröffnet bei 100.
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08'];
    const ohlc: Ohlc[] = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 110, 100, 110],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
    ];
    const bars: Bar[] = days.map((day, k) => {
      const { y, m, d } = parseDay(day);
      const [o, h, l, c] = ohlc[k]!;
      return { t: msFromET(y, m, d, 9, 30), o, h, l, c, v: 1000 };
    });
    const strategy = strategyOf({
      holdsOvernight: true,
      decide: (snap) => {
        if (!snap.position) return snap.i === 0 ? { kind: 'enter', side: 'long', stop: 50, reason: 'once' } : { kind: 'hold' };
        return snap.i === 2 ? { kind: 'exit', reason: 'signal' } : { kind: 'hold' };
      },
    });
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy, params: {} }),
      config: baseConfig({ timeframe: 1440 }),
      initialEquity: 100_000,
    });
    const t = res.trades[0]!;
    expect(t.entryTime).toBe(msFromET(2026, 9, 2, 9, 30)); // Einstieg korrekt am Folge-Open
    // Live: Tagesbar D3 ist erst nach 16:00:04 geschlossen ⇒ Order füllt am Open D4 (100).
    expect(t.exitTime).toBe(msFromET(2026, 9, 4, 9, 30));
    expect(t.exitPrice).toBe(100);
  });
});
