/**
 * Config je Nutzer = globaler Teil (`meta/engineConfig`) + Risiko-Teil des
 * Nutzers (`settings.auto`, sonst aus dem alten `settings.strategy`
 * abgeleitet — `autoSettingsFromLegacy` in shared, dieselbe Ableitung wie
 * Callable und Frontend). Validiert wird das Ergebnis mit demselben
 * `parseConfig()` wie im Dauerprozess — eine Engine startet nie mit einer
 * halb verstandenen Config; ein ungültiger Nutzer-Teil überspringt den
 * Nutzer mit Fehler.
 *
 * Global sind: Universum (samt Kandidatenpool), Zeitrahmen, Feed,
 * Sitzungsfenster, Kosten, Optimierer, Engine-Feinheiten, Fallback-Strategie
 * und der GLOBALE Schalter der Basis-Stufe (`strategy.basis`). Je Nutzer:
 * `risk` und der Nutzer-Schalter der Basis (`settings.auto.basis`). Beide
 * Schalter werden UND-verknüpft (`strategy.basis` der Nutzer-Config ist nur
 * an, wenn global UND Nutzer an sind — Prüfbefund M8: vorher überschrieb der
 * Nutzerteil das Globale, ein plattformweites „aus" bewirkte nichts).
 * `notify`/`paths` haben im Takt keine Bedeutung und werden verworfen.
 */
import { normalizeUserSymbol } from '../../../src/alpaca/symbols.ts';
import { autoSettingsFromLegacy } from '../../../shared/src/autoSettings.js';
import { parseConfig, type Config } from '../../../src/core/config.ts';
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

/** Felder, die nie aus dem globalen Doc kommen (Ausnahme: `GLOBAL_RISK_FELDER` innerhalb von `risk`). */
export const NUR_JE_NUTZER: readonly string[] = ['risk', 'notify', 'paths'];

/**
 * Unterfelder von `risk`, die trotzdem GLOBAL bleiben (`meta/engineConfig`,
 * gepflegt über `config/platform.yaml`).
 *
 * Warum es diese Ausnahme gibt: `risk` gehört dem Nutzer — Risiko je Trade,
 * Positionsdeckel, Notbremsen. Diese vier Blöcke gehören ihm NICHT: Sie sind
 * gemessene Systemgrößen wie der Champion (Volatilitätsziel, Latten der
 * Bremsen je Stufe, Wiederaufbau nach Zwangs-Glattstellung, Geldmarkt-Parken),
 * und sie müssen zu dem Lauf passen, der sie gemessen hat. Ohne diese Zeile
 * fielen sie im Takt still auf die Schema-Vorgaben zurück — der Schalter im
 * YAML wäre wirkungslos, und niemand hätte es gemerkt (dieselbe Fehlerklasse
 * wie die tote Tagesbremse und die tote Short-Achse, docs/ARCHITEKTUR.md
 * §5a.15/16).
 *
 * `cashParking` gehört hier hin und NICHT zum Nutzer: Das Parksymbol ist
 * Infrastruktur der Plattform — der Takt lädt seine Bars EINMAL für alle
 * (engine/sharedData.ts, `infrastrukturSymbole`), und es darf in keinem
 * Handelsuniversum stehen. Ein Parksymbol je Nutzer wäre ein Symbol, dessen
 * Bars niemand geladen hat.
 *
 * Ein Nutzer stellt sie nicht ein; wollte man das, brauchte es `settings.auto`,
 * `saveStrategy` und `shared/src/autoSettings.ts` — bewusst nicht getan.
 */
export const GLOBAL_RISK_FELDER: readonly string[] = ['volTarget', 'tiers', 'wiederaufbau', 'cashParking'];

/** Untergrenze der Bar-Karenz im Takt (s) — siehe DEFAULT_GLOBAL_CONFIG. */
export const TICK_BAR_GRACE_MIN_SEC = (DEFAULT_GLOBAL_CONFIG.engine as { barGraceSec: number }).barGraceSec;

/**
 * Globaler Roh-Teil: Defaults, überschrieben durch die Felder des Docs (ohne risk/notify/paths).
 *
 * Zwei Korrekturen am Doc (Secreview 2, M8): Ein Top-Level `feed` (so schrieb es der Sync-Skript-Stand
 * vor dem Review) landet in `broker.feed`, damit Optimierer und Engine denselben Feed haben; und
 * `engine.barGraceSec` unterschreitet nie die Takt-Untergrenze — mit 4 s gälte ein Bucket zur vollen
 * Minute als geschlossen, bevor Alpaca die letzte Minutenbar per REST liefert.
 */
export function globalConfigRaw(doc: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = plain(DEFAULT_GLOBAL_CONFIG);
  if (!doc) return out;
  for (const [k, v] of Object.entries(doc)) {
    if (NUR_JE_NUTZER.includes(k) || k === 'feed') continue;
    out[k] = plain(v);
  }
  const broker: Record<string, unknown> = isRecord(out.broker) ? { ...out.broker } : {};
  if (doc.feed === 'iex' || doc.feed === 'sip') broker.feed = doc.feed;
  if (broker.mode !== 'paper' && broker.mode !== 'live') broker.mode = 'paper';
  out.broker = broker;
  const engine: Record<string, unknown> = isRecord(out.engine) ? { ...out.engine } : {};
  const grace = typeof engine.barGraceSec === 'number' ? engine.barGraceSec : TICK_BAR_GRACE_MIN_SEC;
  engine.barGraceSec = Math.max(grace, TICK_BAR_GRACE_MIN_SEC);
  out.engine = engine;
  /*
   * `risk` ist Nutzersache — bis auf die gemessenen Systemblöcke
   * (GLOBAL_RISK_FELDER). Die reisen mit dem globalen Teil weiter; enthält das
   * Doc keinen davon, bleibt `risk` wie bisher unbesetzt.
   *
   * Zwei Namen, ein Block: `scripts/module/engineConfig.mjs` schreibt den
   * Risiko-Teil der Plattform-Config als `riskDefaults` (Defaults für Nutzer
   * ohne eigene Einstellung), ältere und von Hand gepflegte Dokumente tragen
   * `risk`. Wer nur einen der beiden liest, hat einen Schalter, der im YAML
   * steht und nichts tut — dieselbe Fehlerklasse wie die tote Tagesbremse
   * (§5a.16). Also beide, `risk` gewinnt.
   */
  const rohRisk = isRecord(doc.risk) ? doc.risk : isRecord(doc.riskDefaults) ? doc.riskDefaults : null;
  if (rohRisk) {
    const globalRisk: Record<string, unknown> = {};
    for (const k of GLOBAL_RISK_FELDER) if (rohRisk[k] !== undefined) globalRisk[k] = plain(rohRisk[k]);
    if (Object.keys(globalRisk).length > 0) out.risk = globalRisk;
  }
  return out;
}

export type UserRiskSource = 'auto' | 'legacy' | 'default';

export interface UserRiskPart {
  risk: Record<string, unknown>;
  /** Gewünschte Teilmenge des Universums (roh, unnormalisiert); null = ganzes Universum. */
  symbols: string[] | null;
  /** Basis-Stufe handeln (`settings.auto.basis`); fehlend, Alt-Schema oder Default ⇒ an. */
  basis: boolean;
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
    // Nur ein ausdrückliches `false` schaltet die Basis ab — wie `validateAutoSettings` es speichert.
    return { risk, symbols, basis: auto.basis !== false, source: 'auto' };
  }
  if (isRecord(s.strategy)) {
    const auto = autoSettingsFromLegacy(s.strategy);
    const risk: Record<string, unknown> = {};
    for (const k of AUTO_FIELDS) risk[k] = auto[k];
    risk.allowShort = auto.allowShort;
    return { risk, symbols: null, basis: auto.basis !== false, source: 'legacy' };
  }
  return { risk: {}, symbols: null, basis: true, source: 'default' };
}

export interface UserConfig {
  config: Config;
  source: UserRiskSource;
  /**
   * Gesetzt, wenn die gespeicherte Symbolauswahl des Nutzers gar nicht mehr
   * ins globale Universum passt. Der Takt macht daraus eine Einstiegssperre —
   * NICHT einen Abbruch (siehe unten).
   */
  auswahlVeraltet?: string;
  /** Die beiden Schalter der Basis-Stufe — `config.strategy.basis` ist ihr UND. */
  basisSchalter: { global: boolean; nutzer: boolean };
}

/** Globaler Schalter der Basis-Stufe aus dem Doc: nur ein ausdrückliches `false` schaltet ab. */
export function globalBasisSchalter(global: Record<string, unknown>): boolean {
  return !(isRecord(global.strategy) && global.strategy.basis === false);
}

/** Globaler Teil + Nutzer-Teil ⇒ validierte Config. Wirft bei ungültigem globalem Teil. */
export function buildUserConfig(global: Record<string, unknown>, settings: unknown): UserConfig {
  const part = userRiskFrom(settings);
  const universe: Record<string, unknown> = isRecord(global.universe) ? { ...global.universe } : {};
  let auswahlVeraltet: string | undefined;
  if (part.symbols) {
    const assetClass = universe.assetClass === 'crypto' ? 'crypto' : 'us_equity';
    const all = Array.isArray(universe.symbols) ? universe.symbols.filter((x): x is string => typeof x === 'string') : [];
    const allowed = new Set(all.map((x) => normalizeUserSymbol(x, assetClass)));
    const subset = [...new Set(part.symbols.map((x) => normalizeUserSymbol(x, assetClass)))].filter((x) => allowed.has(x));
    if (subset.length === 0) {
      // Früher ein `ConfigError` — und der warf den Nutzer aus dem GANZEN Takt:
      // keine Exits, kein Abgleich, keine Schutz-Stop-Prüfung, kein Spiegel. Eine
      // offene Position hätte niemand mehr bewirtschaftet.
      //
      // Seit das Universum nächtlich nach Liquidität gewählt wird, ist der Fall
      // ein Normalfall, kein Konfigurationsfehler: Wer nur TSLA gewählt hat und
      // TSLA fällt heraus, steht genau hier. Also: Universum wie global (damit
      // Daten, Abgleich und Exits laufen), aber keine Einstiege, bis der Nutzer
      // neu wählt.
      auswahlVeraltet = 'gespeicherte Symbolauswahl ist nicht mehr im Handelsuniversum — bitte in den Einstellungen neu wählen';
    } else {
      universe.symbols = subset;
    }
  }
  // Der Schalter der Basis-Stufe: global (meta/engineConfig, `strategy.basis`) UND je Nutzer
  // (settings.auto.basis) — beide müssen an sein. Er wohnt im `strategy`-Block des Kerns, derselben
  // Stelle, die `strategyChoice` im Dauerprozess liest.
  const basisSchalter = { global: globalBasisSchalter(global), nutzer: part.basis };
  const strategy: Record<string, unknown> = { ...(isRecord(global.strategy) ? global.strategy : {}), basis: basisSchalter.global && basisSchalter.nutzer };
  // Risiko des Nutzers + die global gemessenen Blöcke (GLOBAL_RISK_FELDER, von
  // `globalConfigRaw` durchgelassen). Reihenfolge ist Absicht: Der Nutzer kann sie
  // nicht überschreiben, denn er schickt sie gar nicht erst mit (`userRiskFrom`
  // nimmt nur die bekannten Felder aus `settings.auto`).
  const risk: Record<string, unknown> = { ...part.risk };
  const globalRisk = isRecord(global.risk) ? global.risk : {};
  for (const k of GLOBAL_RISK_FELDER) if (globalRisk[k] !== undefined) risk[k] = plain(globalRisk[k]);
  const out: UserConfig = { config: parseConfig({ ...global, universe, risk, strategy }), source: part.source, basisSchalter };
  if (auswahlVeraltet !== undefined) out.auswahlVeraltet = auswahlVeraltet;
  return out;
}
