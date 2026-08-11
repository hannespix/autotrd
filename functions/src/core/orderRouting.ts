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
  alpacaAsset,
  alpacaOrder,
  clientOrderId,
  warteAufFill,
  type AlpacaAsset,
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
 * Owner-Kill-Switch (M14): `meta/live.killSwitch` friert ALLE
 * Echtgeld-Order-Pfade ein — ein Klick im Admin-Panel, keine neue
 * Live-Order mehr, plattformweit.
 *
 * Warum zusätzlich zu `ALPACA_ALLOW_LIVE`: Die Env-Variable braucht ein
 * Deploy bzw. einen Secret-Rollout, um sich zu ändern — im Ernstfall
 * („die Engine kauft Unsinn, SOFORT stoppen") ist das zu langsam. Das
 * Firestore-Flag greift auf allen Instanzen binnen 60 s (Cache-TTL).
 *
 * Fail-CLOSED, bewusst nur hier: Wer den Schalter nicht LESEN kann, darf
 * nicht behaupten, er sei aus. Ein Firestore-Ausfall stoppt damit
 * Echtgeld-Orders — Paper-Routing und der lesende Abgleich sind nicht
 * betroffen, und das eigene Buch handelt ohnehin weiter. Die umgekehrte
 * Richtung (bei Lesefehler weiterhandeln) wäre die einzige Konstellation,
 * in der der Not-Aus genau dann versagt, wenn es brennt.
 */
const KILL_TTL_MS = 60_000;
let killCache: { bis: number; aktiv: boolean } | null = null;

/** Für Tests und den Admin-Schalter: Cache verwerfen. */
export function vergissKillSwitch(): void {
  killCache = null;
}

async function killSwitchAktiv(jetztMs: number = Date.now()): Promise<boolean> {
  if (killCache && killCache.bis > jetztMs) return killCache.aktiv;
  try {
    const aktiv = (await getFirestore().doc('meta/live').get()).get('killSwitch') === true;
    killCache = { bis: jetztMs + KILL_TTL_MS, aktiv };
    return aktiv;
  } catch (err) {
    logger.error('killSwitchAktiv: meta/live nicht lesbar — Echtgeld vorsorglich angehalten', err);
    killCache = { bis: jetztMs + KILL_TTL_MS, aktiv: true };
    return true;
  }
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
  if (v.mode === 'live') {
    if (!echtgeldFreigegeben()) {
      // Bewusst nur `debug`: Bei jedem Trade eines Kontos mit hinterlegtem
      // Live-Schlüssel wäre eine Warnung Lärm, der echte Warnungen zudeckt.
      logger.debug(`brokerVerbindung ${uid}: Echtgeld hinterlegt, Handel verriegelt`);
      return null;
    }
    if (await killSwitchAktiv(jetztMs)) {
      // `warn`, nicht `debug`: Der Kill-Switch ist ein Ausnahmezustand, und
      // jede unterbundene Order gehört ins Log — genau dafür ist er da.
      logger.warn(`brokerVerbindung ${uid}: Kill-Switch aktiv — Echtgeld-Order unterbunden`);
      return null;
    }
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
    // Gelesen heißt: kein Lesefehler mehr, egal was drinstand.
    unlesbar.delete(uid);
    return wert;
  } catch (err) {
    // Nicht lesbar heißt: nicht routen. Im eigenen Buch weiterhandeln ist
    // die sichere Richtung — eine Order zu senden, deren Konto man nicht
    // kennt, ist es nicht. Ein Fehler wird NICHT gecacht: Er kann vorübergehend
    // sein, und ein gemerkter Fehlschlag würde eine Minute lang jedes Routing
    // stillschweigend abschalten.
    logger.warn(`brokerVerbindung ${uid} nicht lesbar`, err);
    unlesbar.add(uid);
    return null;
  }
}

/**
 * Merkzettel für „beim letzten Lesen ging es schief".
 *
 * ── Wozu (Audit 11.08.) ───────────────────────────────────────────────────
 *
 * `brokerVerbindungLesend` gibt für ZWEI verschiedene Sachverhalte `null`
 * zurück: „dieses Konto hat keinen Broker" (der Normalfall) und „ich konnte
 * nicht nachsehen" (ein Problem). Für das Routing ist beides gleich — nicht
 * routen ist in beiden Fällen richtig, und deshalb war das lange kein Fehler.
 *
 * Für die MELDUNG ist es das Gegenteil. `brokerAbgleich.ts` macht aus dem
 * `null` ein `zustand: 'kein_broker'`, und sein eigener Modulkopf beschreibt
 * genau, warum das falsch ist:
 *
 *   „Ohne sie sähe ein Konto, dessen Broker seit Stunden nicht antwortet, im
 *    Heartbeat exakt so aus wie eines ganz ohne Broker."
 *
 * Der Fall, gegen den `AbgleichZustand.fehler` gebaut wurde, trat über den
 * Firestore-Pfad also trotzdem ein: Das Konto verschwand aus `verbunden`,
 * und niemand sah es.
 *
 * Bewusst ein Merkzettel und kein Rückgabewert: Die Altschnittstelle bleibt
 * damit unverändert (`null` = nicht routen), und die einzige Stelle, die den
 * Unterschied BRAUCHT, fragt ihn ab. Der Eintrag hält nur bis zur nächsten
 * erfolgreichen Lesung — ein vorübergehender Fehler darf nicht dauerhaft als
 * Problem gemeldet werden.
 */
const unlesbar = new Set<string>();

/** War die letzte Leseprüfung dieses Kontos ein FEHLER (statt „kein Broker")? */
export function verbindungUnlesbar(uid: string): boolean {
  return unlesbar.has(uid);
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

/**
 * Handels-Eigenschaften eines Symbols, wie Alpaca sie kennt — mit Cache
 * (Alpaca-Sync 05.08., MILESTONES „Weitere Alpaca-Synchronisierung" Punkt 1).
 *
 * Warum das überhaupt: Wir haben zwei Eigenschaften bisher GERATEN.
 * `fractionable` war „Klasse ist Krypto" — dabei erlaubt Alpaca Bruchstücke
 * für die meisten US-Aktien, und ein kleines Konto scheiterte bei uns an
 * „qty_unter_1", wo es beim Broker längst 0,4 Stück kaufen dürfte. Und ob
 * ein Papier LEIHBAR ist, erfuhren wir erst durch die abgelehnte
 * Short-Order — ein vermeidbarer Fehlversuch samt Log-Lärm.
 *
 * ── Cache-Aufbau ──────────────────────────────────────────────────────────
 *
 * Zwei Stufen, beide global statt je Nutzer — die Eigenschaften eines
 * Papiers sind für alle Konten identisch, es wäre Verschwendung, sie je uid
 * zu halten:
 *
 *   1. Prozess-Map (bis Kaltstart) — deckt die Trades EINES Scans ab.
 *   2. `meta/alpacaAssets` in Firestore, ein Feld je Symbol, 24 h gültig —
 *      deckt alle Instanzen und Kaltstarts ab. Eigenschaften ändern sich
 *      praktisch nie unterjährig; 24 h sind konservativ genug.
 *
 * Auch „Alpaca kennt das Symbol nicht" (404 → `bekannt: false`) wird
 * gemerkt: Der halbe Katalog (Indizes, Forex, Futures) existiert dort gar
 * nicht, und genau diese Symbole würden sonst täglich neu angefragt.
 * FEHLER (Netz, 5xx) werden dagegen NICHT persistiert — nur kurz in der
 * Prozess-Map, damit ein wackliger Moment nicht jeden Trade des Scans mit
 * einem eigenen Fehlversuch belastet.
 */
const ASSET_TTL_MS = 24 * 3_600_000;
const ASSET_FEHLER_TTL_MS = 5 * 60_000;

/**
 * Schreibweisen-Stand, unter dem ein Cache-Eintrag entstanden ist.
 *
 * ── Warum eine Antwort ablaufen kann, ohne alt zu sein (10.08.) ───────────
 *
 * `bekannt: false` heißt nicht „dieses Papier gibt es nicht", sondern „auf
 * DIESE Frage kam 404". Ändert sich die Frage — und genau das tut sie, wenn
 * `zuAlpacaSymbol` eine Schreibweise dazulernt —, dann beantwortet der alte
 * Eintrag eine Frage, die wir nicht mehr stellen.
 *
 * Ohne diesen Marker liefe der BRK-B-Fix ins Leere: Der Cache-Eintrag von
 * heute Nachmittag („BRK-B kennt Alpaca nicht", entstanden aus der Anfrage
 * `/v2/assets/BRK-B`) würde noch bis morgen jeden Einstieg blockieren,
 * obwohl die neue Anfrage längst `/v2/assets/BRK.B` lautet und Erfolg hätte.
 * Dieselbe Falle träfe die kompakte Krypto-Schreibweise.
 *
 * Die Nummer wird bei JEDER Änderung an der Symbolübersetzung erhöht.
 * Positive Einträge bleiben verwendbar — was Alpaca einmal kannte, kennt es
 * weiter; nur die Absagen sind an ihre Fragestellung gebunden.
 */
export const SCHREIBWEISE_V = 3;

/**
 * Was wir über ein Symbol beim Broker wissen — DREI Zustände, nicht zwei.
 *
 * Der Modulkopf sagt seit dem 05.08. „Fehler ≠ ‚gibt es nicht'", und der
 * Cache trennt beides auch. Die Rückgabe tat es nicht: `assetAuskunft` gab
 * für BEIDE Fälle `null`, und der Aufrufer fiel deshalb bei einem 404
 * genauso auf Schätzungen zurück wie bei einem Netzfehler — er schickte also
 * eine Eröffnungs-Order für ein Symbol los, von dem er bereits WUSSTE, dass
 * Alpaca es nicht führt. Die Ablehnung kam dann vom Broker.
 *
 *   `bekannt` — Alpaca kennt das Papier, Eigenschaften liegen vor.
 *   `fehlt`   — Alpaca antwortet 404. Eine Eröffnung hier ist zwecklos.
 *   `unklar`  — Netz oder 5xx. Keine Aussage; Metadaten dürfen den Handel
 *               verbessern, nie verhindern (Regel vom 05.08.).
 */
export type AssetStand =
  | { art: 'bekannt'; asset: AlpacaAsset }
  | { art: 'fehlt' }
  | { art: 'unklar' };

const assetCache = new Map<string, { bis: number; stand: AssetStand }>();

/** Für Tests: Prozess-Cache leeren. */
export function vergissAssets(): void {
  assetCache.clear();
}

/** Die Eigenschaften, oder `null` bei `fehlt`/`unklar` (Altschnittstelle). */
export async function assetAuskunft(
  verbindung: BrokerVerbindung,
  symbol: string,
  fetchImpl: typeof fetch = fetch,
  jetztMs: number = Date.now(),
): Promise<AlpacaAsset | null> {
  const stand = await assetStand(verbindung, symbol, fetchImpl, jetztMs);
  return stand.art === 'bekannt' ? stand.asset : null;
}

/**
 * Darf diese Order zum Broker? — als reine Funktion, damit sie prüfbar ist.
 *
 * Drei Regeln, in dieser Reihenfolge:
 *
 *  1. Kennt Alpaca das Symbol NICHT, wird nichts ERÖFFNET. Das ist eine
 *     Aussage des Brokers, kein fehlendes Wissen — die Order würde bei ihm
 *     abgelehnt, und zwar jedes Mal.
 *  2. SCHLIESSEN bleibt in jedem Fall erlaubt. Ein Bestand muss auch dann
 *     verkäuflich sein, wenn das Papier inzwischen delistet wurde; sonst
 *     säße man darin fest.
 *  3. Ist der Stand `unklar` (Netz, 5xx), entscheidet der Handel, nicht die
 *     Metadaten: Sie dürfen ihn verbessern, nie verhindern (Regel 05.08.).
 */
export function brokerVorpruefung(
  stand: AssetStand,
  opts: { eroeffnet: boolean; wirdShort: boolean },
): { ok: true } | { ok: false; grund: string } {
  if (!opts.eroeffnet) return { ok: true };
  if (stand.art === 'fehlt') return { ok: false, grund: 'broker_kennt_symbol_nicht' };
  if (stand.art === 'unklar') return { ok: true };
  if (!stand.asset.tradable) return { ok: false, grund: 'broker_nicht_handelbar' };
  if (opts.wirdShort && !stand.asset.shortable) {
    return { ok: false, grund: 'broker_nicht_shortbar' };
  }
  return { ok: true };
}

export async function assetStand(
  verbindung: BrokerVerbindung,
  symbol: string,
  fetchImpl: typeof fetch = fetch,
  jetztMs: number = Date.now(),
): Promise<AssetStand> {
  const treffer = assetCache.get(symbol);
  if (treffer && treffer.bis > jetztMs) return treffer.stand;

  const ref = getFirestore().doc('meta/alpacaAssets');

  // Stufe 2: Firestore. Ein Lesefehler ist kein Handelshindernis — dann
  // wird eben live gefragt oder (wenn auch das scheitert) geraten.
  try {
    const feld = (await ref.get()).get(symbol) as
      | { bekannt: boolean; at: string; v?: number; tradable?: boolean; fractionable?: boolean;
          shortable?: boolean; easyToBorrow?: boolean; marginable?: boolean }
      | undefined;
    // Eine Absage aus einer ÄLTEREN Schreibweise beantwortet eine Frage, die
    // wir nicht mehr stellen (s. SCHREIBWEISE_V). Zusagen bleiben gültig.
    const frisch = feld?.bekannt === true || (feld?.v ?? 1) >= SCHREIBWEISE_V;
    if (feld && frisch && jetztMs - Date.parse(feld.at) < ASSET_TTL_MS) {
      const stand: AssetStand = feld.bekannt
        ? {
            art: 'bekannt',
            asset: {
              symbol,
              tradable: feld.tradable === true,
              fractionable: feld.fractionable === true,
              shortable: feld.shortable === true,
              easyToBorrow: feld.easyToBorrow === true,
              marginable: feld.marginable === true,
            },
          }
        : { art: 'fehlt' };
      assetCache.set(symbol, { bis: jetztMs + ASSET_TTL_MS, stand });
      return stand;
    }
  } catch (err) {
    logger.warn(`assetAuskunft ${symbol}: Cache nicht lesbar`, err);
  }

  // Stufe 3: live beim Broker fragen.
  try {
    const wert = await alpacaAsset(verbindung.mode, symbol, verbindung.schluessel, fetchImpl);
    const stand: AssetStand = wert ? { art: 'bekannt', asset: wert } : { art: 'fehlt' };
    assetCache.set(symbol, { bis: jetztMs + ASSET_TTL_MS, stand });
    const at = new Date(jetztMs).toISOString();
    ref
      .set(
        {
          [symbol]: wert
            ? {
                bekannt: true,
                tradable: wert.tradable,
                fractionable: wert.fractionable,
                shortable: wert.shortable,
                easyToBorrow: wert.easyToBorrow,
                marginable: wert.marginable,
                at,
              }
            : { bekannt: false, at, v: SCHREIBWEISE_V },
        },
        { merge: true },
      )
      .catch((err: unknown) => logger.warn(`assetStand ${symbol}: Cache nicht schreibbar`, err));
    return stand;
  } catch (err) {
    // Fehler ≠ „gibt es nicht": kurz merken, NICHT persistieren, und als
    // `unklar` in die bisherigen Schätzungen zurückfallen.
    logger.warn(`assetStand ${symbol} fehlgeschlagen`, err);
    assetCache.set(symbol, { bis: jetztMs + ASSET_FEHLER_TTL_MS, stand: { art: 'unklar' } });
    return { art: 'unklar' };
  }
}
