/**
 * Kontoabgleich gegen den Broker — Cash und Depotwert, nicht nur Positionen.
 *
 * ── Der Befund, der das ausgelöst hat (Owner-Screenshot 12.08.) ───────────
 *
 * Zwei Fenster nebeneinander, dasselbe Alpaca-Paper-Konto:
 *
 *                       autotrd          Alpaca
 *   Cash               +39 311,17 $     −45 286,34 $
 *   Depotwert           60 549,91 $     145 830,09 $
 *   Equity              99 861,08 $     100 543,75 $
 *
 * Die beiden großen Differenzen heben sich fast auf: 85 280 $ mehr
 * Positionen bei Alpaca, 84 598 $ weniger Cash. Das ist kein Bewertungs-
 * oder Rundungsfehler — das sind Käufe, die real ausgeführt und im eigenen
 * Buch nie verbucht wurden. Die Restdifferenz von 683 $ in der Equity ist
 * der unterschiedliche Kurszeitpunkt.
 *
 * ── Warum der bestehende Abgleich das nicht sah ──────────────────────────
 *
 * `brokerAbgleich.ts` vergleicht STÜCKZAHLEN je Symbol. Ein Konto kann dort
 * „sauber" melden und trotzdem 85 000 $ auseinanderliegen: Solange beide
 * Seiten dieselben Symbole in denselben Stückzahlen führen, fällt eine
 * völlig andere Kapitaldecke nicht auf. Geld war schlicht nie Teil des
 * Vergleichs.
 *
 * ── Warum das gefährlich ist und nicht nur unschön ───────────────────────
 *
 * `sizeOrder` rechnet die Positionsgröße aus `wallet.paperBalance`. Das Buch
 * sieht +39 311 $ und gibt Kaufaufträge frei; real steht das Konto bei
 * −45 286 $ und kauft auf Kredit. Jeder weitere Kauf vergrößert genau die
 * Lücke, die ihn erlaubt hat — der Fehler verstärkt sich selbst.
 *
 * ── Warum kein automatisches Überschreiben ───────────────────────────────
 *
 * Owner-Direktive: „Alpaca ist die Wahrheit!" Für die ANZEIGE gilt das ohne
 * Einschränkung, und dafür braucht es nichts als das Lesen der richtigen
 * Zahl. Für das BUCH gilt es nicht so einfach: `wallet.paperBalance` einfach
 * auf Alpacas Wert zu setzen ließe 85 000 $ Differenz lautlos verschwinden.
 * Danach stimmt die Zahl und niemand erfährt je, woher sie kam — und die
 * realisierte P&L, die auf denselben Buchungen steht, wäre stillschweigend
 * falsch.
 *
 * Deshalb hier zwei getrennte Antworten:
 *
 *   1. `sicheresKapital` — womit GERECHNET wird: das Minimum aus Buch und
 *      Broker. Immer konservativ, ohne jede Migration, sofort wirksam. Wer
 *      real bei −45 286 $ steht, bekommt keine neuen Käufe mehr freigegeben,
 *      egal was das Buch meint.
 *   2. `kontoAbgleich` — was GEMELDET wird: die Differenz mit Vorzeichen,
 *      Schwelle und Sperr-Empfehlung, damit die Ursache sichtbar bleibt
 *      statt weggerechnet zu werden.
 */

/** Kontozahlen einer Seite — Buch oder Broker. */
export interface Kontostand {
  /** Barbestand. Darf negativ sein: geliehen (Margin). */
  cash: number;
  /** Gesamtwert = Cash + Depotwert. */
  equity: number;
}

export type KontoZustand = 'kein_broker' | 'sauber' | 'drift' | 'grob';

export interface KontoBefund {
  /** Lief der Vergleich? `false` = kein Broker verbunden oder Zahlen unlesbar. */
  geprueft: boolean;
  zustand: KontoZustand;
  /** Broker − Buch, in Kontowährung. Negativ = Broker hat weniger. */
  cashDiff: number;
  equityDiff: number;
  /** Betrag der Cash-Abweichung in Prozent der Broker-Equity. */
  cashDiffPct: number;
  /**
   * Womit gerechnet werden soll — das Minimum beider Seiten.
   *
   * Nicht der Broker-Wert: Läge das BUCH tiefer (weil ein Verkauf beim
   * Broker noch nicht angekommen ist), wäre der Broker-Wert die
   * optimistischere Zahl, und optimistisch ist beim Kapital die falsche
   * Richtung.
   */
  sicheresCash: number;
  /** Sollen neue Einstiege gesperrt werden? */
  sperre: boolean;
  /** Klartext für Log, Heartbeat und Anzeige. */
  grund?: string;
}

/**
 * Ab welcher absoluten Cash-Abweichung es gemeldet wird.
 *
 * Nicht null: Zwischen Buchung im eigenen Buch und Verrechnung beim Broker
 * liegen Sekunden bis Minuten, dazu Gebühren-Rundungen und aufgelaufene
 * Margin-Zinsen. Eine Schwelle von null erzeugte eine Dauermeldung, und eine
 * Meldung, die immer ansteht, liest niemand mehr — derselbe Grund, aus dem
 * der Positions-Abgleich Fremdbestand nicht als Fehler führt.
 */
export const KONTO_MELDE_SCHWELLE = 250;

/**
 * Ab welchem ANTEIL der Equity Einstiege gesperrt werden.
 *
 * 5 % ist deutlich mehr als jede Verrechnungsverzögerung erklären kann und
 * deutlich weniger, als es kostet, weiter blind zu kaufen. Im Anlassfall
 * betrug die Abweichung 84 % der Equity.
 */
export const KONTO_SPERR_ANTEIL = 0.05;

const endlich = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

const OHNE: KontoBefund = {
  geprueft: false,
  zustand: 'kein_broker',
  cashDiff: 0,
  equityDiff: 0,
  cashDiffPct: 0,
  sicheresCash: 0,
  sperre: false,
};

/**
 * Womit gerechnet werden darf: das Minimum aus Buch und Broker.
 *
 * Ohne Broker bleibt das Buch maßgeblich — ein reines Buch-Konto ist kein
 * Fehlerfall, sondern der Normalfall für Paper-Nutzer ohne Verbindung.
 */
export function sicheresKapital(buchCash: number, brokerCash: number | null | undefined): number {
  if (!endlich(buchCash)) return 0;
  if (!endlich(brokerCash)) return buchCash;
  return Math.min(buchCash, brokerCash);
}

/**
 * Buch gegen Broker — Cash und Equity.
 *
 * Pur und ohne Firestore, wie `costGate` und `exitUmbauPlan`: Die
 * Entscheidung sperrt fremde Konten, und das ist nichts, was man nur im
 * Live-Betrieb beobachten können sollte.
 */
export function kontoAbgleich(
  buch: Kontostand | null | undefined,
  broker: Kontostand | null | undefined,
  meldeSchwelle = KONTO_MELDE_SCHWELLE,
  sperrAnteil = KONTO_SPERR_ANTEIL,
): KontoBefund {
  if (!buch || !broker) return OHNE;
  if (!endlich(buch.cash) || !endlich(broker.cash)) return OHNE;
  if (!endlich(buch.equity) || !endlich(broker.equity)) return OHNE;

  const cashDiff = runde(broker.cash - buch.cash);
  const equityDiff = runde(broker.equity - buch.equity);
  const sicheresCash = Math.min(buch.cash, broker.cash);

  // Bezug ist die BROKER-Equity, nicht die Buch-Equity: Sie ist die Wahrheit,
  // und ein kaputtes Buch darf nicht auch noch den Maßstab stellen.
  // Bezugsgröße ≤ 0 (leergeräumtes oder überschuldetes Konto) ⇒ jeder Anteil
  // wäre unendlich; dann zählt nur die absolute Schwelle.
  const bezug = broker.equity > 0 ? broker.equity : 0;
  const cashDiffPct = bezug > 0 ? runde4(Math.abs(cashDiff) / bezug) : 0;

  if (Math.abs(cashDiff) < meldeSchwelle && Math.abs(equityDiff) < meldeSchwelle) {
    return {
      geprueft: true,
      zustand: 'sauber',
      cashDiff,
      equityDiff,
      cashDiffPct,
      sicheresCash,
      sperre: false,
    };
  }

  const grob = bezug > 0 ? cashDiffPct >= sperrAnteil : Math.abs(cashDiff) >= meldeSchwelle * 20;
  const eur = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
  return {
    geprueft: true,
    zustand: grob ? 'grob' : 'drift',
    cashDiff,
    equityDiff,
    cashDiffPct,
    sicheresCash,
    // Sperre NUR bei grober Abweichung. Eine Sperre bei jeder kleinen
    // Differenz träfe den Normalbetrieb und würde abgeschaltet werden.
    sperre: grob,
    grund:
      `Kontostand weicht ab: Cash ${eur(cashDiff)} (${(cashDiffPct * 100).toFixed(1)} % der ` +
      `Broker-Equity), Depotwert ${eur(equityDiff)}. Broker ist maßgeblich` +
      (grob ? ' — Einstiege gesperrt, bis der Abgleich stimmt.' : '.'),
  };
}

const runde = (x: number): number => Math.round(x * 100) / 100;
const runde4 = (x: number): number => Math.round(x * 10_000) / 10_000;
