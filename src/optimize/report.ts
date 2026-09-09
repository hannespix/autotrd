/**
 * Markdown-Bericht eines Optimierungslaufs. Der Bericht ist die einzige
 * Stelle, an der ein Mensch nachvollziehen kann, WARUM ein Symbol handelt
 * oder nicht — deshalb steht jedes Gate mit Wert und Schwelle drin, und der
 * Holdout ist unübersehbar als "nur Bericht, nicht Auswahl" markiert.
 */
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CostConfig, OptimizerConfig, RiskConfig } from '../core/config.ts';
import { ensureDir } from '../core/journal.ts';
import type { AssetClass, Metrics, Ms, Params, TimeframeMin } from '../core/types.ts';
import { fitEndOf } from './promote.ts';
import { gateOptions, type GateResult } from './robustness.ts';
import type { MarktBezug } from '../backtest/marktbezug.ts';
import type { BasisRun, HoldoutMarkt, Massstab, StrategyRun, SymbolRun } from './run.ts';
import type { TimeRange } from './walkForward.ts';

export interface ReportMeta {
  generatedAt: Ms;
  timeframe: TimeframeMin;
  assetClass: AssetClass;
  dataRange: TimeRange | null;
  costs: CostConfig;
  optimizer: OptimizerConfig;
  /**
   * Risiko-Sicht des Laufs. Steht im Bericht, weil zwei Läufe sonst identisch
   * aussehen, obwohl sie Verschiedenes gemessen haben — `allowShort` ist der
   * Fall, der das am 08.09.2026 gezeigt hat: Der Strategie-Parameter
   * `allowShort` war in allen Läufen wirkungslos, weil `risk.allowShort`
   * false stand, und dem Bericht sah man das nicht an.
   */
  risk: RiskConfig;
  initialEquity: number;
  /**
   * Stichtag der Messung (YYYY-MM-DD), falls der Lauf mit `--as-of` gefahren
   * wurde. Steht ganz oben, weil sonst zwei Berichte identisch aussehen, die
   * verschiedene Zeitpunkte messen — und weil ein Leser wissen muss, dass
   * dieser Lauf die letzten Monate NICHT gesehen hat.
   */
  asOf?: string;
}

/* ───────────────────────── Formatierung ───────────────────────── */

export function isoDay(ms: Ms): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoMinute(ms: Ms): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Zahl mit fester Nachkommazahl; ±∞ und null lesbar; Ganzzahlen ohne Nachkommastellen. */
export function num(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '–';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '−∞';
  if (Number.isInteger(x)) return String(x);
  return x.toFixed(digits);
}

function signed(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return num(x, digits);
  return (x > 0 ? '+' : '') + x.toFixed(digits);
}

function pct(x: number | null, digits = 1): string {
  return x === null ? '–' : `${num(x * 100, digits)} %`;
}

function tf(t: TimeframeMin): string {
  return t === 1440 ? 'Tagesbars' : `${t} min`;
}

function paramsJson(p: Params): string {
  return JSON.stringify(p);
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

function metricsRow(m: Metrics): string[] {
  return [
    String(m.trades),
    signed(m.netProfit),
    `${num(m.netReturnPct)} %`,
    `${num(m.maxDrawdownPct)} %`,
    num(m.sharpe),
    num(m.sortino),
    num(m.profitFactor),
    m.winRatePct === null ? '–' : `${num(m.winRatePct, 0)} %`,
    pct(m.feeShare),
  ];
}

const METRICS_HEADER = ['Trades', 'Netto', 'Rendite', 'MaxDD', 'Sharpe', 'Sortino', 'PF', 'Trefferquote', 'Gebührenanteil'];

function gatesTable(gates: readonly GateResult[]): string {
  return table(
    ['Gate', 'Ergebnis', 'Wert', 'Schwelle', 'Notiz'],
    gates.map((g) => [g.name, g.pass ? '✔' : '✘', num(g.value, 3), num(g.threshold, 3), g.note]),
  );
}

function gatesSummary(gates: readonly GateResult[]): string {
  const passed = gates.filter((g) => g.pass).length;
  const failed = gates.filter((g) => !g.pass).map((g) => g.name);
  return failed.length === 0 ? `✔ ${passed}/${gates.length}` : `✘ ${passed}/${gates.length} (${failed.join(', ')})`;
}

/** Ein Festkandidat heißt im Bericht `<strategy> · fest: <label>` — in der Tabelle wie in der Überschrift. */
function kandidatName(s: StrategyRun): string {
  return s.fixed && s.label !== null ? `${s.strategyId} · fest: ${s.label}` : s.strategyId;
}

/**
 * Maßstab je Kandidat, direkt unter den Gates: dieselben OOS-Fenster, die
 * Strategie neben kaufen-und-halten der Benchmark. Ohne Benchmark gilt die
 * Kasse — so wie `beats_market` es handhabt.
 */
function massstabZeile(m: Massstab): string {
  const strategie = `Strategie Sharpe p. a. ${num(m.oosSharpe)}, MaxDD ${num(m.oosMaxDD)} %, Trades je Monat ${num(m.tradesPerMonth, 1)}`;
  const markt =
    m.marktSymbol === null
      ? 'ohne Benchmark: Kasse (Latte 0)'
      : m.marktSharpe === null && m.marktMaxDD === null
        ? `${m.marktSymbol} kaufen-und-halten nicht berechenbar — Latte 0 (Kasse)`
        : `${m.marktSymbol} kaufen-und-halten Sharpe ${num(m.marktSharpe)}, MaxDD ${num(m.marktMaxDD)} %`;
  return `Über dieselben OOS-Fenster: ${strategie} · ${markt}`;
}

/* ───────────────────────── Bericht ───────────────────────── */

export function renderReport(runs: readonly SymbolRun[], meta: ReportMeta): string {
  const o = meta.optimizer;
  const c = meta.costs;
  const out: string[] = [];

  out.push(`# Optimierung ${isoDay(meta.generatedAt)}`);
  out.push('');
  out.push(`- Erzeugt: ${isoMinute(meta.generatedAt)}`);
  if (meta.asOf) out.push(`- **Stichtag ${meta.asOf}** — der Lauf sieht nichts danach (Messung, kein Produktivlauf)`);
  out.push(`- Zeitrahmen: ${tf(meta.timeframe)} (${meta.assetClass})`);
  out.push(`- Datenbereich: ${meta.dataRange ? `${isoDay(meta.dataRange.start)} … ${isoDay(meta.dataRange.end)}` : 'keine Daten'}`);
  out.push(
    `- Kosten: Slippage ${c.slippageBps} bp, halber Spread ${c.spreadBps} bp, SEC ${c.secFeeRate}, FINRA TAF ${c.finraTafPerShare}/Stück (max ${c.finraTafMax}), ` +
      `Krypto-Taker ${c.cryptoTakerPct} %, Short-Leihe ${c.shortBorrowAnnualPct} % p. a.; Stress ×${o.stressCostMultiplier}`,
  );
  out.push(
    `- Suche: ${o.samples} Samples je Fold, Seed ${o.seed}, Objective \`${o.objective}\`, IS ${o.isDays} / OOS ${o.oosDays} / Schritt ${o.stepDays} Tage, ` +
      `Holdout ${o.holdoutDays} Tage, Embargo ${o.embargoBars > 0 ? `${o.embargoBars} Bars` : 'automatisch (Warmup + 20 Bars)'}`,
  );
  const festAlpha = o.fixedCandidates.filter((fc) => fc.tier !== 'basis');
  const festBasis = o.fixedCandidates.filter((fc) => fc.tier === 'basis');
  const festText = (fc: OptimizerConfig['fixedCandidates'][number]) => `${fc.strategy} ${paramsJson(fc.params)}${fc.label === undefined ? '' : ` „${fc.label}"`}`;
  if (festAlpha.length > 0) {
    out.push(`- Festkandidaten (vorregistriert, ohne Suche, dieselben Folds und Gates): ` + festAlpha.map(festText).join('; '));
  }
  if (festBasis.length > 0) {
    const b = o.basis;
    out.push(
      `- Basis-Allokation (Festkandidat tier: basis, EINE durchgehende Simulation über die OOS-Kette, nie Alpha-Champion): ` +
        festBasis.map(festText).join('; ') +
        ` — Basis-Latte: Netto > 0 (auch bei Kosten ×${o.stressCostMultiplier}), MaxDD je Einheit Exposure ≤ ${Math.round((1 - b.minDrawdownReduction) * 100)} % des Korbs liegenlassen, ` +
        `Sharpe ≥ ${b.minSharpeRatio} × Korb, Gebühren ≤ ${Math.round(b.maxCostShare * 100)} % von |Netto|`,
    );
  }
  const go = gateOptions(o);
  out.push(
    `- Gates: ≥ ${o.minOosTrades} OOS-Trades, ≥ ${Math.round(o.minFoldPositiveShare * 100)} % Folds positiv, OOS netto > 0 (auch bei Kosten ×${o.stressCostMultiplier}), ` +
      `kein Fold trägt mehr als ${Math.round(o.maxFoldNetShare * 100)} % des OOS-Nettos, ` +
      `Nachbarschafts-Plateau, PSR (OOS, sr0 = 0) ≥ ${go.minPsrOos}, DSR (IS, deflationiert um alle Trials) ≥ 0.95 ${go.dsrIsGate ? 'als Gate' : 'nur informativ (dsrIsGate=false)'}, ` +
      `Gebührenanteil ≤ 50 %; Beförderungsmarge ${Math.round(o.promotionMargin * 100)} %`,
  );
  const r = meta.risk;
  out.push(
    `- Risiko: ${r.riskPerTradePct} % je Trade, Positionsdeckel ${r.maxPositionPct} %, höchstens ${r.maxPositions} Positionen, ` +
      `Brutto ≤ ${r.maxGrossExposurePct} %, Tagesverlust ${r.maxDailyLossPct} %, Drawdown ${r.maxDrawdownPct} %, ` +
      `**Shorts ${r.allowShort ? 'ERLAUBT' : 'gesperrt'}**${r.allowShort ? '' : ' — der Strategie-Parameter `allowShort` bleibt damit wirkungslos'}`,
  );
  out.push(`- Startkapital je Fenster: ${meta.initialEquity}`);
  out.push('');

  out.push('## Zusammenfassung');
  out.push('');
  out.push(
    table(
      ['Symbol', 'Entscheidung', 'Handelt mit', 'Score', 'Grund'],
      runs.map((r) => [
        r.symbol,
        r.decision.action,
        r.chosen ? `${r.chosen.strategy}${r.chosen.fixed ? ' (fest)' : ''} ${paramsJson(r.chosen.params)}` : '— (kein Handel)',
        r.chosen ? num(r.chosen.score, 3) : '–',
        r.decision.reason,
      ]),
    ),
  );
  out.push('');
  // Die zweite Latte hat ihre eigene Zeile — sie steht nicht in der Tabelle,
  // weil sie um nichts konkurriert, und sie fehlt nie stumm.
  if (festBasis.length > 0) {
    for (const r of runs) out.push(basisZusammenfassung(r, festBasis[0]!));
    out.push('');
  }

  for (const r of runs) {
    out.push(`## ${r.symbol}`);
    out.push('');
    out.push(...korbBlock(r));
    if (r.errors.length) {
      out.push('Fehler:');
      for (const e of r.errors) out.push(`- ${e}`);
      out.push('');
    }
    if (r.results.length === 0) {
      out.push('_Keine bewertbare Strategie._');
      out.push('');
    } else {
      out.push(
        table(
          ['Strategie', 'OOS-Objective (Median)', 'Folds +', 'Trades', 'Netto', 'Rendite', 'MaxDD', 'Gebührenanteil', 'Gates'],
          r.results.map((s) => [
            kandidatName(s),
            num(s.score, 3),
            `${Math.round(s.wfa.oos.positiveFoldShare * s.wfa.folds.length)}/${s.wfa.folds.length}`,
            String(s.wfa.oos.trades),
            signed(s.wfa.oos.netProfit),
            `${num(s.wfa.oos.netReturnPct)} %`,
            `${num(s.wfa.oos.maxDrawdownPct)} %`,
            pct(s.wfa.oos.feeShare),
            gatesSummary(s.gates),
          ]),
        ),
      );
      out.push('');
    }

    out.push(`**Entscheidung: ${r.decision.action}** — ${r.decision.reason}`);
    if (r.incumbent) {
      out.push('');
      const ev = r.incumbentEval;
      out.push(
        `Amtierender Champion: ${r.incumbent.strategy}${r.incumbent.fixed ? ' (fest)' : ''} ${paramsJson(r.incumbent.params)} (Score bei Beförderung ${num(r.incumbent.score, 3)}, ` +
          `Fit-Ende ${isoDay(fitEndOf(r.incumbent))}, Re-Score ${num(r.incumbentRescore, 3)})`,
      );
      if (ev) {
        out.push('');
        out.push(
          `Sauberes OOS nach Fit-Ende: ${ev.cleanFolds} von ${ev.totalFolds} Folds, ${ev.cleanDays} Tage, ${ev.trades} Trades — ` +
            `${ev.pass === null ? 'nicht geprüft' : ev.pass ? 'Gates bestanden' : 'Gates gerissen'}: ${ev.note}`,
        );
        if (ev.gates.length) {
          out.push('');
          out.push(gatesTable(ev.gates));
        }
      }
    }
    out.push('');

    for (const s of r.results) {
      out.push(`### ${r.symbol} · ${kandidatName(s)}`);
      out.push('');
      const fenster = `${isoDay(s.wfa.finalWindow.start)} … ${isoDay(s.wfa.finalWindow.end)}`;
      out.push(
        s.fixed
          ? `finalParams: \`${paramsJson(s.wfa.finalParams)}\` (Festkandidat — vorregistriert, keine Suche; Nachbarschaft auf ${fenster}, Embargo ${s.wfa.embargoBars} Bars)`
          : `finalParams: \`${paramsJson(s.wfa.finalParams)}\` (Suche auf ${fenster}, ${s.wfa.trials} Trials, Embargo ${s.wfa.embargoBars} Bars)`,
      );
      out.push('');
      out.push(gatesTable(s.gates));
      out.push('');
      // Der Maßstab gehört direkt unter die Gates: derselbe Sharpe wie in
      // `beats_market`, daneben MaxDD und Handelsfrequenz — und der Markt.
      out.push(massstabZeile(s.massstab));
      out.push('');
      // Die Rohwerte beider Sharpe-Gates gehören sichtbar in den Bericht: Ein
      // Gate, das nur "0.000" sagt, lässt sich nicht hinterfragen.
      out.push(`PSR (OOS): ${s.psr.note}`);
      out.push('');
      out.push(`DSR (IS): ${s.fixed ? 'nicht anwendbar (feste Parameter, keine Suche) — ' : ''}${s.dsr.note}`);
      out.push('');
      out.push(
        table(
          ['Fold', 'IS', 'OOS', 'Params', 'IS-Objective', 'OOS-Objective', 'OOS-Trades', 'OOS-Netto'],
          s.wfa.folds.map((f) => [
            String(f.fold.index + 1),
            `${isoDay(f.fold.isStart)} … ${isoDay(f.fold.isEnd)}`,
            `${isoDay(f.fold.oosStart)} … ${isoDay(f.fold.oosEnd)}`,
            paramsJson(f.best.params),
            num(f.best.isObjective, 3),
            num(f.best.oosObjective, 3),
            String(f.best.oosMetrics.trades),
            signed(f.best.oosMetrics.netProfit),
          ]),
        ),
      );
      out.push('');
      if (s.wfa.holdout) {
        out.push(
          `**Holdout ${isoDay(s.wfa.holdout.start)} … ${isoDay(s.wfa.holdout.end)} — nur Bericht, nicht Auswahl.** ` +
            'Diese Zahlen haben die Parameterwahl nicht beeinflusst und dürfen sie auch rückwirkend nicht beeinflussen.',
        );
        out.push('');
        out.push(table(METRICS_HEADER, [metricsRow(s.wfa.holdout.metrics)]));
        const markt = marktBlock(r.holdoutMarkt);
        if (markt.length) out.push('', ...markt);
      } else {
        out.push('_Kein Holdout konfiguriert (optimizer.holdoutDays = 0)._');
      }
      out.push('');
    }

    if (r.basis) out.push(...basisAbschnitt(r.symbol, r.basis, r.holdoutMarkt, meta));
  }

  return out.join('\n');
}

/* ───────────────────────── Basis-Allokation ───────────────────────── */

function basisZusammenfassung(r: SymbolRun, fc: OptimizerConfig['fixedCandidates'][number]): string {
  const label = fc.label ?? (Object.keys(fc.params).length === 0 ? 'Defaults' : paramsJson(fc.params));
  if (!r.basis) return `Basis ${r.symbol}: ${label} — nicht gemessen (siehe Fehler unter ${r.symbol})`;
  const gerissen = r.basis.gates.filter((g) => !g.pass).map((g) => g.name);
  return `Basis ${r.symbol}: ${r.basis.label} — ${r.basis.pass ? 'bestanden' : `nicht bestanden (${gerissen.join(', ')})`}`;
}

/**
 * Der Abschnitt der zweiten Latte: Gate-Gruppe, Kennzahlen inklusive
 * Aktivität, der Maßstab (Korb liegenlassen UND SPY über dieselbe Range),
 * die Fold-Scheiben aus der einen Kurve und der Holdout mit Maßstab.
 */
function basisAbschnitt(symbol: string, b: BasisRun, holdoutMarkt: HoldoutMarkt | null, meta: ReportMeta): string[] {
  const k = b.kennzahlen;
  const out: string[] = [];
  out.push(`### ${symbol} · Basis-Allokation (Festkandidat, durchgehende Simulation)`);
  out.push('');
  out.push(
    `${b.strategy} „${b.label}" \`${paramsJson(b.params)}\` — EIN Simulationslauf ${isoDay(b.range.start)} … ${isoDay(b.range.end)} ` +
      `(OOS-Kette des Fold-Plans, ${k.days} Tage; Warmup aus der Historie davor, Positionen über Fold-Grenzen, ein Buch, ein Peak, kein IS-Fenster). ` +
      'Zweite Latte, nicht die zehn Alpha-Gates: Die Basis konkurriert nicht um den Alpha-Champion und steht als eigener Block `basis` in champion.json.',
  );
  out.push('');
  out.push(`**Basis-Latte: ${b.pass ? 'bestanden' : `nicht bestanden (${b.gates.filter((g) => !g.pass).map((g) => g.name).join(', ')})`}**`);
  out.push('');
  out.push(gatesTable(b.gates));
  out.push('');
  out.push(
    `Kennzahlen: Netto ${signed(k.netProfit)} (${signed(k.netReturnPct)} %), bei Kosten ×${b.stressCostMultiplier} ${signed(k.stressNetProfit)}; ` +
      `Sharpe p. a. ${num(k.sharpe)}; MaxDD ${num(k.maxDrawdownPct)} %, mittlere Exposure ${pct(k.avgExposure)}, MaxDD je Einheit Exposure ${k.exposureNormMaxDD === null ? 'nicht bewertbar' : `${num(k.exposureNormMaxDD)} %`}; ` +
      `Gebühren ${num(k.fees)} absolut; ${k.trades} Trades (${num(k.tradesPerMonth, 1)} je Monat), mittlere Haltedauer ${k.avgHoldingDays === null ? '–' : `${num(k.avgHoldingDays, 1)} Handelstage`}, ` +
      `Tage ohne Position ${pct(k.flatDaysShare)}, offen am Ende ${k.openAtEnd}.`,
  );
  out.push('');
  const zeile = (name: string, rendite: number, dd: number, sharpe: number | null, ddExp: string): string[] => [name, `${signed(rendite)} %`, `${num(dd)} %`, num(sharpe), ddExp];
  const zeilen: string[][] = [zeile('Basis', k.netReturnPct, k.maxDrawdownPct, k.sharpe, k.exposureNormMaxDD === null ? '–' : `${num(k.exposureNormMaxDD)} %`)];
  zeilen.push(
    b.korb
      ? zeile(`Korb liegenlassen (${b.korb.symbole} Symbol${b.korb.symbole === 1 ? '' : 'e'}, gleichgewichtet, ohne Kosten) — der Maßstab`, b.korb.netReturnPct, b.korb.maxDrawdownPct, b.korb.sharpe, `${num(b.korb.maxDrawdownPct)} %`)
      : ['Korb liegenlassen — keine Kurse in der Range (Latte nicht berechenbar ⇒ Gates gerissen)', '–', '–', '–', '–'],
  );
  if (b.spy) {
    zeilen.push(
      b.spy.bezug
        ? zeile(`${b.spy.symbol} kaufen-und-halten (nur Bericht)`, b.spy.bezug.netReturnPct, b.spy.bezug.maxDrawdownPct, b.spy.bezug.sharpe, `${num(b.spy.bezug.maxDrawdownPct)} %`)
        : [`${b.spy.symbol} kaufen-und-halten (nur Bericht) — keine Kurse in der Range`, '–', '–', '–', '–'],
    );
  }
  out.push('_Maßstab über DIESELBE Range — der Korb liegenlassen entscheidet (Gates), SPY ist nur Bericht._');
  out.push('');
  out.push(table(['Referenz', 'Rendite', 'MaxDD', 'Sharpe', 'MaxDD je Einheit Exposure'], zeilen));
  out.push('');
  out.push(
    `_Fold-Scheiben aus der EINEN Kurve — nur Bericht, kein Gate: ${Math.round(b.positiveScheibenShare * b.scheiben.length)} von ${b.scheiben.length} Scheiben netto positiv ` +
      `(${pct(b.positiveScheibenShare, 0)}); Korb und ${b.spy ? b.spy.symbol : 'Benchmark'} als Netto von ${meta.initialEquity} liegenlassen, dieselbe Kurve geschnitten._`,
  );
  out.push('');
  out.push(
    table(
      ['Fold-Scheibe', 'Netto Basis', 'Netto Korb', `Netto ${b.spy ? b.spy.symbol : 'Benchmark'}`],
      b.scheiben.map((sc) => [
        `${sc.fold.index + 1}: ${isoDay(sc.fold.oosStart)} … ${isoDay(sc.fold.oosEnd)}`,
        signed(sc.basis),
        sc.korb === null ? '–' : signed(sc.korb),
        sc.spy === null ? '–' : signed(sc.spy),
      ]),
    ),
  );
  out.push('');
  if (b.holdout) {
    out.push(
      `**Holdout ${isoDay(b.holdout.start)} … ${isoDay(b.holdout.end)} — nur Bericht, nicht Latte.** ` +
        'Eigene Simulation ab Holdout-Beginn mit Warmup aus der Historie; diese Zahlen haben die Gates nicht beeinflusst.',
    );
    out.push('');
    out.push(table(METRICS_HEADER, [metricsRow(b.holdout.metrics)]));
    const markt = marktBlock(holdoutMarkt);
    if (markt.length) out.push('', ...markt);
  } else {
    out.push('_Kein Holdout konfiguriert (optimizer.holdoutDays = 0)._');
  }
  out.push('');
  return out;
}

/**
 * Maßstab unter dem Holdout: Was hätte Nichtstun gebracht? Eine
 * Holdout-Rendite ohne diese Zeilen ist nicht lesbar — +11 % sind großartig
 * gegen 0 % und mittelmäßig gegen +12 %.
 */
function korbBlock(r: SymbolRun): string[] {
  if (r.korb) {
    const zeilen = r.korb.staende.map((st, i) => [
      isoDay(st.at),
      String(st.symbols.length),
      i === 0 ? '_erster Stand_' : st.zugang.length ? st.zugang.join(', ') : '—',
      i === 0 ? '—' : st.abgang.length ? st.abgang.join(', ') : '—',
    ]);
    const fehlend = r.korb.fehlend.length ? ` (${r.korb.fehlend.length} ohne Bars im Messfenster, nicht wählbar: ${r.korb.fehlend.join(', ')})` : '';
    const heute =
      r.korb.heuteZugang.length || r.korb.heuteAbgang.length
        ? `**Heute gehandelt wird ein anderer Korb** als der des letzten Standes (auf dem die finalen Parameter gesucht wurden): Zugang ${r.korb.heuteZugang.length ? r.korb.heuteZugang.join(', ') : '—'}, Abgang ${r.korb.heuteAbgang.length ? r.korb.heuteAbgang.join(', ') : '—'}.`
        : '_Der heute gehandelte Korb entspricht dem letzten Stand._';
    return [
      `**Korb je Fold** — Punkt-in-Zeit: zu Beginn jedes OOS-Fensters aus ${r.korb.kandidaten} Kandidaten gewählt${fehlend}, mit Daten bis dahin, ` +
        'Hysterese Stand für Stand. IS-Suche und OOS eines Folds laufen auf dessen Korb; der Holdout auf dem Korb zu seinem Beginn. ' +
        'Der Pool selbst ist von heute — wer im Messzeitraum verschwunden ist, kommt nicht vor (§5a.13).',
      '',
      table(['Stichtag', 'Korb', 'Zugang', 'Abgang'], zeilen),
      '',
      heute,
      '',
    ];
  }
  if (r.korbHinweis) return [`_Korb über das ganze Fenster fest: ${r.korbHinweis}._`, ''];
  return [];
}

function marktBlock(m: HoldoutMarkt | null): string[] {
  if (!m) return [];
  const zeilen: string[][] = [];
  // netReturnPct/maxDrawdownPct sind bereits Prozent (wie in `Metrics`) — pct()
  // würde ein zweites Mal mit 100 multiplizieren.
  const zeile = (name: string, b: MarktBezug): string[] => [name, `${signed(b.netReturnPct)} %`, `${num(b.maxDrawdownPct)} %`, num(b.sharpe)];
  if (m.korb) zeilen.push(zeile(`Kaufen und Halten (${m.korb.symbole} Symbol${m.korb.symbole === 1 ? '' : 'e'}, gleichgewichtet)`, m.korb));
  if (m.benchmark && m.benchmarkSymbol) zeilen.push(zeile(`${m.benchmarkSymbol} (Benchmark)`, m.benchmark));
  if (!zeilen.length) return [];
  return [
    '_Maßstab im selben Fenster — kaufen und liegenlassen, ohne Kosten, durchgehend voll investiert._',
    '',
    table(['Referenz', 'Rendite', 'MaxDD', 'Sharpe'], zeilen),
    '',
    '_Vergleichbar ist der **Sharpe**: Ertrag je Risiko, unabhängig davon, wie oft die Strategie im Markt stand. ' +
      'Eine selten investierte Strategie darf weniger Rendite haben — sie muss den besseren Sharpe haben. ' +
      'Liegt der Maßstab vorn, war die Holdout-Rendite Markt, nicht Kante._',
  ];
}

/** Bericht atomar schreiben; liefert den Pfad. */
export function writeReport(dir: string, name: string, text: string): string {
  ensureDir(dir);
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return path;
}
