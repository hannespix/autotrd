/**
 * autotrd — aggregierte HANDELSQUALITÄT über alle Konten (Owner-Frage 28.07.:
 * „kannst du selbst die Performance einsehen und Verbesserungen vorschlagen?").
 *
 * ── Warum das gebraucht wird ───────────────────────────────────────────────
 *
 * `meta/health` trug bisher nur BETRIEBS-Zahlen: wie viele Symbole gescannt,
 * wie viele Fehler, wie viele Trades. Damit lässt sich feststellen, ob die
 * Maschine läuft — nicht, ob sie etwas taugt. Die eigentliche Diagnose
 * („sterben alle Trades am Signal statt am Stop?", „wie viel frisst die
 * Reibung?") stand ausschließlich in `users/{uid}/stats/main` und war von
 * außen unsichtbar.
 *
 * Genau diese Frage musste am 27.07. ein Mensch mit Taschenrechner
 * beantworten. Das Rohmaterial liegt längst vor — `snapshotEquity` rechnet
 * `tradeStats`, `exitBreakdown` und `costProfile` täglich je Konto. Es wurde
 * nur nie zusammengeführt.
 *
 * ── Datenschutz: das Mindest-N ist der Kern, nicht die Fußnote ─────────────
 *
 * Ein „Aggregat" über EIN Konto ist kein Aggregat, sondern dessen Daten mit
 * einem anderen Etikett — und `meta/**` ist öffentlich lesbar. Solange
 * weniger als `MIN_ACCOUNTS_PUBLIC` Konten beitragen, werden deshalb nur
 * strukturelle Anteile veröffentlicht (Quoten, Verhältnisse), aber KEINE
 * Geldbeträge. Erst ab der Schwelle kommen Summen dazu.
 *
 * Das ist heute unkritisch, weil es praktisch ein Konto gibt und das dem
 * Betreiber gehört. Es wird kritisch in dem Moment, in dem sich der zweite
 * Nutzer registriert — und dann ist es zu spät, die Schwelle nachzurüsten.
 */

import type { AttributionSlice, CostProfile, ExitBucket, TradeStats } from './portfolio.js';

/** Ab so vielen beitragenden Konten dürfen auch Beträge öffentlich werden. */
export const MIN_ACCOUNTS_PUBLIC = 3;

/** Was ein einzelnes Konto zum Aggregat beisteuert. */
export interface AccountContribution {
  stats: Pick<TradeStats, 'n' | 'wins'> & {
    profitFactor?: number | null;
    expectancy?: number | null;
    avgWin?: number | null;
    avgLoss?: number | null;
  };
  exits?: Record<string, ExitBucket> | undefined;
  /** `netPnl` gibt es in `CostProfile` nicht — es folgt aus brutto − Gebühren. */
  costs?: Pick<CostProfile, 'n' | 'fees' | 'grossPnl'> | undefined;
  /** Ergebnis je Anlageklasse — Grundlage der Klassen-Kante (04.08.). */
  byClass?: Record<string, AttributionSlice> | undefined;
}

/** Was eine Anlageklasse über alle Konten hinweg beigetragen hat. */
export interface KlassenBefund {
  n: number;
  /** Nettoergebnis nach Gebühren. */
  pnl: number;
  /** Nur ab MIN_ACCOUNTS_PUBLIC; sonst null (s. Kopfkommentar). */
  fees: number | null;
  /**
   * Nettorendite je gehandeltem Dollar in Prozent. Ein VERHÄLTNIS und damit
   * auch unterhalb der Konten-Schwelle veröffentlichbar — es verrät keine
   * Kontogröße, beantwortet aber die entscheidende Frage: Verdient diese
   * Klasse ihre eigene Reibung?
   */
  kantePct: number | null;
  /**
   * Wie viele Konten in dieser Klasse überhaupt gehandelt haben (MG5).
   *
   * Die entscheidende Zahl, bevor ein Konto seine Gewichte nach fremder
   * Erfahrung stellt: Stammen 58 Trades aus sieben Konten oder aus einem
   * einzigen? Im zweiten Fall ist der „globale" Wert schlicht dessen
   * eigener, und ihn als Kollektivwissen weiterzureichen wäre eine
   * Selbsttäuschung mit zusätzlichen Schritten.
   *
   * Ein Aggregat ohne Personenbezug — es verrät nur, dass mehrere Konten
   * dieselbe Klasse handeln, nicht welche oder mit welchen Beträgen.
   */
  konten: number;
}

export interface ExitShare {
  /** Anteil aller geschlossenen Trades, die so endeten (0…1). */
  share: number;
  /** Trefferquote INNERHALB dieses Ausstiegsgrunds (0…1). */
  winRate: number;
  n: number;
}

export interface TradingHealth {
  /** Konten mit mindestens einem geschlossenen Trade. */
  accounts: number;
  /** Geschlossene Trades insgesamt. */
  trades: number;
  /** Trefferquote in Prozent; null ohne Trades. */
  winRatePct: number | null;
  /** Bruttogewinn ÷ Bruttoverlust, aus avgWin/avgLoss rekonstruiert. */
  profitFactor: number | null;
  /**
   * Anteil der Gebühren am Bruttoergebnis (0…1).
   *
   * Das VERHÄLTNIS statt des Betrags: Es beantwortet dieselbe Frage
   * („frisst die Reibung die Rendite?"), verrät aber keine Kontogröße.
   */
  feeShare: number | null;
  /** Ausstiegsgründe als Anteile — die wichtigste Einzeldiagnose. */
  exits: Record<string, ExitShare>;
  /** Nur ab MIN_ACCOUNTS_PUBLIC gesetzt, sonst null (s. Kopfkommentar). */
  netPnl: number | null;
  fees: number | null;
  /** Wurden Beträge zurückgehalten? Macht die Lücke erklärbar. */
  amountsWithheld: boolean;
  /**
   * Ergebnis je Anlageklasse.
   *
   * Ohne diese Aufschlüsselung sagt das Gesamtbild nur, DASS zu teuer
   * gehandelt wird — nicht WO. Eine Klasse mit negativer Kante gehört nicht
   * feinjustiert, sondern abgeschaltet; ohne die Zahl wäre jede Änderung an
   * der Kostenschwelle geraten.
   */
  klassen: Record<string, KlassenBefund>;
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Konto-Kennzahlen zu einem veröffentlichbaren Gesamtbild verdichten.
 *
 * Die Trefferquote wird aus `wins`/`n` NEU gerechnet, nicht aus den
 * Prozentwerten der Konten gemittelt: Ein Mittel über Quoten gewichtet ein
 * Konto mit drei Trades genauso stark wie eines mit dreihundert. Das ist
 * Simpsons Paradox in seiner banalsten Form und würde die Zahl beliebig weit
 * von der Wahrheit wegtragen.
 */
export function aggregateTradingHealth(
  contributions: AccountContribution[],
  minAccountsPublic = MIN_ACCOUNTS_PUBLIC,
): TradingHealth {
  const beitragend = contributions.filter((c) => (c.stats?.n ?? 0) > 0);
  const accounts = beitragend.length;

  let trades = 0;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let fees = 0;
  let grossPnl = 0;
  let netPnl = 0;
  const exitN: Record<string, { n: number; wins: number }> = {};
  const klassenRoh: Record<
    string,
    { n: number; pnl: number; fees: number; notional: number; konten: number }
  > = {};

  for (const c of beitragend) {
    const n = c.stats.n;
    trades += n;
    wins += c.stats.wins;

    // Bruttogewinn/-verlust aus Durchschnitt × Anzahl rekonstruieren: Die
    // Konto-Statistik speichert avgWin/avgLoss, nicht die Summen. Ohne diese
    // Rückrechnung ließe sich der Profit-Faktor nur als Mittel über
    // Konto-Faktoren bilden — und ein Konto ohne Verluste liefert dort
    // `null`, fiele also heraus und schönte das Gesamtbild.
    const w = c.stats.avgWin;
    const l = c.stats.avgLoss;
    if (typeof w === 'number' && Number.isFinite(w)) grossWin += w * c.stats.wins;
    if (typeof l === 'number' && Number.isFinite(l)) grossLoss += Math.abs(l) * (n - c.stats.wins);

    if (c.costs) {
      // Netto wird ABGELEITET, nicht gelesen: `costProfile` liefert Brutto
      // und Gebühren, und brutto − Gebühren ist per Definition das Netto.
      // Ein zusätzliches gespeichertes Feld könnte davon abweichen — dann
      // stünden zwei Wahrheiten nebeneinander.
      const f = Number.isFinite(c.costs.fees) ? c.costs.fees : 0;
      const g = Number.isFinite(c.costs.grossPnl) ? c.costs.grossPnl : 0;
      fees += f;
      grossPnl += g;
      netPnl += g - f;
    }

    for (const [grund, b] of Object.entries(c.exits ?? {})) {
      const e = exitN[grund] ?? { n: 0, wins: 0 };
      e.n += b.n;
      e.wins += b.wins;
      exitN[grund] = e;
    }

    // Klassen-Beitrag dieses Kontos — Summen, keine Quoten (s. u.).
    for (const [name, slice] of Object.entries(c.byClass ?? {})) {
      const kl = klassenRoh[name] ?? { n: 0, pnl: 0, fees: 0, notional: 0, konten: 0 };
      kl.n += slice.n;
      kl.pnl += slice.pnl;
      kl.fees += slice.fees ?? 0;
      kl.notional += slice.notional ?? 0;
      // Nur Konten zählen, die in DIESER Klasse tatsächlich gehandelt haben.
      // Ein leerer Eintrag (n = 0) entsteht schon durch das bloße Anlegen
      // einer Watchlist und wäre kein Beitrag zur Erfahrung.
      if (slice.n > 0) kl.konten += 1;
      klassenRoh[name] = kl;
    }
  }

  const exitSumme = Object.values(exitN).reduce((a, e) => a + e.n, 0);
  const exits: Record<string, ExitShare> = {};
  for (const [grund, e] of Object.entries(exitN)) {
    exits[grund] = {
      share: exitSumme > 0 ? r4(e.n / exitSumme) : 0,
      winRate: e.n > 0 ? r4(e.wins / e.n) : 0,
      n: e.n,
    };
  }

  // Klassen aus den SUMMEN rechnen, nicht aus gemittelten Konto-Kanten:
  // Ein Mittel über Quoten gewichtet ein Konto mit drei Trades wie eines mit
  // dreihundert — dieselbe Falle wie bei der Trefferquote oben.
  const klassen: Record<string, KlassenBefund> = {};
  for (const [name, k] of Object.entries(klassenRoh)) {
    klassen[name] = {
      n: k.n,
      pnl: Math.round(k.pnl * 100) / 100,
      fees: accounts >= minAccountsPublic ? Math.round(k.fees * 100) / 100 : null,
      kantePct: k.notional > 0 ? r4((k.pnl / k.notional) * 100) : null,
      konten: k.konten,
    };
  }

  const oeffentlich = accounts >= minAccountsPublic;
  // Der Gebührenanteil bezieht sich auf den BETRAG des Bruttoergebnisses:
  // Bei einem Bruttoverlust wäre das Verhältnis sonst negativ und läse sich
  // wie „die Gebühren haben Geld eingebracht".
  const brutto = Math.abs(grossPnl);

  return {
    accounts,
    trades,
    winRatePct: trades > 0 ? Math.round((wins / trades) * 10_000) / 100 : null,
    profitFactor: grossLoss > 0 ? r4(grossWin / grossLoss) : null,
    feeShare: brutto > 0 ? r4(fees / brutto) : null,
    exits,
    netPnl: oeffentlich ? Math.round(netPnl * 100) / 100 : null,
    fees: oeffentlich ? Math.round(fees * 100) / 100 : null,
    amountsWithheld: !oeffentlich,
    klassen,
  };
}

/**
 * Der eine Satz, der aus den Zahlen folgt — als Klartext im Heartbeat.
 *
 * Bewusst EINE Aussage statt einer Liste: Ein Diagnosefeld, das immer drei
 * Sätze enthält, liest niemand mehr. Die Reihenfolge unten ist die nach
 * Schwere — der teuerste Befund gewinnt.
 */
export function tradingVerdict(h: TradingHealth): string {
  if (h.trades === 0) return 'noch keine geschlossenen Trades';

  const signal = h.exits['signal']?.share ?? 0;
  if (signal > 0.8) {
    return `${Math.round(signal * 100)} % der Trades enden am Signal — Stop und Ziel sind praktisch wirkungslos`;
  }
  if (h.feeShare !== null && h.feeShare > 0.5) {
    return `Gebühren fressen ${Math.round(h.feeShare * 100)} % des Bruttoergebnisses — Handelsfrequenz zu hoch`;
  }
  if (h.profitFactor !== null && h.profitFactor < 1) {
    return `Profit-Faktor ${h.profitFactor} — die Verluste überwiegen die Gewinne`;
  }
  if (h.winRatePct !== null && h.winRatePct < 35) {
    return `Trefferquote ${h.winRatePct} % — tragfähig nur, wenn die Gewinner deutlich größer sind`;
  }
  return 'keine auffällige Schieflage';
}
