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
 *
 * `sr0 = 0` heißt seit dem 13.09.2026 „null ÜBERSCHUSS über dem risikolosen
 * Zins", sobald eine Zinsreihe übergeben wird (`GateRiskFree`,
 * Vorregistrierung `docs/wissen/vorregistrierung/2026-09-13-sharpe-gegen-zins.md`).
 * Ohne Zinsreihe bleibt es „null" — und jede betroffene Notiz sagt, welches
 * von beiden gerechnet wurde. Ein stiller Rückfall wäre der Fehler, den die
 * Zinsrechnung behebt, noch einmal.
 *
 * ── EIN Maßstab für ALLE Gates (13.09.2026, zweite Änderung) ─────────────
 *
 * Vorregistrierung `2026-09-13-gates-auf-ueberschuss.md`. Die Zinsrechnung
 * blieb zunächst auf die zwei Sharpe-Gates beschränkt; seit die Treasury
 * brachliegende Kasse in den Geldmarkt legt, war das ein Messfehler: Das
 * KONTO verdient den kurzen Zins, auch wenn die Strategie nichts tut. In
 * Lauf #48 zählten bei `mean_reversion` drei Quartale OHNE EINEN TRADE als
 * positive Folds (+95,93 / +134,31 / +227,50 $), `fold_positive_share` stand
 * bei 16 von 16 — während `probabilistic_sharpe_oos` und `beats_market`, die
 * schon auf Überschuss rechneten, bei jedem Kandidaten durchfielen.
 *
 * Seitdem gilt: **Jede Gate-Kennzahl misst den Überschuss über dem Zins.**
 * Die Geld-Kennzahlen (`fold_positive_share`, `oos_net_profit`,
 * `fold_concentration`, `stress_costs`, der Anteil positiver Nachbarn und
 * die Basis-Gruppe) entstehen aus derselben Reihe `r − r_f`, aus der Sharpe
 * und PSR schon rechnen — nur aufgezinst statt gemittelt
 * (`ueberschussKennzahlen`). Ohne Zinsreihe bleibt alles roh wie bisher, und
 * jede betroffene Notiz sagt, was gerechnet wurde.
 *
 * Drei Größen bleiben ausdrücklich ROH, jede mit Grund:
 *  - `maxDrawdownPct` (und damit `exposureNormMaxDD`): Ein Drawdown ist eine
 *    Kapitalfrage — „wie viel vom Konto war weg" —, und genau die messen die
 *    Notbremsen live. Eine Überschuss-Kurve fällt in jeder flachen Phase,
 *    obwohl das Konto unverändert dasteht; das wäre das Spiegelbild des
 *    behobenen Fehlers. Sein Maßstab (Korb liegenlassen) ist ebenfalls eine
 *    rohe Kursgröße — beide Seiten roh ist konsistent, eine Seite wäre die
 *    verbotene Mischung.
 *  - `objectiveValue` (Score, OOS-Median, Nachbar-Median): das SUCHkriterium,
 *    kein Gate. Gegen dieses Artefakt ist es ohnehin immun — ein Fenster mit
 *    `trades === 0` liefert −∞.
 *  - `deflated_sharpe_is`: deflationiert eine AUSWAHL gegen Auswahlrauschen;
 *    so festgelegt in der Vorregistrierung vom 13.09.2026.
 *
 * `oos_trades` und `fee_share` sind vom Parken per Bauart unberührt: Sie
 * zählen TRADES, und eine Treasury-Umschichtung ist keiner (risk/parken.ts).
 */
import { ROHES_NETTO_NOTE, excessReturns, riskFreeFuerLauf, ueberschussKennzahlen, type RiskFreeSeries } from '../backtest/metrics.ts';
import type { AssetClass, EquityPoint } from '../core/types.ts';
import type { BasisConfig, OptimizerConfig } from '../core/config.ts';
import { median, objectiveValue, sampleVariance, type ObjectiveId } from './objective.ts';
import { neighbors, wirksamerSuchraum } from './search.ts';
import { candidateRange, korbVon, simulateWindow, zeitachseVon, type BasisKennzahlen, type WfaResult, type WindowSimArgs } from './walkForward.ts';

/* ───────────────────────── Injektionspunkt Statistik ───────────────────────── */

/**
 * Spiegel der vereinbarten Funktionen aus src/backtest/metrics.ts.
 *
 * Bewusst OHNE den `riskFree`-Parameter von `sharpeRatio`: Die Überschuss-
 * reihe wird hier gebildet (`excessReturns`) und fertig hineingereicht. Eine
 * injizierte Implementierung, die einen dritten Parameter ignoriert, würde
 * sonst still gegen null rechnen, während die Notiz „Überschuss" behauptet —
 * genau die Sorte stiller Rückfall, gegen die diese Änderung gebaut ist.
 */
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

/* ───────────────────────── Risikoloser Zins für die Gates ───────────────────────── */

/**
 * Der risikolose Satz, AUSGERICHTET auf die jeweilige Renditereihe — nicht
 * die Reihe selbst, sondern ihr Spiegelbild Tag für Tag. Gebaut wird sie in
 * `src/backtest/metrics.ts` (`riskFreeFromBars` + `alignRiskFree` auf der
 * `tagesachse` der Equity-Kurve); hier kommt sie fertig an, damit dieses
 * Modul keine Bars kennen muss.
 *
 * Die Längen werden geprüft, nicht geglaubt: Passt eine nicht, rechnen BEIDE
 * Seiten ohne Zins, und die Notiz sagt warum. Eine Rechnung, in der die
 * Strategie den Zins abgezogen bekommt und der Markt nicht (oder umgekehrt),
 * wäre schlimmer als die alte Rechnung gegen null.
 */
export interface GateRiskFree {
  /** Sätze je Periode, ausgerichtet auf `wfa.oos.dailyReturns` — gleiche Tage, gleiche Länge. */
  strategie: readonly number[];
  /** Sätze je Periode, ausgerichtet auf `markt.dailyReturns`. Fehlt sie, während es eine Markt-Latte gibt, rechnen beide Seiten ohne Zins. */
  markt?: readonly number[] | undefined;
  /** Woher der Satz kommt, wörtlich für die Notiz: „BIL über dieselben Tage (987 von 987 belegt)". */
  quelle: string;
}

/** Ohne konfigurierten Geldmarkt: der Satz, der in jeder betroffenen Notiz steht. */
export const OHNE_ZINS_NOTE = 'kein Geldmarkt-Symbol konfiguriert — gegen null gerechnet';

/* ───────────────────────── Überschuss-Netto eines Fensters ───────────────────────── */

/**
 * Wie weit das aufgezinste rohe Netto von der Kennzahl des Fensters abweichen
 * darf, bevor die Ausrichtung als falsch gilt (Anteil des Startkapitals).
 * Gleitkomma über einige hundert Multiplikationen liegt bei ~1e-13 relativ —
 * 1e-6 ist großzügig und fängt trotzdem jede echte Verschiebung.
 */
export const UEBERSCHUSS_TOLERANZ = 1e-6;

/**
 * Überschuss-Netto EINES simulierten Fensters, taggenau gegen die Zinsreihe.
 *
 * Die Tagesachse kommt aus der Equity-Kurve desselben Laufs (`tagesachse`) —
 * je Tagesrendite genau ein Tagesschlüssel. Passt das nicht, oder deckt die
 * Zinsreihe zu wenige Tage, gibt es einen FEHLER und keine Zahl: Ein um einen
 * Tag verrutschter Zins wäre ein neuer, subtilerer Messfehler als der
 * behobene, und er sähe in jeder Kennzahl plausibel aus.
 *
 * Zusätzlich wird die Ausrichtung gegen die Kennzahl des Simulators geprüft,
 * nicht geglaubt: `E₀ · (Π(1+r) − 1)` MUSS `metrics.netProfit` treffen. Tut
 * es das nicht, gehört die Renditereihe nicht zu diesem Fenster.
 */
export function ueberschussNettoVon(a: {
  result: { dailyReturns: readonly number[]; equity: readonly EquityPoint[]; metrics: { netProfit: number } };
  riskFree: RiskFreeSeries;
  assetClass: AssetClass;
  initialEquity: number;
}): { netProfit: number; quelle: string } | { fehler: string } {
  const { result, initialEquity } = a;
  const al = riskFreeFuerLauf({ dailyReturns: result.dailyReturns, equity: result.equity, riskFree: a.riskFree, assetClass: a.assetClass });
  if ('fehler' in al) return al;
  const u = ueberschussKennzahlen({ returns: result.dailyReturns, riskFree: al.rates, initialEquity });
  const toleranz = UEBERSCHUSS_TOLERANZ * Math.max(1, Math.abs(initialEquity));
  if (Math.abs(u.rohNetProfit - result.metrics.netProfit) > toleranz) {
    return { fehler: `Renditereihe passt nicht zum Netto des Fensters (aufgezinst ${u.rohNetProfit.toFixed(2)}, gemessen ${result.metrics.netProfit.toFixed(2)})` };
  }
  return { netProfit: u.netProfit, quelle: al.quelle };
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
  /** Rohes Netto der Stress-Kette — Bericht; das Gate liest `ueberschussNetProfit`, wenn es eins gibt. */
  netProfit: number;
  /**
   * Überschuss-Netto derselben Kette (Σ je Fold, gegen den Zins gerechnet);
   * null ohne Zinsreihe oder wenn die Ausrichtung scheiterte. DAS ist der
   * Wert des Gates `stress_costs`, sobald er da ist: Sonst bestünde eine
   * Strategie das Gate mit dem Zinsertrag auf brachliegender Kasse — bei
   * ×1,5-Kosten sogar besonders leicht, weil sie dafür nichts handeln muss.
   */
  ueberschussNetProfit: number | null;
  objectiveMedian: number;
  trades: number;
  costMultiplier: number;
  /** Wörtlich für die Notiz des Gates: Zinsquelle oder Grund, warum roh gerechnet wurde. */
  zins: string;
}

/**
 * Die OOS-Kette der WFA noch einmal mit verteuerten Kosten: Je Fold die dort
 * gewählten Parameter auf demselben OOS-Fenster. Was nur bei Idealkosten
 * verdient, verdient live nichts.
 *
 * Mit `riskFree` wird je Fold zusätzlich das ÜBERSCHUSS-Netto gerechnet —
 * aus der Equity-Kurve DIESES Stress-Laufs, nicht aus der des Normallaufs:
 * Die Kosten ändern die Kurve, und eine fremde Achse wäre genau die Sorte
 * plausibel aussehender Falschzahl, gegen die diese Änderung gebaut ist.
 * Scheitert die Ausrichtung auch nur eines Folds, gibt es KEINE
 * Überschusszahl (statt einer halben Kette), und der Grund steht in `zins`.
 */
export function stressTest(
  a: Omit<WindowSimArgs, 'range' | 'params' | 'costMultiplier'> & {
    wfa: WfaResult;
    costMultiplier: number;
    objective: ObjectiveId;
    /** Zinsreihe des Laufs (`optimizer.riskFreeSymbol`); ohne sie bleibt das Gate roh wie bisher. */
    riskFree?: RiskFreeSeries | undefined;
  },
): StressResult {
  const objectives: number[] = [];
  let netProfit = 0;
  let trades = 0;
  let ueberschuss: number | null = a.riskFree ? 0 : null;
  let zins = a.riskFree ? `Maßstab: Überschuss über ${a.riskFree.symbol}` : ROHES_NETTO_NOTE;
  for (const f of a.wfa.folds) {
    const r = simulateWindow({
      ...a,
      params: f.best.params,
      range: { start: f.fold.oosStart, end: f.fold.oosEnd },
      costMultiplier: a.costMultiplier,
      membershipAt: f.fold.oosStart,
    });
    objectives.push(objectiveValue(a.objective, r.metrics));
    netProfit += r.metrics.netProfit;
    trades += r.metrics.trades;
    if (a.riskFree && ueberschuss !== null) {
      const u = ueberschussNettoVon({ result: r, riskFree: a.riskFree, assetClass: a.config.assetClass, initialEquity: a.initialEquity });
      if ('fehler' in u) {
        ueberschuss = null;
        zins = `Maßstab: rohes Netto — Zins nicht auf den Stress-Lauf ausrichtbar (Fold ${f.fold.index + 1}: ${u.fehler})`;
      } else ueberschuss += u.netProfit;
    }
  }
  return { netProfit, ueberschussNetProfit: ueberschuss, objectiveMedian: median(objectives), trades, costMultiplier: a.costMultiplier, zins };
}

/* ───────────────────────── Nachbarschaft: Plateau statt Spitze ───────────────────────── */

export interface NeighborhoodResult {
  medianObjective: number;
  bestObjective: number;
  /** Anteil Nachbarn mit positivem Netto — mit Zinsreihe: mit positivem ÜBERSCHUSS-Netto. */
  positiveShare: number;
  evaluated: number;
  /** true, wenn `positiveShare` auf Überschuss-Netto zählt. */
  ueberschuss: boolean;
  /** Wörtlich für die Notiz des Gates. */
  zins: string;
}

/**
 * Alle ±1-Gitternachbarn der finalParams auf dem finalen Suchfenster (mit
 * derselben Embargo-Regel). Ein Optimum, das beim kleinsten Schritt
 * einbricht, ist eine Spitze im Rauschen, kein Plateau.
 *
 * Der Anteil positiver Nachbarn zählt mit `riskFree` das ÜBERSCHUSS-Netto:
 * Ein Nachbar, der gar nicht handelt, hat mit geparkter Kasse ein positives
 * rohes Netto und zählte sonst als Beleg für ein Plateau — das Plateau wäre
 * dann der Zins. Der Median des Objectives bleibt roh: Er ist das
 * Suchkriterium (kein Gate) und liefert für `trades === 0` ohnehin −∞.
 */
export function neighborhoodTest(
  a: Omit<WindowSimArgs, 'range' | 'params' | 'costMultiplier'> & {
    wfa: WfaResult;
    optimizer: OptimizerConfig;
    /** Zinsreihe des Laufs; ohne sie zählt der Anteil wie bisher rohes Netto. */
    riskFree?: RiskFreeSeries | undefined;
  },
): NeighborhoodResult {
  const { wfa, strategy, optimizer } = a;
  const bestObjective = objectiveValue(optimizer.objective, wfa.finalIsMetrics);
  let mitZins = a.riskFree !== undefined;
  let zins = a.riskFree ? `Maßstab: Überschuss über ${a.riskFree.symbol}` : ROHES_NETTO_NOTE;
  // Dieselbe Regel wie in der Suche: Bei gesperrtem Short ist `allowShort`
  // keine Achse — ihr Nachbar hätte exakt den Bestwert und zählte als Plateau.
  const nb = neighbors(wfa.finalParams, wirksamerSuchraum(strategy.paramSpace, a.config.risk.allowShort).space);
  if (nb.length === 0) {
    // Ein Raum ohne Achsen kann per Parameterwahl nicht überangepasst werden.
    return { medianObjective: bestObjective, bestObjective, positiveShare: 1, evaluated: 0, ueberschuss: mitZins, zins };
  }
  const objectives: number[] = [];
  // BEIDE Reihen werden mitgeführt, damit ein Rückfall mitten in der Schleife
  // keine halb umgestellte Zählung hinterlässt (die ersten Nachbarn
  // Überschuss, die späteren roh) — am Ende zählt genau eine von beiden.
  const roh: number[] = [];
  const ueber: number[] = [];
  // Embargo misst in Bars — bei einem Korb auf der vereinigten Zeitachse.
  const achse = zeitachseVon(korbVon(a.symbol, a.bars));
  for (const params of nb) {
    const range = candidateRange(achse, wfa.finalWindow, strategy, params, optimizer, wfa.finalWindow.embargoAtEnd);
    const r = simulateWindow({ ...a, params, range, membershipAt: wfa.finalWindow.end });
    objectives.push(objectiveValue(optimizer.objective, r.metrics));
    roh.push(r.metrics.netProfit);
    if (a.riskFree && mitZins) {
      const u = ueberschussNettoVon({ result: r, riskFree: a.riskFree, assetClass: a.config.assetClass, initialEquity: a.initialEquity });
      if ('fehler' in u) {
        mitZins = false;
        zins = `Maßstab: rohes Netto — Zins nicht auf die Nachbarschaft ausrichtbar (${u.fehler})`;
      } else ueber.push(u.netProfit);
    }
  }
  const gezaehlt = mitZins ? ueber : roh;
  const positive = gezaehlt.filter((x) => x > 0).length;
  return { medianObjective: median(objectives), bestObjective, positiveShare: positive / nb.length, evaluated: nb.length, ueberschuss: mitZins, zins };
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
  /** Per-Perioden-Sharpe der verketteten OOS-Tagesrenditen (mit Zins: der ÜBERSCHUSSreihe). */
  sr: number | null;
  /** Anzahl OOS-Tagesrenditen. */
  n: number;
  skew: number | null;
  kurt: number | null;
  note: string;
  /**
   * true, wenn gegen den risikolosen Zins gerechnet wurde. Optional, damit
   * Aufrufer ohne Zinsreihe unverändert gültig bleiben — `robustnessGates`
   * liest es und VERWIRFT den Zins auch für `beats_market`, wenn der PSR ohne
   * ihn gerechnet wurde. Zwei Gates desselben Berichts mit verschiedenen
   * Maßstäben wären schlimmer als beide ohne.
   */
  ueberschuss?: boolean | undefined;
}

/**
 * PSR der OOS-Kette mit sr0 = 0: Wahrscheinlichkeit, dass der wahre OOS-Sharpe
 * positiv ist — mit `riskFree`, dass er ÜBER DEM ZINS positiv ist. Sharpe,
 * Schiefe und Kurtosis stammen dann alle drei aus der Überschussreihe, nie
 * gemischt.
 */
export function probabilisticSharpeOos(a: { wfa: WfaResult; metricsFns: MetricsFns; riskFree?: GateRiskFree | undefined }): PsrResult {
  const { wfa, metricsFns } = a;
  const roh = wfa.oos.dailyReturns;
  const n = roh.length;
  // Die Länge entscheidet, nicht die Absicht: Eine Zinsreihe, die nicht auf
  // dieselben Tage passt, wird verworfen — und das steht in der Notiz.
  const mitZins = a.riskFree !== undefined && a.riskFree.strategie.length === n;
  const zins =
    a.riskFree === undefined
      ? `Zins: ${OHNE_ZINS_NOTE}`
      : mitZins
        ? `Zins: ${a.riskFree.quelle}`
        : `Zins: Reihe nicht auf die OOS-Kette ausgerichtet (${n} Renditen, ${a.riskFree.strategie.length} Sätze) — gegen null gerechnet`;
  const returns = mitZins ? excessReturns(roh, a.riskFree!.strategie) : roh;
  const base = { psr: null, sr: null, n, skew: null, kurt: null, ueberschuss: mitZins };
  if (n < DSR_MIN_RETURNS) return { ...base, note: `zu wenige OOS-Tagesrenditen (${n} < ${DSR_MIN_RETURNS}); ${zins}` };
  const sr = metricsFns.sharpeRatio(returns, 1);
  if (sr === null || !Number.isFinite(sr)) return { ...base, note: `Sharpe der OOS-Renditen nicht berechenbar (Varianz 0?); ${zins}` };
  const skew = metricsFns.skewness(returns);
  const kurt = metricsFns.kurtosis(returns);
  const raw = metricsFns.probabilisticSharpe({ sr, n, skew, kurt });
  const psr = Number.isFinite(raw) ? raw : null;
  const detail =
    `OOS-SR/Periode ${sr.toFixed(3)}${mitZins ? ' (Überschuss)' : ''}, n=${n}, Schiefe ${skew.toFixed(2)}, Kurtosis ${kurt.toFixed(2)}, ` +
    `sr0=0${mitZins ? ' über dem Zins' : ''}; ${zins}`;
  return { psr, sr, n, skew, kurt, ueberschuss: mitZins, note: psr === null ? `PSR nicht berechenbar — ${detail}` : `PSR ${psr.toFixed(3)}; ${detail}` };
}

/* ───────────────────────── Überschuss der OOS-Kette (je Fold) ───────────────────────── */

export interface UeberschussKette {
  /** Überschuss-Netto je Fold, in der Reihenfolge von `wfa.folds`. */
  folds: number[];
  /** Σ über alle Folds — der Wert des Gates `oos_net_profit`. */
  netProfit: number;
  /** Anteil Folds mit Überschuss-Netto > 0 — der Wert des Gates `fold_positive_share`. */
  positiveShare: number;
}

/**
 * Die OOS-Kette Fold für Fold im Überschuss.
 *
 * Die Zinsreihe kommt bereits auf die GANZE Kette ausgerichtet an
 * (`GateRiskFree.strategie`); geschnitten wird sie hier nach den Längen der
 * Fold-Renditen. Das ist zulässig, WEIL `wfa.oos.dailyReturns` per Bauart die
 * Verkettung genau dieser Reihen ist (`aggregateOos`) — und weil es das ist,
 * wird es geprüft und nicht geglaubt: Längen, Werte und das aufgezinste rohe
 * Netto je Fold gegen `oosMetrics.netProfit`. Stimmt eine Probe nicht, gibt
 * es KEINE Überschusszahl; die Gates rechnen dann roh und sagen den Grund.
 *
 * Jeder Fold startet mit `initialEquity` — dieselbe Konvention wie
 * `OosAggregate.netProfit` (Summe der Fold-Nettos, kein Zinseszins über die
 * Kette). Nur so bleiben Wert und Schwelle des Gates vergleichbar.
 */
export function ueberschussKette(a: { wfa: WfaResult; riskFree: readonly number[]; initialEquity: number }): UeberschussKette | { fehler: string } {
  const folds = a.wfa.folds;
  const kette = a.wfa.oos.dailyReturns;
  const laengen = folds.map((f) => f.best.oosDailyReturns.length);
  const summe = laengen.reduce((s, x) => s + x, 0);
  if (summe !== kette.length) return { fehler: `Fold-Renditen ergeben nicht die OOS-Kette (${summe} aus ${folds.length} Folds, Kette ${kette.length})` };
  if (a.riskFree.length !== kette.length) return { fehler: `Zinsreihe nicht auf die OOS-Kette ausgerichtet (${kette.length} Renditen, ${a.riskFree.length} Sätze)` };
  const toleranz = UEBERSCHUSS_TOLERANZ * Math.max(1, Math.abs(a.initialEquity));
  const out: number[] = [];
  let off = 0;
  for (let i = 0; i < folds.length; i++) {
    const f = folds[i]!;
    const r = f.best.oosDailyReturns;
    for (let k = 0; k < r.length; k++) {
      if (kette[off + k] !== r[k]) return { fehler: `Fold ${i + 1} liegt nicht an Position ${off} der OOS-Kette — Zinsreihe wäre verschoben` };
    }
    const u = ueberschussKennzahlen({ returns: r, riskFree: a.riskFree.slice(off, off + r.length), initialEquity: a.initialEquity });
    if (Math.abs(u.rohNetProfit - f.best.oosMetrics.netProfit) > toleranz) {
      return { fehler: `Fold ${i + 1}: Renditereihe passt nicht zum Netto (aufgezinst ${u.rohNetProfit.toFixed(2)}, gemessen ${f.best.oosMetrics.netProfit.toFixed(2)})` };
    }
    out.push(u.netProfit);
    off += r.length;
  }
  return {
    folds: out,
    netProfit: out.reduce((s, x) => s + x, 0),
    positiveShare: out.length ? out.filter((x) => x > 0).length / out.length : 0,
  };
}

/* ───────────────────────── Die Gates ───────────────────────── */

export interface GateInput {
  wfa: WfaResult;
  optimizer: OptimizerConfig;
  /**
   * Stress-Lauf (`stressTest`). `ueberschussNetProfit` ist der Wert des Gates,
   * sobald es ihn gibt; ohne bleibt `netProfit` wie bisher.
   */
  stressOos: { netProfit: number; objectiveMedian: number; ueberschussNetProfit?: number | null | undefined; zins?: string | undefined };
  neighborhood: { medianObjective: number; bestObjective: number; positiveShare: number; ueberschuss?: boolean | undefined; zins?: string | undefined };
  /**
   * Startkapital je Fenster — nötig, um die Überschussreihe in Geld
   * auszudrücken (`ueberschussKette`). Fehlt es, bleiben die Geld-Gates roh
   * und sagen das; ein geratenes Startkapital gäbe es hier nicht.
   */
  initialEquity?: number | undefined;
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
  /**
   * Festkandidat (`optimizer.fixedCandidates`): feste Parameter ohne Suche.
   * Wie beim Amtsinhaber ist der DSR nicht anwendbar — es gab keine Trials,
   * um die man deflationieren könnte. Alles andere gilt in voller Schärfe:
   * alle Folds und die VOLLE Trade-Schwelle (anders als beim Amtsinhaber,
   * der nur sein sauberes OOS hat).
   */
  fixed?: boolean | undefined;
  /**
   * Maßstab über DIESELBEN OOS-Fenster: Sharpe p. a. von kaufen und
   * liegenlassen (`marktKette`). Fehlt er, gilt 0 als Latte — das Gate darf
   * nie vakant werden, sonst schafft man es ab, indem man die Benchmark aus
   * der Config nimmt.
   *
   * `dailyReturns` sind die VERKETTETEN Tagesrenditen desselben Maßstabs. Sie
   * werden nur für die Zinsrechnung gebraucht: Ein Sharpe lässt sich nicht
   * nachträglich auf Überschuss umrechnen, die Reihe schon. Ohne sie rechnet
   * `beats_market` beide Seiten ohne Zins.
   */
  markt?: { sharpe: number | null; quelle: string; dailyReturns?: readonly number[] | undefined } | undefined;
  /**
   * Risikoloser Satz für `probabilistic_sharpe_oos` und `beats_market`.
   * Fehlt er, rechnen beide Gates wie bisher gegen null — und sagen es.
   */
  riskFree?: GateRiskFree | undefined;
}

/** Entscheidung über den Zins: entweder BEIDE Seiten mit, oder BEIDE ohne — nie gemischt. */
interface ZinsEntscheidung {
  /** Sätze für die OOS-Kette; null = ohne Zins rechnen. */
  strategie: readonly number[] | null;
  /** Sätze für die Marktkette; null = die Latte braucht keinen (oder es gibt keinen). */
  markt: readonly number[] | null;
  /** Wörtlich für die Notizen der betroffenen Gates. */
  note: string;
}

/**
 * Der Zins gilt nur, wenn er auf ALLEN benötigten Seiten taggenau passt.
 * Jede Ablehnung nennt ihren Grund — ein stiller Rückfall auf null wäre
 * genau der Fehler, den die Zinsrechnung behebt (Befund B2).
 */
function zinsEntscheidung(a: GateInput): ZinsEntscheidung {
  const rf = a.riskFree;
  if (rf === undefined) return { strategie: null, markt: null, note: `Zins: ${OHNE_ZINS_NOTE}` };
  const nOos = a.wfa.oos.dailyReturns.length;
  if (rf.strategie.length !== nOos) {
    return {
      strategie: null,
      markt: null,
      note: `Zins: Reihe nicht auf die OOS-Kette ausgerichtet (${nOos} Renditen, ${rf.strategie.length} Sätze) — beide Seiten gegen null gerechnet`,
    };
  }
  // Der PSR wurde vom selben Aufrufer vorher gerechnet. Hatte er keinen Zins,
  // stünden im selben Bericht zwei Gates mit verschiedenen Maßstäben.
  if (a.psr.ueberschuss !== true) {
    return {
      strategie: null,
      markt: null,
      note: 'Zins: PSR wurde ohne Zins gerechnet — gemischte Rechnung abgelehnt, beide Seiten gegen null gerechnet',
    };
  }
  // Eine Latte, die es gar nicht gibt (keine Benchmark oder keine Kurse), ist
  // die Kasse — und Kasse hat im Überschuss per Definition den Sharpe 0. Die
  // Marktseite braucht dann keine Sätze.
  const brauchtMarkt = a.markt !== undefined && a.markt.sharpe !== null;
  if (!brauchtMarkt) return { strategie: rf.strategie, markt: null, note: `Zins: ${rf.quelle}` };
  const mr = a.markt!.dailyReturns;
  if (mr === undefined || rf.markt === undefined || rf.markt.length !== mr.length) {
    const grund =
      mr === undefined
        ? 'Markt-Renditen fehlen'
        : rf.markt === undefined
          ? 'keine Sätze für die Marktkette'
          : `Sätze der Marktkette nicht ausgerichtet (${mr.length} Renditen, ${rf.markt.length} Sätze)`;
    return { strategie: null, markt: null, note: `Zins: ${grund} — beide Seiten gegen null gerechnet (gemischt wäre schlimmer)` };
  }
  return { strategie: rf.strategie, markt: rf.markt, note: `Zins: ${rf.quelle}` };
}

/**
 * Der Maßstab der GELD-Gates: Überschuss über dem Zins, wenn die Reihe
 * taggenau auf die OOS-Kette passt — sonst rohes Netto, laut gesagt.
 *
 * Die Bedingung ist absichtlich schwächer als `zinsEntscheidung`: Dort geht
 * es um zwei Sharpe-Werte, die denselben Maßstab tragen müssen (Strategie
 * gegen Markt). Die Geld-Gates vergleichen gegen die Zahl NULL, und null ist
 * im Überschuss dieselbe Null wie roh — ein Maßstab, der nicht verrutschen
 * kann. Eine fehlende Marktreihe darf deshalb nicht dazu führen, dass
 * `oos_net_profit` wieder Zinsertrag als Gewinn zählt.
 */
function geldMassstab(a: GateInput): { kette: UeberschussKette | null; note: string } {
  const rf = a.riskFree;
  if (rf === undefined) return { kette: null, note: ROHES_NETTO_NOTE };
  if (a.initialEquity === undefined || !Number.isFinite(a.initialEquity) || a.initialEquity <= 0) {
    return { kette: null, note: 'Maßstab: rohes Netto — kein Startkapital übergeben, Überschuss in Geld nicht ausdrückbar' };
  }
  const k = ueberschussKette({ wfa: a.wfa, riskFree: rf.strategie, initialEquity: a.initialEquity });
  if ('fehler' in k) return { kette: null, note: `Maßstab: rohes Netto — ${k.fehler}` };
  return { kette: k, note: `Maßstab: Überschuss über den Zins (${rf.quelle})` };
}

export function robustnessGates(a: GateInput): { pass: boolean; gates: GateResult[] } {
  const { wfa, optimizer } = a;
  const oos = wfa.oos;
  const gates: GateResult[] = [];

  // Ein Maßstab für alle Geld-Gates, EINMAL entschieden (Vorregistrierung
  // 2026-09-13-gates-auf-ueberschuss). Ohne ihn zählte der Zinsertrag auf
  // brachliegender Kasse als Leistung der Strategie: In Lauf #48 galten drei
  // Quartale OHNE EINEN TRADE als positive Folds.
  const geld = geldMassstab(a);
  const ue = geld.kette;

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

  // Ein Quartal ohne einen einzigen Trade ist KEIN positiver Fold — seit die
  // Kasse im Geldmarkt liegt, hat es trotzdem ein positives rohes Netto.
  const foldShare = ue ? ue.positiveShare : oos.positiveFoldShare;
  gates.push({
    name: 'fold_positive_share',
    pass: foldShare >= optimizer.minFoldPositiveShare,
    value: foldShare,
    threshold: optimizer.minFoldPositiveShare,
    note:
      `${Math.round(foldShare * wfa.folds.length)} von ${wfa.folds.length} Folds ${ue ? 'im Überschuss' : 'netto'} positiv` +
      (ue ? ` (roh wären es ${Math.round(oos.positiveFoldShare * wfa.folds.length)})` : '') +
      `; ${geld.note}`,
  });

  const oosNetto = ue ? ue.netProfit : oos.netProfit;
  gates.push({
    name: 'oos_net_profit',
    pass: oosNetto > 0,
    value: oosNetto,
    threshold: 0,
    note:
      `OOS ${ue ? 'Überschuss' : 'netto'} ${oosNetto.toFixed(2)}` +
      (ue ? ` (roh ${oos.netProfit.toFixed(2)}, ${oos.netReturnPct.toFixed(2)} %)` : ` (${oos.netReturnPct.toFixed(2)} %)`) +
      // Der Drawdown bleibt ROH — eine Kapitalgröße, wie die Notbremsen live
      // sie messen; im Überschuss fiele die Kurve auch in jeder flachen Phase.
      `, MaxDD ${oos.maxDrawdownPct.toFixed(2)} % (roh, Kapitalsicht)` +
      `; ${geld.note}`,
  });

  // Konzentration: Trägt EIN Fold das ganze Ergebnis? Ein Gewinn, der an
  // einem einzelnen Fenster hängt, ist ein Ereignis und keine Kante — und
  // genau so ist der TSLA-Champion vom 07.09. durch alle Gates gekommen
  // (96 % des Nettos aus einem Monat, Holdout danach negativ).
  // Im Überschuss gerechnet: Der Zinsabzug trifft den Zähler EINMAL und den
  // Nenner so oft, wie es Folds gibt — die Konzentration steigt also, und ein
  // Ergebnis, das an einem Fenster hängt, wird sichtbarer statt unsichtbarer.
  const foldNetto = ue ? ue.folds : wfa.folds.map((f) => f.best.oosMetrics.netProfit);
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
      (summeNetto <= 0
        ? `OOS-${ue ? 'Überschuss' : 'Netto'} nicht positiv — Konzentration nicht aussagekräftig (siehe oos_net_profit)`
        : `bester Fold trägt ${(konzentration * 100).toFixed(0)} % des OOS-${ue ? 'Überschusses' : 'Nettos'} ` +
          `(${groesster.toFixed(2)} von ${summeNetto.toFixed(2)} über ${foldNetto.length} Folds); ` +
          `ohne ihn blieben ${(summeNetto - groesster).toFixed(2)}`) + `; ${geld.note}`,
  });

  // Der Stress-Lauf bringt seinen eigenen Überschuss mit (`stressTest`): Seine
  // Equity-Kurve ist eine andere als die des Normallaufs, also muss auch der
  // Zins auf SEINER Achse liegen.
  const stressUe = a.stressOos.ueberschussNetProfit;
  const stressWert = stressUe !== null && stressUe !== undefined ? stressUe : a.stressOos.netProfit;
  gates.push({
    name: 'stress_costs',
    pass: stressWert > 0,
    value: stressWert,
    threshold: 0,
    note:
      `OOS ${stressUe !== null && stressUe !== undefined ? 'Überschuss' : 'netto'} bei Kosten ×${optimizer.stressCostMultiplier}: ${stressWert.toFixed(2)}` +
      (stressUe !== null && stressUe !== undefined ? ` (roh ${a.stressOos.netProfit.toFixed(2)})` : '') +
      `, Objective-Median ${fmt(a.stressOos.objectiveMedian)}; ${a.stressOos.zins ?? ROHES_NETTO_NOTE}`,
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
      `${(a.neighborhood.positiveShare * 100).toFixed(0)} % der Nachbarn ${a.neighborhood.ueberschuss ? 'im Überschuss ' : ''}positiv (≥ ${NEIGHBOR_POSITIVE_SHARE * 100} %: ${nbShareOk ? 'ja' : 'nein'}); ` +
      // Der Median des Objectives bleibt roh: Suchkriterium, kein Gate — und
      // für `trades === 0` liefert es ohnehin −∞ (objective.ts).
      `${a.neighborhood.zins ?? ROHES_NETTO_NOTE} (Anteil positiver Nachbarn; der Objective-Median bleibt roh)`,
  });

  const { minPsrOos, dsrIsGate } = gateOptions(optimizer);
  // Ertrag über dem ZINS je Schwankung, nicht Ertrag über null: Ohne diesen
  // Abzug ist Bargeld eine Kante (Befund B2, 12.09.2026). Die Entscheidung
  // gilt für beide betroffenen Gates gemeinsam.
  const zins = zinsEntscheidung(a);
  const oosBewertet = zins.strategie === null ? oos.dailyReturns : excessReturns(oos.dailyReturns, zins.strategie);
  const srAnnual = a.metricsFns.sharpeRatio(oosBewertet, a.periodsPerYear ?? 252);
  const srNote =
    srAnnual === null ? 'Sharpe p. a. nicht berechenbar' : `OOS-Sharpe p. a. ${srAnnual.toFixed(2)}${zins.strategie ? ' (Überschuss)' : ''}`;
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
  // Ohne Suche gibt es nichts zu deflationieren: Amtsinhaber und Festkandidat
  // tragen feste Parameter. Das Gate sagt „nicht anwendbar" — laut, statt
  // einen DSR mit nTrials = 1 (das ist nur der PSR der IS-Zahl) als
  // bestanden zu verkaufen.
  const ohneSuche = inc ? 'Amtsinhaber' : a.fixed ? 'Festkandidat' : null;
  gates.push({
    name: 'deflated_sharpe_is',
    pass: ohneSuche !== null || !dsrIsGate ? true : dsrOk,
    value: a.dsr.dsr,
    threshold: DSR_THRESHOLD,
    note: ohneSuche !== null
      ? `nicht anwendbar (${ohneSuche}: feste Parameter, keine Suche, keine Trials)`
      : dsrIsGate
        ? dsrOk
          ? dsrNote
          : `${dsrNote} — gilt als durchgefallen`
        : `informativ (dsrIsGate=false): ${dsrNote}${dsrOk ? '' : ' — würde als Gate durchfallen'}`,
  });

  // Zins-unempfindlich per Bauart: Zähler und Nenner entstehen beide aus
  // TRADES (`Trade.fees` / `Trade.grossPnl`), und eine Treasury-Umschichtung
  // ist kein Trade (risk/parken.ts). Weder Parkkosten noch Zinsertrag stecken
  // hier drin — deshalb bleibt dieses Gate roh und ändert sich um exakt 0.
  gates.push({
    name: 'fee_share',
    pass: oos.feeShare === null || oos.feeShare <= FEE_SHARE_MAX,
    value: oos.feeShare,
    threshold: FEE_SHARE_MAX,
    note:
      oos.feeShare === null
        ? 'Gebührenanteil nicht berechenbar (kein Bruttogewinn) — kein Urteil'
        : `Gebühren fressen ${(oos.feeShare * 100).toFixed(1)} % des Bruttogewinns (aus Trades, zinsfrei)`,
  });

  // Schlägt die Strategie das Nichtstun? Am 08.09.2026 bestand
  // momentum_pullback alle neun anderen Gates und verfehlte im folgenden
  // Halbjahr den Korb um 21.8 Prozentpunkte (+1.9 % gegen +23.7 %). Kein
  // einziges Gate hatte danach gefragt. Gemessen auf der OOS-KETTE, nie am
  // Holdout — der bleibt selektionsfrei.
  //
  // Verglichen wird der Sharpe, nicht die Rendite: Er ist Ertrag je eigener
  // Schwankung und bestraft eine selten investierte Strategie nicht dafür,
  // dass sie meistens flach steht. Eine Strategie, die WENIGER Ertrag je
  // Risiko liefert als stumpfes Halten, hat keine Kante — sie hat Gebühren.
  //
  // Beide Seiten tragen denselben Maßstab: Wird der Zins abgezogen, dann von
  // der Strategie UND vom Markt. Eine gemischte Rechnung wäre schlimmer als
  // die alte gegen null — deshalb entscheidet `zinsEntscheidung` einmal für
  // beide, und die Latte wird aus der Marktreihe NEU gerechnet, nie aus dem
  // fertigen Sharpe korrigiert.
  const marktSr =
    zins.markt !== null && a.markt?.dailyReturns !== undefined
      ? a.metricsFns.sharpeRatio(excessReturns(a.markt.dailyReturns, zins.markt), a.periodsPerYear ?? 252)
      : (a.markt?.sharpe ?? null);
  const latte = marktSr ?? 0;
  // Drei unterscheidbare Fälle — "Benchmark da, aber nicht rechenbar" darf im
  // Bericht nicht wie "keine Benchmark konfiguriert" aussehen: Das erste ist
  // ein Datenproblem, das zweite eine Konfigurationsentscheidung.
  const quelle =
    a.markt === undefined
      ? 'kein Maßstab konfiguriert — Latte 0 (Kasse' + (zins.strategie ? ', im Überschuss per Definition 0' : '') + ')'
      : marktSr === null
        ? `${a.markt.quelle}, Sharpe nicht berechenbar — Latte 0 (Kasse)`
        : a.markt.quelle + (zins.markt ? ' (Überschuss)' : '');
  gates.push({
    name: 'beats_market',
    pass: srAnnual !== null && srAnnual > latte,
    value: srAnnual,
    threshold: latte,
    note:
      (srAnnual === null
        ? `OOS-Sharpe nicht berechenbar — gilt als durchgefallen (Latte ${latte.toFixed(2)}, ${quelle})`
        : `OOS-Sharpe p. a. ${srAnnual.toFixed(2)} gegen ${latte.toFixed(2)} aus ${quelle}` +
          (srAnnual > latte ? '' : ' — kaufen und liegenlassen war besser')) + `; ${zins.note}`,
  });

  return { pass: gates.every((g) => g.pass), gates };
}

/* ───────────────────────── Die Basis-Latte (Gate-Gruppe `basis`) ───────────────────────── */

export interface BasisGateInput {
  /** Schwellen aus `optimizer.basis` — `positionPct` ist Sizing, kein Gate, und wird hier nicht gebraucht. */
  basis: Pick<BasisConfig, 'minDrawdownReduction' | 'minSharpeRatio' | 'maxCostShare'>;
  /** Kostenfaktor des Stress-Laufs (`optimizer.stressCostMultiplier`) — nur für die Notiz. */
  stressCostMultiplier: number;
  /**
   * Aus der EINEN durchgehenden Simulation (`basisSimulation`). Die
   * `ueberschuss*`-Felder sind optional, damit von Hand gebaute Eingaben
   * (Tests, ältere Aufrufer) gültig bleiben — fehlen sie, rechnet die
   * Gate-Gruppe roh wie vor dem 13.09.2026 und sagt es in ihren Notizen.
   */
  kennzahlen: Pick<BasisKennzahlen, 'netProfit' | 'stressNetProfit' | 'sharpe' | 'maxDrawdownPct' | 'avgExposure' | 'exposureNormMaxDD' | 'fees'> &
    Partial<Pick<BasisKennzahlen, 'ueberschussNetProfit' | 'ueberschussStressNetProfit' | 'ueberschussSharpe' | 'zins'>>;
  /**
   * Der Maßstab: Kaufen-und-Halten des Korbs, gleichgewichtet, ohne Kosten,
   * über DIESELBE Range. null = nicht berechenbar — dann fallen Drawdown- und
   * Sharpe-Gate; die Latte wird nie vakant, indem man den Maßstab weglässt.
   *
   * `ueberschussSharpe` ist derselbe Maßstab auf Überschussrenditen. Er MUSS
   * da sein, wenn die Basis im Überschuss gerechnet wird — sonst verglichen
   * wir eine Überschuss-Strategie mit einem rohen Markt, und das wäre
   * schlimmer als beide roh (§2.5 der Zins-Vorregistrierung). `basisGates`
   * fällt in diesem Fall für BEIDE Seiten auf roh zurück.
   */
  korb: { sharpe: number | null; maxDrawdownPct: number; ueberschussSharpe?: number | null | undefined } | null;
}

/**
 * Die zweite Latte, ganz im Code (Prüfbefund K1/M15): vier Gates, alle
 * müssen bestehen, kein Trade-Minimum — Aktivität wird berichtet, nicht
 * bewertet. Sie misst etwas anderes als die zehn Alpha-Gates: nicht „gibt es
 * eine Kante gegen SPY", sondern „ist Marktexposition mit Trendfilter
 * besser als den Korb liegenzulassen — je Einheit Exposure, nach Kosten".
 */
export function basisGates(a: BasisGateInput): { pass: boolean; gates: GateResult[] } {
  const { basis, kennzahlen: k, korb } = a;
  const gates: GateResult[] = [];

  /*
   * EIN Maßstab für die ganze Gruppe (Vorregistrierung
   * 2026-09-13-gates-auf-ueberschuss): Geld und Sharpe im Überschuss über dem
   * Zins — aber nur, wenn BEIDE Hälften des Netto-Gates und BEIDE Seiten des
   * Sharpe-Vergleichs im Überschuss vorliegen. Sonst rechnet die ganze Gruppe
   * roh, damit im selben Block nie zwei Maßstäbe nebeneinanderstehen.
   * `basis_drawdown` bleibt in jedem Fall roh (siehe Modulkopf).
   */
  const geldUe = k.ueberschussNetProfit !== null && k.ueberschussNetProfit !== undefined && k.ueberschussStressNetProfit !== null && k.ueberschussStressNetProfit !== undefined;
  const netProfit = geldUe ? k.ueberschussNetProfit! : k.netProfit;
  const stressNetProfit = geldUe ? k.ueberschussStressNetProfit! : k.stressNetProfit;
  const geldNote = geldUe ? (k.zins ?? 'Maßstab: Überschuss über den Zins') : ROHES_NETTO_NOTE;

  // Netto > 0 UND bei Stress > 0 — ein Standard, der Geld verliert, ist schlechter als Kasse.
  gates.push({
    name: 'basis_net_profit',
    pass: netProfit > 0 && stressNetProfit > 0,
    value: netProfit,
    threshold: 0,
    note:
      `${geldUe ? 'Überschuss' : 'Netto'} ${netProfit.toFixed(2)}, bei Kosten ×${a.stressCostMultiplier}: ${stressNetProfit.toFixed(2)} (beide > 0 nötig)` +
      (geldUe ? ` — roh ${k.netProfit.toFixed(2)} / ${k.stressNetProfit.toFixed(2)}` : '') +
      `; ${geldNote}`,
  });

  // Drawdown je Einheit Exposure gegen den liegengelassenen Korb (Prüfbefund
  // K2): Eine Basis, die die halbe Zeit in Kasse steht, hat automatisch den
  // halben rohen Drawdown — der Vergleich muss die Exposure herausrechnen,
  // sonst misst er Kasse, nicht Regel. Ohne Exposure gibt es kein Urteil.
  //
  // BEIDE Seiten bleiben ROH, auch wenn alles andere im Überschuss rechnet
  // (Modulkopf, §4 der Vorregistrierung): Ein Drawdown ist die Frage „wie
  // viel vom Konto war weg", und genau die messen die Notbremsen live. Der
  // Maßstab daneben ist eine rohe Kursgröße — eine Seite umzustellen wäre die
  // verbotene Mischung. Folge für den Leser: Diese Zahl ist NICHT mit den
  // Überschuss-Zahlen desselben Blocks verrechenbar.
  const ddLatte = korb === null ? null : (1 - basis.minDrawdownReduction) * korb.maxDrawdownPct;
  const ddWert = k.exposureNormMaxDD;
  gates.push({
    name: 'basis_drawdown',
    pass: ddLatte !== null && ddWert !== null && ddWert <= ddLatte,
    value: ddWert,
    threshold: ddLatte,
    note:
      korb === null
        ? 'Korb liegenlassen nicht berechenbar — nicht bewertbar, gilt als durchgefallen'
        : ddWert === null
          ? `nicht bewertbar (mittlere Exposure ${k.avgExposure === null ? 'unbekannt' : '0'}) — gilt als durchgefallen; roher MaxDD ${k.maxDrawdownPct.toFixed(2)} %, Korb ${korb.maxDrawdownPct.toFixed(2)} %`
          : `MaxDD ${k.maxDrawdownPct.toFixed(2)} % / mittlere Exposure ${(k.avgExposure! * 100).toFixed(1)} % = ${ddWert.toFixed(2)} % ` +
            `gegen (1 − ${basis.minDrawdownReduction}) × Korb ${korb.maxDrawdownPct.toFixed(2)} % = ${ddLatte!.toFixed(2)} % ` +
            '(beide Seiten ROH, Kapitalsicht — nicht mit den Überschuss-Zahlen verrechenbar)',
  });

  // Ertrag je Risiko: mindestens der Anteil des Korb-Sharpe; ein Korb ohne
  // positiven Sharpe setzt keine Latte — dann muss die Basis nur selbst positiv sein.
  //
  // BEIDE Seiten oder keine: Der Zins wird der Basis nur dann abgezogen, wenn
  // er auch dem liegengelassenen Korb abgezogen wurde. Eine Überschuss-Basis
  // gegen einen rohen Korb wäre eine geschenkte Latte.
  const sharpeUe = k.ueberschussSharpe !== null && k.ueberschussSharpe !== undefined && korb !== null && korb.ueberschussSharpe !== null && korb.ueberschussSharpe !== undefined;
  const korbSr = korb === null ? null : sharpeUe ? korb.ueberschussSharpe! : korb.sharpe;
  const sr = sharpeUe ? k.ueberschussSharpe! : k.sharpe;
  const srLatte = korb === null ? null : korbSr !== null && korbSr > 0 ? basis.minSharpeRatio * korbSr : 0;
  const srNote = sharpeUe ? ' (beide Seiten Überschuss)' : korb === null ? '' : ' (beide Seiten roh)';
  gates.push({
    name: 'basis_sharpe',
    pass: korb !== null && sr !== null && (korbSr !== null && korbSr > 0 ? sr >= srLatte! : sr > 0),
    value: sr,
    threshold: srLatte,
    note:
      korb === null
        ? 'Korb liegenlassen nicht berechenbar — nicht bewertbar, gilt als durchgefallen'
        : sr === null
          ? 'Sharpe der Basis nicht berechenbar (Varianz 0?) — gilt als durchgefallen'
          : korbSr !== null && korbSr > 0
            ? `Sharpe p. a. ${sr.toFixed(2)} gegen ${basis.minSharpeRatio} × Korb ${korbSr.toFixed(2)} = ${srLatte!.toFixed(2)}${srNote}`
            : `Korb-Sharpe ${korbSr === null ? 'nicht berechenbar' : korbSr.toFixed(2)} ≤ 0 setzt keine Latte — Basis-Sharpe ${sr.toFixed(2)} muss > 0 sein${srNote}`,
  });

  // Gebühren gesamt gegen den Betrag des Nettos. Netto 0 ⇒ Anteil unendlich ⇒
  // nicht bestanden. Der Nenner ist der ÜBERSCHUSS: Ein Konto, dessen Netto
  // überwiegend Zinsertrag ist, hätte sonst einen geschmeichelt kleinen
  // Gebührenanteil — die Gebühren sind aber real und der Zins nicht verdient.
  const costShare = netProfit !== 0 ? k.fees / Math.abs(netProfit) : null;
  gates.push({
    name: 'basis_costs',
    pass: costShare !== null && costShare <= basis.maxCostShare,
    value: costShare,
    threshold: basis.maxCostShare,
    note:
      costShare === null
        ? `${geldUe ? 'Überschuss' : 'Netto'} 0 — Gebührenanteil nicht definiert, gilt als durchgefallen (Gebühren ${k.fees.toFixed(2)})`
        : `Gebühren ${k.fees.toFixed(2)} / |${geldUe ? 'Überschuss' : 'Netto'}| ${Math.abs(netProfit).toFixed(2)} = ${(costShare * 100).toFixed(1)} %; ${geldNote}`,
  });

  return { pass: gates.every((g) => g.pass), gates };
}

function fmt(x: number): string {
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '−∞';
  return x.toFixed(3);
}
