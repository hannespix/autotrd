/**
 * Datenschicht gegen Supabase (MS2, Teil 2) — Gegenstück zu data.ts.
 *
 * Gleiche Funktionsnamen, gleiche Signaturen, gleiche Rückgabetypen. Die
 * Oberfläche darf an keiner Stelle wissen, welches Backend gerade antwortet;
 * genau deshalb bleibt der Umschalttag eine Variablen-Änderung statt eines
 * Umbaus (siehe supabase.ts).
 *
 * Drei Dinge sind hier anders als bei Firestore und lohnen den Blick:
 *
 * 1. **Zahlen kommen als Text.** PostgREST liefert `numeric(20,4)` als
 *    String ("123.4500"), damit unterwegs keine Nachkommastellen verloren
 *    gehen. Ungeprüft durchgereicht würde aus `close - open` eine
 *    String-Verkettung und der Chart zeichnete Unsinn. Jede Zahl läuft
 *    deshalb durch `num()`.
 *
 * 2. **Realtime meldet Zeilen, nicht Zustände.** Firestore liefert bei jeder
 *    Änderung die ganze Abfrage neu; Supabase schickt die geänderte Zeile.
 *    Statt Zeilen von Hand in einen Zwischenstand einzupflegen — fehleranfällig,
 *    besonders bei Löschungen — lädt diese Schicht die Abfrage neu und fasst
 *    einen Schwall von Änderungen per Debounce zu einem Nachladen zusammen.
 *    Ein Scan ändert je Symbol nur eine Handvoll Zeilen; die Einfachheit ist
 *    den einen zusätzlichen Roundtrip wert.
 *
 * 3. **Realtime braucht RLS-Leserechte.** Die Kanäle laufen unter derselben
 *    Rolle wie die Abfragen (Migration 0002/0004). Was jemand nicht lesen
 *    darf, sieht er auch im Live-Kanal nicht — die Sicherheitsgrenze liegt
 *    in der Datenbank, nicht in diesem Modul.
 */

import {
  PAPER_FEE_RATE,
  attribution,
  classify,
  costProfile,
  exitBreakdown,
  dailyReturns,
  drawdown,
  sharpe,
  tradeStats,
  type ClosedTrade,
  type Position,
  type Quote,
  type Strategy,
  type StrategyDoc,
  type Wallet,
} from '@autotrd/shared';
import { muxWatch } from './mux.js';
import { sb } from './supabase.js';
import { trackListener } from './listeners.js';
import type { ChartBar } from './chart.js';
import type {
  EquitySeriesPoint,
  ForecastStatsDoc,
  IndicatorRow,
  MarketDocData,
  PortfolioStatsDoc,
  SignalRow,
  StrategyRow,
  TradeRow,
  UiPrefs,
} from './data.js';

export { listenerCount } from './listeners.js';

/** Fasst einen Schwall Realtime-Ereignisse zu einem Nachladen zusammen. */
const RELOAD_DEBOUNCE_MS = 250;

/**
 * PostgREST-Zahl → JS-Zahl. `null`/`undefined`/leer bleiben `null`, damit
 * „kein Wert" nicht als 0 durchrutscht: Ein Kurs von 0 wäre eine Aussage,
 * eine fehlende Angabe ist keine.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Wie `num()`, aber mit Ersatzwert für Felder, die nie fehlen dürfen. */
function num0(v: unknown, fallback = 0): number {
  return num(v) ?? fallback;
}

interface WatchSpec<T> {
  /** Stabiler Schlüssel für den Tab-Mux (identisch benannt wie in data.ts). */
  key: string;
  /** Einmaliges Laden des vollständigen Zustands. */
  load: () => Promise<T>;
  /** Tabellen, deren Änderungen ein Nachladen auslösen. */
  tables: Array<{ table: string; filter?: string }>;
}

/**
 * Gemeinsamer Unterbau: einmal laden, dann bei jeder Änderung nachladen.
 * Läuft über muxWatch, damit mehrere Tabs sich EIN Abo teilen — dieselbe
 * Ersparnis wie bei Firestore (M9b).
 */
function sbWatch<T>(spec: WatchSpec<T>, cb: (value: T) => void): () => void {
  return muxWatch(
    spec.key,
    (emit) => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const reload = async (): Promise<void> => {
        try {
          const value = await spec.load();
          if (!stopped) emit(value as unknown);
        } catch {
          // Ein fehlgeschlagenes Nachladen darf das Abo nicht beenden — das
          // nächste Realtime-Ereignis versucht es ohnehin erneut. Der bisher
          // angezeigte Stand bleibt stehen, statt zu leeren Karten zu führen.
        }
      };

      const channel = sb().channel(`w:${spec.key}`);
      for (const t of spec.tables) {
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: t.table, ...(t.filter ? { filter: t.filter } : {}) },
          () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
          },
        );
      }
      channel.subscribe();
      void reload();

      return trackListener(() => {
        stopped = true;
        if (timer) clearTimeout(timer);
        void sb().removeChannel(channel);
      });
    },
    (p) => cb(p as T),
  );
}

// ── Markt-Stammdaten + Kurs ──────────────────────────────────────────────────

export interface SymbolRow {
  symbol: string;
  name: string | null;
  asset_class: string | null;
  quote_price: string | number | null;
  quote_change_pct: string | number | null;
  quote_updated_at: string | null;
  sentiment: MarketDocData['sentiment'] | null;
  forecast: MarketDocData['forecast'];
  forecast_intraday: MarketDocData['forecastIntraday'];
}

/**
 * Eine market_symbols-Zeile in die Form bringen, die das Dashboard kennt.
 *
 * Die Felder werden einzeln GESETZT statt mit `undefined` belegt: Bei
 * `exactOptionalPropertyTypes` ist „Schlüssel fehlt" nicht dasselbe wie
 * „Schlüssel ist undefined", und die Oberfläche unterscheidet an mehreren
 * Stellen genau das (fehlender Kurs = „--", nicht 0).
 */
export function toMarketDoc(r: SymbolRow | null): MarketDocData | null {
  if (!r) return null;
  const out: MarketDocData = {
    forecast: r.forecast ?? null,
    forecastIntraday: r.forecast_intraday ?? null,
  };
  if (r.name) out.name = r.name;
  if (r.asset_class) out.assetClass = r.asset_class;
  if (r.sentiment) out.sentiment = r.sentiment;
  const price = num(r.quote_price);
  if (price !== null) {
    const quote: Quote = {
      price,
      changePct: num0(r.quote_change_pct),
      updatedAt: r.quote_updated_at ?? new Date().toISOString(),
    };
    out.quote = quote;
  }
  return out;
}

const SYMBOL_COLS =
  'symbol,name,asset_class,quote_price,quote_change_pct,quote_updated_at,sentiment,forecast,forecast_intraday';

export function watchMarketDoc(
  symbol: string,
  cb: (data: MarketDocData | null) => void,
): () => void {
  return sbWatch<MarketDocData | null>(
    {
      key: `marketDoc:${symbol}`,
      tables: [{ table: 'market_symbols', filter: `symbol=eq.${symbol}` }],
      load: async () => {
        const res = await sb()
          .from('market_symbols')
          .select(SYMBOL_COLS)
          .eq('symbol', symbol)
          .maybeSingle();
        return toMarketDoc((res.data as SymbolRow | null) ?? null);
      },
    },
    cb,
  );
}

export async function loadMarketQuotes(): Promise<Map<string, MarketDocData>> {
  const res = await sb().from('market_symbols').select(SYMBOL_COLS);
  const out = new Map<string, MarketDocData>();
  for (const row of (res.data as SymbolRow[] | null) ?? []) {
    const doc = toMarketDoc(row);
    if (doc) out.set(row.symbol, doc);
  }
  return out;
}

// ── Kursreihen ───────────────────────────────────────────────────────────────

export interface BarRow {
  day?: string;
  t?: number | string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number | null;
}

export function toBar(r: BarRow): ChartBar {
  return {
    date: r.day ?? String(r.t ?? ''),
    open: num0(r.open),
    high: num0(r.high),
    low: num0(r.low),
    close: num0(r.close),
    volume: num0(r.volume),
  };
}

/**
 * PostgREST liefert standardmäßig höchstens 1000 Zeilen. Fünf Jahre
 * Tagesbars sind ~1250 — ohne ausdrückliche Obergrenze würde der Chart
 * lautlos am Anfang beschnitten, und niemand sähe, dass Historie fehlt.
 */
const BAR_LIMIT = 5000;

export function watchBars(symbol: string, cb: (bars: ChartBar[]) => void): () => void {
  return sbWatch<ChartBar[]>(
    {
      key: `bars:${symbol}`,
      tables: [{ table: 'bars', filter: `symbol=eq.${symbol}` }],
      load: () => loadBarsOnce(symbol),
    },
    cb,
  );
}

export async function loadBarsOnce(symbol: string): Promise<ChartBar[]> {
  const res = await sb()
    .from('bars')
    .select('day,open,high,low,close,volume')
    .eq('symbol', symbol)
    .order('day', { ascending: true })
    .limit(BAR_LIMIT);
  return ((res.data as BarRow[] | null) ?? []).map(toBar);
}

/** 5-Minuten-Bars; `date` trägt hier die Unix-Sekunde als Text (wie bisher). */
export async function loadIntraday(symbol: string, max = 500): Promise<ChartBar[]> {
  const res = await sb()
    .from('bars_5m')
    .select('t,open,high,low,close,volume')
    .eq('symbol', symbol)
    .order('t', { ascending: false })
    .limit(max);
  return ((res.data as BarRow[] | null) ?? []).map(toBar).reverse();
}

// ── Signale + Indikatoren ────────────────────────────────────────────────────

export interface SignalDbRow {
  direction: 'buy' | 'sell' | 'hold';
  confluence: number;
  price: string | number | null;
  created_at: string;
  detail: {
    rsi?: number | null;
    macdHist?: number | null;
    bbPct?: number | null;
    votes?: SignalRow['votes'];
  } | null;
}

async function latestSignalRow(symbol: string): Promise<SignalDbRow | null> {
  const res = await sb()
    .from('signals')
    .select('direction,confluence,price,created_at,detail')
    .eq('symbol', symbol)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (res.data as SignalDbRow | null) ?? null;
}

/**
 * signals-Zeile → SignalRow. Die Tabelle speichert nur die Gewinnerzahl
 * (`confluence`); Buy- und Sell-Stimmen lassen sich aus den Einzelstimmen
 * zurückgewinnen, sodass die Anzeige dieselben Zahlen zeigt wie unter
 * Firestore.
 */
export function toSignalRow(r: SignalDbRow | null): SignalRow | null {
  if (!r) return null;
  const votes = r.detail?.votes ?? {};
  const werte = Object.values(votes);
  return {
    direction: r.direction,
    buyVotes: werte.filter((v) => v === 'buy').length,
    sellVotes: werte.filter((v) => v === 'sell').length,
    requiredConfluence: r.confluence,
    votes,
    price: num0(r.price),
    at: r.created_at,
  };
}

export function watchLatestSignal(
  symbol: string,
  cb: (sig: SignalRow | null) => void,
): () => void {
  return sbWatch<SignalRow | null>(
    {
      key: `signal:${symbol}`,
      tables: [{ table: 'signals', filter: `symbol=eq.${symbol}` }],
      load: async () => toSignalRow(await latestSignalRow(symbol)),
    },
    cb,
  );
}

/**
 * Indikatoren stehen in Supabase nicht in einer eigenen Tabelle, sondern im
 * `detail` des Signals — sie entstehen ohnehin im selben Rechengang. Ein
 * eigener Schreibpfad hätte nur die Gefahr geschaffen, dass Anzeige und
 * Handelsentscheidung auseinanderlaufen.
 */
export function toIndicatorRow(r: SignalDbRow | null): IndicatorRow | null {
  if (!r?.detail) return null;
  const hist = num(r.detail.macdHist);
  const pctB = num(r.detail.bbPct);
  return {
    rsi: num(r.detail.rsi),
    // Der Scan speichert bewusst nur das Histogramm — Linie und Signallinie
    // zeigt die Oberfläche nicht an. Fehlt der Wert, bleibt das Feld null,
    // statt mit erfundenen Nullen so zu tun, als gäbe es ihn.
    macd: hist === null ? null : { line: 0, signal: 0, histogram: hist },
    bollinger: pctB === null ? null : { upper: 0, middle: 0, lower: 0, pctB },
  };
}

export function watchLatestIndicators(
  symbol: string,
  cb: (row: IndicatorRow | null) => void,
): () => void {
  return sbWatch<IndicatorRow | null>(
    {
      key: `indicators:${symbol}`,
      tables: [{ table: 'signals', filter: `symbol=eq.${symbol}` }],
      load: async () => toIndicatorRow(await latestSignalRow(symbol)),
    },
    cb,
  );
}

// ── Systemzustand + Lernstatistik (meta) ─────────────────────────────────────

async function loadMeta<T>(key: string): Promise<T | null> {
  const res = await sb().from('meta').select('value').eq('key', key).maybeSingle();
  return ((res.data as { value: T } | null)?.value ?? null) as T | null;
}

function watchMeta<T>(key: string, cb: (value: T | null) => void): () => void {
  return sbWatch<T | null>(
    {
      key: `meta:${key}`,
      tables: [{ table: 'meta', filter: `key=eq.${key}` }],
      load: () => loadMeta<T>(key),
    },
    cb,
  );
}

export function watchForecastStats(cb: (stats: ForecastStatsDoc | null) => void): () => void {
  return watchMeta<ForecastStatsDoc>('forecastStats', cb);
}

export function watchForecastStatsIntraday(
  cb: (stats: ForecastStatsDoc | null) => void,
): () => void {
  return watchMeta<ForecastStatsDoc>('forecastStatsIntraday', cb);
}

/** Heartbeat des Scans — dieselbe Rolle wie meta/health in Firestore. */
export function watchHealth(cb: (health: Record<string, unknown> | null) => void): () => void {
  return watchMeta<Record<string, unknown>>('health', cb);
}

// ── Nutzerdaten (MS2 Teil 3) ─────────────────────────────────────────────────
//
// Alles hier ist LESEND. Geschrieben wird ausschließlich serverseitig
// (Edge Function mit service_role) — die RLS-Policies erlauben auf
// wallets/positions/trades bewusst gar keine Schreib-Policy, weil jede davon
// ein Loch wäre (Migration 0002). Das Frontend darf einzig `profiles.settings`
// ändern; das ist keine Geld-Tabelle.

/** Wallet des Nutzers (heute genau eines je Konto — Multi-Wallet folgt). */
async function mainWallet(uid: string): Promise<{ id: string; balance: number; updated_at: string } | null> {
  const res = await sb()
    .from('wallets')
    .select('id,balance,updated_at')
    .eq('user_id', uid)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const r = res.data as { id: string; balance: string | number; updated_at: string } | null;
  return r ? { id: r.id, balance: num0(r.balance), updated_at: r.updated_at } : null;
}

export function watchUserDoc(
  uid: string,
  cb: (data: {
    strategy: Strategy | null;
    wallet: Wallet | null;
    hotkeys: Record<string, string> | null;
    ui: UiPrefs | null;
  }) => void,
): () => void {
  return sbWatch(
    {
      key: `userDoc:${uid}`,
      tables: [
        { table: 'profiles', filter: `id=eq.${uid}` },
        { table: 'wallets', filter: `user_id=eq.${uid}` },
      ],
      load: async () => {
        const prof = await sb().from('profiles').select('settings').eq('id', uid).maybeSingle();
        const settings = ((prof.data as { settings?: Record<string, unknown> } | null)?.settings ??
          {}) as {
          strategy?: Strategy;
          hotkeys?: Record<string, string>;
          ui?: UiPrefs;
        };
        const w = await mainWallet(uid);
        return {
          strategy: settings.strategy ?? null,
          // Der Wallet-Typ der Oberfläche kennt nur Guthaben, Währung und
          // Zeitstempel — die Wallet-ID bleibt bewusst hier unten, damit die
          // UI nichts über die Mehr-Wallet-Struktur wissen muss.
          wallet: w
            ? ({ paperBalance: w.balance, currency: 'USD', updatedAt: w.updated_at } as Wallet)
            : null,
          hotkeys: settings.hotkeys ?? null,
          ui: settings.ui ?? null,
        };
      },
    },
    cb,
  );
}

/**
 * UI-Präferenzen speichern. Der einzige Schreibpfad des Frontends — und
 * auch der geht nur, weil `profiles` keine Geld-Tabelle ist. Weil Postgres
 * kein Feldpfad-Update auf JSONB per PostgREST kennt, wird `settings`
 * gelesen, ergänzt und zurückgeschrieben; die anderen Schlüssel bleiben
 * dabei erhalten (ein blindes Überschreiben würde Strategie und Hotkeys
 * löschen).
 */
export async function saveUiPrefs(uid: string, ui: UiPrefs): Promise<void> {
  const prof = await sb().from('profiles').select('settings').eq('id', uid).maybeSingle();
  const settings = ((prof.data as { settings?: Record<string, unknown> } | null)?.settings ??
    {}) as Record<string, unknown>;
  const { error } = await sb()
    .from('profiles')
    .update({ settings: { ...settings, ui } })
    .eq('id', uid);
  if (error) throw new Error(error.message);
}

export interface PositionRow {
  symbol: string;
  side: 'long' | 'short';
  qty: string | number;
  avg_entry: string | number;
  stop_loss: string | number | null;
  take_profit: string | number | null;
  high_water: string | number | null;
  low_water: string | number | null;
  opened_at: string;
}

export function toPosition(r: PositionRow): Position {
  const p: Position = {
    symbol: r.symbol,
    qty: num0(r.qty),
    avgEntry: num0(r.avg_entry),
    stopLoss: num(r.stop_loss),
    takeProfit: num(r.take_profit),
    openedAt: r.opened_at,
  };
  // Wie bei den Marktdaten: fehlende Felder werden NICHT gesetzt. `side`
  // fehlend heißt „long" (Altbestand vor dem Short-Feature), und ein
  // fehlender Wasserstand lässt den Trailing-Stop konservativ am Einstand
  // starten — beides Verhalten, das ein `undefined` im Feld zerstören würde.
  if (r.side === 'short') p.side = 'short';
  const hw = num(r.high_water);
  if (hw !== null) p.highWater = hw;
  const lw = num(r.low_water);
  if (lw !== null) p.lowWater = lw;
  return p;
}

export function watchPositions(uid: string, cb: (positions: Position[]) => void): () => void {
  return sbWatch<Position[]>(
    {
      key: `positions:${uid}`,
      tables: [{ table: 'positions', filter: `user_id=eq.${uid}` }],
      load: async () => {
        const res = await sb()
          .from('positions')
          .select('symbol,side,qty,avg_entry,stop_loss,take_profit,high_water,low_water,opened_at')
          .eq('user_id', uid);
        return ((res.data as PositionRow[] | null) ?? []).map(toPosition);
      },
    },
    cb,
  );
}

export interface TradeDbRow {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string | number;
  price: string | number;
  executed_at: string;
  source: 'engine' | 'manual';
  pnl: string | number | null;
  risk_exit: string | null;
}

export function toTradeRow(r: TradeDbRow): TradeRow {
  const t: TradeRow = {
    symbol: r.symbol,
    side: r.side,
    qty: num0(r.qty),
    price: num0(r.price),
    executedAt: r.executed_at,
    source: r.source,
  };
  // pnl nur bei schließenden Trades — eine 0 hier hieße „glatt raus", nicht
  // „noch offen". Die Trade-Liste färbt danach.
  const pnl = num(r.pnl);
  if (pnl !== null) t.pnl = pnl;
  if (r.risk_exit) t.riskExit = r.risk_exit;
  return t;
}

/** Jüngste Trades — dieselbe Obergrenze wie unter Firestore. */
const TRADE_LIMIT = 40;

export function watchTrades(uid: string, cb: (trades: TradeRow[]) => void): () => void {
  return sbWatch<TradeRow[]>(
    {
      key: `trades:${uid}`,
      tables: [{ table: 'trades', filter: `user_id=eq.${uid}` }],
      load: async () => {
        const res = await sb()
          .from('trades')
          .select('symbol,side,qty,price,executed_at,source,pnl,risk_exit')
          .eq('user_id', uid)
          .order('executed_at', { ascending: false })
          .limit(TRADE_LIMIT);
        return ((res.data as TradeDbRow[] | null) ?? []).map(toTradeRow);
      },
    },
    cb,
  );
}

/** ~ein halbes Handelsjahr — reicht für Sharpe 90 und das MaxDD-Fenster. */
const EQUITY_WINDOW = 120;

async function loadEquitySeries(uid: string): Promise<EquitySeriesPoint[]> {
  const res = await sb()
    .from('equity_snapshots')
    .select('day,equity')
    .eq('user_id', uid)
    .order('day', { ascending: false })
    .limit(EQUITY_WINDOW);
  return ((res.data as Array<{ day: string; equity: string | number }> | null) ?? [])
    .map((r) => ({ date: r.day, equity: num0(r.equity) }))
    .reverse();
}

export function watchEquitySeries(
  uid: string,
  cb: (points: EquitySeriesPoint[]) => void,
): () => void {
  return sbWatch<EquitySeriesPoint[]>(
    {
      key: `equity:${uid}`,
      tables: [{ table: 'equity_snapshots', filter: `user_id=eq.${uid}` }],
      load: () => loadEquitySeries(uid),
    },
    cb,
  );
}

/**
 * Portfolio-Kennzahlen — hier RECHNET das Frontend, statt ein fertiges
 * Stats-Dokument zu lesen.
 *
 * Unter Firestore schreibt sie ein täglicher Scheduler nach
 * users/{uid}/stats/main. Genau daran ist die Karte am 27.07. gescheitert:
 * Der Scheduler existierte live gar nicht, also blieb sie leer — und man
 * sah es ihr nicht an. Die Kennzahlen sind aber reine Ableitungen aus der
 * Equity-Serie und den Trades; sie brauchen keinen Hintergrundlauf. Was
 * einen braucht, ist die SERIE selbst (historische Equity lässt sich nicht
 * nachträglich rekonstruieren) — die kommt weiter vom Snapshot-Lauf.
 *
 * Gerechnet wird mit denselben Funktionen aus `shared/`, die auch der
 * Scheduler benutzt. Eine zweite Implementierung würde früher oder später
 * andere Zahlen zeigen als das Firebase-System daneben.
 */
async function computeStats(uid: string): Promise<PortfolioStatsDoc | null> {
  const serie = await loadEquitySeries(uid);
  const res = await sb()
    .from('trades')
    .select('symbol,asset_class,pnl,risk_exit,qty,price')
    .eq('user_id', uid)
    .not('pnl', 'is', null)
    .order('executed_at', { ascending: false })
    .limit(STATS_TRADE_WINDOW);
  const closed: ClosedTrade[] = [];
  for (const r of (res.data as TradeStatsRow[] | null) ?? []) {
    const pnl = num(r.pnl);
    if (pnl === null || !r.symbol) continue;
    const qty = num(r.qty);
    const price = num(r.price);
    closed.push({
      symbol: r.symbol,
      pnl,
      assetClass: r.asset_class ?? classify(r.symbol),
      ...(r.risk_exit ? { riskExit: r.risk_exit } : {}),
      // Gebührensatz aus der geteilten Konstante statt aus der Zeile: Der
      // Paper-Broker rechnet damit, und beide Backends müssen dieselben
      // Zahlen liefern — sonst wäre der Umschalttag ein sichtbarer Bruch.
      ...(qty !== null && price !== null
        ? { notional: qty * price, feeRate: PAPER_FEE_RATE }
        : {}),
    });
  }
  if (serie.length === 0 && closed.length === 0) return null;

  const returns = dailyReturns(serie);
  const dd = drawdown(serie);
  const ts = tradeStats(closed);
  const attr = attribution(closed);
  return {
    equityDays: serie.length,
    sharpe30: sharpe(returns.slice(-30)),
    sharpe90: sharpe(returns.slice(-90)),
    hwm: dd.hwm,
    maxDDPct: dd.maxDDPct,
    currentDDPct: dd.currentDDPct,
    trades: ts.n,
    wins: ts.wins,
    winRatePct: ts.winRatePct,
    profitFactor: ts.profitFactor,
    expectancy: ts.expectancy,
    avgWin: ts.avgWin,
    avgLoss: ts.avgLoss,
    bySymbol: attr.bySymbol,
    byClass: attr.byClass,
    exits: exitBreakdown(closed),
    costs: costProfile(closed),
    updatedAt: new Date().toISOString(),
  };
}

interface TradeStatsRow {
  symbol: string;
  asset_class: string | null;
  pnl: string | number;
  risk_exit: string | null;
  qty: string | number | null;
  price: string | number | null;
}

/** Wie im Scheduler: jüngste Trades für WinRate und Attribution. */
const STATS_TRADE_WINDOW = 500;

export function watchPortfolioStats(
  uid: string,
  cb: (stats: PortfolioStatsDoc | null) => void,
): () => void {
  return sbWatch<PortfolioStatsDoc | null>(
    {
      key: `pfStats:${uid}`,
      tables: [
        { table: 'equity_snapshots', filter: `user_id=eq.${uid}` },
        { table: 'trades', filter: `user_id=eq.${uid}` },
      ],
      load: () => computeStats(uid),
    },
    cb,
  );
}

export function watchStrategies(uid: string, cb: (rows: StrategyRow[]) => void): () => void {
  return sbWatch<StrategyRow[]>(
    {
      key: `strategies:${uid}`,
      tables: [{ table: 'strategies', filter: `user_id=eq.${uid}` }],
      load: async () => {
        const res = await sb()
          .from('strategies')
          .select('id,name,draft,compiled,status,mode,symbols,shadow,version,created_at,updated_at')
          .eq('user_id', uid)
          .order('updated_at', { ascending: false });
        return ((res.data as StrategyDbRow[] | null) ?? []).map(toStrategyRow);
      },
    },
    cb,
  );
}

export interface StrategyDbRow {
  id: string;
  name: string;
  draft: StrategyDoc['draft'];
  compiled: StrategyDoc['compiled'];
  status: 'draft' | 'published';
  mode: 'paper' | 'shadow';
  symbols: string[] | null;
  shadow: StrategyDoc['shadow'];
  version: number;
  created_at?: string;
  updated_at: string;
}

/**
 * Die Spalten heißen in Postgres snake_case, das Frontend kennt camelCase.
 * Die Umbenennung passiert hier an EINER Stelle — nicht in der Oberfläche,
 * sonst wäre der Backend-Wechsel dort sichtbar.
 */
export function toStrategyRow(r: StrategyDbRow): StrategyRow {
  const doc: StrategyDoc = {
    name: r.name,
    draft: r.draft,
    compiled: r.compiled,
    status: r.status,
    mode: r.mode,
    symbols: r.symbols ?? [],
    // Ohne `created_at` in der Auswahl fällt der Wert auf `updated_at`
    // zurück statt auf einen leeren String: Das Studio zeigt das Datum an,
    // und „01.01.1970" wäre eine sichtbare Falschaussage.
    createdAt: r.created_at ?? r.updated_at,
    updatedAt: r.updated_at,
  };
  if (r.shadow) doc.shadow = r.shadow;
  return { id: r.id, doc };
}
