/**
 * Overfitting-Schutz: Gates, die ein Walk-Forward-Ergebnis ALLE bestehen
 * muss, bevor es Champion werden darf. Jedes Gate trägt Wert und Schwelle
 * in den Bericht — eine Ablehnung ist damit nachvollziehbar, nie ein
 * stummes "irgendwas hat nicht gepasst".
 *
 * Zwei statistische Gates mit klarer Arbeitsteilung:
 * - PSR auf OUT-OF-SAMPLE (sr0 = 0): die ehrliche Zahl der Prozedur — die
 *   OOS-Renditen wurden nicht selektiert, also wird nichts deflationiert.
 * - DSR auf IN-SAMPLE (finales Suchfenster): deflationiert die SELEKTIERTE
 *   Zahl um die Zahl der Trials und ihre Streuung (Bailey/López de Prado).
 *   DSR auf OOS wäre doppelt konservativ und nicht lehrbuchgemäß.
 */
import type { OptimizerConfig } from '../core/config.ts';
import { median, objectiveValue, sampleVariance, type ObjectiveId } from './objective.ts';
import { neighbors } from './search.ts';
import { candidateRange, korbVon, simulateWindow, zeitachseVon, type WfaResult, type WindowSimArgs } from './walkForward.ts';

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
/** Deflated Sharpe (In-Sample, finales Suchfenster): Wahrscheinlichkeit, dass die selektierte Zahl nicht Auswahlrauschen ist. */
export const DSR_THRESHOLD = 0.95;
/** Probabilistic Sharpe (Out-of-Sample, sr0 = 0): Vorgabe-Schwelle, wenn `optimizer.minPsrOos` fehlt. */
export const PSR_THRESHOLD = 0.9;

/**
 * Optionale Optimierer-Felder, die das Config-Schema erst nachzieht. Der Cast
 * hält den Typecheck unabhängig vom Schema-Stand grün; die Vorgaben sind
 * die abgestimmten Defaults (PSR ≥ 0,9; DSR-IS nur informativ).
 */
export function gateOptions(optimizer: OptimizerConfig): { minPsrOos: number; dsrIsGate: boolean } {
  const o = optimizer as { minPsrOos?: number; dsrIsGate?: boolean };
  return { minPsrOos: o.minPsrOos ?? PSR_THRESHOLD, dsrIsGate: o.dsrIsGate ?? false };
}
/** Gebühren dürfen höchstens diesen Anteil des Bruttogewinns fressen. */
export const FEE_SHARE_MAX = 0.5;
/** Unter so vielen Tagesrenditen sind Schiefe/Kurtosis nicht schätzbar — PSR/DSR dann null (⇒ Gate fällt). */
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
  // Embargo misst in Bars — bei einem Korb auf der vereinigten Zeitachse.
  const achse = zeitachseVon(korbVon(a.symbol, a.bars));
  for (const params of nb) {
    const range = candidateRange(achse, wfa.finalWindow, strategy, params, optimizer, wfa.finalWindow.embargoAtEnd);
    const r = simulateWindow({ ...a, params, range });
    objectives.push(objectiveValue(optimizer.objective, r.metrics));
    if (r.metrics.netProfit > 0) positive++;
  }
  return { medianObjective: median(objectives), bestObjective, positiveShare: positive / nb.length, evaluated: nb.length };
}

/* ───────────────────────── Deflated Sharpe (In-Sample) ───────────────────────── */

/**
 * Quelle der Sharpe-Streuung im Deflated Sharpe:
 * - 'trial_sharpes' (Vorgabe, Lehrbuch): Varianz der IS-Sharpes aller
 *   Kandidaten der finalen Suche — die Streuung der Trials, aus denen das
 *   Auswahl-Maximum stammt.
 * - 'fold_sharpes': Varianz der OOS-Fold-Sharpes. Misst bei kurzen Folds
 *   vor allem Stichprobenrauschen (≈ 1/Bars je Fold) — Integrationslauf:
 *   Sharpe p. a. 12, 10/10 Folds positiv, DSR 0,08. Nur noch als Option.
 */
export type DsrVarSource = 'trial_sharpes' | 'fold_sharpes';

export interface DsrResult {
  dsr: number | null;
  /** Per-Perioden-Sharpe der IS-Tagesrenditen von finalParams. */
  sr: number | null;
  /** Anzahl IS-Tagesrenditen. */
  n: number;
  /** Trials über alle Folds + finale Suche (Vorgabe für `dsr`). */
  nTrials: number;
  /** Trials nur der finalen Suche (Basis von `dsrFinalOnly`). */
  nTrialsFinal: number;
  /** DSR mit nTrials = nur finale Suche — die mildere, zur varSr-Quelle passende Variante. */
  dsrFinalOnly: number | null;
  /** Verwendete Varianz (je nach `varSrSource`). */
  varSr: number;
  varSrSource: DsrVarSource;
  varSrTrials: number;
  varSrFolds: number;
  skew: number | null;
  kurt: number | null;
  note: string;
}

function varOf(xs: readonly number[]): number {
  return xs.length >= 2 ? (sampleVariance(xs) ?? DSR_VAR_SR_FALLBACK) : DSR_VAR_SR_FALLBACK;
}

/**
 * DSR der selektierten IS-Zahl: Tagesrenditen von finalParams auf dem
 * finalen Suchfenster, nTrials = alle bewerteten Parametersätze der WFA,
 * varSr laut `varSrSource`. Alles per Periode (periodsPerYear = 1), wie die
 * Formel es verlangt — annualisierte Werte würden n und Sharpe verfälschen.
 */
export function deflatedSharpeIs(a: { wfa: WfaResult; metricsFns: MetricsFns; varSrSource?: DsrVarSource | undefined }): DsrResult {
  const { wfa, metricsFns } = a;
  const varSrSource: DsrVarSource = a.varSrSource ?? 'trial_sharpes';
  const returns = wfa.finalIsDailyReturns;
  const n = returns.length;
  const nTrials = Math.max(1, wfa.trials);
  const nTrialsFinal = Math.max(1, wfa.finalEvaluated);
  const foldSrs: number[] = [];
  for (const f of wfa.folds) {
    const s = metricsFns.sharpeRatio(f.best.oosDailyReturns, 1);
    if (s !== null && Number.isFinite(s)) foldSrs.push(s);
  }
  const varSrTrials = varOf(wfa.finalTrialSharpes);
  const varSrFolds = varOf(foldSrs);
  const varSr = varSrSource === 'trial_sharpes' ? varSrTrials : varSrFolds;
  const base = { dsr: null, dsrFinalOnly: null, sr: null, n, nTrials, nTrialsFinal, varSr, varSrSource, varSrTrials, varSrFolds, skew: null, kurt: null };
  if (n < DSR_MIN_RETURNS) return { ...base, note: `zu wenige IS-Tagesrenditen (${n} < ${DSR_MIN_RETURNS})` };
  const sr = metricsFns.sharpeRatio(returns, 1);
  if (sr === null || !Number.isFinite(sr)) return { ...base, note: 'Sharpe der IS-Renditen nicht berechenbar (Varianz 0?)' };
  const skew = metricsFns.skewness(returns);
  const kurt = metricsFns.kurtosis(returns);
  const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);
  const dsr = fin(metricsFns.deflatedSharpe({ sr, n, skew, kurt, nTrials, varSr }));
  // nTrials zählt alle Folds, varSr stammt nur aus der finalen Suche ⇒ überdeflationiert; die
  // passende Variante mit nTrials = Samples der finalen Suche steht daneben.
  const dsrFinalOnly = fin(metricsFns.deflatedSharpe({ sr, n, skew, kurt, nTrials: nTrialsFinal, varSr }));
  const detail =
    `IS-SR/Periode ${sr.toFixed(3)}, n=${n}, Trials=${nTrials} (alle Folds), Schiefe ${skew.toFixed(2)}, Kurtosis ${kurt.toFixed(2)}, ` +
    `varSr=${varSr.toExponential(2)} aus ${varSrSource} (Trials ${varSrTrials.toExponential(2)}, Folds ${varSrFolds.toExponential(2)}); ` +
    `DSR bei nTrials=${nTrialsFinal} (nur finale Suche): ${dsrFinalOnly === null ? '–' : dsrFinalOnly.toFixed(3)}`;
  return {
    dsr,
    dsrFinalOnly,
    sr,
    n,
    nTrials,
    nTrialsFinal,
    varSr,
    varSrSource,
    varSrTrials,
    varSrFolds,
    skew,
    kurt,
    note: dsr === null ? `DSR nicht berechenbar — ${detail}` : `DSR ${dsr.toFixed(3)}; ${detail}`,
  };
}

/* ───────────────────────── Probabilistic Sharpe (Out-of-Sample) ───────────────────────── */

export interface PsrResult {
  psr: number | null;
  /** Per-Perioden-Sharpe der verketteten OOS-Tagesrenditen. */
  sr: number | null;
  /** Anzahl OOS-Tagesrenditen. */
  n: number;
  skew: number | null;
  kurt: number | null;
  note: string;
}

/** PSR der OOS-Kette mit sr0 = 0: Wahrscheinlichkeit, dass der wahre OOS-Sharpe positiv ist. */
export function probabilisticSharpeOos(a: { wfa: WfaResult; metricsFns: MetricsFns }): PsrResult {
  const { wfa, metricsFns } = a;
  const returns = wfa.oos.dailyReturns;
  const n = returns.length;
  const base = { psr: null, sr: null, n, skew: null, kurt: null };
  if (n < DSR_MIN_RETURNS) return { ...base, note: `zu wenige OOS-Tagesrenditen (${n} < ${DSR_MIN_RETURNS})` };
  const sr = metricsFns.sharpeRatio(returns, 1);
  if (sr === null || !Number.isFinite(sr)) return { ...base, note: 'Sharpe der OOS-Renditen nicht berechenbar (Varianz 0?)' };
  const skew = metricsFns.skewness(returns);
  const kurt = metricsFns.kurtosis(returns);
  const raw = metricsFns.probabilisticSharpe({ sr, n, skew, kurt });
  const psr = Number.isFinite(raw) ? raw : null;
  const detail = `OOS-SR/Periode ${sr.toFixed(3)}, n=${n}, Schiefe ${skew.toFixed(2)}, Kurtosis ${kurt.toFixed(2)}, sr0=0`;
  return { psr, sr, n, skew, kurt, note: psr === null ? `PSR nicht berechenbar — ${detail}` : `PSR ${psr.toFixed(3)}; ${detail}` };
}

/* ───────────────────────── Die Gates ───────────────────────── */

export interface GateInput {
  wfa: WfaResult;
  optimizer: OptimizerConfig;
  stressOos: { netProfit: number; objectiveMedian: number };
  neighborhood: { medianObjective: number; bestObjective: number; positiveShare: number };
  /** Deflated Sharpe der selektierten IS-Zahl (deflatedSharpeIs). */
  dsr: DsrResult;
  /** Probabilistic Sharpe der OOS-Kette (probabilisticSharpeOos). */
  psr: PsrResult;
  metricsFns: MetricsFns;
  /** Nur für die Notiz (annualisierter OOS-Sharpe); Aktien 252, Krypto 365. */
  periodsPerYear?: number | undefined;
  /**
   * Amtsinhaber-Modus: bewertet wird nur sauberes OOS (Folds nach fitEnd) — die
   * Trade-Schwelle gilt anteilig, der DSR ist ohne Suche nicht anwendbar.
   */
  incumbent?: { cleanFolds: number; totalFolds: number } | undefined;
}

export function robustnessGates(a: GateInput): { pass: boolean; gates: GateResult[] } {
  const { wfa, optimizer } = a;
  const oos = wfa.oos;
  const gates: GateResult[] = [];

  const inc = a.incumbent;
  const minTrades = inc ? Math.max(1, Math.ceil((optimizer.minOosTrades * inc.cleanFolds) / Math.max(1, inc.totalFolds))) : optimizer.minOosTrades;
  gates.push({
    name: 'oos_trades',
    pass: oos.trades >= minTrades,
    value: oos.trades,
    threshold: minTrades,
    note: inc
      ? `${oos.trades} OOS-Trades über ${inc.cleanFolds} saubere von ${inc.totalFolds} Folds (Schwelle anteilig ${minTrades} von ${optimizer.minOosTrades})`
      : `${oos.trades} OOS-Trades über ${wfa.folds.length} Folds`,
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

  // Konzentration: Trägt EIN Fold das ganze Ergebnis? Ein Gewinn, der an
  // einem einzelnen Fenster hängt, ist ein Ereignis und keine Kante — und
  // genau so ist der TSLA-Champion vom 07.09. durch alle Gates gekommen
  // (96 % des Nettos aus einem Monat, Holdout danach negativ).
  const foldNetto = wfa.folds.map((f) => f.best.oosMetrics.netProfit);
  const summeNetto = foldNetto.reduce((sum, x) => sum + x, 0);
  const groesster = foldNetto.length > 0 ? Math.max(...foldNetto) : 0;
  // Nur bei positivem Gesamtergebnis aussagekräftig; ist es das nicht,
  // fällt der Kandidat ohnehin schon an `oos_net_profit`.
  const konzentration = summeNetto > 0 ? groesster / summeNetto : 0;
  gates.push({
    name: 'fold_concentration',
    pass: summeNetto <= 0 || konzentration <= optimizer.maxFoldNetShare,
    value: konzentration,
    threshold: optimizer.maxFoldNetShare,
    note:
      summeNetto <= 0
        ? 'OOS-Netto nicht positiv — Konzentration nicht aussagekräftig (siehe oos_net_profit)'
        : `bester Fold trägt ${(konzentration * 100).toFixed(0)} % des OOS-Nettos ` +
          `(${groesster.toFixed(2)} von ${summeNetto.toFixed(2)} über ${foldNetto.length} Folds); ` +
          `ohne ihn blieben ${(summeNetto - groesster).toFixed(2)}`,
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

  const { minPsrOos, dsrIsGate } = gateOptions(optimizer);
  const srAnnual = a.metricsFns.sharpeRatio(oos.dailyReturns, a.periodsPerYear ?? 252);
  const srNote = srAnnual === null ? 'Sharpe p. a. nicht berechenbar' : `OOS-Sharpe p. a. ${srAnnual.toFixed(2)}`;
  gates.push({
    name: 'probabilistic_sharpe_oos',
    pass: a.psr.psr !== null && a.psr.psr >= minPsrOos,
    value: a.psr.psr,
    threshold: minPsrOos,
    note: a.psr.psr === null ? `PSR nicht berechenbar — gilt als durchgefallen (${a.psr.note}); ${srNote}` : `${a.psr.note}; ${srNote}`,
  });

  // Die OOS-Kette ist die selektionsfreie Evidenz; der DSR beantwortet die
  // In-Sample-Frage und bestraft breite Gitter mit toten Regionen doppelt.
  // Deshalb blockiert er nur auf ausdrücklichen Wunsch — der Wert bleibt sichtbar.
  const dsrOk = a.dsr.dsr !== null && a.dsr.dsr >= DSR_THRESHOLD;
  const dsrNote = a.dsr.dsr === null ? `DSR nicht berechenbar (${a.dsr.note})` : a.dsr.note;
  gates.push({
    name: 'deflated_sharpe_is',
    pass: inc || !dsrIsGate ? true : dsrOk,
    value: a.dsr.dsr,
    threshold: DSR_THRESHOLD,
    note: inc
      ? 'nicht anwendbar (Amtsinhaber: feste Parameter, keine Suche, keine Trials)'
      : dsrIsGate
        ? dsrOk
          ? dsrNote
          : `${dsrNote} — gilt als durchgefallen`
        : `informativ (dsrIsGate=false): ${dsrNote}${dsrOk ? '' : ' — würde als Gate durchfallen'}`,
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
