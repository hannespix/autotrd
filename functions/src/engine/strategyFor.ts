/**
 * Champion (`meta/champion`, Format `ChampionFile` aus `src/optimize/promote.ts`)
 * ⇒ `strategyFor(symbol)`. Dieselben Regeln wie `strategyChoice` in
 * `src/app.ts` (das vom Functions-Build ausgeschlossen ist), gemeinsamer Kern
 * `src/core/basisTier.ts`: Alpha-Champion hat Vorrang, dann die Basis-Stufe
 * (Block `basis`: bestanden, Zeitrahmen passt, Symbol im Korb, Nutzer-Schalter
 * `strategy.basis` an), `noTrade` heißt null, ohne Champion greift die
 * Config-Strategie nur mit `strategy.allowWithoutChampion`. Ein Symbol ohne
 * Strategie wird nicht gehandelt — Exits laufen trotzdem (Regel 4).
 *
 * Die Basis übersteuert NIE ein Symbol des Alpha-Champions und handelt nie
 * bei `pass: false`; ihre Symbole tragen `source: 'basis'` und die
 * Allokations-Semantik (`sizing`), die `decide()` unverändert bekommt.
 */
import { basisChoiceFor, basisStatus } from '../../../src/core/basisTier.ts';
import type { Config } from '../../../src/core/config.ts';
import { errMsg, logger } from '../../../src/core/log.ts';
import type { Params, SizingSpec, Strategy } from '../../../src/core/types.ts';
import type { ChampionBasis, ChampionFile } from '../../../src/optimize/promote.ts';
import { getStrategy as registryStrategy, mergeParams } from '../../../src/strategy/index.ts';
import { isRecord } from './firestoreLike.js';

/** `meta/champion` lesen; fehlt das Doc ⇒ null; falsche Version ⇒ Fehler (nie raten). Der Block `basis` ist additiv. */
export function championFromDoc(data: Record<string, unknown> | undefined): ChampionFile | null {
  if (!data) return null;
  if (data.version !== 1) throw new Error(`meta/champion: unbekannte Champion-Version ${String(data.version)} — Dokument prüfen statt überschreiben`);
  const file: ChampionFile = {
    version: 1,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    symbols: (isRecord(data.symbols) ? data.symbols : {}) as ChampionFile['symbols'],
    noTrade: (isRecord(data.noTrade) ? data.noTrade : {}) as ChampionFile['noTrade'],
  };
  if (isRecord(data.basis)) {
    if (data.basis.version !== 1) throw new Error(`meta/champion: unbekannte Basis-Version ${String(data.basis.version)} — Dokument prüfen statt überschreiben`);
    file.basis = data.basis as unknown as ChampionBasis;
  }
  return file;
}

export type StrategySource = 'champion' | 'basis' | 'config';
export type StrategyChoice = { strategy: Strategy; params: Params; source: StrategySource; sizing?: SizingSpec | undefined };
export type StrategyFn = (symbol: string) => StrategyChoice | null;

export interface StrategyMap {
  fn: StrategyFn;
  /** Vorherrschende Quelle: champion, sobald ein Alpha-Symbol handelt; sonst basis; sonst config; sonst none. */
  source: StrategySource | 'none';
  /** Symbole mit Strategie (werden gehandelt). */
  tradable: string[];
  /** Symbole, die die Basis-Stufe führt (Teilmenge von `tradable`). */
  basisSymbols: string[];
  /** Hinweise fürs Journal (kein Champion, Zeitrahmen weicht ab, Basis aktiv/inaktiv, …). */
  notes: string[];
}

export function buildStrategyFor(a: {
  champion: ChampionFile | null;
  config: Config;
  /** Injizierbar für Tests (Skript-Strategie); Default: Register in src/strategy. */
  getStrategy?: ((id: string) => Strategy) | undefined;
  log?: typeof logger | undefined;
}): StrategyMap {
  const get = a.getStrategy ?? registryStrategy;
  const log = a.log ?? logger;
  const tf = a.config.timeframe;
  const map = new Map<string, StrategyChoice | null>();
  const notes: string[] = [];
  const basis = basisStatus({ champion: a.champion, timeframe: tf, enabled: a.config.strategy.basis });
  let alphaSymbole = 0;
  let basisSymbole = 0;
  let configSymbole = 0;
  for (const symbol of a.config.universe.symbols) {
    let choice: StrategyChoice | null = null;
    const entry = a.champion?.symbols[symbol];
    const basisWahl = basisChoiceFor({ status: basis, symbol, alphaLeads: entry !== undefined });
    if (entry) {
      if (entry.timeframe !== tf) {
        notes.push(`${symbol}: Champion-Zeitrahmen ${entry.timeframe} ≠ Config ${tf} — nicht gehandelt`);
      } else {
        try {
          const strategy = get(entry.strategy);
          choice = { strategy, params: mergeParams(strategy.defaults, entry.params), source: 'champion' };
          alphaSymbole++;
        } catch (e) {
          notes.push(`${symbol}: Champion-Strategie nicht ladbar (${errMsg(e)}) — nicht gehandelt`);
        }
      }
    } else if (basisWahl) {
      // Basis vor noTrade: Der Korb der bestandenen Basis handelt, was kein Alpha-Champion führt.
      try {
        const strategy = get(basisWahl.strategyId);
        choice = { strategy, params: mergeParams(strategy.defaults, basisWahl.params), source: 'basis', sizing: basisWahl.sizing };
        basisSymbole++;
      } catch (e) {
        notes.push(`${symbol}: Basis-Strategie nicht ladbar (${errMsg(e)}) — nicht gehandelt`);
      }
    } else if (a.champion?.noTrade[symbol]) {
      // bewusst kein Handel — der Optimierer hat entschieden
    } else if (a.config.strategy.allowWithoutChampion) {
      try {
        const strategy = get(a.config.strategy.id);
        if (strategy.timeframes.includes(tf)) {
          choice = { strategy, params: mergeParams(strategy.defaults, a.config.strategy.params), source: 'config' };
          configSymbole++;
        } else notes.push(`${symbol}: Config-Strategie ${strategy.id} kennt Zeitrahmen ${tf} nicht — nicht gehandelt`);
      } catch (e) {
        notes.push(`${symbol}: Config-Strategie nicht ladbar (${errMsg(e)}) — nicht gehandelt`);
      }
    }
    map.set(symbol, choice);
  }
  if (!a.champion && !a.config.strategy.allowWithoutChampion) {
    notes.push('kein Champion (meta/champion fehlt) und strategy.allowWithoutChampion=false — keine Einstiege, Exits laufen weiter');
  }
  // Die Basis-Stufe steht im Journal: aktiv mit Korb und Sizing, oder warum nicht.
  if (basis.tradable) {
    const fehlend = basis.symbols.filter((s) => !a.config.universe.symbols.includes(s));
    const alpha = basis.symbols.filter((s) => a.champion?.symbols[s] !== undefined);
    notes.push(basis.note);
    if (alpha.length) notes.push(`Basis-Allokation: ${alpha.join(', ')} führt der Alpha-Champion — die Basis rangiert ohne diese Symbole`);
    if (fehlend.length) notes.push(`Basis-Allokation: ${fehlend.join(', ')} nicht im Universum dieser Engine — die Basis rangiert ohne diese Symbole`);
  } else if (basis.reason !== null) {
    notes.push(basis.reason);
  }
  for (const n of notes) log.warn(n);
  const tradable = [...map].filter(([, c]) => c !== null).map(([s]) => s);
  const basisSymbols = [...map].filter(([, c]) => c?.source === 'basis').map(([s]) => s);
  const source: StrategyMap['source'] = alphaSymbole > 0 ? 'champion' : basisSymbole > 0 ? 'basis' : configSymbole > 0 ? 'config' : 'none';
  return { fn: (symbol) => map.get(symbol) ?? null, source, tradable, basisSymbols, notes };
}
