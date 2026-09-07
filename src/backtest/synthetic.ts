/**
 * Synthetische Bar-Serien für Tests (Backtester, Optimierer, Strategien).
 *
 * Warum eigene Zufallszahlen: `Math.random` ist nicht seedbar — ein Test,
 * der heute grün und morgen rot ist, bewacht nichts. mulberry32 ist klein,
 * deterministisch und für Simulationsdaten mehr als gut genug.
 *
 * Die Zeitachse stammt aus `core/time` (sessionBounds/bucketStart), damit
 * synthetische Bars exakt die Bucket-Grenzen tragen, die `aggregate()`
 * aus echten Minuten-Bars erzeugen würde — inklusive Frühschluss,
 * Feiertagen und Tageswechsel. Sonst testet man den Simulator gegen eine
 * Zeitachse, die es live nie gibt.
 */
import type { AssetClass, Bar, Ms, TimeframeMin } from '../core/types.ts';
import { MIN, bucketStart, dayKeyFor, nextTradingDay, sessionBounds, type Calendar } from '../core/time.ts';

/** Seedbarer 32-Bit-Generator (Tommy Ettinger), gleichverteilt in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standardnormalverteilte Zufallszahl (Box–Muller) aus einem Uniform-Generator. */
export function gaussian(rng: () => number): number {
  let u1 = rng();
  // log(0) vermeiden — der Generator liefert 0 mit Wahrscheinlichkeit 2^-32, aber eben nicht nie.
  while (u1 <= 0) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Die ersten `n` Bucket-Anfänge ab `start` — ausschließlich Sitzungs-Buckets.
 * Liegt `start` innerhalb einer Sitzung, beginnt die Achse mit dem Bucket,
 * der `start` enthält; sonst mit dem ersten Bucket der nächsten Sitzung.
 * Krypto: UTC-Tage, rund um die Uhr.
 */
export function sessionBucketTimes(args: {
  start: Ms;
  n: number;
  tf: TimeframeMin;
  assetClass: AssetClass;
  calendar?: Calendar | undefined;
}): Float64Array {
  const { start, n, tf, assetClass, calendar } = args;
  const out = new Float64Array(Math.max(0, n));
  if (n <= 0) return out;
  let day = dayKeyFor(start, assetClass);
  let k = 0;
  // Schutz gegen Endlosschleifen bei absurden Eingaben (z. B. leerem Kalender).
  for (let guard = 0; guard < 100_000 && k < n; guard++) {
    const bounds = sessionBounds(day, assetClass, calendar);
    if (bounds) {
      let s: Ms | null;
      if (start < bounds.open) s = bounds.open;
      else s = bucketStart(start, tf, bounds);
      if (s !== null) {
        if (tf === 1440) {
          out[k++] = s;
        } else {
          for (; s < bounds.close && k < n; s += tf * MIN) out[k++] = s;
        }
      }
    }
    if (k >= n) break;
    // Erst NACH dem Abbruch weiterblättern — sonst wirft ein Broker-Kalender, der genau hier endet.
    day = nextTradingDay(day, assetClass, calendar);
  }
  if (k < n) throw new Error(`sessionBucketTimes: nur ${k} von ${n} Buckets erzeugt`);
  return out;
}

export interface SyntheticArgs {
  seed: number;
  n: number;
  start: Ms;
  tf: TimeframeMin;
  assetClass: AssetClass;
  startPrice?: number | undefined;
  /** Log-Volatilität je Bar (Standardabweichung), z. B. 0.002 = 0,2 %. */
  volPerBar?: number | undefined;
  /** Log-Drift je Bar. */
  drift?: number | undefined;
  calendar?: Calendar | undefined;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Eine Bar aus Open/Close plus zufälligem Docht; Invarianten h ≥ max(o,c), l ≤ min(o,c), v > 0 gelten per Konstruktion. */
function makeBar(t: Ms, o: number, c: number, vol: number, rng: () => number): Bar {
  const hi = Math.max(o, c) * (1 + 0.5 * vol * Math.abs(gaussian(rng)));
  const lo = Math.min(o, c) * (1 - 0.5 * vol * Math.abs(gaussian(rng)));
  const v = Math.floor(1_000 + 9_000 * rng());
  // Runden ist monoton — die Docht-Invarianten überleben es.
  return { t, o: round4(o), h: round4(hi), l: round4(lo), c: round4(c), v };
}

/** Geometrischer Random Walk mit kleinen Eröffnungslücken (damit Stops auch mal übersprungen werden). */
export function randomWalkBars(args: SyntheticArgs): Bar[] {
  const rng = mulberry32(args.seed);
  const times = sessionBucketTimes(args);
  const vol = args.volPerBar ?? 0.002;
  const drift = args.drift ?? 0;
  let prevClose = args.startPrice ?? 100;
  const out: Bar[] = new Array(times.length);
  for (let k = 0; k < times.length; k++) {
    const gap = k === 0 ? 0 : 0.3 * vol * gaussian(rng);
    const o = prevClose * Math.exp(gap);
    const c = o * Math.exp(drift + vol * gaussian(rng));
    out[k] = makeBar(times[k]!, o, c, vol, rng);
    prevClose = out[k]!.c;
  }
  return out;
}

/**
 * Bars um eine lineare Trendgerade (`slope` = Kursänderung je Bar in
 * Kurseinheiten) mit AR(1)-Rauschen — das Rauschen bleibt an der Geraden,
 * statt wie ein Random Walk davonzulaufen. Die Gerade wird bei 5 % des
 * Startkurses gekappt, damit ein negativer Slope keine negativen Kurse
 * erzeugt.
 */
export function trendingBars(args: SyntheticArgs & { slope: number }): Bar[] {
  const rng = mulberry32(args.seed);
  const times = sessionBucketTimes(args);
  const vol = args.volPerBar ?? 0.002;
  const drift = args.drift ?? 0;
  const p0 = args.startPrice ?? 100;
  const floor = p0 * 0.05;
  let e = 0;
  let prevClose = p0;
  const out: Bar[] = new Array(times.length);
  for (let k = 0; k < times.length; k++) {
    e = 0.8 * e + vol * gaussian(rng) + drift;
    const trend = Math.max(floor, p0 + args.slope * k);
    const c = trend * Math.exp(e);
    const o = k === 0 ? p0 : prevClose * Math.exp(0.3 * vol * gaussian(rng));
    out[k] = makeBar(times[k]!, o, c, vol, rng);
    prevClose = out[k]!.c;
  }
  return out;
}
