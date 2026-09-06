/**
 * Walk-Forward-Analyse: rollierende IS/OOS-Fenster, Suche je Fenster über
 * den ECHTEN Simulator (injiziert), Sperrzone (Embargo) zwischen IS und
 * OOS, Holdout am Ende, das nie zur Auswahl benutzt wird.
 *
 * Warum so streng: Das Vorgängersystem maß eine Strategie, die live nie
 * lief, wählte auf denselben Daten wiederholt aus und kannte keine Sperrzone.
 * Hier gilt: Jede Zahl, die eine Auswahl trifft, stammt aus dem Simulator
 * mit demselben Entscheidungspfad wie live — und jede Verbesserung ist
 * Einbildung, bis sie out-of-sample nach Kosten überlebt.
 */
import type { CostConfig, OptimizerConfig, RiskConfig, SessionConfig } from '../core/config.ts';
import type { Calendar } from '../core/time.ts';
import { DAY } from '../core/time.ts';
import type {
  AssetClass,
  BarSeriesLike,
  EquityPoint,
  Metrics,
  Ms,
  Params,
  SimResult,
  Strategy,
  TimeframeMin,
  Trade,
} from '../core/types.ts';
import { mean, median, objectiveValue, perPeriodSharpe, type ObjectiveId } from './objective.ts';
import { sampleParams } from './search.ts';

/* ───────────────────────── Injektionspunkt Simulator ───────────────────────── */

/**
 * Spiegel des vereinbarten Backtester-Vertrags (src/backtest/simulator.ts).
 * Bewusst lokal deklariert: So ist dieses Modul auch typgeprüft, solange der
 * Backtester parallel entsteht; beim Zusammenziehen prüft TypeScript an der
 * Injektionsstelle, dass beide Verträge zusammenpassen.
 */
export interface SimConfig {
  risk: RiskConfig;
  session: SessionConfig;
  costs: CostConfig;
  assetClass: AssetClass;
  timeframe: TimeframeMin;
}

export interface SimInput {
  bars: ReadonlyMap<string, BarSeriesLike>;
  benchmark?: BarSeriesLike;
  strategyFor: (symbol: string) => { strategy: Strategy; params: Params } | null;
  config: SimConfig;
  initialEquity: number;
  /** Entscheidungen nur in [start, end); alles davor ist Warmup. */
  range?: { start: Ms; end: Ms };
  calendar?: Calendar;
  costMultiplier?: number;
}

export type SimulateFn = (input: SimInput) => SimResult;

export interface TimeRange {
  start: Ms;
  end: Ms;
}

/* ───────────────────────── Folds ───────────────────────── */

export interface Fold {
  index: number;
  isStart: Ms;
  isEnd: Ms;
  oosStart: Ms;
  oosEnd: Ms;
}

export interface FoldPlan {
  folds: Fold[];
  /** Letzte `holdoutDays` — für die Auswahl tabu, nur Bericht. */
  holdout: TimeRange | null;
}

export const MIN_FOLDS = 3;

/**
 * Rollierende Folds, am ENDE verankert: Der letzte Fold endet exakt vor dem
 * Holdout, damit die jüngsten Daten in die Auswahl eingehen; ein Rest am
 * Anfang dient dem ersten Fold als Warmup.
 */
export function buildFolds(a: {
  dataStart: Ms;
  dataEnd: Ms;
  isDays: number;
  oosDays: number;
  stepDays: number;
  holdoutDays: number;
}): FoldPlan {
  if (!(a.isDays > 0) || !(a.oosDays > 0) || !(a.stepDays > 0) || a.holdoutDays < 0) {
    throw new Error(`buildFolds: ungültige Fenster (is=${a.isDays}, oos=${a.oosDays}, step=${a.stepDays}, holdout=${a.holdoutDays})`);
  }
  if (!(a.dataEnd > a.dataStart)) throw new Error('buildFolds: dataEnd muss nach dataStart liegen');

  const selectionEnd = a.dataEnd - a.holdoutDays * DAY;
  const span = selectionEnd - a.dataStart;
  const need = (a.isDays + a.oosDays) * DAY;
  const step = a.stepDays * DAY;
  const count = span >= need ? Math.floor((span - need) / step) + 1 : 0;
  if (count < MIN_FOLDS) {
    const haveDays = Math.floor((a.dataEnd - a.dataStart) / DAY);
    const needDays = a.isDays + a.oosDays + (MIN_FOLDS - 1) * a.stepDays + a.holdoutDays;
    throw new Error(
      `Walk-Forward braucht mindestens ${MIN_FOLDS} Folds, möglich: ${count}. ` +
        `Daten: ${haveDays} Tage (Holdout ${a.holdoutDays}); je Fold ${a.isDays} IS + ${a.oosDays} OOS Tage, Schritt ${a.stepDays} ⇒ ` +
        `mindestens ${needDays} Tage nötig (optimizer.lookbackDays erhöhen oder Fenster verkleinern).`,
    );
  }

  const folds: Fold[] = [];
  for (let k = 0; k < count; k++) {
    const oosEnd = selectionEnd - (count - 1 - k) * step;
    const oosStart = oosEnd - a.oosDays * DAY;
    const isEnd = oosStart;
    const isStart = isEnd - a.isDays * DAY;
    folds.push({ index: k, isStart, isEnd, oosStart, oosEnd });
  }
  return { folds, holdout: a.holdoutDays > 0 ? { start: selectionEnd, end: a.dataEnd } : null };
}

/** Datenbereich einer Serie: [erste Bar, letzte Bar + 1 ms) — Ende exklusiv. */
export function dataRangeOf(bars: BarSeriesLike): TimeRange {
  if (bars.length === 0) throw new Error('Keine Bars — Walk-Forward unmöglich');
  return { start: bars.t[0]!, end: bars.t[bars.length - 1]! + 1 };
}

/** Fold-Plan direkt aus Serie + Optimierer-Config (identisch für alle Strategien eines Symbols). */
export function foldPlanForBars(bars: BarSeriesLike, optimizer: OptimizerConfig): FoldPlan {
  const range = dataRangeOf(bars);
  return buildFolds({
    dataStart: range.start,
    dataEnd: range.end,
    isDays: optimizer.isDays,
    oosDays: optimizer.oosDays,
    stepDays: optimizer.stepDays,
    holdoutDays: optimizer.holdoutDays,
  });
}

/* ───────────────────────── Embargo ───────────────────────── */

/** Erste Position mit t >= ms (binäre Suche) = Anzahl Bars mit t < ms. */
export function lowerBound(t: Float64Array, ms: Ms): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sperrzone in Bars: konfiguriert, sonst automatisch Warmup + 20 (Proxy für die Haltedauer). */
export function embargoBarsFor(strategy: Strategy, params: Params, optimizer: OptimizerConfig): number {
  if (optimizer.embargoBars > 0) return optimizer.embargoBars;
  return strategy.warmupBars(params) + 20;
}

/**
 * Range-Ende des IS-Fensters nach Abzug von `embargoBars` Bars vor `isEnd`.
 * Frisst die Sperrzone das ganze Fenster, kommt `isStart` zurück (leerer
 * Bereich) — der Aufrufer bricht dann mit klarer Meldung ab, statt ein
 * Fenster ohne Entscheidungen still als "0 Trades" zu werten.
 */
export function embargoedEnd(bars: BarSeriesLike, isStart: Ms, isEnd: Ms, embargoBars: number): Ms {
  if (embargoBars <= 0) return isEnd;
  const j = lowerBound(bars.t, isEnd);
  const i0 = lowerBound(bars.t, isStart);
  const cut = j - embargoBars;
  if (cut <= i0) return isStart;
  return bars.t[cut]!;
}

/** Effektiver Entscheidungsbereich eines Kandidaten in einem Fenster (Embargo am Ende, wenn gewünscht). */
export function candidateRange(
  bars: BarSeriesLike,
  window: TimeRange,
  strategy: Strategy,
  params: Params,
  optimizer: OptimizerConfig,
  embargoAtEnd: boolean,
): TimeRange {
  if (!embargoAtEnd) return { start: window.start, end: window.end };
  const end = embargoedEnd(bars, window.start, window.end, embargoBarsFor(strategy, params, optimizer));
  if (end <= window.start) {
    throw new Error(
      `Embargo (${embargoBarsFor(strategy, params, optimizer)} Bars) verschluckt das gesamte Fenster ` +
        `${new Date(window.start).toISOString()} … ${new Date(window.end).toISOString()} für ${strategy.id} — ` +
        `optimizer.isDays erhöhen oder optimizer.embargoBars setzen.`,
    );
  }
  return { start: window.start, end };
}

/* ───────────────────────── Ein Simulationslauf ───────────────────────── */

export interface WindowSimArgs {
  symbol: string;
  strategy: Strategy;
  params: Params;
  bars: BarSeriesLike;
  benchmark?: BarSeriesLike | undefined;
  config: SimConfig;
  initialEquity: number;
  calendar?: Calendar | undefined;
  simulate: SimulateFn;
  range: TimeRange;
  costMultiplier?: number | undefined;
}

/** Ein Symbol, ein Parametersatz, ein Zeitfenster — durch den echten Simulator. */
export function simulateWindow(a: WindowSimArgs): SimResult {
  const input: SimInput = {
    bars: new Map([[a.symbol, a.bars]]),
    strategyFor: (s) => (s === a.symbol ? { strategy: a.strategy, params: a.params } : null),
    config: a.config,
    initialEquity: a.initialEquity,
    range: { start: a.range.start, end: a.range.end },
  };
  if (a.benchmark) input.benchmark = a.benchmark;
  if (a.calendar) input.calendar = a.calendar;
  if (a.costMultiplier !== undefined && a.costMultiplier !== 1) input.costMultiplier = a.costMultiplier;
  return a.simulate(input);
}

/* ───────────────────────── OOS-Aggregation ───────────────────────── */

export interface OosPiece {
  metrics: Metrics;
  trades: readonly Trade[];
  dailyReturns: readonly number[];
  equity: readonly EquityPoint[];
  finalEquity: number;
}

export interface OosAggregate {
  objectiveMedian: number;
  objectiveMean: number;
  positiveFoldShare: number;
  trades: number;
  netProfit: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  dailyReturns: number[];
  profitFactor: number | null;
  feeShare: number | null;
}

/**
 * OOS-Folds zu einer Kette verbinden. Jeder Fold startete mit initialEquity;
 * die Kette multipliziert die Fold-Renditen, der Drawdown wird über die
 * verkettete Equity gemessen (ein Fold-Verlust am Anfang zählt also weiter).
 */
export function aggregateOos(pieces: readonly OosPiece[], objective: ObjectiveId, initialEquity: number): OosAggregate {
  const objectives = pieces.map((p) => objectiveValue(objective, p.metrics));
  let positive = 0;
  let trades = 0;
  let netProfit = 0;
  let scale = 1;
  let peak = 1;
  let maxDd = 0;
  const dailyReturns: number[] = [];
  let wins = 0;
  let losses = 0;
  let fees = 0;
  let gross = 0;

  const touch = (v: number) => {
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  };

  for (const p of pieces) {
    if (p.metrics.netProfit > 0) positive++;
    trades += p.metrics.trades;
    netProfit += p.metrics.netProfit;
    if (initialEquity > 0) {
      for (const e of p.equity) touch((scale * e.equity) / initialEquity);
      scale *= p.finalEquity / initialEquity;
    } else {
      scale *= 1 + p.metrics.netReturnPct / 100;
    }
    touch(scale);
    for (const r of p.dailyReturns) dailyReturns.push(r);
    for (const t of p.trades) {
      if (t.netPnl > 0) wins += t.netPnl;
      else losses += -t.netPnl;
      fees += t.fees;
      gross += t.grossPnl;
    }
  }

  return {
    objectiveMedian: median(objectives),
    objectiveMean: mean(objectives),
    positiveFoldShare: pieces.length ? positive / pieces.length : 0,
    trades,
    netProfit,
    netReturnPct: (scale - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    dailyReturns,
    profitFactor: losses > 0 ? wins / losses : null,
    // Gebührenanteil am Bruttogewinn — nur sinnvoll, wenn brutto etwas verdient wurde.
    feeShare: gross > 0 ? fees / gross : null,
  };
}

function pieceOf(r: SimResult): OosPiece {
  return { metrics: r.metrics, trades: r.trades, dailyReturns: r.dailyReturns, equity: r.equity, finalEquity: r.finalEquity };
}

/* ───────────────────────── Suche in einem Fenster ───────────────────────── */

export interface WfaCandidate {
  params: Params;
  isMetrics: Metrics;
  oosMetrics: Metrics;
  oosTrades: Trade[];
  isObjective: number;
  oosObjective: number;
  oosDailyReturns: number[];
}

export interface WfaFoldResult {
  fold: Fold;
  best: WfaCandidate;
  /** Anzahl in diesem Fold bewerteter Parametersätze. */
  evaluated: number;
}

export interface WfaResult {
  strategyId: string;
  symbol: string;
  timeframe: TimeframeMin;
  folds: WfaFoldResult[];
  oos: OosAggregate;
  /** Parameter für den Live-Einsatz: Re-Optimierung auf dem letzten bekannten Fenster (vor dem Holdout). */
  finalParams: Params;
  finalIsMetrics: Metrics;
  /** Nominales Fenster der finalen Suche; `embargoAtEnd` gilt genau dann, wenn ein Holdout folgt. */
  finalWindow: TimeRange & { embargoAtEnd: boolean };
  /** Bewertete Parametersätze insgesamt (für den Deflated Sharpe). */
  trials: number;
  /** Tagesrenditen von finalParams auf dem finalen Suchfenster (IS) — die Zahl, die der DSR deflationiert. */
  finalIsDailyReturns: number[];
  /** IS-Sharpe je Periode aller Kandidaten der finalen Suche (nur berechenbare) — Streuung der Trials für den DSR. */
  finalTrialSharpes: number[];
  /** finalParams auf dem Holdout — NUR Bericht, nie Auswahl. */
  holdout: (TimeRange & { metrics: Metrics }) | null;
  dataRange: TimeRange;
  /** Sperrzone in Bars für die Default-Parameter (Bericht). */
  embargoBars: number;
}

export interface WalkForwardArgs {
  symbol: string;
  strategy: Strategy;
  /** Bars im Strategie-Zeitrahmen. */
  bars: BarSeriesLike;
  benchmark?: BarSeriesLike | undefined;
  config: SimConfig;
  optimizer: OptimizerConfig;
  initialEquity: number;
  calendar?: Calendar | undefined;
  simulate: SimulateFn;
  rng: () => number;
  /** Immer mitbewertete Parametersätze (z. B. amtierender Champion). */
  include?: readonly Params[] | undefined;
  log?: ((msg: string) => void) | undefined;
}

interface WindowSearch {
  params: Params;
  result: SimResult;
  objective: number;
  evaluated: number;
  /** IS-Sharpe je Periode aller Kandidaten dieses Fensters (nur berechenbare). */
  trialSharpes: number[];
}

/** Mindest-Trades im IS, damit ein Kandidat überhaupt gewählt werden darf. */
export function minIsTrades(optimizer: OptimizerConfig): number {
  return Math.max(10, Math.floor(optimizer.minOosTrades / 4));
}

function searchWindow(a: WalkForwardArgs, window: TimeRange, include: readonly Params[], embargoAtEnd: boolean): WindowSearch {
  const { strategy, optimizer } = a;
  const seeds: Params[] = [strategy.defaults, ...include].map((p) => ({ ...strategy.defaults, ...p }));
  const candidates = sampleParams(strategy.paramSpace, optimizer.samples, a.rng, seeds).map((p) => ({ ...strategy.defaults, ...p }));
  const floor = minIsTrades(optimizer);

  let best: WindowSearch | null = null;
  let fallback: WindowSearch | null = null;
  const trialSharpes: number[] = [];
  for (const params of candidates) {
    const range = candidateRange(a.bars, window, strategy, params, optimizer, embargoAtEnd);
    const result = simulateWindow({ ...a, params, range });
    const objective = objectiveValue(optimizer.objective, result.metrics);
    const sr = perPeriodSharpe(result.dailyReturns);
    if (sr !== null) trialSharpes.push(sr);
    const cand: WindowSearch = { params, result, objective, evaluated: 0, trialSharpes: [] };
    // Bei Gleichstand bleibt der frühere Kandidat — deterministisch und
    // zugunsten von Defaults/Champion, die vorne in der Liste stehen.
    if (result.metrics.trades >= floor && (best === null || objective > best.objective)) best = cand;
    if (fallback === null || result.metrics.trades > fallback.result.metrics.trades) fallback = cand;
  }
  const chosen = best ?? fallback;
  if (!chosen) throw new Error(`Keine Kandidaten für ${strategy.id} — leerer Parameterraum?`);
  return { ...chosen, evaluated: candidates.length, trialSharpes };
}

/* ───────────────────────── Walk-Forward ───────────────────────── */

export function walkForward(a: WalkForwardArgs): WfaResult {
  const { strategy, optimizer } = a;
  const plan = foldPlanForBars(a.bars, optimizer);
  const dataRange = dataRangeOf(a.bars);
  const include = a.include ?? [];
  const log = a.log ?? (() => undefined);

  let trials = 0;
  const foldResults: WfaFoldResult[] = [];
  const pieces: OosPiece[] = [];

  for (const fold of plan.folds) {
    const is = searchWindow(a, { start: fold.isStart, end: fold.isEnd }, include, true);
    trials += is.evaluated;
    const oos = simulateWindow({ ...a, params: is.params, range: { start: fold.oosStart, end: fold.oosEnd } });
    const oosObjective = objectiveValue(optimizer.objective, oos.metrics);
    foldResults.push({
      fold,
      evaluated: is.evaluated,
      best: {
        params: is.params,
        isMetrics: is.result.metrics,
        oosMetrics: oos.metrics,
        oosTrades: oos.trades,
        isObjective: is.objective,
        oosObjective,
        oosDailyReturns: oos.dailyReturns,
      },
    });
    pieces.push(pieceOf(oos));
    log(
      `${a.symbol} ${strategy.id} Fold ${fold.index + 1}/${plan.folds.length}: ${is.evaluated} Kandidaten, ` +
        `IS ${is.objective.toFixed(3)} → OOS ${oosObjective.toFixed(3)} (${oos.metrics.trades} Trades, netto ${oos.metrics.netProfit.toFixed(2)})`,
    );
  }

  // Finale Suche auf dem letzten bekannten Fenster (IS + OOS des letzten Folds).
  // Ein Embargo am Ende nur, wenn ein Holdout folgt — sonst würde es ohne
  // Nutzen die jüngsten Bars aus der Live-Parametrisierung streichen.
  const last = plan.folds[plan.folds.length - 1]!;
  const finalWindow = { start: last.isStart, end: last.oosEnd, embargoAtEnd: plan.holdout !== null };
  const finalInclude = [...include, ...foldResults.map((f) => f.best.params)];
  const fin = searchWindow(a, finalWindow, finalInclude, finalWindow.embargoAtEnd);
  trials += fin.evaluated;

  let holdout: WfaResult['holdout'] = null;
  if (plan.holdout) {
    const h = simulateWindow({ ...a, params: fin.params, range: plan.holdout });
    holdout = { start: plan.holdout.start, end: plan.holdout.end, metrics: h.metrics };
  }

  const oos = aggregateOos(pieces, optimizer.objective, a.initialEquity);
  log(
    `${a.symbol} ${strategy.id}: OOS-Median ${oos.objectiveMedian.toFixed(3)}, Folds positiv ${(oos.positiveFoldShare * 100).toFixed(0)} %, ` +
      `${oos.trades} Trades, netto ${oos.netProfit.toFixed(2)}, ${trials} Trials`,
  );

  return {
    strategyId: strategy.id,
    symbol: a.symbol,
    timeframe: a.config.timeframe,
    folds: foldResults,
    oos,
    finalParams: fin.params,
    finalIsMetrics: fin.result.metrics,
    finalWindow,
    trials,
    finalIsDailyReturns: fin.result.dailyReturns,
    finalTrialSharpes: fin.trialSharpes,
    holdout,
    dataRange,
    embargoBars: embargoBarsFor(strategy, strategy.defaults, optimizer),
  };
}

/**
 * Feste Parameter auf den OOS-Fenstern einer Fold-Liste bewerten — für den
 * Re-Score des amtierenden Champions auf DENSELBEN Folds wie der Kandidat.
 */
export function oosScoreOnFolds(
  a: Omit<WindowSimArgs, 'range' | 'costMultiplier'> & { folds: readonly Fold[]; objective: ObjectiveId },
): OosAggregate {
  const pieces = a.folds.map((f) => pieceOf(simulateWindow({ ...a, range: { start: f.oosStart, end: f.oosEnd } })));
  return aggregateOos(pieces, a.objective, a.initialEquity);
}
