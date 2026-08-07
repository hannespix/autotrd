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
  sizeWithMargin,
} from '../../../shared/src/index.js';
import type {
  Position,
  ReifeBefund,
  RiskConfig,
  Strategy,
  Trade,
} from '../../../shared/src/index.js';
import { fxFelder } from './fx.js';
import { assetAuskunft, brokerVerbindung, routeOrder } from './orderRouting.js';
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

export type BrokerMode = 'paper' | 'live';

/**
 * Einzige Stelle, die den effektiven Broker-Modus bestimmt.
 *
 * DREI Bedingungen, alle nötig — jede eine eigene Fehlerquelle:
 *
 *  1. `strategy.broker.mode === 'live'` — der Schalter des Nutzers.
 *  2. env `ALPACA_ALLOW_LIVE === '1'` — die Freigabe des Betreibers, an einem
 *     Ort, an den keine Oberfläche herankommt.
 *  3. **Live-Reife** (seit 04.08.) — die Zahlen müssen es hergeben.
 *
 * Punkt 3 setzt die Owner-Maxime um: „so lange testen mit paper wallet wie
 * notwendig. bis man sicher nur noch Gewinn schreibt, dann erst den Schalter
 * umlegen, aber trotzdem schon theoretisch startklar sein." Der Schalter ist
 * jederzeit bedienbar — er greift nur nicht, solange die Messung dagegen
 * spricht.
 *
 * `reife` ist OPTIONAL, und zwar mit Bedacht in diese Richtung: Ein Aufrufer,
 * der die Kennzahlen nicht kennt, bekommt den bisherigen Doppel-Guard und
 * damit unverändertes Verhalten. Fehlende Kennzahlen dürfen nie dazu führen,
 * dass eine Prüfung stillschweigend WEGFÄLLT — sie können hier nur dazu
 * führen, dass eine dritte Prüfung nicht hinzukommt. Wer live handelt, reicht
 * sie durch (siehe `scanMarket`); wer nur den Modus anzeigt, nicht.
 */
export function resolveBrokerMode(strategy: Strategy, reife?: ReifeBefund): BrokerMode {
  const wantLive = strategy.broker.mode === 'live';
  if (!wantLive || process.env.ALPACA_ALLOW_LIVE !== '1') return 'paper';
  // Reife bekannt und negativ ⇒ Downgrade. Der Nutzer merkt es an der
  // Broker-Karte, nicht an einer stillen Überraschung im Kontoauszug.
  if (reife && !reife.bereit) return 'paper';
  return 'live';
}

/** Geldbeträge auf Cent runden — Float-Drift hat im Kontostand nichts zu suchen. */
function roundCents(v: number): number {
  return Math.round(v * 100) / 100;
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
  const asset = await assetAuskunft(verbindung, req.symbol);
  const eroeffnet = !schliesst;
  if (asset && eroeffnet) {
    if (!asset.tradable) return { executed: false, reason: 'broker_nicht_handelbar' };
    const wirdShort = req.side === 'sell';
    if (wirdShort && !asset.shortable) return { executed: false, reason: 'broker_nicht_shortbar' };
  }
  // Leerverkäufe verlangen bei Alpaca GANZE Stücke — fractionable gilt nur
  // für Long-Käufe und das Schließen fraktionaler Bestände (Short-Audit 07.08.).
  const fractional =
    (asset?.fractionable ?? (klasse === 'crypto')) && !(req.side === 'sell' && !schliesst);
  // Für die MENGE reicht der Schätzpreis: Er entscheidet über die Stückzahl,
  // nicht über den Buchwert. Der echte Kurs kommt gleich vom Broker zurück
  // und ersetzt ihn beim Buchen.
  const effSchaetzung = effectivePriceForClass(req.price, req.side, klasse);
  const qty = planeMenge(req, strategy, {
    balance,
    position,
    effPreis: effSchaetzung,
    fractional,
  });
  if (qty < (fractional ? 1e-6 : 1)) return { executed: false, reason: 'qty_unter_1' };

  const routing = await routeOrder(verbindung, {
    uid: req.uid,
    symbol: req.symbol,
    side: req.side,
    qty,
    laufId,
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
        laufId,
        grund: buchung.reason ?? 'unbekannt',
        at: new Date().toISOString(),
      })
      .catch((err: unknown) => logger.error(`unbookedFills ${req.uid} nicht schreibbar`, err));
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
      laufId,
    );
  }
  return buchung;
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
        const qty = pos.qty;
        const pnl = (pos.avgEntry - eff) * qty;
        const margin = qty * pos.avgEntry;
        const trade: Trade & { pnl: number; riskExit?: string; cover: boolean } = {
          symbol: req.symbol,
          side: 'buy',
          qty,
          price: eff,
          executedAt: now,
          source: req.source,
          paper: true,
          pnl: Math.round(pnl * 100) / 100,
          cover: true,
          ...(req.riskExit ? { riskExit: req.riskExit } : {}),
          ...(pos.bucket ? { bucket: pos.bucket } : {}),
        };
        tx.delete(posRef);
        tx.set(tradeRef, {
          ...trade,
          at: Timestamp.now(),
          rawPrice: req.price,
          ...herkunft,
          fee: kosten(qty),
          ...anschaffung(pos, now),
        });
        tx.update(userRef, { 'wallet.paperBalance': roundCents(balance + margin + pnl), 'wallet.updatedAt': now });
        return { executed: true, trade: { ...trade, id: tradeRef.id } };
      }
      if (posSnap.exists) {
        /* Nachkauf bleibt VERBOTEN — außer die Stücke liegen bereits im
         * Depot (Vorfall 05.08.). Ein bestätigter Fill ist ein Fait
         * accompli: Wer ihn ablehnt, macht die Order nicht ungeschehen,
         * er macht nur das Buch zum Lügner. Zwei parallele Läufe (Scan +
         * Momentum) können dasselbe Symbol füllen; der zweite Fill wird
         * dann in die bestehende Position EINGEMISCHT — gewichteter
         * Einstand, Stops neu vom gemischten Einstand. */
        if (!echterFill) return { executed: false, reason: 'position_existiert' };
        const pos = posSnap.data() as Position;
        if (pos.side === 'short') return { executed: false, reason: 'position_existiert' };
        const qty = req.qty ?? 0;
        if (!(qty > 0)) return { executed: false, reason: 'qty_unter_1' };
        const cost = qty * eff;
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
          broker: true,
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
        tx.set(tradeRef, { ...trade, at: Timestamp.now(), rawPrice: req.price, ...herkunft, fee: kosten(qty) });
        tx.update(userRef, { 'wallet.paperBalance': roundCents(balance - cost), 'wallet.updatedAt': now });
        return { executed: true, trade: { ...trade, id: tradeRef.id } };
      }
      const cls = req.assetClass ?? classify(req.symbol);
      const fractional = cls === 'crypto';
      const qty = req.qty ?? sizeOrder(strategy, balance, eff, fractional, req.margin, req.stopDistancePct, req.sizeFactor);
      if (qty < (fractional ? 1e-6 : 1)) return { executed: false, reason: 'qty_unter_1' };
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
        } else if (cost > balance) {
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
      const qty = req.qty ?? sizeOrder(strategy, balance, eff, fractional, req.margin, req.stopDistancePct, req.sizeFactor);
      if (qty < (fractional ? 1e-6 : 1)) return { executed: false, reason: 'qty_unter_1' };
      const margin = qty * eff;
      // Gleiche Deckungsprüfung wie beim Kauf: Der Short bindet Sicherheit,
      // und ob die aus Cash oder aus Kaufkraft kommt, entscheidet der Hebel.
      if (req.margin) {
        if (margin > req.margin.buyingPower + 1e-9) return { executed: false, reason: 'zu_wenig_kaufkraft' };
      } else if (margin > balance) {
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
    const qty = pos.qty;
    const proceeds = qty * eff;
    const pnl = (eff - pos.avgEntry) * qty;
    const trade: Trade & { pnl: number; riskExit?: string } = {
      symbol: req.symbol,
      side: 'sell',
      qty,
      price: eff,
      executedAt: now,
      source: req.source,
      paper: true,
      pnl: Math.round(pnl * 100) / 100,
      ...(req.riskExit ? { riskExit: req.riskExit } : {}),
      ...(pos.bucket ? { bucket: pos.bucket } : {}),
    };
    tx.delete(posRef);
    tx.set(tradeRef, {
      ...trade,
      at: Timestamp.now(),
      rawPrice: req.price,
      ...herkunft,
      fee: kosten(qty),
      ...anschaffung(pos, now),
    });
    tx.update(userRef, { 'wallet.paperBalance': roundCents(balance + proceeds), 'wallet.updatedAt': now });
    return { executed: true, trade: { ...trade, id: tradeRef.id } };
  }).then(async (result) => {
    // Lernstatistik NACH der Geld-Transaktion (Trade-Filter 31.07.): Ein
    // geschlossener Trade mit Steckbrief zählt in meta/tradeFilter. Bewusst
    // getrennt und fehlertolerant — eine Statistik, deren Ausfall einen
    // Verkauf verhindert, wäre die falsche Prioritätenordnung.
    const t = result.trade as (Trade & { pnl?: number; bucket?: string }) | undefined;
    if (result.executed && t?.bucket && typeof t.pnl === 'number') {
      await recordFilterStat(t.bucket, t.pnl).catch(() => undefined);
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
