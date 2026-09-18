import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision, IndicatorSet, Strategy } from '../../src/core/types.ts';
import { baseConfig, barsMap, strategyOf } from './helpers.ts';

/**
 * Fahrplan der Parameter (`ParameterWechsel`, Vorregistrierung
 * `docs/wissen/vorregistrierung/2026-09-18-durchgehende-oos-kette.md`):
 * Damit die OOS-Kette EINE Simulation sein kann, wechselt der Simulator
 * Parameter — und die Führung eines Symbols — an vorgegebenen Zeitpunkten,
 * mitten im Lauf, mit offenen Positionen. Ohne Fahrplan bleibt alles wie es war.
 */

const cfg = baseConfig({ timeframe: 1440, risk: { riskPerTradePct: 5, maxPositionPct: 100 } });

/** Tagesbars ab dem 1.9.2026 (Werktage), Schluss = `close(k)`. */
function tage(n: number, close: (k: number) => number): Bar[] {
  const out: Bar[] = [];
  let d = 1;
  while (out.length < n) {
    const dow = new Date(Date.UTC(2026, 8, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const c = close(out.length);
      out.push({ t: msFromET(2026, 9, d, 9, 30), o: c, h: c, l: c, c, v: 1_000 });
    }
    d++;
  }
  return out;
}

/**
 * Eine Strategie, deren Verhalten an den Parametern hängt: `p.modus` 1 =
 * long einsteigen und halten, 2 = sofort raus und nie wieder rein. Die
 * Indikatoren tragen die Parameter mit (`ind.modus`), damit man sieht, ob
 * der Simulator die Indikatoren des NEUEN Satzes reicht.
 */
function nachModus(): Strategy {
  return strategyOf({
    holdsOvernight: true,
    precompute: (_bars, p) => ({ modus: new Float64Array([Number(p.modus ?? 1)]) }) as unknown as IndicatorSet,
    decide: (snap, ind, p): Decision => {
      const ausInd = (ind as unknown as { modus: Float64Array }).modus[0];
      if (ausInd !== Number(p.modus ?? 1)) throw new Error(`Indikatoren (${ausInd}) passen nicht zu den Parametern (${String(p.modus)})`);
      const c = snap.bars.c[snap.i]!;
      if (p.modus === 2) return snap.position ? { kind: 'exit', reason: 'modus2' } : { kind: 'hold' };
      return snap.position ? { kind: 'hold' } : { kind: 'enter', side: 'long', stop: c * 0.5, reason: 'modus1' };
    },
  });
}

describe('Fahrplan der Parameter im Simulator', () => {
  const bars = tage(12, () => 100);
  const t = (k: number) => bars[k]!.t;

  it('ohne Fahrplan bitgleich: dasselbe Ergebnis wie mit einem leeren Fahrplan', () => {
    const a = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 } }), config: cfg, initialEquity: 100_000 });
    const b = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 }, wechsel: [] }), config: cfg, initialEquity: 100_000 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.trades).toHaveLength(0);
    expect(a.offenAmEnde).toHaveLength(1);
  });

  it('ab `ab` gelten die neuen Parameter — mit den Indikatoren des neuen Satzes; die offene Position läuft in den Wechsel hinein', () => {
    // Modus 1 bis Bar 5, ab Bar 6 Modus 2 ⇒ Exit-Signal an Bar 6, Fill am Open von Bar 7.
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 }, wechsel: [{ ab: t(6), params: { modus: 2 } }] }),
      config: cfg,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.entryTime).toBe(t(1)); // Einstieg an Bar 0, Fill am Open von Bar 1
    expect(res.trades[0]!.exitTime).toBe(t(7));
    expect(res.trades[0]!.exitReason).toBe('signal');
    expect(res.offenAmEnde).toEqual([]);
  });

  it('`params: null` sperrt: kein Einstieg mehr, eine offene Position wird am nächsten Open als unmanaged geschlossen', () => {
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 }, wechsel: [{ ab: t(4), params: null }] }),
      config: cfg,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.exitReason).toBe('unmanaged');
    expect(res.trades[0]!.exitTime).toBe(t(5)); // gesperrt ab Bar 4 ⇒ Exit-Intent an Bar 4, Fill am Open von Bar 5
    expect(res.offenAmEnde).toEqual([]);
    // und danach kein neuer Einstieg — die Kurve bleibt flach
    const nachher = res.equity.filter((e) => e.t > t(5));
    expect(nachher.length).toBeGreaterThan(3);
    expect(new Set(nachher.map((e) => e.equity)).size).toBe(1);
  });

  it('eine Sperre lässt sich per späterem Eintrag wieder aufheben — Einstieg erst danach', () => {
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 }, wechsel: [{ ab: t(2), params: null }, { ab: t(8), params: { modus: 1 } }] }),
      config: cfg,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.exitReason).toBe('unmanaged');
    expect(res.offenAmEnde).toHaveLength(1);
    expect(res.trades.length + res.offenAmEnde!.length).toBe(2);
  });

  it('Einträge werden nach Zeit sortiert angewandt — die Reihenfolge im Array ist egal', () => {
    const vor = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 }, wechsel: [{ ab: t(3), params: { modus: 2 } }, { ab: t(7), params: { modus: 1 } }] }), config: cfg, initialEquity: 100_000 });
    const rueck = simulate({ bars: barsMap({ AAA: bars }), strategyFor: () => ({ strategy: nachModus(), params: { modus: 1 }, wechsel: [{ ab: t(7), params: { modus: 1 } }, { ab: t(3), params: { modus: 2 } }] }), config: cfg, initialEquity: 100_000 });
    expect(JSON.stringify(rueck)).toBe(JSON.stringify(vor));
    expect(vor.trades).toHaveLength(1);
    expect(vor.offenAmEnde).toHaveLength(1);
  });
});
