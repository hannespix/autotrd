/**
 * time_series_momentum — was die Familie tut und vor allem, was sie NICHT tut.
 *
 * Die Präfix-Konsistenz (Lookahead-Wächter, §0.2) läuft in
 * test/strategy/strategies.test.ts über die Varianten-Liste. Hier stehen
 * die Regeln aus der Vorregistrierung
 * (docs/wissen/vorregistrierung/2026-09-18-zeitreihen-momentum.md): Einstieg
 * nur mit positivem Momentum ÜBER dem Regime, Ausstieg NUR über das
 * Vorzeichen mit Totband, kein Ziel, kein Trailing, das Regime ist kein
 * Ausstiegsgrund — und die dokumentierte Warmup-Decke von 152 Bars.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { buildSessionInfo } from '../../src/core/session.ts';
import { addDays, isTradingDay, msFromET } from '../../src/core/time.ts';
import type { Bar, PositionState, SymbolSnapshot } from '../../src/core/types.ts';
import { getStrategy, resolveParams } from '../../src/strategy/index.ts';

const s = getStrategy('time_series_momentum');

/** Tagesbars an echten Handelstagen aus einer Close-Reihe; Hoch/Tief ±0,3. */
function bars(closes: readonly number[]): BarSeries {
  const out: Bar[] = [];
  let d = '2024-01-02';
  for (const c of closes) {
    while (!isTradingDay(d, 'us_equity')) d = addDays(d, 1);
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    out.push({ t: msFromET(y, m, dd, 9, 30), o: c, h: c + 0.3, l: c - 0.3, c, v: 1000 });
    d = addDays(d, 1);
  }
  return BarSeries.from(out);
}
const snap = (b: BarSeries, i: number, position: PositionState | null = null): SymbolSnapshot => ({
  symbol: 'TEST',
  bars: b,
  i,
  position,
  session: buildSessionInfo(b, i, 1440, 'us_equity'),
});
const longPos = (entryPrice: number): PositionState => ({
  symbol: 'TEST',
  side: 'long',
  qty: 10,
  entryPrice,
  entryTime: 0,
  stop: entryPrice * 0.8,
  target: null,
  initialStop: entryPrice * 0.8,
  highWater: entryPrice,
  strategy: 'time_series_momentum',
  barsHeld: 30,
  entryDay: '2024-01-02',
});
const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
const ramp = (n: number, from: number, to: number) => Array.from({ length: n }, (_, k) => from + ((to - from) * k) / Math.max(1, n - 1));

const p = resolveParams(s, { lookback: 63, skip: 0, regimeLen: 50, exitBandPct: 2.5, stopPct: 20 });

describe('time_series_momentum', () => {
  it('ist rein symbolweise und nur auf Tagesbars: kein crossScore, timeframes [1440], hält über Nacht', () => {
    expect(s.crossScore).toBeUndefined();
    expect(s.timeframes).toEqual([1440]);
    expect(s.holdsOvernight).toBe(true);
  });

  it('WÄCHTER: die Warmup-Decke ist 152 Bars — darüber verschluckt das Embargo (Warmup + 20) das IS-Fenster der Plattform', () => {
    // Vorregistrierung: „Die Decke ist 152 Bars Warmup (regimeLen 150 + 2;
    // das Momentum selbst braucht 126 + 21 + 2 = 149)". Mein erster Entwurf
    // sagte 149 — dieser Test hat ihn korrigiert, nicht ich. Wer das Gitter
    // nach oben öffnet, muss diese Zahl bewusst ändern.
    const groesster = resolveParams(s, { lookback: 126, skip: 21, regimeLen: 150, exitBandPct: 5, stopPct: 30 });
    expect(s.warmupBars(groesster)).toBe(152);
    expect(s.warmupBars(p)).toBe(65);
  });

  it('Einstieg: Momentum > 0 UND Close über SMA ⇒ long mit Katastrophen-Stop stopPct unter dem Kurs, OHNE Ziel', () => {
    const b = bars([...flat(63, 100), ...ramp(40, 100, 140)]);
    const i = b.length - 1;
    const d = s.decide(snap(b, i), s.precompute(b, p), p);
    expect(d.kind).toBe('enter');
    if (d.kind !== 'enter') return;
    expect(d.side).toBe('long');
    expect(d.stop).toBeCloseTo(140 * 0.8, 6);
    expect(d.target, 'kein Kursziel — die Bewegung soll laufen').toBeUndefined();
    expect(d.reason).toMatch(/Zeitreihen-Momentum \+/);
  });

  it('kein Einstieg unter dem Regime — auch wenn das Momentum noch positiv ist (Ende 2021)', () => {
    // 63 flach, 40 aufwärts bis 140, dann fünf Tage Sturz auf 105: Momentum
    // über 63 Bars noch +5 %, aber der Close liegt tief unter der SMA50.
    const b = bars([...flat(63, 100), ...ramp(40, 100, 140), ...ramp(5, 133, 105)]);
    const i = b.length - 1;
    const ind = s.precompute(b, p);
    expect(ind.mom![i]).toBeGreaterThan(0);
    expect(b.c[i]!).toBeLessThan(ind.regime![i]!);
    expect(s.decide(snap(b, i), ind, p).kind).toBe('hold');
  });

  it('Ausstieg NUR, wenn das Momentum unter −exitBandPct fällt — innerhalb des Totbands wird gehalten', () => {
    // Von 100 auf 97 über 63 Bars: Momentum genau −3 %.
    const b = bars([...flat(63, 100), ...ramp(63, 100, 97)]);
    const i = b.length - 1;
    const ind = s.precompute(b, p);
    expect(ind.mom![i]).toBeCloseTo(-0.03, 6);
    // Band 2,5 %: −3 % liegt darunter ⇒ raus.
    expect(s.decide(snap(b, i, longPos(100)), ind, p).kind).toBe('exit');
    // Band 5 %: −3 % liegt im Totband ⇒ halten.
    const weit = resolveParams(s, { ...p, exitBandPct: 5 });
    expect(s.decide(snap(b, i, longPos(100)), s.precompute(b, weit), weit).kind).toBe('hold');
    // Band 0: jeder Vorzeichenwechsel ⇒ raus.
    const eng = resolveParams(s, { ...p, exitBandPct: 0 });
    expect(s.decide(snap(b, i, longPos(100)), s.precompute(b, eng), eng).kind).toBe('exit');
  });

  it('WÄCHTER: das Regime ist KEIN Ausstiegsgrund, und es gibt kein Trailing — eine Position im Plus unter der SMA wird gehalten', () => {
    // Aufwärts, dann ein Rücksetzer unter die SMA50, aber Momentum über 63
    // Bars klar positiv: halten, nicht move_stop, nicht exit.
    const b = bars([...flat(63, 100), ...ramp(40, 100, 140), ...ramp(5, 133, 118)]);
    const i = b.length - 1;
    const ind = s.precompute(b, p);
    expect(b.c[i]!).toBeLessThan(ind.regime![i]!);
    expect(ind.mom![i]).toBeGreaterThan(0);
    const d = s.decide(snap(b, i, longPos(100)), ind, p);
    expect(d.kind, 'Regime-Exit oder Trailing würden den Umschlag verdoppeln — beides ist vorregistriert ausgeschlossen').toBe('hold');
  });

  it('in der Aufwärmphase: weder Einstieg noch Ausstieg (NaN heißt halten)', () => {
    const b = bars(ramp(40, 100, 140));
    const i = b.length - 1;
    const ind = s.precompute(b, p);
    expect(s.decide(snap(b, i), ind, p).kind).toBe('hold');
    expect(s.decide(snap(b, i, longPos(100)), ind, p).kind).toBe('hold');
  });
});
