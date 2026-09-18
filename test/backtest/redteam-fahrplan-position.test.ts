import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/backtest/simulator.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar, Decision } from '../../src/core/types.ts';
import { baseConfig, barsMap, strategyOf } from './helpers.ts';

/**
 * Prüfer (Red-Team, 18.09.2026, `pruefungen/2026-09-18-red-team-durchgehende-kette.md`):
 * Was passiert mit einer OFFENEN Position, wenn der Fahrplan die Parameter
 * wechselt? Die Vorregistrierung sagt „wie die Plattform nachts" — die
 * Plattform führt eine Position bei einem Parameterwechsel derselben
 * Strategie über `decide()` weiter: Stop und Hochwasser bleiben, ein neuer
 * Trailing-Vorschlag greift nur, wenn er ENGER ist (core/logic.ts). Der
 * Simulator ruft dasselbe `decide()`; dieser Wächter hält fest, dass er dem
 * `PositionState` beim Wechsel nichts zurücksetzt — sonst wäre §0.1 verletzt.
 *
 * Zweiter Fall: Ein Einstieg, der an der letzten Bar VOR einer Korbgrenze
 * entschieden wurde, füllt am Open der Grenz-Bar und wird — weil das Symbol
 * ab dieser Bar gesperrt ist — am Open der Folgebar `unmanaged` geschlossen:
 * eine Rundreise über eine Bar. Die Engine täte dasselbe (Order nach Schluss,
 * Fill am Open, im nächsten Takt ohne Führung). Kein Fehler, aber ein
 * Verhalten, das man kennen muss, wenn man `unmanaged`-Trades liest.
 */

const cfg = baseConfig({
  timeframe: 1440,
  risk: { riskPerTradePct: 5, maxPositionPct: 100 },
  costs: { slippageBps: 0, spreadBps: 0, secFeeRate: 0, finraTafPerShare: 0, finraTafMax: 0 },
});

/** Tagesbars ab dem 1.9.2026 (Werktage), Schluss = `close(k)`, o = h = l = c. */
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

describe('Fahrplan und offene Position (Prüfer, 18.09.2026)', () => {
  it('WÄCHTER: ein Parameterwechsel setzt Stop, Hochwasser, Erstmarke und Einstiegszeit NICHT zurück; der neue Trailing-Abstand greift nur, wenn er enger ist', () => {
    // Kurs steigt jeden Tag um 1: 100, 101, 102, …
    const bars = tage(16, (k) => 100 + k);
    const t = (k: number) => bars[k]!.t;
    const spion: { i: number; trail: number; stop: number | null; hw: number; init: number | null; entry: number }[] = [];
    const trailer = strategyOf({
      timeframes: [1440],
      decide: (snap, _ind, p): Decision => {
        const c = snap.bars.c[snap.i]!;
        if (snap.position) {
          spion.push({ i: snap.i, trail: Number(p.trail), stop: snap.position.stop, hw: snap.position.highWater, init: snap.position.initialStop, entry: snap.position.entryTime });
          return { kind: 'move_stop', stop: snap.position.highWater - Number(p.trail), reason: 'trail' };
        }
        return snap.i === 0 ? { kind: 'enter', side: 'long', stop: c - 10, reason: 'rein' } : { kind: 'hold' };
      },
    });
    // trail 5 bis Bar 5, ab Bar 6 trail 20 (weiter ⇒ darf nicht greifen), ab Bar 9 trail 1 (enger ⇒ greift).
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: trailer, params: { trail: 5 }, wechsel: [{ ab: t(6), params: { trail: 20 } }, { ab: t(9), params: { trail: 1 } }] }),
      config: cfg,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(0);
    expect(res.offenAmEnde).toHaveLength(1);
    const bei = (i: number) => spion.find((s) => s.i === i)!;
    // Einstieg an Bar 0 ⇒ Fill am Open von Bar 1 (101); Erstmarke 90; Hochwasser folgt dem Schluss.
    for (const s of spion) {
      expect(s.init).toBe(90);
      expect(s.entry).toBe(t(1));
      expect(s.hw).toBe(100 + s.i);
    }
    // Unter trail 5: Stop an Bar i = Hochwasser von Bar i−1 minus 5 (der Vorschlag von Bar i−1 wird an Bar i wirksam).
    expect(bei(5)).toMatchObject({ trail: 5, stop: 99 }); // hw(4) − 5 = 104 − 5
    // Wechsel an Bar 6 auf trail 20: der Vorschlag hw − 20 liegt UNTER dem Stop ⇒ Stop bleibt bei hw(5) − 5 = 100.
    expect(bei(6)).toMatchObject({ trail: 20, stop: 100 });
    expect(bei(7)).toMatchObject({ trail: 20, stop: 100 });
    expect(bei(8)).toMatchObject({ trail: 20, stop: 100 });
    // Wechsel an Bar 9 auf trail 1: hw(9) − 1 = 108 > 100 ⇒ enger ⇒ ab Bar 10 wirksam.
    expect(bei(9)).toMatchObject({ trail: 1, stop: 100 });
    expect(bei(10)).toMatchObject({ trail: 1, stop: 108 });
    expect(bei(11)).toMatchObject({ trail: 1, stop: 109 });
  });

  it('Rundreise an der Korbgrenze: Einstieg an der letzten Bar vor `params: null` füllt am Open der Grenz-Bar und wird am nächsten Open `unmanaged` geschlossen (barsHeld 1)', () => {
    const bars = tage(12, () => 100);
    const t = (k: number) => bars[k]!.t;
    const k = 5;
    const einmal = strategyOf({
      timeframes: [1440],
      decide: (snap): Decision => {
        if (snap.position) return { kind: 'hold' };
        return snap.i === k - 1 ? { kind: 'enter', side: 'long', stop: snap.bars.c[snap.i]! * 0.5, reason: 'rein' } : { kind: 'hold' };
      },
    });
    const res = simulate({
      bars: barsMap({ AAA: bars }),
      strategyFor: () => ({ strategy: einmal, params: {}, wechsel: [{ ab: t(k), params: null }] }),
      config: cfg,
      initialEquity: 100_000,
    });
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]).toMatchObject({ entryTime: t(k), exitTime: t(k + 1), exitReason: 'unmanaged', barsHeld: 1 });
    expect(res.offenAmEnde).toEqual([]);
  });
});
