/**
 * Positionsgröße — EINE Funktion für Backtest und Live.
 *
 * Grundlage ist die Equity (nicht das Bargeld — Owner-Erkenntnis 04.08.:
 * Sizing auf Cash lässt das Kapital brachliegen). Das Risiko je Trade ist
 * die Distanz Einstand ↔ Stop; die Stückzahl ist das Minimum aus
 * Risiko-Budget, Positionsdeckel, Exposure-Budget und (Long) Bargeld.
 */
import type { Side } from '../core/types.ts';

export interface SizeInput {
  equity: number;
  cash: number;
  price: number;
  stop: number;
  side: Side;
  /** % der Equity, die bei Stop-Ausführung verloren gehen darf. */
  riskPct: number;
  /** % der Equity als Deckel für die Position. */
  maxPositionPct: number;
  /** Verbleibendes Brutto-Exposure-Budget in USD. */
  exposureBudget: number;
  /** Stückelung: 1 für Aktien (Brackets brauchen ganze Stücke), z. B. 0.0001 für Krypto. */
  qtyStep: number;
}

export interface SizeResult {
  qty: number;
  riskPerUnit: number;
  notional: number;
  /** Warum 0 (wenn qty = 0). */
  reason: string | null;
}

export function sizePosition(inp: SizeInput): SizeResult {
  const riskPerUnit = inp.side === 'long' ? inp.price - inp.stop : inp.stop - inp.price;
  if (!(inp.price > 0)) return { qty: 0, riskPerUnit: 0, notional: 0, reason: 'Kurs ungültig' };
  if (!(riskPerUnit > 0)) return { qty: 0, riskPerUnit, notional: 0, reason: 'Stop liegt nicht auf der Verlustseite' };
  if (!(inp.equity > 0)) return { qty: 0, riskPerUnit, notional: 0, reason: 'Equity ≤ 0' };

  const byRisk = (inp.equity * inp.riskPct) / 100 / riskPerUnit;
  const byCap = (inp.equity * inp.maxPositionPct) / 100 / inp.price;
  const byExposure = Math.max(0, inp.exposureBudget) / inp.price;
  const byCash = inp.side === 'long' ? Math.max(0, inp.cash) / inp.price : Number.POSITIVE_INFINITY;
  const raw = Math.min(byRisk, byCap, byExposure, byCash);
  const step = inp.qtyStep > 0 ? inp.qtyStep : 1;
  const qty = Math.floor(raw / step + 1e-9) * step;
  const rounded = Number(qty.toFixed(8));
  if (rounded <= 0) {
    const limiter =
      raw === byRisk ? 'Risiko-Budget' : raw === byCap ? 'Positionsdeckel' : raw === byExposure ? 'Exposure-Budget' : 'Bargeld';
    return { qty: 0, riskPerUnit, notional: 0, reason: `Stückzahl < ${step} (${limiter})` };
  }
  return { qty: rounded, riskPerUnit, notional: rounded * inp.price, reason: null };
}
