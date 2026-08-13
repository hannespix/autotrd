/**
 * Alpaca-Anbindung: echte Orders statt Buchungen im eigenen Depot (M13/M14).
 *
 * Owner-Auftrag 04.08.: „ich hätte gerne heute noch eine fertige echtgeld
 * trade Möglichkeit."
 *
 * ── Warum Alpaca zuerst und nicht Kraken oder Bitvavo ─────────────────────
 *
 * Weil Alpaca als einziger Anbieter ein Papierkonto mit DERSELBEN API
 * betreibt wie das Echtgeldkonto. Nur die Basis-URL unterscheidet sich. Damit
 * lässt sich die komplette Kette — Schlüssel, Order-Format, Abgleich,
 * Fehlerbehandlung — gegen ein echtes Konto verifizieren, ohne einen Cent zu
 * riskieren. Bei einem Anbieter ohne Papierkonto wäre der erste echte Test
 * zugleich der erste echte Verlust.
 *
 * ── Die Guards, und warum es drei sind ────────────────────────────────────
 *
 * 1. `resolveBrokerMode` (broker.ts): `broker.mode === 'live'`, env
 *    `ALPACA_ALLOW_LIVE === '1'` UND eine bestandene Live-Reife. Drei
 *    Bedingungen an drei verschiedenen Orten — ein verirrter Klick in der
 *    Oberfläche reicht nicht, ein versehentlich gesetztes Env auch nicht,
 *    und ein defizitäres System schon gar nicht.
 * 2. `vorflugkontrolle()` (hier): prüft VOR jeder Order den Kontozustand am
 *    echten Endpunkt. Sie fängt die Fälle, die kein Flag kennt — gesperrtes
 *    Konto, zu große Order, fehlende Deckung, falsches Schlüsselpaar.
 * 3. `clientOrderId()` (hier): Idempotenz. Cloud Functions laufen bei einem
 *    Fehler erneut an. Ohne stabile Order-Kennung sendet ein Retry eine
 *    ZWEITE echte Order — mit Papiergeld ein Schönheitsfehler, mit echtem
 *    Geld eine doppelte Position, die niemand wollte.
 *
 * Diese Guards werden nie gelockert. Wer hier etwas vereinfachen will, sollte
 * vorher ausrechnen, was der Fehlerfall kostet.
 *
 * ── Schlüssel: zwei Quellen, streng getrennt ──────────────────────────────
 *
 * PAPIER (`PK…`): Der Nutzer verbindet sein eigenes Alpaca-Papierkonto über
 * die App (`connectBroker`). Die Schlüssel liegen unter
 * `users/{uid}/private/broker` — eine Sammlung, die die Firestore-Regeln für
 * JEDEN Client sperren; nur das Admin-SDK der Functions kommt heran. Das ist
 * vertretbar, weil an einem Papierkonto kein Geld hängt.
 *
 * ECHTGELD (`AK…`): NUR aus der Umgebung (Secret Manager). Über die App
 * eingegebene Echtgeld-Schlüssel werden ABGELEHNT (`schluesselArt`). Damit
 * bleibt der Weg zum echten Geld einer, an den keine Oberfläche und kein
 * kompromittiertes Nutzerkonto herankommt.
 *
 * Und für beide gilt: nie im Log, nie in einer Fehlermeldung.
 * `keineSchluesselImText()` putzt Ausnahmen, bevor sie irgendwo landen — eine
 * Alpaca-Fehlermeldung enthält im Zweifel den gesendeten Header.
 */

import { logger } from 'firebase-functions/v2';
import { allSymbols, classify } from '../../../shared/src/index.js';
import type { BrokerMode } from './broker.js';

/** Endpunkte. Nur diese beiden — kein konfigurierbares Feld, kein Tippfehler. */
const BASIS: Record<BrokerMode, string> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
};

export function alpacaBasis(mode: BrokerMode): string {
  return BASIS[mode];
}

/**
 * Ein Alpaca-Schlüsselpaar.
 *
 * Bewusst ein WERT, der herumgereicht wird, statt eines env-Zugriffs mitten
 * im Code: Seit dem 04.08. gibt es zwei Quellen — das Papierkonto, das der
 * Nutzer selbst in der App verbindet, und das Echtgeldkonto des Betreibers
 * aus der Umgebung. Welche gilt, entscheidet der Aufrufer; die Funktionen
 * hier wissen davon nichts.
 */
export interface AlpacaSchluessel {
  keyId: string;
  secret: string;
}

/**
 * Präfix eines Alpaca-Schlüssels: `PK…` = Papierkonto, `AK…` = Echtgeld.
 *
 * Diese Unterscheidung ist die Grundlage dafür, dass die App gefahrlos
 * Schlüssel entgegennehmen darf: Über die Oberfläche kommen NUR
 * Papier-Schlüssel herein (siehe `connectBroker`). Ein Echtgeld-Schlüssel
 * wird abgelehnt — er gehört in die Umgebung, an die keine Oberfläche
 * herankommt.
 */
export function schluesselArt(keyId: string): 'paper' | 'live' | 'unbekannt' {
  const k = keyId.trim().toUpperCase();
  if (k.startsWith('PK')) return 'paper';
  if (k.startsWith('AK')) return 'live';
  return 'unbekannt';
}

/** Schlüsselpaar des BETREIBERS aus der Umgebung; null, wenn nicht gesetzt. */
export function envSchluessel(): AlpacaSchluessel | null {
  const keyId = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  return keyId && secret ? { keyId, secret } : null;
}

/** Sind überhaupt Schlüssel in der Umgebung hinterlegt? */
export function alpacaKonfiguriert(): boolean {
  return envSchluessel() !== null;
}

/**
 * Höchstanteil des Kontos, den EINE Order beanspruchen darf.
 *
 * Kein Risikomanagement — das steht in der Engine. Das hier ist eine
 * Tippfehler-Bremse: Eine Order über die Hälfte des Kontos ist bei einer
 * Strategie, die auf zweistellige Positionszahlen ausgelegt ist, kein
 * gewollter Trade, sondern ein verrutschtes Komma.
 */
export const MAX_ORDER_ANTEIL = 0.5;

/* ── Symbolschreibweise: Katalog ↔ Alpaca ─────────────────────────────────
 *
 * Der Katalog führt Krypto in der yfinance-Schreibweise (`BTC-USD`), weil von
 * dort die Kurse kommen. Alpaca schreibt dieselbe Münze `BTC/USD`. Ohne
 * Übersetzung ging jede Krypto-Order mit einem Symbol raus, das der Broker
 * nicht kennt — sie wäre abgelehnt worden, und zwar erst bei ihm.
 *
 * Die Abbildung gehört an DIESE Grenze und nirgendwo sonst: Katalog, Engine,
 * Charts und Buchhaltung sprechen durchgehend Katalog-Schreibweise, nur die
 * Broker-Aufrufe übersetzen — hin beim Senden, zurück beim Lesen. Täte man
 * es weiter innen, hätte man zwei Schreibweisen im Bestand und der
 * Broker-Abgleich meldete Phantom-Positionen („BTC/USD beim Broker,
 * BTC-USD bei uns").
 *
 * Die Endungen sind bewusst aufgezählt statt „alles mit Bindestrich": US-
 * Ticker enthalten Bindestriche (BF-B, BRK-B), und die dürfen nicht zu
 * Krypto-Paaren umgedeutet werden.
 *
 * ── Anteilsklassen: der zweite Fall derselben Sache (10.08.) ──────────────
 *
 * Krypto ist nicht die einzige Stelle, an der die beiden Häuser dasselbe
 * Papier verschieden schreiben. Bei Aktien mit mehreren Anteilsklassen
 * trennt Yahoo (und damit unser Katalog) mit Bindestrich, Alpaca mit Punkt:
 * `BRK-B` hier, `BRK.B` dort. Der Katalog führt genau ein solches Papier —
 * Berkshire B — und es war damit über den Broker-Pfad tot: Die Vorprüfung
 * fragte `/v2/assets/BRK-B`, bekam 404 und blockierte den Einstieg als
 * „kennt Alpaca nicht". Korrekt gehandelt, aber aus dem falschen Grund;
 * handelbar ist das Papier sehr wohl.
 *
 * Die Regel ist bewusst eng gefasst: Basis aus höchstens vier Zeichen, dann
 * GENAU EIN Buchstabe. Das trifft Anteilsklassen (BRK-B, BF-B, PBR-A) und
 * lässt alles andere in Ruhe. Zwei-Zeichen-Endungen sind nämlich ein ganz
 * anderes Feld: Bezugsrechte, Warrants und Units (`ABC.WS`, `ABC.RT`)
 * folgen bei Yahoo eigenen Regeln (`-WT`, `-RT`), die sich NICHT durch
 * Zeichentausch ineinander überführen lassen. Solche Papiere übersetzen wir
 * lieber gar nicht: Dann meldet der Abgleich sie als Fremdbestand — sichtbar
 * und unangetastet — statt sie unter einem erfundenen Namen zu handeln.
 */
const KRYPTO_GEGEN = ['USD', 'USDT', 'USDC', 'BTC'] as const;
const ZU_ALPACA = new RegExp(`^([A-Z0-9]{2,10})-(${KRYPTO_GEGEN.join('|')})$`);
const VON_ALPACA = new RegExp(`^([A-Z0-9]{2,10})/(${KRYPTO_GEGEN.join('|')})$`);
/**
 * Krypto hat bei Alpaca ZWEI Schreibweisen, und die Rückrichtung braucht
 * beide (belegt in Alpacas eigener Hilfe, „Why am I seeing BTCUSD after I
 * bought BTC/USD?"): Bestellt wird das PAAR `BTC/USD`, im Bestand steht dann
 * der HALTEWERT `BTCUSD` — ohne Trennzeichen.
 *
 * Ohne diese Zeile trifft uns genau die Falle, gegen die die Übersetzung
 * angetreten ist: Wir buchen `BTC-USD`, der Abgleich liest `BTCUSD` und
 * meldet für EINE Position zwei Abweichungen — einen Fehlbestand und einen
 * Fremdbestand. Und ein Fehlbestand sperrt Einstiege.
 *
 * Die kompakte Form ist bewusst NICHT frei geraten („alles was auf USD
 * endet"): Sie wird nur akzeptiert, wenn sie sich zu einem Krypto-Symbol
 * unseres Katalogs auflöst. Ein Aktienticker, der zufällig auf eine
 * Gegenwährung endet, würde sonst zu einem Währungspaar umgedeutet, das es
 * nicht gibt.
 */
const KOMPAKT_ZURUECK = new Map<string, string>(
  allSymbols()
    .filter((s) => classify(s) === 'crypto')
    .map((s) => [s.replace('-', ''), s]),
);
/**
 * Anteilsklasse: kurze Basis + `A`, `B` oder `C` (`BRK-B` ↔ `BRK.B`).
 *
 * Die Einschränkung auf drei Buchstaben ist keine Vorsicht, sondern eine
 * Notwendigkeit — gefunden beim Aufbau des Alpaca-Universums (11.08.):
 * `ABC.U` (Unit) und `ABC.W` (Warrant) haben exakt dieselbe Form wie eine
 * Anteilsklasse, meinen aber etwas ganz anderes, und Yahoo schreibt sie
 * `-UN` bzw. `-WT`. Ein allgemeines „ein Buchstabe" hätte sie zu `ABC-U`
 * und `ABC-W` gemacht: Symbole, die es nirgends gibt.
 *
 * A, B und C decken die real vorkommenden Anteilsklassen ab; alles andere
 * bleibt unangetastet und fällt damit sichtbar durch — was bei einer
 * Schreibweise, die wir nicht sicher beherrschen, die richtige Antwort ist.
 */
const KLASSE_ZU = /^([A-Z]{1,4})-([ABC])$/;
const KLASSE_VON = /^([A-Z]{1,4})\.([ABC])$/;

/** Katalog-Schreibweise → Alpaca (`BTC-USD` → `BTC/USD`, `BRK-B` → `BRK.B`). */
export function zuAlpacaSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const krypto = ZU_ALPACA.exec(s);
  if (krypto) return `${krypto[1]}/${krypto[2]}`;
  const klasse = KLASSE_ZU.exec(s);
  if (klasse) return `${klasse[1]}.${klasse[2]}`;
  return symbol;
}

/** Alpaca → Katalog (`BTC/USD` und `BTCUSD` → `BTC-USD`, `BRK.B` → `BRK-B`). */
export function vonAlpacaSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const krypto = VON_ALPACA.exec(s);
  if (krypto) return `${krypto[1]}-${krypto[2]}`;
  const kompakt = KOMPAKT_ZURUECK.get(s);
  if (kompakt) return kompakt;
  const klasse = KLASSE_VON.exec(s);
  if (klasse) return `${klasse[1]}-${klasse[2]}`;
  return symbol;
}

export interface AlpacaKonto {
  id: string;
  status: string;
  currency: string;
  cash: number;
  equity: number;
  buyingPower: number;
  /** Alpaca sperrt Konten z. B. bei offenen Einzahlungsproblemen. */
  tradingBlocked: boolean;
  accountBlocked: boolean;
  /** Wurde das Muster-Daytrader-Limit gerissen? */
  patternDayTrader: boolean;
  /**
   * Konto-Eröffnung (ISO, `created_at`) — der ehrliche Anker der
   * Order-Historie (Owner-Wunsch 13.08.: Historie ohne 30-Tage-Deckel).
   * Vor der Eröffnung kann es keine Orders geben; weiter zurückzufragen
   * ist sinnlos, früher aufzuhören verliert Historie. Leer, wenn Alpaca
   * das Feld nicht liefert — der Aufrufer fällt dann auf sein bisheriges
   * Fenster zurück.
   */
  createdAt: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  seite: 'long' | 'short';
  einstand: number;
}

/** Fehler der Anbindung — nie mit Schlüsseln im Text (s. Modulkopf). */
export class AlpacaFehler extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(keineSchluesselImText(message));
    this.name = 'AlpacaFehler';
  }
}

/**
 * Schlüssel aus einem Text entfernen.
 *
 * Defensiv und nicht optional: Eine Fehlermeldung des Anbieters kann den
 * gesendeten Header enthalten, und Fehlermeldungen landen im Log, in
 * Firestore und im Browser. Ein Schlüssel, der einmal in einem Log steht,
 * ist verbrannt.
 */
export function keineSchluesselImText(text: string, extra?: AlpacaSchluessel): string {
  let t = text;
  const alle = [
    process.env.ALPACA_API_KEY,
    process.env.ALPACA_SECRET_KEY,
    extra?.keyId,
    extra?.secret,
  ];
  for (const k of alle) {
    if (k && k.length >= 8) t = t.split(k).join('«entfernt»');
  }
  return t;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function alpacaFetch(
  mode: BrokerMode,
  pfad: string,
  schluessel: AlpacaSchluessel | null,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const k = schluessel ?? envSchluessel();
  if (!k) {
    throw new AlpacaFehler('Keine Alpaca-Schlüssel hinterlegt');
  }
  let res: Response;
  try {
    res = await fetchImpl(`${alpacaBasis(mode)}${pfad}`, {
      ...init,
      /* Hartes Timeout (Audit 13.08., K-2c): Ohne Signal hing ein POST bis
       * zum Function-Timeout — und dann war UNBEKANNT, ob die Order platziert
       * wurde, während der nächste Scan längst erneut kaufte. 15 s sind für
       * jede Alpaca-Antwort großzügig; ein Abbruch ist hier die ehrlichere
       * Antwort als ein Lauf, der stirbt. Ein vom Aufrufer mitgegebenes
       * Signal hat Vorrang. */
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        'APCA-API-KEY-ID': k.keyId,
        'APCA-API-SECRET-KEY': k.secret,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    throw new AlpacaFehler(keineSchluesselImText(`Netzwerkfehler: ${(e as Error).message}`, k));
  }
  const text = await res.text();
  if (!res.ok) {
    throw new AlpacaFehler(
      keineSchluesselImText(`HTTP ${res.status}: ${text.slice(0, 300)}`, k),
      res.status,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AlpacaFehler(keineSchluesselImText(`Unlesbare Antwort: ${text.slice(0, 200)}`, k));
  }
}

const zahl = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Konto am Endpunkt des ANGEGEBENEN Modus abfragen.
 *
 * Das ist zugleich die Prüfung, ob das Schlüsselpaar zum Modus gehört:
 * Papier-Schlüssel scheitern am Echtgeld-Endpunkt und umgekehrt. Eine
 * Verwechslung fällt damit auf, bevor eine Order rausgeht — und nicht,
 * nachdem sie im falschen Depot gelandet ist.
 */
export async function alpacaKonto(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaKonto> {
  const d = (await alpacaFetch(mode, '/v2/account', schluessel, {}, fetchImpl)) as Record<
    string,
    unknown
  >;
  return {
    id: String(d['id'] ?? ''),
    status: String(d['status'] ?? ''),
    currency: String(d['currency'] ?? 'USD'),
    cash: zahl(d['cash']),
    equity: zahl(d['equity']),
    buyingPower: zahl(d['buying_power']),
    tradingBlocked: d['trading_blocked'] === true,
    accountBlocked: d['account_blocked'] === true,
    patternDayTrader: d['pattern_day_trader'] === true,
    createdAt: typeof d['created_at'] === 'string' ? d['created_at'] : '',
  };
}

/** Eine ausgeführte, geschlossene Order — Rohmaterial der Depot-Übernahme. */
export interface AlpacaGeschlosseneOrder {
  id: string;
  /** Unsere eigene Kennung (`clientOrderId()`) — verrät uid UND Lauf. */
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  /** Mittlerer Ausführungskurs. */
  kurs: number;
  /** Zeitpunkt der (letzten) Ausführung, ISO. */
  filledAt: string;
}

/**
 * Geschlossene Orders mit Ausführung abrufen (Depot-Übernahme, 05.08.).
 *
 * Der Anlass ist der Vorfall vom 05.08.: Die Engine hat beim Broker real
 * gekauft, und das Buch wurde danach geleert („Neu anfangen" löscht das
 * Buch, aber kein Reset der Welt löscht ein Broker-Depot). Die Orders sind
 * die einzige Quelle, aus der sich die HISTORIE zurückgewinnen lässt —
 * `/v2/positions` kennt nur den Bestand, nicht die Käufe dahinter.
 *
 * Nur Orders MIT Ausführung kommen zurück: Eine stornierte Order ist für
 * Buch und Steuer ein Nicht-Ereignis. Aufsteigend sortiert, damit der
 * Import chronologisch bucht — FIFO im Steuerbericht hängt daran.
 */
export async function alpacaOrdersGeschlossen(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel | null = null,
  seitIso: string,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaGeschlosseneOrder[]> {
  const out: AlpacaGeschlosseneOrder[] = [];
  // PAGINIERT (Audit 06.08.): Alpaca deckelt bei 500 Orders je Antwort, und
  // „closed" enthält auch stornierte — die zählen gegen den Deckel, obwohl
  // sie unten rausfallen. 14 Tage 5-min-Handel überschreiten 500 locker; eine
  // einzelne Seite hätte dann still Historie verloren (Steuer/FIFO-Lücken).
  // Cursor ist das submitted_at der letzten Zeile (after = exklusiv danach);
  // Orders mit IDENTISCHEM Zeitstempel an der Seitengrenze können dabei
  // theoretisch übersprungen werden — akzeptiert und dokumentiert, die
  // Alternative (id-Paginierung) bietet die API nicht.
  let after = seitIso;
  // 10 → 40 Seiten (13.08.): Seit der Anker die KONTO-ERÖFFNUNG ist statt
  // „vor 30 Tagen", muss der Deckel die volle Historie tragen — die
  // 5-Minuten-Ära allein produzierte Hunderte Orders je Woche (inklusive
  // Stornos, die gegen die 500 je Seite zählen). 40 × 500 = 20.000 Orders
  // bei ~12 s Laufzeit. Reicht auch das nicht, sagt der Log es unten
  // ausdrücklich, statt still abzuschneiden.
  let abgeschnitten = false;
  const SEITEN_MAX = 40;
  for (let seite = 0; seite < SEITEN_MAX; seite++) {
    const d = (await alpacaFetch(
      mode,
      `/v2/orders?status=closed&after=${encodeURIComponent(after)}&direction=asc&limit=500`,
      schluessel,
      {},
      fetchImpl,
    )) as unknown[];
    if (!Array.isArray(d) || d.length === 0) break;
    if (seite === SEITEN_MAX - 1 && d.length === 500) abgeschnitten = true;
    let letzteSubmitted = '';
    for (const o of d) {
      const r = o as Record<string, unknown>;
      const submitted = String(r['submitted_at'] ?? '');
      if (submitted > letzteSubmitted) letzteSubmitted = submitted;
      const qty = zahl(r['filled_qty']);
      const kurs = zahl(r['filled_avg_price']);
      const filledAt = String(r['filled_at'] ?? '');
      // Ohne Menge, Kurs oder Zeitpunkt ist es keine Ausführung — nicht raten.
      if (!(qty > 0) || !(kurs > 0) || filledAt.length === 0) continue;
      out.push({
        id: String(r['id'] ?? ''),
        clientOrderId: String(r['client_order_id'] ?? ''),
        symbol: vonAlpacaSymbol(String(r['symbol'] ?? '')),
        side: String(r['side'] ?? '') === 'sell' ? ('sell' as const) : ('buy' as const),
        qty,
        kurs,
        filledAt,
      });
    }
    if (d.length < 500 || letzteSubmitted.length === 0 || letzteSubmitted === after) break;
    after = letzteSubmitted;
  }
  if (abgeschnitten) {
    // Kein stilles Abschneiden: Ein FIFO-Steuerbericht auf halber Historie
    // sieht aus wie ein ganzer — der Unterschied muss im Log stehen.
    logger.warn(
      `alpacaOrdersGeschlossen: Seitendeckel (${SEITEN_MAX * 500}) erreicht — Historie vor ${after} unvollständig`,
    );
  }
  // Chronologisch nach FILL sortieren: Die Seiten kommen nach submitted_at,
  // gebucht wird nach filled_at — FIFO im Steuerbericht hängt daran.
  return out.sort((a, b) => (a.filledAt < b.filledAt ? -1 : a.filledAt > b.filledAt ? 1 : 0));
}

/** Eine offene Order beim Broker — für die Schutz-Übernahme beim Adopt. */
export interface AlpacaOffeneOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** Alpaca-Ordertyp ('stop', 'market', 'limit', …). */
  typ: string;
  qty: number;
  /** Auslösekurs bei Stop-Orders; 0 sonst. */
  stopPreis: number;
}

/**
 * Offene Orders abrufen (Audit 06.08.): Die Depot-Übernahme muss WISSEN,
 * welche Schutz-Stops bereits beim Broker liegen — sonst verliert das Buch
 * beim Adopt die `schutz`-Verknüpfung, der alte GTC-Stop bleibt als Waise
 * stehen, reserviert die Stücke und blockiert jeden Exit (Storno-vor-Exit
 * storniert nur die Order, die das Buch kennt).
 */
export async function alpacaOrdersOffen(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaOffeneOrder[]> {
  const d = (await alpacaFetch(
    mode,
    '/v2/orders?status=open&limit=500',
    schluessel,
    {},
    fetchImpl,
  )) as unknown[];
  if (!Array.isArray(d)) return [];
  return d.flatMap((o) => {
    const r = o as Record<string, unknown>;
    const qty = zahl(r['qty']);
    if (!(qty > 0)) return [];
    return [
      {
        id: String(r['id'] ?? ''),
        clientOrderId: String(r['client_order_id'] ?? ''),
        symbol: vonAlpacaSymbol(String(r['symbol'] ?? '')),
        side: String(r['side'] ?? '') === 'sell' ? ('sell' as const) : ('buy' as const),
        typ: String(r['type'] ?? ''),
        qty,
        stopPreis: zahl(r['stop_price']),
      },
    ];
  });
}

/** Offene Positionen beim Broker — Grundlage des Abgleichs. */
export async function alpacaPositionen(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaPosition[]> {
  const d = (await alpacaFetch(mode, '/v2/positions', schluessel, {}, fetchImpl)) as unknown[];
  if (!Array.isArray(d)) return [];
  return d.map((p) => {
    const r = p as Record<string, unknown>;
    const qty = zahl(r['qty']);
    return {
      symbol: vonAlpacaSymbol(String(r['symbol'] ?? '')),
      // Alpaca liefert Short-Mengen negativ; das Vorzeichen steckt bei uns
      // in `seite`, damit Mengen nie versehentlich subtrahiert werden.
      qty: Math.abs(qty),
      seite: String(r['side'] ?? '') === 'short' || qty < 0 ? 'short' : 'long',
      einstand: zahl(r['avg_entry_price']),
    };
  });
}

/** Antwort von `/v2/clock` — die Börsen-Uhr des Brokers (Alpaca-Sync Punkt 2). */
export interface AlpacaUhrAblesung {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}

/**
 * Die US-Börsen-Uhr ablesen. Kennt Feiertage und Halbtage — unsere eigene
 * Kalenderrechnung (`usEquityOpen`) kennt beides nicht.
 */
export async function alpacaUhr(
  mode: BrokerMode,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaUhrAblesung> {
  const d = (await alpacaFetch(mode, '/v2/clock', schluessel, {}, fetchImpl)) as Record<
    string,
    unknown
  >;
  return {
    isOpen: d['is_open'] === true,
    nextOpen: String(d['next_open'] ?? ''),
    nextClose: String(d['next_close'] ?? ''),
  };
}

/**
 * Handels-Eigenschaften eines Papiers, wie der BROKER sie kennt (Alpaca-Sync,
 * 05.08. — MILESTONES „Weitere Alpaca-Synchronisierung", Punkt 1).
 */
export interface AlpacaAsset {
  symbol: string;
  tradable: boolean;
  /** Bruchstücke erlaubt? Wir haben das bisher GERATEN (`klasse === 'crypto'`). */
  fractionable: boolean;
  /** Leihbar für Leerverkäufe? Bisher erfuhren wir das erst per abgelehnter Order. */
  shortable: boolean;
  easyToBorrow: boolean;
  marginable: boolean;
}

/**
 * Eigenschaften eines Symbols abfragen.
 *
 * `null` heißt „Alpaca kennt dieses Symbol nicht" (404) — das ist bei uns
 * ein normaler Fall, kein Fehler: Der Katalog enthält Indizes, Forex und
 * Futures, die Alpaca gar nicht führt. Alle ANDEREN Fehler werfen weiter,
 * damit der Aufrufer Netzwerkprobleme nicht mit „gibt es nicht" verwechselt
 * und fälschlich cached.
 */
export async function alpacaAsset(
  mode: BrokerMode,
  symbol: string,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaAsset | null> {
  let d: Record<string, unknown>;
  try {
    d = (await alpacaFetch(
      mode,
      `/v2/assets/${encodeURIComponent(zuAlpacaSymbol(symbol))}`,
      schluessel,
      {},
      fetchImpl,
    )) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AlpacaFehler && err.status === 404) return null;
    throw err;
  }
  return {
    symbol: vonAlpacaSymbol(String(d['symbol'] ?? symbol)),
    tradable: d['tradable'] === true,
    fractionable: d['fractionable'] === true,
    shortable: d['shortable'] === true,
    easyToBorrow: d['easy_to_borrow'] === true,
    marginable: d['marginable'] === true,
  };
}

/**
 * Stabile Order-Kennung gegen Doppelausführung.
 *
 * Alpaca weist eine `client_order_id` zurück, die es schon kennt — ein Retry
 * derselben Order läuft damit ins Leere statt in eine zweite Position.
 *
 * ── Warum `laufId` und keine Uhrzeit ──────────────────────────────────────
 *
 * Der erste Entwurf leitete die Kennung aus einem Zeitfenster ab
 * (`floor(jetzt / 60s)`). Ein Test führte vor, warum das nicht trägt: Zwei
 * Aufrufe 30 Sekunden auseinander landen in verschiedenen Fenstern, sobald
 * eine Fenstergrenze dazwischen liegt. Ein Retry eine Sekunde nach so einer
 * Grenze hätte eine neue Kennung bekommen — und eine ZWEITE echte Order
 * gesendet. Genau der Fall, gegen den die Kennung schützen soll.
 *
 * Deshalb hängt sie jetzt an der logischen Einheit statt an der Uhr: Alle
 * Orders eines Scans tragen dessen `scanId`, ein Handeingabe-Trade seine
 * eigene Kennung. Derselbe Lauf ⇒ dieselbe Kennung, egal wann er wiederholt
 * wird; ein neuer Lauf ⇒ neue Kennung, auch eine Millisekunde später.
 */
export function clientOrderId(
  uid: string,
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  laufId: string,
): string {
  const roh = `${uid}-${symbol}-${side}-${qty}-${laufId}`;
  // Alpaca erlaubt maximal 128 Zeichen und keine Sonderzeichen. Der Lauf
  // steht am ENDE und würde beim Kürzen zuerst verloren gehen — deshalb wird
  // bei Überlänge der Nutzer-Teil gekappt, nicht der Lauf.
  const sauber = roh.replace(/[^A-Za-z0-9-]/g, '_');
  if (sauber.length <= 128) return sauber;
  const schwanz = `${symbol}-${side}-${qty}-${laufId}`.replace(/[^A-Za-z0-9-]/g, '_');
  return `${uid.replace(/[^A-Za-z0-9-]/g, '_').slice(0, Math.max(0, 127 - schwanz.length))}-${schwanz}`.slice(
    0,
    128,
  );
}

export interface Vorflugbefund {
  ok: boolean;
  /** Klartext-Gründe, warum NICHT gehandelt wird — leer, wenn ok. */
  gruende: string[];
  konto: AlpacaKonto;
}

/**
 * Prüfung unmittelbar VOR einer Order, gegen den echten Kontozustand.
 *
 * Bewusst ALLE Gründe sammeln statt beim ersten abzubrechen: Wer eine Order
 * nicht loswird, will wissen, was alles im Weg steht — sonst behebt er einen
 * Punkt, versucht es erneut und läuft in den nächsten.
 */
export function vorflugkontrolle(
  konto: AlpacaKonto,
  order: { symbol: string; side: 'buy' | 'sell'; qty: number; preis: number },
  opts: { maxAnteil?: number } = {},
): Vorflugbefund {
  const gruende: string[] = [];
  const volumen = order.qty * order.preis;
  const maxAnteil = opts.maxAnteil ?? MAX_ORDER_ANTEIL;

  if (konto.accountBlocked) gruende.push('Konto ist gesperrt (account_blocked)');
  if (konto.tradingBlocked) gruende.push('Handel ist gesperrt (trading_blocked)');
  if (konto.status !== 'ACTIVE') gruende.push(`Kontostatus ist „${konto.status}", nicht ACTIVE`);
  if (!(order.qty > 0)) gruende.push('Menge ist null oder negativ');
  if (!(order.preis > 0)) gruende.push('Kurs ist null oder negativ');

  if (konto.equity > 0 && volumen > konto.equity * maxAnteil) {
    gruende.push(
      `Order über ${volumen.toFixed(2)} ${konto.currency} beansprucht mehr als ` +
        `${Math.round(maxAnteil * 100)} % des Kontos (${konto.equity.toFixed(2)}) — ` +
        'sieht nach Tippfehler aus',
    );
  }
  // Deckung nur beim Kauf prüfen: Ein Verkauf LÖST Kapital, und ein
  // Leerverkauf hat seine eigene Sicherheitsleistung beim Broker.
  if (order.side === 'buy' && volumen > konto.buyingPower) {
    gruende.push(
      `Kaufkraft reicht nicht: ${volumen.toFixed(2)} benötigt, ` +
        `${konto.buyingPower.toFixed(2)} verfügbar`,
    );
  }
  return { ok: gruende.length === 0, gruende, konto };
}

export interface OrderErgebnis {
  id: string;
  clientOrderId: string;
  status: string;
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  /** Von Alpaca gemeldeter Durchschnittskurs; 0, solange nicht ausgeführt. */
  ausfuehrungskurs: number;
}

/**
 * Order absenden — Market-Order, `day`-Gültigkeit.
 *
 * Warum Market und nicht Limit: Die Engine entscheidet auf Basis eines
 * gerade geholten Kurses und will die Position JETZT. Eine Limit-Order, die
 * nicht ausgeführt wird, hinterlässt ein Depot, das nicht dem eigenen Buch
 * entspricht — und genau diese Abweichung ist die teuerste Fehlerquelle
 * einer Broker-Anbindung. Lieber ein paar Basispunkte Slippage (die die
 * Kostenrechnung ohnehin einkalkuliert) als ein stiller Auseinanderlauf.
 */
export async function alpacaOrder(
  mode: BrokerMode,
  order: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    clientOrderId: string;
  },
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<OrderErgebnis> {
  const d = (await alpacaFetch(
    mode,
    '/v2/orders',
    schluessel,
    {
      method: 'POST',
      body: JSON.stringify({
        symbol: zuAlpacaSymbol(order.symbol),
        qty: String(order.qty),
        side: order.side,
        type: 'market',
        time_in_force: 'day',
        client_order_id: order.clientOrderId,
      }),
    },
    fetchImpl,
  )) as Record<string, unknown>;
  return {
    id: String(d['id'] ?? ''),
    clientOrderId: String(d['client_order_id'] ?? order.clientOrderId),
    status: String(d['status'] ?? ''),
    symbol: vonAlpacaSymbol(String(d['symbol'] ?? order.symbol)),
    qty: zahl(d['qty']),
    side: order.side,
    ausfuehrungskurs: zahl(d['filled_avg_price']),
  };
}

/**
 * Schutz-Stop-Order absenden (Bracket Stufe 1, 06.08.) — `type: stop`,
 * `gtc`-Gültigkeit.
 *
 * `gtc` und nicht `day`, mit Absicht: Der Schutz-Stop ist das
 * Sicherheitsnetz ZWISCHEN den Scans und über Nacht — eine `day`-Order
 * verfiele um Börsenschluss, und die Lücke, die sie schließen soll, wäre
 * jede Nacht wieder offen. Bruchstück-Mengen akzeptiert Alpaca bei
 * Stop-Orders nicht; das Runden auf ganze Stücke entscheidet der Aufrufer
 * (`planeSchutzStop`), nicht diese Funktion.
 */
export async function alpacaStopOrder(
  mode: BrokerMode,
  order: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    stopPreis: number;
    clientOrderId: string;
  },
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<OrderErgebnis> {
  const d = (await alpacaFetch(
    mode,
    '/v2/orders',
    schluessel,
    {
      method: 'POST',
      body: JSON.stringify({
        symbol: zuAlpacaSymbol(order.symbol),
        qty: String(order.qty),
        side: order.side,
        type: 'stop',
        stop_price: String(order.stopPreis),
        time_in_force: 'gtc',
        client_order_id: order.clientOrderId,
      }),
    },
    fetchImpl,
  )) as Record<string, unknown>;
  return {
    id: String(d['id'] ?? ''),
    clientOrderId: String(d['client_order_id'] ?? order.clientOrderId),
    status: String(d['status'] ?? ''),
    symbol: vonAlpacaSymbol(String(d['symbol'] ?? order.symbol)),
    qty: zahl(d['qty']),
    side: order.side,
    ausfuehrungskurs: zahl(d['filled_avg_price']),
  };
}

/** Zustand einer einzelnen Order — Grundlage der Schutz-Stop-Pflege. */
export interface AlpacaOrderStand {
  id: string;
  status: string;
  /** Bereits ausgeführte Menge (bei Teilausführung < Order-Menge). */
  filledQty: number;
  /** Mittlerer Ausführungskurs; 0, solange nichts ausgeführt ist. */
  filledAvgPreis: number;
}

/**
 * Eine Order abfragen. `null` heißt: Alpaca kennt sie nicht (404) — nach
 * einem Konto-Reset beim Broker oder wenn die Kennung aus einer anderen
 * Umgebung stammt. Der Aufrufer behandelt das wie „Order weg" und legt
 * den Schutz neu an; alle anderen Fehler werfen weiter.
 */
export async function alpacaOrderAbfragen(
  mode: BrokerMode,
  orderId: string,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaOrderStand | null> {
  let d: Record<string, unknown>;
  try {
    d = (await alpacaFetch(
      mode,
      `/v2/orders/${encodeURIComponent(orderId)}`,
      schluessel,
      {},
      fetchImpl,
    )) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AlpacaFehler && err.status === 404) return null;
    throw err;
  }
  return {
    id: String(d['id'] ?? orderId),
    status: String(d['status'] ?? ''),
    filledQty: zahl(d['filled_qty']),
    filledAvgPreis: zahl(d['filled_avg_price']),
  };
}

/**
 * Order über ihre CLIENT-Kennung wiederfinden (Audit 13.08., K-2e).
 *
 * Die client_order_id ist bei Alpaca dauerhaft eindeutig je Konto — genau
 * darauf baut unsere Idempotenz. Die Kehrseite: Lehnte Alpaca einen
 * Wiederholungsversuch mit 422 „duplicate" ab, konnte bisher niemand
 * nachsehen, was aus der ERSTEN Order geworden ist. Ein Exit mit
 * positionsstabiler Kennung (`exit-<openedAt>`) blieb dann für immer
 * verklemmt: jede Wiederholung 422, der Fill der Ur-Order nie gebucht.
 * Diese Funktion ist das fehlende Gegenstück — nachschlagen statt raten.
 */
export async function alpacaOrderPerClientId(
  mode: BrokerMode,
  clientOrderId: string,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaOrderStand | null> {
  let d: Record<string, unknown>;
  try {
    d = (await alpacaFetch(
      mode,
      `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      schluessel,
      {},
      fetchImpl,
    )) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AlpacaFehler && err.status === 404) return null;
    throw err;
  }
  return {
    id: String(d['id'] ?? ''),
    status: String(d['status'] ?? ''),
    filledQty: zahl(d['filled_qty']),
    filledAvgPreis: zahl(d['filled_avg_price']),
  };
}

/**
 * Order stornieren — mit ehrlichem Befund statt Exception-Raten.
 *
 * `weg` (404) und `storniert` sind für den Aufrufer gleichwertig: Die Order
 * hält keine Stücke mehr fest. `nicht_stornierbar` (422) ist der wichtige
 * Fall — meist heißt es „schon ausgeführt", und der Aufrufer MUSS dann den
 * Order-Stand abfragen, bevor er selbst verkauft: Die Stücke sind unter
 * Umständen schon weg, ein eigener Verkauf würde einen ungewollten Short
 * eröffnen.
 */
export async function alpacaOrderStornieren(
  mode: BrokerMode,
  orderId: string,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<'storniert' | 'weg' | 'nicht_stornierbar'> {
  try {
    await alpacaFetch(
      mode,
      `/v2/orders/${encodeURIComponent(orderId)}`,
      schluessel,
      { method: 'DELETE' },
      fetchImpl,
    );
    return 'storniert';
  } catch (err) {
    if (err instanceof AlpacaFehler) {
      if (err.status === 404) return 'weg';
      if (err.status === 422) return 'nicht_stornierbar';
      // 204 ohne Body läuft bei uns in den JSON-Parse-Fehler — die Order IST
      // dann storniert. Erkennbar am fehlenden HTTP-Status im Fehler.
      if (err.status === undefined && err.message.includes('Unlesbare Antwort')) {
        return 'storniert';
      }
    }
    throw err;
  }
}

/**
 * Stop-Preis einer offenen Order ersetzen (Trailing-Nachziehen).
 *
 * Alpaca legt beim Ersetzen eine NEUE Order an — die zurückgegebene Kennung
 * ersetzt die alte im Positions-Dokument. Scheitert das Ersetzen, bleibt
 * die alte Order unverändert stehen: Der Schutz ist dann nur weiter weg
 * als gewollt, nie verschwunden.
 */
export async function alpacaOrderErsetzen(
  mode: BrokerMode,
  orderId: string,
  stopPreis: number,
  schluessel: AlpacaSchluessel | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const d = (await alpacaFetch(
    mode,
    `/v2/orders/${encodeURIComponent(orderId)}`,
    schluessel,
    { method: 'PATCH', body: JSON.stringify({ stop_price: String(stopPreis) }) },
    fetchImpl,
  )) as Record<string, unknown>;
  const neueId = String(d['id'] ?? '');
  if (!neueId) throw new AlpacaFehler('Ersetzen ohne neue Order-Kennung');
  return neueId;
}

/**
 * Auf die Ausführung warten, statt sie anzunehmen (M13).
 *
 * ── Warum das nötig ist ───────────────────────────────────────────────────
 *
 * `alpacaOrder` liefert die Order zurück, wie sie ANGENOMMEN wurde — bei
 * einer Market-Order steht dort meist `accepted` oder `pending_new`, und
 * `filled_avg_price` ist noch leer. Wer diesen Rückgabewert bucht, schreibt
 * einen Kurs von 0 ins Buch oder fällt auf die Schätzung zurück, die er
 * gerade ersetzen wollte.
 *
 * Market-Orders füllen in liquiden Märkten binnen Sekunden. „Meist" ist bei
 * Geld aber kein Argument: Außerhalb der Handelszeiten, bei Handelsstopps
 * oder in dünnen Büchern kann es dauern oder ganz ausbleiben.
 *
 * ── Was bei Zeitüberschreitung passiert ───────────────────────────────────
 *
 * Nichts wird gebucht. Die Order bleibt beim Broker stehen und wird beim
 * nächsten Abgleich sichtbar — als Position, die nur dort existiert. Genau
 * dafür ist der Abgleich da. Die Alternative wäre, eine unbestätigte
 * Ausführung ins Buch zu schreiben; dann stünde dort ein Trade, den es
 * vielleicht nie gab.
 */
export async function warteAufFill(
  mode: BrokerMode,
  orderId: string,
  schluessel: AlpacaSchluessel | null = null,
  opts: { versuche?: number; pauseMs?: number; schlaf?: (ms: number) => Promise<void> } = {},
  fetchImpl: FetchLike = fetch,
): Promise<OrderErgebnis | null> {
  const versuche = opts.versuche ?? 6;
  const pause = opts.pauseMs ?? 700;
  const schlaf = opts.schlaf ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let i = 0; i < versuche; i += 1) {
    const d = (await alpacaFetch(
      mode,
      `/v2/orders/${encodeURIComponent(orderId)}`,
      schluessel,
      {},
      fetchImpl,
    )) as Record<string, unknown>;
    const status = String(d['status'] ?? '');
    const kurs = zahl(d['filled_avg_price']);
    const menge = zahl(d['filled_qty']);

    // `filled` mit Kurs ist der Normalfall. `partially_filled` zählt
    // ebenfalls: Was ausgeführt IST, ist ausgeführt — der Rest steht in der
    // Menge, und der Abgleich fängt eine Abweichung auf.
    if ((status === 'filled' || status === 'partially_filled') && kurs > 0 && menge > 0) {
      return {
        id: String(d['id'] ?? orderId),
        clientOrderId: String(d['client_order_id'] ?? ''),
        status,
        symbol: vonAlpacaSymbol(String(d['symbol'] ?? '')),
        qty: menge,
        side: String(d['side'] ?? '') === 'sell' ? 'sell' : 'buy',
        ausfuehrungskurs: kurs,
      };
    }
    // Endzustände ohne Ausführung: weiter zu warten wäre sinnlos.
    if (['canceled', 'expired', 'rejected', 'suspended'].includes(status)) return null;
    if (i < versuche - 1) await schlaf(pause);
  }
  return null;
}

export interface Abweichung {
  symbol: string;
  eigeneMenge: number;
  brokerMenge: number;
  /** Positiv = wir buchen mehr, als beim Broker liegt. */
  differenz: number;
}

/**
 * Eigenes Buch gegen die Broker-Positionen halten.
 *
 * Das ist die wichtigste laufende Kontrolle im Echtgeldbetrieb, und sie muss
 * BEIDE Richtungen prüfen: Eine Position, die nur beim Broker existiert, ist
 * genauso gefährlich wie eine, die nur im eigenen Buch steht — im ersten Fall
 * trägt man ein Risiko, von dem die Engine nichts weiß, im zweiten rechnet
 * die Engine mit einer Deckung, die es nicht gibt.
 *
 * Vorzeichenbehaftet verglichen: Ein Long von 10 und ein Short von 10 sind
 * nicht dasselbe, auch wenn die Menge übereinstimmt.
 */
/**
 * Nur die Positionen, die WIRKLICH über den Broker entstanden sind.
 *
 * Ohne diesen Filter meldet der Abgleich jede reine Buchungs-Position als
 * Fehlbestand — sie steht in unserem Buch, beim Broker aber nie. Und davon
 * gibt es reichlich: Positionen aus der Zeit vor dem Verbinden, Exits auf
 * Papier-Positionen (`broker.ts`), Verkäufe, die weder schließen noch ein
 * ausdrücklicher Leerverkauf sind — alles legitime Papier-Buchungen.
 *
 * Der geplante Abgleich (`brokerAbgleich.ts`) filterte so; die Broker-Karte
 * in der App (`brokerStatus.ts`) nicht. Dasselbe Konto war damit für die
 * Engine „sauber" und für den Nutzer „Abweichung" — ein Alarm, den niemand
 * auflösen kann, weil nichts kaputt ist. Ein Warnzeichen, das immer leuchtet,
 * ist schlimmer als keins: Es macht blind für den echten Fall.
 *
 * Deshalb steht der Filter jetzt an EINER Stelle, und beide fragen ihn.
 */
export function nurBrokerPositionen<T extends { broker?: boolean | undefined }>(
  eigene: readonly T[],
): T[] {
  return eigene.filter((p) => p.broker === true);
}

/** Eine Position, wie beide Ansichten sie aus Firestore zusammenstellen. */
export interface BuchPosition {
  symbol: string;
  qty: number;
  side?: string | undefined;
  broker?: boolean | undefined;
}

/**
 * Der Abgleich, den BEIDE Ansichten benutzen: filtern, dann vergleichen.
 *
 * Warum das eine Funktion ist und nicht zwei Zeilen an zwei Stellen: Genau
 * so entstand der Fehler. Beide Seiten riefen `abgleich()`, eine filterte
 * vorher, die andere nicht — sichtbar erst als Widerspruch im Betrieb
 * (`drift: 2, sauber: 0` im Heartbeat bei einer makellosen Broker-Karte,
 * bzw. umgekehrt). Zwei Kompositionen sind zwei Wahrheiten; ein gemeinsamer
 * Filter allein verhindert das nicht, solange ihn jede Seite selbst
 * aufrufen muss.
 *
 * Wer `abgleich()` direkt ruft, umgeht den Filter — `functions/test/
 * brokerAbgleichEinheitlich.test.ts` hält deshalb zusätzlich fest, dass die
 * beiden Aufrufstellen hier hereingehen.
 */
export function bestandsAbgleich(
  eigene: readonly BuchPosition[],
  broker: readonly AlpacaPosition[],
): Abweichung[] {
  return abgleich(nurBrokerPositionen(eigene), broker);
}

export function abgleich(
  eigene: ReadonlyArray<{ symbol: string; qty: number; side?: string | undefined }>,
  broker: readonly AlpacaPosition[],
  toleranz = 1e-6,
): Abweichung[] {
  const vorzeichen = (qty: number, side?: string): number =>
    (side === 'short' ? -1 : 1) * Math.abs(qty);
  const mengen = new Map<string, { eigen: number; fremd: number }>();
  const eintrag = (sym: string): { eigen: number; fremd: number } => {
    const v = mengen.get(sym) ?? { eigen: 0, fremd: 0 };
    mengen.set(sym, v);
    return v;
  };
  for (const p of eigene) eintrag(p.symbol).eigen += vorzeichen(p.qty, p.side);
  for (const p of broker) eintrag(p.symbol).fremd += vorzeichen(p.qty, p.seite);

  const out: Abweichung[] = [];
  for (const [symbol, v] of mengen) {
    const differenz = v.eigen - v.fremd;
    if (Math.abs(differenz) > toleranz) {
      out.push({
        symbol,
        eigeneMenge: v.eigen,
        brokerMenge: v.fremd,
        differenz: Math.round(differenz * 1e6) / 1e6,
      });
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
