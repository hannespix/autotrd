/**
 * Register der Strategie-Vorlagen. Engine, Backtest und Optimierer holen
 * sich Strategien ausschließlich hier — eine unbekannte ID ist ein
 * Konfigurationsfehler und wirft mit der Liste der bekannten IDs.
 */
import type { Params, Strategy } from '../core/types.ts';
import { mergeParams, validateParams } from './params.ts';
import { strategy as trendDonchian } from './trendDonchian.ts';
import { strategy as momentumPullback } from './momentumPullback.ts';
import { strategy as meanReversion } from './meanReversion.ts';
import { strategy as orbBreakout } from './orbBreakout.ts';

export const STRATEGIES: readonly Strategy[] = Object.freeze([trendDonchian, momentumPullback, meanReversion, orbBreakout]);

export function strategyIds(): string[] {
  return STRATEGIES.map((s) => s.id);
}

export function getStrategy(id: string): Strategy {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`Unbekannte Strategie "${id}". Bekannt: ${strategyIds().join(', ')}`);
  return s;
}

/** Defaults ← Overrides, danach streng validiert — der eine Weg zu gültigen Parametern. */
export function resolveParams(s: Strategy, overrides: Partial<Params> = {}): Params {
  const p = mergeParams(s.defaults, overrides);
  validateParams(s.paramSpace, p);
  return p;
}

export { ParamError, gridOf, mergeParams, paramKey, snapToGrid, validateParams } from './params.ts';
