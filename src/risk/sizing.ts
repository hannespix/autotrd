/**
 * Positionsgröße — EINE Funktion für Backtest und Live.
 *
 * Grundlage ist die Equity (nicht das Bargeld — Owner-Erkenntnis 04.08.:
 * Sizing auf Cash lässt das Kapital brachliegen). Die Stückzahl ist das
 * Minimum aus BUDGET, Positionsdeckel, Exposure-Budget und (Long) Bargeld.
 *
 * Das Budget hat zwei Semantiken, und welche gilt, sagt die Strategie-WAHL
 * (`SizingSpec` in core/types.ts), nie die Strategie selbst:
 *
 *  - Risiko-Budget (Vorgabe): Equity × `riskPct` / Stop-Distanz. Ein weiter
 *    Stop heißt eine kleine Position — das Versprechen an den Nutzer
 *    („0,5 % je Trade"). Ein „Zielgewicht", das eine Strategie sich selbst
 *    gäbe, umginge dieses Versprechen (Prüfbefund zur ersten
 *    regime_allocation-Fassung, 09.09.: 4 % der Equity je ausgestopptem
 *    Trade statt 0,5 %) — deshalb gibt es diesen Weg für Strategien nicht.
 *  - Allokation (`sizing.mode: 'allocation'`): Equity × `positionPct`. Das
 *    ist die gemessene Semantik der Basis-Stufe (Prüfbefund K4): Position =
 *    20 % der Equity, unabhängig vom Risiko je Trade; das Risiko am Stop ist
 *    dann positionPct × Stop-Distanz (20 % × 20 % = 4 % der Equity). Die
 *    Semantik kommt aus dem Champion-Block `basis`, den die Basis-Latte
 *    geschrieben hat, und der Nutzer schaltet die Basis an oder aus — er
 *    stellt ihr Risiko nicht ein. `riskPct` ist in diesem Modus ohne Wirkung.
 *
 * In beiden Modi gelten die Deckel des Nutzers unverändert: `maxPositionPct`,
 * Exposure-Budget und Bargeld können die Position nur verkleinern, nie
 * vergrößern. Und ohne Stop auf der Verlustseite gibt es in keinem Modus
 * eine Stückzahl — der Katastrophen-Stop bleibt Pflicht.
 */
import type { Side, SizingSpec } from '../core/types.ts';

export interface SizeInput {
  equity: number;
  cash: number;
  price: number;
  stop: number;
  side: Side;
  /** % der Equity, die bei Stop-Ausführung verloren gehen darf (Risiko-Budget). */
  riskPct: number;
  /** % der Equity als Deckel für die Position. */
  maxPositionPct: number;
  /** Verbleibendes Brutto-Exposure-Budget in USD. */
  exposureBudget: number;
  /** Stückelung: 1 für Aktien (Brackets brauchen ganze Stücke), z. B. 0.0001 für Krypto. */
  qtyStep: number;
  /** Sizing-Semantik der Strategie-Wahl; fehlt sie, gilt das Risiko-Budget (`riskPct`). */
  sizing?: SizingSpec | undefined;
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

  // Das Budget: Risiko je Trade über die Stop-Distanz — oder, nur mit
  // ausdrücklicher Semantik der Wahl (Basis-Stufe), ein fester Anteil der
  // Equity. Beides ist EIN Pfad für Simulator und Engine.
  const allocation = inp.sizing?.mode === 'allocation';
  const byBudget = allocation ? (inp.equity * inp.sizing!.positionPct) / 100 / inp.price : (inp.equity * inp.riskPct) / 100 / riskPerUnit;
  const byCap = (inp.equity * inp.maxPositionPct) / 100 / inp.price;
  const byExposure = Math.max(0, inp.exposureBudget) / inp.price;
  const byCash = inp.side === 'long' ? Math.max(0, inp.cash) / inp.price : Number.POSITIVE_INFINITY;
  const raw = Math.min(byBudget, byCap, byExposure, byCash);
  const step = inp.qtyStep > 0 ? inp.qtyStep : 1;
  const qty = Math.floor(raw / step + 1e-9) * step;
  const rounded = Number(qty.toFixed(8));
  if (rounded <= 0) {
    const limiter =
      raw === byBudget ? (allocation ? 'Allokation' : 'Risiko-Budget') : raw === byCap ? 'Positionsdeckel' : raw === byExposure ? 'Exposure-Budget' : 'Bargeld';
    return { qty: 0, riskPerUnit, notional: 0, reason: `Stückzahl < ${step} (${limiter})` };
  }
  return { qty: rounded, riskPerUnit, notional: rounded * inp.price, reason: null };
}
