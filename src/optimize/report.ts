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
import type { SymbolRun } from './run.ts';
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
        r.chosen ? `${r.chosen.strategy} ${paramsJson(r.chosen.params)}` : '— (kein Handel)',
        r.chosen ? num(r.chosen.score, 3) : '–',
        r.decision.reason,
      ]),
    ),
  );
  out.push('');

  for (const r of runs) {
    out.push(`## ${r.symbol}`);
    out.push('');
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
            s.strategyId,
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
        `Amtierender Champion: ${r.incumbent.strategy} ${paramsJson(r.incumbent.params)} (Score bei Beförderung ${num(r.incumbent.score, 3)}, ` +
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
      out.push(`### ${r.symbol} · ${s.strategyId}`);
      out.push('');
      out.push(`finalParams: \`${paramsJson(s.wfa.finalParams)}\` (Suche auf ${isoDay(s.wfa.finalWindow.start)} … ${isoDay(s.wfa.finalWindow.end)}, ${s.wfa.trials} Trials, Embargo ${s.wfa.embargoBars} Bars)`);
      out.push('');
      out.push(gatesTable(s.gates));
      out.push('');
      // Die Rohwerte beider Sharpe-Gates gehören sichtbar in den Bericht: Ein
      // Gate, das nur "0.000" sagt, lässt sich nicht hinterfragen.
      out.push(`PSR (OOS): ${s.psr.note}`);
      out.push('');
      out.push(`DSR (IS): ${s.dsr.note}`);
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
      } else {
        out.push('_Kein Holdout konfiguriert (optimizer.holdoutDays = 0)._');
      }
      out.push('');
    }
  }

  return out.join('\n');
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
