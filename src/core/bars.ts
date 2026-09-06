/**
 * Kolumnare Bar-Serien und Aggregation.
 *
 * Grundsatz: Es werden NUR 1-Minuten-Bars (bzw. Tagesbars) vom Broker
 * geladen; jeder höhere Zeitrahmen entsteht lokal über `aggregate()` —
 * im Backtest wie live mit derselben Funktion. So sind Bucket-Grenzen
 * garantiert identisch, und der Backtest sieht exakt die Bars, die die
 * Engine sehen würde.
 */
import type { AssetClass, Bar, BarSeriesLike, Ms, TimeframeMin } from './types.ts';
import { bucketStart, dayKey, sessionBounds, type Calendar, type SessionBounds } from './time.ts';

export class BarSeries implements BarSeriesLike {
  readonly length: number;
  readonly t: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;
  constructor(t: Float64Array, o: Float64Array, h: Float64Array, l: Float64Array, c: Float64Array, v: Float64Array) {
    for (const col of [o, h, l, c, v]) {
      if (col.length !== t.length) throw new Error('BarSeries: Spaltenlängen ungleich');
    }
    this.t = t;
    this.o = o;
    this.h = h;
    this.l = l;
    this.c = c;
    this.v = v;
    this.length = t.length;
  }

  static from(bars: readonly Bar[]): BarSeries {
    const n = bars.length;
    const t = new Float64Array(n);
    const o = new Float64Array(n);
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    const c = new Float64Array(n);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const b = bars[i]!;
      if (i > 0 && b.t <= t[i - 1]!) throw new Error(`BarSeries: Zeit nicht streng steigend bei Index ${i}`);
      t[i] = b.t;
      o[i] = b.o;
      h[i] = b.h;
      l[i] = b.l;
      c[i] = b.c;
      v[i] = b.v;
    }
    return new BarSeries(t, o, h, l, c, v);
  }

  static empty(): BarSeries {
    const z = new Float64Array(0);
    return new BarSeries(z, z, z, z, z, z);
  }

  at(i: number): Bar {
    if (i < 0 || i >= this.length) throw new RangeError(`BarSeries.at(${i}) außerhalb [0, ${this.length})`);
    return { t: this.t[i]!, o: this.o[i]!, h: this.h[i]!, l: this.l[i]!, c: this.c[i]!, v: this.v[i]! };
  }

  /** Präfix-Sicht (teilt den Speicher — kein Kopieren). */
  prefix(n: number): BarSeries {
    const m = Math.max(0, Math.min(n, this.length));
    return new BarSeries(
      this.t.subarray(0, m),
      this.o.subarray(0, m),
      this.h.subarray(0, m),
      this.l.subarray(0, m),
      this.c.subarray(0, m),
      this.v.subarray(0, m),
    );
  }

  /** Teilserie [from, to) als Kopie. */
  slice(from: number, to = this.length): BarSeries {
    return new BarSeries(
      this.t.slice(from, to),
      this.o.slice(from, to),
      this.h.slice(from, to),
      this.l.slice(from, to),
      this.c.slice(from, to),
      this.v.slice(from, to),
    );
  }

  toBars(): Bar[] {
    const out: Bar[] = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.at(i);
    return out;
  }

  last(): Bar | null {
    return this.length ? this.at(this.length - 1) : null;
  }

  /** Index der letzten Bar mit t <= ms (binäre Suche); -1 wenn keine. */
  indexAtOrBefore(ms: Ms): number {
    let lo = 0;
    let hi = this.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid]! <= ms) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Neue Serie mit angehängter Bar (Kopie). Für den Live-Pfad je geschlossener Bar. */
  append(b: Bar): BarSeries {
    if (this.length && b.t <= this.t[this.length - 1]!) throw new Error('append: Zeit nicht steigend');
    const n = this.length + 1;
    const grow = (col: Float64Array, val: number) => {
      const out = new Float64Array(n);
      out.set(col);
      out[n - 1] = val;
      return out;
    };
    return new BarSeries(grow(this.t, b.t), grow(this.o, b.o), grow(this.h, b.h), grow(this.l, b.l), grow(this.c, b.c), grow(this.v, b.v));
  }
}

/* ───────────────────────── Aggregation ───────────────────────── */

export interface AggregateOptions {
  tf: TimeframeMin;
  assetClass: AssetClass;
  calendar?: Calendar | undefined;
  /** Nur Buckets aufnehmen, die vollständig geschlossen sind (Ende <= closedBefore). */
  closedBefore?: Ms | undefined;
}

/**
 * Aggregiert Minuten-Bars (oder Tagesbars bei tf=1440 aus Minuten-Bars)
 * zu Buckets des Zeitrahmens. Minuten außerhalb der Sitzung werden
 * verworfen (Aktien). Ein Bucket existiert nur, wenn mindestens eine
 * Quell-Bar hineinfällt — Lücken bleiben Lücken.
 */
export function aggregate(minuteBars: readonly Bar[], opts: AggregateOptions): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curEnd = 0;
  let boundsDay = '';
  let bounds: SessionBounds | null = null;

  const flush = () => {
    if (cur && (opts.closedBefore === undefined || curEnd <= opts.closedBefore)) out.push(cur);
    cur = null;
  };

  for (const b of minuteBars) {
    const day = dayKey(b.t);
    if (day !== boundsDay) {
      boundsDay = day;
      bounds = sessionBounds(day, opts.assetClass, opts.calendar);
    }
    if (!bounds) continue;
    const start = bucketStart(b.t, opts.tf, bounds);
    if (start === null) continue;
    if (cur && cur.t === start) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      if (b.vw !== undefined && cur.vw !== undefined) {
        // volumengewichtet fortschreiben
        const totalV = cur.v;
        const prevV = totalV - b.v;
        cur.vw = totalV > 0 ? (cur.vw * prevV + b.vw * b.v) / totalV : b.vw;
      }
      if (b.n !== undefined && cur.n !== undefined) cur.n += b.n;
    } else {
      flush();
      cur = { t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      if (b.vw !== undefined) cur.vw = b.vw;
      if (b.n !== undefined) cur.n = b.n;
      curEnd = opts.tf === 1440 ? bounds.close : Math.min(start + opts.tf * 60_000, bounds.close);
    }
  }
  flush();
  return out;
}

/** Nur Bars innerhalb der regulären Sitzung (Aktien); Krypto unverändert. */
export function filterRegularSession(bars: readonly Bar[], assetClass: AssetClass, calendar?: Calendar): Bar[] {
  if (assetClass === 'crypto') return [...bars];
  const out: Bar[] = [];
  let boundsDay = '';
  let bounds: SessionBounds | null = null;
  for (const b of bars) {
    const day = dayKey(b.t);
    if (day !== boundsDay) {
      boundsDay = day;
      bounds = sessionBounds(day, assetClass, calendar);
    }
    if (!bounds) continue;
    if (b.t >= bounds.open && b.t < bounds.close) out.push(b);
  }
  return out;
}

/** Bars strikt nach Zeit sortieren und Duplikate (gleiches t) auf die letzte Version reduzieren. */
export function normalizeBars(bars: readonly Bar[]): Bar[] {
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const out: Bar[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && last.t === b.t) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}
