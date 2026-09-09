/**
 * Die Basis-Stufe: Welche Symbole handelt der Champion-Block `basis`, und wie?
 *
 * EIN Kern für beide Betriebsarten: `src/app.ts` (`strategyChoice`, eigener
 * Prozess) und `functions/src/engine/strategyFor.ts` (`buildStrategyFor`,
 * Plattform) fragen hier nach — dieselbe Reihenfolge, dieselben Bedingungen.
 *
 * Reihenfolge je Symbol (Owner-Anweisung, 09.09.2026):
 *   1. Alpha-Champion (`champion.symbols[symbol]`) — er führt das Symbol; die
 *      Basis übersteuert NIE ein Symbol, das der Alpha-Champion handelt.
 *   2. Basis (`champion.basis`), wenn ALLE Bedingungen stehen:
 *      Block vorhanden · `pass === true` (die Basis-Latte, §0.9) · Zeitrahmen
 *      des Blocks = Zeitrahmen der Config · Symbol im Korb des Blocks ·
 *      `positionPct` im Block (Sizing-Semantik der Messung, Prüfbefund K4) ·
 *      Schalter an (`strategy.basis`; auf der Plattform der Nutzer-Schalter
 *      `settings.auto.basis`).
 *   3. `noTrade` / nichts (bzw. die Config-Strategie mit
 *      `allowWithoutChampion`, wie bisher).
 *
 * Die Basis handelt nie, wenn `pass` false ist — ein Block ohne bestandene
 * Latte ist ein Befund, keine Freigabe. Und sie handelt den Korb als Ganzes:
 * Auf der Plattform wählt der Nutzer Alpha-Symbole aus, die Basis kommt als
 * Block dazu (`universeWithBasis`) oder gar nicht — ein Teilkorb wäre eine
 * andere Strategie als die gemessene (Rang über weniger Symbole).
 *
 * Bekannte Grenze, nicht wegdefiniert: Führt der Alpha-Champion ein Symbol des
 * Basis-Korbs (SPY etwa), fehlt es der Basis — sie rangiert dann über einen
 * um dieses Symbol kleineren Korb als gemessen. Unter MIN_KORB hält sie still
 * (regimeAllocation.ts). Das steht im Journal (`note`).
 */
import type { Config } from './config.ts';
import type { Params, SizingSpec, TimeframeMin } from './types.ts';
import type { ChampionBasis, ChampionFile } from '../optimize/promote.ts';

/** Die handelbare Basis eines Champions — oder der Grund, warum nicht. */
export type BasisStatus =
  | { tradable: true; basis: ChampionBasis; symbols: readonly string[]; sizing: SizingSpec; note: string }
  | { tradable: false; basis: ChampionBasis | null; reason: string | null };

/** Wahl der Basis-Stufe für EIN Symbol (Strategie-ID und Parameter des Blocks, Allokations-Sizing). */
export interface BasisChoice {
  strategyId: string;
  params: Params;
  sizing: SizingSpec;
  label: string;
}

/**
 * Ist die Basis des Champions handelbar? Prüft alles außer der Symbolfrage.
 * `reason` ist null, wenn es schlicht keinen Block gibt (kein Journal-Rauschen);
 * sonst der Text fürs Journal.
 */
export function basisStatus(a: { champion: ChampionFile | null; timeframe: TimeframeMin; enabled: boolean }): BasisStatus {
  const basis = a.champion?.basis ?? null;
  if (!basis) return { tradable: false, basis: null, reason: null };
  const name = `Basis-Allokation „${basis.label}"`;
  if (basis.pass !== true) return { tradable: false, basis, reason: `${name}: Latte nicht bestanden — nicht gehandelt` };
  if (basis.timeframe !== a.timeframe) return { tradable: false, basis, reason: `${name}: Zeitrahmen ${basis.timeframe} ≠ Config ${a.timeframe} — nicht gehandelt` };
  const pct = basis.positionPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) {
    return { tradable: false, basis, reason: `${name}: Block ohne positionPct (Lauf vor der Basis-Stufe) — Sizing-Semantik unbekannt, nicht gehandelt` };
  }
  if (!Array.isArray(basis.symbols) || basis.symbols.length === 0) return { tradable: false, basis, reason: `${name}: Block ohne Symbole — nicht gehandelt` };
  if (!a.enabled) return { tradable: false, basis, reason: `${name}: vom Nutzer abgeschaltet — nicht gehandelt` };
  const sizing: SizingSpec = { mode: 'allocation', positionPct: pct };
  return {
    tradable: true,
    basis,
    symbols: basis.symbols,
    sizing,
    note: `${name}: ${basis.symbols.length} Symbole (${basis.symbols.join(', ')}), ${basis.strategy}, Position ${pct} % der Equity je Symbol (Allokation; Risiko je Trade ohne Wirkung)`,
  };
}

/**
 * Die Basis-Wahl für ein Symbol — nur, wenn kein Alpha-Champion es führt
 * (`alphaLeads`), die Basis handelbar ist und das Symbol im Korb steht.
 */
export function basisChoiceFor(a: { status: BasisStatus; symbol: string; alphaLeads: boolean }): BasisChoice | null {
  if (a.alphaLeads || !a.status.tradable) return null;
  if (!a.status.symbols.includes(a.symbol)) return null;
  return { strategyId: a.status.basis.strategy, params: a.status.basis.params, sizing: a.status.sizing, label: a.status.basis.label };
}

/**
 * Das Universum der Engine mit dem Basis-Korb: `universe.symbols` ∪
 * `basis.symbols`, wenn die Basis handelbar ist — sonst unverändert. Die
 * Engine (`src/engine/engine.ts`) führt nur Symbole ihres Universums; ohne
 * diese Erweiterung könnte die Basis ihren Korb nicht handeln (und ein
 * Teilkorb wäre eine andere Strategie). Gilt für `run` und den Takt, NICHT
 * für den Optimierer: Dort ist der Basis-Korb eine eigene Einheit
 * (`optimizer.basisUniverse`), die Alpha-Einheit bleibt der Korb der Config.
 */
export function universeWithBasis(config: Config, champion: ChampionFile | null): Config {
  const status = basisStatus({ champion, timeframe: config.timeframe, enabled: config.strategy.basis });
  if (!status.tradable) return config;
  const symbols = [...new Set([...config.universe.symbols, ...status.symbols])];
  if (symbols.length === config.universe.symbols.length) return config;
  return { ...config, universe: { ...config.universe, symbols } };
}
