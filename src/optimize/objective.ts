/**
 * Zielfunktion der Suche. Bewusst OHNE Trade-Haircut: Wer die Stichproben-
 * größe ins Ziel mischt, verschiebt nur, wo die Schwelle liegt — und macht
 * sie unsichtbar. Die Mindestzahl an Trades ist deshalb ein eigenes Gate
 * (robustness.ts), das im Bericht mit Wert und Schwelle steht.
 */
import type { OptimizerConfig } from '../core/config.ts';
import type { Metrics } from '../core/types.ts';

export type ObjectiveId = OptimizerConfig['objective'];

/**
 * Objective einer Metrik-Menge. Nicht berechenbar (null/NaN) und
 * 0 Trades ⇒ −Infinity, damit solche Kandidaten in jeder Rangfolge
 * ganz unten landen, ohne dass ein Aufrufer Sonderfälle prüfen muss.
 */
export function objectiveValue(id: ObjectiveId, m: Metrics): number {
  if (!(m.trades > 0)) return -Infinity;
  let v: number | null;
  switch (id) {
    case 'sortino':
      v = m.sortino;
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
  return v;
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
