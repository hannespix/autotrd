/**
 * Parameter-Sweeps (M11): pure Planungs- und Anwendungslogik — getrennt vom
 * Callable, damit Gitter-Clamps und Kombi-Deckel hart unit-getestet sind.
 *
 * Bewusst ≤ 2 Achsen und ≤ 60 Kombis (MILESTONES): Die Historie wird einmal
 * geladen, alle Kombis rechnen im RAM über compileClassic + backtestSpec.
 * Kein Auto-Apply — der beste Punkt wird nur als Entwurf übernommen.
 */

import type { Strategy } from '../../../shared/src/index.js';

export const MAX_COMBOS = 60;
export const MAX_AXIS_VALUES = 12;

interface SweepParamDef {
  label: string;
  min: number;
  max: number;
  /** Wert in eine KOPIE der Strategie schreiben. */
  apply: (s: Strategy, v: number) => void;
}

/** Whitelist der sweepbaren Classic-Parameter (harte Bounds = Engine-Bounds). */
export const SWEEP_PARAMS: Record<string, SweepParamDef> = {
  rsiBuy: {
    label: 'RSI Kauf <',
    min: 5,
    max: 45,
    apply: (s, v) => {
      s.indicators.rsi.thresholdBuy = v;
    },
  },
  rsiSell: {
    label: 'RSI Verkauf >',
    min: 55,
    max: 95,
    apply: (s, v) => {
      s.indicators.rsi.thresholdSell = v;
    },
  },
  bbBreakout: {
    label: 'BB-Ausbruch %',
    min: 50,
    max: 100,
    apply: (s, v) => {
      s.indicators.bollinger.bbBreakoutPct = v;
    },
  },
  minConfluence: {
    label: 'Min. Konfluenz',
    min: 1,
    max: 5,
    apply: (s, v) => {
      s.signals.minConfluence = Math.round(v);
    },
  },
  forecastWeight: {
    label: 'Prognose-Gewicht',
    min: 0,
    max: 3,
    apply: (s, v) => {
      s.signals.forecastWeight = Math.round(v);
      s.signals.useForecast = v > 0;
    },
  },
};

export interface SweepPoint {
  x: number;
  y: number | null;
}

/** Achsen validieren: Whitelist, Zahlen, Clamp auf Bounds, Dedupe, Deckel. */
export function buildSweepPlan(
  xParam: string,
  xValues: number[],
  yParam?: string,
  yValues?: number[],
): SweepPoint[] {
  const clean = (param: string, values: number[]): number[] => {
    const def = SWEEP_PARAMS[param];
    if (!def) throw new Error(`Unbekannter Sweep-Parameter: ${param}`);
    const nums = values
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .map((v) => Math.min(def.max, Math.max(def.min, v)));
    const uniq = [...new Set(nums)];
    if (uniq.length === 0) throw new Error(`Keine gültigen Werte für ${param}`);
    if (uniq.length > MAX_AXIS_VALUES) throw new Error(`Zu viele Werte für ${param} (max ${MAX_AXIS_VALUES})`);
    return uniq.sort((a, b) => a - b);
  };

  const xs = clean(xParam, xValues);
  if (yParam !== undefined && yParam === xParam) throw new Error('X- und Y-Parameter müssen verschieden sein');
  const ys = yParam !== undefined ? clean(yParam, yValues ?? []) : [null];
  if (xs.length * ys.length > MAX_COMBOS) {
    throw new Error(`Zu viele Kombinationen: ${xs.length * ys.length} (max ${MAX_COMBOS})`);
  }
  const plan: SweepPoint[] = [];
  for (const y of ys) for (const x of xs) plan.push({ x, y });
  return plan;
}

/** Basis-Strategie klonen und den Sweep-Punkt anwenden (Basis bleibt unberührt). */
export function applySweepPoint(
  base: Strategy,
  xParam: string,
  x: number,
  yParam?: string,
  y?: number | null,
): Strategy {
  const clone = JSON.parse(JSON.stringify(base)) as Strategy;
  SWEEP_PARAMS[xParam]!.apply(clone, x);
  if (yParam !== undefined && y !== null && y !== undefined) SWEEP_PARAMS[yParam]!.apply(clone, y);
  return clone;
}
