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
import { strategy as crossSectionalMomentum } from './crossSectionalMomentum.ts';
import { strategy as regimeAllocation } from './regimeAllocation.ts';
import { strategy as vigilantAllocation } from './vigilantAllocation.ts';
import { strategy as indexReversal } from './indexReversal.ts';
import { strategy as turnOfMonth } from './turnOfMonth.ts';

/**
 * Registriert heißt NICHT gehandelt: Was hier steht, ist messbar. Gehandelt
 * wird ausschließlich, was der Champion nennt (`strategy.allowWithoutChampion:
 * false`), und gemessen wird, was eine Config in `optimizer.strategies` oder
 * `optimizer.fixedCandidates` aufführt. Die drei Sleeves vom 12.09.2026
 * (`vigilant_allocation`, `index_reversal`, `turn_of_month`) stehen deshalb
 * hier, aber in keiner Produktions-Config — ihre Probe-Configs sind
 * `config/vigilant-1440.yaml` und `config/sleeves-1440.yaml`.
 */
export const STRATEGIES: readonly Strategy[] = Object.freeze([
  trendDonchian,
  momentumPullback,
  meanReversion,
  orbBreakout,
  crossSectionalMomentum,
  regimeAllocation,
  vigilantAllocation,
  indexReversal,
  turnOfMonth,
]);

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
