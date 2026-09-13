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
import { korrelationsmatrix, type Korrelationsmatrix } from '../backtest/aktivitaet.ts';
import type { ExitKategorie, Quartile } from '../backtest/anatomie.ts';
import type { MarktBezug } from '../backtest/marktbezug.ts';
import type { BasisRun, EnsembleRun, HoldoutMarkt, KandidatAuswertung, Massstab, StrategyRun, SymbolRun } from './run.ts';
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
export function kandidatName(s: StrategyRun): string {
  return s.fixed && s.label !== null ? `${s.strategyId} · fest: ${s.label}` : s.strategyId;
}

/**
 * Maßstab je Kandidat, direkt unter den Gates: dieselben OOS-Fenster, die
 * Strategie neben kaufen-und-halten der Benchmark. Ohne Benchmark gilt die
 * Kasse — so wie `beats_market` es handhabt.
 *
 * Beide Sharpe-Werte kommen aus DEM GATE (`Massstab.oosSharpe` =
 * `beats_market.value`, `marktSharpe` = seine Schwelle), und die Zeile sagt,
 * gegen welchen Satz gerechnet wurde. Zwei verschieden gerechnete
 * Sharpe-Werte nebeneinander im selben Bericht wären der schlimmste Fall:
 * Wer den einen liest, glaubt den anderen zu verstehen.
 */
function massstabZeile(m: Massstab): string {
  const strategie = `Strategie Sharpe p. a. ${num(m.oosSharpe)}, MaxDD ${num(m.oosMaxDD)} %, Trades je Monat ${num(m.tradesPerMonth, 1)}`;
  const markt =
    m.marktSymbol === null
      ? 'ohne Benchmark: Kasse (Latte 0)'
      : m.marktSharpe === null && m.marktMaxDD === null
        ? `${m.marktSymbol} kaufen-und-halten nicht berechenbar — Latte 0 (Kasse)`
        : `${m.marktSymbol} kaufen-und-halten Sharpe ${num(m.marktSharpe)}, MaxDD ${num(m.marktMaxDD)} %`;
  return `Über dieselben OOS-Fenster: ${strategie} · ${markt} · ${m.zins}`;
}

/* ───────────────────────── Auswertung: wo das Geld hingeht ───────────────────────── */

/** Deutsche Namen der Ausstiegsgründe — ein Bericht um 7 Uhr morgens liest keine Schlüssel. */
const EXIT_NAMEN: Record<ExitKategorie, string> = {
  target: 'Ziel (Limit)',
  trailing: 'Trailing-Stop (nachgezogene Marke)',
  stop: 'Stop (Erstmarke)',
  signal: 'Signal (Strategie sagt raus)',
  eod: 'Tagesschluss (EOD-Flatten)',
  time: 'Zeit (Haltedauer abgelaufen)',
  drawdown: 'Notbremse Drawdown',
  kill_switch: 'Notbremse Tagesverlust / Kill-Switch',
  manual: 'manuell',
  reconcile: 'Abgleich mit dem Broker',
  unmanaged: 'ohne führende Strategie',
};

/** Quartils-Zeile: min · Q1 · Median · Q3 · max · n. */
function quartilZeile(name: string, q: Quartile | null, einheit: string, digits = 2): string[] {
  if (!q) return [name, einheit, '–', '–', '–', '–', '–', '0'];
  return [name, einheit, num(q.min, digits), num(q.q1, digits), num(q.median, digits), num(q.q3, digits), num(q.max, digits), String(q.n)];
}

/**
 * Exit-Anatomie: je Ausstiegsgrund Anzahl, Netto, Trefferquote, Haltedauer,
 * Beitrag. Die Tabelle, an der man sieht, ob ein Stop zu eng oder ein Ziel zu
 * nah sitzt — und die einzige Stelle im Bericht, die sagt, WO das Geld
 * hingeht statt nur WIE VIEL.
 */
function anatomieBlock(a: KandidatAuswertung): string[] {
  const an = a.anatomie;
  const out: string[] = [];
  out.push(
    `**Exit-Anatomie** — welcher Ausstiegsgrund verdient, welcher verliert? Eine Zeile je Grund über die ganze OOS-Kette ` +
      `(${an.trades} Trades, Netto ${signed(an.netto)} $).`,
  );
  out.push('');
  if (an.trades === 0) {
    out.push('_Keine abgeschlossenen Trades in der OOS-Kette._');
    out.push('');
    return out;
  }
  out.push(
    table(
      ['Ausstiegsgrund', 'Trades', 'Anteil', 'Netto Σ ($)', 'Ø je Trade ($)', 'Median ($)', 'Trefferquote', 'Ø Bars', 'Median Bars', 'Beitrag'],
      an.zeilen.map((z) => [
        EXIT_NAMEN[z.kategorie],
        String(z.anzahl),
        pct(z.anteil, 0),
        signed(z.nettoSumme),
        signed(z.nettoMittel),
        signed(z.nettoMedian),
        pct(z.trefferquote, 0),
        num(z.barsMittel, 1),
        num(z.barsMedian, 1),
        z.nettoBeitrag === null ? '–' : `${signed(z.nettoBeitrag * 100, 0)} %`,
      ]),
    ),
  );
  out.push('');
  out.push(
    '_Einheiten: „Netto Σ/Ø/Median" in USD nach allen Kosten; „Anteil" = Trades dieses Grundes an allen Trades; ' +
      '„Trefferquote" = Anteil dieser Trades mit Netto > 0; „Bars" sind Bars des Zeitrahmens (bei Tagesbars: Handelstage); ' +
      '„Beitrag" = Netto dieses Grundes am insgesamt BEWEGTEN Netto (Σ der Beträge aller Gründe), mit Vorzeichen — ' +
      'die Beträge der Spalte ergeben zusammen 100 %._',
  );
  out.push('');
  out.push(
    '_So liest man sie: Trägt **Stop (Erstmarke)** den größten negativen Beitrag, kostet die Schutzmarke mehr, als sie schützt — ' +
      'entweder sitzt sie im Rauschen (dann sagt die MAE-Tabelle darunter, wie weit der Kurs typischerweise gegen die Position läuft) ' +
      'oder die Einstiege taugen nicht; welches von beiden, entscheidet der Nachlauf. ' +
      'Trägt **Ziel (Limit)** fast den ganzen Gewinn bei kurzer Haltedauer, lebt die Taktik von wenigen Treffern — dann ist die Frage, ' +
      'wie viel Buchgewinn das Ziel liegen lässt (Spalte „mitgenommener Anteil"). ' +
      'Schneiden **Signal**, **Tagesschluss** oder **Zeit** bei hoher Trefferquote und kurzer Haltedauer ab, während die Gewinner unter ' +
      '„Ziel" viel länger laufen, ist das die Fehlerklasse des Vorgängersystems: Signal-Exits schnitten die Gewinner ab, ' +
      'Take-Profit-Exits gewannen 26 von 26 Fällen (CLAUDE.md §2). ' +
      '**Trailing-Stop** mit negativem Beitrag UND kurzer Haltedauer ist der zweite Altfall: eine Marke, die zu früh nachgezogen wird._',
  );
  if (an.stopOhneHerkunft > 0) {
    out.push('');
    out.push(
      `_${an.stopOhneHerkunft} Stop-Ausstiege ohne überlieferte Marken-Herkunft (\`stopTrailed\` fehlt) stehen unter „Stop (Erstmarke)" — ` +
        'unbekannt wird nicht zu Trailing geraten._',
    );
  }
  out.push('');
  return out;
}

/**
 * MFE/MAE: Saßen Stop und Ziel richtig? Beide Richtungen gehören in den
 * Bericht — der abgeschnittene Gewinn UND der Verlust, den der Stop verhindert
 * hat. Ein Stop, der „zu eng" aussieht, ist manchmal der Grund, dass es
 * überhaupt noch Kapital gibt.
 */
function exkursionBlock(a: KandidatAuswertung): string[] {
  const e = a.exkursion;
  const out: string[] = [];
  out.push(
    '**Saßen Stop und Ziel richtig?** — größter Buchgewinn (MFE) und größter Buchverlust (MAE) je Trade, in % vom Einstandskurs, ' +
      'gemessen ausschließlich WÄHREND der Haltezeit.',
  );
  out.push('');
  if (e.gemessen === 0) {
    out.push(`_Keine Trades mit MFE/MAE (${e.ohneDaten} ohne Kursextreme) — die Kursextreme führt der Simulator mit, ein Fake oder das Live-Buch nicht._`);
    out.push('');
    return out;
  }
  out.push(
    table(
      ['Kennzahl', 'Einheit', 'Min', 'Q1', 'Median', 'Q3', 'Max', 'n'],
      [
        quartilZeile('Gewinner: mitgenommener Anteil des Buchgewinns', e.gewinner.mitnahme, 'Faktor (1 = am Hoch raus)'),
        quartilZeile('Gewinner: MFE', e.gewinner.mfePct, '% vom Einstand'),
        quartilZeile('Gewinner: Netto', e.gewinner.nettoPct, '% vom Einstand'),
        quartilZeile('Verlierer: MAE', e.verlierer.maePct, '% vom Einstand'),
        quartilZeile('Verlierer: MFE', e.verlierer.mfePct, '% vom Einstand'),
        quartilZeile('Alle: MFE', e.alle.mfePct, '% vom Einstand'),
        quartilZeile('Alle: MAE', e.alle.maePct, '% vom Einstand'),
      ],
    ),
  );
  out.push('');
  out.push(
    `_${e.gemessen} Trades gemessen, ${e.ohneDaten} ohne Kursextreme (gehen in keine Zahl ein). ` +
      'MFE ist der beste, MAE der schlechteste Kurs während der Haltezeit, jeweils in % vom Einstand; MFE ≥ 0, MAE ≤ 0. ' +
      '„Mitgenommener Anteil" = Netto in % vom Einstand geteilt durch MFE: 1,0 heißt am Hoch ausgestiegen, 0,3 heißt, ' +
      'dass zwei Drittel des erreichten Buchgewinns liegen blieben — dann liegt das Ziel zu nah oder das Trailing zieht zu früh._',
  );
  out.push('');
  out.push(
    `_Die Kehrseite: ${e.verlierer.anzahl} Verlierer, davon ${e.verlierer.warWeiterImPlus} zwischenzeitlich WEITER im Plus, als sie am Ende im Minus schlossen. ` +
      'Die Verlierer-MAE sagt, wie weit der Kurs gegen die Position lief, bevor Schluss war — sie ist die Zahl, gegen die man eine Stop-Weite prüft. ' +
      'Nur sie allein genügt nicht: Ein weiterer Stop hätte die kleinen Verluste in große verwandelt, und keine Statistik zeigt Kapital, das es nicht mehr gibt._',
  );
  out.push('');
  return out;
}

/**
 * Der Nachlauf steht als eigener Absatz — er hängt NICHT an MFE/MAE, sondern
 * an den Bars nach dem Ausstieg, und muss auch dann erscheinen, wenn keine
 * Kursextreme überliefert sind.
 */
function nachlaufZeile(a: KandidatAuswertung): string[] {
  const n = a.nachlauf;
  if (n.verlierer === 0) return ['_Nachlauf nach Stop-Ausstiegen: kein ausgestoppter Verlierer in der OOS-Kette._', ''];
  const quote = n.geprueft > 0 ? pct(n.erholt / n.geprueft, 0) : '–';
  return [
    `_Nachlauf nach Stop-Ausstiegen (Was-wäre-wenn, ${n.horizont} Bars nach dem Ausstieg, Blick endet mit der OOS-Kette — kein Holdout): ` +
      `von ${n.verlierer} ausgestoppten Verlierern waren ${n.geprueft} prüfbar (${n.ohneDaten} ohne Folgebars); ` +
      `${n.erholt} davon (${quote}) erreichten im Horizont wieder den Einstandskurs. ` +
      'Das ist eine OBERGRENZE: gerechnet wird brutto gegen den Einstand, ohne Kosten und ohne die Frage, ob das Konto den Weg dorthin ausgehalten hätte. ' +
      'Eine hohe Quote heißt, dass der Stop Gewinner abschneidet; eine niedrige, dass er genau das tut, wofür er da ist. ' +
      'Die Zahl entscheidet nichts — sie ist nie Teil eines Gates und darf es nicht werden (sie sieht Bars nach dem Ausstieg)._',
    '',
  ];
}

/** Aktivität: „aktiv, nicht hyperaktiv" in Zahlen (docs/wissen/aktivitaet.md). */
function aktivitaetBlock(a: KandidatAuswertung, m: Massstab): string[] {
  const k = a.aktivitaet;
  const out: string[] = [];
  out.push('**Aktivität über die OOS-Kette** — wie oft, wie lange und mit wie viel Kapital war der Kandidat überhaupt im Markt?');
  out.push('');
  const pause =
    k.laengstePause === null
      ? '–'
      : `${k.laengstePause}${k.pauseVon && k.pauseBis ? ` (${k.pauseVon} … ${k.pauseBis})` : ''}`;
  out.push(
    table(
      ['Kennzahl', 'Wert', 'Einheit / Definition'],
      [
        ['Trades', String(k.trades), 'abgeschlossene Round-Trips über alle Symbole der OOS-Kette'],
        ['Trades je Monat', num(m.tradesPerMonth, 1), `Round-Trips je 30,44 Kalendertage (${num(m.oosDays, 0)} OOS-Kalendertage) — dieselbe Zahl wie in der Maßstab-Zeile`],
        ['Zeit im Markt', k.zeitImMarkt === null ? '–' : pct(k.zeitImMarkt, 0), `Anteil der Handelstage mit mindestens einer offenen Position (Quelle: ${k.zeitImMarktQuelle ?? 'nicht bewertbar'})`],
        ['Gleichzeitige Positionen', k.mittlerePositionen === null ? '–' : num(k.mittlerePositionen, 2), 'Mittel über die Bars der OOS-Fenster (Positionen, die am Fensterende offen blieben, fehlen)'],
        ['Gebundenes Kapital', k.mittlereExposurePct === null ? 'nicht bewertbar' : `${num(k.mittlereExposurePct, 1)} %`, 'Mittel der Brutto-Exposure je Bar (Σ |Stück × Schluss| / Equity)'],
        ['Längste Phase ohne Einstieg', pause, 'Handelstage der OOS-Fenster ohne einen einzigen neuen Einstieg (Ränder eingerechnet)'],
        ['Gemessene Handelstage', String(k.handelstage), 'Handelstage mit Bars in den OOS-Fenstern'],
      ],
    ),
  );
  out.push('');
  out.push(
    '_Zielband aus docs/wissen/aktivitaet.md: 2–10 Trades je Monat und Konto, Median-Haltedauer ≥ 10 Handelstage. ' +
      'Unter etwa einem Trade je Monat entsteht kein Journal, aus dem `readiness` je etwas lernen könnte; darüber frisst der Umschlag die Kante. ' +
      'Die längste Phase ohne Einstieg ist die Zahl, die man im Betrieb spürt — sie sagt, wie lange das Konto stillstehen kann, ohne dass etwas kaputt ist._',
  );
  if (!a.konsistent) {
    out.push('');
    out.push(`⚠ _Der Auswertungslauf weicht vom Walk-Forward ab: ${a.hinweis ?? ''} — die Zahlen dieses Abschnitts sind nicht belastbar._`);
  }
  out.push('');
  return out;
}

/**
 * Korrelationsmatrix der Tagesrenditen aller gemessenen Kandidaten. Ohne sie
 * ist jede Ensemble-Entscheidung geraten: Zwei Taktiken mit Sharpe 0,6 und
 * Korrelation 0,9 sind eine Taktik.
 */
function korrelationsAbschnitt(runs: readonly SymbolRun[]): string[] {
  const reihen: { name: string; reihe: KandidatAuswertung['renditen'] }[] = [];
  for (const r of runs) {
    for (const s of r.results) {
      if (s.auswertung && s.auswertung.renditen.tage.length > 0) reihen.push({ name: `${r.symbol} · ${kandidatName(s)}`, reihe: s.auswertung.renditen });
    }
  }
  const out: string[] = ['## Korrelationsmatrix der Tagesrenditen', ''];
  if (reihen.length < 2) {
    out.push(`_Weniger als zwei gemessene Kandidaten mit Renditereihe (${reihen.length}) — keine Matrix._`);
    out.push('');
    return out;
  }
  const k: Korrelationsmatrix = korrelationsmatrix(reihen);
  out.push(
    'Frage: Lohnt ein Ensemble aus mehreren dieser Taktiken? Das entscheidet die Korrelation ihrer Tagesrenditen — nichts sonst. ' +
      'Zwei Kandidaten mit gleichem Sharpe und Korrelation 0,9 sind ein Kandidat; bei 0,1 sind sie ein deutlich besseres Portfolio.',
  );
  out.push('');
  const kuerzel = k.namen.map((_, i) => `K${i + 1}`);
  out.push(table(['Kürzel', 'Kandidat'], k.namen.map((n, i) => [kuerzel[i]!, n])));
  out.push('');
  out.push(
    table(
      ['', ...kuerzel],
      k.namen.map((_, i) => [kuerzel[i]!, ...k.werte[i]!.map((v) => (v === null ? '–' : num(v, 2)))]),
    ),
  );
  out.push('');
  out.push(
    `**Durchschnittskorrelation: ${k.durchschnitt === null ? '–' : num(k.durchschnitt, 2)}** ` +
      `(Mittel über alle berechenbaren Paare oberhalb der Diagonalen${k.zuWenigeTage > 0 ? `; ${k.zuWenigeTage} Paare mit weniger als ${k.mindestTage} gemeinsamen Tagen bleiben „–"` : ''}).`,
  );
  out.push('');
  out.push(
    '_Einheit: Pearson-Korrelation in [−1, +1] auf den TAGESRENDITEN der OOS-Kette. ' +
      'Zwei Regeln, ohne die die Zahl falsch gelesen wird: (1) Verglichen wird je Paar nur auf den GEMEINSAMEN Handelstagen — ' +
      'ein Tag, den ein Kandidat gar nicht gemessen hat, ist kein Datenpunkt und wird weggelassen, nicht mit 0 gefüllt. ' +
      '(2) Ein gemessener Tag OHNE Position hat die Rendite 0, und die zählt mit: nicht investiert heißt kein Ertrag. ' +
      'Das ist ausdrücklich KEINE bedingte Korrelation „wenn beide investiert sind" — gerade die Tage, an denen der eine steht und der andere läuft, ' +
      `sind der Grund, warum ein Ensemble glätten würde. Gemeinsame Tage je Paar: ${k.minGemeinsameTage ?? '–'} bis ${k.maxGemeinsameTage ?? '–'}._`,
  );
  out.push('');
  return out;
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
  if (o.ensembles.length > 0) {
    out.push(
      `- Ensembles (mehrere Sleeves als EINE Einheit, EINE Simulation, DIESELBEN zehn Alpha-Gates — keine dritte Latte): ` +
        o.ensembles
          .map((e) => `„${e.label}" (${e.weighting === 'equal' ? 'gleichgewichtet' : 'inverse Vola, Fenster 60 Handelstage'}): ${e.sleeves.map((sl) => sl.strategy).join(' + ')}`)
          .join('; '),
    );
  }
  out.push(
    o.riskFreeSymbol === null
      ? '- Risikoloser Zins: **keiner konfiguriert** (`optimizer.riskFreeSymbol: null`) — `probabilistic_sharpe_oos` und `beats_market` rechnen Ertrag über NULL je Schwankung. ' +
          'Mit einem Geldmarktpapier im Korb wird dabei Bargeld als Kante verbucht (Befund B2, 12.09.2026).'
      : `- Risikoloser Zins: Tagesrendite von **${o.riskFreeSymbol}** — \`probabilistic_sharpe_oos\` und \`beats_market\` rechnen auf Überschussrenditen (r − r_f derselben Tage), ` +
        'auf BEIDEN Seiten oder auf keiner. Jede Gate-Notiz sagt, was tatsächlich gerechnet wurde.',
  );
  // Der Maßstab ALLER Gate-Kennzahlen — eine Zeile, damit niemand eine
  // Überschuss-Zahl für ein Konto-Netto hält (Vorregistrierung
  // `docs/wissen/vorregistrierung/2026-09-13-gates-auf-ueberschuss.md`).
  out.push(
    o.riskFreeSymbol === null
      ? '- **Maßstab der Gate-Kennzahlen: ROHES Netto.** Ohne Zinsreihe zählt jeder Zinsertrag auf brachliegender Kasse als Gewinn der Strategie — ' +
          'mit eingeschaltetem `risk.cashParking` scheitert ein Lauf deshalb, statt still falsch zu rechnen.'
      : `- **Maßstab der Gate-Kennzahlen: ÜBERSCHUSS über ${o.riskFreeSymbol}.** \`fold_positive_share\`, \`oos_net_profit\`, \`fold_concentration\`, \`stress_costs\`, ` +
        'der Anteil positiver Nachbarn in `neighborhood_plateau` und die Gruppe `basis` rechnen Netto als `E₀ · (Π(1 + r − r_f) − 1)` — ein Quartal ohne einen Trade ' +
        'ist damit KEIN positiver Fold. Roh bleiben bewusst: **MaxDD** (und `basis_drawdown`) als Kapitalgröße, wie die Notbremsen sie live messen und wie sein Maßstab ' +
        'sie rechnet, sowie die Zielfunktion (`objective`, Suchkriterium — für 0 Trades ohnehin −∞) und `deflated_sharpe_is`. `oos_trades` und `fee_share` sind ' +
        'zinsfrei per Bauart: Sie zählen Trades, und eine Treasury-Umschichtung ist keiner. **Drawdown-Zahlen sind deshalb nicht mit Überschuss-Zahlen verrechenbar.**',
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
      runs.map((r) =>
        r.art === 'basis'
          ? [r.symbol, 'Basis-Einheit', r.basis ? `Block basis: ${r.basis.strategy} ${paramsJson(r.basis.params)} — ${r.basis.pass ? 'bestanden' : 'nicht bestanden'}` : '— (nicht gemessen)', '–', r.decision.reason]
          : [
              r.symbol,
              r.decision.action,
              r.chosen ? `${r.chosen.strategy}${r.chosen.fixed ? ' (fest)' : ''} ${paramsJson(r.chosen.params)}` : '— (kein Handel)',
              r.chosen ? num(r.chosen.score, 3) : '–',
              r.decision.reason,
            ],
      ),
    ),
  );
  out.push('');
  // Die zweite Latte hat ihre eigene Zeile — sie steht nicht in der Tabelle,
  // weil sie um nichts konkurriert, und sie fehlt nie stumm.
  if (festBasis.length > 0) {
    for (const r of runs) out.push(basisZusammenfassung(r, festBasis[0]!));
    out.push('');
  }
  // Ensembles stehen ebenfalls außerhalb der Tabelle: Sie konkurrieren um
  // nichts und werden in diesem Lauf nie befördert.
  const ensembleLaeufe = runs.flatMap((r) => (r.ensembles ?? []).map((e) => ({ symbol: r.symbol, e })));
  if (ensembleLaeufe.length > 0) {
    for (const { symbol, e } of ensembleLaeufe) {
      const gerissen = e.gates.filter((g) => !g.pass).map((g) => g.name);
      out.push(
        `Ensemble ${symbol} · „${e.label}" (${e.regel === 'equal' ? 'gleichgewichtet' : 'inverse Vola'}): ` +
          `${e.pass ? '**alle zehn Alpha-Gates bestanden**' : `nicht bestanden (${gerissen.join(', ')})`} — ` +
          `${e.messung.wfa.oos.trades} OOS-Trades, netto ${signed(e.messung.wfa.oos.netProfit)}, Folds positiv ` +
          `${Math.round(e.messung.wfa.oos.positiveFoldShare * e.messung.wfa.folds.length)}/${e.messung.wfa.folds.length}. ` +
          'Auch bestanden heißt NICHT befördert: siehe Versuchszählung im eigenen Abschnitt.',
      );
    }
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
    if (r.art === 'basis') {
      out.push('_Eigene Einheit der Basis-Allokation (optimizer.basisUniverse): keine Alpha-Kandidaten, keine Alpha-Entscheidung — `symbols`/`noTrade` der Champion-Datei bleiben unberührt._');
      out.push('');
    } else if (r.results.length === 0) {
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

    out.push(r.art === 'basis' ? `**Basis-Einheit** — ${r.decision.reason}` : `**Entscheidung: ${r.decision.action}** — ${r.decision.reason}`);
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
      // Wo das Geld hingeht: Exit-Anatomie, MFE/MAE, Aktivität. Reine Messung —
      // kein Gate liest eine dieser Zahlen (siehe backtest/anatomie.ts).
      if (s.auswertung) {
        out.push(...anatomieBlock(s.auswertung));
        out.push(...exkursionBlock(s.auswertung));
        out.push(...nachlaufZeile(s.auswertung));
        out.push(...aktivitaetBlock(s.auswertung, s.massstab));
      } else {
        out.push('_Keine Auswertung (Exit-Anatomie, MFE/MAE, Aktivität) für diesen Kandidaten — siehe Fehlerliste des Symbols._');
        out.push('');
      }
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

    for (const e of r.ensembles ?? []) out.push(...ensembleAbschnitt(r.symbol, e, r.holdoutMarkt, meta));
    if (r.basis) out.push(...basisAbschnitt(r.symbol, r.basis, r.holdoutMarkt, meta));
  }

  out.push(...korrelationsAbschnitt(runs));

  return out.join('\n');
}

/* ───────────────────────── Ensemble ───────────────────────── */

/**
 * Der Abschnitt einer Ensemble-Einheit.
 *
 * Er muss drei Fragen beantworten, sonst ist er wertlos: Hält die Einheit die
 * zehn Gates? WIRKT die Diversifikation, oder trägt ein Sleeve alles? Und wie
 * viele Einheiten wurden auf denselben Daten probiert? Die dritte Frage ist
 * die wichtigste — wer sechs Dinge probiert und eines bestanden sieht, liest
 * sonst einen Einzelbeweis, wo eine Auswahl steht.
 */
function ensembleAbschnitt(symbol: string, e: EnsembleRun, holdoutMarkt: HoldoutMarkt | null, meta: ReportMeta): string[] {
  const m = e.messung;
  const w = m.wfa;
  const out: string[] = [];
  out.push(`### ${symbol} · Ensemble „${e.label}" (${e.regel === 'equal' ? 'gleichgewichtet' : 'inverse Vola, 60 Handelstage'})`);
  out.push('');
  out.push(
    `${m.plan.sleeves.length} Sleeves in EINER Portfolio-Simulation über dieselben ${w.folds.length} Folds wie jeder andere Kandidat — ` +
      `ein Konto, ein Positionslimit, eine Notbremse; dieselben Kosten, derselbe Stress ×${meta.optimizer.stressCostMultiplier}, ` +
      `Embargo ${w.embargoBars} Bars (Maximum über die Sleeves, Warmup der Einheit ${m.plan.warmupBars} Bars). ` +
      '**Dieselben zehn Alpha-Gates, unverändert** — ein Ensemble ist ein Kandidat für die bestehende Latte, keine dritte Latte (§0.9). ' +
      'Keine Suche: Die Parameter jedes Sleeves sind vorregistriert, der Deflated Sharpe ist deshalb „nicht anwendbar".',
  );
  out.push('');
  out.push(`**Versuchszählung: ${e.versuche}**`);
  out.push('');
  out.push(`**Gates: ${e.pass ? 'bestanden' : `nicht bestanden (${e.gates.filter((g) => !g.pass).map((g) => g.name).join(', ')})`}**`);
  out.push('');
  out.push(gatesTable(e.gates));
  out.push('');
  out.push(massstabZeile(e.massstab));
  out.push('');
  out.push(`PSR (OOS): ${e.psr.note}`);
  out.push('');
  out.push(`DSR (IS): nicht anwendbar (vorregistrierte Parameter je Sleeve, keine Suche) — ${e.dsr.note}`);
  out.push('');

  /* ── Zusammensetzung ── */
  out.push('**Zusammensetzung** — wer trägt was, und mit welchem Anteil?');
  out.push('');
  out.push(
    table(
      ['Sleeve', 'Strategie', 'Parameter', 'Universum', 'Gewicht ⌀', 'Plätze Soll ⌀', 'Plätze Ist', 'Trades', 'Netto', 'Anteil am Netto', 'Gebühren'],
      m.beitraege.map((b) => {
        const sl = m.plan.sleeves[b.index]!;
        return [
          b.label,
          b.strategy,
          paramsJson(sl.params),
          sl.universe === 'korb' ? 'Korb je Fold' : `fest (${sl.symbols.length}): ${sl.symbols.join(', ')}`,
          pct(b.mittleresGewicht, 1),
          num(b.mittlerePlaetze, 2),
          String(b.plaetzeIst),
          String(b.trades),
          signed(b.netProfit),
          b.anteilAmNetto === null ? '–' : pct(b.anteilAmNetto, 1),
          num(b.fees),
        ];
      }),
    ),
  );
  out.push('');
  out.push(
    '_„Gewicht ⌀" ist die REGEL im Mittel über alle Fenster, „Plätze Soll ⌀" ihre Umrechnung in ein Positionslimit je Sleeve ' +
      '(jeder Sleeve mindestens einer, Rest nach größtem Anspruch, Summe = `risk.maxPositions`). ' +
      '„Plätze Ist" ist die größte Zahl GLEICHZEITIG offener Positionen, die dieser Sleeve im gemeinsamen Lauf wirklich hatte. ' +
      '**Soll und Ist können auseinanderfallen, und der Bericht behauptet nicht das Gegenteil:** `decide()` (core/logic.ts) kennt heute nur ein ' +
      'globales `maxPositions` — das Soll ist ein Plan, noch keine Schranke. Liegt ein Ist deutlich über seinem Soll, während ein anderer ' +
      'Sleeve unter seinem bleibt, hat dieser Sleeve dem anderen die Plätze genommen (Prüfbefund M5 der Basis-Prüfung: wer einen Korb-Rang ' +
      'hat, konkurriert vor den Ranglosen). Dann ist die gemessene Einheit nicht die geplante._',
  );
  out.push('');
  if (m.fehlend.length > 0) {
    out.push(`_Vorregistrierte Sleeve-Symbole ohne Bars im Messfenster (fehlen im Sleeve): ${m.fehlend.join(', ')}._`);
    out.push('');
  }
  if (m.entzogen.length > 0) {
    out.push(
      `_**Der Korb-Sleeve läuft auf einem kleineren Korb als allein.** Im letzten gemessenen Fenster führten feste Sleeves ${m.entzogen.length} Symbole, ` +
        `die auch im Punkt-in-Zeit-Korb standen: ${m.entzogen.join(', ')}. In EINER Simulation trägt ein Symbol genau EINE Strategie — live genauso, ` +
        'eine Position mit einem Stop (§0.6). Die Zahlen dieses Sleeves sind deshalb NICHT die seiner Einzelmessung, und ein Vergleich „Ensemble gegen Sleeve allein" ' +
        'vergleicht auch zwei Körbe._',
    );
    out.push('');
  }

  /* ── Korrelation: wirkt die Diversifikation? ── */
  out.push('**Korrelationsmatrix der Sleeve-Renditen** — die eine Zahl, an der hängt, ob ein Ensemble überhaupt etwas bringt.');
  out.push('');
  const k = m.korrelation;
  const kuerzel = k.namen.map((_, i) => `S${i + 1}`);
  out.push(table(['Kürzel', 'Sleeve'], k.namen.map((n, i) => [kuerzel[i]!, n])));
  out.push('');
  out.push(
    table(
      ['', ...kuerzel],
      k.namen.map((_, i) => [kuerzel[i]!, ...k.werte[i]!.map((v) => (v === null ? '–' : num(v, 2)))]),
    ),
  );
  out.push('');
  out.push(
    `**Durchschnittskorrelation: ${k.durchschnitt === null ? '–' : num(k.durchschnitt, 2)}** ` +
      `(Mittel über alle berechenbaren Paare oberhalb der Diagonalen; gemeinsame Tage je Paar ${k.minGemeinsameTage ?? '–'} bis ${k.maxGemeinsameTage ?? '–'}` +
      `${k.zuWenigeTage > 0 ? `; ${k.zuWenigeTage} Paare unter ${k.mindestTage} Tagen bleiben „–"` : ''}).`,
  );
  out.push('');
  out.push(
    '_Quelle der Reihen: je Sleeve ein SOLO-Lauf über dieselben Fenster — dieselben Kosten, dasselbe Konto, nur ohne die anderen Sleeves; ' +
      'eingeschränkt auf die Handelstage der OOS-Kette. Aus dem gemeinsamen Lauf lässt sich keine Sleeve-Rendite herausrechnen (eine Equity-Kurve, ein Konto), ' +
      'und eine Korrelation aus zugerechneten Trades wäre keine Renditekorrelation. Ein gemessener Tag OHNE Position hat die Rendite 0, und die zählt — ' +
      'gerade die Tage, an denen der eine steht und der andere läuft, sind der Grund, warum ein Ensemble glätten würde. ' +
      'Dieselben Solo-Reihen tragen die Gewichtsregel `inverse_vol`._',
  );
  out.push('');

  /* ── Wer trägt welchen Fold? ── */
  out.push('**Je Fold: wer hat ihn getragen?** Ein Ensemble, dessen Folds alle von demselben Sleeve getragen werden, ist kein Ensemble.');
  out.push('');
  out.push(
    table(
      ['Fold', 'OOS', 'Netto gesamt', ...m.plan.sleeves.map((sl) => `Netto ${sl.label}`), 'Träger'],
      m.foldTraeger.map((ft, i) => {
        const gesamt = w.folds[i]?.best.oosMetrics.netProfit ?? 0;
        return [
          String(ft.fold.index + 1),
          `${isoDay(ft.fold.oosStart)} … ${isoDay(ft.fold.oosEnd)}`,
          signed(gesamt),
          ...ft.netto.map((n, j) => `${signed(n)} (${ft.trades[j]})`),
          ft.traeger === null ? '— (kein Trade)' : m.plan.sleeves[ft.traeger]!.label,
        ];
      }),
    ),
  );
  out.push('');
  const getragen = new Map<string, number>();
  for (const ft of m.foldTraeger) {
    if (ft.traeger === null) continue;
    const name = m.plan.sleeves[ft.traeger]!.label;
    getragen.set(name, (getragen.get(name) ?? 0) + 1);
  }
  out.push(
    `_Träger = größter Netto-Beitrag im Fenster; Klammern = Trades des Sleeves. Verteilung: ${[...getragen.entries()].map(([n, c]) => `${n} ${c}×`).join(', ') || '—'} ` +
      `über ${m.foldTraeger.length} Folds. Die Zurechnung läuft über Trade.strategy — deshalb darf eine Strategie je Ensemble nur einmal vorkommen (parseConfig)._`,
  );
  out.push('');

  /* ── Die Gewichtsregel, Fenster für Fenster ── */
  const oosStaende = m.staende.filter((st) => st.fenster.endsWith('OOS'));
  if (oosStaende.length > 0) {
    out.push('**Die Gewichtsregel, Fenster für Fenster** (nur die OOS-Fenster; IS, finales Fenster und Holdout laufen nach derselben Regel).');
    out.push('');
    out.push(
      table(
        ['Fenster', 'gültig ab', ...m.plan.sleeves.map((sl) => `${sl.label}: Gewicht / Plätze`), 'Grund'],
        oosStaende.map((st) => [
          st.fenster,
          st.tag,
          ...st.gewichte.map((g, j) => `${pct(g, 1)} / ${st.plaetze[j]}`),
          st.aufwaermphase ? 'Aufwärmphase ⇒ gleichgewichtet' : st.grund,
        ]),
      ),
    );
    out.push('');
    out.push(
      '_Kausal: Die Gewichte eines Fensters entstehen aus Handelstagen VOR seinem ersten Tag — nie aus dem Fenster selbst. ' +
        'Das Vola-Fenster ist auf 60 Handelstage vorregistriert und steht als Konstante im Code (`VOLA_FENSTER`), nicht in der Config: ' +
        'Ein Fenster, an dem man drehen kann, ist ein Parameter, und ein Parameter in einer Gewichtsregel ist Gewichtsoptimierung. ' +
        'Fehlt einem Sleeve die Streuung, gilt für ALLE gleichgewichtet — eine geratene Streuung wäre schlimmer als keine._',
    );
    out.push('');
  }

  /* ── Innenleben und Aktivität ── */
  if (e.auswertung) {
    out.push(...anatomieBlock(e.auswertung));
    out.push(...exkursionBlock(e.auswertung));
    out.push(...aktivitaetBlock(e.auswertung, e.massstab));
  }

  out.push(
    table(
      ['Fold', 'IS', 'OOS', 'IS-Objective', 'OOS-Objective', 'OOS-Trades', 'OOS-Netto'],
      w.folds.map((f) => [
        String(f.fold.index + 1),
        `${isoDay(f.fold.isStart)} … ${isoDay(f.fold.isEnd)}`,
        `${isoDay(f.fold.oosStart)} … ${isoDay(f.fold.oosEnd)}`,
        num(f.best.isObjective, 3),
        num(f.best.oosObjective, 3),
        String(f.best.oosMetrics.trades),
        signed(f.best.oosMetrics.netProfit),
      ]),
    ),
  );
  out.push('');
  if (w.holdout) {
    out.push(
      `**Holdout ${isoDay(w.holdout.start)} … ${isoDay(w.holdout.end)} — nur Bericht, nicht Auswahl.** ` +
        'Diese Zahlen haben nichts ausgewählt und dürfen es auch rückwirkend nicht.',
    );
    out.push('');
    out.push(table(METRICS_HEADER, [metricsRow(w.holdout.metrics)]));
    const markt = marktBlock(holdoutMarkt);
    if (markt.length) out.push('', ...markt);
  } else {
    out.push('_Kein Holdout konfiguriert (optimizer.holdoutDays = 0)._');
  }
  out.push('');
  out.push(
    '_Diese Einheit wird in diesem Lauf NICHT befördert, auch wenn alle zehn Gates halten. Zwei Gründe, beide vor dem Lauf festgeschrieben: ' +
      '(1) Die Vorregistrierung verlangt dasselbe Urteil auf mindestens zwei weiteren Stichtagen (`--as-of`), bevor etwas Champion wird — ' +
      'bei sechs vorregistrierten Einheiten auf denselben Daten ist ein einzelnes Bestehen kein Beleg. ' +
      '(2) Das Champion-Format trägt eine Strategie und einen Parametersatz je Symbol; ein Ensemble trägt mehrere._',
  );
  out.push('');
  return out;
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
  out.push(
    `Korb (${b.symbols.length} Symbol${b.symbols.length === 1 ? '' : 'e'}): ${b.symbols.join(', ')}. ` +
      `Sizing: Allokation, Position ${b.positionPct} % der Equity je Symbol (optimizer.basis.positionPct) — ` +
      'riskPerTradePct der Config ist für die Basis ohne Wirkung; Positionsdeckel, Exposure-Budget, Positionslimit und Bargeld gelten. ' +
      'Genau diese Semantik handelt die Basis-Stufe der Engine (Block basis: positionPct).',
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
  // Welche Zahlen die GATES gelesen haben — die Kennzahlenzeile darüber ist
  // die rohe Sicht, und die beiden dürfen nicht verwechselt werden.
  out.push(
    k.ueberschussNetProfit === null || k.ueberschussNetProfit === undefined
      ? `_Maßstab der Gates dieses Blocks: **rohes Netto**. ${k.zins ?? ''}_`
      : `_Maßstab der Gates dieses Blocks: **Überschuss über dem Zins** — Netto ${signed(k.ueberschussNetProfit)} statt roh ${signed(k.netProfit)}, ` +
        `bei Kosten ×${b.stressCostMultiplier} ${signed(k.ueberschussStressNetProfit ?? 0)}, Sharpe p. a. ${num(k.ueberschussSharpe)} statt roh ${num(k.sharpe)}. ` +
        `MaxDD und MaxDD je Einheit Exposure bleiben ROH (Kapitalsicht, wie der Maßstab daneben) und sind mit den Überschuss-Zahlen nicht verrechenbar. ${k.zins ?? ''}_`,
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
