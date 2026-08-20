/**
 * momentum.ts — Cross-Sectional Momentum über das ganze Universum (Owner-Go
 * 28.07.: „Voll: Momentum-Umbau").
 *
 * ── Warum ausgerechnet Momentum ─────────────────────────────────────────────
 *
 * Es ist die am besten replizierte Anomalie, die mit unseren Mitteln
 * handelbar ist: Jegadeesh/Titman (1993) für US-Aktien, Asness/Moskowitz/
 * Pedersen (2013) über acht Assetklassen — exakt unser Katalog-Zuschnitt —,
 * Moskowitz/Ooi/Pedersen (2012) für die Zeitreihen-Variante. Und sie passt
 * zu unseren einzigen echten Vorteilen: kein Rechenschaftsdruck, kein
 * Market-Impact, kein Zwang, investiert zu sein. Alles Zeithorizont-Vorteile
 * — deshalb Wochenrhythmus, nicht 5-Minuten-Takt.
 *
 * ── Die Konstruktion ────────────────────────────────────────────────────────
 *
 *  Score    = Rendite über ~11 Monate, den letzten Monat AUSGENOMMEN
 *             („12-1"): Auf Monatssicht kehren Kurse eher um (Jegadeesh
 *             1990), das Momentum sitzt in den Monaten davor. Wer den
 *             letzten Monat mitzählt, mischt zwei gegenläufige Effekte.
 *  Auswahl  = die TOP_N Symbole mit dem höchsten Score, gleichgewichtet.
 *             Gleichgewichtung statt Score-Gewichtung ist eine bewusste
 *             Demutsgeste: Die RANGFOLGE der Scores ist Evidenz, ihre
 *             GRÖSSE auf unserer Datenbasis vor allem Rauschen.
 *  Filter   = gehandelt wird nur, wenn der Leitindex über seinem
 *             200-Tage-Schnitt steht (Faber 2007). Momentum-Crashs
 *             passieren in Erholungsphasen NACH Markteinbrüchen
 *             (Daniel/Moskowitz 2016) — der Filter ist die billigste
 *             bekannte Versicherung dagegen: Er kostet im Bullenmarkt fast
 *             nichts und nimmt im Bären das Kapital vom Tisch.
 *  Rhythmus = wöchentlich prüfen, NUR Abweichungen handeln. Täglich neu
 *             ranken hieße, das Kosten-Problem der 5-min-Konfluenz in
 *             langsamer wieder einzubauen.
 *
 * Alles hier ist PUR — Eingaben rein, Zielportfolio raus. Wer die Kurse
 * liefert und wer die Orders ausführt, entscheidet der Aufrufer; nur so
 * lässt sich jede Regel ohne Datenbank und ohne Netz testen.
 */

export interface MomentumOptions {
  /** Fenster des Scores in Handelstagen (~12 Monate). */
  lookbackDays?: number;
  /** Jüngste Tage, die NICHT zählen (~1 Monat, Reversal-Schutz). */
  skipDays?: number;
  /**
   * Mindest-Datenlage in Handelstagen. Wer weniger Historie hat, bekommt
   * KEINEN Score statt eines aus kurzem Fenster gerechneten: Ein Score aus
   * drei Monaten ist mit einem aus zwölf nicht vergleichbar, und ein
   * Ranking über unvergleichbare Scores ist wertlos.
   */
  minBars?: number;
}

export const MOMENTUM_DEFAULTS: Required<MomentumOptions> = {
  lookbackDays: 252,
  skipDays: 21,
  minBars: 200,
};

/** Zahl der gehaltenen Positionen — klein genug für 25-k-Konten (je ~3 k $),
 *  groß genug, dass kein Einzelwert das Ergebnis dominiert. */
export const MOMENTUM_TOP_N = 8;

/** SMA-Fenster des Marktfilters (Faber 2007: 10-Monats-SMA ≈ 200 Tage). */
export const MARKET_FILTER_SMA = 200;

/**
 * 12-1-Momentum-Score: Gesamtrendite von t−lookback bis t−skip, in Prozent.
 * `null` = nicht bewertbar (zu wenig Historie oder kaputte Kurse) — und
 * nicht bewertbar heißt: nimmt am Ranking nicht teil, wird also weder
 * gekauft noch künstlich schlecht gestellt.
 */
export function momentumScore(closes: number[], opts: MomentumOptions = {}): number | null {
  const { lookbackDays, skipDays, minBars } = { ...MOMENTUM_DEFAULTS, ...opts };
  if (closes.length < minBars) return null;
  const endIdx = closes.length - 1 - skipDays;
  const startIdx = Math.max(0, closes.length - 1 - lookbackDays);
  if (endIdx <= startIdx) return null;
  const start = closes[startIdx]!;
  const end = closes[endIdx]!;
  if (!(start > 0) || !(end > 0) || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return ((end / start - 1) * 100 + Number.EPSILON) as number;
}

export interface RankedSymbol {
  symbol: string;
  /** 12-1-Score in Prozent. */
  score: number;
}

/**
 * Universum ranken: Score je Symbol, unbewertbare fallen raus, Rest
 * absteigend sortiert. Gleichstand wird alphabetisch gebrochen — nicht aus
 * fachlichem Grund, sondern damit zwei Läufe über dieselben Daten IMMER
 * dasselbe Portfolio liefern (Determinismus schlägt Eleganz).
 */
export function rankMomentum(
  universe: ReadonlyMap<string, number[]> | Record<string, number[]>,
  opts: MomentumOptions = {},
): RankedSymbol[] {
  const entries = universe instanceof Map ? [...universe.entries()] : Object.entries(universe);
  const out: RankedSymbol[] = [];
  for (const [symbol, closes] of entries) {
    const score = momentumScore(closes, opts);
    if (score !== null) out.push({ symbol, score: Math.round(score * 100) / 100 });
  }
  out.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return out;
}

/**
 * Marktfilter: Steht der Leitindex über seinem 200-Tage-Schnitt?
 *
 * `false` heißt: kein einziger Neukauf; bestehende Positionen werden beim
 * nächsten Rebalancing aufgelöst. Zu wenig Historie zählt als `false` —
 * die konservative Lesart, denn der Filter ist eine Versicherung, und eine
 * Versicherung, die bei Unklarheit „versichert" meldet, wäre keine.
 */
export function marketFilterPasses(indexCloses: number[], smaWindow = MARKET_FILTER_SMA): boolean {
  if (indexCloses.length < smaWindow) return false;
  const last = indexCloses[indexCloses.length - 1]!;
  if (!(last > 0)) return false;
  const fenster = indexCloses.slice(-smaWindow);
  const sma = fenster.reduce((a, b) => a + b, 0) / smaWindow;
  return last > sma;
}

export interface TargetPosition {
  symbol: string;
  /** Zielanteil am Gesamtkapital, 0–1. */
  weight: number;
}

/**
 * Zielportfolio: Top-N gleichgewichtet — oder leer, wenn der Marktfilter
 * geschlossen hat. Positives Momentum ist zusätzlich Pflicht: In einem
 * Markt, in dem selbst die besten N gefallen sind, „relativ am wenigsten
 * verloren" zu kaufen wäre Ranking-Logik ohne Sinn für die Richtung.
 */
export function targetPortfolio(
  ranked: RankedSymbol[],
  marktOffen: boolean,
  topN = MOMENTUM_TOP_N,
): TargetPosition[] {
  if (!marktOffen) return [];
  const gewinner = ranked.filter((r) => r.score > 0).slice(0, topN);
  if (gewinner.length === 0) return [];
  const weight = Math.round((1 / gewinner.length) * 10_000) / 10_000;
  return gewinner.map((g) => ({ symbol: g.symbol, weight }));
}

export interface RebalanceOrder {
  symbol: string;
  side: 'buy' | 'sell';
  /** Ziel-Notional in Kontowährung (bei sell: kompletter Bestand = null). */
  notional: number | null;
}

/* ── Schatten-Konto ─────────────────────────────────────────────────────────
 *
 * Die Momentum-Strategie läuft ZUERST als Schattenkonto neben der echten —
 * umgestellt wird nur, was sich mit derselben Evidenzschwelle durchsetzt,
 * die auch der Auto-Tuner anlegt (judgeCandidate). Nichts an diesem Umbau
 * darf auf der Behauptung beruhen, dass die Literatur schon recht haben
 * wird; sie muss es auf UNSEREN Daten zeigen.
 */

export interface MomentumHolding {
  qty: number;
  avgEntry: number;
  openedAt: string;
}

export interface MomentumBook {
  cash: number;
  holdings: Record<string, MomentumHolding>;
  /** Ergebnisse geschlossener Positionen, jüngste zuletzt (für judgeCandidate). */
  pnls: number[];
  startedAt: string;
  lastRebalance: string | null;
}

export function emptyMomentumBook(startkapital: number, now: Date): MomentumBook {
  return {
    cash: startkapital,
    holdings: {},
    pnls: [],
    startedAt: now.toISOString(),
    lastRebalance: null,
  };
}

/** Depotwert = Cash + bewertete Bestände. Fehlt ein Kurs, zählt der Einstand
 *  — lieber ein leicht veralteter Wert als ein Loch in der Equity-Kurve. */
export function momentumEquity(book: MomentumBook, preise: ReadonlyMap<string, number>): number {
  let sum = book.cash;
  for (const [sym, h] of Object.entries(book.holdings)) {
    const p = preise.get(sym);
    sum += h.qty * (p !== undefined && p > 0 ? p : h.avgEntry);
  }
  return Math.round(sum * 100) / 100;
}

export interface ApplyOrdersInput {
  book: MomentumBook;
  orders: RebalanceOrder[];
  preise: ReadonlyMap<string, number>;
  /** Gebührensatz JE SEITE, je Symbol — klassenecht (siehe feeRateForClass). */
  feeRate: (symbol: string) => number;
  /** Erlaubt Bruchstücke (Krypto); sonst wird auf ganze Stücke abgerundet. */
  fractional?: (symbol: string) => boolean;
  now: Date;
}

/**
 * Orders auf das Schattenkonto anwenden.
 *
 * Verkäufe laufen zuerst und schreiben ihr Ergebnis in `pnls` — dieselbe
 * Größe, die `judgeCandidate` für den Vergleich braucht. Käufe erst danach,
 * denn sie leben vom Cash der Verkäufe. Reicht das Cash für eine Order
 * nicht, wird sie ANTEILIG ausgeführt statt verworfen: Ein Portfolio, das
 * eine Position wegen eines Rundungs-Cents komplett auslässt, wäre nicht das
 * Portfolio, das die Strategie beschreibt.
 */
export function applyMomentumOrders(input: ApplyOrdersInput): MomentumBook {
  const { orders, preise, feeRate, fractional, now } = input;
  let cash = input.book.cash;
  const holdings = { ...input.book.holdings };
  const pnls = [...input.book.pnls];

  for (const o of orders.filter((x) => x.side === 'sell')) {
    const h = holdings[o.symbol];
    const p = preise.get(o.symbol);
    if (!h || p === undefined || !(p > 0)) continue;
    const erloes = h.qty * p * (1 - feeRate(o.symbol));
    const einstand = h.qty * h.avgEntry;
    cash += erloes;
    pnls.push(Math.round((erloes - einstand) * 100) / 100);
    delete holdings[o.symbol];
  }

  for (const o of orders.filter((x) => x.side === 'buy')) {
    const p = preise.get(o.symbol);
    if (p === undefined || !(p > 0) || o.notional === null) continue;
    const budget = Math.min(o.notional, cash);
    if (budget <= 0) continue;
    const stueckpreis = p * (1 + feeRate(o.symbol));
    let qty = budget / stueckpreis;
    if (!fractional?.(o.symbol)) qty = Math.floor(qty);
    if (!(qty > 0)) continue;
    const kosten = qty * stueckpreis;
    if (kosten > cash + 1e-9) continue;
    cash -= kosten;
    const alt = holdings[o.symbol];
    const neueQty = (alt?.qty ?? 0) + qty;
    holdings[o.symbol] = {
      qty: neueQty,
      // Mischkurs inkl. Gebühren: Der Einstand ist, was die Position
      // WIRKLICH gekostet hat — sonst zeigte jeder Trade Scheingewinn.
      avgEntry: ((alt?.qty ?? 0) * (alt?.avgEntry ?? 0) + kosten) / neueQty,
      openedAt: alt?.openedAt ?? now.toISOString(),
    };
  }

  return {
    cash: Math.round(cash * 100) / 100,
    holdings,
    // Wie die Schatten-Flotte: nur die jüngsten Ergebnisse, sonst wächst das
    // Dokument unbegrenzt. 400 reichen weit über die Evidenzschwelle hinaus.
    pnls: pnls.slice(-400),
    startedAt: input.book.startedAt,
    lastRebalance: now.toISOString(),
  };
}

/**
 * Ist heute Rebalancing-Tag?
 *
 * Wöchentlich, gemessen an vollen Tagen seit dem letzten Lauf — nicht am
 * Wochentag. Ein fester Wochentag verschöbe bei jedem ausgefallenen Lauf
 * (Feiertag, Deploy-Fenster) die ganze Kette um eine Woche.
 */
export function istRebalanceFaellig(
  lastRebalance: string | null,
  now: Date,
  intervalDays = 7,
): boolean {
  if (!lastRebalance) return true;
  const t = Date.parse(lastRebalance);
  if (!Number.isFinite(t)) return true;
  return (now.getTime() - t) / 86_400_000 >= intervalDays;
}

/**
 * Wochen-Rebalancing als Diff: verkauft, was nicht mehr im Ziel ist, und
 * kauft, was fehlt. Bestehende Zielpositionen werden bewusst NICHT auf den
 * Cent nachjustiert — jedes Nachjustieren ist ein Roundtrip an Kosten, und
 * die Auswertung vom 27.07. hat gezeigt, was übermäßiges Handeln anrichtet.
 */
export function rebalanceOrders(
  gehalten: ReadonlySet<string> | string[],
  ziel: TargetPosition[],
  equity: number,
): RebalanceOrder[] {
  const ist = gehalten instanceof Set ? gehalten : new Set(gehalten);
  const soll = new Set(ziel.map((z) => z.symbol));
  const orders: RebalanceOrder[] = [];
  // Verkäufe zuerst: Sie schaffen das Cash, mit dem die Käufe bezahlt werden.
  for (const sym of [...ist].sort()) {
    if (!soll.has(sym)) orders.push({ symbol: sym, side: 'sell', notional: null });
  }
  for (const z of ziel) {
    if (!ist.has(z.symbol)) {
      orders.push({
        symbol: z.symbol,
        side: 'buy',
        notional: Math.floor(equity * z.weight * 100) / 100,
      });
    }
  }
  return orders;
}

/**
 * Toleranzband des Nachschubs: Erst wenn eine gehaltene Zielposition mehr
 * als diesen Anteil UNTER ihrem Zielgewicht liegt, wird nachgekauft.
 *
 * 25 % ist die Abwägung zwischen zwei Fehlern: Ein enges Band (5 %) kaufte
 * bei jedem Wochentakt ein paar Euro nach — genau das Nachjustieren auf den
 * Cent, dessen Kosten die Auswertung vom 27.07. verurteilt hat. Ein weites
 * Band (50 %) ließe die Hälfte des Sockel-Budgets dauerhaft als Bargeld
 * liegen — genau das, was der Auftrag vom 20.08. abstellt. Bei 25 % ist der
 * kleinste Nachkauf ein Viertel des Zielgewichts (bei 8 gleichgewichteten
 * Positionen ~3 % des Budgets) — groß genug, dass die Einstiegsgebühr im
 * Promillebereich der Order bleibt.
 */
export const NACHSCHUB_TOLERANZ = 0.25;

/**
 * Nachschub-Käufe: gehaltene Zielpositionen zurück ans Zielgewicht.
 *
 * `rebalanceOrders` ist ein reiner Bestands-Diff — es kauft, was FEHLT, und
 * verkauft, was nicht mehr ins Ziel gehört. Was es nie tat: eine gehaltene
 * Position aufstocken. Drei Wege führten deshalb dauerhaft in Bargeld
 * (Owner 20.08.: „es geht nicht darum, alles als Bargeld liegen zu
 * lassen"): Erstkäufe, die bei knappem Cash anteilig ausgeführt wurden,
 * blieben für immer klein; wachsende Equity vergrößerte das Budget, aber
 * keine Position; und Cash aus Verkäufen der aktiven Engine fand nie in
 * den Sockel zurück.
 *
 * Bewusst NUR Käufe: Eine Position ÜBER Zielgewicht (der Gewinner des
 * Portfolios) wird nicht gestutzt — Stutzen wäre ein Roundtrip an Kosten
 * und verkaufte ausgerechnet das Papier mit dem stärksten Lauf. Das
 * Toleranzband hält die Nachkäufe selten und groß; der Takt bleibt der
 * wöchentliche Rebalance-Takt, die Handelsfrequenz steigt nicht.
 *
 * `bestandswerte` trägt je GEHALTENEM Symbol den aktuellen Marktwert;
 * Symbole ohne Eintrag sind Sache von `rebalanceOrders` (Neukauf). Werte
 * ≤ 0 (Shorts, kaputte Kurse) werden übersprungen — nachgekauft wird nur,
 * was als Long-Bestand bewertbar ist.
 */
export function nachschubOrders(
  bestandswerte: ReadonlyMap<string, number>,
  ziel: TargetPosition[],
  budget: number,
  toleranz: number = NACHSCHUB_TOLERANZ,
): RebalanceOrder[] {
  const orders: RebalanceOrder[] = [];
  if (!(budget > 0)) return orders;
  for (const z of ziel) {
    const wert = bestandswerte.get(z.symbol);
    if (wert === undefined || !(wert > 0)) continue;
    const soll = budget * z.weight;
    if (wert >= soll * (1 - toleranz)) continue;
    const fehl = Math.floor((soll - wert) * 100) / 100;
    if (fehl <= 0) continue;
    orders.push({ symbol: z.symbol, side: 'buy', notional: fehl });
  }
  return orders;
}
