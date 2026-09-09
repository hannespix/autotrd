/**
 * Geteilte Marktdaten des Takts: EIN Bars-Cache (`/tmp/autotrd/shared`),
 * EIN Datenclient (Plattform-Key), EINE Uhr/Kalender-Ablesung je Takt —
 * egal, wie viele Nutzer laufen. Je Nutzer gibt es nur den Trading-Client
 * mit dessen Schlüsseln; alle Datenaufrufe lenkt `withSharedData` um.
 *
 * `SharedBarStoreView`: Die Engine bekommt eine Lese-Sicht auf den
 * geteilten Cache. Ihr eigener Backfill (beim Start) findet dort alles vor,
 * schreibt aber nichts — weder Bars noch Lücken-Marker. Sonst markierte der
 * erste Nutzer eine noch nicht geheilte Lücke als „geprüft", und der
 * geteilte Abruf holte sie nie nach.
 */
import type { AlpacaAsset, AlpacaClient, AlpacaClock, BarAdjustment, BarsRequest, LatestQuote } from '../../../src/alpaca/types.ts';
import { HOUR, type CalendarDay } from '../../../src/core/time.ts';
import type { Bar, Ms } from '../../../src/core/types.ts';
import { BarStore, type BaseTimeframe } from '../../../src/data/store.ts';

export class SharedBarStoreView extends BarStore {
  private readonly shared: BarStore;

  constructor(shared: BarStore) {
    // Dieselbe Wurzel UND dieselbe Bereinigung: Der Backfill der Nutzer-Engine prüft die Bereinigung
    // gegen den Store, und die Sicht darf sich nicht anders ausgeben als der geteilte Cache.
    super(shared.root, shared.adjustment);
    this.shared = shared;
  }

  override load(symbol: string, tf: BaseTimeframe): Bar[] {
    return this.shared.load(symbol, tf);
  }

  override lastTime(symbol: string, tf: BaseTimeframe): Ms | null {
    return this.shared.lastTime(symbol, tf);
  }

  override firstTime(symbol: string, tf: BaseTimeframe): Ms | null {
    return this.shared.firstTime(symbol, tf);
  }

  override gapMarks(symbol: string, tf: BaseTimeframe): Set<string> {
    return this.shared.gapMarks(symbol, tf);
  }

  override save(_symbol: string, _tf: BaseTimeframe, _bars: readonly Bar[]): void {
    // nur der Takt schreibt den geteilten Cache
  }

  override upsert(symbol: string, tf: BaseTimeframe, _bars: readonly Bar[]): Bar[] {
    return this.shared.load(symbol, tf);
  }

  override prune(_symbol: string, _tf: BaseTimeframe, _olderThan: Ms): void {
    // der Takt kürzt den geteilten Cache selbst
  }

  override markGapsChecked(_symbol: string, _tf: BaseTimeframe, _keys: Iterable<string>): void {
    // Lücken-Marker setzt nur der geteilte Abruf
  }

  override cleanupTemp(): number {
    return 0;
  }
}

/** Bars aus dem Cache im Format von `getBars` (Zeitfenster inklusiv). */
export function barsFromStore(store: BarStore, req: BarsRequest): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const sym of new Set(req.symbols)) {
    out.set(
      sym,
      store.load(sym, req.timeframe).filter((b) => b.t >= req.start && (req.end === undefined || b.t <= req.end)),
    );
  }
  return out;
}

/** Datenseite, die alle Nutzer eines Takts teilen. */
export interface SharedServices {
  store: BarStore;
  getClock(): Promise<AlpacaClock>;
  getCalendar(start: string, end: string): Promise<CalendarDay[]>;
  getAsset(symbol: string): Promise<AlpacaAsset | null>;
  getLatestBars(symbols: string[]): Promise<Map<string, Bar>>;
  getLatestQuotes(symbols: string[]): Promise<Map<string, LatestQuote>>;
}

/** Explizite Delegation (Fake-Clients haben Prototyp-Methoden — Spread ginge ins Leere). */
export function delegateClient(base: AlpacaClient, over: Partial<AlpacaClient>): AlpacaClient {
  const full: AlpacaClient = {
    mode: base.mode,
    getAccount: () => base.getAccount(),
    getClock: () => base.getClock(),
    getCalendar: (s, e) => base.getCalendar(s, e),
    getAsset: (sym) => base.getAsset(sym),
    listPositions: () => base.listPositions(),
    listOrders: (o) => base.listOrders(o),
    getOrder: (id) => base.getOrder(id),
    getOrderByClientId: (c) => base.getOrderByClientId(c),
    submitOrder: (o) => base.submitOrder(o),
    replaceOrder: (id, p) => base.replaceOrder(id, p),
    cancelOrder: (id) => base.cancelOrder(id),
    cancelAllOrders: () => base.cancelAllOrders(),
    closePosition: (s, q) => base.closePosition(s, q),
    closeAllPositions: (c) => base.closeAllPositions(c),
    getBars: (r) => base.getBars(r),
    getLatestBars: (s) => base.getLatestBars(s),
    getLatestQuotes: (s) => base.getLatestQuotes(s),
  };
  return { ...full, ...over };
}

/** Trading-Client des Nutzers, Datenaufrufe auf die geteilte Seite umgelenkt. */
export function withSharedData(user: AlpacaClient, shared: SharedServices): AlpacaClient {
  return delegateClient(user, {
    getClock: () => shared.getClock(),
    getCalendar: (s, e) => shared.getCalendar(s, e),
    getAsset: async (symbol) => {
      try {
        return await shared.getAsset(symbol);
      } catch {
        // ohne Plattform-Key: der eigene Trading-Key darf Stammdaten lesen
        return user.getAsset(symbol);
      }
    },
    getBars: async (req) => barsFromStore(shared.store, req),
    getLatestBars: (s) => shared.getLatestBars(s),
    getLatestQuotes: (s) => shared.getLatestQuotes(s),
  });
}

/* ───────────────────────── Prozess-Caches (Instanz-Lebensdauer) ───────────────────────── */

const stores = new Map<string, BarStore>();

/**
 * Ein `BarStore` je Wurzel — hält die Bars zwischen Takten im Speicher (warme Instanz). Die Wurzel
 * trägt die Bereinigung bereits im Pfad (`barStoreRoot`); der Store bekommt sie zusätzlich als Wert.
 */
export function sharedStoreFor(root: string, adjustment: BarAdjustment = 'raw'): BarStore {
  let s = stores.get(root);
  if (!s) {
    s = new BarStore(root, adjustment);
    stores.set(root, s);
  }
  return s;
}

export const ASSET_TTL_MS = 6 * HOUR;
const assets = new Map<string, { until: Ms; asset: AlpacaAsset | null }>();

/** Stammdaten sind kontounabhängig und ändern sich selten — ein Abruf je Symbol und 6 h. */
export async function cachedAsset(symbol: string, fetch: () => Promise<AlpacaAsset | null>, now: Ms): Promise<AlpacaAsset | null> {
  const hit = assets.get(symbol);
  if (hit && hit.until > now) return hit.asset;
  const asset = await fetch();
  assets.set(symbol, { until: now + ASSET_TTL_MS, asset });
  return asset;
}

const CALENDAR_MEMO_MAX = 8;
const calendarMemo = new Map<string, CalendarDay[]>();

/**
 * Kalender einmal je Schlüssel (Tag bzw. Zeitraum) — der Broker-Kalender ändert sich nicht minütlich.
 * Mehrere Schlüssel nebeneinander: Takt (`today`) und Engine (`from..to`) verdrängten sich mit einem
 * einzigen Slot gegenseitig und kosteten zwei Kalender-Aufrufe je Takt (Secreview 2, G6).
 */
export async function cachedCalendar(key: string, fetch: () => Promise<CalendarDay[]>): Promise<CalendarDay[]> {
  const hit = calendarMemo.get(key);
  if (hit) return hit;
  const days = await fetch();
  if (calendarMemo.size >= CALENDAR_MEMO_MAX) calendarMemo.delete(calendarMemo.keys().next().value!);
  calendarMemo.set(key, days);
  return days;
}

/** Für Tests: alle Prozess-Caches leeren. */
export function resetSharedCaches(): void {
  stores.clear();
  assets.clear();
  calendarMemo.clear();
}
