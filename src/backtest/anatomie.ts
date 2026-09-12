/**
 * Exit-Anatomie und Kursexkursionen — WO das Geld gewonnen und verloren wird.
 *
 * Der Bericht sagte bisher, WIE VIEL ein Kandidat verdient (Sharpe, Netto,
 * MaxDD, Trades). Er sagte nicht, WO das Geld hingeht. Genau daran hing im
 * Vorgängersystem alles Wesentliche (CLAUDE.md §2): Signal-Exits schnitten
 * Gewinner ab, Take-Profit-Exits gewannen 26 von 26 Fällen, ein falsch
 * gerechnetes Trailing verkaufte bei −3 % statt −25 %. Diese drei Befunde
 * kamen aus Handarbeit am Journal. Hier stehen sie als Messung.
 *
 * NUR MESSUNG, NIE ENTSCHEIDUNG. Kein Wert dieses Moduls wird von `decide()`,
 * vom Simulator, von einem Gate oder von der Beförderung gelesen; nichts hier
 * wird in einen `Trade` zurückgeschrieben. Alle Funktionen sind rein (sie
 * mutieren ihre Eingaben nicht) und arbeiten ausschließlich auf ABGESCHLOSSENEN
 * Trades — sie können deshalb weder einen Einstieg noch einen Ausstieg
 * beeinflussen. Wächter: test/backtest/anatomie.test.ts.
 *
 * Kausalität von MFE/MAE: Die Kursextreme führt der Simulator bar für bar
 * während der Haltezeit mit (`updateExcursion`), nur aus Bars, die er zu
 * diesem Zeitpunkt schon gesehen hat. Sie erscheinen erst im fertigen Trade.
 * Was NACH dem Ausstieg geschah, steht NICHT in MFE/MAE — dafür gibt es
 * `stopNachlauf`, das sich seine Bars selbst holt und ausdrücklich eine
 * Was-wäre-wenn-Rechnung ist.
 */
import type { BarSeriesLike, ExitReason, Ms, Trade } from '../core/types.ts';

/* ───────────────────────── Kategorien ───────────────────────── */

/**
 * Ausstiegsgrund für die Statistik. `stop` und `trailing` teilen denselben
 * `ExitReason` — der Unterschied steht in `Trade.stopTrailed` und ist der
 * wichtigste der ganzen Tabelle: Ein Katastrophen-Stop soll selten und teuer
 * sein, ein Trailing-Stop oft und billig. Wer beides zusammenzählt, sieht
 * keines von beidem.
 */
export type ExitKategorie = ExitReason | 'trailing';

/** Reihenfolge im Bericht: erst die gewollten Ausstiege, dann die Notausgänge. */
export const EXIT_KATEGORIEN: readonly ExitKategorie[] = [
  'target',
  'trailing',
  'stop',
  'signal',
  'eod',
  'time',
  'drawdown',
  'kill_switch',
  'manual',
  'reconcile',
  'unmanaged',
];

/**
 * Kategorie eines Trades. Fehlt `stopTrailed` (Live-Buch, älteres Journal,
 * Test-Fake), zählt der Trade unter `stop` — „Herkunft unbekannt" wird NICHT
 * zu „Trailing" geraten; `ExitAnatomie.stopOhneHerkunft` sagt, wie viele das
 * betrifft.
 */
export function exitKategorie(t: Trade): ExitKategorie {
  return t.exitReason === 'stop' && t.stopTrailed === true ? 'trailing' : t.exitReason;
}

/* ───────────────────────── Verteilungs-Helfer ───────────────────────── */

/** Median einer Zahlenreihe (Kopie, Eingabe bleibt unberührt); NaN bei leerer Reihe. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Quartile {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  n: number;
}

/**
 * Quartile nach linearer Interpolation (Typ 7, wie R und NumPy). Der
 * Mittelwert allein verschweigt bei Trades das Wesentliche: Eine Handvoll
 * Ausreißer trägt den ganzen Schnitt.
 */
export function quartile(xs: readonly number[]): Quartile | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = p * (s.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? s[lo]! : s[lo]! + (idx - lo) * (s[hi]! - s[lo]!);
  };
  return { min: s[0]!, q1: at(0.25), median: at(0.5), q3: at(0.75), max: s[s.length - 1]!, n: s.length };
}

/* ───────────────────────── Exit-Anatomie ───────────────────────── */

export interface ExitZeile {
  kategorie: ExitKategorie;
  anzahl: number;
  /** Anteil an allen Trades (0–1). */
  anteil: number;
  /** Summe der Netto-Ergebnisse dieser Kategorie in USD. */
  nettoSumme: number;
  /** Netto je Trade dieser Kategorie in USD (Mittelwert). */
  nettoMittel: number;
  /** Median des Nettos je Trade in USD. */
  nettoMedian: number;
  /** Anteil der Trades mit netPnl > 0 (0–1). */
  trefferquote: number;
  /** Haltedauer in Bars des Strategie-Zeitrahmens. */
  barsMittel: number;
  barsMedian: number;
  /**
   * Beitrag zum Gesamtergebnis: `nettoSumme / Σ|nettoSumme je Kategorie|`
   * (−1 … +1). Bewusst am BETRAG normiert und nicht am Netto: Bei einem
   * Gesamtnetto nahe null wäre jeder Anteil eine Zufallszahl, bei negativem
   * Gesamtnetto bekäme ein Verlustbringer ein Pluszeichen. null, wenn keine
   * Kategorie etwas bewegt hat.
   */
  nettoBeitrag: number | null;
}

export interface ExitAnatomie {
  trades: number;
  /** Σ netPnl über alle Trades in USD. */
  netto: number;
  /** Nur Kategorien mit mindestens einem Trade, in der Reihenfolge von `EXIT_KATEGORIEN`. */
  zeilen: ExitZeile[];
  /** Stop-Ausstiege ohne überlieferte Marken-Herkunft (`stopTrailed` fehlt) — sie stehen unter `stop`. */
  stopOhneHerkunft: number;
}

/**
 * Je Ausstiegsgrund: Anzahl, Anteil, Netto (Summe/Mittel/Median),
 * Trefferquote, Haltedauer und Beitrag zum Ergebnis. Das ist die Tabelle, an
 * der man sieht, ob ein Stop zu eng oder ein Ziel zu nah sitzt.
 */
export function exitAnatomie(trades: readonly Trade[]): ExitAnatomie {
  const gruppen = new Map<ExitKategorie, Trade[]>();
  let stopOhneHerkunft = 0;
  let netto = 0;
  for (const t of trades) {
    netto += t.netPnl;
    if (t.exitReason === 'stop' && t.stopTrailed === undefined) stopOhneHerkunft++;
    const k = exitKategorie(t);
    const g = gruppen.get(k);
    if (g) g.push(t);
    else gruppen.set(k, [t]);
  }
  const summen = new Map<ExitKategorie, number>();
  let betragSumme = 0;
  for (const [k, g] of gruppen) {
    const s = g.reduce((acc, t) => acc + t.netPnl, 0);
    summen.set(k, s);
    betragSumme += Math.abs(s);
  }
  const zeilen: ExitZeile[] = [];
  for (const kategorie of EXIT_KATEGORIEN) {
    const g = gruppen.get(kategorie);
    if (!g || g.length === 0) continue;
    const nettoSumme = summen.get(kategorie)!;
    const netti = g.map((t) => t.netPnl);
    const bars = g.map((t) => t.barsHeld);
    zeilen.push({
      kategorie,
      anzahl: g.length,
      anteil: trades.length > 0 ? g.length / trades.length : 0,
      nettoSumme,
      nettoMittel: nettoSumme / g.length,
      nettoMedian: median(netti),
      trefferquote: g.filter((t) => t.netPnl > 0).length / g.length,
      barsMittel: bars.reduce((a, b) => a + b, 0) / g.length,
      barsMedian: median(bars),
      nettoBeitrag: betragSumme > 0 ? nettoSumme / betragSumme : null,
    });
  }
  return { trades: trades.length, netto, zeilen, stopOhneHerkunft };
}

/* ───────────────────────── MFE / MAE ───────────────────────── */

export interface Exkursion {
  /** Größter Buchgewinn während der Haltezeit in % vom Einstand (≥ 0). */
  mfePct: number;
  /** Größter Buchverlust während der Haltezeit in % vom Einstand (≤ 0). */
  maePct: number;
  /** Netto-Ergebnis in % des Einstandswerts der Position (netPnl / (Einstand × Stück)). */
  nettoPct: number;
  /**
   * `nettoPct / mfePct` — welcher Anteil des erreichten Buchgewinns wurde
   * mitgenommen? 1 = am Hoch ausgestiegen, deutlich unter 1 = Ziel zu nah
   * oder Trailing zu früh, negativ = aus einem Buchgewinn wurde ein Verlust.
   * null, wenn es keinen Buchgewinn gab (mfePct ≤ 0).
   */
  mitnahme: number | null;
  gewinner: boolean;
  kategorie: ExitKategorie;
}

/** Exkursion eines Trades in Prozent vom Einstand; null, wenn MFE/MAE fehlen oder der Einstand ≤ 0 ist. */
export function exkursionVon(t: Trade): Exkursion | null {
  if (t.mae === null || t.mfe === null || !(t.entryPrice > 0) || !(t.qty > 0)) return null;
  const vz = t.side === 'long' ? 1 : -1;
  const mfePct = ((t.mfe - t.entryPrice) / t.entryPrice) * vz * 100;
  const maePct = ((t.mae - t.entryPrice) / t.entryPrice) * vz * 100;
  const nettoPct = (t.netPnl / (t.entryPrice * t.qty)) * 100;
  return {
    mfePct,
    maePct,
    nettoPct,
    mitnahme: mfePct > 0 ? nettoPct / mfePct : null,
    gewinner: t.netPnl > 0,
    kategorie: exitKategorie(t),
  };
}

export interface ExkursionAuswertung {
  /** Trades mit MFE/MAE. */
  gemessen: number;
  /** Trades ohne MFE/MAE (Live-Buch, Fake, Einstand 0) — sie gehen in keine Zahl ein. */
  ohneDaten: number;
  gewinner: {
    anzahl: number;
    /** Anteil des mitgenommenen Buchgewinns (`netto / MFE`). */
    mitnahme: Quartile | null;
    mfePct: Quartile | null;
    nettoPct: Quartile | null;
  };
  verlierer: {
    anzahl: number;
    /** Wie weit lief der Kurs gegen die Position (≤ 0, in % vom Einstand)? */
    maePct: Quartile | null;
    /** Wie weit war sie zwischendurch im Plus (≥ 0)? */
    mfePct: Quartile | null;
    /**
     * Verlierer, die zwischendurch WEITER im Plus standen, als sie am Ende im
     * Minus schlossen (mfePct + nettoPct > 0) — abgegebene Gewinne, nicht
     * bloß Rauschen. Kein Urteil: Der Stop ist auch der Grund, dass es noch
     * Kapital gibt (siehe `stopNachlauf`).
     */
    warWeiterImPlus: number;
  };
  alle: { mfePct: Quartile | null; maePct: Quartile | null };
}

/** MFE/MAE über alle Trades, getrennt nach Gewinnern und Verlierern — als Verteilung, nicht als Mittelwert. */
export function exkursionAuswertung(trades: readonly Trade[]): ExkursionAuswertung {
  const gemessen: Exkursion[] = [];
  let ohneDaten = 0;
  for (const t of trades) {
    const e = exkursionVon(t);
    if (e) gemessen.push(e);
    else ohneDaten++;
  }
  const g = gemessen.filter((e) => e.gewinner);
  const v = gemessen.filter((e) => !e.gewinner);
  const mitnahmen = g.map((e) => e.mitnahme).filter((x): x is number => x !== null);
  return {
    gemessen: gemessen.length,
    ohneDaten,
    gewinner: {
      anzahl: g.length,
      mitnahme: quartile(mitnahmen),
      mfePct: quartile(g.map((e) => e.mfePct)),
      nettoPct: quartile(g.map((e) => e.nettoPct)),
    },
    verlierer: {
      anzahl: v.length,
      maePct: quartile(v.map((e) => e.maePct)),
      mfePct: quartile(v.map((e) => e.mfePct)),
      warWeiterImPlus: v.filter((e) => e.mfePct + e.nettoPct > 0).length,
    },
    alle: { mfePct: quartile(gemessen.map((e) => e.mfePct)), maePct: quartile(gemessen.map((e) => e.maePct)) },
  };
}

/* ───────────────────────── Die Kehrseite: was nach dem Stop geschah ───────────────────────── */

export interface NachlaufErgebnis {
  /** Geprüfte Bars nach dem Ausstieg. */
  horizont: number;
  /** Per Stop oder Trailing geschlossene Verlust-Trades. */
  verlierer: number;
  /** Davon mit mindestens einer Folgebar innerhalb der Grenze. */
  geprueft: number;
  /** Ohne Folgebars (Fensterende, fehlende Serie) — kein Urteil. */
  ohneDaten: number;
  /**
   * Davon: Der Kurs erreichte im Horizont wieder den Einstand. OBERGRENZE —
   * gerechnet wird brutto gegen den Einstandskurs, ohne Kosten und ohne die
   * Frage, ob das Konto den Weg dorthin überlebt hätte.
   */
  erholt: number;
}

/** Erster Index mit t > `ms` (Bars sind aufsteigend sortiert). */
function nachIndex(t: Float64Array, ms: Ms, laenge: number): number {
  let lo = 0;
  let hi = laenge;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Die Kehrseite der MAE-Tabelle: Wie viele der ausgestoppten Verlierer hätten
 * sich erholt, wenn niemand sie geschlossen hätte?
 *
 * Ausdrücklich eine WAS-WÄRE-WENN-Rechnung im Nachhinein. Sie sieht Bars NACH
 * dem Ausstieg, gehört also in keinen Entscheidungspfad und in kein Gate —
 * nur in den Bericht. `bis` begrenzt den Blick hart (im Optimierer auf das
 * Ende der OOS-Kette), damit die Zahl nicht in den Holdout hineinreicht.
 *
 * Die Antwort trägt zwei Richtungen: Eine hohe Quote heißt, dass der Stop
 * Gewinner abschneidet — eine niedrige, dass er genau das tut, wofür er da
 * ist. Der Kritiker darf das Ergebnis in keine der beiden Richtungen
 * weglesen.
 */
export function stopNachlauf(a: {
  trades: readonly Trade[];
  bars: ReadonlyMap<string, BarSeriesLike>;
  /** Bars nach dem Ausstieg, die geprüft werden (≥ 1). */
  horizont: number;
  /** Harte Obergrenze der Zeitachse (exklusiv) — Bars ab hier zählen nicht mehr. */
  bis?: Ms | undefined;
}): NachlaufErgebnis {
  const horizont = Math.max(1, Math.floor(a.horizont));
  const bis = a.bis ?? Number.POSITIVE_INFINITY;
  let verlierer = 0;
  let geprueft = 0;
  let ohneDaten = 0;
  let erholt = 0;
  for (const t of a.trades) {
    if (t.exitReason !== 'stop' || t.netPnl >= 0) continue;
    verlierer++;
    const serie = a.bars.get(t.symbol);
    if (!serie || serie.length === 0) {
      ohneDaten++;
      continue;
    }
    const start = nachIndex(serie.t, t.exitTime, serie.length);
    const ende = Math.min(serie.length, start + horizont);
    let gesehen = 0;
    let zurueck = false;
    for (let i = start; i < ende; i++) {
      if (serie.t[i]! >= bis) break;
      gesehen++;
      if (t.side === 'long' ? serie.h[i]! >= t.entryPrice : serie.l[i]! <= t.entryPrice) {
        zurueck = true;
        break;
      }
    }
    if (gesehen === 0) ohneDaten++;
    else {
      geprueft++;
      if (zurueck) erholt++;
    }
  }
  return { horizont, verlierer, geprueft, ohneDaten, erholt };
}

/** Median der Haltedauer in Bars — die natürliche Zeitskala einer Taktik, Nenner für den Nachlauf-Horizont. */
export function medianHaltedauer(trades: readonly Trade[]): number {
  if (trades.length === 0) return 1;
  return Math.max(1, Math.round(median(trades.map((t) => t.barsHeld))));
}
