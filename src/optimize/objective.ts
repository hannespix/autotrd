/**
 * Zielfunktion der Suche. Bewusst OHNE Trade-Haircut: Wer die Stichproben-
 * größe ins Ziel mischt, verschiebt nur, wo die Schwelle liegt — und macht
 * sie unsichtbar. Die Mindestzahl an Trades ist deshalb ein eigenes Gate
 * (robustness.ts), das im Bericht mit Wert und Schwelle steht.
 */
import type { OptimizerConfig } from '../core/config.ts';
import type { Metrics } from '../core/types.ts';

export type ObjectiveId = OptimizerConfig['objective'];

/** Endliche Objectives werden hierauf geklemmt — ±∞ bleibt Sentinel für "kein Beleg". */
export const OBJECTIVE_CAP = 1e6;
/**
 * Fenster ohne Verlusttag bei positivem Mittel: Sortino wäre +∞ (Downside 0).
 * Solche Fenster rangieren über jedem endlichen Sortino, untereinander nach
 * Sharpe — die Basis liegt weit über realistischen Sortino-Werten.
 */
export const PERFECT_WINDOW_BASE = 1e5;

function clamp(v: number): number {
  if (v === -Infinity) return -Infinity;
  return Math.max(-OBJECTIVE_CAP, Math.min(OBJECTIVE_CAP, v));
}

/**
 * Sortino mit Rückfall: `sortinoRatio` liefert null ohne Verlusttag (Downside
 * 0) — das ist der BESTE Fall, nicht der schlechteste. Red-Team-Befund: als
 * −∞ zog ein perfekter Fold den Fold-Median nach unten und ein perfekter
 * IS-Kandidat konnte nie `best` werden.
 */
function sortinoObjective(m: Metrics): number {
  if (m.sortino !== null && Number.isFinite(m.sortino)) return m.sortino;
  const sharpe = m.sharpe;
  if (sharpe === null || !Number.isFinite(sharpe)) return m.netProfit > 0 ? OBJECTIVE_CAP : -Infinity;
  if (sharpe > 0) return PERFECT_WINDOW_BASE + sharpe;
  // Renditen ≥ 0 mit Mittel ≤ 0 gibt es nur als "alle null" (dann ist Sharpe null) — Sicherheitsnetz.
  return sharpe;
}

/**
 * Objective einer Metrik-Menge. 0 Trades ⇒ −Infinity (kein Beleg), damit
 * solche Kandidaten in jeder Rangfolge ganz unten landen; nicht berechenbar
 * (null/NaN) ebenso. Endliche Werte auf ±OBJECTIVE_CAP geklemmt.
 */
export function objectiveValue(id: ObjectiveId, m: Metrics): number {
  if (!(m.trades > 0)) return -Infinity;
  let v: number | null;
  switch (id) {
    case 'sortino':
      v = sortinoObjective(m);
      break;
    case 'sharpe':
      v = m.sharpe;
      break;
    case 'return_over_dd':
      // Drawdown unter 1 % wird auf 1 % gedeckelt: sonst explodiert das
      // Verhältnis bei winzigen Drawdowns und belohnt Zufallstreffer.
      v = m.netReturnPct / Math.max(m.maxDrawdownPct, 1);
      break;
  }
  if (v === null || Number.isNaN(v)) return -Infinity;
  return clamp(v);
}

/* ───────────────────────── Kleine Statistik-Helfer ───────────────────────── */

/** Median; leere Liste ⇒ −Infinity (kein Beleg = schlechtester Wert). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return -Infinity;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid]!;
  const lo = s[mid - 1]!;
  const hi = s[mid]!;
  // ±Infinity-Mischung ergäbe NaN — dann zählt die schlechte Hälfte.
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return Math.min(lo, hi);
  return (lo + hi) / 2;
}

/** Arithmetisches Mittel; leere Liste ⇒ −Infinity. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return -Infinity;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Stichprobenvarianz (n−1); weniger als 2 Werte ⇒ null. */
export function sampleVariance(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - 1);
}

/**
 * Sharpe je Periode (Mittel / Stichproben-Standardabweichung, nicht
 * annualisiert). Für die Streuung der Trials im Deflated Sharpe — bewusst
 * ohne Injektion, damit walkForward keine Statistik-Abhängigkeit braucht.
 */
export function perPeriodSharpe(returns: readonly number[]): number | null {
  if (returns.length < 2) return null;
  const m = mean(returns);
  let s = 0;
  for (const r of returns) s += (r - m) * (r - m);
  const sd = Math.sqrt(s / (returns.length - 1));
  if (!(sd > 0)) return null;
  const v = m / sd;
  return Number.isFinite(v) ? v : null;
}
