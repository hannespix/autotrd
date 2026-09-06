/**
 * Indikatoren auf Float64Array-Spalten — alle kausal (der Wert an Index i
 * nutzt ausschließlich Bars ≤ i), O(n), ohne Allokation je Bar außer dem
 * Ergebnis. Die Aufwärmphase ist NaN.
 *
 * Warum NaN statt 0 oder „bester Schätzwert": In der Aufwärmphase darf
 * keine Strategie handeln. NaN macht jeden Vergleich zu `false` und lässt
 * Lookahead-Fehler im Präfix-Test (test/strategy) sofort auffallen.
 *
 * Fenster-Konventionen:
 *   - sma/stddev/zscore: Fenster [i-n+1, i] — inklusive der aktuellen Bar.
 *   - rollingMax/rollingMin: Fenster [i-n, i-1] — die VORHERIGEN n Bars,
 *     exklusive der aktuellen (Donchian: „Close über dem Hoch der letzten n
 *     Bars" muss die eigene Bar ausschließen, sonst ist es nie ein Ausbruch).
 *   - Enthält ein Fenster einen nicht-endlichen Wert, ist das Ergebnis NaN;
 *     Rekursionen (EMA/RSI/ATR) tragen NaN weiter. Nichts wird stillschweigend
 *     als 0 gezählt.
 *
 * Der zweite Teil der Datei bündelt die Entscheidungs-Bausteine, die alle
 * Strategie-Vorlagen teilen (ATR-Bracket, Trailing-Regel, Benchmark-Filter).
 * Sie liegen hier und nicht in einer eigenen Datei, weil `index.ts` die
 * Vorlagen importiert — ein Import in die Gegenrichtung wäre ein Zyklus.
 */
import type { BarSeriesLike, Decision, IndicatorSet, PositionState, Side, SymbolSnapshot } from '../core/types.ts';
import { dayKey } from '../core/time.ts';

/** Eingabespalte: Float64Array oder ein beliebiges zahlenwertiges Array. */
export type Series = ArrayLike<number>;

const NaN_ = Number.NaN;

function checkWindow(n: number, fn: string): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`${fn}: Fensterlänge muss ganzzahlig ≥ 1 sein (ist ${n})`);
  }
}

function checkSameLength(fn: string, ...cols: Series[]): number {
  const len = cols[0]?.length ?? 0;
  for (const c of cols) {
    if (c.length !== len) throw new RangeError(`${fn}: Spaltenlängen ungleich (${cols.map((x) => x.length).join(', ')})`);
  }
  return len;
}

/** Neues Array voller NaN. */
export function nanArray(len: number): Float64Array {
  const out = new Float64Array(len);
  out.fill(NaN_);
  return out;
}

/* ───────────────────────── Gleitende Mittel ───────────────────────── */

/** Einfacher gleitender Durchschnitt über [i-n+1, i]. */
export function sma(x: Series, n: number): Float64Array {
  checkWindow(n, 'sma');
  const len = x.length;
  const out = nanArray(len);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    if (Number.isFinite(v)) sum += v;
    else bad++;
    if (i >= n) {
      const u = x[i - n]!;
      if (Number.isFinite(u)) sum -= u;
      else bad--;
    }
    if (i >= n - 1 && bad === 0) out[i] = sum / n;
  }
  return out;
}

/**
 * Exponentieller Durchschnitt, α = 2/(n+1). Seed ist die SMA der ersten n
 * endlichen Werte (führende NaN — etwa aus einem verketteten Indikator —
 * werden übersprungen; ein NaN innerhalb des Seed-Fensters setzt den Seed
 * zurück). Nach dem Seed lässt ein NaN-Eingang den Zustand unverändert und
 * liefert NaN.
 */
export function ema(x: Series, n: number): Float64Array {
  checkWindow(n, 'ema');
  const len = x.length;
  const out = nanArray(len);
  const alpha = 2 / (n + 1);
  let seedSum = 0;
  let seedCount = 0;
  let seeded = false;
  let prev = NaN_;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) {
      if (!seeded) {
        seedSum = 0;
        seedCount = 0;
      }
      continue;
    }
    if (!seeded) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        seeded = true;
        out[i] = prev;
      }
      continue;
    }
    prev = prev + alpha * (v - prev);
    out[i] = prev;
  }
  return out;
}

/* ───────────────────────── Wilder-Familie ───────────────────────── */

function rsiOf(avgGain: number, avgLoss: number): number {
  const total = avgGain + avgLoss;
  // Beide Mittel 0 (völlig flache Kurse): kein Informationsgehalt → neutral.
  if (total === 0) return 50;
  return (100 * avgGain) / total;
}

/**
 * RSI nach Wilder: die ersten Mittel von Gewinn und Verlust sind einfache
 * Durchschnitte der ersten n Änderungen (erster Wert an Index n), danach
 * avg = (avg·(n−1) + x)/n. Das ist NICHT die pandas-`ewm`-Variante, die
 * mit dem ersten Wert seedet — beide konvergieren, aber die Aufwärmwerte
 * unterscheiden sich, und Aufwärmwerte entscheiden über Einstiege.
 */
export function rsi(close: Series, n: number): Float64Array {
  checkWindow(n, 'rsi');
  const len = close.length;
  const out = nanArray(len);
  let sumGain = 0;
  let sumLoss = 0;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < len; i++) {
    const d = close[i]! - close[i - 1]!;
    // Math.max trägt NaN weiter — ein NaN-Kurs darf nicht als „0 Änderung" zählen.
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);
    if (i <= n) {
      sumGain += gain;
      sumLoss += loss;
      if (i === n) {
        avgGain = sumGain / n;
        avgLoss = sumLoss / n;
        out[i] = rsiOf(avgGain, avgLoss);
      }
      continue;
    }
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[i] = rsiOf(avgGain, avgLoss);
  }
  return out;
}

/** True Range. An Index 0 gibt es keinen Vorschluss — dort zählt die reine Spanne h−l. */
export function trueRange(h: Series, l: Series, c: Series): Float64Array {
  const len = checkSameLength('trueRange', h, l, c);
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const hl = h[i]! - l[i]!;
    if (i === 0) {
      out[i] = hl;
      continue;
    }
    const pc = c[i - 1]!;
    out[i] = Math.max(hl, Math.abs(h[i]! - pc), Math.abs(l[i]! - pc));
  }
  return out;
}

/** Wilder-Glättung einer Serie: Seed = Mittel der ersten n Werte (Index n−1), danach (prev·(n−1)+x)/n. */
function wilderSmooth(x: Series, n: number): Float64Array {
  const len = x.length;
  const out = nanArray(len);
  let sum = 0;
  let prev = NaN_;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    if (i < n) {
      sum += v;
      if (i === n - 1) {
        prev = sum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

/** Average True Range nach Wilder (erster Wert an Index n−1). */
export function atr(h: Series, l: Series, c: Series, n: number): Float64Array {
  checkWindow(n, 'atr');
  return wilderSmooth(trueRange(h, l, c), n);
}

/**
 * ADX nach Wilder (Konvention wie TA-Lib): DM/TR ab Index 1, geglättete
 * Summen ab Index n, DX ab Index n, ADX als Mittel der ersten n DX an
 * Index 2n−1, danach Wilder-Glättung. Werte 0..100.
 */
export function adx(h: Series, l: Series, c: Series, n: number): Float64Array {
  checkWindow(n, 'adx');
  const len = checkSameLength('adx', h, l, c);
  const out = nanArray(len);
  if (len < 2) return out;
  let sTr = 0;
  let sPlus = 0;
  let sMinus = 0;
  let dxSum = 0;
  let dxCount = 0;
  let adxPrev = NaN_;
  for (let i = 1; i < len; i++) {
    const up = h[i]! - h[i - 1]!;
    const down = l[i - 1]! - l[i]!;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    const pc = c[i - 1]!;
    const tr = Math.max(h[i]! - l[i]!, Math.abs(h[i]! - pc), Math.abs(l[i]! - pc));
    if (i <= n) {
      sTr += tr;
      sPlus += plusDm;
      sMinus += minusDm;
      if (i < n) continue;
    } else {
      sTr = sTr - sTr / n + tr;
      sPlus = sPlus - sPlus / n + plusDm;
      sMinus = sMinus - sMinus / n + minusDm;
    }
    const plusDi = sTr > 0 ? (100 * sPlus) / sTr : 0;
    const minusDi = sTr > 0 ? (100 * sMinus) / sTr : 0;
    const diSum = plusDi + minusDi;
    const dx = diSum > 0 ? (100 * Math.abs(plusDi - minusDi)) / diSum : 0;
    if (dxCount < n) {
      dxSum += dx;
      dxCount++;
      if (dxCount === n) {
        adxPrev = dxSum / n;
        out[i] = adxPrev;
      }
      continue;
    }
    adxPrev = (adxPrev * (n - 1) + dx) / n;
    out[i] = adxPrev;
  }
  return out;
}

/* ───────────────────────── Fenster-Extrema (monotone Deque) ───────────────────────── */

function rollingExtreme(x: Series, n: number, wantMax: boolean, fn: string): Float64Array {
  checkWindow(n, fn);
  const len = x.length;
  const out = nanArray(len);
  // Deque aus Indizes; Werte sind entlang der Deque monoton (fallend für Max).
  const dq = new Int32Array(len);
  let head = 0;
  let tail = 0;
  let bad = 0;
  for (let i = 0; i < len; i++) {
    // Fenster für i ist [i-n, i-1]: erst Bar i-1 aufnehmen, dann Bar i-n-1 entlassen.
    if (i >= 1) {
      const j = i - 1;
      const v = x[j]!;
      if (!Number.isFinite(v)) bad++;
      else {
        while (tail > head) {
          const last = x[dq[tail - 1]!]!;
          if (wantMax ? last <= v : last >= v) tail--;
          else break;
        }
        dq[tail++] = j;
      }
    }
    const leaving = i - n - 1;
    if (leaving >= 0 && !Number.isFinite(x[leaving]!)) bad--;
    while (tail > head && dq[head]! < i - n) head++;
    if (i >= n && bad === 0 && tail > head) out[i] = x[dq[head]!]!;
  }
  return out;
}

/** Höchster Wert der VORHERIGEN n Bars (exklusive i): max(x[i-n..i-1]). NaN für i < n. */
export function rollingMax(x: Series, n: number): Float64Array {
  return rollingExtreme(x, n, true, 'rollingMax');
}

/** Tiefster Wert der VORHERIGEN n Bars (exklusive i): min(x[i-n..i-1]). NaN für i < n. */
export function rollingMin(x: Series, n: number): Float64Array {
  return rollingExtreme(x, n, false, 'rollingMin');
}

/* ───────────────────────── Streuung ───────────────────────── */

/**
 * Laufende Momente über [i-n+1, i] als gleitendes Welford-Update: M2 wird
 * um den laufenden Fenster-Mittelwert geführt, nicht als Σx² − n·mean².
 * Warum: Bei Kursen um 500 und σ um 0.01 frisst die Differenz zweier
 * großer Zahlen die Genauigkeit auf (Beleg: Referenztest mit n = 2).
 * Ersetzen von u durch v im vollen Fenster ist exakt in reeller Arithmetik:
 *   mean' = mean + (v−u)/n,  M2' = M2 + (v−u)·(v − mean' + u − mean).
 * Nach einer NaN-Episode wird das Fenster einmal neu aufgebaut (O(n),
 * selten) — kausal bleibt alles, denn es werden nur Bars ≤ i gelesen.
 */
function windowMoments(x: Series, n: number, emit: (i: number, mean: number, sd: number) => void): void {
  const len = x.length;
  let mean = 0;
  let m2 = 0;
  let bad = 0;
  let valid = false;
  let slides = 0;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) bad++;
    if (i >= n && !Number.isFinite(x[i - n]!)) bad--;
    if (bad > 0) {
      valid = false;
      continue;
    }
    if (i < n - 1) {
      // Aufbau: alle Werte bis hier endlich (sonst wäre bad > 0) — Welford-Add.
      const delta = v - mean;
      mean += delta / (i + 1);
      m2 += delta * (v - mean);
      continue;
    }
    if (i === n - 1) {
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
      valid = true;
      slides = 0;
    } else if (valid && slides < n) {
      const u = x[i - n]!;
      const next = mean + (v - u) / n;
      m2 += (v - u) * (v - next + u - mean);
      mean = next;
      slides++;
    } else {
      // Neuaufbau in zwei Durchläufen über [i-n+1, i]: nach einer NaN-Episode
      // und planmäßig alle n Bars. Der Rundungsrest im gleitenden M2 ist
      // absolut und stammt aus FRÜHEREN Fenstern — nach einem Regimewechsel
      // von großer zu winziger Volatilität würde er das kleine σ verfälschen.
      // Kosten: 2n Operationen je n Bars, also amortisiert O(1) je Bar.
      let sum = 0;
      for (let k = i - n + 1; k <= i; k++) sum += x[k]!;
      mean = sum / n;
      m2 = 0;
      for (let k = i - n + 1; k <= i; k++) m2 += (x[k]! - mean) ** 2;
      valid = true;
      slides = 0;
    }
    emit(i, mean, Math.sqrt(m2 > 0 ? m2 / n : 0));
  }
}

/** Populations-Standardabweichung über [i-n+1, i]. */
export function stddev(x: Series, n: number): Float64Array {
  checkWindow(n, 'stddev');
  const out = nanArray(x.length);
  windowMoments(x, n, (i, _mean, sd) => {
    out[i] = sd;
  });
  return out;
}

/** z-Score (x − SMA)/σ über [i-n+1, i]; σ = 0 ⇒ NaN (nicht definiert). */
export function zscore(x: Series, n: number): Float64Array {
  checkWindow(n, 'zscore');
  const out = nanArray(x.length);
  windowMoments(x, n, (i, mean, sd) => {
    if (sd > 0) out[i] = (x[i]! - mean) / sd;
  });
  return out;
}

/** Rate of Change: x[i]/x[i-n] − 1. NaN für i < n oder Nenner 0. */
export function roc(x: Series, n: number): Float64Array {
  checkWindow(n, 'roc');
  const len = x.length;
  const out = nanArray(len);
  for (let i = n; i < len; i++) {
    const base = x[i - n]!;
    if (base !== 0) out[i] = x[i]! / base - 1;
  }
  return out;
}

/* ───────────────────────── Kreuzungen ───────────────────────── */

function crossing(a: Series, b: Series | number, up: boolean, fn: string): Float64Array {
  const len = a.length;
  if (typeof b !== 'number' && b.length !== len) throw new RangeError(`${fn}: Längen ungleich (${len} vs ${b.length})`);
  const out = nanArray(len);
  const bAt = typeof b === 'number' ? () => b : (i: number) => b[i]!;
  for (let i = 1; i < len; i++) {
    const a0 = a[i - 1]!;
    const a1 = a[i]!;
    const b0 = bAt(i - 1);
    const b1 = bAt(i);
    if (!Number.isFinite(a0) || !Number.isFinite(a1) || !Number.isFinite(b0) || !Number.isFinite(b1)) continue;
    out[i] = (up ? a0 < b0 && a1 >= b1 : a0 > b0 && a1 <= b1) ? 1 : 0;
  }
  return out;
}

/** 1, wenn a in Bar i von unter b auf ≥ b kreuzt (a[i-1] < b[i-1] && a[i] >= b[i]); sonst 0; NaN ohne Vorbar/Werte. `b` darf eine Konstante sein. */
export function crossUp(a: Series, b: Series | number): Float64Array {
  return crossing(a, b, true, 'crossUp');
}

/** Spiegel von crossUp: a[i-1] > b[i-1] && a[i] <= b[i]. */
export function crossDown(a: Series, b: Series | number): Float64Array {
  return crossing(a, b, false, 'crossDown');
}

/* ───────────────────────── Tages-Hilfen ───────────────────────── */

export type DayOf = (t: number) => string;

/**
 * Laufende Tagesnummer je Bar (0, 0, 0, 1, 1, …) nach ET-Handelstag. Ein
 * Tageswechsel ist genau dort, wo sich der Wert erhöht — die Strategien
 * brauchen nur das, nicht den Datumsstring, und Intl je Bar ist teuer.
 */
export function dayIndex(t: Series, dayOf: DayOf = dayKey): Float64Array {
  const len = t.length;
  const out = new Float64Array(len);
  let day = '';
  let k = -1;
  for (let i = 0; i < len; i++) {
    const d = dayOf(t[i]!);
    if (d !== day) {
      day = d;
      k++;
    }
    out[i] = k;
  }
  return out;
}

/** Position der Bar innerhalb ihres ET-Tages (0 = erste Bar des Tages). */
export function barOfDay(t: Series, dayOf: DayOf = dayKey): Float64Array {
  const len = t.length;
  const out = new Float64Array(len);
  let day = '';
  let k = 0;
  for (let i = 0; i < len; i++) {
    const d = dayOf(t[i]!);
    if (d !== day) {
      day = d;
      k = 0;
    } else k++;
    out[i] = k;
  }
  return out;
}

/** Sitzungs-VWAP: kumuliert je ET-Tag über den typischen Preis (h+l+c)/3; Neustart beim Tageswechsel. */
export function sessionVwap(bars: BarSeriesLike, dayOf: DayOf = dayKey): Float64Array {
  const len = bars.length;
  const out = nanArray(len);
  let day = '';
  let sumPv = 0;
  let sumV = 0;
  for (let i = 0; i < len; i++) {
    const d = dayOf(bars.t[i]!);
    if (d !== day) {
      day = d;
      sumPv = 0;
      sumV = 0;
    }
    const v = bars.v[i]!;
    const tp = (bars.h[i]! + bars.l[i]! + bars.c[i]!) / 3;
    sumPv += tp * v;
    sumV += v;
    if (sumV > 0) out[i] = sumPv / sumV;
  }
  return out;
}

/* ───────────────────────── Kleinkram ───────────────────────── */

/** Nicht-endliche Werte durch `value` ersetzen (neues Array). */
export function nanFill(x: Series, value: number): Float64Array {
  const len = x.length;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    out[i] = Number.isFinite(v) ? v : value;
  }
  return out;
}

/** Indikatorwert an Index i; NaN, wenn Schlüssel oder Index fehlen. */
export function indAt(ind: IndicatorSet, key: string, i: number): number {
  const arr = ind[key];
  if (arr === undefined || i < 0 || i >= arr.length) return NaN_;
  return arr[i]!;
}

/** Kurs für Begründungstexte — sechs signifikante Stellen, damit auch Krypto-Kleinstkurse lesbar bleiben. */
export function fmtPx(x: number): string {
  return Number.isFinite(x) ? String(Number(x.toPrecision(6))) : String(x);
}

/* ═══════════════════ Entscheidungs-Bausteine (von allen Vorlagen geteilt) ═══════════════════ */

export function hold(): Decision {
  return { kind: 'hold' };
}

export interface Bracket {
  stop: number;
  target: number | null;
}

/**
 * ATR-Bracket: Stop = close ∓ atrMult·ATR, Ziel = close ± rrMult·atrMult·ATR
 * (nur wenn rrMult > 0). null, wenn ATR/Kurs unbrauchbar oder die Marke
 * nicht auf der Verlustseite läge — dann gibt es keinen Einstieg, denn
 * ohne Stop kein Trade (core/types.ts).
 */
export function atrBracket(close: number, atrNow: number, atrMult: number, rrMult: number, side: Side): Bracket | null {
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(atrNow) || atrNow <= 0 || !(atrMult > 0)) return null;
  const dist = atrMult * atrNow;
  return bracketFromStop(close, side === 'long' ? close - dist : close + dist, rrMult, side);
}

/** Bracket aus einer gegebenen Stop-Marke; Ziel = close ± rrMult·|close − stop|. */
export function bracketFromStop(close: number, stop: number, rrMult: number, side: Side): Bracket | null {
  if (!Number.isFinite(close) || !Number.isFinite(stop) || stop <= 0) return null;
  const risk = side === 'long' ? close - stop : stop - close;
  if (!(risk > 0)) return null;
  let target: number | null = null;
  if (rrMult > 0) {
    target = side === 'long' ? close + rrMult * risk : close - rrMult * risk;
    if (!(target > 0)) target = null;
  }
  return { stop, target };
}

export function enterDecision(side: Side, br: Bracket, reason: string): Decision {
  return br.target === null ? { kind: 'enter', side, stop: br.stop, reason } : { kind: 'enter', side, stop: br.stop, target: br.target, reason };
}

/**
 * Nachzieh-Stop nach Owner-Regel: erst nachziehen, wenn die Position im
 * Plus ist (Hochwasser jenseits des Einstands), und nur enger. Liefert die
 * neue Marke oder null (nichts tun).
 *
 * Warum „im Plus" als Bedingung: Ein Trailing ab der ersten Bar verkauft
 * bei −3 % Rauschen statt am geplanten Erststop — genau der Fehler, der
 * im Vorgängersystem Gewinner abgeschnitten hat. Und warum die Marke unter
 * dem Kurs liegen muss: Eine Stop-Order über dem Markt (Long) ist keine
 * Absicherung, sondern ein sofortiger Marktverkauf; dafür gibt es `exit`.
 */
export function trailingStop(pos: PositionState, close: number, atrNow: number, trailMult: number): number | null {
  if (!(trailMult > 0) || !Number.isFinite(atrNow) || atrNow <= 0 || !Number.isFinite(close)) return null;
  const dist = trailMult * atrNow;
  if (pos.side === 'long') {
    if (!(pos.highWater > pos.entryPrice)) return null;
    const cand = pos.highWater - dist;
    if (pos.stop !== null && !(cand > pos.stop)) return null;
    if (!(cand > 0) || !(cand < close)) return null;
    return cand;
  }
  if (!(pos.highWater < pos.entryPrice)) return null;
  const cand = pos.highWater + dist;
  if (pos.stop !== null && !(cand < pos.stop)) return null;
  if (!(cand > close)) return null;
  return cand;
}

/** `move_stop`, wenn die Trailing-Regel eine engere Marke ergibt, sonst `hold`. */
export function trailOrHold(pos: PositionState, close: number, atrNow: number, trailMult: number): Decision {
  const stop = trailingStop(pos, close, atrNow, trailMult);
  if (stop === null) return hold();
  const anchor = pos.side === 'long' ? 'unter Hochwasser' : 'über Tiefwasser';
  return { kind: 'move_stop', stop, reason: `Trailing ${trailMult}×ATR ${anchor} ${fmtPx(pos.highWater)}` };
}

/* ───────────────────────── Benchmark-Filter ───────────────────────── */

const closeSmaCache = new WeakMap<BarSeriesLike, Map<number, Float64Array>>();

/**
 * SMA der Schlusskurse, je (Serien-Objekt, Länge) einmal berechnet. Kausal:
 * Index i nutzt nur Bars ≤ i, deshalb darf der Backtest die volle Serie
 * mit laufendem i übergeben. Voraussetzung: Serien-Objekte sind
 * unveränderlich (core/bars.ts erzeugt bei `append` ein neues Objekt).
 */
export function cachedCloseSma(bars: BarSeriesLike, len: number): Float64Array {
  let byLen = closeSmaCache.get(bars);
  if (!byLen) {
    byLen = new Map();
    closeSmaCache.set(bars, byLen);
  }
  let arr = byLen.get(len);
  if (!arr) {
    arr = sma(bars.c, len);
    byLen.set(len, arr);
  }
  return arr;
}

/**
 * Marktfilter: Long nur, wenn die Benchmark über ihrer SMA(len) schließt;
 * Short gespiegelt. Ohne Benchmark im Snapshot greift der Filter nicht
 * (true). In der Aufwärmphase der Benchmark: false — lieber kein Einstieg
 * als ein Einstieg mit blindem Filter.
 */
export function benchmarkAllows(bench: SymbolSnapshot['benchmark'], len: number, side: Side): boolean {
  if (!bench) return true;
  const i = bench.i;
  if (i < 0 || i >= bench.bars.length) return false;
  const mean = cachedCloseSma(bench.bars, len)[i]!;
  const close = bench.bars.c[i]!;
  if (!Number.isFinite(mean) || !Number.isFinite(close)) return false;
  return side === 'long' ? close > mean : close < mean;
}
