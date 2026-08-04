/**
 * Forecast-Kern — purer Port von reference/scripts/forecaster.py (compute)
 * und der zeitkritischen Gate-/Scoring-Logik aus forecast_eval.py.
 *
 * Ehrliche Heuristik, KEIN Markt-Orakel:
 * - Baseline: Kleinste-Quadrate-Regression über die letzten N Tages-Closes
 *   → Drift, `horizon` Werktage projiziert, ±1σ-Residuenband.
 * - Feature-Tilt (V2): RSI- und MACD-Lage verschieben die Drift, gedeckelt.
 * - Self-Tuning: Shadow-Prognosen über LOOKBACK_GRID; die Live-Prognose
 *   nutzt den historisch besten Lookback (nur realisierte Scores!).
 *
 * LOOKAHEAD-GATE (CLAUDE.md §5 — heilig, nie aufweichen):
 * `isForecastDue` lässt nur Prognosen zur Bewertung zu, deren LETZTER
 * Horizont-Tag strikt VOR heute liegt; `scoreForecast` verlangt zusätzlich
 * einen realisierten Close am letzten Horizont-Tag.
 */

import { macd, wilderRsi } from './indicators.ts';

export const LOOKBACK_GRID = [10, 20, 30] as const;
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
  dailyVol: number;
  sigma: number;
  baseClose: number;
  lookback: number;
}

const round = (x: number, p: number): number => {
  const m = 10 ** p;
  return Math.round(x * m) / m;
};

/** Die nächsten n Werktage (Mo–Fr) nach base_date, UTC-Datumsarithmetik.
 *  Ungültiges Datum ⇒ leere Liste (NIE endlos drehen — Backtest-Fixtures
 *  nutzen synthetische Datums-Strings). */
export function nextWeekdays(baseDate: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${baseDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return out;
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
 * Eine Prognose für eine `lookback`-Länge: lineare Regression über die
 * letzten n Closes, linear fortgeschrieben, mit einem Band aus der
 * Residuen-Streuung. `closes` älteste→neueste; `baseDate` ist das Datum des
 * letzten Bars. Liefert null bei < 5 Bars.
 *
 * **Kein Sentiment-Tilt mehr** (28.07.): Die Prognose kannte einen Term
 * `w × sentiment × vol`, der die Steigung nach der Nachrichtenlage
 * verschob. Mit dem Ausbau der News-Strecke ist `sentiment` konstant 0 —
 * der Term war exakt null, und die ganze `w`-Achse des Suchgitters
 * unterschied Kombis, die dieselbe Zahl rechneten. Fünf w-Werte × drei
 * Lookbacks hieß: 15 identische Prognosen je Symbol und Tag, alle
 * gespeichert, alle einzeln bewertet. Jetzt sind es drei echte.
 */
export function computeForecast(
  closes: number[],
  baseDate: string,
  horizon: number = FORECAST_HORIZON,
  lookback: number = DEFAULT_LOOKBACK,
): ForecastComputation | null {
  const n = Math.min(lookback, closes.length);
  if (n < 5) return null;
  const seg = closes.slice(-n);
  const { slope, intercept: _i, sigma } = linreg(seg);
  const vol = dailyVol(seg);
  const last = seg[seg.length - 1]!;
  const slopeAdj = slope;

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
export function bestParams(
  combos: Record<string, ComboStat>,
  fallbackLookback: number = DEFAULT_LOOKBACK,
): { lookback: number } {
  const fallback = { lookback: fallbackLookback };
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
  const lb = Number(best!.key);
  return { lookback: Number.isFinite(lb) && lb > 0 ? lb : fallbackLookback };
}

/**
 * Kombi-Schlüssel für Stats und Doc-IDs — seit 28.07. der Lookback allein.
 *
 * Vorher `${w}_${lookback}`. Ein Altbestand mit Unterstrich fällt in
 * `bestParams` durch die `Number()`-Prüfung und landet beim Fallback: Der
 * Tuner beginnt seine Evidenz neu, statt aus Schlüsseln zu lesen, deren
 * zweite Hälfte es nicht mehr gibt.
 */
export function comboKey(lookback: number): string {
  return String(lookback);
}

/* ── Intraday-Kurzfrist-Prognose (Prognose 2.0 Teil 2) ───────────────────────
 *
 * Gleiche ehrliche Mathematik wie die Tages-Prognose, aber auf 5-min-Bars:
 * Horizont ist die NÄCHSTE STUNDE (12 Bars), Zeitachse sind UNIX-Sekunden.
 * Eigenes Shadow-Gitter + eigene Statistik (meta/forecastStatsIntraday) —
 * kurzfristige Dynamik lernt getrennt von der Tages-Dynamik.
 *
 * LOOKAHEAD-GATE (genauso heilig wie beim Tages-Pfad): bewertbar erst, wenn
 * der LETZTE Horizont-Bar vollständig ABGESCHLOSSEN ist (Bar-Start + Bar-Länge
 * ≤ jetzt) UND sein Close realisiert vorliegt (scoreForecast-Semantik).
 */

export const INTRADAY_LOOKBACK_GRID = [24, 48] as const; // 5-min-Bars (2 h / 4 h)
export const DEFAULT_INTRADAY_LOOKBACK = 24;
export const INTRADAY_HORIZON = 12; // 12 × 5 min = 1 Stunde
export const INTRADAY_STEP_SEC = 300;

export interface IntradayForecastPoint {
  t: number; // UNIX-Sekunden (Bar-Start)
  value: number;
}

export interface IntradayForecastBandPoint {
  t: number;
  upper: number;
  lower: number;
}

export interface IntradayForecastComputation {
  points: IntradayForecastPoint[];
  band: IntradayForecastBandPoint[];
  slope: number;
  slopeAdj: number;
  vol: number;
  sigma: number;
  baseClose: number;
  lookback: number;
}

/**
 * Kurzfrist-Prognose über die nächsten `horizon` 5-min-Bars — dieselbe
 * Regressions-Mechanik wie computeForecast, Zeitachse = baseT + k·step.
 * `closes` älteste→neueste; liefert null bei < 5 Bars.
 */
export function computeIntradayForecast(
  closes: number[],
  baseT: number,
  horizon: number = INTRADAY_HORIZON,
  lookback: number = DEFAULT_INTRADAY_LOOKBACK,
  stepSec: number = INTRADAY_STEP_SEC,
): IntradayForecastComputation | null {
  const n = Math.min(lookback, closes.length);
  if (n < 5) return null;
  const seg = closes.slice(-n);
  const { slope, sigma } = linreg(seg);
  const vol = dailyVol(seg); // hier: mittlere absolute Bar-Änderung
  const last = seg[seg.length - 1]!;
  const slopeAdj = slope;

  const points: IntradayForecastPoint[] = [];
  const band: IntradayForecastBandPoint[] = [];
  for (let k = 1; k <= horizon; k++) {
    const t = baseT + k * stepSec;
    const y = last + slopeAdj * k;
    const bandw = sigma * Math.sqrt(1 + k / n);
    points.push({ t, value: round(y, 4) });
    band.push({ t, upper: round(y + bandw, 4), lower: round(y - bandw, 4) });
  }
  return {
    points,
    band,
    slope: round(slope, 5),
    slopeAdj: round(slopeAdj, 5),
    vol: round(vol, 5),
    sigma: round(sigma, 5),
    baseClose: round(last, 4),
    lookback,
  };
}

/**
 * BAR-REALISIERT-GATE: bewertbar nur, wenn der letzte Horizont-Bar
 * vollständig abgeschlossen ist (Bar-START + Bar-Länge ≤ nowSec) — ein noch
 * laufender Bar zählt NICHT (Intraday-Pendant zu isForecastDue).
 */
export function isIntradayForecastDue(
  points: Array<{ t: number }>,
  nowSec: number,
  stepSec: number = INTRADAY_STEP_SEC,
): boolean {
  if (points.length === 0) return false;
  return points[points.length - 1]!.t + stepSec <= nowSec;
}

/**
 * Scoring gegen realisierte 5-min-Closes (Schlüssel = String der UNIX-Sekunde)
 * — delegiert an scoreForecast: letzter Horizont-Bar MUSS realisiert sein,
 * fehlende Zwischen-Bars (Lücken/Halts) werden übersprungen.
 */
export function scoreIntradayForecast(
  points: IntradayForecastPoint[],
  baseClose: number,
  actuals: Record<string, number>,
): ForecastScore | null {
  return scoreForecast(
    points.map((p) => ({ time: String(p.t), value: p.value })),
    baseClose,
    actuals,
  );
}

/* ── Feature-Regressoren + realisierte Konfidenz (Prognose 2.0 Teil 3) ──────
 *
 * Zwei kausale Verfeinerungen — die V1-Kerne (computeForecast /
 * computeIntradayForecast) bleiben als Golden-Parity-Basis UNANGETASTET:
 *
 * 1. forecastFeatures: RSI-Zustand (Mean-Reversion), MACD-Momentum und
 *    Vola-Regime aus den GLEICHEN vergangenen Closes — die V2-Wrapper
 *    verschieben die Drift um einen hart gedeckelten Feature-Tilt und
 *    weiten das Band im turbulenten Regime.
 * 2. applyBandCalibration: das ±1σ-Band (in-sample-Residuen) wird auf die
 *    REALISIERTE Fehlerverteilung der aktiven Kombi skaliert — die
 *    Selbstverbesserung erreicht damit auch die Konfidenz, nicht nur die
 *    Parameterwahl. Ohne Evidenz (n zu klein) bleibt alles unverändert.
 */

export const FEATURE_TILT_W = 0.5; // fest (Teil 4 macht daraus eine Sweep-Achse)
export const VOL_REGIME_MIN = 0.75;
export const VOL_REGIME_MAX = 1.75;
/** MAE (mittl. Absolutfehler) → σ einer Normalverteilung: σ = MAE·√(π/2). */
export const MAE_TO_SIGMA = 1.2533;
export const CALIB_MIN = 0.5;
export const CALIB_MAX = 3;

export interface ForecastFeatures {
  /** (50 − RSI14)/50 ∈ [−1, 1] — überkauft ⇒ negativer Zug (Mean-Reversion). */
  rsiState: number;
  /** MACD-Histogramm normiert auf die Bar-Volatilität, geclampt [−1, 1]. */
  macdMom: number;
  /** Kurz-Vol ÷ Lang-Vol, geclampt [VOL_REGIME_MIN, VOL_REGIME_MAX]. */
  volRegime: number;
  /** Kombiniertes Richtungssignal ∈ [−1, 1] (im turbulenten Regime gedämpft). */
  signal: number;
}

/**
 * Kausale Feature-Extraktion aus vergangenen Closes (älteste→neueste).
 * Fehlt die Historie für einen Indikator, trägt er neutral (0 bzw. 1) bei.
 */
export function forecastFeatures(closes: number[], lookback: number): ForecastFeatures {
  const rsiSeries = wilderRsi(closes);
  const rsiLast = rsiSeries[rsiSeries.length - 1];
  const rsiState = typeof rsiLast === 'number' ? Math.max(-1, Math.min(1, (50 - rsiLast) / 50)) : 0;

  const hist = macd(closes).histogram;
  const histLast = hist[hist.length - 1];
  const n = Math.min(lookback, closes.length);
  const vol = dailyVol(closes.slice(-n));
  const macdMom =
    typeof histLast === 'number' && vol > 0 ? Math.max(-1, Math.min(1, histLast / vol)) : 0;

  const volLong = dailyVol(closes.slice(-Math.min(3 * lookback, closes.length)));
  const volRegime =
    vol > 0 && volLong > 0
      ? Math.max(VOL_REGIME_MIN, Math.min(VOL_REGIME_MAX, vol / volLong))
      : 1;

  // Momentum und Mean-Reversion je zur Hälfte; Turbulenz (Regime > 1) dämpft
  // das Richtungssignal — in unruhigen Phasen ist Zurückhaltung ehrlicher.
  const raw = 0.5 * macdMom + 0.5 * rsiState;
  const signal = Math.max(-1, Math.min(1, raw / Math.max(1, volRegime)));
  return { rsiState: round(rsiState, 4), macdMom: round(macdMom, 4), volRegime: round(volRegime, 4), signal: round(signal, 4) };
}

/** Punkte um den Feature-Tilt verschieben + Band im turbulenten Regime weiten. */
function applyFeatures<
  T extends {
    points: Array<{ value: number }>;
    band: Array<{ upper: number; lower: number }>;
    slopeAdj: number;
  },
>(fc: T, feat: ForecastFeatures, vol: number): T & { features: ForecastFeatures } {
  const cap = TILT_CAP * vol;
  const tilt = Math.max(-cap, Math.min(cap, FEATURE_TILT_W * feat.signal * vol));
  const widen = Math.max(1, feat.volRegime);
  const points = fc.points.map((p, i) => ({ ...p, value: round(p.value + tilt * (i + 1), 4) }));
  const band = fc.band.map((b, i) => {
    const mid = (b.upper + b.lower) / 2 + tilt * (i + 1);
    const half = ((b.upper - b.lower) / 2) * widen;
    return { ...b, upper: round(mid + half, 4), lower: round(mid - half, 4) };
  });
  return { ...fc, points, band, slopeAdj: round(fc.slopeAdj + tilt, 5), features: feat };
}

/** V2 der Tages-Prognose: V1-Kern + Feature-Tilt + Regime-Band. */
export function computeForecastV2(
  closes: number[],
  baseDate: string,
  horizon: number = FORECAST_HORIZON,
  lookback: number = DEFAULT_LOOKBACK,
): (ForecastComputation & { features: ForecastFeatures }) | null {
  const base = computeForecast(closes, baseDate, horizon, lookback);
  if (!base) return null;
  return applyFeatures(base, forecastFeatures(closes, lookback), base.dailyVol);
}

/** V2 der Intraday-Prognose: gleiche Mechanik auf 5-min-Closes. */
export function computeIntradayForecastV2(
  closes: number[],
  baseT: number,
  horizon: number = INTRADAY_HORIZON,
  lookback: number = DEFAULT_INTRADAY_LOOKBACK,
  stepSec: number = INTRADAY_STEP_SEC,
): (IntradayForecastComputation & { features: ForecastFeatures }) | null {
  const base = computeIntradayForecast(closes, baseT, horizon, lookback, stepSec);
  if (!base) return null;
  return applyFeatures(base, forecastFeatures(closes, lookback), base.vol);
}

export interface BandCalibration {
  /** Skalierungsfaktor des Bands (geclampt [CALIB_MIN, CALIB_MAX]). */
  s: number;
  /** Realisierte mittlere MAE der aktiven Kombi in %. */
  maePct: number;
  /** Anzahl realisierter Bewertungen, auf denen die Kalibrierung fußt. */
  n: number;
}

/**
 * Band auf die realisierte Fehlerverteilung skalieren: Ziel-Halbbreite im
 * Mittel = σ der echten Fehler (MAE·√(π/2)·baseClose). Erst ab
 * MIN_SAMPLES_PER_COMBO Bewertungen aktiv — vorher bleibt das ±1σ-Band der
 * Regression unverändert (null). NIEMALS aus unbewerteten Prognosen speisen.
 */
export function applyBandCalibration<
  T extends { band: Array<{ upper: number; lower: number }>; baseClose: number },
>(fc: T, combo: ComboStat | undefined): { fc: T; calib: BandCalibration | null } {
  if (!combo || combo.n < MIN_SAMPLES_PER_COMBO || fc.baseClose <= 0) return { fc, calib: null };
  const halfWidths = fc.band.map((b) => (b.upper - b.lower) / 2);
  const meanHalf = halfWidths.reduce((a, b) => a + b, 0) / Math.max(1, halfWidths.length);
  if (meanHalf <= 0) return { fc, calib: null };
  const maePct = combo.maeSum / combo.n;
  const target = (maePct / 100) * fc.baseClose * MAE_TO_SIGMA;
  const s = Math.max(CALIB_MIN, Math.min(CALIB_MAX, target / meanHalf));
  const band = fc.band.map((b) => {
    const mid = (b.upper + b.lower) / 2;
    const half = ((b.upper - b.lower) / 2) * s;
    return { ...b, upper: round(mid + half, 4), lower: round(mid - half, 4) };
  });
  return {
    fc: { ...fc, band },
    calib: { s: round(s, 3), maePct: round(maePct, 3), n: combo.n },
  };
}

export interface ForecastVoteWeighting {
  /** Effektives Stimmgewicht (ganzzahlig, wie die Konfluenz zählt). */
  weight: number;
  /** Kante-über-Zufall-Faktor 0–1; null = keine Evidenz (Basisgewicht gilt). */
  factor: number | null;
}

/**
 * Genauigkeitsgewichtetes Forecast-Vote (Prognose 2.0 Teil 4): Das
 * konfigurierte Stimmgewicht wird mit der REALISIERTEN Kante über den
 * Münzwurf skaliert — 50 % Trefferquote ⇒ Faktor 0 (die Prognose weiß
 * nichts, also stimmt sie nicht mit), 75 % ⇒ 0.5, 100 % ⇒ 1. Unter 50 %
 * ebenfalls 0 — NIE contrarian drehen.
 *
 * **Ohne Evidenz stimmt die Prognose NICHT mit** (Beweislast-Umkehr,
 * Owner-Direktive 28.07.). Bis zur ersten Deploy-Reihe Ende Juli lief es
 * andersherum: unter MIN_TOTAL_SCORES galt das volle konfigurierte Gewicht
 * — die Prognose konnte mit forecastWeight 2 einen Ausstieg im Alleingang
 * auslösen, obwohl live noch KEINE einzige Prognose je bewertet worden war
 * (meta/forecastStats stand auf scored: 0). Ein Signal, dessen Trefferquote
 * niemand kennt, hat in einer Geld-Entscheidung kein Stimmrecht; es muss
 * sich das Gewicht erst durch realisierte Treffer verdienen. Im Chart
 * bleibt die Prognose als Anzeige — nur handeln darf sie nicht mehr blind.
 */
export function accuracyWeightedVote(
  baseWeight: number,
  stats: { scored?: number | undefined; dirAccuracy?: number | null | undefined } | null | undefined,
): ForecastVoteWeighting {
  const base = Math.trunc(baseWeight);
  const scored = stats?.scored ?? 0;
  const acc = stats?.dirAccuracy;
  if (scored < MIN_TOTAL_SCORES || acc === null || acc === undefined || !Number.isFinite(acc)) {
    return { weight: 0, factor: null };
  }
  const factor = Math.max(0, Math.min(1, (acc / 100 - 0.5) * 2));
  return { weight: Math.round(base * factor), factor: round(factor, 3) };
}

/** Intraday-Doc (market/{sym}/forecastsIntraday/{baseT_lookback}). */
export interface IntradayForecastDoc {
  baseT: number;
  baseClose: number;
  lookback: number;
  horizonBars: number;
  vol: number;
  points: IntradayForecastPoint[];
  predictedPct: number;
  madeAt: string;
  evaluated: boolean;
  evaluatedAt?: string;
  maePct?: number;
  dirHit?: boolean;
  nPoints?: number;
  /** true = unbewertbar verfallen (z. B. Session-Ende vor Horizont) — zählt NICHT in die Statistik. */
  expired?: boolean;
  /** Sentiment-Schatten wie beim Tages-Doc (siehe ForecastDoc.sentSign). */
  sentSign?: number;
  sentVal?: number;
}

/**
 * Sentiment-Schatten-Treffer: Hätte das News-Vorzeichen zum Prognosezeitpunkt
 * die realisierte Richtung getroffen? Gleiche Vorzeichen-Konvention wie
 * scoreForecast (Gleichstand zählt als „runter"). null = nicht wertbar
 * (neutrales/fehlendes Sentiment oder kein realisierter End-Close).
 * Nur BEWERTETE Prognosen rufen das auf — dieselben Lookahead-Gates wie beim
 * dirHit gelten damit automatisch auch hier.
 */
export function sentimentHit(
  sentSign: number | undefined,
  baseClose: number,
  actLast: number | undefined,
): boolean | null {
  if (sentSign !== 1 && sentSign !== -1) return null;
  if (actLast === undefined || actLast <= 0 || baseClose <= 0) return null;
  return actLast - baseClose > 0 === sentSign > 0;
}
