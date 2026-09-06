/**
 * Overfitting-Schutz: Gates, die ein Walk-Forward-Ergebnis ALLE bestehen
 * muss, bevor es Champion werden darf. Jedes Gate trägt Wert und Schwelle
 * in den Bericht — eine Ablehnung ist damit nachvollziehbar, nie ein
 * stummes "irgendwas hat nicht gepasst".
 *
 * Stress- und Nachbarschaftstest führen eigene Simulationen aus (injizierter
 * Simulator); der Deflated Sharpe (Bailey/López de Prado) rechnet mit
 * Per-Perioden-Sharpe der OOS-Tagesrenditen und der Zahl aller Trials.
 */
import type { OptimizerConfig } from '../core/config.ts';
import { median, objectiveValue, sampleVariance, type ObjectiveId } from './objective.ts';
import { neighbors } from './search.ts';
import { candidateRange, simulateWindow, type WfaResult, type WindowSimArgs } from './walkForward.ts';

/* ───────────────────────── Injektionspunkt Statistik ───────────────────────── */

/** Spiegel der vereinbarten Funktionen aus src/backtest/metrics.ts. */
export interface MetricsFns {
  sharpeRatio: (returns: readonly number[], periodsPerYear: number) => number | null;
  skewness: (x: readonly number[]) => number;
  /** Nicht-Exzess-Kurtosis (Normalverteilung = 3). */
  kurtosis: (x: readonly number[]) => number;
  probabilisticSharpe: (a: { sr: number; n: number; skew: number; kurt: number; sr0?: number }) => number;
  deflatedSharpe: (a: { sr: number; n: number; skew: number; kurt: number; nTrials: number; varSr: number }) => number;
}

export interface GateResult {
  name: string;
  pass: boolean;
  value: number | null;
  threshold: number | null;
  note: string;
}

/* ───────────────────────── Schwellen (fest, nicht konfigurierbar) ───────────────────────── */

/** Nachbarschaft: Median der ±1-Nachbarn muss mindestens diesen Anteil des Bestwerts halten. */
export const NEIGHBOR_MEDIAN_RATIO = 0.5;
/** Nachbarschaft: Anteil der Nachbarn mit positivem Netto. */
export const NEIGHBOR_POSITIVE_SHARE = 0.6;
/** Deflated Sharpe: Wahrscheinlichkeit, dass der OOS-Sharpe nicht Auswahlrauschen ist. */
export const DSR_THRESHOLD = 0.95;
/** Gebühren dürfen höchstens diesen Anteil des Bruttogewinns fressen. */
export const FEE_SHARE_MAX = 0.5;
/** Unter so vielen OOS-Tagesrenditen sind Schiefe/Kurtosis nicht schätzbar — DSR dann null. */
export const DSR_MIN_RETURNS = 30;
/** Varianz der Fold-Sharpes, wenn weniger als 2 Folds einen Wert liefern. */
export const DSR_VAR_SR_FALLBACK = 0.01;

/* ───────────────────────── Stress: Kosten × Faktor ───────────────────────── */

export interface StressResult {
  netProfit: number;
  objectiveMedian: number;
  trades: number;
  costMultiplier: number;
}

/**
 * Die OOS-Kette der WFA noch einmal mit verteuerten Kosten: Je Fold die dort
 * gewählten Parameter auf demselben OOS-Fenster. Was nur bei Idealkosten
 * verdient, verdient live nichts.
 */
export function stressTest(
  a: Omit<WindowSimArgs, 'range' | 'params' | 'costMultiplier'> & { wfa: WfaResult; costMultiplier: number; objective: ObjectiveId },
): StressResult {
  const objectives: number[] = [];
  let netProfit = 0;
  let trades = 0;
  for (const f of a.wfa.folds) {
    const r = simulateWindow({
      ...a,
      params: f.best.params,
      range: { start: f.fold.oosStart, end: f.fold.oosEnd },
      costMultiplier: a.costMultiplier,
    });
    objectives.push(objectiveValue(a.objective, r.metrics));
    netProfit += r.metrics.netProfit;
    trades += r.metrics.trades;
  }
  return { netProfit, objectiveMedian: median(objectives), trades, costMultiplier: a.costMultiplier };
}

/* ───────────────────────── Nachbarschaft: Plateau statt Spitze ───────────────────────── */

export interface NeighborhoodResult {
  medianObjective: number;
  bestObjective: number;
  positiveShare: number;
  evaluated: number;
}

/**
 * Alle ±1-Gitternachbarn der finalParams auf dem finalen Suchfenster (mit
 * derselben Embargo-Regel). Ein Optimum, das beim kleinsten Schritt
 * einbricht, ist eine Spitze im Rauschen, kein Plateau.
 */
export function neighborhoodTest(
  a: Omit<WindowSimArgs, 'range' | 'params' | 'costMultiplier'> & { wfa: WfaResult; optimizer: OptimizerConfig },
): NeighborhoodResult {
  const { wfa, strategy, optimizer } = a;
  const bestObjective = objectiveValue(optimizer.objective, wfa.finalIsMetrics);
  const nb = neighbors(wfa.finalParams, strategy.paramSpace);
  if (nb.length === 0) {
    // Ein Raum ohne Achsen kann per Parameterwahl nicht überangepasst werden.
    return { medianObjective: bestObjective, bestObjective, positiveShare: 1, evaluated: 0 };
  }
  const objectives: number[] = [];
  let positive = 0;
  for (const params of nb) {
    const range = candidateRange(a.bars, wfa.finalWindow, strategy, params, optimizer, wfa.finalWindow.embargoAtEnd);
    const r = simulateWindow({ ...a, params, range });
    objectives.push(objectiveValue(optimizer.objective, r.metrics));
    if (r.metrics.netProfit > 0) positive++;
  }
  return { medianObjective: median(objectives), bestObjective, positiveShare: positive / nb.length, evaluated: nb.length };
}

/* ───────────────────────── Deflated Sharpe ───────────────────────── */

/**
 * Quelle der Sharpe-Streuung im Deflated Sharpe:
 * - 'fold_sharpes' (Vorgabe laut Spezifikation): Varianz der OOS-Fold-Sharpes.
 *   Achtung: Bei kurzen Folds misst das vor allem Stichprobenrauschen
 *   (≈ 1/Bars je Fold) und treibt den erwarteten Max-Sharpe so hoch, dass
 *   auch starke Strategien durchfallen — Integrationslauf: Sharpe p. a. 12,
 *   10/10 Folds positiv, DSR 0,08.
 * - 'trial_sharpes' (Bailey/López de Prado): Varianz der IS-Sharpes aller
 *   bewerteten Parametersätze — die Streuung der Trials, die das Auswahl-
 *   Maximum tatsächlich erzeugt.
 */
export type DsrVarSource = 'fold_sharpes' | 'trial_sharpes';

export interface DsrResult {
  dsr: number | null;
  psr: number | null;
  /** Per-Perioden-Sharpe der OOS-Tagesrenditen. */
  sr: number | null;
  n: number;
  nTrials: number;
  /** Verwendete Varianz (je nach `varSrSource`). */
  varSr: number;
  varSrSource: DsrVarSource;
  varSrFolds: number;
  varSrTrials: number;
  note: string;
}

/**
 * DSR auf den verketteten OOS-Tagesrenditen: nTrials = alle bewerteten
 * Parametersätze, varSr laut `varSrSource` (Vorgabe: Fold-Sharpes).
 * Alles per Periode (periodsPerYear = 1), wie die Formel es verlangt —
 * annualisierte Werte würden n und Sharpe gegeneinander verfälschen.
 */
export function deflatedSharpeOos(a: { wfa: WfaResult; metricsFns: MetricsFns; varSrSource?: DsrVarSource | undefined }): DsrResult {
  const { wfa, metricsFns } = a;
  const varSrSource: DsrVarSource = a.varSrSource ?? 'fold_sharpes';
  const returns = wfa.oos.dailyReturns;
  const n = returns.length;
  const nTrials = Math.max(1, wfa.trials);
  const foldSrs: number[] = [];
  for (const f of wfa.folds) {
    const s = metricsFns.sharpeRatio(f.best.oosDailyReturns, 1);
    if (s !== null && Number.isFinite(s)) foldSrs.push(s);
  }
  const varOf = (xs: readonly number[]): number => (xs.length >= 2 ? (sampleVariance(xs) ?? DSR_VAR_SR_FALLBACK) : DSR_VAR_SR_FALLBACK);
  const varSrFolds = varOf(foldSrs);
  const varSrTrials = varOf(wfa.trialSharpes);
  const varSr = varSrSource === 'trial_sharpes' ? varSrTrials : varSrFolds;
  const base = { dsr: null, psr: null, sr: null, n, nTrials, varSr, varSrSource, varSrFolds, varSrTrials };
  if (n < DSR_MIN_RETURNS) return { ...base, note: `zu wenige OOS-Tagesrenditen (${n} < ${DSR_MIN_RETURNS})` };
  const sr = metricsFns.sharpeRatio(returns, 1);
  if (sr === null || !Number.isFinite(sr)) return { ...base, note: 'Sharpe der OOS-Renditen nicht berechenbar (Varianz 0?)' };
  const skew = metricsFns.skewness(returns);
  const kurt = metricsFns.kurtosis(returns);
  const dsrRaw = metricsFns.deflatedSharpe({ sr, n, skew, kurt, nTrials, varSr });
  const psrRaw = metricsFns.probabilisticSharpe({ sr, n, skew, kurt });
  const dsr = Number.isFinite(dsrRaw) ? dsrRaw : null;
  const psr = Number.isFinite(psrRaw) ? psrRaw : null;
  const detail =
    `SR/Periode ${sr.toFixed(3)}, n=${n}, Trials=${nTrials}, Schiefe ${skew.toFixed(2)}, Kurtosis ${kurt.toFixed(2)}, ` +
    `varSr=${varSr.toExponential(2)} aus ${varSrSource} (Folds ${varSrFolds.toExponential(2)}, Trials ${varSrTrials.toExponential(2)}), ` +
    `PSR=${psr === null ? '–' : psr.toFixed(3)}`;
  const note = dsr === null ? `DSR nicht berechenbar — ${detail}` : detail;
  return { dsr, psr, sr, n, nTrials, varSr, varSrSource, varSrFolds, varSrTrials, note };
}

/* ───────────────────────── Die Gates ───────────────────────── */

export interface GateInput {
  wfa: WfaResult;
  optimizer: OptimizerConfig;
  stressOos: { netProfit: number; objectiveMedian: number };
  neighborhood: { medianObjective: number; bestObjective: number; positiveShare: number };
  dsr: number | null;
  metricsFns: MetricsFns;
  /** Nur für die Notiz (annualisierter OOS-Sharpe); Aktien 252, Krypto 365. */
  periodsPerYear?: number | undefined;
}

export function robustnessGates(a: GateInput): { pass: boolean; gates: GateResult[] } {
  const { wfa, optimizer } = a;
  const oos = wfa.oos;
  const gates: GateResult[] = [];

  gates.push({
    name: 'oos_trades',
    pass: oos.trades >= optimizer.minOosTrades,
    value: oos.trades,
    threshold: optimizer.minOosTrades,
    note: `${oos.trades} OOS-Trades über ${wfa.folds.length} Folds`,
  });

  gates.push({
    name: 'fold_positive_share',
    pass: oos.positiveFoldShare >= optimizer.minFoldPositiveShare,
    value: oos.positiveFoldShare,
    threshold: optimizer.minFoldPositiveShare,
    note: `${Math.round(oos.positiveFoldShare * wfa.folds.length)} von ${wfa.folds.length} Folds netto positiv`,
  });

  gates.push({
    name: 'oos_net_profit',
    pass: oos.netProfit > 0,
    value: oos.netProfit,
    threshold: 0,
    note: `OOS netto ${oos.netProfit.toFixed(2)} (${oos.netReturnPct.toFixed(2)} %), MaxDD ${oos.maxDrawdownPct.toFixed(2)} %`,
  });

  gates.push({
    name: 'stress_costs',
    pass: a.stressOos.netProfit > 0,
    value: a.stressOos.netProfit,
    threshold: 0,
    note: `OOS netto bei Kosten ×${optimizer.stressCostMultiplier}: ${a.stressOos.netProfit.toFixed(2)}, Objective-Median ${fmt(a.stressOos.objectiveMedian)}`,
  });

  const nbThreshold = NEIGHBOR_MEDIAN_RATIO * a.neighborhood.bestObjective;
  const nbMedianOk = a.neighborhood.medianObjective >= nbThreshold;
  const nbShareOk = a.neighborhood.positiveShare >= NEIGHBOR_POSITIVE_SHARE;
  gates.push({
    name: 'neighborhood_plateau',
    pass: nbMedianOk && nbShareOk,
    value: a.neighborhood.medianObjective,
    threshold: nbThreshold,
    note:
      `Nachbar-Median ${fmt(a.neighborhood.medianObjective)} vs. Bestwert ${fmt(a.neighborhood.bestObjective)} (≥ ${NEIGHBOR_MEDIAN_RATIO}×: ${nbMedianOk ? 'ja' : 'nein'}); ` +
      `${(a.neighborhood.positiveShare * 100).toFixed(0)} % der Nachbarn positiv (≥ ${NEIGHBOR_POSITIVE_SHARE * 100} %: ${nbShareOk ? 'ja' : 'nein'})`,
  });

  const srAnnual = a.metricsFns.sharpeRatio(oos.dailyReturns, a.periodsPerYear ?? 252);
  const srNote = srAnnual === null ? 'Sharpe p. a. nicht berechenbar' : `Sharpe p. a. ${srAnnual.toFixed(2)}`;
  gates.push({
    name: 'deflated_sharpe',
    pass: a.dsr !== null && a.dsr >= DSR_THRESHOLD,
    value: a.dsr,
    threshold: DSR_THRESHOLD,
    note:
      a.dsr === null
        ? `DSR nicht berechenbar (zu wenige Renditen oder Varianz 0) — gilt als durchgefallen; ${srNote}`
        : `DSR ${a.dsr.toFixed(3)} bei ${wfa.trials} Trials, n=${oos.dailyReturns.length}; ${srNote}`,
  });

  gates.push({
    name: 'fee_share',
    pass: oos.feeShare === null || oos.feeShare <= FEE_SHARE_MAX,
    value: oos.feeShare,
    threshold: FEE_SHARE_MAX,
    note: oos.feeShare === null ? 'Gebührenanteil nicht berechenbar (kein Bruttogewinn) — kein Urteil' : `Gebühren fressen ${(oos.feeShare * 100).toFixed(1)} % des Bruttogewinns`,
  });

  return { pass: gates.every((g) => g.pass), gates };
}

function fmt(x: number): string {
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '−∞';
  return x.toFixed(3);
}
