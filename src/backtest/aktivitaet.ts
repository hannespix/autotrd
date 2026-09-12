/**
 * Aktivitätskennzahlen und die Korrelation der Tagesrenditen.
 *
 * Zwei Fragen, die der Bericht bisher nicht beantwortet hat:
 *
 * 1. „Es muss aktiv handeln" (Owner, 12.09.2026) — WIE aktiv ist ein
 *    Kandidat wirklich? Trades je Monat allein sagt das nicht: Vier Trades
 *    im Monat können vier Tage oder das ganze Jahr im Markt bedeuten. Dazu
 *    gehören Zeit im Markt, gleichzeitige Positionen, gebundenes Kapital —
 *    und vor allem die längste Phase, in der gar nichts passiert ist. Das
 *    Aktivitätsbudget in docs/wissen/aktivitaet.md nennt die Zielbereiche.
 * 2. Lohnt ein Ensemble aus mehreren Taktiken? Das entscheidet die
 *    Korrelation der Tagesrenditen, nichts sonst. Zwei Kandidaten mit
 *    Sharpe 0,6 und Korrelation 0,9 sind ein Kandidat; mit Korrelation 0,1
 *    sind sie ein deutlich besseres Portfolio.
 *
 * NUR MESSUNG. Nichts hier wird von `decide()`, vom Simulator oder von einem
 * Gate gelesen; alle Funktionen sind rein und arbeiten auf abgeschlossenen
 * Trades und fertigen Equity-Kurven.
 */
import { DAY, dayKeyFor } from '../core/time.ts';
import type { AssetClass, EquityPoint, Ms, Trade } from '../core/types.ts';

/* ───────────────────────── Aktivität ───────────────────────── */

export interface Aktivitaet {
  trades: number;
  /** Handelstage der gemessenen Fenster (Tage mit mindestens einer Bar). */
  handelstage: number;
  /**
   * Anteil der Handelstage mit mindestens einer offenen Position (0–1) —
   * „Zeit im Markt". Quelle siehe `zeitImMarktQuelle`.
   */
  zeitImMarkt: number | null;
  /**
   * `exposure`: aus der Equity-Kurve (Brutto-Exposure je Bar) — die genaue
   * Zahl, sie kennt auch am Fensterende offene Positionen. `trades`:
   * ersatzweise aus den Haltezeiten abgeschlossener Trades; dann fehlt, was
   * am Ende offen blieb. null: nicht bewertbar.
   */
  zeitImMarktQuelle: 'exposure' | 'trades' | null;
  /**
   * Mittlere Zahl gleichzeitig offener Positionen je Bar. Immer aus den
   * Haltezeiten abgeschlossener Trades — eine am Fensterende offene Position
   * ist in keinem Trade und fehlt deshalb.
   */
  mittlerePositionen: number | null;
  /**
   * Mittleres gebundenes Kapital in % der Equity (Mittel von
   * `EquityPoint.exposure` über die Bars der Fenster); null, wenn der
   * Simulator keine Exposure liefert — dann „nicht bewertbar", nie 0.
   */
  mittlereExposurePct: number | null;
  /**
   * Längste zusammenhängende Phase OHNE einen einzigen Einstieg, in
   * Handelstagen der gemessenen Fenster. Gezählt werden auch die Ränder: vom
   * ersten Handelstag bis zum ersten Einstieg und vom letzten Einstieg bis
   * zum letzten Handelstag. Ohne einen einzigen Einstieg ist es das ganze
   * Fenster.
   */
  laengstePause: number | null;
  /** Erster und letzter Handelstag der längsten Pause (YYYY-MM-DD). */
  pauseVon: string | null;
  pauseBis: string | null;
}

/** Tagesschlüssel der Bars einer Equity-Kurve, aufsteigend und ohne Dubletten. */
function handelstageVon(equity: readonly EquityPoint[], assetClass: AssetClass): string[] {
  const tage = new Set<string>();
  for (const p of equity) tage.add(dayKeyFor(p.t, assetClass));
  return [...tage].sort();
}

/**
 * Aktivität eines Laufs (oder einer Kette von Fenstern) aus seinen Trades und
 * seiner Equity-Kurve. `equity` liefert die Zeitachse (je Bar ein Punkt) und,
 * falls vorhanden, die Exposure je Bar.
 */
export function aktivitaet(a: { trades: readonly Trade[]; equity: readonly EquityPoint[]; assetClass: AssetClass }): Aktivitaet {
  const { trades, assetClass } = a;
  const equity = [...a.equity].sort((x, y) => x.t - y.t);
  const tage = handelstageVon(equity, assetClass);
  const leer: Aktivitaet = {
    trades: trades.length,
    handelstage: tage.length,
    zeitImMarkt: null,
    zeitImMarktQuelle: null,
    mittlerePositionen: null,
    mittlereExposurePct: null,
    laengstePause: null,
    pauseVon: null,
    pauseBis: null,
  };
  if (equity.length === 0 || tage.length === 0) return leer;

  // Gleichzeitige Positionen je Bar: eine Position liegt an Bar t im Buch,
  // wenn sie zu t oder davor gefüllt wurde und noch nicht geschlossen ist —
  // derselbe Stand, den der Simulator am Schluss der Bar als Exposure bucht.
  // Zwei wandernde Zeiger über sortierte Ein- und Ausstiegszeiten statt einer
  // Schleife über alle Trades je Bar.
  const einstiegsZeiten = trades.map((t) => t.entryTime).sort((x, y) => x - y);
  const ausstiegsZeiten = trades.map((t) => t.exitTime).sort((x, y) => x - y);
  let iEin = 0;
  let iAus = 0;
  let offeneSumme = 0;
  const tageMitPosition = new Set<string>();
  for (const p of equity) {
    while (iEin < einstiegsZeiten.length && einstiegsZeiten[iEin]! <= p.t) iEin++;
    while (iAus < ausstiegsZeiten.length && ausstiegsZeiten[iAus]! <= p.t) iAus++;
    const offen = iEin - iAus;
    offeneSumme += offen;
    if (offen > 0) tageMitPosition.add(dayKeyFor(p.t, assetClass));
  }
  const mittlerePositionen = offeneSumme / equity.length;

  // Exposure: nur wenn JEDER Punkt sie trägt — ein halb gefülltes Feld wäre
  // ein zu kleiner Mittelwert und damit ein zu schöner normierter Drawdown.
  let mittlereExposurePct: number | null = null;
  let zeitImMarkt: number | null = null;
  let zeitImMarktQuelle: Aktivitaet['zeitImMarktQuelle'] = null;
  if (equity.every((p) => p.exposure !== undefined)) {
    let summe = 0;
    const tageInvestiert = new Set<string>();
    for (const p of equity) {
      const e = p.exposure!;
      summe += e;
      if (e > 0) tageInvestiert.add(dayKeyFor(p.t, assetClass));
    }
    mittlereExposurePct = (summe / equity.length) * 100;
    zeitImMarkt = tageInvestiert.size / tage.length;
    zeitImMarktQuelle = 'exposure';
  } else if (trades.length > 0) {
    zeitImMarkt = tageMitPosition.size / tage.length;
    zeitImMarktQuelle = 'trades';
  }

  // Längste Pause: zusammenhängende Handelstage ohne einen Einstieg. Die
  // Läufe werden gesammelt und danach verglichen — kein Zustand über eine
  // Closure, damit die Zahl an einer Stelle entsteht.
  const einstiege = new Set<string>();
  for (const t of trades) einstiege.add(dayKeyFor(t.entryTime, assetClass));
  const laeufe: { von: string; bis: string; tage: number }[] = [];
  let start = -1;
  for (let i = 0; i <= tage.length; i++) {
    const einstieg = i === tage.length || einstiege.has(tage[i]!);
    if (!einstieg) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      laeufe.push({ von: tage[start]!, bis: tage[i - 1]!, tage: i - start });
      start = -1;
    }
  }
  let laengste: { von: string; bis: string; tage: number } | null = null;
  for (const l of laeufe) if (laengste === null || l.tage > laengste.tage) laengste = l;

  return {
    trades: trades.length,
    handelstage: tage.length,
    zeitImMarkt,
    zeitImMarktQuelle,
    mittlerePositionen,
    mittlereExposurePct,
    laengstePause: laengste === null ? 0 : laengste.tage,
    pauseVon: laengste === null ? null : laengste.von,
    pauseBis: laengste === null ? null : laengste.bis,
  };
}

/* ───────────────────────── Tagesrenditen mit Datum ───────────────────────── */

export interface Renditereihe {
  /** Handelstage (YYYY-MM-DD), aufsteigend und ohne Dubletten. */
  tage: string[];
  /** Tagesrendite je Tag; der erste Tag eines Fensters gegen `initialEquity`. */
  renditen: number[];
}

/**
 * Tagesrenditen MIT Datum aus einer Equity-Kurve — dieselbe Rechnung, die der
 * Simulator für `SimResult.dailyReturns` macht (Schlussstand je Handelstag,
 * erster Tag gegen das Startkapital), nur mit dem Tagesschlüssel daneben.
 * Ohne Datum lässt sich keine Korrelation bilden: Zwei Reihen gleicher Länge
 * sind noch lange nicht dieselben Tage.
 *
 * Der Wächter dafür ist test/backtest/aktivitaet.test.ts — `renditen` muss
 * Wert für Wert `SimResult.dailyReturns` desselben Laufs entsprechen.
 */
export function tagesrenditen(a: { equity: readonly EquityPoint[]; initialEquity: number; assetClass: AssetClass }): Renditereihe {
  const punkte = [...a.equity].sort((x, y) => x.t - y.t);
  const schluss = new Map<string, number>();
  for (const p of punkte) schluss.set(dayKeyFor(p.t, a.assetClass), p.equity);
  const tage = [...schluss.keys()].sort();
  const renditen: number[] = [];
  let vor = a.initialEquity;
  for (const tag of tage) {
    const e = schluss.get(tag)!;
    renditen.push(vor > 0 ? e / vor - 1 : 0);
    vor = e;
  }
  return { tage, renditen };
}

/** Mehrere Fenster (OOS-Kette) zu EINER Reihe hängen — jedes Fenster startet frisch bei `initialEquity`. */
export function renditeketteVon(a: {
  fenster: readonly { equity: readonly EquityPoint[] }[];
  initialEquity: number;
  assetClass: AssetClass;
}): Renditereihe {
  const tage: string[] = [];
  const renditen: number[] = [];
  for (const f of a.fenster) {
    const r = tagesrenditen({ equity: f.equity, initialEquity: a.initialEquity, assetClass: a.assetClass });
    for (let i = 0; i < r.tage.length; i++) {
      tage.push(r.tage[i]!);
      renditen.push(r.renditen[i]!);
    }
  }
  return { tage, renditen };
}

/* ───────────────────────── Korrelation ───────────────────────── */

export interface Korrelationsmatrix {
  namen: string[];
  /** `werte[i][j]` = Korrelation der Reihen i und j; null = zu wenige gemeinsame Tage. Diagonale 1. */
  werte: (number | null)[][];
  /** Mittel aller berechenbaren Paare oberhalb der Diagonalen; null, wenn kein Paar berechenbar ist. */
  durchschnitt: number | null;
  /** Gemeinsame Tage, die ein Paar mindestens braucht. */
  mindestTage: number;
  /** Kleinste und größte Zahl gemeinsamer Tage über alle Paare (Belastbarkeit der Matrix). */
  minGemeinsameTage: number | null;
  maxGemeinsameTage: number | null;
  /** Paare, die an `mindestTage` gescheitert sind. */
  zuWenigeTage: number;
}

/** Pearson-Korrelation zweier gleich langer Reihen; null bei < 2 Werten oder σ = 0 (eine Konstante korreliert mit nichts). */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  // Rundungsfehler dürfen keine Korrelation > 1 erzeugen.
  return Math.max(-1, Math.min(1, r));
}

/**
 * Korrelationsmatrix der Tagesrenditen mehrerer Kandidaten.
 *
 * Zwei Regeln, die die Zahl lesbar machen und beide in der Legende des
 * Berichts stehen müssen:
 *
 * - Verglichen wird je Paar auf den GEMEINSAMEN Handelstagen. Ein Tag, den
 *   ein Kandidat nicht gemessen hat (anderes OOS-Fenster, andere Historie),
 *   ist kein Datenpunkt — er wird weggelassen, nicht mit 0 aufgefüllt.
 * - Ein gemessener Tag OHNE Position hat die Rendite 0, und die zählt.
 *   Nicht investiert heißt kein Ertrag — das ist die ökonomisch richtige
 *   Wahl. Wer solche Tage wegließe, bekäme eine BEDINGTE Korrelation
 *   („wenn beide investiert sind") und damit eine ganz andere Aussage: Für
 *   die Frage, ob ein Ensemble Rendite glättet, zählen gerade die Tage, an
 *   denen der eine steht und der andere läuft.
 */
export function korrelationsmatrix(reihen: readonly { name: string; reihe: Renditereihe }[], mindestTage = 20): Korrelationsmatrix {
  const namen = reihen.map((r) => r.name);
  const karten = reihen.map((r) => {
    const m = new Map<string, number>();
    for (let i = 0; i < r.reihe.tage.length; i++) m.set(r.reihe.tage[i]!, r.reihe.renditen[i]!);
    return m;
  });
  const werte: (number | null)[][] = reihen.map(() => reihen.map(() => null));
  let summe = 0;
  let paare = 0;
  let minTage: number | null = null;
  let maxTage: number | null = null;
  let zuWenigeTage = 0;
  for (let i = 0; i < reihen.length; i++) {
    werte[i]![i] = 1;
    for (let j = i + 1; j < reihen.length; j++) {
      const a = karten[i]!;
      const b = karten[j]!;
      const x: number[] = [];
      const y: number[] = [];
      for (const [tag, v] of a) {
        const w = b.get(tag);
        if (w === undefined) continue;
        x.push(v);
        y.push(w);
      }
      minTage = minTage === null ? x.length : Math.min(minTage, x.length);
      maxTage = maxTage === null ? x.length : Math.max(maxTage, x.length);
      const r = x.length >= mindestTage ? pearson(x, y) : null;
      if (x.length < mindestTage) zuWenigeTage++;
      werte[i]![j] = r;
      werte[j]![i] = r;
      if (r !== null) {
        summe += r;
        paare++;
      }
    }
  }
  return {
    namen,
    werte,
    durchschnitt: paare > 0 ? summe / paare : null,
    mindestTage,
    minGemeinsameTage: minTage,
    maxGemeinsameTage: maxTage,
    zuWenigeTage,
  };
}

/** Kalendertage eines Fensters — dieselbe Zählung wie `computeMetrics` (aufgerundet, mindestens 1). */
export function kalendertage(range: { start: Ms; end: Ms }): number {
  return Math.max(1, Math.ceil((range.end - range.start) / DAY));
}
