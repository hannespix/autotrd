/**
 * Bootstrap für alle CLI-Kommandos: Config + .env laden, Modus über den
 * Doppel-Guard auflösen, Secrets schwärzen, Pfade und Broker-Client bauen,
 * Champion in `strategyFor` übersetzen. Hier steht die Verdrahtung —
 * Fachlogik liegt in den Modulen.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAlpacaClient } from './alpaca/rest.ts';
import type { AlpacaClient } from './alpaca/types.ts';
import { aggregate, BarSeries } from './core/bars.ts';
import { homeDir, loadConfigFile, loadEnv, resolveMode, type Config, type Env } from './core/config.ts';
import { ensureDir, homePaths, Journal, StateStore, type HomePaths } from './core/journal.ts';
import { logger, registerSecret, setLogLevel } from './core/log.ts';
import { dayKeyFor, sessionBounds, type Calendar } from './core/time.ts';
import type { Bar, BarSeriesLike, Params, Strategy, TimeframeMin } from './core/types.ts';
import { loadCalendarFile } from './data/calendar.ts';
import { BarStore, barStoreRoot } from './data/store.ts';
import { loadChampion, type ChampionFile } from './optimize/promote.ts';
import { ladeUniverseDatei, mitUniverse } from './universe/file.ts';
import { getStrategy } from './strategy/index.ts';
import { mergeParams } from './strategy/params.ts';

export interface AppOptions {
  config: string;
  env: string;
  home?: string | undefined;
  verbose?: boolean | undefined;
  /**
   * Pfad zur Auswahl aus `autotrd universe`. Gesetzt ⇒ sie ersetzt
   * `universe.symbols`; fehlt die Datei, gilt die Config (erster Lauf).
   * `'auto'` nimmt `<home>/universe.json`.
   */
  universeFile?: string | undefined;
}

export interface App {
  config: Config;
  env: Env;
  mode: 'paper' | 'live';
  modeReasons: string[];
  home: string;
  paths: HomePaths;
  journal: Journal;
  state: StateStore;
  store: BarStore;
  calendar: Calendar | undefined;
  /** Nur mit Keys; sonst null (Backtest/Optimierung brauchen keinen Broker). */
  client: AlpacaClient | null;
  champion: ChampionFile | null;
}

export function bootstrap(opts: AppOptions): App {
  if (opts.verbose) setLogLevel('debug');
  const env = loadEnv(opts.env);
  registerSecret(env.ALPACA_API_KEY);
  registerSecret(env.ALPACA_SECRET_KEY);
  registerSecret(env.TELEGRAM_BOT_TOKEN);
  const roh = loadConfigFile(opts.config);
  const { mode, reasons } = resolveMode(roh, env);
  const home = opts.home ? resolve(opts.home) : homeDir(roh, env);
  ensureDir(home);
  const paths = homePaths(home);
  // Nächtliche Auswahl anwenden, falls verlangt. Fehlt sie, bleibt es beim
  // committeten Universum — nie stillschweigend etwas anderes handeln.
  let config = roh;
  if (opts.universeFile) {
    const pfad = opts.universeFile === 'auto' ? paths.universe : resolve(opts.universeFile);
    const gewaehlt = ladeUniverseDatei(pfad, roh);
    if (gewaehlt) {
      config = mitUniverse(roh, gewaehlt);
      logger.info(`Universum aus der Auswahl: ${gewaehlt.length} Symbole (${pfad})`);
    } else {
      logger.warn(`Keine Universums-Auswahl unter ${pfad} — es gilt das Universum aus der Config (${roh.universe.symbols.length} Symbole).`);
    }
  }
  const client =
    env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY
      ? createAlpacaClient({
          mode,
          keyId: env.ALPACA_API_KEY,
          secret: env.ALPACA_SECRET_KEY,
          feed: config.broker.feed,
          assetClass: config.universe.assetClass,
        })
      : null;
  const calendar = loadCalendarFile(paths.calendar) ?? undefined;
  return {
    config,
    env,
    mode,
    modeReasons: reasons,
    home,
    paths,
    journal: new Journal(paths.journal),
    state: new StateStore(paths.state),
    // Derselbe Wurzelpfad wie in der Engine (bars/<assetClass>/<feed>/) — sonst
    // lesen fetch/backtest und die Engine verschiedene Caches.
    store: new BarStore(barStoreRoot(paths.bars, config.universe.assetClass, config.broker.feed)),
    calendar,
    client,
    champion: loadChampion(paths.champion),
  };
}

export function requireClient(app: App): AlpacaClient {
  if (!app.client) {
    throw new Error('Keine Alpaca-Keys in .env (ALPACA_API_KEY / ALPACA_SECRET_KEY) — dieses Kommando braucht den Broker.');
  }
  return app.client;
}

/** Basis-Zeitrahmen im Cache: Tagesbars für 1440, sonst Minutenbars. */
export function baseTimeframe(tf: TimeframeMin): '1Min' | '1Day' {
  return tf === 1440 ? '1Day' : '1Min';
}

/**
 * Bars eines Symbols im Strategie-Zeitrahmen aus dem Cache. Minutenbars
 * werden lokal aggregiert (Backtest = Live); Tagesbars vom Broker tragen
 * den Zeitstempel des ET-Tagesbeginns und werden auf die Sitzungseröffnung
 * normiert, damit `bucketStart`/`buildSessionInfo` sie einordnen können.
 */
export function seriesForTimeframe(app: App, symbol: string, closedBefore?: number): BarSeries {
  const tf = app.config.timeframe;
  const assetClass = app.config.universe.assetClass;
  const raw = app.store.load(symbol, baseTimeframe(tf));
  if (tf === 1440) {
    const out: Bar[] = [];
    for (const b of raw) {
      const day = dayKeyFor(b.t, assetClass);
      const bounds = sessionBounds(day, assetClass, app.calendar);
      if (!bounds) continue;
      if (closedBefore !== undefined && bounds.close > closedBefore) continue;
      const last = out[out.length - 1];
      if (last && last.t === bounds.open) out[out.length - 1] = { ...b, t: bounds.open };
      else out.push({ ...b, t: bounds.open });
    }
    return BarSeries.from(out);
  }
  const agg = aggregate(raw, { tf, assetClass, calendar: app.calendar, closedBefore });
  return BarSeries.from(agg);
}

export interface StrategyChoice {
  strategy: Strategy;
  params: Params;
  source: 'champion' | 'config';
}

/**
 * Welche Strategie handelt ein Symbol? Champion (aus `optimize`) hat
 * Vorrang; `noTrade` bedeutet null; ohne Champion greift die Config nur,
 * wenn `strategy.allowWithoutChampion` gesetzt ist.
 */
export function strategyChoice(app: App, symbol: string): StrategyChoice | null {
  const champ = app.champion;
  if (champ) {
    const entry = champ.symbols[symbol];
    if (entry) {
      if (entry.timeframe !== app.config.timeframe) {
        logger.warn('Champion-Zeitrahmen weicht von der Config ab — Symbol wird nicht gehandelt', {
          symbol,
          champion: entry.timeframe,
          config: app.config.timeframe,
        });
        return null;
      }
      const strategy = getStrategy(entry.strategy);
      return { strategy, params: mergeParams(strategy.defaults, entry.params), source: 'champion' };
    }
    if (champ.noTrade[symbol]) return null;
  }
  if (!app.config.strategy.allowWithoutChampion) return null;
  const strategy = getStrategy(app.config.strategy.id);
  if (!strategy.timeframes.includes(app.config.timeframe)) return null;
  return { strategy, params: mergeParams(strategy.defaults, app.config.strategy.params), source: 'config' };
}

export function strategyForFn(app: App): (symbol: string) => { strategy: Strategy; params: Params } | null {
  const cache = new Map<string, StrategyChoice | null>();
  return (symbol) => {
    if (!cache.has(symbol)) cache.set(symbol, strategyChoice(app, symbol));
    const c = cache.get(symbol) ?? null;
    return c ? { strategy: c.strategy, params: c.params } : null;
  };
}

/** Alle Symbole inkl. Benchmark (die Benchmark wird geladen, nie gehandelt). */
export function allSymbols(config: Config): string[] {
  const set = new Set(config.universe.symbols);
  if (config.universe.benchmark) set.add(config.universe.benchmark);
  return [...set];
}

export function benchmarkSeries(app: App, closedBefore?: number): BarSeriesLike | undefined {
  const b = app.config.universe.benchmark;
  if (!b) return undefined;
  const s = seriesForTimeframe(app, b, closedBefore);
  return s.length ? s : undefined;
}

export function configExists(path: string): boolean {
  return existsSync(resolve(path));
}
