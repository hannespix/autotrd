/**
 * Ein Optimierungslauf: je Symbol × Strategie Walk-Forward → Stress,
 * Nachbarschaft, Deflated Sharpe → Gates → Champion/Challenger-Entscheidung
 * → champion.json, Journal, Markdown-Bericht.
 *
 * Simulator, Statistik und Strategie-Register werden INJIZIERT. Die
 * Standard-Implementierungen (Backtester, Strategien) lädt `loadDefaultDeps()`
 * asynchron nach — so bleibt `runOptimization` synchron und ohne statische
 * Abhängigkeit auf Module, die parallel entstehen; Tests laufen mit Fakes.
 */
import type { Config } from '../core/config.ts';
import { Journal, homePaths } from '../core/journal.ts';
import { errMsg } from '../core/log.ts';
import type { Calendar } from '../core/time.ts';
import { dayKey } from '../core/time.ts';
import type { BarSeriesLike, Ms, Strategy } from '../core/types.ts';
import {
  applyDecision,
  decidePromotion,
  emptyChampionFile,
  journalDecision,
  loadChampion,
  saveChampion,
  type ChampionEntry,
  type ChampionFile,
  type PromotionDecision,
} from './promote.ts';
import { renderReport, writeReport } from './report.ts';
import {
  deflatedSharpeOos,
  neighborhoodTest,
  robustnessGates,
  stressTest,
  type DsrResult,
  type DsrVarSource,
  type GateResult,
  type MetricsFns,
  type NeighborhoodResult,
  type StressResult,
} from './robustness.ts';
import { mulberry32 } from './search.ts';
import {
  foldPlanForBars,
  oosScoreOnFolds,
  walkForward,
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
  /** Streuungsquelle des Deflated Sharpe; Vorgabe 'fold_sharpes' (siehe robustness.ts). */
  dsrVarSource?: DsrVarSource | undefined;
  now?: (() => Ms) | undefined;
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
  dsr: DsrResult;
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
  errors: string[];
}

export interface OptimizeRunOutput {
  runs: SymbolRun[];
  champion: ChampionFile;
  reportPath: string;
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

  for (const symbol of input.symbols) {
    const runAt = now();
    const incumbent = champion.symbols[symbol] ?? null;
    const errors: string[] = [];
    const results: StrategyRun[] = [];

    let bars: BarSeriesLike | null = null;
    try {
      const b = input.barsFor(symbol);
      if (b.length === 0) throw new Error('keine Bars');
      bars = b;
    } catch (e) {
      errors.push(`Bars: ${errMsg(e)}`);
      log(`${symbol}: ${errMsg(e)}`);
    }

    if (bars) {
      const first = bars.t[0]!;
      const last = bars.t[bars.length - 1]! + 1;
      dataRange = dataRange ? { start: Math.min(dataRange.start, first), end: Math.max(dataRange.end, last) } : { start: first, end: last };

      const common = {
        symbol,
        bars,
        benchmark: input.benchmark,
        config: simConfig,
        initialEquity: input.initialEquity,
        calendar: input.calendar,
        simulate: deps.simulate,
      };

      for (const strategy of usable) {
        try {
          const include = incumbent && incumbent.strategy === strategy.id ? [incumbent.params] : [];
          const wfa = walkForward({ ...common, strategy, optimizer, rng, include, log });
          const stress = stressTest({ ...common, strategy, wfa, costMultiplier: optimizer.stressCostMultiplier, objective: optimizer.objective });
          const neighborhood = neighborhoodTest({ ...common, strategy, wfa, optimizer });
          const dsr = deflatedSharpeOos({ wfa, metricsFns: deps.metricsFns, varSrSource: input.dsrVarSource });
          const g = robustnessGates({
            wfa,
            optimizer,
            stressOos: stress,
            neighborhood,
            dsr: dsr.dsr,
            metricsFns: deps.metricsFns,
            periodsPerYear,
          });
          results.push({ strategyId: strategy.id, wfa, gates: g.gates, pass: g.pass, score: wfa.oos.objectiveMedian, stress, neighborhood, dsr });
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

    // Amtierenden Champion auf DENSELBEN Folds neu bewerten — ein alter Score
    // aus einer anderen Datenlage ist kein Vergleichsmaßstab.
    let incumbentRescore: number | null = null;
    if (incumbent && bars) {
      try {
        const strat = deps.getStrategy(incumbent.strategy);
        if (incumbent.timeframe !== cfg.timeframe || !strat.timeframes.includes(cfg.timeframe)) {
          errors.push(`Champion ${incumbent.strategy}: Zeitrahmen ${incumbent.timeframe} ≠ ${cfg.timeframe} — nicht vergleichbar`);
        } else {
          const folds = foldPlanForBars(bars, optimizer).folds;
          incumbentRescore = oosScoreOnFolds({
            symbol,
            strategy: strat,
            params: incumbent.params,
            bars,
            benchmark: input.benchmark,
            config: simConfig,
            initialEquity: input.initialEquity,
            calendar: input.calendar,
            simulate: deps.simulate,
            folds,
            objective: optimizer.objective,
          }).objectiveMedian;
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
        candidate: candidate ? { entry: candidate, pass: bestPassed !== null } : null,
        margin: optimizer.promotionMargin,
      });
    }

    champion = applyDecision({ file: champion, symbol, decision, candidate, bestScore: bestAny ? bestAny.score : null, now: runAt });
    const chosen = decision.action === 'promote' ? champion.symbols[symbol]! : decision.action === 'keep' ? incumbent : null;
    journalDecision(journal, { symbol, decision, chosen, candidate, candidatePass: bestPassed !== null, incumbentRescore, now: runAt });
    log(`${symbol}: ${decision.action} — ${decision.reason}`);
    runs.push({ symbol, results, decision, chosen, incumbent, incumbentRescore, errors });
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
    initialEquity: input.initialEquity,
  });
  const reportPath = writeReport(paths.reports, `optimize-${dayKey(generatedAt)}.md`, text);
  log(`Bericht: ${reportPath}`);
  return { runs, champion, reportPath };
}
