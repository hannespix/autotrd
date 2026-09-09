/**
 * Marktbezug: Was hätte "kaufen und liegenlassen" im selben Fenster gebracht?
 *
 * Warum das im Bericht stehen muss: Eine Strategie mit +11 % im Holdout
 * klingt großartig — bis man sieht, dass derselbe Korb im selben Halbjahr
 * +12 % gemacht hat, ohne einen einzigen Auftrag. Ohne diese Zahl misst der
 * Bericht Marktbewegung und nennt sie Kante. Genau das war der teuerste
 * Selbstbetrug des Vorgängersystems in anderer Form.
 *
 * Die Zahl, die trägt, ist der **Sharpe**: Er ist Ertrag je Risiko und damit
 * unabhängig davon, wie oft man investiert war — deshalb vergleichbar
 * zwischen einer selten investierten Strategie und einem stets vollen Korb.
 * Die Rendite daneben ist Größenordnung, kein Gleichstand-Vergleich: Eine
 * Strategie, die nur 20 % der Zeit im Markt steht, DARF weniger Rendite
 * haben — sie muss den besseren Sharpe haben.
 *
 * Die Referenz ist absichtlich dumm: gleichgewichtet kaufen, halten, nichts
 * tun. Kosten bleiben draußen (einmal Einstieg auf ein halbes Jahr ist
 * Rauschen), was die Referenz eher zu gut als zu schlecht macht — die
 * richtige Richtung für einen Maßstab, den die Strategie schlagen soll.
 */
import { dayKeyFor } from '../core/time.ts';
import type { AssetClass, BarSeriesLike, Ms } from '../core/types.ts';
import { maxDrawdownPct, sharpeRatio } from './metrics.ts';

const DAY = 86_400_000;

export interface MarktBezug {
  /** Symbole mit Kurs am ersten Tag des Fensters; Gewicht je 1/n. */
  symbole: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  /** Kalendertage des Fensters — dieselbe Zählung wie in `computeMetrics`. */
  days: number;
  /** Handelstage mit Kurs im Fenster (Länge der Renditereihe + 1). */
  punkte: number;
}

/**
 * Gleichgewichtetes Kaufen-und-Halten über `range` ([start, end)) — dieselbe
 * Fenstergrenze wie im Simulator, damit die Zahlen dasselbe Fenster meinen.
 * null, wenn das Fenster weniger als zwei Handelstage hat oder kein Symbol
 * am ersten Tag bewertbar ist.
 */
export function kaufenUndHalten(args: {
  bars: ReadonlyMap<string, BarSeriesLike>;
  range: { start: Ms; end: Ms };
  assetClass: AssetClass;
  periodsPerYear: number;
}): MarktBezug | null {
  const r = wertreihe(args.bars, args.range, args.assetClass);
  if (!r) return null;
  return {
    symbole: r.symbole,
    netReturnPct: (r.kurve[r.kurve.length - 1]! - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(r.kurve),
    sharpe: sharpeRatio(r.renditen, args.periodsPerYear),
    days: Math.max(1, Math.ceil((args.range.end - args.range.start) / DAY)),
    punkte: r.punkte,
  };
}

export interface MarktKette {
  sharpe: number | null;
  /**
   * MaxDD der VERKETTETEN Wertreihe in % — gemessen wie `aggregateOos` den
   * MaxDD der OOS-Kette misst: Ein Verlust im ersten Fenster zählt in den
   * folgenden weiter. Ein Höchstwert je Fenster wäre eine andere, kleinere Zahl.
   */
  maxDrawdownPct: number;
  /** Rendite der Kette in % (Produkt der Fenster-Renditen). */
  netReturnPct: number;
  fenster: number;
  punkte: number;
}

/**
 * Der Maßstab über MEHRERE Fenster, aneinandergehängt — das Spiegelbild der
 * OOS-Kette (`aggregateOos` in optimize/walkForward.ts). Jedes Fenster startet
 * frisch gleichgewichtet, genau wie jeder Fold mit `initialEquity` startet;
 * die Tagesrenditen werden in derselben Reihenfolge verkettet und EINMAL zu
 * einem Sharpe verdichtet. Nur so vergleicht man dieselbe Größe: ein Mittel
 * über Fenster-Sharpes wäre eine andere Zahl. Der Drawdown entsteht auf der
 * verketteten Wertreihe derselben Renditen.
 */
export function marktKette(args: {
  bars: ReadonlyMap<string, BarSeriesLike>;
  ranges: readonly { start: Ms; end: Ms }[];
  assetClass: AssetClass;
  periodsPerYear: number;
}): MarktKette | null {
  const renditen: number[] = [];
  // Jedes Fenster beginnt bei 1 und wird an den Endstand des vorigen gehängt.
  const kette: number[] = [1];
  let stand = 1;
  let fenster = 0;
  let punkte = 0;
  for (const range of args.ranges) {
    const r = wertreihe(args.bars, range, args.assetClass);
    if (!r) continue;
    fenster++;
    punkte += r.punkte;
    for (const x of r.renditen) renditen.push(x);
    // kurve[0] ist immer 1 — der Endstand des vorigen Fensters steht schon in der Kette.
    for (let i = 1; i < r.kurve.length; i++) kette.push(stand * r.kurve[i]!);
    stand *= r.kurve[r.kurve.length - 1]!;
  }
  if (fenster === 0 || renditen.length < 2) return null;
  return { sharpe: sharpeRatio(renditen, args.periodsPerYear), maxDrawdownPct: maxDrawdownPct(kette), netReturnPct: (stand - 1) * 100, fenster, punkte };
}

interface Wertreihe {
  symbole: number;
  /** Wertentwicklung, beginnend bei 1. */
  kurve: number[];
  renditen: number[];
  punkte: number;
}

function wertreihe(bars: ReadonlyMap<string, BarSeriesLike>, range: { start: Ms; end: Ms }, assetClass: AssetClass): Wertreihe | null {

  // Tagesschluss je Symbol im Fenster (letzte Bar des Tages gewinnt) — so ist
  // die Renditereihe tageweise wie die des Simulators, auch bei Minutenbars.
  const proSymbol: { basis: number; kurse: Map<string, number> }[] = [];
  const tage = new Set<string>();
  let ersterTag: string | null = null;
  const roh = new Map<string, Map<string, number>>();
  for (const [sym, s] of bars) {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length; i++) {
      const t = s.t[i]!;
      if (t < range.start) continue;
      if (t >= range.end) break;
      const k = dayKeyFor(t, assetClass);
      m.set(k, s.c[i]!);
      tage.add(k);
      if (ersterTag === null || k < ersterTag) ersterTag = k;
    }
    if (m.size) roh.set(sym, m);
  }
  const achse = [...tage].sort();
  if (achse.length < 2 || ersterTag === null) return null;

  // Nur Symbole mit Kurs am ERSTEN Tag: ein später startendes Symbol bekäme
  // sonst rückwirkend ein Gewicht, das es nie hatte (Survivorship durch die
  // Hintertür — genau der Fehler, den der Maßstab aufdecken soll).
  for (const m of roh.values()) {
    const basis = m.get(ersterTag);
    if (basis === undefined || !(basis > 0)) continue;
    proSymbol.push({ basis, kurse: m });
  }
  if (!proSymbol.length) return null;

  // Wertreihe: am ersten Tag gleichgewichtet gekauft, danach nichts getan.
  // Fehlt ein Tageskurs (Handelsstopp, Datenlücke), gilt der letzte bekannte.
  const stand = proSymbol.map(() => 1);
  const kurve: number[] = [1];
  const renditen: number[] = [];
  for (let d = 1; d < achse.length; d++) {
    const k = achse[d]!;
    let summe = 0;
    for (let j = 0; j < proSymbol.length; j++) {
      const eintrag = proSymbol[j]!;
      const p = eintrag.kurse.get(k);
      if (p !== undefined && p > 0) stand[j] = p / eintrag.basis;
      summe += stand[j]!;
    }
    const wert = summe / proSymbol.length;
    const vor = kurve[kurve.length - 1]!;
    kurve.push(wert);
    if (vor > 0) renditen.push(wert / vor - 1);
  }

  return { symbole: proSymbol.length, kurve, renditen, punkte: achse.length };
}
