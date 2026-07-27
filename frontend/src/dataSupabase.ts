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

import type { Quote } from '@autotrd/shared';
import { muxWatch } from './mux.js';
import { sb } from './supabase.js';
import { trackListener } from './listeners.js';
import type { ChartBar } from './chart.js';
import type {
  ForecastStatsDoc,
  IndicatorRow,
  MarketDocData,
  SignalRow,
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
