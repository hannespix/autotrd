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
import { aggregate, anfangsStreuner, BarSeries } from './core/bars.ts';
import { basisChoiceFor, basisStatus, universeWithBasis } from './core/basisTier.ts';
import { IEX_STREAM_SYMBOL_MAX } from './alpaca/stream.ts';
import { homeDir, loadConfigFile, loadEnv, resolveMode, type Config, type Env } from './core/config.ts';
import { ensureDir, homePaths, Journal, StateStore, type HomePaths } from './core/journal.ts';
import { logger, registerSecret, setLogLevel } from './core/log.ts';
import { dayKeyFor, msFromET, parseDay, sessionBounds, type Calendar } from './core/time.ts';
import type { Bar, BarSeriesLike, Ms, Params, SizingSpec, Strategy, TimeframeMin } from './core/types.ts';
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
  /**
   * Stichtag (YYYY-MM-DD) für eine MESSUNG: Der Lauf tut so, als wäre dieser
   * Tag heute — alles danach ist unsichtbar. Siehe `App.asOf`.
   */
  asOf?: string | undefined;
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
  /**
   * Stichtag einer Messung, als Ende des genannten ET-Tags. Gesetzt ⇒ jede
   * Bar-Serie endet dort (`seriesForTimeframe`), und die Universumswahl rechnet
   * mit diesem Zeitpunkt statt mit `Date.now()`.
   *
   * Warum das eine EINZELNE Stelle ist: Der ganze Lauf hängt an den Bars —
   * Walk-Forward-Fenster, Holdout und Datenbereich leiten sich aus der ersten
   * und letzten Bar ab (`optimize/run.ts`). Wer hier kürzt, kürzt alles, und
   * es kann keine Stelle geben, die den Schnitt vergisst.
   *
   * Wozu: Ein einziges Holdout-Fenster kann nicht zwischen Kante und
   * Marktregime unterscheiden (docs/ARCHITEKTUR.md §5a). Mit mehreren
   * Stichtagen entstehen mehrere vollständig getrennte
   * (Auswahl → Holdout)-Paare aus verschiedenen Marktphasen — mit derselben
   * Maschinerie und ohne Leckage. Nebenbei behebt es den Survivorship-Befund:
   * Auch die Universumswahl sieht dann nur Daten bis zum Stichtag.
   */
  asOf?: Ms | undefined;
}

/** Stichtag als Ende des ET-Tags: Bars, die an diesem Tag geschlossen haben, zählen noch dazu. */
export function asOfMs(day: string): Ms {
  const { y, m, d } = parseDay(day);
  return msFromET(y, m, d, 23, 59, 59);
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
  // Ein Lauf hat EINE Uhr. Mit Stichtag ist es der Stichtag — für die Bars,
  // für die Universumswahl und für die Frage, wie alt eine Auswahl ist.
  // Deshalb steht der Stichtag VOR dem Laden der Auswahl: Am 09.09. schlug
  // eine Stichtags-Messung fehl, weil die (korrekt auf den Stichtag
  // datierte) Auswahl gegen die Wanduhr 186 Tage alt war.
  const asOf = opts.asOf === undefined ? undefined : asOfMs(opts.asOf);
  if (asOf !== undefined) logger.warn(`Stichtag ${opts.asOf}: Der Lauf sieht keine Daten danach (Messung).`);
  // Nächtliche Auswahl anwenden, falls verlangt. Fehlt sie, bleibt es beim
  // committeten Universum — nie stillschweigend etwas anderes handeln.
  let config = roh;
  if (opts.universeFile) {
    const pfad = opts.universeFile === 'auto' ? paths.universe : resolve(opts.universeFile);
    const gewaehlt = ladeUniverseDatei(pfad, roh, asOf ?? Date.now());
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
    ...(asOf === undefined ? {} : { asOf }),
    env,
    mode,
    modeReasons: reasons,
    home,
    paths,
    journal: new Journal(paths.journal),
    state: new StateStore(paths.state),
    // Derselbe Wurzelpfad wie in der Engine (bars/<assetClass>/<feed>[-adj-<bereinigung>]/) —
    // sonst lesen fetch/backtest und die Engine verschiedene Caches. Der Store kennt seine
    // Bereinigung; der Backfill prüft dagegen (data/store.ts, data/backfill.ts).
    store: new BarStore(barStoreRoot(paths.bars, config.universe.assetClass, config.broker.feed, config.broker.adjustment), config.broker.adjustment),
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
  // Der Stichtag ist die Standardgrenze; ein ausdrückliches `closedBefore`
  // (Engine-Tick) hat Vorrang. Beide zusammen kommen nicht vor — `--as-of`
  // wird für `run` abgelehnt.
  const grenze = closedBefore ?? app.asOf;
  const raw = app.store.load(symbol, baseTimeframe(tf));
  if (tf === 1440) {
    const out: Bar[] = [];
    for (const b of raw) {
      const day = dayKeyFor(b.t, assetClass);
      const bounds = sessionBounds(day, assetClass, app.calendar);
      if (!bounds) continue;
      if (grenze !== undefined && bounds.close > grenze) continue;
      const last = out[out.length - 1];
      if (last && last.t === bounds.open) out[out.length - 1] = { ...b, t: bounds.open };
      else out.push({ ...b, t: bounds.open });
    }
    return ohneStreuner(symbol, BarSeries.from(out));
  }
  const agg = aggregate(raw, { tf, assetClass, calendar: app.calendar, closedBefore: grenze });
  return ohneStreuner(symbol, BarSeries.from(agg));
}

/**
 * Verirrte Einzelbars am Anfang verwerfen (IEX: SPY 2018-11-01, SO
 * 2019-11-11 — Regel in `anfangsStreuner`). Der Cache behält sie: Der
 * Backfill misst seinen Rückstand an der Rohreihe. Nur wer rechnet, sieht
 * sie nicht — Backtest, Optimierer, Universumswahl und Maßstab gleichermaßen.
 */
function ohneStreuner(symbol: string, serie: BarSeries): BarSeries {
  const n = anfangsStreuner(serie.t);
  if (n === 0) return serie;
  const tag = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  logger.info(`${symbol}: ${n} Streuner-Bar(s) am Anfang verworfen (${tag(serie.t[0]!)} … ${tag(serie.t[n - 1]!)}) — Daten dicht ab ${tag(serie.t[n]!)}`);
  return serie.slice(n);
}

export interface StrategyChoice {
  strategy: Strategy;
  params: Params;
  /** Alpha-Champion, Basis-Stufe (Block `basis`) oder Config-Strategie (`allowWithoutChampion`). */
  source: 'champion' | 'basis' | 'config';
  /** Sizing-Semantik der Wahl — nur die Basis-Stufe setzt sie (Allokation, `positionPct`). */
  sizing?: SizingSpec | undefined;
  /** false ⇒ keine neuen Einstiege (Basis ohne Einstiegsrecht: pass gefallen, Schalter aus); Bestand wird geführt. */
  entriesAllowed?: boolean | undefined;
  entryLockReason?: string | undefined;
}

/** Was die Engine je Symbol bekommt (`EngineDeps.strategyFor`). */
export type EngineStrategyChoice = {
  strategy: Strategy;
  params: Params;
  sizing?: SizingSpec | undefined;
  source?: string | undefined;
  entriesAllowed?: boolean | undefined;
  entryLockReason?: string | undefined;
};

/**
 * Welche Strategie handelt ein Symbol? Dieselbe Reihenfolge wie
 * `buildStrategyFor` auf der Plattform (gemeinsamer Kern core/basisTier.ts):
 * Alpha-Champion (aus `optimize`) → Basis-Stufe (Block `basis` führbar,
 * Zeitrahmen passt, Symbol im Korb — Einstiegsrecht nur mit bestandener Latte
 * und `strategy.basis` an) → `noTrade` bedeutet null; ohne Champion greift die
 * Config nur mit `strategy.allowWithoutChampion`.
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
    // Basis vor noTrade: Ein Symbol ohne Alpha-Champion, das im Basis-Korb
    // steht, führt die Basis — mit deren Parametern und Sizing; Einstiege nur
    // mit Einstiegsrecht (core/basisTier.ts).
    const status = basisStatus({
      champion: champ,
      timeframe: app.config.timeframe,
      enabled: app.config.strategy.basis,
      pool: app.config.universe.candidates,
      maxPositionPct: app.config.risk.maxPositionPct,
    });
    const basis = basisChoiceFor({ status, symbol, alphaLeads: false });
    if (basis) {
      const strategy = getStrategy(basis.strategyId);
      const choice: StrategyChoice = { strategy, params: mergeParams(strategy.defaults, basis.params), source: 'basis', sizing: basis.sizing, entriesAllowed: basis.entriesAllowed };
      if (basis.entryLockReason !== undefined) choice.entryLockReason = basis.entryLockReason;
      return choice;
    }
    if (champ.noTrade[symbol]) return null;
  }
  if (!app.config.strategy.allowWithoutChampion) return null;
  const strategy = getStrategy(app.config.strategy.id);
  if (!strategy.timeframes.includes(app.config.timeframe)) return null;
  return { strategy, params: mergeParams(strategy.defaults, app.config.strategy.params), source: 'config' };
}

export function strategyForFn(app: App): (symbol: string) => EngineStrategyChoice | null {
  const cache = new Map<string, StrategyChoice | null>();
  return (symbol) => {
    if (!cache.has(symbol)) cache.set(symbol, strategyChoice(app, symbol));
    const c = cache.get(symbol) ?? null;
    if (!c) return null;
    const out: EngineStrategyChoice = { strategy: c.strategy, params: c.params, source: c.source };
    if (c.sizing) out.sizing = c.sizing;
    if (c.entriesAllowed !== undefined) out.entriesAllowed = c.entriesAllowed;
    if (c.entryLockReason !== undefined) out.entryLockReason = c.entryLockReason;
    return out;
  };
}

/**
 * Symbole mit offener Position oder laufender Einstiegs-Order laut
 * `state.json` — was die Engine beim Start FÜHREN muss. Für das Universum
 * (`engineConfig`): Der Korb einer Basis ohne Einstiegsrecht bleibt nur dann
 * dabei, wenn darin etwas offen ist.
 */
export function heldSymbols(app: App): string[] {
  const st = app.state.load();
  if (!st) return [];
  return [...new Set([...Object.keys(st.positions ?? {}), ...Object.keys(st.pendingEntries ?? {})])];
}

/**
 * Die Config, mit der die ENGINE läuft (`run`, `backtest`): das Universum um
 * den Korb der Basis-Stufe erweitert, wenn die Basis handelbar ist — oder
 * wenn sie nur noch führt und im Korb etwas offen ist (`held`, aus
 * `heldSymbols`; `backtest` lässt es weg). Die Engine führt nur Symbole
 * ihres Universums (core/basisTier.ts). Für den Optimierer gilt das nicht:
 * Dort ist der Basis-Korb eine eigene Einheit.
 */
export function engineConfig(app: App, held: readonly string[] = []): Config {
  return universeWithBasis(app.config, app.champion, held);
}

/** Alle Symbole inkl. Benchmark (die Benchmark wird geladen, nie gehandelt). */
export function allSymbols(config: Config): string[] {
  const set = new Set(config.universe.symbols);
  if (config.universe.benchmark) set.add(config.universe.benchmark);
  return [...set];
}

/**
 * Reißt dieses Universum das Abonnement-Limit des Datenstroms? IEX-Basis
 * erlaubt 30 Symbole je Verbindung (Benchmark zählt mit); darüber antwortet
 * Alpaca mit 405 „symbol limit exceeded", der Strom kommt nie zustande und
 * die Engine sperrt STILL jeden Einstieg (Datenfrische) — Alpha wie Basis
 * (Prüfbefund M10, 09.09.2026). `run` verweigert deshalb den Start, `doctor`
 * warnt. Der Plattform-Takt lädt per REST und ist nicht betroffen. Gibt den
 * Fehlertext zurück, sonst null.
 */
export function streamLimitViolation(config: Config): string | null {
  if (config.broker.feed !== 'iex') return null;
  const n = allSymbols(config).length;
  if (n <= IEX_STREAM_SYMBOL_MAX) return null;
  return (
    `${n} Symbole (Universum ∪ Basis-Korb, inkl. Benchmark) — der IEX-Datenstrom des Basis-Plans erlaubt ${IEX_STREAM_SYMBOL_MAX}. ` +
    'Die Subscription würde mit 405 scheitern und ohne Datenfrische gäbe es keinen einzigen Einstieg. ' +
    'universe.maxSymbols bzw. universe.symbols verkleinern, oder broker.feed: sip.'
  );
}

/**
 * Was `fetch` lädt: Universum und Benchmark — und den Kandidatenpool, wenn
 * der Optimierer den Korb je Fold wählt (dann braucht jeder Kandidat die
 * ganze Tiefe, nicht nur die 130 Tage der nächtlichen Auswahl).
 */
export function fetchSymbols(config: Config): string[] {
  const set = new Set(allSymbols(config));
  // Nur auf Tagesbars: Die Auswahl rechnet auf Tagesbars wie nachts; 139
  // Kandidaten als Minutenbars über Jahre wären weder nötig noch bezahlbar.
  if (config.optimizer.pooled && config.optimizer.foldMembership === 'point_in_time' && config.timeframe === 1440) {
    for (const s of config.universe.candidates ?? []) set.add(s);
  }
  // Der eigene Korb der Basis-Allokation: eigene Einheit, eigene Bars-Ladung.
  for (const s of config.optimizer.basisUniverse) set.add(s);
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
