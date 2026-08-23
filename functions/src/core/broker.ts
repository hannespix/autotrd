/**
 * Broker-Schicht — Port von reference/scripts/broker.py auf Firestore.
 *
 * Paper-Ausführung läuft als Firestore-TRANSAKTION über users/{uid}:
 * wallet-Feld (Cash), positions/{symbol}, trades/{tradeId} — alles Felder,
 * die Clients per Rules NICHT schreiben können (ARCHITECTURE §5).
 *
 * SICHERHEIT (Port der Python-Guards, niemals lockern):
 * - Default ist immer Paper.
 * - Echtgeld erfordert DREIERLEI: strategy.broker.mode === 'live', env
 *   ALPACA_ALLOW_LIVE === '1' UND eine bestandene Live-Reife-Prüfung
 *   (Owner-Maxime 04.08., siehe shared/src/liveReadiness.ts) — sonst
 *   automatischer Downgrade auf Paper. `resolveBrokerMode()` ist die einzige
 *   Stelle, die über den Modus entscheidet; der Alpaca-Adapter hängt daran.
 * - Keys nur aus env/Secret Manager, nie geloggt.
 */

import { FieldPath, FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  DEFAULT_MARGIN_RATE,
  classify,
  currencyForSymbol,
  effectivePriceForClass,
  effectivePriceFromFill,
  feePartsForClass,
  marginInterest,
  resolveRisk,
  riskBasedQty,
  sicheresKapital,
  sizeWithMargin,
} from '../../../shared/src/index.js';
import type {
  Position,
  RiskConfig,
  Strategy,
  Trade,
} from '../../../shared/src/index.js';
import { fxFelder } from './fx.js';
import { rundeLimitPreis } from './alpacaBroker.js';
import { assetStand, brokerVerbindung, brokerVorpruefung, routeOrder } from './orderRouting.js';
import { schutzAnlegen, schutzAufheben } from './schutzStop.js';

/**
 * Margin-Budget, das der AUFRUFER mitbringt (Scan bzw. Puls).
 *
 * Warum nicht im Broker selbst gerechnet: Die Nachschuss-Mathematik braucht
 * den MARKTWERT aller offenen Positionen, und den kennt nur der Scan — er hat
 * die Kurse gerade geholt. Der Broker läuft in einer Transaktion über GENAU
 * EIN Positions-Dokument; er müsste alle anderen nachladen und hätte trotzdem
 * keine Kurse dazu, sondern nur Einstände. Mit Einständen gerechnet wäre das
 * Budget aber systematisch zu groß, sobald das Depot im Minus steht — also
 * genau dann, wenn es darauf ankommt.
 *
 * FEHLT das Feld, handelt der Broker bar gedeckt wie bisher. Das ist kein
 * Fallback, sondern der Normalfall: Ohne Hebel gibt es nichts zu rechnen.
 */
export interface MarginBudget {
  /** Eigenkapital (Cash + Marktwert der Positionen) — Basis der Tranche. */
  equity: number;
  /** Verbleibende Kaufkraft unter dem für DIESE Order geltenden Hebel. */
  buyingPower: number;
  /**
   * Der für DIESE Order geltende Hebel. Er gehört mit ins Budget, weil die
   * Tranche mit ihm skaliert — ohne ihn käme trotz voller Kaufkraft immer
   * nur eine bar gedeckte Positionsgröße heraus, und der Hebel bliebe
   * folgenlos (siehe `sizeWithMargin`).
   */
  leverage: number;
}

/* `resolveBrokerMode`/`BrokerMode` sind am 13.08. nach `core/liveGate.ts`
 * gezogen (Audit K-1): Die Order-Routing-Schicht braucht dieselbe
 * Drei-Guard-Kette, und sie darf `broker.ts` nicht importieren (Zyklus —
 * broker.ts importiert orderRouting). Der Re-Export hier hält alle
 * bestehenden Aufrufer unverändert. */
export { resolveBrokerMode } from './liveGate.js';
export type { BrokerMode } from './liveGate.js';

/**
 * Ist die Menge zu klein, um sie zu buchen?
 *
 * ── Der Audit-Befund vom 11.08. ───────────────────────────────────────────
 *
 * Die Untergrenze stand zweimal im Code, mit verschiedenen Antworten:
 *
 *   `executeTrade` (Routing)   `asset?.fractionable ?? (klasse === 'crypto')`
 *   `executePaperTrade` (Buch) `cls === 'crypto'`
 *
 * Seit dem Alpaca-Assets-Sync kennt die routende Schicht echte Bruchstücke
 * auch bei Aktien. Die buchende nicht. Die Folge war kein abgelehnter Trade,
 * sondern ein AUSGEFÜHRTER, der nicht ankam: Die Order über 0,25 NVDA ging
 * raus und wurde gefüllt — rund 200 $ real investiert —, danach lehnte die
 * Buchung sie mit `qty_unter_1` ab, weil sie NVDA für unteilbar hielt.
 *
 * Übrig blieben ein `unbookedFills`-Dokument und ein `logger.error`. Keine
 * Position, kein Cash-Abzug, kein Schutz-Stop. Und weil der Cooldown nur bei
 * Erfolg gesetzt wird und keine Position entsteht, wiederholte der
 * 5-Minuten-Scan denselben Vorgang, solange das Kaufsignal stand.
 *
 * ── Warum ein bestätigter Fill die Grenze nicht mehr passieren muss ───────
 *
 * Weil die Frage dann falsch gestellt ist. „Ist die Menge zu klein zum
 * Kaufen?" entscheidet, ob eine Order rausgeht — sie ist aber schon raus und
 * ausgeführt. Die Buchung abzulehnen ließe den Kauf real bestehen und nur das
 * Buch dahinter zurückfallen. Exakt dieselbe Begründung trägt die
 * Cash-Prüfung ein paar Zeilen weiter unten seit dem 05.08.
 *
 * Geprüft wird dann nur noch, dass überhaupt etwas gefüllt wurde: Eine
 * Position über null Stück ist keine Position.
 */
/**
 * Unter welcher Lauf-Kennung dieser Auftrag beim Broker ankommt.
 *
 * ── Der Audit-Befund vom 11.08. ───────────────────────────────────────────
 *
 * Die Idempotenz beim Broker hängt an der `clientOrderId`, und die enthält
 * die Kennung des LAUFS. Für einen Risiko-Exit ist der Lauf aber die falsche
 * Bezugsgröße, denn zwei verschiedene Läufe stoßen denselben Exit an:
 *
 *   riskPulse    jede Minute      `puls-2026-08-11T10:03Z`
 *   scanMarket   alle 5 Minuten   `2026-08-11T10:03Z`
 *
 * Sie überlappen sich also zwangsläufig alle fünf Minuten, und weil die
 * Kennungen verschieden sind, sieht Alpaca zwei verschiedene Orders.
 *
 * Die Abfolge, die das auslöst:
 *
 *   10:03:00  Der Puls liest `positions/AAPL`, `riskExitReason` feuert,
 *             `routeOrder` geht raus. `warteAufFill` pollt bis zu 6 × 700 ms
 *             — die Position steht in Firestore also noch rund vier Sekunden.
 *   10:03:02  Der laufende Scan erreicht dieselbe Position, liest sie als
 *             offen, `riskExitReason` feuert ebenfalls, zweite echte Order.
 *   danach    Beide Fills laufen: 10 Stück verkauft, 10 weitere LEERverkauft.
 *             Der Puls bucht, der Scan bekommt `keine_position` und schreibt
 *             nur `unbookedFills`.
 *
 * Übrig bleibt ein echter Short über −10 Stück beim Broker, ohne Stop und
 * ohne Buchung. Und der Abgleich stuft ihn als harmlos ein: Bei eigener
 * Menge 0 ist er weder Fehl- noch Doppelbestand, landet also in
 * `fremdbestand` und löst keine Sperre aus. Nichts hält ihn auf.
 *
 * Genau das Risiko, das `executeTrade` ein paar Zeilen weiter oben für den
 * anderen Fall beschreibt: „aus einem gewollten Ausstieg würde ein
 * ungewollter Einstieg in die Gegenrichtung, mit echtem Risiko und ohne
 * Stop".
 *
 * ── Warum die Position die richtige Bezugsgröße ist ───────────────────────
 *
 * Ein Risiko-Exit ist durch die POSITION bestimmt, nicht durch den Lauf, der
 * ihn zufällig zuerst bemerkt. `openedAt` ist über das ganze Leben einer
 * Position stabil und bei einer neu eröffneten eine andere Zeit — dieselbe
 * Position wird also unter derselben Kennung geschlossen, egal wer den Exit
 * auslöst, und ein späterer Wiedereinstieg bekommt trotzdem eine neue.
 *
 * Alles andere behält die Lauf-Kennung: Ein Einstieg IST an seinen Lauf
 * gebunden — zwei Scans, die dasselbe Symbol kaufen wollen, sind zwei
 * Entscheidungen, keine Wiederholung derselben.
 *
 * Fehlt `openedAt` (Altbestand), bleibt es beim bisherigen Verhalten.
 */
export function auftragsLauf(
  req: { riskExit?: string | undefined },
  position: { openedAt?: string | undefined } | null,
  laufId: string,
): string {
  if (typeof req.riskExit !== 'string' || req.riskExit === '') return laufId;
  const auf = position?.openedAt;
  if (typeof auf !== 'string' || auf === '') return laufId;
  return `exit-${auf}`;
}

export function mengeZuKlein(qty: number, fractional: boolean, echterFill: boolean): boolean {
  if (echterFill) return !(qty > 0);
  return !(qty >= (fractional ? 1e-6 : 1));
}

/** Geldbeträge auf Cent runden — Float-Drift hat im Kontostand nichts zu suchen. */
function roundCents(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Wie lange der letzte Konto-Abgleich als Kapital-Deckel nachwirkt.
 *
 * Der Abgleich läuft mit jedem Scan (Minuten-Takt); 24 Stunden überbrücken
 * Wochenenden und Ausfälle der Broker-API, ohne dass eine uralte Zahl ewig
 * weiterklemmt. Nach Ablauf gilt wieder das Buch allein — zusammen mit dem
 * Totmann-Wächter, der stehende Scans ohnehin meldet.
 */
export const KAPITAL_DECKEL_STD = 24;

/**
 * Womit ein EINSTIEG rechnen darf (Audit 13.08., Hochbefund 1).
 *
 * `kontoAbgleich` berechnet seit dem 12.08. das `sicheresCash` — das Minimum
 * aus Buch- und Broker-Cash — und legt es im Vermerk `risk.abgleich` ab. Bis
 * heute LAS es dort niemand: `sizeOrder` und die Deckungsprüfung rechneten
 * weiter allein mit `wallet.paperBalance`. Genau das war der Anlassfall vom
 * 12.08.: Buch +39 311 $, Broker −45 286 $ — das Buch gab munter weitere
 * Käufe frei, real lief jeder davon auf Kredit.
 *
 * Der Deckel wirkt nur auf Einstiege (Sizing + Deckungsprüfung). Exits und
 * die Wallet-Arithmetik rechnen weiter mit dem echten Buchstand: Ein Stop,
 * der wegen einer Buchungsdifferenz nicht auslöst, wäre gefährlicher als die
 * Differenz selbst — und eine Buchung mit geklemmter Zahl machte das Buch
 * zum Lügner.
 */
export function kapitalDeckel(
  vermerk: unknown,
  buchCash: number,
  jetztIso: string,
): number {
  if (typeof vermerk !== 'object' || vermerk === null) return buchCash;
  const v = vermerk as { at?: unknown; konto?: { sicheresCash?: unknown } };
  const cash = v.konto?.sicheresCash;
  if (typeof cash !== 'number' || !Number.isFinite(cash)) return buchCash;
  if (typeof v.at !== 'string') return buchCash;
  const alter = Date.parse(jetztIso) - Date.parse(v.at);
  // Zukunfts-Stempel oder unlesbares Datum ⇒ dem Vermerk nicht trauen,
  // aber in die KONSERVATIVE Richtung: Der Deckel gilt dann trotzdem.
  if (Number.isFinite(alter) && alter > KAPITAL_DECKEL_STD * 3_600_000) return buchCash;
  return sicheresKapital(buchCash, cash);
}

/**
 * Positionsgröße eines Kaufs (pure, testbar) — MA-Audit 26.07.:
 * Basis ist per Default der VERFÜGBARE Cash ('balance'), nicht mehr das
 * Startkapital. Grund (Owner-Feedback): Mit fixen Startkapital-Tranchen
 * scheiterte jeder Kauf still an 'zu_wenig_cash', sobald der Rest-Cash die
 * Tranche nicht mehr deckte — das Wallet stand dann groß im Depot, aber der
 * Auto-Trader handelte nicht mehr. Cash-Basis kann IMMER kaufen, solange
 * floor(cash·pct/price) ≥ 1 Stück ergibt. 'initial' bleibt als bewusste
 * Option für fixe Tranchen (Referenz-Verhalten).
 */
export function sizeOrder(
  strategy: Strategy,
  balance: number,
  effPrice: number,
  fractional = false,
  margin?: MarginBudget,
  stopDistancePct?: number,
  sizeFactor = 1,
): number {
  // Überzeugungs-Sizing (01.08.): Der Faktor wirkt auf den PROZENTSATZ der
  // Tranche und wird gemeinsam mit ihm bei 25 % gedeckelt — die
  // Klumpengrenze der Risiko-Hülle bleibt die letzte Instanz.
  const f = Number.isFinite(sizeFactor) && sizeFactor > 0 ? Math.min(1.5, Math.max(0.25, sizeFactor)) : 1;
  const pctCap = (pct: number): number => Math.min(25, pct * f);
  // Risiko-Sizing hat Vorrang, wenn es eingeschaltet IST und der Stop-Abstand
  // bekannt ist (28.07.): Dann bestimmt nicht mehr der Depotanteil die
  // Stückzahl, sondern der Betrag, der im Stop-Fall verloren gehen darf —
  // für jede Position derselbe. Fehlt der Stop-Abstand, fällt es bewusst auf
  // den alten Weg zurück statt auf einer unbekannten Zahl zu rechnen.
  const risikoPct = strategy.engine.riskPerTradePct ?? 0;
  if (risikoPct > 0 && typeof stopDistancePct === 'number' && stopDistancePct > 0) {
    const eigenkapital = margin ? margin.equity : Math.max(0, balance);
    const q = riskBasedQty({
      equity: eigenkapital,
      riskPerTradePct: risikoPct * f,
      stopDistancePct,
      effPrice,
      maxPositionPct: pctCap(strategy.engine.maxPositionPct),
      ...(margin ? { buyingPower: margin.buyingPower } : {}),
      fractional,
    });
    if (q > 0) return q;
  }
  // Mit Hebel entscheidet nicht mehr der Cash, sondern das EIGENKAPITAL über
  // die Tranche — sonst schrumpfte sie mit jedem Kauf gegen null und der
  // Hebel wäre nach der ersten Handvoll Positionen wirkungslos, obwohl noch
  // Kaufkraft da ist. Die Kaufkraft deckelt zusätzlich (sizeWithMargin).
  if (margin) {
    return sizeWithMargin(margin, pctCap(strategy.engine.maxPositionPct), effPrice, fractional, margin.leverage);
  }
  const base = strategy.broker.sizingBase ?? 'balance';
  const capital = base === 'initial' ? strategy.broker.initialCapital : Math.max(0, balance);
  const raw = (capital * pctCap(strategy.engine.maxPositionPct)) / 100 / effPrice;
  // Krypto handelt real in BRUCHTEILEN (MA-Fund 26.07.): floor auf ganze
  // Stücke ergab bei BTC (~64 000 $) mit einer 2 500-$-Tranche IMMER 0 —
  // die Engine konnte teure Coins schlicht nie kaufen ('qty_unter_1').
  // µ-Einheiten (6 Nachkommastellen) sind Kauf-Standard der Krypto-Börsen.
  if (fractional) return Math.floor(raw * 1e6) / 1e6;
  return Math.floor(raw);
}

export interface TradeResult {
  executed: boolean;
  reason?: string;
  trade?: Trade & { id: string };
}

/**
 * Anschaffungsbezug für einen SCHLIESSENDEN Trade (04.08.).
 *
 * Der Grund, warum das hier stehen muss und nicht später nachgerüstet werden
 * kann: Das Positions-Doc wird in derselben Transaktion gelöscht. Danach ist
 * Einstand und Eröffnungszeitpunkt nur noch dadurch rekonstruierbar, dass man
 * Käufe und Verkäufe je Symbol chronologisch paart — und das funktioniert NUR,
 * solange Nachkauf verboten und jeder Verkauf ganz ist. Genau diese beiden
 * Bedingungen fallen, sobald es Teilverkäufe gibt.
 */
function anschaffung(pos: Position, jetzt: string): Partial<Trade> {
  const auf = Date.parse(pos.openedAt);
  const zu = Date.parse(jetzt);
  return {
    entryPrice: pos.avgEntry,
    acquiredAt: pos.openedAt,
    ...(Number.isFinite(auf) && Number.isFinite(zu)
      ? { holdingDays: Math.round(((zu - auf) / 86_400_000) * 100) / 100 }
      : {}),
  };
}

/**
 * Momentaufnahme des Signals, die ans Trade-Journal geht (M12).
 *
 * Rein beschreibende Daten — bewusst OHNE Kurs-Bars: Die ≤-60-Bars-Idee aus
 * dem Milestone würde jedes Journal-Doc um ein Vielfaches aufblähen, und der
 * spätere Tagesfilm rekonstruiert denselben Ausschnitt ohnehin aus den
 * `ohlc`-Chunks (Datum + Symbol reichen als Schlüssel).
 */
export interface SignalKontext {
  /** Entscheidungspfad: konfluenz | regelbaum | momentum | manuell. */
  typ: string;
  /** Indikator-Stimmen des Scans (rsi/macd/bollinger → buy/sell/hold). */
  votes?: Record<string, string>;
  /** Konfluenz der gewählten Richtung inkl. Prognose-Stimme. */
  konfluenz?: number;
  /** Erforderliche Konfluenz laut Einstellung — macht „knapp" sichtbar. */
  minKonfluenz?: number;
  /** Prognose-Stimme, falls sie mitgestimmt hat. */
  forecast?: { dir: string; weight: number };
  /** Regime-Zustand zum Zeitpunkt der Entscheidung. */
  regime?: string;
  /**
   * Kam dieser Einstieg NUR durch die ampel-gedeckte Trendstimme zustande?
   * (Owner 18.08.)
   *
   * Die Regel ist seit dem 17.08. scharf und hat die Signalzahl von 0 auf
   * 23 je Scan gehoben — in den ersten 31 Stunden 18 neue Trades, und der
   * Gebührenanteil stieg von 57 % auf 68 %. Ob das gute oder teure Trades
   * sind, kann niemand aus der Summe lesen: Sie stehen im Buch neben
   * Positionen, die Tage vorher aus einer anderen Logik entstanden.
   *
   * Mit diesem Etikett lässt sich die Frage in zwei Wochen beantworten
   * statt diskutieren — dieselbe Disziplin, mit der der Schatten seine
   * Varianten trennt. Ein Feature, dessen Ertrag man nicht isolieren kann,
   * kann man auch nicht verantworten.
   */
  soloTrend?: boolean;
}

export interface TradeRequest {
  uid: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  /** Stückzahl; ohne Angabe beim Kauf: Positionsgröße aus maxPositionPct. */
  qty?: number;
  source: 'engine' | 'manual';
  /** Risiko-Exit-Grund (stop_loss/take_profit/trailing_stop/max_hold). */
  riskExit?: string;
  /**
   * Eingefrorener Signal-Kontext für das Trade-Journal (M12).
   *
   * Warum EINFRIEREN statt nachschlagen: Votes, Konfluenz und Regime sind
   * eine Momentaufnahme des Scans — fünf Minuten später stehen dieselben
   * Indikatoren anders, und aus den Trade-Records allein ist nicht mehr
   * rekonstruierbar, WARUM die Engine gehandelt hat. Optional und rein
   * beschreibend: Kein Buchungspfad liest dieses Feld.
   */
  signalContext?: SignalKontext;
  /** Asset-Klasse für klassen-spezifische Risiko-Level (MA6). */
  assetClass?: string | null;
  /**
   * ECHTER Ausführungskurs vom Broker (M13) — ersetzt die Schätzung
   * `effectivePriceForClass`. Genau dafür gibt es das Routing: Die Schätzung
   * kennt weder Teilausführungen noch den tatsächlichen Spread, und bei einer
   * Kante von 0,143 % gegen 0,300 % Kosten entscheidet diese Größenordnung
   * darüber, ob das System trägt.
   */
  fillPreis?: number;
  /** Order-Kennung beim Broker — die Brücke zwischen Buch und Depot. */
  brokerOrderId?: string;
  /**
   * Leerverkauf erlauben (Owner 26.07.): sell OHNE Position eröffnet dann
   * einen Short statt mit 'keine_position' abzulehnen. Buy auf eine
   * Short-Position deckt IMMER ein (kein Flag nötig — die Position sagt es).
   */
  openShort?: boolean;
  /**
   * Kaufkraft unter Hebel (Owner-Wunsch 28.07.). Ohne dieses Feld ist der
   * Trade strikt BAR gedeckt — exakt das Verhalten von vorher. Der Aufrufer
   * setzt es nur, wenn `broker.leverage > 1` UND das Signal überzeugend
   * genug ist (`effectiveLeverage`).
   */
  margin?: MarginBudget;
  /**
   * Steckbrief des Einstiegs (Trade-Filter 31.07.) — nur bei ÖFFNENDEN
   * Trades gesetzt; landet am Positions-Doc und beim Schließen mit dem
   * realisierten P&L in der globalen Lernstatistik (meta/tradeFilter).
   */
  bucket?: string;
  /**
   * SOCKEL-Kauf des Kern-Satelliten (04.08.): stempelt `core: true` auf die
   * Position. Der 5-Minuten-Scan fasst solche Positionen dann nicht mehr an —
   * siehe Position.core. Nur der Momentum-Lauf setzt dieses Flag.
   */
  core?: boolean;
  /**
   * AUSDRÜCKLICHE Aufstockung einer bestehenden Long-Position (Sockel-
   * Nachschub #345, Red-Team-Befund 20.08.): erlaubt dem Buchungspfad das
   * Einmischen in die Position, das seit dem Vorfall 05.08. sonst nur
   * echten Fills offensteht. Nur der wöchentliche Momentum-/Sockel-Lauf
   * setzt dieses Flag; Scan und Handeingabe nie — deren Wiederholungskauf-
   * Schutz bleibt unverändert. Ohne echten Fill zahlt die Aufstockung
   * strikt aus dem Cash (zu_wenig_cash statt Kredit).
   */
  aufstockung?: boolean;
  /**
   * Überzeugungs-Faktor der Positionsgröße (Owner-Direktive 01.08.): skaliert
   * die Tranche mit messbarer Überzeugung (convictionFactor, 0,25–1,5).
   * Fehlt er, gilt exakt die bisherige Größe. Die Klumpengrenze (25 %)
   * deckelt IMMER zusätzlich — der Faktor kann sie nie aushebeln.
   */
  sizeFactor?: number;
  /**
   * Abstand vom Einstieg bis zum Stop in % — Basis des Risiko-Sizings.
   * Der Aufrufer löst ihn auf (ATR-Vielfaches vor festem Prozentwert),
   * damit die Position mit demselben Abstand DIMENSIONIERT wird, mit dem
   * sie später GESTOPPT wird.
   */
  stopDistancePct?: number;
}

/**
 * Paper-Trade transaktional ausführen (Port von _execute_trade):
 * - buy: nie nachkaufen (Position existiert → no-op); Größe via sizeOrder()
 *   (maxPositionPct vom Cash bzw. Startkapital) oder explizite qty;
 *   Cash-Deckung nötig.
 * - sell: nur mit Position; realisiert P&L in den Trade-Record.
 */
/**
 * Wie viele Stück würde dieser Auftrag bewegen? (M13)
 *
 * VORAB gerechnet, außerhalb der Transaktion — das Order-Routing muss die
 * Menge kennen, bevor es eine Order senden kann, und ein HTTP-Aufruf hat in
 * einer Firestore-Transaktion nichts verloren (sie wird bei Konflikt
 * wiederholt).
 *
 * Bewusst als eigene, PURE Funktion und nicht als zweite Kopie der Regel:
 * Die Transaktion unten ruft dieselbe Funktion auf. Zwei Fassungen derselben
 * Mengenlogik wären zwei Gelegenheiten, eine davon zu vergessen — und die
 * Abweichung fiele erst auf, wenn Buch und Depot auseinanderlaufen.
 *
 * Schließende Aufträge übernehmen die Positionsmenge, öffnende gehen durch
 * `sizeOrder`. `req.qty` schlägt beides, weil ein Aufrufer, der die Menge
 * kennt (Handeingabe, geroutete Order), sie nicht neu ausrechnen lassen darf.
 */
export function planeMenge(
  req: TradeRequest,
  strategy: Strategy,
  kontext: { balance: number; position: Position | null; effPreis: number; fractional: boolean },
): number {
  const pos = kontext.position;
  // Schließen: Buy auf Short (Eindecken) oder Sell auf Long — beides bewegt
  // exakt die offene Menge, nie mehr.
  if (pos && ((req.side === 'buy' && pos.side === 'short') || (req.side === 'sell' && pos.side !== 'short'))) {
    return pos.qty;
  }
  if (req.qty !== undefined) return req.qty;
  return sizeOrder(
    strategy,
    kontext.balance,
    kontext.effPreis,
    kontext.fractional,
    req.margin,
    req.stopDistancePct,
    req.sizeFactor,
  );
}

/**
 * Wie viel eine SCHLIESSENDE Buchung wirklich bewegt — und was übrig bleibt.
 *
 * `planeMenge` fordert beim Schließen immer die volle Position an; der Broker
 * muss sie aber nicht am Stück füllen. `executeTrade` reicht die tatsächlich
 * ausgeführte Menge als `req.qty` weiter (`routing.fillMenge`), und der
 * Schutz-Stop tut dasselbe mit `fillQty` — dort ausdrücklich, denn er
 * STORNIERT den Rest der Stop-Order (`schutzStop.ts`, „Teilausführung wird
 * wie eine Ausführung behandelt"). Dieser Rest füllt also garantiert nie nach.
 *
 * Wer die Position trotzdem ganz ausbucht, richtet zweierlei Schaden an:
 *
 *   1. GELD. Erlös, realisierter P&L und Gebühr laufen über Stücke, die nie
 *      den Besitzer gewechselt haben. Beim Cover kommt die volle Margin
 *      zurück statt des gefüllten Anteils.
 *   2. AUFSICHT — das Schlimmere. Die verbliebenen Stücke liegen weiter beim
 *      Broker, stehen aber in keinem Buch mehr: kein Stop, kein Trailing,
 *      kein Signal-Exit, keine Sicht für den Risikolauf. Beim Short bleibt
 *      ein offener Leerverkauf ohne Absicherung zurück. Der Abgleich stuft
 *      so etwas als „Fremdbestand" ein — die HARMLOSE Kategorie, ohne Sperre.
 *
 * Die Position zu verkleinern statt zu löschen erschwert keinen Ausstieg: Der
 * gefüllte Teil IST ausgestiegen, und der Rest kommt überhaupt erst dadurch
 * wieder unter Aufsicht, dass er im Buch steht. Beim nächsten Scan stellt
 * `pflegeSchutz` ihm einen frischen Stop.
 *
 * Ohne verwertbare Wunschmenge bleibt es beim heutigen Verhalten (ganz
 * schließen) — eine fehlende Angabe darf nie zu einem Rest führen, den
 * niemand angefordert hat. Mehr als die offene Menge wird nie gebucht.
 */
export function schlussMenge(
  posQty: number,
  gewuenscht?: number,
): { menge: number; rest: number; ganz: boolean } {
  const voll = { menge: posQty, rest: 0, ganz: true };
  if (gewuenscht === undefined || !Number.isFinite(gewuenscht) || gewuenscht <= 0) return voll;
  if (gewuenscht >= posQty) return voll;
  const rest = posQty - gewuenscht;
  // Float-Rauschen ist kein Restbestand: 10 − 9.999999999 hinterlässt keine
  // handelbaren Stücke, wohl aber eine Geisterposition, die jeder Abgleich
  // ab da als Drift meldet.
  if (rest <= Math.abs(posQty) * 1e-9) return voll;
  return { menge: gewuenscht, rest, ganz: false };
}

/**
 * Trade ausführen — mit Order-Routing an den Broker, wenn eins hinterlegt ist.
 *
 * ── Die eine Stelle, an der geroutet wird ─────────────────────────────────
 *
 * Der Scan ruft `executePaperTrade` an neun Stellen auf (Kauf, Short,
 * Eindecken, vier Exit-Gründe, Regelbaum, Momentum). Das Routing dort je
 * einzeln einzubauen wären neun Gelegenheiten, eine zu vergessen — genau das
 * Muster, das `entrySperre` im Scan bewusst vermeidet. Deshalb diese Hülle:
 * Sie ersetzt den direkten Aufruf, und der Broker-Kern bleibt unangetastet.
 *
 * ── Reihenfolge: erst ausführen, dann buchen ──────────────────────────────
 *
 * Die Order geht raus, der Fill wird abgewartet, und ERST der bestätigte
 * Ausführungskurs wird gebucht. Umgekehrt stünde ein Trade im Buch, den es
 * beim Broker vielleicht nie gab.
 *
 * Bleibt der Fill aus, wird NICHTS gebucht. Die Order steht dann eventuell
 * weiter beim Broker und wird beim nächsten Abgleich sichtbar — als Position,
 * die nur dort existiert. Das ist der Fall, für den der Abgleich da ist.
 *
 * ── Ohne Verbindung ändert sich gar nichts ────────────────────────────────
 *
 * Kein Broker hinterlegt ⇒ direkter Durchgriff, kein zusätzlicher Read, kein
 * verändertes Verhalten. Das ist der Normalfall: Die meisten Konten handeln
 * im eigenen Buch, und ein Papierkonto ist Opt-in.
 */
export async function executeTrade(
  req: TradeRequest,
  strategy: Strategy,
  laufId: string,
): Promise<TradeResult> {
  const verbindung = await brokerVerbindung(req.uid);
  if (!verbindung) return executePaperTrade(req, strategy);

  const db = getFirestore();
  const userRef = db.doc(`users/${req.uid}`);
  const [userSnap, posSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('positions').doc(req.symbol).get(),
  ]);
  const balance = (userSnap.get('wallet.paperBalance') as number | undefined) ?? 0;
  const position = posSnap.exists ? (posSnap.data() as Position) : null;

  /* Die Kennung, unter der dieser Auftrag beim Broker ankommt.
   *
   * EINMAL abgeleitet und ab hier überall benutzt — Order, Fehlerspur und
   * Schutz-Stop. Zwei Ableitungen wären zwei Gelegenheiten, sie verschieden
   * zu machen; die Begründung steht bei `auftragsLauf`. */
  const lauf = auftragsLauf(req, position, laufId);

  /* Schließt dieser Auftrag eine Position, die der Broker gar nicht kennt?
   *
   * Der gefährlichste Einzelfall dieser ganzen Schicht. Wer sein Konto
   * verbindet, hat in aller Regel schon Positionen im eigenen Buch — die
   * sind dort nie angekommen. Ein Verkaufsauftrag für so eine Position würde
   * beim Broker keinen Bestand auflösen, sondern einen LEERVERKAUF eröffnen:
   * aus einem gewollten Ausstieg würde ein ungewollter Einstieg in die
   * Gegenrichtung, mit echtem Risiko und ohne Stop.
   *
   * Deshalb: Exits werden nur geroutet, wenn die Position beim Öffnen
   * tatsächlich über den Broker entstanden ist (`Position.broker`). Alles
   * andere bleibt reine Buchführung — genau wie vor dem Verbinden. */
  const schliesst =
    position !== null &&
    ((req.side === 'buy' && position.side === 'short') ||
      (req.side === 'sell' && position.side !== 'short'));
  if (schliesst && position.broker !== true) return executePaperTrade(req, strategy);

  /* Ein Verkauf, der weder schließt noch ein AUSDRÜCKLICHER Leerverkauf auf
   * leerem Bestand ist, darf NIE zum Broker (Short-Audit 07.08.). Vorher
   * lief er durch: Das Buch lehnte zwar ab (keine_position bzw.
   * short_nachverkauf_verboten) — aber ERST NACH dem Routing. Beim Broker
   * war da längst ein echter Leerverkauf eröffnet (bzw. ein bestehender
   * Short verdoppelt), ungebucht, ohne Stop. Erreichbar über den manuellen
   * Verkaufs-Knopf; die Ablehnung muss deshalb VOR die Order. */
  if (req.side === 'sell' && !schliesst && !(req.openShort === true && position === null)) {
    return executePaperTrade(req, strategy);
  }

  const klasse = req.assetClass ?? classify(req.symbol);

  /* Schutz-Stop aus dem Weg räumen (Bracket Stufe 1, 06.08.).
   *
   * Alpaca RESERVIERT die Stücke für die offene Stop-Order — ohne Storno
   * würde der eigene Exit mit „insufficient qty" abgelehnt. Und wenn der
   * Storno „nicht stornierbar" meldet, hat der Stop meist schon verkauft:
   * Dann wird DESSEN Fill gebucht (als Risk-Exit zum echten Stop-Kurs)
   * statt ein zweiter Verkauf versucht, der einen ungewollten Short
   * eröffnen würde. */
  const schutz = schliesst && position.broker === true ? (position.schutz ?? null) : null;
  if (schutz?.orderId) {
    const aufhebung = await schutzAufheben(verbindung, req.uid, req.symbol, schutz).catch(
      (err: unknown) => {
        logger.warn(`schutzAufheben ${req.uid} ${req.symbol} fehlgeschlagen`, err);
        return { stand: 'frei' } as const;
      },
    );
    if (aufhebung.stand === 'gefuellt') {
      return executePaperTrade(
        {
          ...req,
          qty: aufhebung.fillQty,
          fillPreis: aufhebung.fillPreis,
          brokerOrderId: aufhebung.orderId,
          riskExit: req.riskExit ?? 'stop_loss',
        },
        strategy,
      );
    }
  }

  /* Eigenschaften vom Broker statt geraten (Alpaca-Sync 05.08.).
   *
   * `fractionable`: Bisher hieß „Bruchstücke erlaubt" schlicht „Klasse ist
   * Krypto" — dabei erlaubt Alpaca sie für die meisten US-Aktien. Für ein
   * kleines Konto ist das der Unterschied zwischen „kauft 0,4 Stück" und
   * „scheitert an qty_unter_1". `shortable`: Ein nicht leihbares Papier
   * wird jetzt VOR der Order abgefangen, mit klarem Grund — statt als
   * abgelehnte Order beim Broker zu enden. `null` (Symbol unbekannt,
   * Metadaten nicht erreichbar) fällt auf die bisherigen Schätzungen
   * zurück: Metadaten dürfen den Handel verbessern, nie verhindern. */
  const stand = await assetStand(verbindung, req.symbol);
  const asset = stand.art === 'bekannt' ? stand.asset : null;
  const eroeffnet = !schliesst;
  const vor = brokerVorpruefung(stand, { eroeffnet, wirdShort: req.side === 'sell' });
  if (!vor.ok) return { executed: false, reason: vor.grund };
  // Leerverkäufe verlangen bei Alpaca GANZE Stücke — fractionable gilt nur
  // für Long-Käufe und das Schließen fraktionaler Bestände (Short-Audit 07.08.).
  const fractional =
    (asset?.fractionable ?? (klasse === 'crypto')) && !(req.side === 'sell' && !schliesst);
  // Für die MENGE reicht der Schätzpreis: Er entscheidet über die Stückzahl,
  // nicht über den Buchwert. Der echte Kurs kommt gleich vom Broker zurück
  // und ersetzt ihn beim Buchen.
  const effSchaetzung = effectivePriceForClass(req.price, req.side, klasse);
  /* Auch die ECHTE Order rechnet mit dem gedeckelten Kapital (Red-Team
   * 20.08., Rest von Hochbefund 1): Der Deckel vom 13.08. saß nur im
   * Buchungspfad — also genau in der Spur, die ihn am wenigsten braucht.
   * Die reale Order wurde weiter am ungedeckelten Buchstand bemessen; beim
   * Anlassfall (Buch +39 311 $, Broker −45 286 $) ging sie in voller Größe
   * raus, und ein Margin-Konto füllt so etwas auf Kredit. Der Deckel wirkt
   * hier NUR aufs Einstiegs-Sizing: Schließende Mengen kommen aus der
   * Position, eine ausdrückliche req.qty bleibt unangetastet (planeMenge). */
  const deckelOrder = kapitalDeckel(
    userSnap.get('risk.abgleich'),
    balance,
    new Date().toISOString(),
  );
  const qty = planeMenge(req, strategy, {
    balance: deckelOrder,
    position,
    effPreis: effSchaetzung,
    fractional,
  });
  // Hier ist noch nichts gefüllt — die Order geht erst gleich raus.
  if (mengeZuKlein(qty, fractional, false)) return { executed: false, reason: 'qty_unter_1' };

  /* Hebel 1b (Owner 15.08., „rund um die Uhr"): Krypto-EINSTIEGE gehen als
   * Limit-Order zum Entscheidungskurs statt als Market-Order. Alpaca nimmt
   * für Maker 0,15 % statt Taker 0,25 % — bei der Klasse, deren Gebühren
   * (1.316 $) ihren Brutto-Gewinn (+691 $) auffressen, ist der Verzicht
   * auf das Spread-Überqueren der größte einzelne Kostenhebel. Füllt das
   * Limit im Wartefenster nicht, storniert K-2c die Order (kein_fill) —
   * ein verpasster Einstieg kostet nichts, ein zu teurer echtes Geld.
   * NUR Einstiege: Exits bleiben Market (das Routing erzwingt das
   * zusätzlich selbst). Gebucht wird weiterhin die Taker-Gebühr der
   * Klasse — lieber zu viel Reibung einplanen als zu wenig. */
  const limitPreis =
    eroeffnet && klasse === 'crypto' ? rundeLimitPreis(req.price, req.side) : 0;

  const routing = await routeOrder(verbindung, {
    uid: req.uid,
    symbol: req.symbol,
    side: req.side,
    qty,
    ...(limitPreis > 0 ? { limitPreis } : {}),
    // K-2c: Eine ungefüllte ERÖFFNENDE Order wird storniert, damit sie
    // nicht Minuten später füllt, während der nächste Scan erneut kauft.
    // Schließende bleiben stehen — ihr später Fill ist erwünscht und wird
    // über die positionsstabile Kennung nachgebucht.
    stornoBeiKeinFill: eroeffnet,
    laufId: lauf,
  });
  if (!routing.ausgefuehrt) {
    return { executed: false, reason: `broker_${routing.grund ?? 'unbekannt'}` };
  }

  // Die AUSGEFÜHRTE Menge gilt, nicht die geplante: Bei einer Teilausführung
  // liegt weniger im Depot, und das Buch muss dem folgen — sonst rechnet die
  // Engine mit Stücken, die es nicht gibt.
  const buchung = await executePaperTrade(
    {
      ...req,
      qty: routing.fillMenge ?? qty,
      fillPreis: routing.fillPreis!,
      ...(routing.brokerOrderId ? { brokerOrderId: routing.brokerOrderId } : {}),
    },
    strategy,
  ).catch((err: unknown) => ({
    executed: false as const,
    reason: `buchung_exception: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
  }));

  /* Ein bestätigter Fill, der nicht gebucht wurde, darf NIEMALS stumm
   * verschwinden (Vorfall 05.08.). Er wird festgehalten — mit allem, was
   * zum Nachbuchen nötig ist — und laut gemeldet. Die Depot-Übernahme
   * (`adoptBroker`) räumt solche Fälle auf; dieses Dokument sorgt dafür,
   * dass es überhaupt etwas zum Aufräumen gibt und der Fall nicht erst
   * beim Abgleich als anonymer „Fremdbestand" auftaucht. */
  if (!buchung.executed) {
    logger.error(
      `FILL NICHT GEBUCHT ${req.uid} ${req.symbol} ${req.side} ` +
        `${routing.fillMenge ?? qty} @ ${routing.fillPreis} — ${buchung.reason ?? 'unbekannt'}`,
    );
    await db
      .collection('users')
      .doc(req.uid)
      .collection('unbookedFills')
      .doc()
      .set({
        symbol: req.symbol,
        side: req.side,
        qty: routing.fillMenge ?? qty,
        fillPreis: routing.fillPreis ?? null,
        brokerOrderId: routing.brokerOrderId ?? null,
        laufId: lauf,
        grund: buchung.reason ?? 'unbekannt',
        at: new Date().toISOString(),
      })
      .catch((err: unknown) => logger.error(`unbookedFills ${req.uid} nicht schreibbar`, err));
    /* Cooldown stempeln (Audit 13.08., K-2a): Ohne ihn sah der nächste
     * 5-Minuten-Scan dasselbe Kaufsignal, keine Position, keinen Cooldown —
     * und kaufte ERNEUT echt, alle fünf Minuten, solange das Signal stand.
     * Genau dieser Loop war der NVDA-Vorfall vom 11.08.; behoben wurde
     * damals nur der eine Auslöser (qty_unter_1), nicht die Fehlerklasse.
     * Der Stempel gilt für jede Buchungs-Panne, die ein bestätigter Fill
     * hinterlässt. */
    await db
      .doc(`users/${req.uid}`)
      .set({ engineCooldowns: { [req.symbol]: new Date().toISOString() } }, { merge: true })
      .catch((err: unknown) => logger.warn(`Cooldown nach Fill-Panne ${req.uid}`, err));
  }

  /* Schutz-Stop anlegen (Bracket Stufe 1): nur nach einem ERÖFFNENDEN,
   * GEBUCHTEN Fill. Liest die Position frisch (Nachkauf → Gesamtmenge) und
   * wirft nie — ein fehlgeschlagenes Sicherheitsnetz darf den gebuchten
   * Trade nicht rückwirkend scheitern lassen; die Engine-Stops gelten ja
   * weiter. */
  if (buchung.executed && eroeffnet) {
    await schutzAnlegen(
      verbindung,
      req.uid,
      req.symbol,
      resolveRisk(strategy.engine, klasse),
      klasse,
      lauf,
    );
  }
  return buchung;
}

/**
 * Unverbuchte Fills nachbuchen (Audit 13.08., K-2b).
 *
 * `unbookedFills` war bis heute ein Friedhof mit Beschriftung: Der Fill
 * wurde festgehalten „mit allem, was zum Nachbuchen nötig ist" — aber
 * niemand hat je nachgebucht. Die Position lag real beim Broker (gekauft,
 * bezahlt, ohne Stop), im Buch fehlte sie, und der Abgleich stufte sie als
 * harmlosen Fremdbestand ein. Heilung nur von Hand über die Übernahme.
 *
 * Diese Funktion läuft je Konto zu Beginn des Scans: Sie nimmt die
 * ältesten Einträge, prüft gegen die Trade-Historie, ob die Order-Kennung
 * nicht doch schon gebucht wurde (Doppelbuchung wäre schlimmer als eine
 * späte), bucht den Fill über den normalen Buchungspfad und löscht den
 * Eintrag erst NACH erfolgreicher Buchung. Ein Eintrag ohne verwertbaren
 * Fill (kein Preis, keine Menge) bleibt liegen — er ist ein Fall für die
 * Übernahme, nicht für eine geratene Buchung.
 *
 * Bewusst gedeckelt (3 je Lauf): Der Normalzustand ist eine LEERE Liste;
 * die Schleife darf den Scan nie messbar verlängern.
 *
 * ── Kopf-Blockade (Owner-Fund 21.08.: „5 Trades nicht registriert") ──────
 *
 * Bis dahin nahm die Abfrage schlicht `orderBy('at').limit(3)` — die
 * ÄLTESTEN drei. Ein Eintrag ohne verwertbaren Fill blieb liegen, eine
 * scheiternde Buchung ebenfalls. Beim nächsten Lauf griff dieselbe Abfrage
 * dieselben drei. Steckten die ältesten drei fest, kamen Eintrag vier und
 * fünf NIE an die Reihe — die Heilung lief, buchte aber für immer nichts,
 * und niemand sah es, weil nur der Erfolgsfall geloggt wurde.
 *
 * Deshalb jetzt: Ein Fehlversuch zählt hoch (`versuche`). Wer die Grenze
 * reisst, gilt als Fall für die Übernahme und wird beim Auswählen
 * übersprungen — er blockiert nichts mehr, verschwindet aber auch nicht
 * still. Gelesen wird ein FENSTER der ältesten Einträge, damit die Auswahl
 * ohne zweites Sortierfeld (und damit ohne zusammengesetzten Index)
 * auskommt.
 */
/** Ab so vielen Fehlversuchen gilt ein Eintrag als Fall für die Übernahme. */
export const NACHBUCHUNG_TOT_AB = 5;
/** So viele der ältesten Einträge werden je Lauf betrachtet (Auswahl in JS). */
const NACHBUCHUNG_FENSTER = 25;

export interface NachbuchungsStand {
  /** Erfolgreich nachgebuchte Fills in diesem Lauf. */
  gebucht: number;
  /** Einträge, die danach noch offen sind (inkl. der festhängenden). */
  offen: number;
  /** Davon festhängend: `versuche >= NACHBUCHUNG_TOT_AB` — Fall für Übernahme. */
  steckt: number;
}

export async function bucheUnverbuchteFills(
  uid: string,
  strategy: Strategy,
  limit = 3,
): Promise<NachbuchungsStand> {
  const leer: NachbuchungsStand = { gebucht: 0, offen: 0, steckt: 0 };
  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const fenster = await userRef
    .collection('unbookedFills')
    .orderBy('at')
    .limit(NACHBUCHUNG_FENSTER)
    .get()
    .catch(() => null);
  if (!fenster || fenster.empty) return leer;

  const versucheVon = (d: FirebaseFirestore.QueryDocumentSnapshot): number => {
    const v = d.get('versuche') as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  /**
   * Ohne Preis oder Menge ist nichts zu buchen — und das steht im Eintrag,
   * nicht erst im Ergebnis. Solche Einträge dürfen deshalb GAR KEINEN Platz
   * verbrauchen: Sie fünfmal „scheitern" zu lassen, hielte gesunde Fills
   * fünf Läufe lang auf. In der Emulator-Probe war genau das der
   * Unterschied zwischen Lauf 1 und Lauf 6.
   */
  const unbrauchbar = (d: FirebaseFirestore.QueryDocumentSnapshot): boolean => {
    const zahl = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    return (
      typeof d.get('symbol') !== 'string'
      || (d.get('side') !== 'buy' && d.get('side') !== 'sell')
      || !(zahl(d.get('qty')) > 0)
      || !(zahl(d.get('fillPreis')) > 0)
    );
  };
  const aufgegeben = (d: FirebaseFirestore.QueryDocumentSnapshot): boolean =>
    versucheVon(d) >= NACHBUCHUNG_TOT_AB || unbrauchbar(d);

  const steckt = fenster.docs.filter(aufgegeben).length;
  // Nur die noch Buchbaren, und davon höchstens `limit` je Lauf.
  const dran = fenster.docs.filter((d) => !aufgegeben(d)).slice(0, limit);

  /* Einen unbrauchbaren Eintrag EINMAL als aufgegeben festschreiben, damit
   * der Grund im Dokument steht und nicht nur in einer Logzeile von
   * vorgestern. Danach wird er nie wieder angefasst. */
  for (const doc of fenster.docs) {
    if (unbrauchbar(doc) && versucheVon(doc) < NACHBUCHUNG_TOT_AB) {
      logger.warn(`unbookedFills ${uid}/${doc.id}: kein verwertbarer Fill — Fall für die Übernahme`);
      await doc.ref
        .set(
          {
            versuche: NACHBUCHUNG_TOT_AB,
            letzterVersuch: new Date().toISOString(),
            letzterGrund: 'kein_verwertbarer_fill',
          },
          { merge: true },
        )
        .catch(() => undefined);
    }
  }

  /** Fehlversuch festhalten — nur so verlässt ein toter Eintrag je den Kopf. */
  const merkeFehlversuch = async (
    doc: FirebaseFirestore.QueryDocumentSnapshot,
    grund: string,
  ): Promise<void> => {
    await doc.ref
      .set(
        {
          versuche: versucheVon(doc) + 1,
          letzterVersuch: new Date().toISOString(),
          letzterGrund: grund.slice(0, 200),
        },
        { merge: true },
      )
      .catch(() => undefined);
  };

  let gebucht = 0;
  for (const doc of dran) {
    const d = doc.data() as {
      symbol?: string;
      side?: 'buy' | 'sell';
      qty?: number;
      fillPreis?: number | null;
      brokerOrderId?: string | null;
    };
    /* `dran` enthält keine unbrauchbaren Einträge mehr — die sind oben
     * aussortiert. Der Guard bleibt trotzdem stehen: Er trägt die
     * Nicht-Null-Zusicherungen für den TypeScript-Pfad darunter. */
    if (!d.symbol || !d.side || !(d.qty! > 0) || !(d.fillPreis! > 0)) continue;
    if (d.brokerOrderId) {
      const schon = await userRef
        .collection('trades')
        .where('brokerOrderId', '==', d.brokerOrderId)
        .limit(1)
        .get()
        .catch(() => null);
      if (schon && !schon.empty) {
        await doc.ref.delete().catch(() => undefined);
        continue;
      }
    }
    const r = await executePaperTrade(
      {
        uid,
        symbol: d.symbol,
        side: d.side,
        price: d.fillPreis!,
        qty: d.qty!,
        fillPreis: d.fillPreis!,
        ...(d.brokerOrderId ? { brokerOrderId: d.brokerOrderId } : {}),
        source: 'engine',
        assetClass: classify(d.symbol),
      },
      strategy,
    ).catch((err: unknown) => ({
      executed: false as const,
      reason: `nachbuchung_exception: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    }));
    if (r.executed) {
      await doc.ref.delete().catch(() => undefined);
      gebucht += 1;
      logger.info(`unbookedFills ${uid}: ${d.side} ${d.qty} ${d.symbol} @ ${d.fillPreis} nachgebucht`);
    } else {
      logger.warn(`unbookedFills ${uid}/${doc.id}: Nachbuchung scheitert weiter — ${r.reason ?? '?'}`);
      await merkeFehlversuch(doc, r.reason ?? 'unbekannt');
    }
  }
  // `offen` zählt das gelesene Fenster minus das, was dieser Lauf gebucht hat.
  // Bei mehr als `NACHBUCHUNG_FENSTER` Einträgen ist es eine Untergrenze —
  // die genaue Zahl ist dann ohnehin nicht die interessante Nachricht.
  return { gebucht, offen: Math.max(0, fenster.size - gebucht), steckt };
}

export async function executePaperTrade(req: TradeRequest, strategy: Strategy): Promise<TradeResult> {
  const db = getFirestore();
  const userRef = db.doc(`users/${req.uid}`);
  const posRef = userRef.collection('positions').doc(req.symbol);
  const tradeRef = userRef.collection('trades').doc();

  if (!(req.price > 0) || !Number.isFinite(req.price)) {
    return { executed: false, reason: 'kein_preis' };
  }

  /* EZB-Kurs VOR der Transaktion holen (M12b).
   *
   * Zwei Gründe, warum er nicht hineingehört: Eine Firestore-Transaktion
   * wird bei Konflikt WIEDERHOLT — ein HTTP-Aufruf darin liefe mehrfach.
   * Und sie soll kurz sein; ein fremder Server mit acht Sekunden Timeout
   * ist das Gegenteil davon.
   *
   * Schlägt der Abruf fehl, bleiben die Felder leer und der Trade läuft
   * trotzdem: Ein nicht erreichbarer Kursserver darf keinen Handel
   * verhindern — aber auch keine erfundene Zahl in eine Steuererklärung
   * schreiben. Der Bericht zählt solche Vorgänge als `fxLuecken`.
   */
  const fx = await fxFelder(new Date().toISOString(), currencyForSymbol(req.symbol));

  return db.runTransaction(async (tx) => {
    const [userSnap, posSnap] = await Promise.all([tx.get(userRef), tx.get(posRef)]);
    if (!userSnap.exists) return { executed: false, reason: 'kein_profil' };
    const balance = (userSnap.get('wallet.paperBalance') as number | undefined) ?? 0;
    const now = new Date().toISOString();
    /* Einstiege rechnen mit dem GEDECKELTEN Kapital (siehe kapitalDeckel):
     * min(Buch, Broker) aus dem letzten Konto-Abgleich. Die Wallet-Buchungen
     * weiter unten bleiben beim echten Buchstand — der Deckel entscheidet,
     * OB und WIE GROSS gekauft wird, nicht, was gebucht wird. */
    const deckung = kapitalDeckel(userSnap.get('risk.abgleich'), balance, now);

    /* Realismus (User-Wunsch 25.07.): Ausführung zum EFFEKTIVEN Preis —
     * Kommission + Slippage wie im Backtest; rawPrice bleibt im Record.
     *
     * KLASSENECHT seit 04.08. Vorher rechnete das Buch für JEDE Anlageklasse
     * denselben Pauschalsatz von 0,105 % je Seite, während das Kosten-Tor beim
     * EINSTIEG (scanMarket) längst klassenecht rechnete. Krypto kostet real
     * 0,25 % je Seite — es wurde also 2,4-fach zu billig verbucht, und zwar
     * ausgerechnet in der Klasse, die rund um die Uhr handelt und deshalb am
     * häufigsten im Buch steht. Aus diesen P&Ls lernen Trade-Filter, A/B-Duell
     * und Auto-Tuner: die Verzerrung ließ Krypto-Steckbriefe zu spät blocken
     * und Aktien-Steckbriefe zu früh. */
    const klasse = req.assetClass ?? classify(req.symbol);
    const gebuehr = feePartsForClass(klasse);

    /* Echter Fill schlägt Schätzung (M13).
     *
     * Liegt ein bestätigter Ausführungskurs vom Broker vor, wird ER gebucht —
     * mit Kommission, aber OHNE den geschätzten Slippage-Aufschlag: Die
     * Slippage ist im Fill bereits enthalten (sie ist der Abstand zwischen
     * `req.price` und dem gemeldeten Kurs). Ein zweiter Aufschlag wäre eine
     * Doppelbuchung, die genau die Kante verfälscht, die wir messen wollen. */
    const echterFill = req.fillPreis !== undefined && req.fillPreis > 0;
    const eff = echterFill
      ? Math.round(effectivePriceFromFill(req.fillPreis!, req.side, klasse) * 10_000) / 10_000
      : Math.round(effectivePriceForClass(req.price, req.side, klasse) * 10_000) / 10_000;

    /* Herkunftsangaben, die an JEDEN Trade gehören (04.08.).
     *
     * Nicht aus Steuergründen — es ist Papiergeld —, sondern weil sie später
     * nicht mehr rekonstruierbar sind: Eine Katalog-Änderung verschiebt die
     * Anlageklasse rückwirkend, und sobald eine Gebühren-Konstante angefasst
     * wird, ist die Aufteilung Kommission/Slippage historisch verloren. */
    const herkunft = {
      assetClass: klasse,
      currency: currencyForSymbol(req.symbol),
      commissionRate: gebuehr.commission,
      // Bei echtem Fill ist die Slippage REAL geflossen und steckt im Kurs;
      // sie hier nochmal als Satz zu führen würde sie doppelt ausweisen.
      slippageRate: echterFill ? 0 : gebuehr.slippage,
      feeRate: echterFill ? gebuehr.commission : gebuehr.commission + gebuehr.slippage,
      /** Woher der Ausführungskurs stammt — 'broker' heißt: bestätigt, nicht geschätzt. */
      preisQuelle: echterFill ? 'broker' : 'modell',
      ...(echterFill ? { brokerFillPrice: req.fillPreis! } : {}),
      ...(req.brokerOrderId ? { brokerOrderId: req.brokerOrderId } : {}),
      // Eingefrorener EZB-Kurs (M12b) — nie nachträglich neu holen, sonst
      // wandern historische Gewinne. Fehlt er, fehlt er ehrlich.
      ...fx,
    };
    /**
     * Ausführungskosten dieses Trades in Kontowährung.
     *
     * Basis ist der Kurs, auf den die Gebühr real anfällt: bei bestätigtem
     * Fill der Fill-Kurs, sonst der gesehene Kurs. `herkunft.feeRate` trägt
     * die passende Rate (mit oder ohne Slippage-Anteil) bereits.
     */
    const gebuehrenBasis = echterFill ? req.fillPreis! : req.price;
    const kosten = (menge: number): number =>
      Math.round(menge * gebuehrenBasis * herkunft.feeRate * 100) / 100;

    if (req.side === 'buy') {
      // Buy auf eine SHORT-Position = Eindecken (Cover): Margin + P&L zurück.
      // P&L eines Shorts = (Einstand − Rückkaufkurs) × Stück — verdient,
      // wenn der Kurs seit dem Leerverkauf GEFALLEN ist.
      if (posSnap.exists && (posSnap.data() as Position).side === 'short') {
        const pos = posSnap.data() as Position;
        const { menge: qty, rest, ganz } = schlussMenge(pos.qty, req.qty);
        const pnl = (pos.avgEntry - eff) * qty;
        const margin = qty * pos.avgEntry;
        const trade: Trade & {
          pnl: number;
          riskExit?: string;
          cover: boolean;
          teilSchluss?: true;
        } = {
          symbol: req.symbol,
          side: 'buy',
          qty,
          ...(ganz ? {} : { teilSchluss: true as const }),
          price: eff,
          executedAt: now,
          source: req.source,
          paper: true,
          pnl: Math.round(pnl * 100) / 100,
          cover: true,
          ...(req.riskExit ? { riskExit: req.riskExit } : {}),
          ...(pos.bucket ? { bucket: pos.bucket } : {}),
        };
        if (ganz) tx.delete(posRef);
        else tx.update(posRef, { qty: rest });
        tx.set(tradeRef, {
          ...trade,
          at: Timestamp.now(),
          rawPrice: req.price,
          ...herkunft,
          fee: kosten(qty),
          ...(ganz ? {} : { restMenge: rest }),
          ...anschaffung(pos, now),
        });
        tx.update(userRef, { 'wallet.paperBalance': roundCents(balance + margin + pnl), 'wallet.updatedAt': now });
        return { executed: true, trade: { ...trade, id: tradeRef.id } };
      }
      if (posSnap.exists) {
        /* Nachkauf bleibt VERBOTEN — außer (a) die Stücke liegen bereits im
         * Depot (Vorfall 05.08.): Ein bestätigter Fill ist ein Fait
         * accompli — wer ihn ablehnt, macht die Order nicht ungeschehen,
         * er macht nur das Buch zum Lügner. Oder (b) der Kauf ist eine
         * AUSDRÜCKLICHE Aufstockung des wöchentlichen Rebalancings
         * (Sockel-Nachschub #345; Red-Team-Befund 20.08.: ohne dieses Flag
         * scheiterte jeder Nachschub-Kauf ohne Broker-Verbindung still an
         * genau dieser Zeile — der Schatten führte aus, die echten Konten
         * nicht). Der 05.08.-Schutz gegen Wiederholungskäufe bleibt: Scan
         * und Handeingabe setzen das Flag nie. */
        if (!echterFill && req.aufstockung !== true) {
          return { executed: false, reason: 'position_existiert' };
        }
        const pos = posSnap.data() as Position;
        if (pos.side === 'short') return { executed: false, reason: 'position_existiert' };
        const qty = req.qty ?? 0;
        if (!(qty > 0)) return { executed: false, reason: 'qty_unter_1' };
        const cost = qty * eff;
        /* Aufstockung ohne echten Fill zahlt strikt aus dem CASH — der
         * Nachschub ist aus der Equity dimensioniert und darf nie still
         * einen Kredit eröffnen. Ein echter Fill wird dagegen IMMER
         * gebucht (das Geld ist beim Broker geflossen); geht er unter
         * null, steht der Fehlbetrag als `borrowed` am Trade — dieselbe
         * Forensik wie beim Neueinstieg (Red-Team-Befund 2, 20.08.). */
        if (!echterFill && cost > deckung) {
          return { executed: false, reason: 'zu_wenig_cash' };
        }
        const borrowed = roundCents(Math.max(0, cost - Math.max(0, balance)));
        const nQty = pos.qty + qty;
        const nAvg = Math.round(((pos.qty * pos.avgEntry + qty * eff) / nQty) * 10_000) / 10_000;
        const risk = resolveRisk(strategy.engine, req.assetClass ?? classify(req.symbol));
        tx.set(posRef, {
          ...pos,
          qty: nQty,
          avgEntry: nAvg,
          stopLoss: risk.stopLossPct > 0 ? nAvg * (1 - risk.stopLossPct / 100) : (pos.stopLoss ?? null),
          takeProfit:
            risk.takeProfitPct > 0 ? nAvg * (1 + risk.takeProfitPct / 100) : (pos.takeProfit ?? null),
          highWater: Math.max(pos.highWater ?? nAvg, eff),
          // `broker: true` sagt „liegt real beim Broker" — das darf nur ein
          // echter Fill behaupten; die Paper-Aufstockung erbt den Stand der
          // Position aus `...pos`.
          ...(echterFill ? { broker: true } : {}),
          ...(req.brokerOrderId ? { brokerOrderId: req.brokerOrderId } : {}),
        });
        const trade: Trade & { nachkauf: boolean } = {
          symbol: req.symbol,
          side: 'buy',
          qty,
          price: eff,
          executedAt: now,
          source: req.source,
          paper: true,
          nachkauf: true,
        };
        tx.set(tradeRef, {
          ...trade,
          at: Timestamp.now(),
          rawPrice: req.price,
          ...herkunft,
          fee: kosten(qty),
          ...(borrowed > 0 ? { borrowed } : {}),
        });
        tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - cost), 'wallet.updatedAt': now });
        return { executed: true, trade: { ...trade, id: tradeRef.id } };
      }
      const cls = req.assetClass ?? classify(req.symbol);
      const fractional = cls === 'crypto';
      const qty = req.qty ?? sizeOrder(strategy, deckung, eff, fractional, req.margin, req.stopDistancePct, req.sizeFactor);
      if (mengeZuKlein(qty, fractional, echterFill)) {
        return { executed: false, reason: 'qty_unter_1' };
      }
      const cost = qty * eff;
      // Ohne Hebel prüft der Cash, mit Hebel die Kaufkraft. Der Cash darf
      // dabei NEGATIV werden — das ist der geliehene Betrag, auf den
      // accrueMarginInterest täglich Zinsen bucht.
      //
      // Bei ECHTEM Fill entfallen beide Prüfungen (05.08.): Das Geld ist
      // beim Broker bereits geflossen; die Buchung abzulehnen ließe den
      // Kauf real bestehen und nur das Buch dahinter zurückfallen. Der
      // Fehlbetrag läuft als `borrowed` — sichtbar, nicht wegdefiniert.
      if (!echterFill) {
        if (req.margin) {
          if (cost > req.margin.buyingPower + 1e-9) return { executed: false, reason: 'zu_wenig_kaufkraft' };
        } else if (cost > deckung) {
          return { executed: false, reason: 'zu_wenig_cash' };
        }
      }
      const borrowed = roundCents(Math.max(0, cost - Math.max(0, balance)));

      // Level klassen-aufgelöst festschreiben (MA6): Krypto bekommt weitere
      // Stops als ein Index. Der Aufrufer reicht die Klasse durch; ohne
      // Angabe gelten die globalen Werte.
      const risk = resolveRisk(strategy.engine, req.assetClass ?? null);
      const position: Position = {
        symbol: req.symbol,
        qty,
        avgEntry: eff,
        stopLoss: risk.stopLossPct > 0 ? eff * (1 - risk.stopLossPct / 100) : null,
        takeProfit: risk.takeProfitPct > 0 ? eff * (1 + risk.takeProfitPct / 100) : null,
        openedAt: now,
        highWater: eff, // Startpunkt des nachziehenden Stops
        ...(req.bucket ? { bucket: req.bucket } : {}),
        ...(req.core ? { core: true } : {}),
        // Beim Broker wirklich vorhanden? Entscheidet spaeter ueber Routing
        // des Exits und ueber den Abgleich (siehe Position.broker).
        ...(req.brokerOrderId ? { broker: true, brokerOrderId: req.brokerOrderId } : {}),
      };
      const trade: Trade = {
        symbol: req.symbol,
        side: 'buy',
        qty,
        price: eff,
        executedAt: now,
        source: req.source,
        paper: true,
      };
      tx.set(posRef, position);
      // `borrowed` steht am Trade, damit im Nachhinein nachvollziehbar ist,
      // welcher Einstieg auf Kredit lief — im Kontostand allein ist das
      // später nicht mehr auseinanderzuhalten.
      tx.set(tradeRef, {
        ...trade,
        at: Timestamp.now(),
        rawPrice: req.price,
        ...herkunft,
        fee: kosten(qty),
        ...(borrowed > 0 ? { borrowed } : {}),
      });
      // Auf Cent runden (Audit 26.07.): Ohne das sammelt der Float-Rest jedes
      // Trades im Kontostand an — nach vielen Zyklen driftet er sichtbar.
      tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - cost), 'wallet.updatedAt': now });
      return { executed: true, trade: { ...trade, id: tradeRef.id } };
    }

    // sell
    if (!posSnap.exists) {
      // Leerverkauf (Opt-in via openShort): Verkaufs-Signal ohne Position
      // eröffnet einen Short. Buchhaltung als 100-%-Margin: Der Cash sinkt
      // um qty×eff (Sicherheitsleistung) — so bläht der Leerverkaufs-Erlös
      // weder den Cash noch das Cash-Sizing auf, und beim Eindecken kommt
      // Margin + P&L zurück. Level gespiegelt: Stop ÜBER dem Einstand
      // (steigender Kurs = Verlust), Take darunter, lowWater fürs Trailing.
      if (!req.openShort) return { executed: false, reason: 'keine_position' };
      const cls = req.assetClass ?? classify(req.symbol);
      const fractional = cls === 'crypto';
      const qty = req.qty ?? sizeOrder(strategy, deckung, eff, fractional, req.margin, req.stopDistancePct, req.sizeFactor);
      if (mengeZuKlein(qty, fractional, echterFill)) {
        return { executed: false, reason: 'qty_unter_1' };
      }
      const margin = qty * eff;
      // Gleiche Deckungsprüfung wie beim Kauf: Der Short bindet Sicherheit,
      // und ob die aus Cash oder aus Kaufkraft kommt, entscheidet der Hebel.
      if (req.margin) {
        if (margin > req.margin.buyingPower + 1e-9) return { executed: false, reason: 'zu_wenig_kaufkraft' };
      } else if (margin > deckung) {
        return { executed: false, reason: 'zu_wenig_cash' };
      }
      const risk = resolveRisk(strategy.engine, cls);
      const position: Position = {
        symbol: req.symbol,
        qty,
        avgEntry: eff,
        side: 'short',
        stopLoss: risk.stopLossPct > 0 ? eff * (1 + risk.stopLossPct / 100) : null,
        takeProfit: risk.takeProfitPct > 0 ? eff * (1 - risk.takeProfitPct / 100) : null,
        openedAt: now,
        lowWater: eff, // Startpunkt des Short-Trailings
        ...(req.bucket ? { bucket: req.bucket } : {}),
        ...(req.brokerOrderId ? { broker: true, brokerOrderId: req.brokerOrderId } : {}),
      };
      const trade: Trade & { short: boolean } = {
        symbol: req.symbol,
        side: 'sell',
        qty,
        price: eff,
        executedAt: now,
        source: req.source,
        paper: true,
        short: true,
      };
      tx.set(posRef, position);
      tx.set(tradeRef, { ...trade, at: Timestamp.now(), rawPrice: req.price, ...herkunft, fee: kosten(qty) });
      tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - margin), 'wallet.updatedAt': now });
      return { executed: true, trade: { ...trade, id: tradeRef.id } };
    }
    const pos = posSnap.data() as Position;
    if (pos.side === 'short') return { executed: false, reason: 'short_nachverkauf_verboten' };
    const { menge: qty, rest, ganz } = schlussMenge(pos.qty, req.qty);
    const proceeds = qty * eff;
    const pnl = (eff - pos.avgEntry) * qty;
    const trade: Trade & { pnl: number; riskExit?: string; teilSchluss?: true } = {
      symbol: req.symbol,
      side: 'sell',
      qty,
      ...(ganz ? {} : { teilSchluss: true as const }),
      price: eff,
      executedAt: now,
      source: req.source,
      paper: true,
      pnl: Math.round(pnl * 100) / 100,
      ...(req.riskExit ? { riskExit: req.riskExit } : {}),
      ...(pos.bucket ? { bucket: pos.bucket } : {}),
    };
    if (ganz) tx.delete(posRef);
    else tx.update(posRef, { qty: rest });
    tx.set(tradeRef, {
      ...trade,
      at: Timestamp.now(),
      rawPrice: req.price,
      ...herkunft,
      fee: kosten(qty),
      ...(ganz ? {} : { restMenge: rest }),
      ...anschaffung(pos, now),
    });
    tx.update(userRef, { 'wallet.paperBalance': roundCents(balance + proceeds), 'wallet.updatedAt': now });
    return { executed: true, trade: { ...trade, id: tradeRef.id } };
  }).then(async (result) => {
    // Lernstatistik NACH der Geld-Transaktion (Trade-Filter 31.07.): Ein
    // geschlossener Trade mit Steckbrief zählt in meta/tradeFilter. Bewusst
    // getrennt und fehlertolerant — eine Statistik, deren Ausfall einen
    // Verkauf verhindert, wäre die falsche Prioritätenordnung.
    const t = result.trade as
      | (Trade & { id: string; pnl?: number; bucket?: string; riskExit?: string; nachkauf?: boolean })
      | undefined;
    if (result.executed && t?.bucket && typeof t.pnl === 'number') {
      await recordFilterStat(t.bucket, t.pnl).catch(() => undefined);
    }
    /* Journal-Autoanlage (M12) — gleiche Prioritätenordnung wie die
     * Statistik darüber: nach der Geld-Transaktion, fehlertolerant, nie
     * handelsblockierend. Doc-ID = Trade-ID, damit Journal und Historie
     * ohne Suchlauf zueinanderfinden. Der Server legt die FAKTEN an; die
     * Review-Felder (notes/tags/mistakes/review) ergänzt später der User —
     * die Rules lassen ihn AUSSCHLIESSLICH diese vier Felder ändern. */
    if (result.executed && t) {
      await userRef
        .collection('journal')
        .doc(t.id)
        .set({
          at: t.executedAt,
          symbol: t.symbol,
          side: t.side,
          qty: t.qty,
          price: t.price,
          source: t.source,
          assetClass: req.assetClass ?? classify(req.symbol),
          // Ein Trade mit realisiertem P&L ist ein Ausstieg — auch der Cover.
          art: typeof t.pnl === 'number' ? 'exit' : 'entry',
          ...(typeof t.pnl === 'number' ? { pnl: t.pnl } : {}),
          ...(t.riskExit ? { riskExit: t.riskExit } : {}),
          // Einstiege tragen den Steckbrief nur am Request (er wandert in die
          // Position), Ausstiege am Trade — beides landet hier.
          ...(t.bucket ?? req.bucket ? { bucket: t.bucket ?? req.bucket } : {}),
          ...(t.nachkauf ? { nachkauf: true } : {}),
          ...(req.signalContext ? { signalContext: req.signalContext } : {}),
        })
        .catch((err: unknown) => logger.warn(`journal ${req.uid} ${t.id} nicht schreibbar`, err));
    }
    return result;
  });
}

/**
 * Ein geschlossener Trade → globale Steckbrief-Statistik (meta/tradeFilter).
 *
 * GLOBAL statt je User (Owner-Direktive 28.07.: „das Tool soll sich als
 * Gesamtes verbessern"): Aggregat-Zähler ohne Konto-Bezug, dafür füllen
 * sich die Steckbriefe über alle Konten in Tagen statt Wochen. FieldPath-
 * Segmente, weil die Schlüssel '|' und '+' enthalten — als String-Pfad
 * würde Firestore daran scheitern (gleiche Falle wie bei den Kombi-Keys).
 */
async function recordFilterStat(bucket: string, pnl: number): Promise<void> {
  const ref = getFirestore().doc('meta/tradeFilter');
  await ref.set({}, { merge: true });
  await ref.update(
    new FieldPath('updatedAt'),
    new Date().toISOString(),
    new FieldPath('buckets', bucket, 'n'),
    FieldValue.increment(1),
    new FieldPath('buckets', bucket, 'wins'),
    FieldValue.increment(pnl > 0 ? 1 : 0),
    new FieldPath('buckets', bucket, 'pnlSum'),
    FieldValue.increment(Math.round(pnl * 100) / 100),
    new FieldPath('buckets', bucket, 'pnlSqSum'),
    FieldValue.increment(Math.round(pnl * pnl * 100) / 100),
  );
}

/**
 * Stop-Loss/Take-Profit einer offenen Position prüfen (Port von _check_risk).
 * Liefert den Exit-Grund oder null.
 *
 * Engine-Audit 26.07. (MA1) — zwei Härtungen gegenüber dem Port:
 *  1. Die beim Kauf gespeicherten LEVEL der Position haben Vorrang vor den
 *     heutigen Prozenten. Sonst verschiebt eine Settings-Änderung rückwirkend
 *     die Stops aller offenen Positionen, während die UI die alten Level zeigt.
 *  2. Prozentwert ≤ 0 heißt „diese Seite ist AUS" (wie `null` beim Level) —
 *     vorher feuerte takeProfitPct = 0 wegen `change >= 0` bei jedem
 *     Nicht-Verlust sofort, stopLossPct = 0 analog bei jedem Minus.
 */
export interface RiskExitContext {
  /** Effektive Risiko-Parameter (klassen-aufgelöst, MA6). */
  risk: RiskConfig;
  /** ATR in Prozent des Kurses — für volatilitätsadaptive Stops. */
  atrPct?: number | null | undefined;
  /** Bezugszeitpunkt (Testbarkeit); Default: jetzt. */
  now?: Date;
}

export function riskExitReason(
  pos: Position,
  price: number,
  strategyOrCtx: Strategy | RiskExitContext,
): string | null {
  if (!(pos.avgEntry > 0) || !(price > 0)) return null;

  // Aufruf mit Strategy (Altpfad) oder mit aufgelöstem Kontext (MA6)
  const ctx: RiskExitContext =
    'engine' in strategyOrCtx
      ? { risk: resolveRisk(strategyOrCtx.engine, null) }
      : strategyOrCtx;
  const r = ctx.risk;
  const now = ctx.now ?? new Date();

  const level = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const pct = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  // Schwellen mit Toleranz vergleichen: `92/100 - 1` ergibt in Gleitkomma
  // -0.07999999999999996 und verfehlt einen 8-%-Stop damit knapp. Wer 8 %
  // einstellt, will bei exakt 8 % raus — nicht bei 8,0000001 %.
  const atMost = (v: number, limit: number): boolean => v <= limit + Math.abs(limit) * 1e-9 + 1e-12;
  const atLeast = (v: number, limit: number): boolean => v >= limit - Math.abs(limit) * 1e-9 - 1e-12;

  // ATR-Stops haben Vorrang vor festen Prozenten: Ein 2-%-Stop ist bei BTC
  // Rauschen, bei einem Index ein echtes Signal. atrPct kommt aus den Bars.
  const atrOk = typeof ctx.atrPct === 'number' && Number.isFinite(ctx.atrPct) && ctx.atrPct > 0;
  const stopPct = atrOk && pct(r.atrStopMult) > 0 ? pct(r.atrStopMult) * (ctx.atrPct as number) : pct(r.stopLossPct);
  const takePct = atrOk && pct(r.atrTakeMult) > 0 ? pct(r.atrTakeMult) * (ctx.atrPct as number) : pct(r.takeProfitPct);
  const trailPct = pct(r.trailingStopPct);

  if (pos.side === 'short') {
    // SHORT-Spiegelung (Owner 26.07.): Verlust bei STEIGENDEM Kurs.
    // 1) Trailing über lowWater — sichert Gewinne, sobald der Kurs unter
    //    dem Einstand war; Exit, wenn er vom Tief wieder hochläuft.
    if (trailPct > 0) {
      const trough = level(pos.lowWater);
      if (trough !== null && trough < pos.avgEntry && atLeast(price, trough * (1 + trailPct / 100))) {
        return 'trailing_stop';
      }
    }
    // 2) Stop ÜBER dem Einstand: Level vor Prozent
    const sLevel = level(pos.stopLoss);
    if (sLevel !== null) {
      if (atLeast(price, sLevel)) return 'stop_loss';
    } else if (stopPct > 0 && atLeast(price / pos.avgEntry - 1, stopPct / 100)) {
      return 'stop_loss';
    }
    // 3) Take UNTER dem Einstand: Level vor Prozent
    const tLevel = level(pos.takeProfit);
    if (tLevel !== null) {
      if (atMost(price, tLevel)) return 'take_profit';
    } else if (takePct > 0 && atMost(price / pos.avgEntry - 1, -takePct / 100)) {
      return 'take_profit';
    }
  } else {
    // 1) Nachziehender Stop — SICHERT GEWINNE, ersetzt aber nicht den festen
    // Stop. Er greift deshalb erst, wenn die Position im Plus war (Höchstkurs
    // über dem Einstand); solange sie nie im Gewinn stand, ist allein der
    // feste bzw. ATR-Stop zuständig. Ohne diese Trennung würde ein enger
    // Trailing-Wert ein bewusst weit gesetztes Stop-Level überstimmen.
    if (trailPct > 0) {
      const peak = level(pos.highWater) ?? 0;
      if (peak > pos.avgEntry && atMost(price, peak * (1 - trailPct / 100))) return 'trailing_stop';
    }

    // 2) Fester Stop: gespeichertes Level schlägt den Prozentwert
    const stopLevel = level(pos.stopLoss);
    if (stopLevel !== null) {
      if (atMost(price, stopLevel)) return 'stop_loss';
    } else if (stopPct > 0 && atMost(price / pos.avgEntry - 1, -stopPct / 100)) {
      return 'stop_loss';
    }

    // 3) Take-Profit: ebenso Level vor Prozent
    const takeLevel = level(pos.takeProfit);
    if (takeLevel !== null) {
      if (atLeast(price, takeLevel)) return 'take_profit';
    } else if (takePct > 0 && atLeast(price / pos.avgEntry - 1, takePct / 100)) {
      return 'take_profit';
    }
  }

  // 4) Zeitgrenze: eine ewig seitwärts laufende Position bindet Kapital
  const maxDays = pct(r.maxHoldDays);
  if (maxDays > 0) {
    const opened = Date.parse(pos.openedAt);
    if (Number.isFinite(opened) && now.getTime() - opened >= maxDays * 86_400_000) return 'max_hold';
  }

  return null;
}

/**
 * Höchstzahl Tage, die eine einzelne Abrechnung nachholt.
 *
 * Ohne Deckel würde ein Konto, dessen letzte Abrechnung Monate zurückliegt
 * (neues Feld, pausierter Scheduler, Wiederherstellung), auf einen Schlag mit
 * einem Jahreszins belastet. Der Fehler ginge dann zu Lasten des Users, und
 * zwar für ein Versäumnis auf unserer Seite.
 */
const MAX_INTEREST_CATCHUP_DAYS = 7;

/**
 * Margin-Zinsen für einen Tag buchen — der dritte Teil, ohne den Hebel eine
 * Schönfärberei wäre (margin.ts, Modul-Kopf).
 *
 * Idempotent über `wallet.marginInterestDate`: Ein zweiter Lauf am selben Tag
 * bucht nichts. Läuft transaktional, weil der Scan parallel Trades schreibt —
 * lesen und schreiben dürfen hier nicht auseinanderfallen.
 *
 * Verzinst wird der NEGATIVE Cash, nicht der Positionswert: Geliehen ist
 * genau der Betrag, den das Konto über sein Bargeld hinaus ausgegeben hat.
 * Ein Konto mit positivem Cash zahlt nichts, auch wenn Hebel erlaubt ist.
 */
export async function accrueMarginInterest(
  uid: string,
  day: string,
  annualRate = DEFAULT_MARGIN_RATE,
): Promise<number> {
  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return 0;
    const balance = snap.get('wallet.paperBalance') as number | undefined;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) return 0;
    const last = snap.get('wallet.marginInterestDate') as string | undefined;
    if (last === day) return 0; // heute schon abgerechnet

    const borrowed = Math.max(0, -balance);
    // Auch ohne Schuld das Datum fortschreiben: Sonst sammelt ein Konto, das
    // lange bar geführt wurde, eine riesige Lücke an und zahlt beim ersten
    // Kredit rückwirkend für Tage ohne Kredit.
    let days = 1;
    if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
      const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
      if (Number.isFinite(diff) && diff > 0) days = Math.min(MAX_INTEREST_CATCHUP_DAYS, diff);
      else days = 0; // Datum in der Zukunft/kaputt ⇒ nichts buchen
    }
    const zins = days > 0 ? marginInterest(borrowed, days, annualRate) : 0;
    tx.set(
      userRef,
      {
        wallet: {
          marginInterestDate: day,
          ...(zins > 0
            ? {
                paperBalance: roundCents(balance - zins),
                marginInterestTotal: FieldValue.increment(zins),
                updatedAt: new Date().toISOString(),
              }
            : {}),
        },
      },
      { merge: true },
    );
    return zins;
  });
}

/** Tages-Quota (admin/quotas/{uid}) transaktional erhöhen; false = Limit erreicht. */
export async function consumeQuota(uid: string, kind: string, dailyLimit: number): Promise<boolean> {
  const db = getFirestore();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.doc(`admin/quotas-${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = `${kind}_${day}`;
    const used = (snap.get(key) as number | undefined) ?? 0;
    if (used >= dailyLimit) return false;
    tx.set(ref, { [key]: FieldValue.increment(1) }, { merge: true });
    return true;
  });
}
