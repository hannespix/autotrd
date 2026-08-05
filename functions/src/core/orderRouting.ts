/**
 * Order-Routing an Alpaca (M13) — die Schicht zwischen Entscheidung und Buch.
 *
 * ── Die Architekturentscheidung dahinter (05.08.) ─────────────────────────
 *
 * Es gibt nicht EINE Wahrheit, sondern zwei über verschiedene Dinge:
 *
 *   Alpaca ist die Wahrheit über den BESTAND — was liegt im Depot, wurde die
 *   Order gefüllt, zu welchem Kurs.
 *
 *   Das eigene Buch ist die Wahrheit über die ABSICHT — warum wurde gekauft,
 *   welcher Stop gilt, welcher Steckbrief, welcher EZB-Kurs war eingefroren,
 *   welche Strategie-Variante hat ausgelöst.
 *
 * Ein Broker-Datensatz kann die Absicht nicht speichern: `bucket`,
 * `riskExit`, `core`, `highWater`, `fxRate` existieren dort nicht und
 * müssten auch bei „Alpaca ist alleinige Wahrheit" in Firestore liegen —
 * dann hätte man wieder zwei Quellen, nur mit umgekehrter Zuständigkeit.
 *
 * Der Ausschlag gab aber ein anderes Argument: autotrd ist eine
 * Multi-User-PAPER-Plattform. Wäre der Broker die alleinige Wahrheit,
 * bräuchte jeder Nutzer ein eigenes Alpaca-Konto samt KYC, bevor er den
 * ersten simulierten Trade sieht. Das macht aus einer Plattform ein
 * Broker-Frontend.
 *
 * ── Woran die Entscheidung NICHT vorbeikommt ──────────────────────────────
 *
 * Wenn das Buch „10 Stück" sagt und der Broker „0", dann sind es null. Bei
 * Echtgeld ist das keine Meinungsverschiedenheit. Daraus folgt nicht, dass
 * der Broker führen muss — daraus folgt, dass das System einem Widerspruch
 * nicht ausweichen darf: Der Abgleich läuft bei JEDEM Scan, und eine
 * Abweichung sperrt Einstiege, statt eine Seite zu erraten.
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Kein Firestore-Schreibvorgang. Diese Datei sendet die Order, wartet auf
 * die Ausführung und gibt den echten Kurs zurück; gebucht wird danach im
 * Broker-Kern — außerhalb der Transaktion, aus demselben Grund wie beim
 * EZB-Kurs: Eine Firestore-Transaktion wird bei Konflikt WIEDERHOLT, ein
 * HTTP-Aufruf darin liefe mehrfach.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  alpacaOrder,
  clientOrderId,
  warteAufFill,
  type AlpacaSchluessel,
} from './alpacaBroker.js';
import type { BrokerMode } from './broker.js';
import { entschluessle } from './keyVault.js';

/** Verbindungsdaten eines Kontos, so wie `connectBroker` sie ablegt. */
export interface BrokerVerbindung {
  mode: BrokerMode;
  schluessel: AlpacaSchluessel;
}

/**
 * Kurzlebiger Prozess-Cache für die Verbindungsdaten.
 *
 * Ohne ihn liest ein Scan mit neun Trades neunmal dasselbe Dokument, dazu
 * einmal für den Abgleich — zehn identische Reads je Konto und Scan, alle
 * fünf Minuten. Das ist kein Detail: Firestore rechnet nach Reads ab, und
 * der Zähler läuft rund um die Uhr weiter, weil Krypto nie schließt.
 *
 * Die 60 Sekunden sind bewusst kurz. Zugangsdaten zu cachen heißt, mit
 * veralteten zu arbeiten: Wer die Verbindung trennt, will nicht, dass die
 * nächste Order trotzdem noch beim Broker landet. Eine Minute deckt genau
 * einen Scan-Durchlauf ab und ist danach vergessen. Der Cache lebt in der
 * Function-Instanz — ein Kaltstart beginnt ohnehin leer.
 */
const VERBINDUNG_TTL_MS = 60_000;
const verbindungCache = new Map<string, { bis: number; wert: BrokerVerbindung | null }>();

/** Cache verwerfen — beim Verbinden/Trennen, damit die Änderung sofort greift. */
export function vergissVerbindung(uid: string): void {
  verbindungCache.delete(uid);
}

/**
 * Darf überhaupt an einen Echtgeld-Endpunkt geordert werden?
 *
 * Nur die Betreiber-Freigabe, bewusst OHNE die anderen beiden Guards
 * (`broker.mode: live` je Konto, Live-Reife) — die prüft `resolveBrokerMode`
 * weiterhin an seiner Stelle. Hier geht es um die grobe Frage: Ist auf
 * diesem Server Echtgeld überhaupt eingeschaltet? Solange nein, sind alle
 * feineren Prüfungen gegenstandslos, und ein hinterlegter Live-Schlüssel
 * darf keinen einzigen Order-Pfad erreichen.
 */
function echtgeldFreigegeben(): boolean {
  return process.env.ALPACA_ALLOW_LIVE === '1';
}

/**
 * Verbindung eines Kontos laden — oder `null`, wenn keine hinterlegt ist.
 *
 * Die Sammlung `private/**` ist per Rules für JEDEN Client gesperrt; nur das
 * Admin-SDK liest hier. Ein fehlender Eintrag ist der Normalfall, kein
 * Fehler: Die allermeisten Konten handeln im eigenen Buch.
 *
 * ── Echtgeld-Verbindungen liefert diese Funktion NICHT aus ────────────────
 *
 * Seit dem 05.08. dürfen Echtgeld-Schlüssel in der App hinterlegt werden
 * (verschlüsselt, siehe `core/keyVault.ts`). Damit entsteht ein Weg, den es
 * vorher nicht gab: Ein `AK…`-Schlüssel im Dokument würde hier zu
 * `mode: 'live'` — und `routeOrder` schickte die nächste Order an den
 * ECHTGELD-Endpunkt, ohne dass jemand etwas scharf geschaltet hätte.
 *
 * Deshalb gibt diese Funktion, die ausschließlich das ORDER-Routing bedient,
 * bei einer Live-Verbindung `null` zurück, solange M14 verriegelt ist. Der
 * Trade läuft dann im eigenen Buch weiter — genau wie vorher.
 *
 * Für den LESENDEN Abgleich gibt es `brokerVerbindungLesend()`. Die Trennung
 * ist der ganze Punkt: „startklar, aber nicht scharf" heißt, das echte Depot
 * sehen zu können, ohne hineinzuhandeln.
 */
export async function brokerVerbindung(
  uid: string,
  jetztMs: number = Date.now(),
): Promise<BrokerVerbindung | null> {
  const v = await brokerVerbindungLesend(uid, jetztMs);
  if (!v) return null;
  if (v.mode === 'live' && !echtgeldFreigegeben()) {
    // Bewusst nur `debug`: Bei jedem Trade eines Kontos mit hinterlegtem
    // Live-Schlüssel wäre eine Warnung Lärm, der echte Warnungen zudeckt.
    logger.debug(`brokerVerbindung ${uid}: Echtgeld hinterlegt, Handel verriegelt`);
    return null;
  }
  return v;
}

/**
 * Dieselbe Verbindung — auch für Echtgeld, aber ausdrücklich nur zum LESEN.
 *
 * Aufrufer dieser Funktion dürfen `/v2/account` und `/v2/positions` abrufen.
 * Wer eine ORDER senden will, nimmt `brokerVerbindung()`. Der getrennte Name
 * ist die Absicherung: Ein künftiger Aufrufer muss sich aktiv für die
 * lesende Variante entscheiden, statt sie versehentlich zu erben.
 */
export async function brokerVerbindungLesend(
  uid: string,
  jetztMs: number = Date.now(),
): Promise<BrokerVerbindung | null> {
  const treffer = verbindungCache.get(uid);
  if (treffer && treffer.bis > jetztMs) return treffer.wert;
  try {
    const doc = await getFirestore().doc(`users/${uid}/private/broker`).get();
    const keyId = doc.get('keyId') as string | undefined;
    const gespeichert = doc.get('secretKey') as string | undefined;
    // Entschlüsseln (05.08.). `entschluessle` gibt Klartext-Altbestand
    // unverändert zurück und `null`, wenn ein Chiffrat nicht aufgeht —
    // falscher Hauptschlüssel oder manipulierte Daten. Beides darf nicht
    // als Zugangsdaten an einen Broker gehen.
    const secret = gespeichert ? entschluessle(gespeichert) : null;
    if (gespeichert && !secret) {
      logger.warn(`brokerVerbindung ${uid}: Geheimnis nicht entschlüsselbar`);
    }
    const wert: BrokerVerbindung | null =
      keyId && secret
        ? { mode: doc.get('mode') === 'live' ? 'live' : 'paper', schluessel: { keyId, secret } }
        : null;
    // Auch das NEGATIVE Ergebnis wird gemerkt: Konten ohne Broker sind der
    // Normalfall, und genau für sie wäre der Read je Trade reine Verschwendung.
    verbindungCache.set(uid, { bis: jetztMs + VERBINDUNG_TTL_MS, wert });
    return wert;
  } catch (err) {
    // Nicht lesbar heißt: nicht routen. Im eigenen Buch weiterhandeln ist
    // die sichere Richtung — eine Order zu senden, deren Konto man nicht
    // kennt, ist es nicht. Ein Fehler wird NICHT gecacht: Er kann vorübergehend
    // sein, und ein gemerkter Fehlschlag würde eine Minute lang jedes Routing
    // stillschweigend abschalten.
    logger.warn(`brokerVerbindung ${uid} nicht lesbar`, err);
    return null;
  }
}

export interface RoutingErgebnis {
  /** Wurde beim Broker ausgeführt? Nur dann darf gebucht werden. */
  ausgefuehrt: boolean;
  /** Echter Ausführungskurs — ersetzt die Schätzung im Buch. */
  fillPreis?: number;
  /** Tatsächlich ausgeführte Menge (kann bei Teilausführung kleiner sein). */
  fillMenge?: number;
  /** Order-Kennung beim Broker — die Brücke zwischen Buch und Depot. */
  brokerOrderId?: string;
  /** Klartext, falls nicht ausgeführt. Landet im Log, nicht im Buch. */
  grund?: string;
}

/**
 * Eine Order beim Broker platzieren und auf die Ausführung warten.
 *
 * Gibt `ausgefuehrt: false` zurück, wenn irgendetwas nicht stimmt — der
 * Aufrufer bucht dann NICHTS. Das ist die wichtige Richtung: Lieber ein
 * Trade, der im Buch fehlt und beim nächsten Abgleich auffällt, als einer,
 * der gebucht ist und nie stattgefunden hat.
 */
export async function routeOrder(
  verbindung: BrokerVerbindung,
  auftrag: {
    uid: string;
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    /** Lauf-Kennung (scanId) — bindet die Order-ID an den Lauf, nicht an die Uhr. */
    laufId: string;
  },
  fetchImpl: typeof fetch = fetch,
  warteOpts: { versuche?: number; pauseMs?: number } = {},
): Promise<RoutingErgebnis> {
  if (!(auftrag.qty > 0)) return { ausgefuehrt: false, grund: 'menge_null' };

  const coid = clientOrderId(
    auftrag.uid,
    auftrag.symbol,
    auftrag.side,
    auftrag.qty,
    auftrag.laufId,
  );
  try {
    const order = await alpacaOrder(
      verbindung.mode,
      { symbol: auftrag.symbol, side: auftrag.side, qty: auftrag.qty, clientOrderId: coid },
      verbindung.schluessel,
      fetchImpl,
    );
    if (!order.id) return { ausgefuehrt: false, grund: 'keine_order_id' };

    const fill = await warteAufFill(
      verbindung.mode,
      order.id,
      verbindung.schluessel,
      warteOpts,
      fetchImpl,
    );
    if (!fill || !(fill.ausfuehrungskurs > 0)) {
      // Die Order steht möglicherweise weiter beim Broker. Sie wird beim
      // nächsten Abgleich als Position sichtbar, die nur dort existiert —
      // und sperrt dann die Einstiege, bis jemand hinsieht.
      return { ausgefuehrt: false, grund: 'kein_fill' };
    }
    return {
      ausgefuehrt: true,
      fillPreis: fill.ausfuehrungskurs,
      fillMenge: fill.qty > 0 ? fill.qty : auftrag.qty,
      brokerOrderId: order.id,
    };
  } catch (err) {
    // Die Fehlermeldung kann die Antwort des Brokers enthalten; sie geht
    // durch `keineSchluesselImText` in alpacaFetch, bevor sie hier ankommt.
    const text = err instanceof Error ? err.message : String(err);
    logger.warn(`routeOrder ${auftrag.symbol} ${auftrag.side}: ${text.slice(0, 200)}`);
    return { ausgefuehrt: false, grund: 'broker_fehler' };
  }
}
