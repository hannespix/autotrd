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
 * 1. `resolveBrokerMode` (broker.ts): `broker.mode === 'live'` UND env
 *    `ALPACA_ALLOW_LIVE === '1'`. Zwei Schalter an zwei verschiedenen Orten —
 *    ein verirrter Klick in der Oberfläche reicht nicht, und ein
 *    versehentlich gesetztes Env auch nicht.
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
 * ── Schlüssel ─────────────────────────────────────────────────────────────
 *
 * Nur aus der Umgebung (Secret Manager), nie aus Firestore, nie im Log, nie
 * in einer Fehlermeldung. `keineSchluesselImText()` putzt Ausnahmen, bevor
 * sie irgendwo landen — eine Alpaca-Fehlermeldung enthält im Zweifel den
 * gesendeten Header.
 */

import type { BrokerMode } from './broker.js';

/** Endpunkte. Nur diese beiden — kein konfigurierbares Feld, kein Tippfehler. */
const BASIS: Record<BrokerMode, string> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
};

export function alpacaBasis(mode: BrokerMode): string {
  return BASIS[mode];
}

/** Sind überhaupt Schlüssel hinterlegt? */
export function alpacaKonfiguriert(): boolean {
  return Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
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
export function keineSchluesselImText(text: string): string {
  let t = text;
  for (const k of [process.env.ALPACA_API_KEY, process.env.ALPACA_SECRET_KEY]) {
    if (k && k.length >= 8) t = t.split(k).join('«entfernt»');
  }
  return t;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function alpacaFetch(
  mode: BrokerMode,
  pfad: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  if (!alpacaKonfiguriert()) {
    throw new AlpacaFehler('Keine Alpaca-Schlüssel hinterlegt');
  }
  let res: Response;
  try {
    res = await fetchImpl(`${alpacaBasis(mode)}${pfad}`, {
      ...init,
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    throw new AlpacaFehler(`Netzwerkfehler: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new AlpacaFehler(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AlpacaFehler(`Unlesbare Antwort: ${text.slice(0, 200)}`);
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
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaKonto> {
  const d = (await alpacaFetch(mode, '/v2/account', {}, fetchImpl)) as Record<string, unknown>;
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
  };
}

/** Offene Positionen beim Broker — Grundlage des Abgleichs. */
export async function alpacaPositionen(
  mode: BrokerMode,
  fetchImpl: FetchLike = fetch,
): Promise<AlpacaPosition[]> {
  const d = (await alpacaFetch(mode, '/v2/positions', {}, fetchImpl)) as unknown[];
  if (!Array.isArray(d)) return [];
  return d.map((p) => {
    const r = p as Record<string, unknown>;
    const qty = zahl(r['qty']);
    return {
      symbol: String(r['symbol'] ?? ''),
      // Alpaca liefert Short-Mengen negativ; das Vorzeichen steckt bei uns
      // in `seite`, damit Mengen nie versehentlich subtrahiert werden.
      qty: Math.abs(qty),
      seite: String(r['side'] ?? '') === 'short' || qty < 0 ? 'short' : 'long',
      einstand: zahl(r['avg_entry_price']),
    };
  });
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
  fetchImpl: FetchLike = fetch,
): Promise<OrderErgebnis> {
  const d = (await alpacaFetch(
    mode,
    '/v2/orders',
    {
      method: 'POST',
      body: JSON.stringify({
        symbol: order.symbol,
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
    symbol: String(d['symbol'] ?? order.symbol),
    qty: zahl(d['qty']),
    side: order.side,
    ausfuehrungskurs: zahl(d['filled_avg_price']),
  };
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
