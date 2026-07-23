/**
 * Forecast-Kern — purer Port von reference/scripts/forecaster.py (compute)
 * und der zeitkritischen Gate-/Scoring-Logik aus forecast_eval.py.
 *
 * Ehrliche Heuristik, KEIN Markt-Orakel:
 * - Baseline: Kleinste-Quadrate-Regression über die letzten N Tages-Closes
 *   → Drift, `horizon` Werktage projiziert, ±1σ-Residuenband.
 * - Sentiment-Tilt: Drift wird in Richtung des News-Sentiments verschoben,
 *   skaliert mit der Tagesvolatilität, hart gedeckelt (±TILT_CAP·vol).
 * - Self-Tuning: Shadow-Prognosen über WEIGHT_GRID × LOOKBACK_GRID; die
 *   Live-Prognose nutzt die historisch beste Kombi (nur realisierte Scores!).
 *
 * LOOKAHEAD-GATE (CLAUDE.md §5 — heilig, nie aufweichen):
 * `isForecastDue` lässt nur Prognosen zur Bewertung zu, deren LETZTER
 * Horizont-Tag strikt VOR heute liegt; `scoreForecast` verlangt zusätzlich
 * einen realisierten Close am letzten Horizont-Tag.
 */

export const WEIGHT_GRID = [0.0, 0.25, 0.5, 0.75, 1.0] as const;
export const LOOKBACK_GRID = [10, 20, 30] as const;
export const DEFAULT_W = 0.5;
export const DEFAULT_LOOKBACK = 20;
export const FORECAST_HORIZON = 6; // projizierte Werktage
export const TILT_CAP = 1.5; // Tilt ≤ dies × Tagesvolatilität
export const MIN_SAMPLES_PER_COMBO = 8;
export const MIN_TOTAL_SCORES = 20;

export interface ForecastPoint {
  time: string; // YYYY-MM-DD
  value: number;
}

export interface ForecastBandPoint {
  time: string;
  upper: number;
  lower: number;
}

export interface ForecastComputation {
  points: ForecastPoint[];
  band: ForecastBandPoint[];
  slope: number;
  slopeAdj: number;
  tilt: number;
  dailyVol: number;
  sigma: number;
  baseClose: number;
  lookback: number;
}

const round = (x: number, p: number): number => {
  const m = 10 ** p;
  return Math.round(x * m) / m;
};

/** Die nächsten n Werktage (Mo–Fr) nach base_date, UTC-Datumsarithmetik. */
export function nextWeekdays(baseDate: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${baseDate}T00:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay(); // 0=So .. 6=Sa
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Kleinste-Quadrate-Regression über Index 0..n-1 (Port von _linreg). */
export function linreg(ys: number[]): { slope: number; intercept: number; sigma: number } {
  const n = ys.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += ys[i]!;
    sxx += i * i;
    sxy += i * ys[i]!;
  }
  const denom = n * sxx - sx * sx || 1e-9;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i]! - (intercept + slope * i);
    ss += r * r;
  }
  const sigma = Math.sqrt(ss / Math.max(n - 2, 1));
  return { slope, intercept, sigma };
}

/** Mittlere absolute Tagesänderung (Port von _daily_vol). */
export function dailyVol(closes: number[]): number {
  if (closes.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < closes.length; i++) sum += Math.abs(closes[i]! - closes[i - 1]!);
  return sum / (closes.length - 1);
}

/**
 * Eine Prognose für eine (sentiment, w, lookback)-Kombi — exakter Port von
 * forecaster.compute inkl. Rundungen. `closes` älteste→neueste; `baseDate`
 * ist das Datum des letzten Bars. Liefert null bei < 5 Bars.
 */
export function computeForecast(
  closes: number[],
  baseDate: string,
  sentiment: number,
  w: number,
  horizon: number = FORECAST_HORIZON,
  lookback: number = DEFAULT_LOOKBACK,
): ForecastComputation | null {
  const n = Math.min(lookback, closes.length);
  if (n < 5) return null;
  const seg = closes.slice(-n);
  const { slope, intercept: _i, sigma } = linreg(seg);
  const vol = dailyVol(seg);
  const last = seg[seg.length - 1]!;

  let tilt = w * sentiment * vol;
  const cap = TILT_CAP * vol;
  tilt = Math.max(-cap, Math.min(cap, tilt));
  const slopeAdj = slope + tilt;

  const dates = nextWeekdays(baseDate, horizon);
  const points: ForecastPoint[] = [];
  const band: ForecastBandPoint[] = [];
  for (let k = 1; k <= dates.length; k++) {
    const dt = dates[k - 1]!;
    const y = last + slopeAdj * k;
    const bandw = sigma * Math.sqrt(1 + k / n);
    points.push({ time: dt, value: round(y, 4) });
    band.push({ time: dt, upper: round(y + bandw, 4), lower: round(y - bandw, 4) });
  }
  return {
    points,
    band,
    slope: round(slope, 5),
    slopeAdj: round(slopeAdj, 5),
    tilt: round(tilt, 5),
    dailyVol: round(vol, 5),
    sigma: round(sigma, 5),
    baseClose: round(last, 4),
    lookback,
  };
}

/**
 * LOOKAHEAD-GATE: bewertbar ist eine Prognose nur, wenn ihr LETZTER
 * Horizont-Tag strikt vor `today` (YYYY-MM-DD) liegt — der heutige Bar kann
 * fehlen oder unfertig sein.
 */
export function isForecastDue(points: ForecastPoint[], today: string): boolean {
  if (points.length === 0) return false;
  return points[points.length - 1]!.time < today;
}

export interface ForecastScore {
  maePct: number;
  dirHit: boolean;
  nPoints: number;
}

/**
 * Scoring gegen realisierte Closes (Port aus evaluate_due):
 * - der LETZTE Horizont-Tag MUSS einen realisierten Close > 0 haben,
 *   sonst null (kein Score mit fehlendem Endtag);
 * - Zwischen-Tage ohne Close (Feiertage) werden übersprungen;
 * - dirHit: Richtung des letzten gematchten Punkts vs. baseClose.
 */
export function scoreForecast(
  points: ForecastPoint[],
  baseClose: number,
  actuals: Record<string, number>,
): ForecastScore | null {
  if (points.length === 0) return null;
  const lastDay = points[points.length - 1]!.time;
  const lastActual = actuals[lastDay];
  if (lastActual === undefined || lastActual <= 0) return null;

  const matched: Array<[number, number]> = [];
  for (const p of points) {
    const act = actuals[p.time];
    if (act !== undefined && act > 0) matched.push([p.value, act]);
  }
  if (matched.length === 0) return null;

  let mae = 0;
  for (const [pred, act] of matched) mae += Math.abs(pred - act) / act;
  mae = (mae / matched.length) * 100;

  const [predLast, actLast] = matched[matched.length - 1]!;
  const dirHit = predLast - baseClose > 0 === actLast - baseClose > 0;
  return { maePct: round(mae, 4), dirHit, nPoints: matched.length };
}

export interface ComboStat {
  n: number;
  hits: number;
  maeSum: number;
}

/**
 * Self-Tuning (Port von best_params): beste realisierte Richtungs-Quote,
 * Tiebreak niedrigste MAE; Defaults bis genug Evidenz da ist (kein Lookahead —
 * es fließen nur bereits bewertete Prognosen ein).
 */
export function bestParams(combos: Record<string, ComboStat>): { w: number; lookback: number } {
  const fallback = { w: DEFAULT_W, lookback: DEFAULT_LOOKBACK };
  const entries = Object.entries(combos);
  const total = entries.reduce((s, [, d]) => s + d.n, 0);
  if (total < MIN_TOTAL_SCORES) return fallback;
  const eligible = entries.filter(([, d]) => d.n >= MIN_SAMPLES_PER_COMBO);
  if (eligible.length === 0) return fallback;
  let best: { key: string; dirAcc: number; mae: number } | null = null;
  for (const [key, d] of eligible) {
    const dirAcc = d.hits / d.n;
    const mae = d.maeSum / d.n;
    if (!best || dirAcc > best.dirAcc || (dirAcc === best.dirAcc && mae < best.mae)) {
      best = { key, dirAcc, mae };
    }
  }
  const [w, lb] = best!.key.split('_');
  return { w: Number(w), lookback: Number(lb) };
}

/** Kombi-Schlüssel für Stats/Doc-IDs: `${w}_${lookback}` (z. B. "0.5_20"). */
export function comboKey(w: number, lookback: number): string {
  return `${w}_${lookback}`;
}
