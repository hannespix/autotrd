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
 */
import type { Config } from '../core/config.ts';
import { Journal, homePaths } from '../core/journal.ts';
import { errMsg } from '../core/log.ts';
import type { Calendar } from '../core/time.ts';
import { DAY, dayKey } from '../core/time.ts';
import type { BarSeriesLike, Ms, Strategy } from '../core/types.ts';
import {
  applyDecision,
  decidePromotion,
  emptyChampionFile,
  fitEndOf,
  journalDecision,
  loadChampion,
  saveChampion,
  type ChampionEntry,
  type ChampionFile,
  type PromotionDecision,
} from './promote.ts';
import { renderReport, writeReport } from './report.ts';
import {
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
import { mulberry32 } from './search.ts';
import {
  MIN_FOLDS,
  fixedParamsWfa,
  foldPlanForBars,
  korbVon,
  walkForward,
  zeitachseVon,
  type BarsInput,
  type SimConfig,
  type SimulateFn,
  type TimeRange,
  type WfaResult,
} from './walkForward.ts';

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
  log?: ((msg: string) => void) | undefined;
}

export interface StrategyRun {
  strategyId: string;
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
  errors: string[];
}

export interface OptimizeRunOutput {
  runs: SymbolRun[];
  champion: ChampionFile;
  reportPath: string;
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
}

/** Anzeigename eines Korbs — taucht im Bericht und im Journal auf. */
export function korbName(anzahl: number): string {
  return `Korb (${anzahl} Symbole)`;
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

  if (!pooled) {
    return input.symbols.map((symbol) => {
      const g = geladen.find((x) => x.symbol === symbol);
      const eigener = fehler.filter((f) => f.startsWith(`${symbol}: `)).map((f) => `Bars: ${f.slice(symbol.length + 2)}`);
      return { key: symbol, symbols: [symbol], bars: g ? g.bars : null, errors: eigener };
    });
  }

  // Gepoolt: eine Einheit. Symbole ohne Bars fallen aus dem Korb, bleiben
  // aber in `symbols` — sonst behielten sie stumm einen alten Champion,
  // obwohl über sie gerade nichts gemessen wurde.
  const korb = new Map(geladen.map((g) => [g.symbol, g.bars]));
  return [
    {
      key: korbName(korb.size),
      symbols: [...input.symbols],
      bars: korb.size > 0 ? korb : null,
      errors: fehler.length > 0 ? [`ohne Bars, nicht im Korb: ${fehler.join('; ')}`] : [],
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
    const common = bars
      ? {
          symbol,
          bars,
          benchmark: input.benchmark,
          config: simConfig,
          initialEquity: input.initialEquity,
          calendar: input.calendar,
          simulate: deps.simulate,
        }
      : null;

    if (bars && common) {
      const achse = zeitachseVon(korbVon(symbol, bars));
      const first = achse.t[0]!;
      const last = achse.t[achse.length - 1]! + 1;
      dataRange = dataRange ? { start: Math.min(dataRange.start, first), end: Math.max(dataRange.end, last) } : { start: first, end: last };

      for (const strategy of usable) {
        try {
          // Kein `include` des Amtsinhabers: seine Params stammen aus einem Fit-Fenster,
          // das in den OOS-Fenstern der Kandidaten liegt — Defaults bleiben drin (walkForward).
          const wfa = walkForward({ ...common, strategy, optimizer, rng, log });
          const stress = stressTest({ ...common, strategy, wfa, costMultiplier: optimizer.stressCostMultiplier, objective: optimizer.objective });
          const neighborhood = neighborhoodTest({ ...common, strategy, wfa, optimizer });
          const dsr = deflatedSharpeIs({ wfa, metricsFns: deps.metricsFns, varSrSource: input.dsrVarSource });
          const psr = probabilisticSharpeOos({ wfa, metricsFns: deps.metricsFns });
          const g = robustnessGates({ wfa, optimizer, stressOos: stress, neighborhood, dsr, psr, metricsFns: deps.metricsFns, periodsPerYear });
          results.push({ strategyId: strategy.id, wfa, gates: g.gates, pass: g.pass, score: wfa.oos.objectiveMedian, stress, neighborhood, dsr, psr });
          log(`${symbol} ${strategy.id}: Gates ${g.pass ? 'bestanden' : 'NICHT bestanden'} (${g.gates.filter((x) => !x.pass).map((x) => x.name).join(', ') || '–'})`);
        } catch (e) {
          errors.push(`${strategy.id}: ${errMsg(e)}`);
          log(`${symbol} ${strategy.id}: Fehler — ${errMsg(e)}`);
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
    if (incumbent && bars && common) {
      try {
        const strat = deps.getStrategy(incumbent.strategy);
        if (incumbent.timeframe !== cfg.timeframe || !strat.timeframes.includes(cfg.timeframe)) {
          errors.push(`Champion ${incumbent.strategy}: Zeitrahmen ${incumbent.timeframe} ≠ ${cfg.timeframe} — nicht vergleichbar`);
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
    });

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
        incumbent,
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
    runs.push({ symbol, results, decision, chosen, incumbent, incumbentRescore, incumbentEval, errors });
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
