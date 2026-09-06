/**
 * Kennzahlen eines Backtests — und die Statistik gegen Selbstbetrug.
 *
 * Sharpe/Sortino/MaxDD/Profitfaktor sind Standard. Entscheidend für den
 * Optimierer sind PSR und DSR (Bailey & López de Prado): Wer hundert
 * Parameter-Kombinationen probiert, bekommt allein durch Zufall welche mit
 * schönem Sharpe. Der Deflated Sharpe fragt, ob der beste Kandidat auch
 * die Latte reißt, die N Zufallsversuche als Maximum erwarten lassen —
 * unter Berücksichtigung von Schiefe und schweren Rändern.
 *
 * Konvention: `sr` in PSR/DSR ist der Sharpe JE PERIODE (nicht
 * annualisiert); `n` die Anzahl Perioden. Kurtosis ist ROH (Normal = 3).
 */
import type { EquityPoint, Metrics, Trade } from '../core/types.ts';

/* ───────────────────────── Momente ───────────────────────── */

function mean(x: readonly number[]): number {
  let s = 0;
  for (const v of x) s += v;
  return x.length ? s / x.length : 0;
}

/** Stichproben-Standardabweichung (n−1). */
function sampleStd(x: readonly number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}

/** Zentrale Momente (Population, /n) — die Form der PSR-Formel. */
function centralMoments(x: readonly number[]): { m2: number; m3: number; m4: number } {
  const n = x.length;
  const m = mean(x);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  return { m2: m2 / n, m3: m3 / n, m4: m4 / n };
}

/** Schiefe γ₃; 0 bei < 3 Werten oder σ = 0 (Normal-Annahme statt NaN). */
export function skewness(x: readonly number[]): number {
  if (x.length < 3) return 0;
  const { m2, m3 } = centralMoments(x);
  if (!(m2 > 0)) return 0;
  return m3 / Math.pow(m2, 1.5);
}

/** Rohe Kurtosis γ₄ (Normal ⇒ 3, NICHT Exzess); 3 bei < 4 Werten oder σ = 0. */
export function kurtosis(x: readonly number[]): number {
  if (x.length < 4) return 3;
  const { m2, m4 } = centralMoments(x);
  if (!(m2 > 0)) return 3;
  return m4 / (m2 * m2);
}

/* ───────────────────────── Normalverteilung ───────────────────────── */

const LOG_SQRT_2PI = 0.9189385332046728;

/**
 * Φ(x) nach Marsaglia (2004) — Reihenentwicklung, die für |x| ≤ 8 auf
 * ~1e-15 konvergiert. Jenseits davon ist der Rand numerisch 0 bzw. 1.
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x < -8) return 0;
  if (x > 8) return 1;
  let s = x;
  let t = 0;
  let b = x;
  const q = x * x;
  let i = 1;
  while (s !== t) {
    t = s;
    i += 2;
    b *= q / i;
    s = t + b;
  }
  return 0.5 + s * Math.exp(-0.5 * q - LOG_SQRT_2PI);
}

/**
 * Φ⁻¹(p): Acklam-Näherung (rel. Fehler < 1,15e-9) plus ein Newton-Schritt
 * gegen `normalCdf`, der den Rest auf Maschinengenauigkeit drückt.
 * p = 0/1 ⇒ ∓∞, außerhalb [0, 1] ⇒ NaN — ein Quantil außerhalb gibt es nicht.
 */
export function normalInv(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN;
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924] as const;
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857] as const;
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878] as const;
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742] as const;
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Newton-Verfeinerung: x ← x − (Φ(x) − p)/φ(x)
  const pdf = Math.exp(-0.5 * x * x - LOG_SQRT_2PI);
  if (pdf > 1e-300) {
    const err = normalCdf(x) - p;
    x -= err / pdf;
  }
  return x;
}

/* ───────────────────────── Kennzahlen ───────────────────────── */

/** Annualisierter Sharpe (Mittel/σ·√Perioden); null bei < 2 Werten oder σ = 0. */
export function sharpeRatio(returns: readonly number[], periodsPerYear: number): number | null {
  if (returns.length < 2) return null;
  const sd = sampleStd(returns);
  if (!(sd > 0)) return null;
  return (mean(returns) / sd) * Math.sqrt(periodsPerYear);
}

/** Annualisierter Sortino: Mittel / Downside-Deviation gegen 0 (√(Σ min(r,0)²/n)); null bei < 2 Werten oder ohne Verluste. */
export function sortinoRatio(returns: readonly number[], periodsPerYear: number): number | null {
  if (returns.length < 2) return null;
  let s = 0;
  for (const r of returns) if (r < 0) s += r * r;
  const dd = Math.sqrt(s / returns.length);
  if (!(dd > 0)) return null;
  return (mean(returns) / dd) * Math.sqrt(periodsPerYear);
}

/** Maximaler Rückgang vom laufenden Hoch in %, ≥ 0 (0 bei leerer Kurve). */
export function maxDrawdownPct(equity: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = ((peak - e) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Probabilistic Sharpe Ratio: P(SR* > sr0) gegeben `n` Perioden mit
 * beobachtetem `sr`, Schiefe und (roher) Kurtosis. Schwere Ränder und
 * Linksschiefe vergrößern die Unsicherheit — deshalb stehen sie im Nenner.
 */
export function probabilisticSharpe(args: { sr: number; n: number; skew: number; kurt: number; sr0?: number | undefined }): number {
  const sr0 = args.sr0 ?? 0;
  const dof = Math.max(0, args.n - 1);
  const variance = 1 - args.skew * args.sr + ((args.kurt - 1) / 4) * args.sr * args.sr;
  // Mathematisch kann der Ausdruck bei extremer Schiefe ≤ 0 werden — dann ist die Aussage „unendlich sicher".
  const denom = Math.sqrt(Math.max(1e-12, variance));
  return normalCdf(((args.sr - sr0) * Math.sqrt(dof)) / denom);
}

export const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Erwartetes Maximum von N unabhängigen SR-Schätzungen mit Varianz `varSr`
 * und wahrem SR 0 — die Latte, die ein Suchsieger reißen muss.
 * N ≤ 1 oder varSr ≤ 0 ⇒ 0 (keine Auswahl, keine Inflation).
 */
export function expectedMaxSharpe(nTrials: number, varSr: number): number {
  if (!(nTrials > 1) || !(varSr > 0)) return 0;
  const g = EULER_MASCHERONI;
  return Math.sqrt(varSr) * ((1 - g) * normalInv(1 - 1 / nTrials) + g * normalInv(1 - 1 / (nTrials * Math.E)));
}

/** Deflated Sharpe Ratio = PSR gegen die Zufalls-Latte expectedMaxSharpe(nTrials, varSr). */
export function deflatedSharpe(args: { sr: number; n: number; skew: number; kurt: number; nTrials: number; varSr: number }): number {
  const sr0 = expectedMaxSharpe(args.nTrials, args.varSr);
  return probabilisticSharpe({ sr: args.sr, n: args.n, skew: args.skew, kurt: args.kurt, sr0 });
}

export function computeMetrics(args: {
  trades: Trade[];
  equity: EquityPoint[];
  dailyReturns: number[];
  initialEquity: number;
  periodsPerYear: number;
  days: number;
  exposurePct: number;
}): Metrics {
  const { trades, equity, dailyReturns, initialEquity, periodsPerYear, days, exposurePct } = args;
  const finalEquity = equity.length ? equity[equity.length - 1]!.equity : initialEquity;
  const netProfit = finalEquity - initialEquity;
  const netReturnPct = initialEquity > 0 ? (netProfit / initialEquity) * 100 : 0;
  const cagrPct =
    days >= 1 && initialEquity > 0 && finalEquity > 0 ? (Math.pow(finalEquity / initialEquity, 365 / days) - 1) * 100 : null;

  // Der Drawdown beginnt beim Startkapital — ein Verlust auf der ersten Bar ist einer.
  const curve: number[] = new Array(equity.length + 1);
  curve[0] = initialEquity;
  for (let i = 0; i < equity.length; i++) curve[i + 1] = equity[i]!.equity;

  let wins = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let sumNet = 0;
  let sumFees = 0;
  let sumGrossPos = 0;
  let sumR = 0;
  let nR = 0;
  for (const t of trades) {
    sumNet += t.netPnl;
    sumFees += t.fees;
    if (t.grossPnl > 0) sumGrossPos += t.grossPnl;
    if (t.netPnl > 0) {
      wins++;
      sumWin += t.netPnl;
    } else if (t.netPnl < 0) {
      sumLoss += -t.netPnl;
    }
    if (t.rMultiple !== null && Number.isFinite(t.rMultiple)) {
      sumR += t.rMultiple;
      nR++;
    }
  }
  const n = trades.length;
  return {
    netProfit,
    netReturnPct,
    cagrPct,
    sharpe: sharpeRatio(dailyReturns, periodsPerYear),
    sortino: sortinoRatio(dailyReturns, periodsPerYear),
    maxDrawdownPct: maxDrawdownPct(curve),
    profitFactor: n > 0 && sumLoss > 0 ? sumWin / sumLoss : null,
    winRatePct: n > 0 ? (wins / n) * 100 : null,
    expectancy: n > 0 ? sumNet / n : null,
    avgR: nR > 0 ? sumR / nR : null,
    trades: n,
    exposurePct,
    feeShare: sumGrossPos > 0 ? sumFees / sumGrossPos : null,
    days,
  };
}
