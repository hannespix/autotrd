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

import type {
  AttributionSlice,
  CostProfile,
  ExitBucket,
  ReibungJeKlasse,
  TradeStats,
} from './portfolio.js';

/** Ab so vielen beitragenden Konten dürfen auch Beträge öffentlich werden. */
export const MIN_ACCOUNTS_PUBLIC = 3;

/**
 * Ab so vielen Trades im 7-Tage-Fenster urteilt das Verdict über das FENSTER
 * statt über die kumulative Geschichte. Darunter wäre das „aktuelle
 * Verhalten" eine Handvoll Einzelfälle mit Prozentzeichen.
 */
export const EXIT_FENSTER_MIN_TRADES = 10;

/** Was ein einzelnes Konto zum Aggregat beisteuert. */
export interface AccountContribution {
  stats: Pick<TradeStats, 'n' | 'wins'> & {
    profitFactor?: number | null;
    expectancy?: number | null;
    avgWin?: number | null;
    avgLoss?: number | null;
  };
  exits?: Record<string, ExitBucket> | undefined;
  /**
   * Exit-Verteilung NUR über die letzten `EXIT_FENSTER_TAGE` (Task 115):
   * die einzige Sicht, in der eine Verhaltensänderung — etwa der Exit-Umbau
   * vom 09.08. — überhaupt ankommen kann, bevor sie Hunderte Alt-Trades
   * überstimmt haben.
   */
  exits7t?: Record<string, ExitBucket> | undefined;
  /** `netPnl` gibt es in `CostProfile` nicht — es folgt aus brutto − Gebühren. */
  costs?: Pick<CostProfile, 'n' | 'fees' | 'grossPnl'> | undefined;
  /** Ergebnis je Anlageklasse — Grundlage der Klassen-Kante (04.08.). */
  byClass?: Record<string, AttributionSlice> | undefined;
  /**
   * Gemessene Ausführungs-Reibung je Klasse (19.08., `reibungsProfil`) —
   * Basispunkte, also Verhältnisse: Sie verraten keine Kontogröße und sind
   * darum auch unterhalb der Konten-Schwelle veröffentlichbar.
   */
  reibung?: Record<string, ReibungJeKlasse> | undefined;
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
  /**
   * Summe der Ergebnisse dieses Ausstiegsgrunds in $ (22.08.).
   *
   * ── Warum das Feld fehlte, obwohl die Zahl da war ──────────────────────
   *
   * `ExitBucket` trägt `pnl` seit jeher, `exitBreakdown` summiert es, und
   * der Konto-Beitrag reicht es bis hierher durch. Verworfen wurde es erst
   * an der letzten Stufe — vom Parametertyp von `exitShares`, der nur
   * `{ n, wins }` annahm. Eine Zahl, die den ganzen Weg mitreist und einen
   * Schritt vor dem Ziel wegfällt, ist schwerer zu finden als eine, die es
   * nie gab.
   *
   * ── Warum ausgerechnet diese Zahl ─────────────────────────────────────
   *
   * Anteil und Trefferquote beantworten „wie oft", nicht „wie viel". Am
   * 22.08. stand der Exit-Mix der Woche bei fast gleichen Stückzahlen
   * (23/22/21/9) — daraus ist nicht ablesbar, ob die 22 Stopps 200 $ oder
   * 2 000 $ gekostet haben. Genau an dieser Unterscheidung hängt aber, ob
   * das Problem bei den Gebühren liegt oder beim Bruttoergebnis; ohne sie
   * sind alle Gegenmaßnahmen Vermutungen über dieselbe unbekannte Zahl.
   *
   * BEWUSST KEIN Verhältnis: Ein Quotient mit dem Bruttoergebnis im Nenner
   * sieht umso besser aus, je schlechter die Woche war, und geht bei einer
   * ausgeglichenen Woche durch null. Hier steht die Summe selbst.
   */
  /**
   * Nur ab MIN_ACCOUNTS_PUBLIC; sonst null — dieselbe Schwelle wie `fees`
   * und `netPnl`. Ein Geldbetrag je Ausstiegsgrund über EIN Konto ist
   * dessen Ergebnis mit einem anderen Etikett.
   */
  pnl: number | null;
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
  /** Dieselbe Diagnose, aber NUR über die letzten `EXIT_FENSTER_TAGE`. */
  exits7t: Record<string, ExitShare>;
  /** Geschlossene Trades im 7-Tage-Fenster — der Nenner von `exits7t`. */
  trades7t: number;
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
  /**
   * GEMESSENE Ausführungs-Reibung je Klasse in Basispunkten — Entscheidungs-
   * kurs gegen echten Broker-Fill, getrennt nach Einstieg und Ausstieg.
   *
   * Das ist die Zahl, an der der nächste Kostenhebel hängt: Aktien-Einstiege
   * als Limit-Order lohnen nur, wenn die echte Einstiegs-Reibung die
   * Modellannahme (5 bp) spürbar übersteigt. Nur Verhältnisse — deshalb ohne
   * Konten-Schwelle veröffentlichbar.
   */
  reibung: Record<string, ReibungJeKlasse>;
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
  const exitN: Record<string, { n: number; pnl: number; wins: number }> = {};
  const exitNeuN: Record<string, { n: number; pnl: number; wins: number }> = {};
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
      const e = exitN[grund] ?? { n: 0, pnl: 0, wins: 0 };
      e.n += b.n;
      e.pnl += Number.isFinite(b.pnl) ? b.pnl : 0;
      e.wins += b.wins;
      exitN[grund] = e;
    }
    for (const [grund, b] of Object.entries(c.exits7t ?? {})) {
      const e = exitNeuN[grund] ?? { n: 0, pnl: 0, wins: 0 };
      e.n += b.n;
      e.pnl += Number.isFinite(b.pnl) ? b.pnl : 0;
      e.wins += b.wins;
      exitNeuN[grund] = e;
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

  /* `oeffentlich` steht weiter unten, wird hier aber schon gebraucht — die
   * Geldsumme je Ausstiegsgrund unterliegt derselben Schwelle wie `fees` und
   * `netPnl`. Deshalb an dieser Stelle einmal vorab bestimmt. */
  const geldOeffentlich = beitragend.length >= minAccountsPublic;
  const exitShares = (
    roh: Record<string, { n: number; pnl: number; wins: number }>,
  ): Record<string, ExitShare> => {
    const summe = Object.values(roh).reduce((a, e) => a + e.n, 0);
    const out: Record<string, ExitShare> = {};
    for (const [grund, e] of Object.entries(roh)) {
      out[grund] = {
        share: summe > 0 ? r4(e.n / summe) : 0,
        winRate: e.n > 0 ? r4(e.wins / e.n) : 0,
        n: e.n,
        /* Auf Cent gerundet: Die Summe ist eine Geldgröße, keine Quote —
         * vier Nachkommastellen wie bei `share` wären hier Scheingenauigkeit.
         *
         * UND SIE UNTERLIEGT DER SCHWELLE (nachgetragen 22.08.). Beim Einbau
         * am selben Tag ist genau das durchgerutscht: `netPnl`, `fees` und
         * `klassen[].fees` hängen an `accounts >= MIN_ACCOUNTS_PUBLIC`, das
         * neue `pnl` je Ausstiegsgrund hing an nichts. Bei einem einzigen
         * beitragenden Konto wären das dessen Beträge mit einem anderen
         * Etikett — in einem Dokument, das öffentlich lesbar ist. Der
         * Dateikopf sagt dazu: „Es wird kritisch in dem Moment, in dem sich
         * der zweite Nutzer registriert — und dann ist es zu spät, die
         * Schwelle nachzurüsten." */
        pnl: geldOeffentlich ? Math.round(e.pnl * 100) / 100 : null,
      };
    }
    return out;
  };
  const exits = exitShares(exitN);
  const exits7t = exitShares(exitNeuN);
  const trades7t = Object.values(exitNeuN).reduce((a, e) => a + e.n, 0);

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

  /* Reibung über ALLE Beiträge, nicht nur `beitragend`: Der Filter oben
   * verlangt geschlossene Trades — Einstiegs-Reibung fällt aber schon beim
   * ERSTEN Kauf an, lange bevor irgendetwas geschlossen ist. Ein frisches
   * Konto, dessen Fills hier fehlten, wäre genau die Lücke, in der die
   * Messung am nötigsten ist. Gewichtet wird mit n je Konto — ein Mittel
   * über Konto-Schnitte wäre dieselbe Simpsons-Falle wie bei der
   * Trefferquote oben. */
  const reibungRoh: Record<
    string,
    { sum: number; n: number; max: number; ein: [number, number]; aus: [number, number] }
  > = {};
  for (const c of contributions) {
    for (const [name, r] of Object.entries(c.reibung ?? {})) {
      if (!(r.n > 0)) continue;
      const k = reibungRoh[name] ?? { sum: 0, n: 0, max: -Infinity, ein: [0, 0], aus: [0, 0] };
      k.sum += r.avgBp * r.n;
      k.n += r.n;
      k.max = Math.max(k.max, r.maxBp);
      k.ein[0] += r.einstieg.avgBp * r.einstieg.n;
      k.ein[1] += r.einstieg.n;
      k.aus[0] += r.ausstieg.avgBp * r.ausstieg.n;
      k.aus[1] += r.ausstieg.n;
      reibungRoh[name] = k;
    }
  }
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  const reibung: Record<string, ReibungJeKlasse> = {};
  for (const [name, k] of Object.entries(reibungRoh)) {
    reibung[name] = {
      n: k.n,
      avgBp: r1(k.sum / k.n),
      maxBp: r1(k.max),
      einstieg: { n: k.ein[1], avgBp: k.ein[1] > 0 ? r1(k.ein[0] / k.ein[1]) : 0 },
      ausstieg: { n: k.aus[1], avgBp: k.aus[1] > 0 ? r1(k.aus[0] / k.aus[1]) : 0 },
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
    exits7t,
    trades7t,
    netPnl: oeffentlich ? Math.round(netPnl * 100) / 100 : null,
    fees: oeffentlich ? Math.round(fees * 100) / 100 : null,
    amountsWithheld: !oeffentlich,
    klassen,
    reibung,
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

  // Die Signal-Exit-Diagnose bevorzugt das 7-TAGE-Fenster, sobald es genug
  // Trades trägt (Task 115): Der Exit-Umbau vom 09.08. kann in der
  // kumulativen Verteilung rechnerisch erst nach Wochen ankommen — bis dahin
  // stünde hier ein Urteil über ein System, das es so nicht mehr gibt, und
  // läse sich wie die Widerlegung des Umbaus. Unter der Mindestzahl gilt
  // weiter die kumulative Sicht: Drei Trades sind keine Verteilung.
  const neuN = h.trades7t ?? 0;
  if (neuN >= EXIT_FENSTER_MIN_TRADES) {
    const neuSignal = h.exits7t['signal']?.share ?? 0;
    if (neuSignal > 0.8) {
      return `${Math.round(neuSignal * 100)} % der Trades der letzten 7 Tage enden am Signal — Stop und Ziel sind praktisch wirkungslos`;
    }
  } else {
    const signal = h.exits['signal']?.share ?? 0;
    if (signal > 0.8) {
      return `${Math.round(signal * 100)} % der Trades enden am Signal — Stop und Ziel sind praktisch wirkungslos`;
    }
  }
  /* Die Ursachen-Behauptung ist am 22.08. gestrichen worden, die Zahl bleibt.
   *
   * Hier stand „… — Handelsfrequenz zu hoch". Der Satz wurde allein aus
   * `feeShare > 0.5` gebildet — ohne dass irgendeine Frequenzgröße in die
   * Entscheidung einging. Er behauptete also eine Ursache, die er nicht
   * gemessen hatte, und er stand als Urteil im täglichen KI-Bericht.
   *
   * Nachgerechnet trug er auch nicht: In der Woche zum 22.08. standen rund
   * 415 $ Gebühren gegen eine Brutto-Verschlechterung von grob 1 650 $. Die
   * Frequenz zu halbieren hätte ~200 $ gespart — an einem Problem, das
   * achtmal so groß war. Erschwerend läuft `feeShare` über ein rollendes
   * Fenster der letzten Abschlüsse je Konto und nicht über die sieben Tage,
   * auf die sich der Exit-Mix daneben bezieht; die beiden Zahlen im selben
   * Bericht sprechen also über verschiedene Zeiträume.
   *
   * Die GEBÜHREN-AUSSAGE bleibt unverändert stehen — sie ist Kostenwahrheit
   * und wird nie abgeschwächt. Was sie nicht sagen darf, ist woher es kommt.
   * Diese Frage beantwortet ab jetzt `exits7t.<grund>.pnl`: das Geld je
   * Ausstiegsgrund, das bis heute eine Stufe vor dem Ziel verworfen wurde. */
  if (h.feeShare !== null && h.feeShare > 0.5) {
    return `Gebühren fressen ${Math.round(h.feeShare * 100)} % des Bruttoergebnisses`;
  }
  if (h.profitFactor !== null && h.profitFactor < 1) {
    return `Profit-Faktor ${h.profitFactor} — die Verluste überwiegen die Gewinne`;
  }
  if (h.winRatePct !== null && h.winRatePct < 35) {
    return `Trefferquote ${h.winRatePct} % — tragfähig nur, wenn die Gewinner deutlich größer sind`;
  }
  return 'keine auffällige Schieflage';
}
