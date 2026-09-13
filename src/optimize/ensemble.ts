/**
 * Die Ensemble-Einheit: mehrere Sleeves, EINE Portfolio-Simulation, dieselben
 * zehn Alpha-Gates.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────
 *
 * Der Optimierer messe bisher jede Strategie-Familie EINZELN und verwerfe
 * jede EINZELN (Ursache 4 in `docs/wissen/analysen/2026-09-12-warum-nichts-
 * gehandelt-wird.md`). Gemessen über 18 bzw. 16 Folds mit dem Bärenmarkt
 * 2022 im Fenster:
 *
 *   momentum_pullback   Sharpe 0,64 · 572 Trades · fällt an `fold_positive_share`
 *                       (0,500) und `fold_concentration` (0,647)
 *   vigilant_allocation Sharpe 0,73 ·  27 Trades · fällt an `oos_trades` (60)
 *
 * Der eine hat Ertrag ohne Beständigkeit, der andere Beständigkeit ohne
 * Trades. Genau die zwei Mängel, die diese Gates messen, bessert
 * Diversifikation — wenn die Quellen wirklich unabhängig sind. Sind sie es
 * nicht, besteht das Ensemble nicht, und das ist die richtige Antwort.
 *
 * ── Was hier NICHT passiert ──────────────────────────────────────────────
 *
 * - **Kein Gate wird angefasst.** Ein Ensemble ist ein KANDIDAT für die
 *   bestehende Alpha-Latte, keine dritte Latte (CLAUDE.md §0.9). Es läuft
 *   durch `robustnessGates` wie jeder Festkandidat, mit `fixed: true` (keine
 *   Suche ⇒ der Deflated Sharpe ist „nicht anwendbar", alle anderen neun
 *   gelten in voller Schärfe).
 * - **Keine Suche, keine Gewichtsoptimierung.** Zusammensetzung, Parameter
 *   und Gewichtsregel stehen VOR dem Lauf in
 *   `docs/wissen/vorregistrierung/2026-09-12-ensemble.md`. Wer Gewichte
 *   optimiert, hat so viele Freiheitsgrade wie Sleeves und misst am Ende
 *   sein Gitter. Das Vola-Fenster ist deshalb eine Konstante in DIESER
 *   Datei (`VOLA_FENSTER`) und keine Config-Achse.
 * - **Keine zweite Rangliste.** Der Korb-Rang entsteht ausschließlich in
 *   `decide()` (§0.2). Dass die Sleeves getrennt rangieren, besorgt
 *   `korbSchluessel` (Strategie + Parameter + Sizing-Semantik) von selbst —
 *   hier wird nichts sortiert und nichts bewertet.
 * - **Kein zweiter Entscheidungspfad.** Die Einheit läuft durch denselben
 *   Simulator und damit dieselbe `decide()` wie jeder andere Kandidat
 *   (`simulateKorbWindow`); heterogen ist nur die WAHL je Symbol, und die
 *   kennt `SimInput.strategyFor` seit jeher.
 *
 * ── Die drei Regeln dieser Datei ─────────────────────────────────────────
 *
 * 1. **Universum je Sleeve.** Ein Sleeve bekommt entweder den
 *    liquiditätsgewählten Korb je Fold (Punkt-in-Zeit wie jeder
 *    Aktien-Kandidat) oder eine feste, vorregistrierte Symbolliste. Beides
 *    zugleich gibt es nicht, und ein Symbol gehört genau EINEM Sleeve —
 *    sonst wäre nicht bestimmt, welche Strategie es führt. Die feste Liste
 *    läuft am Membership-Filter VORBEI: Sie ist die Vorregistrierung, nicht
 *    das Ergebnis einer Auswahl, und der nach Dollarumsatz rangierte Korb
 *    kann bauartbedingt kein defensives Papier enthalten (Lauf #43).
 * 2. **Gewichte sind eine Regel.** `equal` oder `inverse_vol` (Anteil ∝ 1/σ
 *    der eigenen Renditen über `VOLA_FENSTER` Handelstage). Kausal: Für ein
 *    Fenster, das bei t beginnt, zählen nur Handelstage VOR t. In der
 *    Aufwärmphase — solange ein Sleeve keine `VOLA_FENSTER` Tage hat oder
 *    seine Streuung nicht bestimmbar ist — gilt gleichgewichtet.
 * 3. **Das Embargo ist das MAXIMUM über die Sleeves.** Der langsamste
 *    bestimmt: `vigilant_allocation` hat 255 Bars Warmup, also ein
 *    automatisches Embargo von 275 Bars; ein IS-Fenster von 365 Kalendertagen
 *    (~252 Bars) wird davon ganz verschluckt. Das scheitert hier LAUT
 *    (`ensembleEmbargoEnde`) und misst nicht still ein leeres Fenster.
 *
 * ── Die bekannte Lücke, benannt und nicht beschönigt ─────────────────────
 *
 * Der Anteil eines Sleeves soll auf sein BUDGET wirken. Im Alpha-Pfad ist
 * das Budget das Risiko je Trade über die Stop-Distanz (`risk/sizing.ts`),
 * und die Währung, in der ein Sleeve dort Kapital bindet, ist die Zahl
 * gleichzeitiger Positionen. Deshalb rechnet `plaetzeJeSleeve` aus den
 * Gewichten ein Positionslimit je Sleeve. **`decide()` kennt heute nur ein
 * globales `maxPositions`** (core/logic.ts) — der Plan ist damit noch keine
 * Schranke, sondern ein Soll. Was dieser Modul dagegen kann und tut: Er
 * misst je Fold, wie viele Plätze ein Sleeve WIRKLICH belegt hat
 * (`plaetzeIst`), und der Bericht stellt Soll und Ist nebeneinander. Ein
 * Sleeve, der die anderen verdrängt, ist damit eine Zahl und keine Hoffnung.
 * Was `core/logic.ts` dafür bräuchte, steht in `docs/wissen/` und im
 * Bericht — es sind eine Gruppe je `SymbolInput` und ein Zähler je Gruppe.
 */
import { korrelationsmatrix, tagesrenditen, type Korrelationsmatrix, type Renditereihe } from '../backtest/aktivitaet.ts';
import { ROHES_NETTO_NOTE, type RiskFreeSeries } from '../backtest/metrics.ts';
import type { EnsembleConfig } from '../core/config.ts';
import type { OptimizerConfig } from '../core/config.ts';
import { dayKeyFor } from '../core/time.ts';
import type { AssetClass, BarSeriesLike, Ms, Params, SimResult, Strategy, TimeframeMin, Trade } from '../core/types.ts';
import type { Calendar } from '../core/time.ts';
import { mean, median, objectiveValue } from './objective.ts';
import { ueberschussNettoVon, type NeighborhoodResult, type StressResult } from './robustness.ts';
import { neighbors, wirksamerSuchraum } from './search.ts';
import {
  aggregateOos,
  embargoedEnd,
  embargoBarsFor,
  korbZum,
  oosPieceOf,
  simulateKorbWindow,
  type Fold,
  type KorbSimArgs,
  type Membership,
  type OosPiece,
  type SimConfig,
  type SimulateFn,
  type TimeRange,
  type Wahl,
  type WfaFoldResult,
  type WfaResult,
  type Zeitachse,
} from './walkForward.ts';

/**
 * Fenster der realisierten Volatilität für `inverse_vol`, in HANDELSTAGEN.
 *
 * Vorregistriert am 12.09.2026 („Das Fenster ist hiermit auf 60 festgelegt;
 * es wird nicht variiert") und deshalb eine Konstante und keine Config-Achse:
 * Ein Fenster, an dem man drehen kann, ist ein Parameter, und ein Parameter
 * in einer Gewichtsregel ist genau die Gewichtsoptimierung, die die
 * Vorregistrierung ausschließt.
 */
export const VOLA_FENSTER = 60;

/** Strategie-ID, unter der eine Ensemble-Einheit im `WfaResult` und in den Gates geführt wird. */
export const ENSEMBLE_ID = 'ensemble';

export type Gewichtsregel = EnsembleConfig['weighting'];

/* ───────────────────────── Plan: was gemessen wird ───────────────────────── */

export interface SleevePlan {
  index: number;
  /** Name im Bericht: `label` der Config, sonst die Strategie-ID. */
  label: string;
  strategy: Strategy;
  /** Vorregistrierte Parameter, bereits geprüft und auf das Gitter genagelt. */
  params: Params;
  universe: 'korb' | 'fixed';
  /** Bei `fixed` die vorregistrierten Symbole; bei `korb` leer (die Mitglieder kommen je Fenster). */
  symbols: readonly string[];
  warmupBars: number;
  /** Sperrzone dieses Sleeves in Bars (konfiguriert oder Warmup + 20). */
  embargoBars: number;
}

export interface EnsemblePlan {
  label: string;
  regel: Gewichtsregel;
  sleeves: SleevePlan[];
  /** Sperrzone der EINHEIT = Maximum über die Sleeves — der langsamste bestimmt, sonst leckt Information. */
  embargoBars: number;
  /** Warmup der Einheit = Maximum über die Sleeves (nur Bericht). */
  warmupBars: number;
}

/**
 * Den Plan aus der Config bauen. `paramsFor` prüft und normalisiert die
 * vorregistrierten Parameter genau wie bei einem Festkandidaten
 * (`festParams` in run.ts) — ein Tippfehler darf nicht stumm mit dem Default
 * laufen. Eine Strategie, die den Zeitrahmen nicht kann, ist hier ein
 * Fehler und kein Überspringen: Ein Ensemble ohne einen seiner
 * vorregistrierten Sleeves ist eine ANDERE Zusammensetzung.
 */
export function ensemblePlan(a: {
  ensemble: EnsembleConfig;
  getStrategy: (id: string) => Strategy;
  paramsFor: (strategy: Strategy, params: Params) => Params;
  timeframe: TimeframeMin;
  optimizer: OptimizerConfig;
}): EnsemblePlan {
  const sleeves: SleevePlan[] = a.ensemble.sleeves.map((s, index) => {
    const strategy = a.getStrategy(s.strategy);
    if (!strategy.timeframes.includes(a.timeframe)) {
      throw new Error(
        `Sleeve ${s.strategy} kann den Zeitrahmen ${a.timeframe} nicht — ein Ensemble ohne einen seiner vorregistrierten Sleeves wäre eine andere Zusammensetzung, also scheitert der Kandidat statt still zu schrumpfen.`,
      );
    }
    const params = a.paramsFor(strategy, s.params);
    return {
      index,
      label: s.label ?? strategy.id,
      strategy,
      params,
      universe: s.universe,
      symbols: [...s.symbols],
      warmupBars: strategy.warmupBars(params),
      embargoBars: embargoBarsFor(strategy, params, a.optimizer),
    };
  });
  return {
    label: a.ensemble.label,
    regel: a.ensemble.weighting,
    sleeves,
    embargoBars: sleeves.reduce((m, s) => Math.max(m, s.embargoBars), 0),
    warmupBars: sleeves.reduce((m, s) => Math.max(m, s.warmupBars), 0),
  };
}

/* ───────────────────────── Universum je Sleeve ───────────────────────── */

export interface KorbZuordnung {
  /** Der Korb dieses Fensters — genau die Symbole, die handeln dürfen. */
  korb: Map<string, BarSeriesLike>;
  /** Symbol ⇒ Index des Sleeves, der es führt. */
  sleeveVon: Map<string, number>;
  /** Vorregistrierte Symbole eines festen Sleeves ohne Bars — im Bericht, nie stumm. */
  fehlend: string[];
  /**
   * Symbole, die der Punkt-in-Zeit-Korb zu `at` enthielt und die ein FESTER
   * Sleeve führt — dem Korb-Sleeve also entzogen sind.
   *
   * Das ist kein Schönheitsfehler, sondern der Preis der Einheit: In EINER
   * Simulation trägt ein Symbol genau EINE Strategie (`SimInput.strategyFor`,
   * und live genau eine Position mit einem Stop — §0.6). Ein Aktien-Sleeve im
   * Ensemble läuft deshalb auf einem kleineren Korb als derselbe Sleeve
   * allein, und der Bericht sagt, um welche Symbole es geht. Wer das nicht
   * nennt, vergleicht hinterher zwei verschiedene Messungen.
   */
  entzogen: string[];
}

/**
 * Der Korb eines Fensters, Sleeve für Sleeve.
 *
 * Reihenfolge und Vorrang sind die der Vorregistrierung: Feste Sleeves
 * bekommen ihre Symbole (an der Zugehörigkeit je Fold VORBEI — die Liste ist
 * die Vorregistrierung), der Korb-Sleeve bekommt, was der Punkt-in-Zeit-Korb
 * zu `at` hergibt UND kein fester Sleeve schon belegt hat. Ohne diese
 * Aufteilung führte ein Symbol zwei Strategien, und `SimInput.strategyFor`
 * kennt nur eine.
 */
export function korbZuordnung(a: {
  plan: EnsemblePlan;
  /** Alle Bars der Einheit (Korb ∪ Kandidatenpool ∪ Sleeve-Symbole). */
  alle: ReadonlyMap<string, BarSeriesLike>;
  membership?: Membership | undefined;
  /** Zeitpunkt der Korb-Wahl (OOS-Beginn des Folds) — Pflicht, sobald es eine Membership gibt. */
  at?: Ms | undefined;
}): KorbZuordnung {
  const korb = new Map<string, BarSeriesLike>();
  const sleeveVon = new Map<string, number>();
  const fehlend: string[] = [];
  const belegt = new Set<string>();
  for (const s of a.plan.sleeves) {
    if (s.universe !== 'fixed') continue;
    for (const sym of s.symbols) {
      const b = a.alle.get(sym);
      if (!b || b.length === 0) {
        fehlend.push(sym);
        continue;
      }
      korb.set(sym, b);
      sleeveVon.set(sym, s.index);
      belegt.add(sym);
    }
  }
  const entzogen: string[] = [];
  const korbSleeve = a.plan.sleeves.find((s) => s.universe === 'korb');
  if (korbSleeve) {
    for (const [sym, b] of korbZum(a.alle, a.membership, a.at)) {
      if (belegt.has(sym)) {
        entzogen.push(sym);
        continue;
      }
      korb.set(sym, b);
      sleeveVon.set(sym, korbSleeve.index);
    }
  }
  return { korb, sleeveVon, fehlend, entzogen: entzogen.sort() };
}

/** Die Wahl je Symbol für `simulateKorbWindow` — Strategie und Parameter des führenden Sleeves. */
export function wahlFuerZuordnung(plan: EnsemblePlan, sleeveVon: ReadonlyMap<string, number>): (symbol: string) => Wahl | null {
  return (symbol) => {
    const i = sleeveVon.get(symbol);
    if (i === undefined) return null;
    const s = plan.sleeves[i];
    return s ? { strategy: s.strategy, params: s.params } : null;
  };
}

/* ───────────────────────── Gewichte: eine Regel, kein Parameter ───────────────────────── */

/**
 * Realisierte Volatilität eines Sleeves VOR einem Tag: Standardabweichung
 * seiner letzten `fenster` Tagesrenditen mit Tagesschlüssel < `bis`.
 *
 * Strikt kausal: `bis` ist der Tagesschlüssel des ersten Handelstags des
 * Fensters, für das gewichtet wird; dieser Tag selbst zählt NICHT mit. Wer
 * ihn mitnähme, gewichtete ein Fenster mit einer Zahl aus diesem Fenster.
 * null heißt „nicht bestimmbar" (zu wenige Tage oder σ = 0) — der Aufrufer
 * fällt dann auf gleichgewichtet zurück, nie auf einen geratenen Wert.
 */
export function sigmaVor(reihe: Renditereihe, bis: string, fenster = VOLA_FENSTER): number | null {
  const werte: number[] = [];
  for (let i = 0; i < reihe.tage.length; i++) {
    if (reihe.tage[i]! >= bis) break;
    werte.push(reihe.renditen[i]!);
  }
  if (werte.length < fenster) return null;
  const x = werte.slice(werte.length - fenster);
  const mu = x.reduce((s, v) => s + v, 0) / x.length;
  let q = 0;
  for (const v of x) q += (v - mu) * (v - mu);
  const sd = Math.sqrt(q / (x.length - 1));
  return Number.isFinite(sd) && sd > 0 ? sd : null;
}

export interface Gewichte {
  /** Anteil je Sleeve, Summe 1. */
  werte: number[];
  /** σ je Sleeve (null = nicht bestimmbar ⇒ Aufwärmphase). */
  sigmas: (number | null)[];
  /** Gleichgewichtet, weil die Regel es sagt ODER weil ein σ fehlte. */
  aufwaermphase: boolean;
  /** Im Klartext, für Bericht und Journal. */
  grund: string;
}

/**
 * Die Gewichte für ein Fenster, das am Tag `bis` beginnt.
 *
 * `equal` ist bedingungslos gleichgewichtet. `inverse_vol` verlangt für JEDEN
 * Sleeve ein bestimmbares σ; fehlt auch nur eines, gilt gleichgewichtet und
 * der Grund sagt es. Ein Ensemble, das einen Sleeve mit geratener Streuung
 * gewichtet, misst die Schätzung, nicht die Regel.
 */
export function gewichteVor(a: { reihen: readonly Renditereihe[]; bis: string; regel: Gewichtsregel; fenster?: number }): Gewichte {
  const n = a.reihen.length;
  const fenster = a.fenster ?? VOLA_FENSTER;
  const gleich = new Array<number>(n).fill(1 / n);
  if (a.regel === 'equal') {
    return { werte: gleich, sigmas: a.reihen.map(() => null), aufwaermphase: false, grund: `gleichgewichtet (Regel equal): je Sleeve ${(100 / n).toFixed(1)} %` };
  }
  const sigmas = a.reihen.map((r) => sigmaVor(r, a.bis, fenster));
  if (sigmas.some((s) => s === null)) {
    const fehlt = sigmas.map((s, i) => (s === null ? i + 1 : null)).filter((x): x is number => x !== null);
    return {
      werte: gleich,
      sigmas,
      aufwaermphase: true,
      grund: `Aufwärmphase: Sleeve ${fehlt.join(', ')} hat vor ${a.bis} keine ${fenster} Handelstage mit Streuung — gleichgewichtet`,
    };
  }
  const inv = sigmas.map((s) => 1 / s!);
  const summe = inv.reduce((x, y) => x + y, 0);
  const werte = inv.map((x) => x / summe);
  return {
    werte,
    sigmas,
    aufwaermphase: false,
    grund: `inverse Vola über ${fenster} Handelstage vor ${a.bis}: σ ${sigmas.map((s) => (s! * 100).toFixed(2)).join(' / ')} % ⇒ ${werte.map((w) => (w * 100).toFixed(1)).join(' / ')} %`,
  };
}

/**
 * Plätze je Sleeve aus den Gewichten.
 *
 * Warum Plätze: Im Alpha-Pfad ist das Budget das Risiko je Trade über die
 * Stop-Distanz (`risk/sizing.ts`). Ein Sleeve bindet dort Kapital über die
 * Zahl gleichzeitiger Positionen — die Plätze SIND seine Währung. Der Anteil
 * wirkt also, indem er die Plätze verteilt; `risk.maxPositionPct`, das
 * Exposure-Budget, das Bargeld und `maxPositions` bleiben darüber harte
 * Obergrenzen und können eine Position nur verkleinern, nie vergrößern.
 *
 * Die Regel: Jeder Sleeve bekommt EINEN Platz — ein Sleeve ohne Platz ist
 * kein Sleeve, und die ganze Einheit steht und fällt damit, dass jede Quelle
 * überhaupt handeln darf. Die restlichen Plätze gehen nacheinander an den
 * Sleeve mit dem größten offenen Anspruch (`w × maxPositions − Plätze`);
 * bei Gleichstand an den kleineren Index, damit der Lauf reproduzierbar ist.
 * Die Summe ist per Bauart genau `maxPositions`.
 */
export function plaetzeJeSleeve(gewichte: readonly number[], maxPositions: number): number[] {
  const n = gewichte.length;
  if (n === 0) return [];
  if (!Number.isInteger(maxPositions) || maxPositions < n) {
    throw new Error(
      `Ensemble mit ${n} Sleeves braucht mindestens ${n} Plätze, risk.maxPositions ist ${maxPositions} — ` +
        'ein Sleeve ohne eigenen Platz handelt nur, wenn die anderen zufällig gerade nichts tun; das ist keine gemessene Einheit.',
    );
  }
  const plaetze = new Array<number>(n).fill(1);
  for (let rest = maxPositions - n; rest > 0; rest--) {
    let best = 0;
    let bester = gewichte[0]! * maxPositions - plaetze[0]!;
    for (let i = 1; i < n; i++) {
      const anspruch = gewichte[i]! * maxPositions - plaetze[i]!;
      if (anspruch > bester) {
        bester = anspruch;
        best = i;
      }
    }
    plaetze[best]!++;
  }
  return plaetze;
}

/** Ein Gewichtsstand: die Gewichte und Plätze, mit denen ein Fenster gefahren wurde. */
export interface GewichtsStand {
  /** Beginn des Fensters (Epoch-ms) und sein Tagesschlüssel. */
  at: Ms;
  tag: string;
  /** Wofür dieser Stand galt — nur Bericht. */
  fenster: string;
  gewichte: number[];
  plaetze: number[];
  sigmas: (number | null)[];
  aufwaermphase: boolean;
  grund: string;
}

/* ───────────────────────── Embargo: der langsamste Sleeve bestimmt ───────────────────────── */

/**
 * Ende des IS-Fensters nach Abzug der Sperrzone der EINHEIT.
 *
 * Das Embargo ist das Maximum über die Sleeves: Ein Fenster, das für den
 * schnellen Sleeve sauber ist, leckt für den langsamen weiter Information.
 * Frisst die Sperrzone das ganze Fenster, ist das ein FEHLER und kein leeres
 * Fenster mit „0 Trades" — genau daran scheiterte die erste
 * `regime_allocation`-Fassung, und deshalb steht in `config/vigilant-1440.yaml`
 * `isDays: 550`.
 */
export function ensembleEmbargoEnde(a: { plan: EnsemblePlan; achse: Zeitachse; fenster: TimeRange }): Ms {
  const ende = embargoedEnd(a.achse, a.fenster.start, a.fenster.end, a.plan.embargoBars);
  if (ende <= a.fenster.start) {
    const langsamster = a.plan.sleeves.reduce((m, s) => (s.embargoBars > m.embargoBars ? s : m), a.plan.sleeves[0]!);
    throw new Error(
      `Embargo (${a.plan.embargoBars} Bars, gesetzt vom Sleeve ${langsamster.strategy.id} mit ${langsamster.warmupBars} Bars Warmup) verschluckt das gesamte IS-Fenster ` +
        `${new Date(a.fenster.start).toISOString().slice(0, 10)} … ${new Date(a.fenster.end).toISOString().slice(0, 10)} — ` +
        'optimizer.isDays erhöhen (der langsamste Sleeve bestimmt) oder optimizer.embargoBars setzen.',
    );
  }
  return ende;
}

/* ───────────────────────── Beitrag je Sleeve ───────────────────────── */

export interface SleeveBeitrag {
  index: number;
  label: string;
  strategy: string;
  trades: number;
  netProfit: number;
  fees: number;
  /** Anteil am Netto der Einheit; null, wenn das Netto nicht positiv ist (dann ist ein Anteil keine Aussage). */
  anteilAmNetto: number | null;
  /** Mittleres Gewicht über alle Stände (die Regel), nicht das realisierte Kapital. */
  mittleresGewicht: number;
  /** Mittlere Plätze aus dem Plan (Soll). */
  mittlerePlaetze: number;
  /** Größte Zahl GLEICHZEITIG offener Positionen dieses Sleeves im gemeinsamen Lauf (Ist). */
  plaetzeIst: number;
}

/** Größte Zahl gleichzeitig offener Positionen einer Trade-Menge (zwei wandernde Zeiger über Ein-/Ausstiege). */
export function maxGleichzeitig(trades: readonly Trade[]): number {
  const ein = trades.map((t) => t.entryTime).sort((a, b) => a - b);
  const aus = trades.map((t) => t.exitTime).sort((a, b) => a - b);
  let i = 0;
  let j = 0;
  let offen = 0;
  let max = 0;
  while (i < ein.length) {
    // Bei gleichem Zeitstempel zuerst schließen: Ein Exit und ein Einstieg in
    // derselben Bar belegen nacheinander denselben Platz, nicht zwei.
    if (j < aus.length && aus[j]! <= ein[i]!) {
      offen--;
      j++;
      continue;
    }
    offen++;
    i++;
    if (offen > max) max = offen;
  }
  return max;
}

/* ───────────────────────── Die Messung ───────────────────────── */

export interface FoldTraeger {
  fold: Fold;
  /** Netto je Sleeve in diesem OOS-Fenster. */
  netto: number[];
  trades: number[];
  /** Sleeve mit dem größten Netto-Beitrag; null, wenn kein Trade im Fenster lag. */
  traeger: number | null;
}

export interface EnsembleMessung {
  plan: EnsemblePlan;
  wfa: WfaResult;
  stress: StressResult;
  nachbarschaft: NeighborhoodResult;
  /** Gewichte und Plätze je Fenster — die Regel, nachvollziehbar Zeile für Zeile. */
  staende: GewichtsStand[];
  beitraege: SleeveBeitrag[];
  foldTraeger: FoldTraeger[];
  /** Tagesrenditen jedes Sleeves ALLEIN über dieselben OOS-Fenster (Solo-Lauf) — Eingang der Matrix und der Gewichte. */
  sleeveReihen: { name: string; reihe: Renditereihe }[];
  korrelation: Korrelationsmatrix;
  /** Symbol ⇒ Sleeve im letzten gemessenen Fenster (Bericht). */
  zuordnung: { symbol: string; sleeve: string }[];
  /** Vorregistrierte Symbole ohne Bars — nie stumm. */
  fehlend: string[];
  /** Korb-Mitglieder, die feste Sleeves führen (dem Korb-Sleeve entzogen) — letzter gemessener Stand. */
  entzogen: string[];
  /** Die OOS-Teilläufe, für Aktivität und Anatomie im Bericht (`auswertungFuer` in run.ts). */
  oosTeile: SimResult[];
  /** Der gemessene Korb des letzten Fensters (Bericht). */
  korbGroesse: number;
}

export interface EnsembleMessArgs {
  plan: EnsemblePlan;
  /** Alle Bars der Einheit (Korb ∪ Kandidatenpool ∪ feste Sleeve-Symbole). */
  bars: ReadonlyMap<string, BarSeriesLike>;
  /** Zeitachse der EINHEIT — derselbe Fold-Plan wie für jeden anderen Kandidaten. */
  achse: Zeitachse;
  folds: readonly Fold[];
  holdout: TimeRange | null;
  membership?: Membership | undefined;
  config: SimConfig;
  optimizer: OptimizerConfig;
  initialEquity: number;
  benchmark?: BarSeriesLike | undefined;
  calendar?: Calendar | undefined;
  simulate: SimulateFn;
  assetClass: AssetClass;
  /** Bars des Parksymbols — GETRENNT vom Korb (siehe `WindowSimArgs.parkBars`). */
  parkBars?: BarSeriesLike | undefined;
  /**
   * Zinsreihe des Laufs (`optimizer.riskFreeSymbol`). Stress und Nachbarschaft
   * simulieren eigene Fenster und richten den Zins auf IHRER Equity-Kurve aus;
   * ohne sie rechnen beide roh wie vor dem 13.09.2026 und sagen es.
   */
  riskFree?: RiskFreeSeries | undefined;
  log?: ((msg: string) => void) | undefined;
}

/**
 * Die Einheit messen: Solo-Läufe je Sleeve (Streuung und Korrelation), dann
 * Fold für Fold EIN gemeinsamer Lauf über IS (mit Embargo) und OOS, dazu
 * Stress, Nachbarschaft und der Holdout.
 *
 * Reihenfolge ist kein Zufall: Die Gewichte eines Fensters entstehen aus den
 * Solo-Renditen VOR seinem ersten Handelstag. Der Solo-Lauf selbst ist
 * kausal (der Simulator reicht Strategien nur `bars.prefix(i+1)`), also ist
 * es die ganze Kette.
 */
export function messeEnsemble(a: EnsembleMessArgs): EnsembleMessung {
  const { plan, folds, optimizer } = a;
  if (folds.length === 0) throw new Error('messeEnsemble: keine Folds');
  const log = a.log ?? (() => undefined);
  const erster = folds[0]!;
  const letzter = folds[folds.length - 1]!;
  const gemeinsam = {
    symbol: plan.label,
    bars: a.bars,
    benchmark: a.benchmark,
    config: a.config,
    initialEquity: a.initialEquity,
    calendar: a.calendar,
    simulate: a.simulate,
    // Am Korb vorbei: Die Parkbars gehören in kein `bars`/`korb` dieser Messung.
    parkBars: a.parkBars,
  };

  /* ── 1. Solo-Läufe: die eigenen Renditen jedes Sleeves ── */
  // Eine durchgehende Range über IS des ersten und OOS des letzten Folds.
  // Sie liefert BEIDES: die Streuung für die Gewichte (Tage vor dem jeweiligen
  // Fenster) und die Reihen der Korrelationsmatrix. Warmup kommt wie überall
  // aus der Historie davor.
  const soloRange: TimeRange = { start: erster.isStart, end: letzter.oosEnd };
  const soloReihen: Renditereihe[] = [];
  for (const s of plan.sleeves) {
    const z = korbZuordnung({ plan: einSleevePlan(plan, s), alle: a.bars, membership: a.membership, at: erster.oosStart });
    const r = simulateKorbWindow({ ...gemeinsam, range: soloRange, korb: z.korb, wahlFuer: wahlFuerZuordnung(plan, z.sleeveVon) });
    soloReihen.push(tagesrenditen({ equity: r.equity, initialEquity: a.initialEquity, assetClass: a.assetClass }));
    log(`${plan.label} · Solo ${s.label}: ${r.trades.length} Trades, netto ${r.metrics.netProfit.toFixed(2)} (nur Streuung und Korrelation, kein Gate)`);
  }

  /* ── 2. Fold für Fold: EIN gemeinsamer Lauf ── */
  const staende: GewichtsStand[] = [];
  const foldResults: WfaFoldResult[] = [];
  const pieces: OosPiece[] = [];
  const oosTeile: SimResult[] = [];
  const oosTrades: Trade[] = [];
  const foldTraeger: FoldTraeger[] = [];
  let letzteZuordnung: KorbZuordnung | null = null;
  const fehlend = new Set<string>();

  const standFuer = (at: Ms, fenster: string): GewichtsStand => {
    const tag = dayKeyFor(at, a.assetClass);
    const g = gewichteVor({ reihen: soloReihen, bis: tag, regel: plan.regel });
    const stand: GewichtsStand = {
      at,
      tag,
      fenster,
      gewichte: g.werte,
      plaetze: plaetzeJeSleeve(g.werte, a.config.risk.maxPositions),
      sigmas: g.sigmas,
      aufwaermphase: g.aufwaermphase,
      grund: g.grund,
    };
    staende.push(stand);
    return stand;
  };

  const laufe = (range: TimeRange, at: Ms, costMultiplier?: number): { res: SimResult; z: KorbZuordnung } => {
    const z = korbZuordnung({ plan, alle: a.bars, membership: a.membership, at });
    for (const f of z.fehlend) fehlend.add(f);
    const res = simulateKorbWindow({
      ...gemeinsam,
      range,
      korb: z.korb,
      wahlFuer: wahlFuerZuordnung(plan, z.sleeveVon),
      ...(costMultiplier !== undefined ? { costMultiplier } : {}),
    });
    return { res, z };
  };

  for (const fold of folds) {
    // Der Korb eines Folds gilt ab seinem OOS-Beginn — auch für die IS-Läufe
    // (walkForward.ts, `Membership`). Gewichtet wird jedes Fenster mit dem
    // Stand VOR seinem Beginn.
    const isEnde = ensembleEmbargoEnde({ plan, achse: a.achse, fenster: { start: fold.isStart, end: fold.isEnd } });
    standFuer(fold.isStart, `Fold ${fold.index + 1} IS`);
    const is = laufe({ start: fold.isStart, end: isEnde }, fold.oosStart);
    standFuer(fold.oosStart, `Fold ${fold.index + 1} OOS`);
    const oos = laufe({ start: fold.oosStart, end: fold.oosEnd }, fold.oosStart);
    letzteZuordnung = oos.z;
    foldResults.push({
      fold,
      evaluated: 0,
      best: {
        // Ein Ensemble hat keinen EINEN Parametersatz — die Sleeves tragen ihre
        // vorregistrierten. Der Bericht zeigt sie in der Zusammensetzung.
        params: {},
        isMetrics: is.res.metrics,
        oosMetrics: oos.res.metrics,
        oosTrades: oos.res.trades,
        isObjective: objectiveValue(optimizer.objective, is.res.metrics),
        oosObjective: objectiveValue(optimizer.objective, oos.res.metrics),
        oosDailyReturns: oos.res.dailyReturns,
      },
    });
    pieces.push(oosPieceOf(oos.res, a.assetClass));
    oosTeile.push(oos.res);
    for (const t of oos.res.trades) oosTrades.push(t);
    foldTraeger.push(traegerVon(plan, fold, oos.res.trades));
  }

  /* ── 3. Finales Fenster und Holdout ── */
  const finalWindow = { start: letzter.isStart, end: letzter.oosEnd, embargoAtEnd: a.holdout !== null };
  const finalEnde = finalWindow.embargoAtEnd ? ensembleEmbargoEnde({ plan, achse: a.achse, fenster: finalWindow }) : finalWindow.end;
  standFuer(finalWindow.start, 'finales Fenster');
  const fin = laufe({ start: finalWindow.start, end: finalEnde }, finalWindow.end);
  let holdout: WfaResult['holdout'] = null;
  if (a.holdout) {
    standFuer(a.holdout.start, 'Holdout');
    const h = laufe({ start: a.holdout.start, end: a.holdout.end }, a.holdout.start);
    holdout = { start: a.holdout.start, end: a.holdout.end, metrics: h.res.metrics };
  }

  const oos = aggregateOos(pieces, optimizer.objective, a.initialEquity);
  const wfa: WfaResult = {
    strategyId: ENSEMBLE_ID,
    symbol: plan.label,
    timeframe: a.config.timeframe,
    folds: foldResults,
    oos,
    finalParams: {},
    finalIsMetrics: fin.res.metrics,
    finalWindow,
    // Ein vorregistrierter Parametersatz je Sleeve, keine Suche: ein Trial,
    // wie bei jedem Festkandidaten. Zu deflationieren gibt es trotzdem nichts
    // (robustness.ts, `fixed`).
    trials: 1,
    finalEvaluated: 1,
    finalIsDailyReturns: fin.res.dailyReturns,
    finalTrialSharpes: [],
    holdout,
    dataRange: { start: a.achse.t[0]!, end: a.achse.t[a.achse.length - 1]! + 1 },
    embargoBars: plan.embargoBars,
  };

  /* ── 4. Stress: dieselben OOS-Fenster, Kosten × Faktor ── */
  // Mit Zinsreihe zählt auch hier der ÜBERSCHUSS (robustness.ts, `stressTest`):
  // Sonst bestünde `stress_costs` ausgerechnet eine Einheit, die bei teureren
  // Kosten gar nicht mehr handelt und nur noch den Geldmarktzins einsammelt.
  const stressObjectives: number[] = [];
  let stressNetto = 0;
  let stressTrades = 0;
  let stressUeberschuss: number | null = a.riskFree ? 0 : null;
  let stressZins = a.riskFree ? `Maßstab: Überschuss über ${a.riskFree.symbol}` : ROHES_NETTO_NOTE;
  for (const fold of folds) {
    const r = laufe({ start: fold.oosStart, end: fold.oosEnd }, fold.oosStart, optimizer.stressCostMultiplier);
    stressObjectives.push(objectiveValue(optimizer.objective, r.res.metrics));
    stressNetto += r.res.metrics.netProfit;
    stressTrades += r.res.metrics.trades;
    if (a.riskFree && stressUeberschuss !== null) {
      const u = ueberschussNettoVon({ result: r.res, riskFree: a.riskFree, assetClass: a.assetClass, initialEquity: a.initialEquity });
      if ('fehler' in u) {
        stressUeberschuss = null;
        stressZins = `Maßstab: rohes Netto — Zins nicht auf den Stress-Lauf ausrichtbar (Fold ${fold.index + 1}: ${u.fehler})`;
      } else stressUeberschuss += u.netProfit;
    }
  }
  const stress: StressResult = {
    netProfit: stressNetto,
    ueberschussNetProfit: stressUeberschuss,
    objectiveMedian: median(stressObjectives),
    trades: stressTrades,
    costMultiplier: optimizer.stressCostMultiplier,
    zins: stressZins,
  };

  /* ── 5. Nachbarschaft: ±1 je Achse je Sleeve ── */
  const nachbarschaft = ensembleNachbarschaft({
    plan,
    gemeinsam,
    achse: a.achse,
    bars: a.bars,
    membership: a.membership,
    fenster: { start: finalWindow.start, end: finalEnde },
    at: finalWindow.end,
    optimizer,
    allowShort: a.config.risk.allowShort,
    bestObjective: objectiveValue(optimizer.objective, fin.res.metrics),
    assetClass: a.assetClass,
    ...(a.riskFree ? { riskFree: a.riskFree } : {}),
  });

  /* ── 6. Beitrag je Sleeve und Korrelation ── */
  const oosTage = new Set<string>();
  for (const teil of oosTeile) for (const p of teil.equity) oosTage.add(dayKeyFor(p.t, a.assetClass));
  const sleeveReihen = plan.sleeves.map((s, i) => ({ name: s.label, reihe: nurTage(soloReihen[i]!, oosTage) }));
  const beitraege = beitraegeVon({ plan, trades: oosTrades, netto: oos.netProfit, staende });

  return {
    plan,
    wfa,
    stress,
    nachbarschaft,
    staende,
    beitraege,
    foldTraeger,
    sleeveReihen,
    korrelation: korrelationsmatrix(sleeveReihen),
    zuordnung: letzteZuordnung
      ? [...letzteZuordnung.sleeveVon.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([symbol, i]) => ({ symbol, sleeve: plan.sleeves[i]?.label ?? String(i) }))
      : [],
    fehlend: [...fehlend].sort(),
    entzogen: letzteZuordnung ? [...letzteZuordnung.entzogen] : [],
    oosTeile,
    korbGroesse: letzteZuordnung ? letzteZuordnung.korb.size : 0,
  };
}

/** Ein Plan mit genau EINEM Sleeve — für den Solo-Lauf, ohne die Zuordnung zu verbiegen. */
function einSleevePlan(plan: EnsemblePlan, sleeve: SleevePlan): EnsemblePlan {
  return { ...plan, sleeves: [sleeve] };
}

/** Eine Renditereihe auf die Tage einer Menge einschränken (OOS-Kette aus dem durchgehenden Solo-Lauf). */
export function nurTage(reihe: Renditereihe, tage: ReadonlySet<string>): Renditereihe {
  const out: Renditereihe = { tage: [], renditen: [] };
  for (let i = 0; i < reihe.tage.length; i++) {
    if (!tage.has(reihe.tage[i]!)) continue;
    out.tage.push(reihe.tage[i]!);
    out.renditen.push(reihe.renditen[i]!);
  }
  return out;
}

/** Wer hat diesen Fold getragen? Netto und Trades je Sleeve aus den Trades des gemeinsamen Laufs. */
function traegerVon(plan: EnsemblePlan, fold: Fold, trades: readonly Trade[]): FoldTraeger {
  const netto = plan.sleeves.map(() => 0);
  const anzahl = plan.sleeves.map(() => 0);
  for (const t of trades) {
    const i = plan.sleeves.findIndex((s) => s.strategy.id === t.strategy);
    if (i < 0) continue;
    netto[i]! += t.netPnl;
    anzahl[i]!++;
  }
  let traeger: number | null = null;
  for (let i = 0; i < netto.length; i++) {
    if (anzahl[i]! === 0) continue;
    if (traeger === null || netto[i]! > netto[traeger]!) traeger = i;
  }
  return { fold, netto, trades: anzahl, traeger };
}

function beitraegeVon(a: { plan: EnsemblePlan; trades: readonly Trade[]; netto: number; staende: readonly GewichtsStand[] }): SleeveBeitrag[] {
  return a.plan.sleeves.map((s, i) => {
    const eigene = a.trades.filter((t) => t.strategy === s.strategy.id);
    const net = eigene.reduce((x, t) => x + t.netPnl, 0);
    const fees = eigene.reduce((x, t) => x + t.fees, 0);
    return {
      index: i,
      label: s.label,
      strategy: s.strategy.id,
      trades: eigene.length,
      netProfit: net,
      fees,
      anteilAmNetto: a.netto > 0 ? net / a.netto : null,
      mittleresGewicht: mean(a.staende.map((st) => st.gewichte[i] ?? 0)),
      mittlerePlaetze: mean(a.staende.map((st) => st.plaetze[i] ?? 0)),
      plaetzeIst: maxGleichzeitig(eigene),
    };
  });
}

/**
 * Nachbarschaft einer EINHEIT: jede Achse jedes Sleeves einmal um einen
 * Gitterschritt nach oben und unten, alle anderen Sleeves unverändert.
 *
 * Dieselbe Frage wie bei einem einzelnen Kandidaten — hängt das Ergebnis an
 * genau diesem Parametersatz oder an einer Region? — nur über alle Sleeves
 * zugleich. Ein Raum ohne wirksame Achse (alles genagelt) kann per
 * Parameterwahl nicht überangepasst werden und zählt wie dort als Plateau.
 */
function ensembleNachbarschaft(a: {
  plan: EnsemblePlan;
  gemeinsam: Omit<KorbSimArgs, 'range' | 'korb' | 'wahlFuer' | 'costMultiplier'>;
  achse: Zeitachse;
  bars: ReadonlyMap<string, BarSeriesLike>;
  membership?: Membership | undefined;
  fenster: TimeRange;
  at: Ms;
  optimizer: OptimizerConfig;
  allowShort: boolean;
  bestObjective: number;
  assetClass: AssetClass;
  /** Zinsreihe; mit ihr zählt der Anteil positiver Nachbarn das ÜBERSCHUSS-Netto (robustness.ts, `neighborhoodTest`). */
  riskFree?: RiskFreeSeries | undefined;
}): NeighborhoodResult {
  const objectives: number[] = [];
  // Beide Reihen mitführen, damit ein Rückfall mitten in der Schleife keine
  // halb umgestellte Zählung hinterlässt (siehe `neighborhoodTest`).
  const roh: number[] = [];
  const ueber: number[] = [];
  let mitZins = a.riskFree !== undefined;
  let zins = a.riskFree ? `Maßstab: Überschuss über ${a.riskFree.symbol}` : ROHES_NETTO_NOTE;
  let evaluated = 0;
  for (const s of a.plan.sleeves) {
    const raum = wirksamerSuchraum(s.strategy.paramSpace, a.allowShort);
    for (const params of neighbors(s.params, raum.space)) {
      const variante: EnsemblePlan = {
        ...a.plan,
        sleeves: a.plan.sleeves.map((x) => (x.index === s.index ? { ...x, params: { ...params, ...raum.pinned } } : x)),
      };
      const z = korbZuordnung({ plan: variante, alle: a.bars, membership: a.membership, at: a.at });
      const r = simulateKorbWindow({ ...a.gemeinsam, range: a.fenster, korb: z.korb, wahlFuer: wahlFuerZuordnung(variante, z.sleeveVon) });
      objectives.push(objectiveValue(a.optimizer.objective, r.metrics));
      roh.push(r.metrics.netProfit);
      if (a.riskFree && mitZins) {
        const u = ueberschussNettoVon({ result: r, riskFree: a.riskFree, assetClass: a.assetClass, initialEquity: a.gemeinsam.initialEquity });
        if ('fehler' in u) {
          mitZins = false;
          zins = `Maßstab: rohes Netto — Zins nicht auf die Nachbarschaft ausrichtbar (${u.fehler})`;
        } else ueber.push(u.netProfit);
      }
      evaluated++;
    }
  }
  if (evaluated === 0) return { medianObjective: a.bestObjective, bestObjective: a.bestObjective, positiveShare: 1, evaluated: 0, ueberschuss: mitZins, zins };
  const positive = (mitZins ? ueber : roh).filter((x) => x > 0).length;
  return { medianObjective: median(objectives), bestObjective: a.bestObjective, positiveShare: positive / evaluated, evaluated, ueberschuss: mitZins, zins };
}

/* ───────────────────────── Versuchszählung ───────────────────────── */

/** Vorregistrierte Ensemble-Versuche: 3 Zusammensetzungen × 2 Gewichtsregeln (`2026-09-12-ensemble.md` Punkt 3). */
export const VORREGISTRIERTE_ENSEMBLES = 6;
/** Vorregistrierte Einzel-Sleeves auf denselben Daten (`2026-09-12-drei-sleeves.md`). */
export const VORREGISTRIERTE_SLEEVES = 3;

/**
 * Die Versuchszählung — die Zahl, ohne die ein bestandenes Ensemble wie ein
 * Einzelbeweis aussieht.
 *
 * Der Nenner ist ausdrücklich die VORREGISTRIERUNG, nicht dieser Lauf: Wer
 * heute nur eine Einheit misst, hat trotzdem sechs angemeldet, und die drei
 * einzeln gemessenen Sleeves liegen auf denselben Daten. Neun Einheiten auf
 * einem Datensatz — wer davon eine bestehen sieht und die acht anderen nicht
 * mitzählt, misst sich selbst.
 */
export function versuche(a: { ensembles: number }): string {
  return (
    `${a.ensembles} Ensemble-Einheit${a.ensembles === 1 ? '' : 'en'} in DIESEM Lauf. Der Nenner ist die Vorregistrierung, nicht der Lauf: ` +
    `${VORREGISTRIERTE_ENSEMBLES} Ensemble-Versuche (3 Zusammensetzungen × 2 Gewichtsregeln) plus ${VORREGISTRIERTE_SLEEVES} einzeln gemessene Sleeves = ` +
    `${VORREGISTRIERTE_ENSEMBLES + VORREGISTRIERTE_SLEEVES} Einheiten auf denselben Daten ` +
    '(docs/wissen/vorregistrierung/2026-09-12-ensemble.md Punkt 3, 2026-09-12-drei-sleeves.md). ' +
    'Wer neun Dinge probiert und eines bestehen sieht, hat noch nichts bewiesen — deshalb zählt ein bestandenes Ensemble erst, ' +
    'wenn dasselbe Urteil auf mindestens zwei weiteren Stichtagen (`--as-of`) steht.'
  );
}
