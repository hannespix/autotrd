/**
 * Rauchtest des Orderpfads — EINE winzige Order im Papiergeld, durch die
 * ganze Kette und wieder weg.
 *
 * Warum es diese Datei gibt: Seit dem Umbau im September 2026 hat die
 * Engine NULL Trades ausgeführt — kein Kandidat besteht die Gates, und das
 * ist ein zulässiges Ergebnis (§0.9). Der Preis dafür ist, dass der
 * Orderpfad unerprobt ist: Bracket-Order, Schutz-Stop beim Broker,
 * Fill-Erkennung, Abgleich, positionsstabile Kennungen, Exit-Idempotenz,
 * Storno vor eigenem Exit, 422-Behandlung. Der erste echte Trade wäre sonst
 * der erste Test dieser Kette. Genau das soll er nicht sein.
 *
 * Was dieser Rauchtest NICHT ist: kein Beleg für eine Kante, keine Messung,
 * kein Beitrag zur Live-Reife. Er zeigt, dass die Mechanik trägt — mehr
 * nicht. Daraus folgen fünf Eigenschaften, die alle im Code stehen:
 *
 *  1. **Echtgeld ist hart gesperrt** — drei Schichten. Der Aufrufer prüft
 *     `resolveMode` (cli.ts), `rauchtest()` prüft den aufgelösten Modus,
 *     den Modus des Clients UND `broker.mode` noch einmal, und
 *     `RauchtestClient.submitOrder` wirft, wenn der Client nicht im
 *     Paper-Modus steht. Keine der drei ist abschaltbar, und keine kommt
 *     zum Zuge, nachdem schon eine Order gesendet wurde.
 *  2. **Die Kennungen tragen ein Präfix** (`rauchtest-`). Gerechnet wird
 *     die Kennung von derselben Funktion wie im Betrieb (`entryClientId`
 *     über `decisionBucketStart`), am Broker heißt sie dann
 *     `rauchtest-atd-paper-SPY-…-e`. Zwei Wirkungen: `parseClientId`
 *     erkennt sie NICHT als Engine-Kennung (die Produktions-Engine kann
 *     eine Rauchtest-Order nie als eigene übernehmen), und eine Kollision
 *     mit einer echten Einstiegs-Kennung ist ausgeschlossen. Der Anker ist
 *     der Minuten-Bucket, damit zwei Läufe am selben Tag verschiedene
 *     Kennungen bekommen — im selben Bucket ist es bewusst dieselbe, denn
 *     genau das ist die Idempotenz-Eigenschaft, die geprüft wird.
 *  3. **Die Trades zählen nirgends mit.** `RauchtestJournal` schreibt
 *     `trade_closed` als `note` mit `rauchtestKind: 'trade_closed'`.
 *     `Journal.trades()` filtert auf `kind === 'trade_closed'`, und
 *     `readiness.ts` bewertet nur, was von dort kommt — ein Rauchtest-Trade
 *     kann die Live-Reife also selbst dann nicht verfälschen, wenn jemand
 *     die Journale aneinanderhängt. `trades()` des Wrappers ist immer leer.
 *  4. **Fremder Bestand bleibt unberührt.** Der Rauchtest bricht ab, wenn
 *     im Symbol schon eine Position oder eine offene Order liegt;
 *     `closePosition`, `closeAllPositions` und `cancelAllOrders` sind im
 *     dekorierten Client gesperrt (sie würden fremden Bestand im selben
 *     Konto anfassen — Secreview 2, G4). Aufgeräumt wird nur, was der Lauf
 *     selbst angelegt hat: Kennungs-Präfix oder Bein der eigenen Order.
 *  5. **Exits werden nie gesperrt** (§0.4). Scheitert ein Schritt, läuft
 *     das Aufräumen trotzdem — und der Schutz-Stop liegt von der ersten
 *     Sekunde an als Bracket-Bein beim Broker, nicht im Prozess. Stirbt der
 *     Prozess zwischen Fill und Exit, bleibt die Position mit GTC-Stop
 *     beim Broker stehen; `autotrd status` zeigt sie, `flatten` räumt sie.
 */
import {
  isOpenStatus,
  type AlpacaAccount,
  type AlpacaAsset,
  type AlpacaClient,
  type AlpacaClock,
  type AlpacaMode,
  type AlpacaOrder,
  type AlpacaPosition,
  type BarsRequest,
  type LatestQuote,
  type NewOrder,
  type ReplaceOrder,
} from '../alpaca/types.ts';
import type { Config } from '../core/config.ts';
import { emptyState, type JournalEvent, type JournalEventKind, type JournalLike } from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import { dayKeyFor, type Calendar, type CalendarDay } from '../core/time.ts';
import type { Bar, Ms, TimeframeMin, Trade } from '../core/types.ts';
import { pdtCheck } from '../risk/pdt.ts';
import { Book, type EnterIntent, type ExitIntent } from './book.ts';
import { decisionBucketStart, entryClientId, parseClientId } from './ids.ts';
import { flattenOrders, OrderExecutor, roundStopFor, roundTargetFor } from './orders.ts';
import { reconcile } from './reconcile.ts';

/** Präfix JEDER Kennung, die dieser Lauf an den Broker gibt. */
export const RAUCHTEST_CLIENT_PREFIX = 'rauchtest-';
/** Strategie-Kennung in Intent, Position und Trade — im Journal unverwechselbar. */
export const RAUCHTEST_STRATEGY = 'rauchtest';
/**
 * Zeitrahmen NUR für den Kennungs-Anker (`decisionBucketStart`): der
 * Minuten-Bucket. Mit dem Zeitrahmen der Produktion (1440) hätten zwei
 * Läufe am selben Tag dieselbe Einstiegs-Kennung — der zweite würde die
 * tote Order des ersten „wiederfinden" und nie handeln. Entschieden wird
 * hier ohnehin nichts aus Bars; der Anker ist die einzige Wirkung.
 */
export const RAUCHTEST_TIMEFRAME: TimeframeMin = 1;
/** Der Rauchtest prüft den Aktien-Orderpfad (Bracket) — Krypto hat einen anderen. */
export const RAUCHTEST_ASSET_CLASS = 'us_equity';
/**
 * Mindestabstand zum Sitzungsschluss. Kurz vor 16:00 ET wäre der eigene
 * Ausstieg eine Marktorder ohne Gegenseite: Sie füllt erst am nächsten
 * Morgen, der Fill-Wartelauf läuft ins Zeitlimit, und die Position bliebe
 * über Nacht stehen (mit GTC-Stop, aber ungewollt). Ein Rauchtest, der
 * seinen eigenen Ausstieg nicht mehr schafft, ist keiner.
 */
export const RAUCHTEST_MIN_MIN_BIS_SCHLUSS = 15;

/** Kennung nach außen markieren (idempotent). */
export function markiereClientId(id: string): string {
  return id.startsWith(RAUCHTEST_CLIENT_PREFIX) ? id : RAUCHTEST_CLIENT_PREFIX + id;
}

/** Kennung nach innen entmarkieren (idempotent); fremde Kennungen bleiben, wie sie sind. */
export function entmarkiereClientId(id: string): string {
  return id.startsWith(RAUCHTEST_CLIENT_PREFIX) ? id.slice(RAUCHTEST_CLIENT_PREFIX.length) : id;
}

function gesperrt(methode: string): Error {
  return new Error(`Rauchtest: ${methode} ist gesperrt — der Aufruf würde fremden Bestand im selben Konto anfassen.`);
}

/**
 * Broker-Client des Rauchtests: markiert jede Kennung nach außen, entfernt
 * die Marke nach innen (der OrderExecutor sieht exakt seine eigene
 * Kennung), sperrt die kontoweiten Befehle und lässt keine Order durch,
 * wenn der Modus nicht `paper` ist.
 */
export class RauchtestClient implements AlpacaClient {
  readonly mode: AlpacaMode;
  /** Was tatsächlich an den Broker ging (Bracket-Beine legt der Broker an, sie stehen hier nicht). */
  readonly gesendet: NewOrder[] = [];
  /** Methodennamen in Aufrufreihenfolge — Beleg dafür, dass vor dem Senden nachgesehen wurde (§0.6). */
  readonly aufrufe: string[] = [];
  private readonly inner: AlpacaClient;

  constructor(inner: AlpacaClient) {
    this.inner = inner;
    this.mode = inner.mode;
  }

  private zaehle(name: string): void {
    this.aufrufe.push(name);
  }

  private herein(o: AlpacaOrder): AlpacaOrder {
    return { ...o, clientOrderId: entmarkiereClientId(o.clientOrderId), legs: o.legs.map((l) => this.herein(l)) };
  }

  async getAccount(): Promise<AlpacaAccount> {
    this.zaehle('getAccount');
    return this.inner.getAccount();
  }

  async getClock(): Promise<AlpacaClock> {
    this.zaehle('getClock');
    return this.inner.getClock();
  }

  async getCalendar(start: string, end: string): Promise<CalendarDay[]> {
    this.zaehle('getCalendar');
    return this.inner.getCalendar(start, end);
  }

  async getAsset(symbol: string): Promise<AlpacaAsset | null> {
    this.zaehle('getAsset');
    return this.inner.getAsset(symbol);
  }

  async listPositions(): Promise<AlpacaPosition[]> {
    this.zaehle('listPositions');
    return this.inner.listPositions();
  }

  async listOrders(opts: { status: 'open' | 'closed' | 'all'; symbols?: string[]; after?: Ms; limit?: number; nested?: boolean }): Promise<AlpacaOrder[]> {
    this.zaehle('listOrders');
    return (await this.inner.listOrders(opts)).map((o) => this.herein(o));
  }

  async getOrder(id: string): Promise<AlpacaOrder | null> {
    this.zaehle('getOrder');
    const o = await this.inner.getOrder(id);
    return o ? this.herein(o) : null;
  }

  async getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    this.zaehle('getOrderByClientId');
    const o = await this.inner.getOrderByClientId(markiereClientId(clientOrderId));
    return o ? this.herein(o) : null;
  }

  async submitOrder(order: NewOrder): Promise<AlpacaOrder> {
    this.zaehle('submitOrder');
    // Dritte Schicht des Doppel-Guards: Was hier ankommt, ist das Einzige,
    // was Geld bewegen kann. Sie steht bewusst NACH allen Prüfungen des
    // Aufrufers — wer sie umgeht, umgeht sie nicht.
    if (this.mode !== 'paper') throw new Error('Rauchtest: Der Broker-Client steht nicht auf Paper — es wird keine Order gesendet.');
    const markiert: NewOrder = { ...order, clientOrderId: markiereClientId(order.clientOrderId) };
    this.gesendet.push(markiert);
    return this.herein(await this.inner.submitOrder(markiert));
  }

  async replaceOrder(id: string, patch: ReplaceOrder): Promise<AlpacaOrder> {
    this.zaehle('replaceOrder');
    if (this.mode !== 'paper') throw new Error('Rauchtest: Der Broker-Client steht nicht auf Paper — es wird keine Order geändert.');
    const p: ReplaceOrder = patch.clientOrderId === undefined ? patch : { ...patch, clientOrderId: markiereClientId(patch.clientOrderId) };
    return this.herein(await this.inner.replaceOrder(id, p));
  }

  async cancelOrder(id: string): Promise<void> {
    this.zaehle('cancelOrder');
    return this.inner.cancelOrder(id);
  }

  async cancelAllOrders(): Promise<void> {
    this.zaehle('cancelAllOrders');
    throw gesperrt('cancelAllOrders');
  }

  async closePosition(_symbol: string, _qty?: number): Promise<AlpacaOrder | null> {
    this.zaehle('closePosition');
    throw gesperrt('closePosition');
  }

  async closeAllPositions(_cancelOrders: boolean): Promise<void> {
    this.zaehle('closeAllPositions');
    throw gesperrt('closeAllPositions');
  }

  async getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
    this.zaehle('getBars');
    return this.inner.getBars(req);
  }

  async getLatestBars(symbols: string[]): Promise<Map<string, Bar>> {
    this.zaehle('getLatestBars');
    return this.inner.getLatestBars(symbols);
  }

  async getLatestQuotes(symbols: string[]): Promise<Map<string, LatestQuote>> {
    this.zaehle('getLatestQuotes');
    return this.inner.getLatestQuotes(symbols);
  }
}

/**
 * Journal des Rauchtests. Es schreibt alles mit — aber `trade_closed` wird
 * zu `note` mit `rauchtestKind: 'trade_closed'`, und `trades()` ist leer.
 *
 * Der Grund steht in `readiness.ts`: Die Live-Reife bewertet `Trade`-Objekte,
 * die `Journal.trades()` aus Ereignissen der Art `trade_closed` liest. Ein
 * Rauchtest-Trade darf dort NIE auftauchen — er ist ein Mechanik-Beweis,
 * kein Handelsergebnis. Ein eigener Ordner allein würde das nur solange
 * sichern, bis jemand zwei Journale aneinanderhängt; die Umbenennung der Art
 * sichert es auch dann.
 */
export class RauchtestJournal implements JournalLike {
  /** Alles, was dieser Lauf geschrieben hat — Grundlage des Protokolls. */
  readonly ereignisse: JournalEvent[] = [];
  private readonly ziel: JournalLike | null;

  constructor(ziel: JournalLike | null = null) {
    this.ziel = ziel;
  }

  append(kind: JournalEventKind, data: Record<string, unknown> = {}, ts: Ms = Date.now()): void {
    const art: JournalEventKind = kind === 'trade_closed' ? 'note' : kind;
    const daten: Record<string, unknown> = { ...data, rauchtest: true };
    if (art !== kind) daten['rauchtestKind'] = kind;
    this.ereignisse.push({ ...daten, ts, kind: art });
    this.ziel?.append(art, daten, ts);
  }

  readAll(): JournalEvent[] {
    return [...this.ereignisse];
  }

  /** Immer leer: Ein Rauchtest-Trade ist kein Beleg (siehe Klassenkopf). */
  trades(): Trade[] {
    return [];
  }
}

/* ───────────────────────── Ergebnis ───────────────────────── */

export type SchrittName = 'vorbedingungen' | 'einstieg' | 'idempotenz' | 'fill' | 'beine' | 'abgleich' | 'ausstieg' | 'aufraeumen';

export interface Schritt {
  name: SchrittName;
  titel: string;
  ok: boolean;
  text: string;
  details: Record<string, unknown>;
}

export interface RauchtestErgebnis {
  ok: boolean;
  /** true ⇒ eine Vorbedingung war nicht erfüllt; es wurde NICHTS gesendet. */
  abgebrochen: boolean;
  grund: string | null;
  mode: string;
  symbol: string;
  qty: number;
  /** Einstiegs-Kennung OHNE Marke (am Broker steht sie mit `rauchtest-`). */
  clientId: string | null;
  schritte: Schritt[];
  ereignisse: JournalEvent[];
  protokoll: string;
}

export interface RauchtestArgs {
  /** Roher Broker-Client; `rauchtest()` dekoriert ihn selbst. */
  client: AlpacaClient;
  config: Config;
  /** Aufgelöster Modus des Aufrufers (`resolveMode`) — alles außer `paper` bricht ab. */
  mode: 'paper' | 'live';
  symbol: string;
  qty: number;
  /** Zieljournal (eigene Datei, nicht das der Produktion); null ⇒ nur im Speicher. */
  journal?: JournalLike | undefined;
  calendar?: Calendar | undefined;
  /** Abstand des Schutz-Stops vom Referenzkurs in Prozent (Default 5 — weit genug, um nicht auszulösen). */
  stopPct?: number | undefined;
  /** Abstand des Ziels in Prozent (Default 5 — weit genug, um nicht sofort zu füllen). */
  targetPct?: number | undefined;
  /** Zeitlimit je Warteschritt in ms (Default 60 000). */
  timeoutMs?: number | undefined;
  /** Pause zwischen zwei Abfragen in ms (Default 1 500). */
  pollMs?: number | undefined;
  now?: (() => Ms) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  log?: typeof logger | undefined;
}

function n2(v: number | null | undefined, stellen = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(stellen);
}

/** Protokoll als Markdown — das, was ein Mensch liest und was als Artefakt hochgeht. */
export function protokollText(e: Omit<RauchtestErgebnis, 'protokoll'>): string {
  const zeilen: string[] = [];
  zeilen.push(`# Rauchtest Orderpfad — ${e.symbol} × ${e.qty} (${e.mode})`);
  zeilen.push('');
  zeilen.push(
    e.abgebrochen
      ? `**ABGEBROCHEN vor der ersten Order** — ${e.grund ?? 'ohne Grund?'}`
      : e.ok
        ? '**BESTANDEN** — jeder Schritt der Kette hat getan, was er soll.'
        : `**FEHLGESCHLAGEN** — ${e.grund ?? 'siehe Schritte'}`,
  );
  zeilen.push('');
  zeilen.push('| Schritt | Urteil | Befund |');
  zeilen.push('|---|---|---|');
  for (const s of e.schritte) zeilen.push(`| ${s.titel} | ${s.ok ? '✔' : '✘'} | ${s.text.replace(/\|/g, '\\|')} |`);
  zeilen.push('');
  for (const s of e.schritte) {
    const keys = Object.keys(s.details);
    if (keys.length === 0) continue;
    zeilen.push(`### ${s.titel}`);
    zeilen.push('');
    for (const k of keys) zeilen.push(`- \`${k}\`: ${JSON.stringify(s.details[k])}`);
    zeilen.push('');
  }
  zeilen.push('---');
  zeilen.push('');
  zeilen.push(
    'Dieser Lauf ist ein Mechanik-Beweis, kein Handelsergebnis: Seine Trades stehen im Journal als ' +
      '`note` mit `rauchtestKind: "trade_closed"` und werden von `readiness.ts` nie gezählt.',
  );
  return zeilen.join('\n');
}

/** Kurzfassung für Log und Konsole. */
export function zusammenfassung(e: RauchtestErgebnis): string {
  const gut = e.schritte.filter((s) => s.ok).length;
  const kopf = e.abgebrochen ? 'ABGEBROCHEN' : e.ok ? 'BESTANDEN' : 'FEHLGESCHLAGEN';
  return `Rauchtest ${kopf} — ${gut}/${e.schritte.length} Schritte, ${e.symbol} × ${e.qty} (${e.mode})`;
}

/* ───────────────────────── Ablauf ───────────────────────── */

/** Referenzkurs: Quote-Mitte, sonst letzte Bar. Null ⇒ kein Kurs, kein Handel. */
async function referenzkurs(client: AlpacaClient, symbol: string, log: typeof logger): Promise<number | null> {
  try {
    const q = (await client.getLatestQuotes([symbol])).get(symbol);
    if (q && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  } catch (e) {
    log.debug('Rauchtest: keine Quotes — es gilt die letzte Bar', { error: errMsg(e) });
  }
  try {
    const b = (await client.getLatestBars([symbol])).get(symbol);
    if (b && b.c > 0) return b.c;
  } catch (e) {
    log.warn('Rauchtest: keine letzte Bar', { error: errMsg(e) });
  }
  return null;
}

/**
 * Der Rauchtest. Gibt IMMER ein Ergebnis zurück (wirft nicht): Auch ein
 * Fehler mitten in der Kette ist ein Befund, und das Aufräumen läuft danach
 * trotzdem.
 */
export async function rauchtest(a: RauchtestArgs): Promise<RauchtestErgebnis> {
  const now = a.now ?? ((): Ms => Date.now());
  const sleep = a.sleep ?? ((ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms)));
  const log = a.log ?? logger;
  const symbol = a.symbol;
  const qty = a.qty;
  const stopPct = a.stopPct ?? 5;
  const targetPct = a.targetPct ?? 5;
  const pollMs = Math.max(1, a.pollMs ?? 1_500);
  const runden = Math.max(1, Math.ceil((a.timeoutMs ?? 60_000) / pollMs));
  const journal = new RauchtestJournal(a.journal ?? null);
  const schritte: Schritt[] = [];
  let clientId: string | null = null;

  const bauErgebnis = (o: { ok: boolean; abgebrochen: boolean; grund: string | null }): RauchtestErgebnis => {
    const basis: Omit<RauchtestErgebnis, 'protokoll'> = {
      ok: o.ok,
      abgebrochen: o.abgebrochen,
      grund: o.grund,
      mode: a.mode,
      symbol,
      qty,
      clientId,
      schritte,
      ereignisse: journal.readAll(),
    };
    return { ...basis, protokoll: protokollText(basis) };
  };

  const push = (name: SchrittName, titel: string, ok: boolean, text: string, details: Record<string, unknown> = {}): boolean => {
    schritte.push({ name, titel, ok, text, details });
    journal.append('note', { schritt: name, ok, text, ...details }, now());
    (ok ? log.info : log.warn)(`Rauchtest ${name}: ${ok ? 'ok' : 'FEHLER'} — ${text}`);
    return ok;
  };

  const abbruch = (grund: string, details: Record<string, unknown> = {}): RauchtestErgebnis => {
    push('vorbedingungen', 'Vorbedingungen', false, grund, details);
    return bauErgebnis({ ok: false, abgebrochen: true, grund });
  };

  /* ── Echtgeld-Sperre: VOR jeder Verbindung, vor jeder Order ── */
  if (a.mode !== 'paper') return abbruch(`Aufgelöster Modus ist \`${a.mode}\` — der Rauchtest läuft ausschließlich im Papiergeld.`);
  if (a.config.broker.mode !== 'paper') {
    return abbruch(`\`broker.mode\` steht auf \`${a.config.broker.mode}\` — der Rauchtest läuft nur gegen eine Paper-Config, auch wenn der Doppel-Guard gerade Paper ergäbe.`);
  }
  if (a.client.mode !== 'paper') return abbruch(`Der Broker-Client steht auf \`${a.client.mode}\` — es wird nichts gesendet.`);
  if (a.config.universe.assetClass !== RAUCHTEST_ASSET_CLASS) {
    return abbruch(`Assetklasse ist \`${a.config.universe.assetClass}\` — dieser Rauchtest prüft den Aktien-Orderpfad (Bracket beim Broker). Krypto hat einen anderen (Stop-Limit nach dem Fill) und braucht einen eigenen Lauf.`);
  }
  if (!Number.isInteger(qty) || qty <= 0) return abbruch(`Stückzahl ${qty} ist keine positive ganze Zahl (Bracket-Orders brauchen ganze Stücke).`);

  const client = new RauchtestClient(a.client);

  /* ── 1. Vorbedingungen ── */
  let acc: AlpacaAccount;
  let clock: AlpacaClock;
  try {
    acc = await client.getAccount();
    clock = await client.getClock();
  } catch (e) {
    return abbruch(`Broker nicht erreichbar: ${errMsg(e)}`);
  }
  if (acc.tradingBlocked || acc.accountBlocked) return abbruch('Konto gesperrt (trading_blocked/account_blocked).');
  if (!clock.isOpen) {
    return abbruch(`Markt geschlossen (nächste Öffnung ${new Date(clock.nextOpen).toISOString()}). Der Rauchtest wartet nicht — er bricht ab.`);
  }
  const bisSchluss = Math.floor((clock.nextClose - clock.timestamp) / 60_000);
  if (bisSchluss < RAUCHTEST_MIN_MIN_BIS_SCHLUSS) {
    return abbruch(
      `Nur noch ${bisSchluss} Minuten bis zum Sitzungsschluss (mindestens ${RAUCHTEST_MIN_MIN_BIS_SCHLUSS}). Der eigene Ausstieg würde nicht mehr füllen und die Position bliebe über Nacht stehen.`,
    );
  }
  const asset = await client.getAsset(symbol);
  if (!asset) return abbruch(`${symbol} ist bei Alpaca unbekannt.`);
  if (!asset.tradable) return abbruch(`${symbol} ist nicht handelbar (Status ${asset.status}).`);
  if (asset.assetClass !== RAUCHTEST_ASSET_CLASS) return abbruch(`${symbol} ist ${asset.assetClass}, erwartet wurde ${RAUCHTEST_ASSET_CLASS}.`);
  const bestand = (await client.listPositions()).find((p) => p.symbol === symbol) ?? null;
  if (bestand) {
    return abbruch(`Im Konto liegt bereits ${symbol} (${bestand.side} ${bestand.qty}) — der Rauchtest fasst fremden Bestand nicht an. Anderes Symbol wählen oder die Position klären.`);
  }
  const schonOffen = flattenOrders(await client.listOrders({ status: 'open', symbols: [symbol], nested: true })).filter((o) => o.symbol === symbol && isOpenStatus(o.status));
  if (schonOffen.length > 0) {
    return abbruch(`Für ${symbol} liegen bereits ${schonOffen.length} offene Order(s) im Konto — der Rauchtest würde sie beim Ausstieg stornieren. Anderes Symbol wählen.`);
  }
  const ref = await referenzkurs(client, symbol, log);
  if (ref === null || !(ref > 0)) return abbruch(`Kein Referenzkurs für ${symbol} (weder Quote noch Bar) — ohne Kurs kein Stop und keine Order.`);
  const bedarf = ref * qty;
  if (acc.cash < bedarf) return abbruch(`Bargeld ${n2(acc.cash)} $ reicht nicht für ${qty} × ${n2(ref)} $ = ${n2(bedarf)} $.`);
  const pdt = pdtCheck({
    respect: a.config.risk.pdt.respect,
    minEquity: a.config.risk.pdt.minEquity,
    maxDayTrades: a.config.risk.pdt.maxDayTrades,
    equity: acc.equity,
    brokerCount: acc.daytradeCount,
    localCount: 0,
    plannedIntradayEntries: 0,
    // Der Rauchtest öffnet und schließt am selben Tag — er IST ein Daytrade.
    intraday: true,
    assetClass: RAUCHTEST_ASSET_CLASS,
  });
  if (!pdt.allowed) return abbruch(`${pdt.reason ?? 'PDT-Gate'} — der Rauchtest öffnet und schließt am selben Tag und wäre ein Daytrade.`);
  push('vorbedingungen', 'Vorbedingungen', true, `Paper, Markt offen, ${symbol} handelbar, Bargeld ${n2(acc.cash)} $, PDT frei (${pdt.remaining === Number.POSITIVE_INFINITY ? 'Regel greift nicht' : pdt.remaining})`, {
    equity: acc.equity,
    cash: acc.cash,
    daytradeCount: acc.daytradeCount,
    referenzkurs: ref,
    marktOffen: clock.isOpen,
  });

  /* ── Werkzeuge für die Kette ── */
  const book = new Book();
  /** Order-IDs, die nachweislich zu diesem Lauf gehören (eigene Order oder eines ihrer Beine). */
  const eigeneOrderIds = new Set<string>();
  const laufBeginn = now();

  const bauExecutor = (b: Book, j: JournalLike): OrderExecutor =>
    new OrderExecutor({
      client,
      book: b,
      journal: j,
      mode: 'paper',
      assetClass: RAUCHTEST_ASSET_CLASS,
      timeframe: RAUCHTEST_TIMEFRAME,
      // GTC statt DAY: Stirbt der Prozess zwischen Fill und Exit, überlebt das
      // Stop-Bein den Sitzungsschluss — die Position steht nie ohne Schutz.
      holdsOvernightFor: () => true,
      strategyIdFor: () => RAUCHTEST_STRATEGY,
      stufeFor: () => RAUCHTEST_STRATEGY,
      costs: a.config.costs,
      calendar: a.calendar,
      now,
      sleep,
      log,
    });
  const executor = bauExecutor(book, journal);

  /** Offene Orders, die diesem Lauf gehören — nach Kennungs-Präfix ODER als Bein einer eigenen Order. */
  const eigeneOffene = async (): Promise<AlpacaOrder[]> => {
    const top = await a.client.listOrders({ status: 'open', symbols: [symbol], nested: true });
    const out = new Map<string, AlpacaOrder>();
    for (const o of top) {
      const meins = o.clientOrderId.startsWith(RAUCHTEST_CLIENT_PREFIX) || eigeneOrderIds.has(o.id);
      for (const x of [o, ...o.legs]) {
        if (x.symbol !== symbol || !isOpenStatus(x.status)) continue;
        if (!meins && !x.clientOrderId.startsWith(RAUCHTEST_CLIENT_PREFIX) && !eigeneOrderIds.has(x.id)) continue;
        eigeneOrderIds.add(x.id);
        out.set(x.id, x);
      }
    }
    return [...out.values()];
  };

  /** Alle Einstiegs-Orders dieses Laufs (jeder Status) — die Zahl, die bei Idempotenz 1 bleiben muss. */
  const eigeneEinstiege = async (): Promise<AlpacaOrder[]> =>
    flattenOrders(await a.client.listOrders({ status: 'all', symbols: [symbol], nested: true, after: laufBeginn - 60_000, limit: 500 })).filter(
      (o) => o.symbol === symbol && o.clientOrderId.startsWith(RAUCHTEST_CLIENT_PREFIX) && parseClientId(entmarkiereClientId(o.clientOrderId))?.kind === 'entry',
    );

  const warteBis = async (fertig: () => boolean): Promise<boolean> => {
    for (let i = 0; i < runden; i++) {
      await executor.syncOrders();
      if (fertig()) return true;
      await sleep(pollMs);
    }
    await executor.syncOrders();
    return fertig();
  };

  /* ── 2.–7. Die Kette ── */
  const decidedAt = now();
  const anker = decisionBucketStart(decidedAt, RAUCHTEST_TIMEFRAME, RAUCHTEST_ASSET_CLASS, a.calendar);
  const kennung = entryClientId('paper', symbol, anker);
  clientId = kennung;
  const rohStop = ref * (1 - stopPct / 100);
  const rohTarget = ref * (1 + targetPct / 100);
  const stop = roundStopFor(rohStop, 'long');
  const target = roundTargetFor(rohTarget, 'long');
  const intent: EnterIntent = {
    kind: 'enter',
    symbol,
    side: 'long',
    qty,
    stop: rohStop,
    target: rohTarget,
    refPrice: ref,
    reason: 'rauchtest',
    strategy: RAUCHTEST_STRATEGY,
    decidedAt,
  };

  let fehler: string | null = null;

  const kette = async (): Promise<void> => {
    // 2. Einstieg: EINE Bracket-Order (Markt + Stop-Bein + Ziel-Bein).
    const res = (await executor.execute([intent]))[0];
    const beimBroker = await a.client.getOrderByClientId(markiereClientId(kennung));
    if (beimBroker) eigeneOrderIds.add(beimBroker.id);
    const einstiegOk =
      res !== undefined && res.ok && beimBroker !== null && beimBroker.orderClass === 'bracket' && beimBroker.clientOrderId === markiereClientId(kennung) && beimBroker.qty === qty;
    if (
      !push(
        'einstieg',
        'Einstieg (Bracket)',
        einstiegOk,
        einstiegOk
          ? `Bracket ${symbol} buy ${qty} gesendet, Kennung am Broker \`${markiereClientId(kennung)}\``
          : `Einstieg nicht wie erwartet beim Broker angekommen (${res?.note ?? 'kein Ergebnis'})`,
        {
          clientIdIntern: clientId,
          clientIdBeimBroker: beimBroker?.clientOrderId ?? null,
          orderId: beimBroker?.id ?? null,
          orderClass: beimBroker?.orderClass ?? null,
          timeInForce: beimBroker?.timeInForce ?? null,
          stopGerundet: stop,
          zielGerundet: target,
          note: res?.note ?? null,
        },
      )
    ) {
      return;
    }

    // 3. Idempotenz (§0.6): dieselbe logische Einheit ein zweites Mal — im
    //    laufenden Prozess UND nach simuliertem Neustart (frisches Buch, wie
    //    nach einem Absturz). Es darf keine zweite Order entstehen.
    const vorher = (await eigeneEinstiege()).length;
    const zweiter = (await executor.execute([intent]))[0];
    const gefragtVor = client.aufrufe.filter((x) => x === 'getOrderByClientId').length;
    const gesendetVor = client.gesendet.length;
    const neustart = (await bauExecutor(new Book(), new RauchtestJournal(null)).execute([intent]))[0];
    const gefragt = client.aufrufe.filter((x) => x === 'getOrderByClientId').length - gefragtVor;
    const neuGesendet = client.gesendet.length - gesendetVor;
    const nachher = (await eigeneEinstiege()).length;
    push(
      'idempotenz',
      'Idempotenz (zweite Anforderung)',
      vorher === 1 && nachher === 1 && neuGesendet === 0 && gefragt > 0 && zweiter?.ok === true && neustart?.ok === true,
      nachher === 1 && neuGesendet === 0
        ? `Zweite Anforderung erzeugte keine zweite Order — im Prozess über das Buch, nach Neustart über getOrderByClientId (${gefragt} Abfragen)`
        : `Zweite Anforderung erzeugte ${nachher - vorher} weitere Order(s) / ${neuGesendet} Sendungen — Idempotenz verletzt`,
      {
        einstiegsOrdersVorher: vorher,
        einstiegsOrdersNachher: nachher,
        neueSendungen: neuGesendet,
        getOrderByClientIdAbfragen: gefragt,
        notizImProzess: zweiter?.note ?? null,
        notizNachNeustart: neustart?.note ?? null,
      },
    );

    // 4. Fill: warten, bis das Buch eine Position hat (REST-Abgleich, wie auf der Plattform).
    const gefuellt = await warteBis(() => book.positions.has(symbol));
    const pos = book.positions.get(symbol) ?? null;
    if (
      !push(
        'fill',
        'Fill',
        gefuellt && pos !== null && pos.qty === qty,
        gefuellt && pos ? `Gefüllt: ${pos.qty} × ${n2(pos.entryPrice)} $` : `Kein Fill innerhalb von ${runden * pollMs} ms`,
        { menge: pos?.qty ?? null, einstand: pos?.entryPrice ?? null, einstiegszeit: pos?.entryTime ?? null, stopImBuch: pos?.stop ?? null, zielImBuch: pos?.target ?? null },
      )
    ) {
      // Ohne Fill bleibt die Einstiegs-Order womöglich offen — stornieren, dann aufräumen.
      await executor.cancelOwnEntryOrders();
      return;
    }

    // 5. Beine: Stop UND Ziel liegen beim Broker, mit der Rundung aus §4.
    const offen = await eigeneOffene();
    const stopBein = offen.find((o) => (o.type === 'stop' || o.type === 'stop_limit') && o.side === 'sell') ?? null;
    const zielBein = offen.find((o) => o.type === 'limit' && o.side === 'sell') ?? null;
    const stopPreis = stopBein?.stopPrice ?? null;
    const zielPreis = zielBein?.limitPrice ?? null;
    const einstand = pos!.entryPrice;
    const beineOk =
      stopBein !== null &&
      zielBein !== null &&
      stopPreis === stop &&
      zielPreis === target &&
      stopPreis <= rohStop && // Stop VOM Kurs WEG gerundet (long ⇒ abwärts)
      zielPreis <= rohTarget && // Limit ZUM Kurs HIN gerundet (long ⇒ abwärts)
      stopPreis < einstand &&
      zielPreis > einstand &&
      book.protectiveOrders.has(symbol);
    push(
      'beine',
      'Stop und Ziel beim Broker',
      beineOk,
      beineOk
        ? `Stop ${n2(stopPreis)} (roh ${n2(rohStop, 4)}, vom Kurs weg abgerundet), Ziel ${n2(zielPreis)} (roh ${n2(rohTarget, 4)}, zum Kurs hin abgerundet)`
        : `Beine nicht wie erwartet (Stop ${String(stopPreis)}, Ziel ${String(zielPreis)}, erwartet ${stop} / ${target})`,
      {
        stopBeinId: stopBein?.id ?? null,
        zielBeinId: zielBein?.id ?? null,
        stopRoh: rohStop,
        stopGerundet: stop,
        stopBeimBroker: stopPreis,
        zielRoh: rohTarget,
        zielGerundet: target,
        zielBeimBroker: zielPreis,
        einstand,
        schutzStopImBuch: book.protectiveOrders.get(symbol)?.orderId ?? null,
      },
    );

    // 6. Abgleich: derselbe `reconcile()` wie in der Engine, mit erzwungenem
    //    `onOrphan: 'halt'` und ohne `ensureStops` — er darf fremden Bestand
    //    weder übernehmen noch mit einem Stop versehen.
    const state = emptyState('paper', dayKeyFor(now(), RAUCHTEST_ASSET_CLASS), acc.equity);
    const abgleich = await reconcile({
      client,
      book,
      journal,
      config: { ...a.config, engine: { ...a.config.engine, onOrphan: 'halt' } },
      state,
      now: now(),
      log,
    });
    const brokerPos = (await a.client.listPositions()).find((p) => p.symbol === symbol) ?? null;
    const buchPos = book.positions.get(symbol) ?? null;
    const abgleichOk =
      !abgleich.missing.includes(symbol) &&
      !abgleich.orphans.includes(symbol) &&
      brokerPos !== null &&
      buchPos !== null &&
      brokerPos.side === buchPos.side &&
      Math.abs(brokerPos.qty - buchPos.qty) < 1e-9;
    push(
      'abgleich',
      'Abgleich Buch ↔ Broker',
      abgleichOk,
      abgleichOk
        ? `Buch und Broker einig: ${buchPos!.side} ${buchPos!.qty} ${symbol}`
        : `Buch (${buchPos ? `${buchPos.side} ${buchPos.qty}` : 'leer'}) und Broker (${brokerPos ? `${brokerPos.side} ${brokerPos.qty}` : 'leer'}) uneins`,
      {
        buch: buchPos ? { side: buchPos.side, qty: buchPos.qty, entryPrice: buchPos.entryPrice } : null,
        broker: brokerPos ? { side: brokerPos.side, qty: brokerPos.qty, avgEntryPrice: brokerPos.avgEntryPrice } : null,
        missing: abgleich.missing,
        // Fremdbestand im selben Konto ist kein Fehler des Rauchtests — nur eine Tatsache, die im Protokoll steht.
        fremdbestand: abgleich.orphans,
      },
    );

    // 7. Ausstieg: Storno der Beine, dann eigener Exit (§0.7).
    const sellsVor = client.gesendet.filter((o) => o.side === 'sell').length;
    const exitIntent: ExitIntent = { kind: 'exit', symbol, reason: 'manual', decidedAt: now() };
    const exitRes = (await executor.execute([exitIntent]))[0];
    const geschlossen = await warteBis(() => !book.positions.has(symbol));
    const sells = client.gesendet.filter((o) => o.side === 'sell').length - sellsVor;
    const stornos = journal.ereignisse.filter((e) => e['event'] === 'cancel_requested').length;
    const treffer422 = journal.ereignisse.filter((e) => typeof e['text'] === 'string' && (e['text'] as string).includes('422'));
    const trade = journal.ereignisse.find((e) => e['rauchtestKind'] === 'trade_closed')?.['trade'] as Trade | undefined;
    push(
      'ausstieg',
      'Ausstieg (Storno vor eigenem Exit)',
      geschlossen && sells <= 1,
      geschlossen
        ? `Position zu (${stornos} Storno(s), ${sells} eigene Verkaufsorder) — ${treffer422.length > 0 ? '422 aufgetreten: Order-Stand abgefragt, kein Nachverkauf' : 'kein 422 aufgetreten, Beine ließen sich normal stornieren'}`
        : 'Position nach dem Exit-Versuch noch offen',
      {
        exitNote: exitRes?.note ?? null,
        exitClientId: exitRes?.clientId ?? null,
        stornosVorExit: stornos,
        eigeneVerkaufsorders: sells,
        stornoErgab422: treffer422.map((e) => String(e['text'])),
        trade: trade ? { exitPrice: trade.exitPrice, exitReason: trade.exitReason, netPnl: trade.netPnl, fees: trade.fees, strategy: trade.strategy } : null,
      },
    );
  };

  try {
    await kette();
  } catch (e) {
    fehler = errMsg(e);
    push('ausstieg', 'Kette abgebrochen', false, `Unerwarteter Fehler: ${fehler}`);
  }

  /* ── 8. Aufräumen — läuft IMMER, auch nach einem Fehler (§0.4: Exits nie sperren) ── */
  const notizen: string[] = [];
  try {
    if (book.pendingEntries.has(symbol)) {
      await executor.cancelOwnEntryOrders();
      notizen.push('offene Einstiegs-Order storniert');
    }
    if (book.positions.has(symbol)) {
      notizen.push('Position war noch offen — Not-Ausstieg');
      await executor.execute([{ kind: 'exit', symbol, reason: 'manual', decidedAt: now() }]);
      await warteBis(() => !book.positions.has(symbol));
    }
    // Rest-Orders nach Positionsschluss abräumen (cleanupClosed im Executor).
    await executor.syncOrders();
  } catch (e) {
    notizen.push(`Aufräumen mit Fehler: ${errMsg(e)}`);
  }
  for (const o of await eigeneOffene()) {
    try {
      await a.client.cancelOrder(o.id);
      notizen.push(`Rest-Order ${o.id} (${o.type}) storniert`);
    } catch (e) {
      notizen.push(`Rest-Order ${o.id} nicht stornierbar: ${errMsg(e)}`);
    }
  }
  let restPosition: AlpacaPosition | null = null;
  let restOrders: AlpacaOrder[] = [];
  try {
    restPosition = (await a.client.listPositions()).find((p) => p.symbol === symbol) ?? null;
    restOrders = await eigeneOffene();
  } catch (e) {
    notizen.push(`Endkontrolle fehlgeschlagen: ${errMsg(e)}`);
  }
  const sauber = restPosition === null && restOrders.length === 0 && !notizen.some((t) => t.includes('nicht stornierbar') || t.includes('fehlgeschlagen'));
  push(
    'aufraeumen',
    'Aufräumen',
    sauber,
    sauber ? 'Keine Position und keine Order dieses Laufs mehr offen (nachgesehen, nicht angenommen)' : `Es blieb etwas stehen: ${restPosition ? `Position ${restPosition.side} ${restPosition.qty}` : ''} ${restOrders.map((o) => o.id).join(',')}`.trim(),
    { restPosition: restPosition ? { side: restPosition.side, qty: restPosition.qty } : null, restOrders: restOrders.map((o) => ({ id: o.id, type: o.type, status: o.status })), notizen },
  );

  const ok = fehler === null && schritte.every((s) => s.ok);
  const erg = bauErgebnis({ ok, abgebrochen: false, grund: ok ? null : (fehler ?? schritte.find((s) => !s.ok)?.text ?? null) });
  journal.append('note', { schritt: 'urteil', ok, grund: erg.grund }, now());
  return erg;
}
