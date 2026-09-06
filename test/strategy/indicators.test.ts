/**
 * Indikator-Tests: Handrechnungen, naive Referenz-Implementierungen (O(n·k))
 * gegen die optimierten Varianten, NaN-Verhalten, Präfix-Konsistenz
 * (Lookahead-Wächter) und Determinismus.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { DAY, MIN, msFromET } from '../../src/core/time.ts';
import type { Bar, PositionState } from '../../src/core/types.ts';
import {
  adx,
  atr,
  atrBracket,
  barOfDay,
  benchmarkAllows,
  bracketFromStop,
  cachedCloseSma,
  crossDown,
  crossUp,
  dayIndex,
  ema,
  indAt,
  nanFill,
  roc,
  rollingMax,
  rollingMin,
  rsi,
  sessionVwap,
  sma,
  stddev,
  trailingStop,
  trueRange,
  zscore,
} from '../../src/strategy/indicators.ts';

/* ───────────────────────── Hilfen ───────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBars(n: number, seed: number): BarSeries {
  const rnd = mulberry32(seed);
  const out: Bar[] = [];
  let c = 100;
  const t0 = msFromET(2025, 1, 2, 9, 30);
  for (let i = 0; i < n; i++) {
    const o = c;
    c = Math.max(1, c * (1 + (rnd() - 0.48) * 0.04));
    const h = Math.max(o, c) + rnd() * 0.5;
    const l = Math.min(o, c) - rnd() * 0.5;
    out.push({ t: t0 + i * DAY, o, h, l, c, v: 1000 + Math.floor(rnd() * 5000) });
  }
  return BarSeries.from(out);
}

const F = (xs: number[]): Float64Array => Float64Array.from(xs);
const N = Number.NaN;

function expectSeries(actual: Float64Array, expected: ArrayLike<number>, tol = 1e-9): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!;
    const e = expected[i]!;
    if (Number.isNaN(e)) {
      expect(Number.isNaN(a), `Index ${i}: erwartet NaN, ist ${a}`).toBe(true);
    } else {
      expect(Math.abs(a - e) <= tol * Math.max(1, Math.abs(e)), `Index ${i}: erwartet ${e}, ist ${a}`).toBe(true);
    }
  }
}

/* ───────────────────────── Naive Referenzen ───────────────────────── */

function naiveSma(x: ArrayLike<number>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i < n - 1) {
      out.push(N);
      continue;
    }
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += x[k]!;
    out.push(s / n);
  }
  return out;
}

function naiveEma(x: ArrayLike<number>, n: number): number[] {
  const out: number[] = [];
  const alpha = 2 / (n + 1);
  let prev = N;
  for (let i = 0; i < x.length; i++) {
    if (i < n - 1) {
      out.push(N);
      continue;
    }
    if (i === n - 1) {
      let s = 0;
      for (let k = 0; k < n; k++) s += x[k]!;
      prev = s / n;
    } else prev = alpha * x[i]! + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

function naiveRsi(c: ArrayLike<number>, n: number): number[] {
  const out: number[] = [N];
  let g = 0;
  let l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    if (i <= n) {
      g += Math.max(d, 0);
      l += Math.max(-d, 0);
      if (i < n) {
        out.push(N);
        continue;
      }
      g /= n;
      l /= n;
    } else {
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
    }
    out.push(g + l === 0 ? 50 : 100 - 100 / (1 + g / l));
  }
  return out;
}

function naiveTr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.length; i++) {
    if (i === 0) out.push(h[0]! - l[0]!);
    else out.push(Math.max(h[i]! - l[i]!, Math.abs(h[i]! - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!)));
  }
  return out;
}

function naiveAtr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n: number): number[] {
  const tr = naiveTr(h, l, c);
  const out: number[] = [];
  let prev = N;
  for (let i = 0; i < tr.length; i++) {
    if (i < n - 1) {
      out.push(N);
      continue;
    }
    if (i === n - 1) prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else prev = (prev * (n - 1) + tr[i]!) / n;
    out.push(prev);
  }
  return out;
}

function naiveRollingExt(x: ArrayLike<number>, n: number, max: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i < n) {
      out.push(N);
      continue;
    }
    let m = max ? -Infinity : Infinity;
    for (let k = i - n; k <= i - 1; k++) m = max ? Math.max(m, x[k]!) : Math.min(m, x[k]!);
    out.push(m);
  }
  return out;
}

function naiveStd(x: ArrayLike<number>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (i < n - 1) {
      out.push(N);
      continue;
    }
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += x[k]!;
    const mean = s / n;
    let v = 0;
    for (let k = i - n + 1; k <= i; k++) v += (x[k]! - mean) ** 2;
    out.push(Math.sqrt(v / n));
  }
  return out;
}

/* ───────────────────────── Handrechnungen ───────────────────────── */

describe('Indikatoren: Handrechnungen', () => {
  it('sma(3) über 1..5', () => {
    expectSeries(sma(F([1, 2, 3, 4, 5]), 3), [N, N, 2, 3, 4]);
  });

  it('ema(3): Seed ist die SMA der ersten drei Werte, danach α = 0.5', () => {
    // Seed an Index 2 = (1+2+3)/3 = 2; dann 2 + 0.5·(4−2) = 3; 3 + 0.5·(5−3) = 4.
    expectSeries(ema(F([1, 2, 3, 4, 5]), 3), [N, N, 2, 3, 4]);
    expectSeries(ema(F([7, 9, 11]), 1), [7, 9, 11]);
  });

  it('rsi(3) nach Wilder: erste Mittel einfach, danach (avg·(n−1)+x)/n', () => {
    // Änderungen: +1, −0.5, +1, +0.5, −1
    // i=3: avgG = 2/3, avgL = 1/6 → RS 4 → 80
    // i=4: avgG = (2/3·2+0.5)/3 = 11/18, avgL = (1/6·2)/3 = 1/9 → RS 5.5 → 84.615…
    // i=5: avgG = 11/27, avgL = (1/9·2+1)/3 = 11/27 → RS 1 → 50
    expectSeries(rsi(F([10, 11, 10.5, 11.5, 12, 11]), 3), [N, N, N, 80, 100 - 100 / 6.5, 50]);
  });

  it('rsi: nur Gewinne ⇒ 100, nur Verluste ⇒ 0, flach ⇒ 50', () => {
    expectSeries(rsi(F([1, 2, 3, 4]), 2), [N, N, 100, 100]);
    expectSeries(rsi(F([4, 3, 2, 1]), 2), [N, N, 0, 0]);
    expectSeries(rsi(F([5, 5, 5, 5]), 2), [N, N, 50, 50]);
  });

  it('trueRange und atr(3) von Hand', () => {
    const h = F([10, 11, 12, 13, 11]);
    const l = F([8, 9, 9, 12, 10]);
    const c = F([9, 10, 11, 12.5, 10.5]);
    expectSeries(trueRange(h, l, c), [2, 2, 3, 2, 2.5]);
    // ATR[2] = 7/3; ATR[3] = (7/3·2+2)/3 = 20/9; ATR[4] = (20/9·2+2.5)/3 = 62.5/27
    expectSeries(atr(h, l, c, 3), [N, N, 7 / 3, 20 / 9, 62.5 / 27]);
  });

  it('rollingMax/rollingMin nehmen die VORHERIGEN n Bars, exklusive der aktuellen', () => {
    expectSeries(rollingMax(F([1, 3, 2, 5, 4]), 2), [N, N, 3, 3, 5]);
    expectSeries(rollingMin(F([1, 3, 2, 5, 4]), 2), [N, N, 1, 2, 2]);
    // Der aktuelle Wert darf das Fenster nie beeinflussen — sonst gäbe es keine Ausbrüche.
    const x = F([1, 2, 3, 4, 100]);
    expect(rollingMax(x, 3)[4]).toBe(4);
  });

  it('stddev ist Populations-σ; zscore = (x − sma)/σ; σ = 0 ⇒ NaN', () => {
    expectSeries(stddev(F([1, 3]), 2), [N, 1]);
    expectSeries(zscore(F([1, 3]), 2), [N, 1]);
    expectSeries(stddev(F([2, 4, 4, 4, 5, 5, 7, 9]), 8), [N, N, N, N, N, N, N, 2]);
    expectSeries(zscore(F([5, 5, 5]), 3), [N, N, N]);
  });

  it('roc(2)', () => {
    expectSeries(roc(F([10, 11, 12, 9]), 2), [N, N, 0.2, 9 / 11 - 1]);
    expectSeries(roc(F([0, 1, 2]), 1), [N, N, 1]);
  });

  it('crossUp/crossDown — mit Serie und mit Konstante', () => {
    expectSeries(crossUp(F([1, 2, 3]), F([2, 2, 2])), [N, 1, 0]);
    expectSeries(crossUp(F([1, 2, 3]), 2), [N, 1, 0]);
    expectSeries(crossDown(F([3, 2, 1]), 2), [N, 1, 0]);
    // Berührung von oben ist keine Aufwärtskreuzung.
    expectSeries(crossUp(F([2, 2, 2]), 2), [N, 0, 0]);
    expectSeries(crossUp(F([N, 1, 3]), 2), [N, N, 1]);
  });

  it('sessionVwap startet je ET-Tag neu', () => {
    const d1 = msFromET(2026, 3, 2, 9, 30);
    const d2 = msFromET(2026, 3, 3, 9, 30);
    const bars = BarSeries.from([
      { t: d1, o: 10, h: 12, l: 9, c: 9, v: 100 }, // tp 10
      { t: d1 + 5 * MIN, o: 9, h: 15, l: 12, c: 12, v: 300 }, // tp 13
      { t: d2, o: 12, h: 21, l: 18, c: 21, v: 50 }, // tp 20
    ]);
    expectSeries(sessionVwap(bars), [10, (10 * 100 + 13 * 300) / 400, 20]);
  });

  it('dayIndex/barOfDay zählen nach ET-Tag', () => {
    const d1 = msFromET(2026, 3, 2, 9, 30);
    const d2 = msFromET(2026, 3, 3, 9, 30);
    const t = F([d1, d1 + 5 * MIN, d1 + 10 * MIN, d2, d2 + 5 * MIN]);
    expectSeries(dayIndex(t), [0, 0, 0, 1, 1]);
    expectSeries(barOfDay(t), [0, 1, 2, 0, 1]);
  });

  it('adx: flache Serie ⇒ 0, gerade Aufwärtslinie ⇒ 100, Warmup bis 2n−2', () => {
    const n = 5;
    const len = 30;
    const flat = new Float64Array(len).fill(10);
    const a0 = adx(flat, flat, flat, n);
    for (let i = 0; i < len; i++) {
      if (i < 2 * n - 1) expect(Number.isNaN(a0[i]!)).toBe(true);
      else expect(a0[i]).toBe(0);
    }
    const h = Float64Array.from({ length: len }, (_, i) => 101 + i);
    const l = Float64Array.from({ length: len }, (_, i) => 99 + i);
    const c = Float64Array.from({ length: len }, (_, i) => 100 + i);
    const a1 = adx(h, l, c, n);
    expect(a1[2 * n - 1]).toBeCloseTo(100, 9);
    expect(a1[len - 1]).toBeCloseTo(100, 9);
  });

  it('nanFill und indAt', () => {
    expectSeries(nanFill(F([1, N, 3]), 0), [1, 0, 3]);
    const ind = { a: F([1, 2]) };
    expect(indAt(ind, 'a', 1)).toBe(2);
    expect(Number.isNaN(indAt(ind, 'a', 2))).toBe(true);
    expect(Number.isNaN(indAt(ind, 'b', 0))).toBe(true);
  });

  it('Fensterlängen müssen ganzzahlig ≥ 1 sein', () => {
    expect(() => sma(F([1, 2]), 0)).toThrow(RangeError);
    expect(() => ema(F([1, 2]), 1.5)).toThrow(RangeError);
    expect(() => rollingMax(F([1, 2]), -1)).toThrow(RangeError);
  });
});

/* ───────────────────────── Referenz-Vergleich ───────────────────────── */

describe('Indikatoren: optimierte Implementierung == naive Referenz', () => {
  const bars = randomBars(400, 7);
  const c = bars.c;

  it('sma', () => {
    for (const n of [1, 2, 5, 20, 100]) expectSeries(sma(c, n), naiveSma(c, n));
  });
  it('ema', () => {
    for (const n of [1, 3, 10, 50]) expectSeries(ema(c, n), naiveEma(c, n));
  });
  it('rsi', () => {
    for (const n of [2, 6, 14]) expectSeries(rsi(c, n), naiveRsi(c, n));
  });
  it('atr', () => {
    for (const n of [1, 7, 14, 21]) expectSeries(atr(bars.h, bars.l, bars.c, n), naiveAtr(bars.h, bars.l, bars.c, n));
  });
  it('rollingMax/rollingMin (monotone Deque)', () => {
    for (const n of [1, 2, 10, 20, 60]) {
      expectSeries(rollingMax(bars.h, n), naiveRollingExt(bars.h, n, true));
      expectSeries(rollingMin(bars.l, n), naiveRollingExt(bars.l, n, false));
    }
    // Serie mit vielen Gleichständen und Plateaus
    const plateau = F([5, 5, 5, 3, 3, 8, 8, 8, 1, 1, 9, 5, 5]);
    for (const n of [1, 2, 3, 4]) {
      expectSeries(rollingMax(plateau, n), naiveRollingExt(plateau, n, true));
      expectSeries(rollingMin(plateau, n), naiveRollingExt(plateau, n, false));
    }
  });
  it('stddev/zscore', () => {
    for (const n of [2, 10, 20, 30]) {
      const sd = naiveStd(c, n);
      const mean = naiveSma(c, n);
      expectSeries(stddev(c, n), sd, 1e-8);
      const z = mean.map((m, i) => (Number.isNaN(m) || sd[i] === 0 ? N : (c[i]! - m) / sd[i]!));
      expectSeries(zscore(c, n), z, 1e-8);
    }
  });
  it('stddev bleibt bei großen Kursniveaus genau (Versatz-Summen)', () => {
    const big = Float64Array.from(c, (v) => v + 50_000);
    expectSeries(stddev(big, 20), naiveStd(big, 20), 1e-7);
  });
});

/* ───────────────────────── NaN-Verhalten ───────────────────────── */

describe('Indikatoren: NaN-Verhalten', () => {
  it('sma: NaN im Fenster ⇒ NaN, danach Erholung', () => {
    expectSeries(sma(F([1, 2, N, 4, 5, 6]), 2), [N, 1.5, N, N, 4.5, 5.5]);
  });
  it('ema: führende NaN werden übersprungen (Verkettung ema(rsi))', () => {
    const c = randomBars(60, 3).c;
    const r = rsi(c, 14);
    const e = ema(r, 5);
    for (let i = 0; i < 18; i++) expect(Number.isNaN(e[i]!)).toBe(true);
    expect(Number.isFinite(e[18]!)).toBe(true);
    // Seed = SMA der ersten fünf endlichen RSI-Werte (Index 14..18)
    let s = 0;
    for (let k = 14; k <= 18; k++) s += r[k]!;
    expect(e[18]).toBeCloseTo(s / 5, 12);
  });
  it('rollingMax: NaN im Fenster ⇒ NaN', () => {
    expectSeries(rollingMax(F([1, N, 3, 4, 5]), 2), [N, N, N, N, 4]);
  });
  it('rsi/atr tragen NaN-Kurse weiter statt sie als 0 zu zählen', () => {
    const r = rsi(F([1, 2, N, 4, 5, 6, 7]), 2);
    expect(Number.isNaN(r[3]!)).toBe(true);
    expect(Number.isNaN(r[6]!)).toBe(true);
  });
});

/* ───────────────────────── Präfix-Konsistenz & Determinismus ───────────────────────── */

describe('Indikatoren: Präfix-Konsistenz (Lookahead-Wächter)', () => {
  const bars = randomBars(300, 11);
  const probes = [0, 1, 2, 13, 14, 15, 19, 20, 21, 27, 28, 99, 100, 101, 150, 199, 200, 201, 250, 298, 299];

  const fns: Record<string, (b: BarSeries) => Float64Array> = {
    sma20: (b) => sma(b.c, 20),
    ema20: (b) => ema(b.c, 20),
    ema100: (b) => ema(b.c, 100),
    rsi14: (b) => rsi(b.c, 14),
    rsi2: (b) => rsi(b.c, 2),
    tr: (b) => trueRange(b.h, b.l, b.c),
    atr14: (b) => atr(b.h, b.l, b.c, 14),
    adx14: (b) => adx(b.h, b.l, b.c, 14),
    rollingMax20: (b) => rollingMax(b.h, 20),
    rollingMin10: (b) => rollingMin(b.l, 10),
    stddev20: (b) => stddev(b.c, 20),
    zscore20: (b) => zscore(b.c, 20),
    roc10: (b) => roc(b.c, 10),
    crossUp: (b) => crossUp(ema(b.c, 5), ema(b.c, 20)),
    crossDown: (b) => crossDown(ema(b.c, 5), ema(b.c, 20)),
    vwap: (b) => sessionVwap(b),
    dayIndex: (b) => dayIndex(b.t),
    barOfDay: (b) => barOfDay(b.t),
    emaOfRsi: (b) => ema(rsi(b.c, 14), 5),
  };

  for (const [name, fn] of Object.entries(fns)) {
    it(`${name}: Wert an i hängt nur von Bars ≤ i ab`, () => {
      const full = fn(bars);
      for (const i of probes) {
        const pre = fn(bars.prefix(i + 1));
        expect(pre.length).toBe(i + 1);
        expect(Object.is(pre[i], full[i]), `${name}[${i}]: Präfix ${pre[i]} vs voll ${full[i]}`).toBe(true);
      }
    });
  }

  it('Determinismus: zweimal rechnen ⇒ identische Arrays', () => {
    for (const fn of Object.values(fns)) expect(fn(bars)).toEqual(fn(bars));
  });
});

/* ───────────────────────── Entscheidungs-Bausteine ───────────────────────── */

function pos(over: Partial<PositionState> = {}): PositionState {
  return {
    symbol: 'X',
    side: 'long',
    qty: 1,
    entryPrice: 100,
    entryTime: 0,
    stop: 95,
    target: null,
    initialStop: 95,
    highWater: 100,
    strategy: 't',
    barsHeld: 0,
    entryDay: '2026-01-02',
    ...over,
  };
}

describe('Entscheidungs-Bausteine', () => {
  it('atrBracket: Stop auf der Verlustseite, Ziel nur mit rrMult > 0', () => {
    expect(atrBracket(100, 2, 2.5, 0, 'long')).toEqual({ stop: 95, target: null });
    expect(atrBracket(100, 2, 2.5, 2, 'long')).toEqual({ stop: 95, target: 110 });
    expect(atrBracket(100, 2, 2.5, 2, 'short')).toEqual({ stop: 105, target: 90 });
    expect(atrBracket(100, N, 2.5, 2, 'long')).toBeNull();
    expect(atrBracket(100, 0, 2.5, 2, 'long')).toBeNull();
    // Stop ≤ 0 (winzige Kurse, riesige ATR) ⇒ kein Bracket ⇒ kein Einstieg.
    expect(atrBracket(1, 1, 2, 0, 'long')).toBeNull();
  });

  it('bracketFromStop: Stop muss auf der Verlustseite liegen', () => {
    expect(bracketFromStop(101.5, 99, 2, 'long')).toEqual({ stop: 99, target: 106.5 });
    expect(bracketFromStop(98.5, 101, 2, 'short')).toEqual({ stop: 101, target: 93.5 });
    expect(bracketFromStop(100, 100, 2, 'long')).toBeNull();
    expect(bracketFromStop(100, 102, 2, 'long')).toBeNull();
    expect(bracketFromStop(100, N, 2, 'long')).toBeNull();
  });

  it('trailingStop: erst im Plus, nur enger, nur unter dem Kurs (Long)', () => {
    // Nicht im Plus (Hochwasser = Einstand) ⇒ nichts.
    expect(trailingStop(pos({ highWater: 100 }), 100, 2, 3)).toBeNull();
    // Im Plus: 110 − 3·2 = 104 > 95 ⇒ nachziehen.
    expect(trailingStop(pos({ highWater: 110 }), 109, 2, 3)).toBe(104);
    // Nicht enger als bestehender Stop ⇒ nichts.
    expect(trailingStop(pos({ highWater: 110, stop: 105 }), 109, 2, 3)).toBeNull();
    // Kandidat über dem Kurs ⇒ nichts (das ist Sache des Stops beim Broker).
    expect(trailingStop(pos({ highWater: 110 }), 103, 2, 3)).toBeNull();
    // Ohne bestehenden Stop ist jede Marke enger.
    expect(trailingStop(pos({ highWater: 110, stop: null }), 109, 2, 3)).toBe(104);
    // trailMult 0 / ATR NaN ⇒ aus.
    expect(trailingStop(pos({ highWater: 110 }), 109, 2, 0)).toBeNull();
    expect(trailingStop(pos({ highWater: 110 }), 109, N, 3)).toBeNull();
  });

  it('trailingStop: Short gespiegelt', () => {
    const s = pos({ side: 'short', entryPrice: 100, stop: 105, highWater: 100 });
    expect(trailingStop(s, 100, 2, 3)).toBeNull();
    expect(trailingStop({ ...s, highWater: 90 }, 91, 2, 3)).toBe(96);
    expect(trailingStop({ ...s, highWater: 90, stop: 95 }, 91, 2, 3)).toBeNull();
    expect(trailingStop({ ...s, highWater: 90 }, 97, 2, 3)).toBeNull();
  });

  it('benchmarkAllows: ohne Benchmark true, in der Aufwärmphase false, sonst Close vs SMA', () => {
    expect(benchmarkAllows(undefined, 200, 'long')).toBe(true);
    const bench = randomBars(50, 5);
    expect(benchmarkAllows({ bars: bench, i: 5 }, 20, 'long')).toBe(false);
    const m = sma(bench.c, 20);
    for (const i of [19, 30, 49]) {
      const above = bench.c[i]! > m[i]!;
      expect(benchmarkAllows({ bars: bench, i }, 20, 'long')).toBe(above);
      expect(benchmarkAllows({ bars: bench, i }, 20, 'short')).toBe(!above);
    }
    expect(benchmarkAllows({ bars: bench, i: 50 }, 20, 'long')).toBe(false);
    expect(benchmarkAllows({ bars: bench, i: -1 }, 20, 'long')).toBe(false);
  });

  it('cachedCloseSma: je (Serie, Länge) einmal; Präfix-Sicht ist ein eigener Schlüssel', () => {
    const bench = randomBars(50, 9);
    const a = cachedCloseSma(bench, 20);
    expect(cachedCloseSma(bench, 20)).toBe(a);
    expect(cachedCloseSma(bench, 10)).not.toBe(a);
    const pre = bench.prefix(30);
    const b = cachedCloseSma(pre, 20);
    expect(b).not.toBe(a);
    expect(b.length).toBe(30);
    expect(Object.is(b[29], a[29])).toBe(true);
  });
});
