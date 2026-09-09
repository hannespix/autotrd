/**
 * Ein Optimierungslauf: je Symbol × Strategie Walk-Forward → Stress,
 * Nachbarschaft, PSR (OOS), DSR (IS) → Gates → Champion/Challenger-
 * Entscheidung → champion.json, Journal, Markdown-Bericht.
 *
 * Simulator, Statistik und Strategie-Register werden INJIZIERT. Die
 * Standard-Implementierungen (Backtester, Strategien) lädt `loadDefaultDeps()`
 * asynchron nach — so bleibt `runOptimization` synchron und ohne statische
 * Abhängigkeit auf Module, die parallel entstehen; Tests laufen mit Fakes.
 *
 * Der amtierende Champion wird NICHT auf denselben Folds wie der Kandidat
 * bewertet, sondern nur auf OOS-Folds, die nach seinem Fit-Fenster beginnen
 * (`fitEnd`) — und durch dieselben Gates. Seine Parameter fließen auch nicht
 * mehr in die Kandidatensuche ein: Sie wurden auf Daten gefittet, die in den
 * OOS-Fenstern der Kandidaten liegen (Red-Team-Befund).
 *
 * Festkandidaten (`optimizer.fixedCandidates`) sind vorregistrierte
 * Parametersätze ohne Suche: dieselben Folds, derselbe Korb je Fold, derselbe
 * Holdout, dieselbe Kette aus Stress, Nachbarschaft, PSR und Gates, dieselbe
 * Kandidatenliste. Ohne Trials gibt es nichts zu deflationieren — der DSR ist
 * bei ihnen wie beim Amtsinhaber „nicht anwendbar"; sonst kein Sonderweg.
 *
 * Die zweite Latte: Ein Festkandidat mit `tier: basis` (Basis-Allokation)
 * läuft NICHT in dieser Liste. Er wird in EINER durchgehenden Simulation über
 * die OOS-Kette gemessen (`basisSimulation`), gegen den liegengelassenen Korb
 * über dieselbe Range (`basisGates`), und sein Befund steht als eigener Block
 * `basis` in der Champion-Datei — bestanden oder nicht, nie als Alpha-Champion
 * (Prüfbefund K1/K2/M6, 09.09.2026).
 */
import { kaufenUndHalten, kaufenUndHaltenKurve, kurvenstandVor, marktKette, type MarktBezug, type MarktKurve } from '../backtest/marktbezug.ts';
import { BarSeries } from '../core/bars.ts';
import type { Config, FixedCandidateConfig } from '../core/config.ts';
import { Journal, homePaths } from '../core/journal.ts';
import { errMsg } from '../core/log.ts';
import { validateParams } from '../strategy/params.ts';
import { universeRegelnFuer } from '../universe/select.ts';
import { korbJeFold, type KorbStand } from './korbJeFold.ts';
import type { Calendar } from '../core/time.ts';
import { DAY, dayKey } from '../core/time.ts';
import type { Bar, BarSeriesLike, Metrics, Ms, Params, Strategy } from '../core/types.ts';
import {
  applyDecision,
  decidePromotion,
  emptyChampionFile,
  fitEndOf,
  journalBasis,
  journalDecision,
  loadChampion,
  mitBasis,
  saveChampion,
  type ChampionBasis,
  type ChampionEntry,
  type ChampionFile,
  type PromotionDecision,
} from './promote.ts';
import { renderReport, writeReport } from './report.ts';
import {
  basisGates,
  deflatedSharpeIs,
  neighborhoodTest,
  probabilisticSharpeOos,
  robustnessGates,
  stressTest,
  type DsrResult,
  type DsrVarSource,
  type GateResult,
  type MetricsFns,
  type NeighborhoodResult,
  type PsrResult,
  type StressResult,
} from './robustness.ts';
import { mulberry32, wirksamerSuchraum } from './search.ts';
import {
  MIN_FOLDS,
  TAGE_JE_MONAT,
  basisSimulation,
  fixedCandidateWfa,
  fixedParamsWfa,
  foldPlanForBars,
  korbVon,
  korbZum,
  type Membership,
  walkForward,
  zeitachseVon,
  type BarsInput,
  type BasisKennzahlen,
  type Fold,
  type SimConfig,
  type SimulateFn,
  type TimeRange,
  type WfaResult,
} from './walkForward.ts';

export { TAGE_JE_MONAT };

/* ───────────────────────── Abhängigkeiten ───────────────────────── */

export interface OptimizeDeps {
  simulate: SimulateFn;
  metricsFns: MetricsFns;
  getStrategy: (id: string) => Strategy;
}

/**
 * Standard-Abhängigkeiten aus Backtester und Strategie-Register. Bewusst
 * dynamisch importiert: Fehlen die Module, scheitert DIESER Aufruf laut —
 * nicht das Laden des Optimierer-Moduls (Tests injizieren Fakes).
 */
export async function loadDefaultDeps(): Promise<OptimizeDeps> {
  const [sim, metrics, strategies] = await Promise.all([
    import('../backtest/simulator.ts'),
    import('../backtest/metrics.ts'),
    import('../strategy/index.ts'),
  ]);
  return {
    simulate: sim.simulate,
    metricsFns: {
      sharpeRatio: metrics.sharpeRatio,
      skewness: metrics.skewness,
      kurtosis: metrics.kurtosis,
      probabilisticSharpe: metrics.probabilisticSharpe,
      deflatedSharpe: metrics.deflatedSharpe,
    },
    getStrategy: strategies.getStrategy,
  };
}

/* ───────────────────────── Ein- und Ausgabe ───────────────────────── */

export interface OptimizeRunInput {
  config: Config;
  symbols: string[];
  strategies: string[];
  /** Bars im Strategie-Zeitrahmen (config.timeframe). */
  barsFor: (symbol: string) => BarSeriesLike;
  /**
   * Bars eines Kandidaten aus `universe.candidates` (null = keine) — für den
   * Korb je Fold (`optimizer.foldMembership`). Ein Kandidat ohne Bars ist
   * nicht wählbar, kein Fehler.
   */
  candidateBarsFor?: ((symbol: string) => BarSeriesLike | null) | undefined;
  benchmark?: BarSeriesLike | undefined;
  calendar?: Calendar | undefined;
  /** State-Verzeichnis (champion.json, reports/, journal.jsonl). */
  home: string;
  initialEquity: number;
  simulate?: SimulateFn | undefined;
  metricsFns?: MetricsFns | undefined;
  getStrategy?: ((id: string) => Strategy) | undefined;
  /** Journal-Pfad; Standard homePaths(home).journal. */
  journalPath?: string | undefined;
  /** Streuungsquelle des Deflated Sharpe; Vorgabe 'trial_sharpes' (siehe robustness.ts). */
  dsrVarSource?: DsrVarSource | undefined;
  now?: (() => Ms) | undefined;
  /** Stichtag der Messung (YYYY-MM-DD) — nur für den Berichtskopf. */
  asOf?: string | undefined;
  /** Commit der Config/Vorregistrierung — wird in den Basis-Block der Champion-Datei geschrieben, falls bekannt. */
  configCommit?: string | undefined;
  log?: ((msg: string) => void) | undefined;
}

export interface StrategyRun {
  strategyId: string;
  /**
   * Festkandidat (`optimizer.fixedCandidates`): vorregistrierte Parameter,
   * keine Suche — dieselben Folds, derselbe Korb je Fold, dieselben Gates,
   * dieselbe Liste. Kein Sonderweg nach oben.
   */
  fixed: boolean;
  /** Name des Festkandidaten im Bericht (`label`, sonst die registrierten Parameter); null bei gesuchten Strategien. */
  label: string | null;
  wfa: WfaResult;
  gates: GateResult[];
  pass: boolean;
  /** = wfa.oos.objectiveMedian */
  score: number;
  stress: StressResult;
  neighborhood: NeighborhoodResult;
  /** Deflated Sharpe der selektierten IS-Zahl. */
  dsr: DsrResult;
  /** Probabilistic Sharpe der OOS-Kette. */
  psr: PsrResult;
  /** Maßstab über dieselben OOS-Fenster — für Bericht und Maschine, kein Gate. */
  massstab: Massstab;
}

/**
 * Maßstab je Kandidat über DIESELBEN OOS-Fenster, auf denen er bewertet
 * wurde: die Strategie neben kaufen-und-halten der Benchmark. Er entscheidet
 * nichts (das tut `beats_market` mit dem Sharpe), aber ohne ihn liest man
 * einen Sharpe von 0,8 als Kante, wo der Markt 1,2 gemacht hat.
 */
export interface Massstab {
  /** Sharpe p. a. der verketteten OOS-Tagesrenditen — dieselbe Zahl wie der Wert des Gates `beats_market`. */
  oosSharpe: number | null;
  /** MaxDD der verketteten OOS-Equity in % (`OosAggregate.maxDrawdownPct`). */
  oosMaxDD: number;
  /** OOS-Trades je Monat: Trades / (OOS-Kalendertage / 30,44); null ohne OOS-Tage. */
  tradesPerMonth: number | null;
  /** Kalendertage aller OOS-Fenster zusammen. */
  oosDays: number;
  /** Benchmark des Maßstabs; null ohne Benchmark — dann gilt die Kasse (Latte 0), wie in `beats_market`. */
  marktSymbol: string | null;
  /** Sharpe p. a. von kaufen-und-halten der Benchmark, verkettet über dieselben Fenster; null ohne Benchmark oder nicht berechenbar. */
  marktSharpe: number | null;
  /** MaxDD derselben verketteten Wertreihe in %; null ohne Benchmark oder ohne Kurse in den Fenstern. */
  marktMaxDD: number | null;
}

/** Latte für `beats_market` samt MaxDD für den Maßstab — aus `marktKette` über die OOS-Fenster. */
export interface MarktLatte {
  sharpe: number | null;
  maxDrawdownPct: number | null;
  quelle: string;
}

export function massstabFuer(a: {
  wfa: WfaResult;
  metricsFns: MetricsFns;
  periodsPerYear: number;
  marktSymbol: string | null;
  markt: MarktLatte | undefined;
}): Massstab {
  const oosDays = a.wfa.folds.reduce((s, f) => s + (f.fold.oosEnd - f.fold.oosStart) / DAY, 0);
  return {
    oosSharpe: a.metricsFns.sharpeRatio(a.wfa.oos.dailyReturns, a.periodsPerYear),
    oosMaxDD: a.wfa.oos.maxDrawdownPct,
    tradesPerMonth: oosDays > 0 ? a.wfa.oos.trades / (oosDays / TAGE_JE_MONAT) : null,
    oosDays,
    marktSymbol: a.marktSymbol,
    marktSharpe: a.markt?.sharpe ?? null,
    marktMaxDD: a.markt?.maxDrawdownPct ?? null,
  };
}

/** Name eines Festkandidaten im Bericht: `label` der Config, sonst die registrierten Parameter (keine: „Defaults"). */
export function festLabel(fc: Pick<FixedCandidateConfig, 'strategy' | 'params' | 'label'>): string {
  if (fc.label !== undefined) return fc.label;
  return Object.keys(fc.params).length === 0 ? 'Defaults' : JSON.stringify(fc.params);
}

/**
 * Effektive Parameter eines Festkandidaten: Defaults ← registrierte Werte,
 * geprüft wie `strategy.params` der Config (im Raum, auf dem Gitter, keine
 * fremden Schlüssel) — ein Tippfehler darf nicht stumm mit dem Default
 * laufen. Bei gesperrtem Short ist `allowShort` keine Achse (§5a.15): Sie
 * wird wie in der Suche auf 0 genagelt, und der Lauf sagt es, wenn das einen
 * registrierten Wert ändert.
 */
export function festParams(a: { strategy: Strategy; params: Params; allowShort: boolean; log?: ((msg: string) => void) | undefined }): Params {
  const registriert: Params = { ...a.strategy.defaults, ...a.params };
  validateParams(a.strategy.paramSpace, registriert);
  const raum = wirksamerSuchraum(a.strategy.paramSpace, a.allowShort);
  for (const [k, v] of Object.entries(raum.pinned)) {
    if (a.params[k] !== undefined && a.params[k] !== v) a.log?.(`${k}=${a.params[k]} registriert, aber bei gesperrtem Short keine Achse — auf ${v} genagelt (§5a.15)`);
  }
  return { ...registriert, ...raum.pinned };
}

/** Re-Score des amtierenden Champions auf sauberem OOS (Folds nach fitEnd). */
export interface IncumbentEval {
  strategy: string;
  fitEnd: Ms;
  cleanFolds: number;
  totalFolds: number;
  /** Kalendertage sauberes OOS. */
  cleanDays: number;
  trades: number;
  /** OOS-Median auf sauberen Folds; bei zu wenig sauberem OOS der Beförderungs-Score. */
  score: number | null;
  /** true/false = Gates auf sauberem OOS; null = nicht geprüft (zu wenig sauberes OOS). */
  pass: boolean | null;
  gates: GateResult[];
  note: string;
}

export interface SymbolRun {
  symbol: string;
  /** Absteigend nach Score sortiert. */
  results: StrategyRun[];
  decision: PromotionDecision;
  /** Wer nach diesem Lauf handelt (null = kein Handel). */
  chosen: ChampionEntry | null;
  incumbent: ChampionEntry | null;
  incumbentRescore: number | null;
  incumbentEval: IncumbentEval | null;
  /**
   * Was Kaufen-und-Halten im Holdout-Fenster gebracht hätte. Ohne diese Zahl
   * liest man Marktbewegung als Kante (siehe backtest/marktbezug.ts).
   * null, wenn es keinen Holdout gibt oder das Fenster zu kurz ist.
   */
  holdoutMarkt: HoldoutMarkt | null;
  /** Korb je Fold — die Stände, mit denen gemessen wurde; null, wenn der Korb fest war (siehe `korbHinweis`). */
  korb: KorbProtokoll | null;
  /** Warum der Korb fest war (Schalter, ungepoolt, kein Pool) — oder null. */
  korbHinweis: string | null;
  /**
   * Die Basis-Allokation dieser Einheit (Festkandidat mit `tier: basis`),
   * falls konfiguriert UND gemessen. Sie steht nicht in `results`, konkurriert
   * nicht um den Alpha-Champion und wird nie `chosen`.
   */
  basis?: BasisRun;
  errors: string[];
}

/** Ein Fold-Fenster der durchgehenden Basis-Simulation, nur Bericht: Netto der Basis neben Korb und Benchmark. */
export interface BasisScheibeRun {
  fold: Fold;
  basis: number;
  /** Netto von Startkapital in den Korb liegenlassen, aus EINER Kurve über die Range geschnitten; null ohne Kurse. */
  korb: number | null;
  spy: number | null;
}

export interface BasisRun {
  label: string;
  strategy: string;
  params: Params;
  /** Die Gate-Gruppe `basis` (vier Gates, alle müssen bestehen). */
  gates: GateResult[];
  pass: boolean;
  kennzahlen: BasisKennzahlen;
  /** Die eine Range: OOS-Beginn des ersten Folds … OOS-Ende des letzten. */
  range: TimeRange;
  stressCostMultiplier: number;
  /** Maßstab: der Korb liegenlassen, gleichgewichtet, ohne Kosten, über dieselbe Range. null = keine Kurse. */
  korb: MarktBezug | null;
  /** Zweite Referenz, nur Bericht: die Benchmark (z. B. SPY) über dieselbe Range. */
  spy?: { symbol: string; bezug: MarktBezug | null };
  scheiben: BasisScheibeRun[];
  /** Anteil der Fold-Scheiben mit positivem Basis-Netto (0–1) — nur Bericht. */
  positiveScheibenShare: number;
  /** Eigene Simulation ab Holdout-Beginn — nur Bericht. */
  holdout: (TimeRange & { metrics: Metrics }) | null;
}

export interface KorbProtokoll {
  kandidaten: number;
  /** Kandidaten des Pools ohne Bars im Messfenster — frühe Stände wählten aus einem dünneren Pool. */
  fehlend: readonly string[];
  staende: readonly KorbStand[];
  /** Heute gehandelter Korb gegenüber dem letzten Stand (dem der finalen Parameter): was heute dazukam … */
  heuteZugang: readonly string[];
  /** … und was seitdem abging. Mit Holdout liegt der letzte Stand `holdoutDays` zurück. */
  heuteAbgang: readonly string[];
}

export interface HoldoutMarkt {
  range: TimeRange;
  /** Der gehandelte Korb, gleichgewichtet. */
  korb: MarktBezug | null;
  /** Die konfigurierte Benchmark (z. B. SPY), falls vorhanden. */
  benchmarkSymbol: string | null;
  benchmark: MarktBezug | null;
}

export interface OptimizeRunOutput {
  runs: SymbolRun[];
  champion: ChampionFile;
  reportPath: string;
}

/**
 * Hat der Lauf überhaupt etwas gemessen?
 *
 * Der Unterschied, auf den alles ankommt:
 *
 * - **„Keine Strategie hat die Gates bestanden"** ist ein ZULÄSSIGES Ergebnis
 *   (CLAUDE.md §0.9). Dort wurde gemessen, und das Urteil lautet: nicht
 *   handeln. Ein solcher Lauf ist ein Erfolg und bleibt grün.
 * - **„Nicht bewertbar"** heißt, dass die MESSUNG selbst ausgefallen ist —
 *   zu wenig Historie, Datenpanne, leerer Cache. Es liegt kein Urteil vor,
 *   weder für noch gegen den Champion.
 *
 * Am 09.09. meldeten zwei Läufe „success", nachdem sie in 25 bzw. 31 Sekunden
 * nichts gemessen hatten: Der Backfill konnte nicht nach hinten wachsen und
 * fand 127 statt 815 bzw. 2900 Tage. Ein Loch, das sich als Erfolg meldet, ist
 * schlimmer als ein Fehler — man sucht nicht danach. Deshalb ist die Frage
 * hier eine eigene Funktion und der Aufrufer beendet sich mit einem Fehlercode.
 *
 * Geprüft wird `results`, nicht der Text der Entscheidung: Eine Einheit ohne
 * einen einzigen Strategie-Lauf hat nichts gemessen, ganz gleich, wie die
 * Begründung formuliert ist.
 */
export function nichtsGemessen(runs: readonly SymbolRun[]): boolean {
  return runs.length > 0 && runs.every((r) => r.results.length === 0 && r.basis === undefined);
}

/* ───────────────────────── Einheiten: ein Symbol oder der Korb ───────────────────────── */

/**
 * Bewertungseinheit. Je Symbol ist sie ein Symbol; gepoolt ist sie das ganze
 * Universum in EINEM Simulationslauf mit EINEM Konto — inklusive
 * Positionslimit, Brutto-Exposure und Notbremsen, also so, wie es live läuft.
 */
interface Einheit {
  /** Anzeige- und Journalschlüssel. */
  key: string;
  /** Symbole, auf die die Entscheidung angewandt wird. */
  symbols: string[];
  bars: BarsInput | null;
  errors: string[];
  /** Bars des Kandidatenpools im Messfenster — nur gepoolt mit Korb je Fold. */
  kandidaten: ReadonlyMap<string, BarSeriesLike> | null;
  kandidatenFehlend: readonly string[];
  korbHinweis: string | null;
  /** Korb je Fold versprochen, aber nicht wählbar — kein stiller Rückfall, nicht bewertbar. */
  korbFehler: string | null;
}

/** Anzeigename eines Korbs — taucht im Bericht und im Journal auf. */
export function korbName(anzahl: number): string {
  return `Korb (${anzahl} Symbole)`;
}

/** Erste Position mit t >= ms. */
function abIndex(bars: BarSeriesLike, ms: Ms): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars.t[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Die Bars in [start, ende) — eine Kopie, keine Sicht. Ohne `ende` bis zum Schluss. */
function imFenster(bars: BarSeriesLike, start: Ms, ende?: Ms): BarSeriesLike {
  const lo = abIndex(bars, start);
  const hi = ende === undefined ? bars.length : abIndex(bars, ende);
  if (lo === 0 && hi === bars.length) return bars;
  const out: Bar[] = [];
  for (let i = lo; i < hi; i++) out.push(bars.at(i));
  return BarSeries.from(out);
}

function einheitenVon(input: OptimizeRunInput, pooled: boolean, log: (m: string) => void): Einheit[] {
  const geladen: { symbol: string; bars: BarSeriesLike }[] = [];
  const fehler: string[] = [];
  for (const symbol of input.symbols) {
    try {
      const b = input.barsFor(symbol);
      if (b.length === 0) throw new Error('keine Bars');
      geladen.push({ symbol, bars: b });
    } catch (e) {
      fehler.push(`${symbol}: ${errMsg(e)}`);
      log(`${symbol}: ${errMsg(e)}`);
    }
  }

  // Das Messfenster ist `lookbackDays` bis zum Ende der Daten — nicht „alles,
  // was auf der Platte liegt". Der Cache wächst mit jedem tieferen Lauf; ohne
  // diesen Schnitt hinge die Fold-Zahl davon ab, wer zuletzt wie tief geladen
  // hat, und der nächtliche Lauf würde Jahr für Jahr stumm länger. Anker ist
  // das Datenende, nicht die Wanduhr: Mit Stichtag enden die Daten dort.
  let fensterStart: Ms | null = null;
  let fensterEnde: Ms | null = null;
  if (geladen.length > 0) {
    const ende = geladen.reduce((m, g) => Math.max(m, g.bars.t[g.bars.length - 1]! + 1), Number.NEGATIVE_INFINITY);
    fensterEnde = ende;
    fensterStart = ende - input.config.optimizer.lookbackDays * DAY;
    for (let i = geladen.length - 1; i >= 0; i--) {
      const g = geladen[i]!;
      g.bars = imFenster(g.bars, fensterStart);
      if (g.bars.length === 0) {
        fehler.push(`${g.symbol}: keine Bars im Messfenster`);
        log(`${g.symbol}: keine Bars im Messfenster (${input.config.optimizer.lookbackDays} Tage bis ${new Date(ende).toISOString().slice(0, 10)})`);
        geladen.splice(i, 1);
      }
    }
  }

  // Korb je Fold braucht die Bars des ganzen Kandidatenpools — im selben
  // Messfenster wie der Korb. Fehlt der Pool, ist der Lauf ungepoolt oder
  // steht der Schalter auf `fixed`, bleibt der Korb der Config fest, und der
  // Bericht sagt, warum.
  let kandidaten: Map<string, BarSeriesLike> | null = null;
  let korbHinweis: string | null = null;
  let korbFehler: string | null = null;
  const kandidatenFehlend: string[] = [];
  const pool = input.config.universe.candidates;
  if (input.config.optimizer.foldMembership === 'fixed') {
    korbHinweis = 'foldMembership: fixed — der Korb der Config gilt über das ganze Fenster (Auswahl von heute, rückwärts angewandt)';
  } else if (!pooled) {
    korbHinweis = 'ungepoolt — Korb je Fold gibt es nur für den gepoolten Korb';
  } else if (!pool || pool.length === 0 || !input.candidateBarsFor) {
    korbHinweis = 'kein Kandidatenpool (universe.candidates) — der Korb der Config gilt über das ganze Fenster';
  } else if (input.config.timeframe !== 1440) {
    // Die Auswahl rechnet auf Tagesbars wie nachts (Median-Dollarumsatz je
    // Tag). Auf Minutenbars wäre es ein anderes Kriterium (Prüfbefund 2.2).
    korbHinweis = `Korb je Fold nur auf Tagesbars (Zeitrahmen ${input.config.timeframe}) — der Korb der Config gilt über das ganze Fenster`;
  } else {
    kandidaten = new Map();
    for (const sym of pool) {
      let b: BarSeriesLike | null;
      try {
        b = input.candidateBarsFor(sym);
      } catch {
        b = null;
      }
      // Im selben Fenster wie der gehandelte Korb — und nicht darüber hinaus:
      // Ein Kandidat mit einer jüngeren Bar dürfe sonst die Zeitachse und damit
      // jeden Fold verschieben (Prüfbefund 3.1).
      const im = b && b.length > 0 && fensterStart !== null && fensterEnde !== null ? imFenster(b, fensterStart, fensterEnde) : b;
      if (!im || im.length === 0) {
        kandidatenFehlend.push(sym);
        continue;
      }
      kandidaten.set(sym, im);
    }
    if (kandidatenFehlend.length > 0) log(`Kandidatenpool: ${kandidatenFehlend.length} von ${pool.length} ohne Bars im Messfenster — nicht wählbar: ${kandidatenFehlend.join(', ')}`);
    if (kandidaten.size === 0) {
      // KEIN stiller Rückfall auf den Korb der Config: Ein Lauf, der den Korb
      // je Fold verspricht und ihn nicht wählen kann, misst nichts (Prüfbefund 6.1).
      korbFehler = `Korb je Fold: keiner von ${pool.length} Kandidaten hat Bars im Messfenster — \`fetch\` mit Kandidatenpool laufen lassen (fetchSymbols) oder foldMembership: fixed setzen`;
      kandidaten = null;
    }
  }

  if (!pooled) {
    return input.symbols.map((symbol) => {
      const g = geladen.find((x) => x.symbol === symbol);
      const eigener = fehler.filter((f) => f.startsWith(`${symbol}: `)).map((f) => `Bars: ${f.slice(symbol.length + 2)}`);
      return { key: symbol, symbols: [symbol], bars: g ? g.bars : null, errors: eigener, kandidaten: null, kandidatenFehlend: [], korbHinweis, korbFehler: null };
    });
  }

  // Gepoolt: eine Einheit. Symbole ohne Bars fallen aus dem Korb, bleiben
  // aber in `symbols` — sonst behielten sie stumm einen alten Champion,
  // obwohl über sie gerade nichts gemessen wurde.
  const korb = new Map(geladen.map((g) => [g.symbol, g.bars]));
  // Mit Korb je Fold simuliert jedes Fenster auf SEINEM Stand — die Serien
  // aller Kandidaten liegen deshalb bereit, die Membership wählt je Fenster.
  const alle = kandidaten ? new Map([...korb, ...kandidaten]) : korb;
  return [
    {
      key: korbName(korb.size),
      symbols: [...input.symbols],
      // Ohne gehandelte Symbole mit Bars gibt es nichts zu messen — auch nicht
      // auf Kandidaten allein (Prüfbefund 3.2).
      bars: korb.size > 0 ? alle : null,
      errors: fehler.length > 0 ? [`ohne Bars, nicht im Korb: ${fehler.join('; ')}`] : [],
      kandidaten: kandidaten && kandidaten.size > 0 ? kandidaten : null,
      kandidatenFehlend,
      korbHinweis,
      korbFehler,
    },
  ];
}

/**
 * Amtierender Champion einer Einheit.
 *
 * Gepoolt zählt er nur, wenn ALLE Symbole denselben Eintrag tragen — also
 * wenn er aus einem gepoolten Lauf stammt. Ein je Symbol gefitteter Champion
 * ist mit einem Korb-Kandidaten nicht vergleichbar; ihn trotzdem als
 * Amtsinhaber zu führen, hieße Äpfel gegen Birnen anzutreten und dem
 * Kandidaten eine Marge abzuverlangen, die keine Bedeutung hat.
 */
function amtsinhaberVon(champion: ChampionFile, einheit: Einheit): ChampionEntry | null {
  const erster = champion.symbols[einheit.symbols[0]!] ?? null;
  if (einheit.symbols.length === 1 || !erster) return erster;
  for (const sym of einheit.symbols) {
    const e = champion.symbols[sym];
    if (!e || e.strategy !== erster.strategy || e.fitEnd !== erster.fitEnd) return null;
    if (JSON.stringify(e.params) !== JSON.stringify(erster.params)) return null;
  }
  return erster;
}

function resolveDeps(input: OptimizeRunInput): OptimizeDeps {
  const missing: string[] = [];
  if (!input.simulate) missing.push('simulate');
  if (!input.metricsFns) missing.push('metricsFns');
  if (!input.getStrategy) missing.push('getStrategy');
  if (missing.length) {
    throw new Error(`runOptimization: ${missing.join(', ')} nicht injiziert — \`await loadDefaultDeps()\` in die Eingabe spreaden.`);
  }
  return { simulate: input.simulate!, metricsFns: input.metricsFns!, getStrategy: input.getStrategy! };
}

/** Absteigend, ±∞-sicher, mit Strategie-ID als deterministischem Tiebreak. */
function byScoreDesc(a: StrategyRun, b: StrategyRun): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  return a.strategyId < b.strategyId ? -1 : a.strategyId > b.strategyId ? 1 : 0;
}

/* ───────────────────────── Lauf ───────────────────────── */

export function runOptimization(input: OptimizeRunInput): OptimizeRunOutput {
  const deps = resolveDeps(input);
  const cfg = input.config;
  const optimizer = cfg.optimizer;
  const now = input.now ?? Date.now;
  const log = input.log ?? (() => undefined);
  const paths = homePaths(input.home);
  const journal = new Journal(input.journalPath ?? paths.journal);
  // Ein Generator für den ganzen Lauf: gleiche Config + gleicher Seed ⇒ identisches Ergebnis.
  const rng = mulberry32(optimizer.seed);
  const simConfig: SimConfig = {
    risk: cfg.risk,
    session: cfg.session,
    costs: cfg.costs,
    assetClass: cfg.universe.assetClass,
    timeframe: cfg.timeframe,
  };
  const periodsPerYear = cfg.universe.assetClass === 'crypto' ? 365 : 252;

  // Unbekannte Strategie-IDs sind ein Config-Fehler: laut scheitern, nicht still überspringen.
  const strategies = input.strategies.map((id) => deps.getStrategy(id));
  const usable = strategies.filter((s) => s.timeframes.includes(cfg.timeframe));
  for (const s of strategies) {
    if (!usable.includes(s)) log(`${s.id}: Zeitrahmen ${cfg.timeframe} nicht unterstützt — übersprungen`);
  }
  // Festkandidaten: dieselbe Regel für die Strategie-ID (unbekannt ⇒ laut,
  // fremder Zeitrahmen ⇒ übersprungen). Ihre Parameter prüft jede Einheit
  // beim Bewerten — ungültig ist dort ein Fehler-Eintrag, kein Absturz.
  const festKandidaten = optimizer.fixedCandidates.map((fc) => ({ config: fc, strategy: deps.getStrategy(fc.strategy), label: festLabel(fc) }));
  const festName = (fk: { config: FixedCandidateConfig; strategy: Strategy; label: string }) =>
    `${fk.strategy.id} · ${fk.config.tier === 'basis' ? 'Basis' : 'fest'}: ${fk.label}`;
  const festUsable = festKandidaten.filter((fk) => fk.strategy.timeframes.includes(cfg.timeframe));
  for (const fk of festKandidaten) {
    if (!festUsable.includes(fk)) log(`${festName(fk)}: Zeitrahmen ${cfg.timeframe} nicht unterstützt — übersprungen`);
  }
  // Zwei Latten, beide im Code: `alpha` läuft in derselben Liste wie die
  // gesuchten Strategien; `basis` ist die zweite Latte (durchgehende
  // Simulation, Gate-Gruppe `basis`, eigener Block in der Champion-Datei) und
  // taucht in dieser Liste NIE auf. parseConfig lässt höchstens einen zu.
  const festAlpha = festUsable.filter((fk) => fk.config.tier !== 'basis');
  const basisKandidat = festUsable.find((fk) => fk.config.tier === 'basis') ?? null;
  const basisKonfiguriert = optimizer.fixedCandidates.some((fc) => fc.tier === 'basis');

  let champion = loadChampion(paths.champion) ?? emptyChampionFile(now());
  const runs: SymbolRun[] = [];
  let dataRange: TimeRange | null = null;
  const einheiten = einheitenVon(input, optimizer.pooled, log);

  for (const einheit of einheiten) {
    const symbol = einheit.key;
    const runAt = now();
    const incumbent = amtsinhaberVon(champion, einheit);
    const errors: string[] = [...einheit.errors];
    const results: StrategyRun[] = [];

    const bars = einheit.bars;
    // Latte für das Gate `beats_market`: derselbe Maßstab über DIESELBEN
    // OOS-Fenster, auf denen auch die Strategie bewertet wird. Der Amtsinhaber
    // wird nur auf sauberen Folds nachgerechnet und braucht deshalb seine
    // eigene Latte — sonst verglichen wir eine Strategie auf Fenster X mit
    // einem Markt auf Fenster Y.
    //
    // Bewusst die BENCHMARK (SPY), nicht der Korb: Der Korb wechselt je Fold
    // (§5a.13) und stammt aus einem Pool, der von heute ist — wer unterwegs
    // verschwand, ist nicht darin. SPY ist eine Serie, die damals kaufbar war.
    const marktSymbol = input.benchmark && cfg.universe.benchmark ? cfg.universe.benchmark : null;
    const marktLatteFuer = (folds: readonly Fold[]): MarktLatte | undefined => {
      const bench = input.benchmark;
      if (!bench || marktSymbol === null || folds.length === 0) return undefined;
      const k = marktKette({
        bars: new Map([[marktSymbol, bench]]),
        ranges: folds.map((f) => ({ start: f.oosStart, end: f.oosEnd })),
        assetClass: cfg.universe.assetClass,
        periodsPerYear,
      });
      // Benchmark da, aber ohne Kurse in den Fenstern: ein Datenproblem, das
      // im Bericht nicht wie „keine Benchmark konfiguriert" aussehen darf.
      if (!k) return { sharpe: null, maxDrawdownPct: null, quelle: `${marktSymbol} kaufen und halten: keine Kurse in den OOS-Fenstern` };
      return { sharpe: k.sharpe, maxDrawdownPct: k.maxDrawdownPct, quelle: `${marktSymbol} kaufen und halten über ${k.fenster} OOS-Fenster` };
    };
    const common = bars
      ? {
          symbol,
          bars,
          benchmark: input.benchmark,
          config: simConfig,
          initialEquity: input.initialEquity,
          calendar: input.calendar,
          simulate: deps.simulate,
          membership: undefined as Membership | undefined,
        }
      : null;
    let korbProtokoll: KorbProtokoll | null = null;
    let basisRun: BasisRun | null = null;
    let messbar = true;
    // Das Regime dieser Messung — steht auf jedem neuen Champion-Eintrag.
    const korbModus: 'point_in_time' | 'fixed' = einheit.kandidaten ? 'point_in_time' : 'fixed';
    // Ein Amtsinhaber aus einem anderen Zeitrahmen oder Korb-Regime ist kein
    // Maßstab: Er tritt ab (stay_notrade räumt seinen Eintrag), statt einem
    // Kandidaten eine Marge auf einen Score abzuverlangen, der anders
    // entstanden ist (Prüfbefund 4.2).
    let incumbentVergleichbar = true;

    if (bars && common) {
      const achse = zeitachseVon(korbVon(symbol, bars));
      const first = achse.t[0]!;
      const last = achse.t[achse.length - 1]! + 1;
      dataRange = dataRange ? { start: Math.min(dataRange.start, first), end: Math.max(dataRange.end, last) } : { start: first, end: last };

      // Korb je Fold: EINMAL je Einheit gewählt (die Stände hängen nur an den
      // Daten und am Fold-Plan, nicht an der Strategie) und dann von jedem
      // Fenster über `membershipAt` abgerufen. Scheitert die Wahl, ist nichts
      // messbar — kein stiller Rückfall auf den Endkorb.
      if (einheit.korbFehler) {
        messbar = false;
        errors.push(einheit.korbFehler);
        log(`${symbol}: ${einheit.korbFehler}`);
      }
      if (einheit.kandidaten) {
        try {
          const plan = foldPlanForBars(achse, optimizer);
          const letzter = plan.folds[plan.folds.length - 1]!;
          const zeiten = [...plan.folds.map((f) => f.oosStart), letzter.oosEnd, ...(plan.holdout ? [plan.holdout.start] : [])];
          const k = korbJeFold({
            kandidaten: einheit.kandidaten,
            zeiten,
            regeln: universeRegelnFuer(cfg.universe.maxSymbols),
            pflicht: cfg.universe.benchmark ? [cfg.universe.benchmark] : [],
          });
          common.membership = k.at;
          const letzterStand = new Set(k.staende[k.staende.length - 1]!.symbols);
          const heute = new Set(einheit.symbols);
          korbProtokoll = {
            kandidaten: k.kandidaten,
            fehlend: einheit.kandidatenFehlend,
            staende: k.staende,
            heuteZugang: einheit.symbols.filter((x) => !letzterStand.has(x)).sort(),
            heuteAbgang: [...letzterStand].filter((x) => !heute.has(x)).sort(),
          };
          log(`${symbol}: Korb je Fold — ${k.staende.length} Stände aus ${k.kandidaten} Kandidaten`);
        } catch (e) {
          messbar = false;
          errors.push(`Korb je Fold: ${errMsg(e)}`);
          log(`${symbol}: Korb je Fold — Fehler: ${errMsg(e)}`);
        }
      }

      // Latte für das Gate `beats_market`: derselbe Maßstab über DIESELBEN
      // OOS-Fenster wie die Strategien. Der Fold-Plan hängt nur an der
      // Zeitachse, ist also für alle Strategien dieser Einheit derselbe —
      // einmal rechnen genügt.
      //
      // Bewusst die BENCHMARK (SPY), nicht der Korb — siehe marktLatteFuer.

      // EINE Kette für jeden Kandidaten, gesucht oder fest: Stress,
      // Nachbarschaft, DSR (IS), PSR (OOS), Gates, Maßstab. Ein Festkandidat
      // KANN so keinen Sonderweg haben — er unterscheidet sich nur darin, wie
      // sein WfaResult entstand.
      const bewerte = (strategy: Strategy, wfa: WfaResult, fest: { label: string } | null): StrategyRun => {
        const stress = stressTest({ ...common, strategy, wfa, costMultiplier: optimizer.stressCostMultiplier, objective: optimizer.objective });
        const neighborhood = neighborhoodTest({ ...common, strategy, wfa, optimizer });
        const dsr = deflatedSharpeIs({ wfa, metricsFns: deps.metricsFns, varSrSource: input.dsrVarSource });
        const psr = probabilisticSharpeOos({ wfa, metricsFns: deps.metricsFns });
        const markt = marktLatteFuer(wfa.folds.map((f) => f.fold));
        const g = robustnessGates({ wfa, optimizer, stressOos: stress, neighborhood, dsr, psr, metricsFns: deps.metricsFns, periodsPerYear, fixed: fest !== null, ...(markt ? { markt } : {}) });
        const massstab = massstabFuer({ wfa, metricsFns: deps.metricsFns, periodsPerYear, marktSymbol, markt });
        return { strategyId: strategy.id, fixed: fest !== null, label: fest?.label ?? null, wfa, gates: g.gates, pass: g.pass, score: wfa.oos.objectiveMedian, stress, neighborhood, dsr, psr, massstab };
      };
      const gatesLog = (name: string, r: StrategyRun) => log(`${symbol} ${name}: Gates ${r.pass ? 'bestanden' : 'NICHT bestanden'} (${r.gates.filter((x) => !x.pass).map((x) => x.name).join(', ') || '–'})`);

      for (const strategy of messbar ? usable : []) {
        try {
          // Kein `include` des Amtsinhabers: seine Params stammen aus einem Fit-Fenster,
          // das in den OOS-Fenstern der Kandidaten liegt — Defaults bleiben drin (walkForward).
          const wfa = walkForward({ ...common, strategy, optimizer, rng, log });
          const r = bewerte(strategy, wfa, null);
          results.push(r);
          gatesLog(strategy.id, r);
        } catch (e) {
          errors.push(`${strategy.id}: ${errMsg(e)}`);
          log(`${symbol} ${strategy.id}: Fehler — ${errMsg(e)}`);
        }
      }

      // Festkandidaten: über ALLE Folds des Plans (es gibt kein Fit-Ende, die
      // Parameter sind vorregistriert), mit dem Korb je Fold und dem Holdout
      // wie jeder gesuchte Kandidat — dann durch dieselbe Kette. Ungültige
      // Parameter sind ein Fehler-Eintrag dieser Einheit, kein Absturz.
      for (const fk of messbar ? festAlpha : []) {
        const name = festName(fk);
        try {
          const params = festParams({ strategy: fk.strategy, params: fk.config.params, allowShort: cfg.risk.allowShort, log: (m) => log(`${symbol} ${name}: ${m}`) });
          const wfa = fixedCandidateWfa({ ...common, strategy: fk.strategy, params, optimizer });
          const r = bewerte(fk.strategy, wfa, { label: fk.label });
          results.push(r);
          gatesLog(name, r);
        } catch (e) {
          // validateParams meldet mehrzeilig — im Bericht ist ein Eintrag eine Zeile.
          const msg = errMsg(e).replace(/:\s*\n\s*/g, ': ').replace(/\s*\n\s*/g, '; ');
          errors.push(`${name}: ${msg}`);
          log(`${symbol} ${name}: Fehler — ${msg}`);
        }
      }

      // Die Basis-Allokation: EINE durchgehende Simulation über die OOS-Kette,
      // Maßstab der liegengelassene Korb über dieselbe Range, Gate-Gruppe
      // `basis`. Sie kommt nicht in `results` — sie konkurriert um nichts.
      if (basisKandidat && messbar) {
        const name = festName(basisKandidat);
        try {
          if (einheiten.length > 1) {
            throw new Error('Basis nur auf EINER Einheit (gepoolter Korb oder ein Symbol) — ungepoolt mit mehreren Symbolen gäbe es mehrere Basen für einen Block');
          }
          if (common.membership) {
            throw new Error('Basis nur auf festem Korb: Korb je Fold ist für die durchgehende Simulation nicht zulässig — optimizer.foldMembership: fixed setzen oder den Kandidatenpool weglassen');
          }
          const params = festParams({ strategy: basisKandidat.strategy, params: basisKandidat.config.params, allowShort: cfg.risk.allowShort, log: (m) => log(`${symbol} ${name}: ${m}`) });
          const sim = basisSimulation({ ...common, strategy: basisKandidat.strategy, params, optimizer, sharpeRatio: deps.metricsFns.sharpeRatio, periodsPerYear });
          const korbBars = korbVon(symbol, bars);
          const gemeinsam = { range: sim.range, assetClass: cfg.universe.assetClass };
          const korb = kaufenUndHalten({ ...gemeinsam, bars: korbBars, periodsPerYear });
          const korbKurve = kaufenUndHaltenKurve({ ...gemeinsam, bars: korbBars });
          const bench = input.benchmark;
          const spyBars = bench && marktSymbol !== null ? new Map([[marktSymbol, bench]]) : null;
          const spy = spyBars ? kaufenUndHalten({ ...gemeinsam, bars: spyBars, periodsPerYear }) : null;
          const spyKurve = spyBars ? kaufenUndHaltenKurve({ ...gemeinsam, bars: spyBars }) : null;
          // Scheiben-Netto des Maßstabs: Startkapital in die Kurve investiert, dieselbe Kurve in die Folds geschnitten.
          const scheibe = (k: MarktKurve | null, f: Fold): number | null =>
            k === null ? null : input.initialEquity * (kurvenstandVor(k, f.oosEnd) - kurvenstandVor(k, f.oosStart));
          const scheiben = sim.scheiben.map((sc) => ({ fold: sc.fold, basis: sc.netProfit, korb: scheibe(korbKurve, sc.fold), spy: scheibe(spyKurve, sc.fold) }));
          const g = basisGates({
            basis: optimizer.basis,
            stressCostMultiplier: optimizer.stressCostMultiplier,
            kennzahlen: sim.kennzahlen,
            korb: korb ? { sharpe: korb.sharpe, maxDrawdownPct: korb.maxDrawdownPct } : null,
          });
          basisRun = {
            label: basisKandidat.label,
            strategy: basisKandidat.strategy.id,
            params,
            gates: g.gates,
            pass: g.pass,
            kennzahlen: sim.kennzahlen,
            range: sim.range,
            stressCostMultiplier: sim.stressCostMultiplier,
            korb,
            ...(marktSymbol !== null ? { spy: { symbol: marktSymbol, bezug: spy } } : {}),
            scheiben,
            positiveScheibenShare: scheiben.length ? scheiben.filter((x) => x.basis > 0).length / scheiben.length : 0,
            holdout: sim.holdout,
          };
          log(`${symbol} ${name}: Basis-Latte ${g.pass ? 'bestanden' : 'NICHT bestanden'} (${g.gates.filter((x) => !x.pass).map((x) => x.name).join(', ') || '–'})`);
        } catch (e) {
          const msg = errMsg(e).replace(/:\s*\n\s*/g, ': ').replace(/\s*\n\s*/g, '; ');
          errors.push(`${name}: ${msg}`);
          log(`${symbol} ${name}: Fehler — ${msg}`);
        }
      }
    }

    results.sort(byScoreDesc);
    const bestPassed = results.find((r) => r.pass) ?? null;
    const bestAny = results[0] ?? null;

    // Amtierenden Champion NUR auf sauberem OOS (Folds nach fitEnd) und durch dieselben
    // Gates bewerten. Reicht das saubere OOS nicht, gilt der bei der Beförderung belegte
    // Score weiter — eine Datenlücke ist kein Beleg gegen den Champion.
    let incumbentRescore: number | null = null;
    let incumbentPass: boolean | null = null;
    let incumbentEval: IncumbentEval | null = null;
    if (incumbent && bars && common && messbar) {
      try {
        const strat = deps.getStrategy(incumbent.strategy);
        const incumbentModus = incumbent.foldMembership ?? 'fixed';
        if (incumbent.timeframe !== cfg.timeframe || !strat.timeframes.includes(cfg.timeframe)) {
          incumbentVergleichbar = false;
          errors.push(`Champion ${incumbent.strategy}: Zeitrahmen ${incumbent.timeframe} ≠ ${cfg.timeframe} — nicht vergleichbar, tritt ab`);
        } else if (incumbentModus !== korbModus) {
          incumbentVergleichbar = false;
          errors.push(`Champion ${incumbent.strategy}: gemessen mit Korb ${incumbentModus}, jetzt ${korbModus} — nicht vergleichbar, tritt ab`);
        } else {
          const plan = foldPlanForBars(zeitachseVon(korbVon(symbol, bars)), optimizer);
          const fitEnd = fitEndOf(incumbent);
          const clean = plan.folds.filter((f) => f.oosStart >= fitEnd);
          const cleanDays = Math.round(clean.reduce((s, f) => s + (f.oosEnd - f.oosStart) / DAY, 0));
          const base = { strategy: incumbent.strategy, fitEnd, cleanFolds: clean.length, totalFolds: plan.folds.length, cleanDays };
          if (clean.length < MIN_FOLDS) {
            incumbentRescore = incumbent.score;
            incumbentEval = {
              ...base,
              trades: 0,
              score: incumbent.score,
              pass: null,
              gates: [],
              note: `zu wenig sauberes OOS nach fitEnd (${clean.length} von ${plan.folds.length} Folds, ${cleanDays} Tage; mindestens ${MIN_FOLDS} Folds) — Beförderungs-Score ${incumbent.score.toFixed(3)} gilt weiter`,
            };
          } else {
            const wfa = fixedParamsWfa({ ...common, strategy: strat, params: incumbent.params, folds: clean, optimizer, holdout: plan.holdout });
            const stress = stressTest({ ...common, strategy: strat, wfa, costMultiplier: optimizer.stressCostMultiplier, objective: optimizer.objective });
            const neighborhood = neighborhoodTest({ ...common, strategy: strat, wfa, optimizer });
            const dsr = deflatedSharpeIs({ wfa, metricsFns: deps.metricsFns, varSrSource: input.dsrVarSource });
            const psr = probabilisticSharpeOos({ wfa, metricsFns: deps.metricsFns });
            const g = robustnessGates({
              wfa,
              optimizer,
              stressOos: stress,
              neighborhood,
              dsr,
              psr,
              metricsFns: deps.metricsFns,
              periodsPerYear,
              incumbent: { cleanFolds: clean.length, totalFolds: plan.folds.length },
              ...(((m) => (m ? { markt: m } : {}))(marktLatteFuer(clean))),
            });
            incumbentRescore = wfa.oos.objectiveMedian;
            incumbentPass = g.pass;
            const failed = g.gates.filter((x) => !x.pass).map((x) => x.name);
            incumbentEval = {
              ...base,
              trades: wfa.oos.trades,
              score: incumbentRescore,
              pass: g.pass,
              gates: g.gates,
              note: g.pass
                ? `Gates auf sauberem OOS bestanden (${clean.length} von ${plan.folds.length} Folds, ${cleanDays} Tage, ${wfa.oos.trades} Trades)`
                : `Gates auf sauberem OOS gerissen: ${failed.join(', ')} (${clean.length} von ${plan.folds.length} Folds, ${cleanDays} Tage, ${wfa.oos.trades} Trades)`,
            };
          }
          log(`${symbol} Champion ${incumbent.strategy}: ${incumbentEval.note}`);
        }
      } catch (e) {
        errors.push(`Champion ${incumbent.strategy}: Re-Score fehlgeschlagen — ${errMsg(e)}`);
      }
    }

    const toEntry = (r: StrategyRun): ChampionEntry => ({
      strategy: r.strategyId,
      params: r.wfa.finalParams,
      timeframe: cfg.timeframe,
      score: r.score,
      oos: r.wfa.oos,
      gates: r.gates,
      decidedAt: runAt,
      trials: r.wfa.trials,
      dataRange: r.wfa.dataRange,
      // Ende des Fensters, aus dem finalParams stammen: OOS davor ist für spätere Re-Scores tabu.
      fitEnd: r.wfa.finalWindow.end,
      foldMembership: korbModus,
      // Ein Festkandidat bleibt als solcher erkennbar: vorregistriert, nicht gesucht.
      ...(r.fixed ? { fixed: true as const } : {}),
    });

    // Marktbezug des Holdouts: EINMAL je Einheit, denn das Fenster hängt nur
    // an den Daten, nicht an der Strategie. Er entscheidet nichts — er ist
    // der Maßstab, an dem ein Leser erkennt, ob eine Holdout-Rendite Kante
    // war oder nur Markt.
    let holdoutMarkt: HoldoutMarkt | null = null;
    const holdoutRange = results.find((r) => r.wfa.holdout !== null)?.wfa.holdout ?? basisRun?.holdout ?? null;
    if (holdoutRange && bars) {
      const range = { start: holdoutRange.start, end: holdoutRange.end };
      const gemeinsam = { range, assetClass: cfg.universe.assetClass, periodsPerYear };
      const bench = input.benchmark;
      const benchSymbol = cfg.universe.benchmark ?? null;
      holdoutMarkt = {
        range,
        // Der Korb zum Holdout-Beginn — nicht der Endkorb: Der Maßstab folgt der Zugehörigkeit.
        korb: kaufenUndHalten({ ...gemeinsam, bars: korbZum(korbVon(symbol, bars), common?.membership, range.start) }),
        benchmarkSymbol: bench && benchSymbol ? benchSymbol : null,
        benchmark: bench && benchSymbol ? kaufenUndHalten({ ...gemeinsam, bars: new Map([[benchSymbol, bench]]) }) : null,
      };
    }

    let decision: PromotionDecision;
    let candidate: ChampionEntry | null = null;
    if (!bars || (results.length === 0 && errors.length > 0)) {
      // Nichts messbar (Datenpanne, zu wenig Historie): kein Beleg für oder
      // gegen den Champion — Zustand unverändert lassen, Fehler in den Bericht.
      decision = { action: incumbent ? 'keep' : 'stay_notrade', reason: `nicht bewertbar: ${errors.join('; ')}` };
    } else {
      const pick = bestPassed ?? bestAny;
      candidate = pick ? toEntry(pick) : null;
      decision = decidePromotion({
        incumbent: incumbentVergleichbar ? incumbent : null,
        incumbentRescore,
        incumbentPass,
        candidate: candidate ? { entry: candidate, pass: bestPassed !== null } : null,
        margin: optimizer.promotionMargin,
      });
    }

    // Gepoolt gilt EINE Entscheidung für den ganzen Korb: derselbe Eintrag
    // wird für jedes Symbol geschrieben. Damit bleibt das Champion-Format je
    // Symbol — Engine, Frontend und Plattform brauchen keine Zeile Änderung.
    for (const sym of einheit.symbols) {
      champion = applyDecision({ file: champion, symbol: sym, decision, candidate, bestScore: bestAny ? bestAny.score : null, now: runAt });
    }
    const ersteszSymbol = einheit.symbols[0]!;
    const chosen = decision.action === 'promote' ? champion.symbols[ersteszSymbol]! : decision.action === 'keep' ? incumbent : null;
    journalDecision(journal, { symbol, decision, chosen, candidate, candidatePass: bestPassed !== null, incumbentRescore, incumbentPass, now: runAt });
    log(`${symbol}: ${decision.action} — ${decision.reason}`);

    // Basis-Block: geschrieben, wenn gemessen — bestanden oder nicht; `pass`
    // entscheidet, was eine spätere Engine-Stufe damit tun darf. Nicht
    // messbar (Fehler oben) ⇒ der alte Block bleibt, wie beim Alpha-Champion
    // ohne Beleg; der Bericht trägt den Fehler.
    if (basisRun) {
      const block: ChampionBasis = {
        version: 1,
        strategy: basisRun.strategy,
        params: basisRun.params,
        symbols: [...einheit.symbols],
        label: basisRun.label,
        timeframe: cfg.timeframe,
        pass: basisRun.pass,
        gates: basisRun.gates,
        measuredAt: runAt,
        ...(input.configCommit === undefined ? {} : { configCommit: input.configCommit }),
      };
      champion = mitBasis(champion, block, runAt);
      const gerissen = basisRun.gates.filter((x) => !x.pass).map((x) => x.name);
      journalBasis(journal, { symbol, basis: block, reason: basisRun.pass ? 'Basis-Latte bestanden' : `Basis-Latte nicht bestanden: ${gerissen.join(', ')}`, now: runAt });
    }
    runs.push({
      symbol,
      results,
      decision,
      chosen,
      incumbent,
      incumbentRescore,
      incumbentEval,
      holdoutMarkt,
      korb: korbProtokoll,
      korbHinweis: einheit.korbHinweis,
      ...(basisRun ? { basis: basisRun } : {}),
      errors,
    });
  }

  // Kein Basis-Kandidat mehr in der Config ⇒ kein veralteter Block überlebt.
  if (!basisKonfiguriert && champion.basis) {
    const alt = champion.basis;
    champion = mitBasis(champion, null, now());
    journalBasis(journal, { symbol: alt.symbols.join(','), basis: null, reason: `kein Festkandidat mit tier: basis mehr in der Config — Block „${alt.label}" geräumt`, now: now() });
    log(`Basis „${alt.label}" aus der Champion-Datei geräumt: kein Basis-Kandidat mehr in der Config`);
  }

  saveChampion(paths.champion, champion);
  const generatedAt = now();
  const text = renderReport(runs, {
    generatedAt,
    timeframe: cfg.timeframe,
    assetClass: cfg.universe.assetClass,
    dataRange,
    costs: cfg.costs,
    optimizer,
    risk: cfg.risk,
    initialEquity: input.initialEquity,
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
  });
  const reportPath = writeReport(paths.reports, `optimize-${dayKey(generatedAt)}.md`, text);
  log(`Bericht: ${reportPath}`);
  return { runs, champion, reportPath };
}
