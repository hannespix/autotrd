/**
 * Config je Nutzer = globaler Teil (`meta/engineConfig`) + Risiko-Teil des
 * Nutzers (`settings.auto`, sonst aus dem alten `settings.strategy`
 * abgeleitet — `autoSettingsFromLegacy` in shared, dieselbe Ableitung wie
 * Callable und Frontend). Validiert wird das Ergebnis mit demselben
 * `parseConfig()` wie im Dauerprozess — eine Engine startet nie mit einer
 * halb verstandenen Config; ein ungültiger Nutzer-Teil überspringt den
 * Nutzer mit Fehler.
 *
 * Global sind: Universum, Zeitrahmen, Feed, Sitzungsfenster, Kosten,
 * Optimierer, Engine-Feinheiten, Fallback-Strategie. Je Nutzer: `risk`.
 * `notify`/`paths` haben im Takt keine Bedeutung und werden verworfen.
 */
import { normalizeUserSymbol } from '../../../src/alpaca/symbols.ts';
import { autoSettingsFromLegacy } from '../../../shared/src/autoSettings.js';
import { ConfigError, parseConfig, type Config } from '../../../src/core/config.ts';
import { isRecord, plain } from './firestoreLike.js';

export const DEFAULT_UNIVERSE: readonly string[] = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AMD', 'TSLA'];

/**
 * Eingebaute Defaults, wenn `meta/engineConfig` fehlt oder Felder auslässt.
 * `barGraceSec: 20` statt 4: Der Takt feuert zur vollen Minute (mit Jitter),
 * die letzte Minutenbar eines Buckets erscheint bei Alpaca erst Sekunden
 * nach Minutenende. Mit 20 s Karenz gilt ein Bucket sicher erst im NÄCHSTEN
 * Takt als geschlossen — dann ist die letzte Bar da, und kein Bucket wird
 * aus vier statt fünf Minuten aggregiert.
 */
export const DEFAULT_GLOBAL_CONFIG: Record<string, unknown> = {
  broker: { mode: 'paper', feed: 'iex' },
  universe: { assetClass: 'us_equity', symbols: [...DEFAULT_UNIVERSE], benchmark: 'SPY' },
  timeframe: 5,
  engine: { barGraceSec: 20 },
};

/** Felder, die nie aus dem globalen Doc kommen. */
export const NUR_JE_NUTZER: readonly string[] = ['risk', 'notify', 'paths'];

/** Globaler Roh-Teil: Defaults, überschrieben durch die Felder des Docs (ohne risk/notify/paths). */
export function globalConfigRaw(doc: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = plain(DEFAULT_GLOBAL_CONFIG);
  if (!doc) return out;
  for (const [k, v] of Object.entries(doc)) {
    if (NUR_JE_NUTZER.includes(k)) continue;
    out[k] = plain(v);
  }
  return out;
}

export type UserRiskSource = 'auto' | 'legacy' | 'default';

export interface UserRiskPart {
  risk: Record<string, unknown>;
  /** Gewünschte Teilmenge des Universums (roh, unnormalisiert); null = ganzes Universum. */
  symbols: string[] | null;
  source: UserRiskSource;
}

const AUTO_FIELDS = ['riskPerTradePct', 'maxPositionPct', 'maxPositions', 'maxDailyLossPct', 'maxDrawdownPct'] as const;

/**
 * Risiko-Teil aus den Nutzer-Settings.
 *
 * `settings.auto` wird unverändert durchgereicht (das Schema prüft); die
 * Alt-Felder werden über `autoSettingsFromLegacy` (shared) in die Hülle des
 * Schemas geklemmt, weil sie aus einer anderen Welt stammen (riskPerTradePct
 * 0 hieß dort „Prozent-Tranche", hier hieße es „kein Risiko-Budget" ⇒
 * Stückzahl 0). Die Ableitung wohnt in shared, damit Takt, Callable und
 * Frontend dieselben Zahlen sehen.
 */
export function userRiskFrom(settings: unknown): UserRiskPart {
  const s = isRecord(settings) ? settings : {};
  if (isRecord(s.auto)) {
    const auto = s.auto;
    const risk: Record<string, unknown> = {};
    for (const k of AUTO_FIELDS) if (auto[k] !== undefined) risk[k] = auto[k];
    if (auto.allowShort !== undefined) risk.allowShort = auto.allowShort;
    const symbols = Array.isArray(auto.symbols) ? auto.symbols.filter((x): x is string => typeof x === 'string') : null;
    return { risk, symbols, source: 'auto' };
  }
  if (isRecord(s.strategy)) {
    const auto = autoSettingsFromLegacy(s.strategy);
    const risk: Record<string, unknown> = {};
    for (const k of AUTO_FIELDS) risk[k] = auto[k];
    risk.allowShort = auto.allowShort;
    return { risk, symbols: null, source: 'legacy' };
  }
  return { risk: {}, symbols: null, source: 'default' };
}

export interface UserConfig {
  config: Config;
  source: UserRiskSource;
}

/** Globaler Teil + Nutzer-Teil ⇒ validierte Config. Wirft `ConfigError`. */
export function buildUserConfig(global: Record<string, unknown>, settings: unknown): UserConfig {
  const part = userRiskFrom(settings);
  const universe: Record<string, unknown> = isRecord(global.universe) ? { ...global.universe } : {};
  if (part.symbols) {
    const assetClass = universe.assetClass === 'crypto' ? 'crypto' : 'us_equity';
    const all = Array.isArray(universe.symbols) ? universe.symbols.filter((x): x is string => typeof x === 'string') : [];
    const allowed = new Set(all.map((x) => normalizeUserSymbol(x, assetClass)));
    const subset = [...new Set(part.symbols.map((x) => normalizeUserSymbol(x, assetClass)))].filter((x) => allowed.has(x));
    if (subset.length === 0) throw new ConfigError('settings.auto.symbols enthält kein Symbol des globalen Universums (meta/engineConfig.universe.symbols)');
    universe.symbols = subset;
  }
  return { config: parseConfig({ ...global, universe, risk: part.risk }), source: part.source };
}
