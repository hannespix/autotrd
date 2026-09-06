/**
 * Champion (`meta/champion`, Format `ChampionFile` aus `src/optimize/promote.ts`)
 * ⇒ `strategyFor(symbol)`. Dieselben Regeln wie `strategyChoice` in
 * `src/app.ts` (das vom Functions-Build ausgeschlossen ist): Champion hat
 * Vorrang, `noTrade` heißt null, ohne Champion greift die Config-Strategie
 * nur mit `strategy.allowWithoutChampion`. Ein Symbol ohne Strategie wird
 * nicht gehandelt — Exits laufen trotzdem (Regel 4).
 */
import type { Config } from '../../../src/core/config.ts';
import { errMsg, logger } from '../../../src/core/log.ts';
import type { Params, Strategy } from '../../../src/core/types.ts';
import type { ChampionFile } from '../../../src/optimize/promote.ts';
import { getStrategy as registryStrategy, mergeParams } from '../../../src/strategy/index.ts';
import { isRecord } from './firestoreLike.js';

/** `meta/champion` lesen; fehlt das Doc ⇒ null; falsche Version ⇒ Fehler (nie raten). */
export function championFromDoc(data: Record<string, unknown> | undefined): ChampionFile | null {
  if (!data) return null;
  if (data.version !== 1) throw new Error(`meta/champion: unbekannte Champion-Version ${String(data.version)} — Dokument prüfen statt überschreiben`);
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    symbols: (isRecord(data.symbols) ? data.symbols : {}) as ChampionFile['symbols'],
    noTrade: (isRecord(data.noTrade) ? data.noTrade : {}) as ChampionFile['noTrade'],
  };
}

export type StrategyChoice = { strategy: Strategy; params: Params };
export type StrategyFn = (symbol: string) => StrategyChoice | null;

export interface StrategyMap {
  fn: StrategyFn;
  source: 'champion' | 'config' | 'none';
  /** Symbole mit Strategie (werden gehandelt). */
  tradable: string[];
  /** Hinweise fürs Journal (kein Champion, Zeitrahmen weicht ab, …). */
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
  let source: StrategyMap['source'] = 'none';
  for (const symbol of a.config.universe.symbols) {
    let choice: StrategyChoice | null = null;
    const entry = a.champion?.symbols[symbol];
    if (entry) {
      if (entry.timeframe !== tf) {
        notes.push(`${symbol}: Champion-Zeitrahmen ${entry.timeframe} ≠ Config ${tf} — nicht gehandelt`);
      } else {
        try {
          const strategy = get(entry.strategy);
          choice = { strategy, params: mergeParams(strategy.defaults, entry.params) };
          source = 'champion';
        } catch (e) {
          notes.push(`${symbol}: Champion-Strategie nicht ladbar (${errMsg(e)}) — nicht gehandelt`);
        }
      }
    } else if (a.champion?.noTrade[symbol]) {
      // bewusst kein Handel — der Optimierer hat entschieden
    } else if (a.config.strategy.allowWithoutChampion) {
      try {
        const strategy = get(a.config.strategy.id);
        if (strategy.timeframes.includes(tf)) {
          choice = { strategy, params: mergeParams(strategy.defaults, a.config.strategy.params) };
          if (source === 'none') source = 'config';
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
  for (const n of notes) log.warn(n);
  const tradable = [...map].filter(([, c]) => c !== null).map(([s]) => s);
  return { fn: (symbol) => map.get(symbol) ?? null, source, tradable, notes };
}
