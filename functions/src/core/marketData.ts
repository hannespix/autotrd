/**
 * Marktdaten-Provider — Port von reference/scripts/market_data.py.
 *
 * Primär: Alpaca Market Data (nur konfiguriert + nur US-Aktien/ETF-Symbole),
 * sonst Fallback auf die Yahoo-Finance-Chart-API (v8, kein Key nötig) — sie
 * liefert Quote UND Tages-Bars in einem Request und versteht alle
 * yfinance-Symbolkonventionen des Katalogs (^GSPC, EURUSD=X, GC=F, BTC-USD).
 */

export interface DailyBar {
  date: string; // YYYY-MM-DD in der Börsen-Zeitzone des Symbols
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  changePct: number;
  bars: DailyBar[];
  source: 'alpaca' | 'yahoo';
}

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ALPACA_DATA_BASE = 'https://data.alpaca.markets';

function alpacaConfigured(): boolean {
  return Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
}

/** Alpaca kennt nur US-Aktien/ETFs — keine Indizes/Forex/Futures/Suffixe. */
function isAlpacaTradable(symbol: string): boolean {
  return /^[A-Z]+$/.test(symbol);
}

function fmtDate(tsSec: number, timeZone: string): string {
  // en-CA liefert YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(tsSec * 1000));
}

interface YahooChartResponse {
  chart: {
    result?: Array<{
      meta: {
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        exchangeTimezoneName?: string;
      };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

async function fetchYahoo(symbol: string, range: string): Promise<MarketSnapshot> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart.result?.[0];
  if (!result || json.chart.error) {
    throw new Error(`Yahoo ${symbol}: ${json.chart.error?.description ?? 'keine Daten'}`);
  }

  const tz = result.meta.exchangeTimezoneName ?? 'America/New_York';
  const quote = result.indicators.quote[0];
  const bars: DailyBar[] = [];
  const ts = result.timestamp ?? [];
  for (let i = 0; i < ts.length; i++) {
    const close = quote?.close[i];
    if (close === null || close === undefined) continue; // Feiertags-/Lückenzeilen
    bars.push({
      date: fmtDate(ts[i]!, tz),
      open: quote!.open[i] ?? close,
      high: quote!.high[i] ?? close,
      low: quote!.low[i] ?? close,
      close,
      volume: quote!.volume[i] ?? 0,
    });
  }
  if (bars.length === 0) throw new Error(`Yahoo ${symbol}: leere Bar-Serie`);

  const price = result.meta.regularMarketPrice ?? bars[bars.length - 1]!.close;
  const prev =
    result.meta.previousClose ??
    (bars.length >= 2 ? bars[bars.length - 2]!.close : price);
  const changePct = prev > 0 ? (price / prev - 1) * 100 : 0;

  return { symbol, price, changePct, bars, source: 'yahoo' };
}

/** Tiefe Tages-Historie (Chart-Audit 2): ~5 Jahre für nahtloses Rausscrollen. */
export async function getDeepDailyBars(symbol: string): Promise<DailyBar[]> {
  // range=max statt 5y (Zoom-Kontinuum 06.08.): die volle Yahoo-Historie —
  // bei alten Indizes Jahrzehnte. Einmalig je Symbol (deepBackfillV-Marker);
  // die Jahres-Chunks bleiben je ~250 Zeilen klein, nur ihre Anzahl wächst.
  return (await fetchYahoo(symbol, 'max')).bars;
}

/** Nur der aktuelle Kurs — leichtgewichtig fürs Kurz-Intervall (quoteNow)
 *  und die Katalog-Versorgung (Taschenmesser Teil 2); lastBar = jüngste
 *  Tageskerze aus demselben 5d-Fetch (keine zweite Anfrage nötig). */
export async function getQuickQuote(
  symbol: string,
): Promise<{ price: number; changePct: number; lastBar: DailyBar }> {
  const snap = await fetchYahoo(symbol, '5d');
  return { price: snap.price, changePct: snap.changePct, lastBar: snap.bars[snap.bars.length - 1]! };
}

/** Tages-Bars nach Jahr bündeln (ein Firestore-Doc je Jahr — Lese-Kosten). */
export function chunkBarsByYear(bars: DailyBar[]): Map<string, Record<string, Omit<DailyBar, 'date'>>> {
  const byYear = new Map<string, Record<string, Omit<DailyBar, 'date'>>>();
  for (const bar of bars) {
    const year = bar.date.slice(0, 4);
    const days = byYear.get(year) ?? {};
    const { date: _d, ...ohlcv } = bar;
    days[bar.date] = ohlcv;
    byYear.set(year, days);
  }
  return byYear;
}

export interface IntradayBar {
  /** UNIX-Sekunden (UTC) des Bar-Starts. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Raster der 5-min-Serie in Sekunden — Bar-Starts sind Vielfache davon. */
export const INTRADAY_GRID_SEC = 300;

/**
 * Yahoo hängt bei OFFENEN Märkten einen Pseudo-Bar an, dessen Zeitstempel die
 * AKTUELLE UHRZEIT ist statt eines Bar-Starts — gemessen am 28.07.:
 * BTC-USD `1785224649` (%300 = 249), EURUSD=X `%300 = 200`, GC=F `%300 = 245`;
 * bei geschlossenen Märkten (AAPL, ^GSPC) liegt dagegen JEDER Bar auf dem
 * Raster. Er ist kein 5-min-Bar, sondern der Live-Kurs in Bar-Verkleidung.
 *
 * Er muss raus, und zwar an der Quelle: `runIntradayForecast` nimmt den
 * letzten Bar als `baseT`, und alle Prognosepunkte sind `baseT + k·300`. Ein
 * off-grid `baseT` verschiebt die GANZE Prognose neben das Kursraster — kein
 * einziger Punkt findet je einen realisierten Close. Genau das war der Befund
 * vom 28.07.: `intradayScored: 0` bei `unrealized: 150`. Weil Shadow-Prognosen
 * nur bei OFFENEM Markt entstehen, traf es nicht einzelne, sondern restlos
 * alle — 150 von 150.
 *
 * Der Preis dafür ist ein bis zu 5 Minuten alter letzter Close. Das ist der
 * richtige Preis: Signale und Prognosen sollen auf ABGESCHLOSSENEN Bars
 * stehen, nicht auf einem halben, der sich noch bewegt (Repainting). Der
 * Live-Kurs kommt ohnehin aus `quote`.
 */
export function isGridBar(t: number, stepSec: number = INTRADAY_GRID_SEC): boolean {
  return Number.isFinite(t) && t % stepSec === 0;
}

/** 5-Minuten-Bars je Handelstag (ET-Datum) — Chart-Feedback 24.07.:
 *  „minutengenaue Daten". Yahoo liefert 5m für die letzten ~5 Handelstage. */
export async function getIntradayBars(symbol: string): Promise<Map<string, IntradayBar[]>> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=5d&interval=5m`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
  if (!res.ok) throw new Error(`Yahoo intraday ${symbol}: HTTP ${res.status}`);
  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart.result?.[0];
  if (!result || json.chart.error) {
    throw new Error(`Yahoo intraday ${symbol}: ${json.chart.error?.description ?? 'keine Daten'}`);
  }
  const tz = result.meta.exchangeTimezoneName ?? 'America/New_York';
  const quote = result.indicators.quote[0];
  const ts = result.timestamp ?? [];
  const byDay = new Map<string, IntradayBar[]>();
  for (let i = 0; i < ts.length; i++) {
    const close = quote?.close[i];
    if (close === null || close === undefined) continue;
    if (!isGridBar(ts[i]!)) continue; // Yahoos „Jetzt"-Pseudo-Bar, s. isGridBar
    const day = fmtDate(ts[i]!, tz);
    const list = byDay.get(day) ?? [];
    list.push({
      t: ts[i]!,
      o: quote!.open[i] ?? close,
      h: quote!.high[i] ?? close,
      l: quote!.low[i] ?? close,
      c: close,
      v: quote!.volume[i] ?? 0,
    });
    byDay.set(day, list);
  }
  return byDay;
}

/* ── Batch-Beobachtung des ganzen Katalogs (Owner-Frage 28.07.) ─────────────
 * „kann das tool nicht alles immer parallel beobachten? markt ist ja dynamisch
 * und ändert sich stetig!" — konnte es nicht: `getQuickQuote` macht EINEN
 * Yahoo-Fetch je Symbol, deshalb rotierte die Versorgung in 15er-Häppchen mit
 * einem 50-min-Frische-Gate durch den Katalog. Ein Symbol war damit im
 * schlechtesten Fall eine Stunde alt.
 *
 * Gemessen am 28.07. (Katalog = 166 Symbole):
 *   v7/finance/quote  … HTTP 401 (query1 UND query2)
 *   v8/finance/spark  … HTTP 200, mehrere Symbole je Request
 *   Grenze: 20 Symbole ok, ab 22 kommt HTTP 400
 *   → 9 Requests, 165/166 Symbole, 2,5 s
 *
 * Damit ist der ganze Katalog bei JEDEM 5-min-Scan frisch — 9 statt 166
 * Fetches. Spark liefert nur Closes (kein OHLCV); für Kurs + Tagesänderung
 * reicht das genau, die exakten Tageskerzen kommen weiter aus der Chart-API.
 */
const SPARK_URL = 'https://query1.finance.yahoo.com/v8/finance/spark';
/** Gemessene harte Grenze ist 21; 20 lässt Luft, ohne Requests zu verschenken. */
export const SPARK_CHUNK = 20;

export interface SparkQuote {
  symbol: string;
  price: number;
  changePct: number;
  /** Zeitstempel des letzten RASTER-Bars (0, wenn keiner geliefert wurde). */
  lastGridT: number;
}

export interface SparkEntry {
  symbol?: string;
  timestamp?: number[];
  close?: (number | null)[];
  previousClose?: number;
  chartPreviousClose?: number;
}

/**
 * Kurse für viele Symbole in wenigen Requests. Chunks laufen parallel; ein
 * fehlgeschlagener Chunk kostet nur seine 20 Symbole, nie den ganzen Lauf.
 *
 * Der letzte Spark-Punkt ist bei offenen Märkten derselbe off-grid
 * „Jetzt"-Punkt wie in der Chart-API (s. `isGridBar`) — als PREIS ist er
 * richtig und gewollt, nur als Bar-Zeitstempel wäre er falsch. `lastGridT`
 * meldet deshalb den letzten echten Rasterpunkt separat.
 */
export async function getSparkBatch(symbols: string[]): Promise<Map<string, SparkQuote>> {
  const out = new Map<string, SparkQuote>();
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += SPARK_CHUNK) {
    chunks.push(symbols.slice(i, i + SPARK_CHUNK));
  }

  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const url =
        `${SPARK_URL}?symbols=${chunk.map(encodeURIComponent).join(',')}` +
        `&range=1d&interval=5m`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
      if (!res.ok) throw new Error(`Yahoo spark: HTTP ${res.status} (${chunk.length} Symbole)`);
      return (await res.json()) as Record<string, SparkEntry>;
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const [symbol, entry] of Object.entries(r.value)) {
      const q = parseSparkEntry(symbol, entry);
      if (q) out.set(symbol, q);
    }
  }
  return out;
}

/**
 * TAGES-Closes für viele Symbole in wenigen Requests.
 *
 * Derselbe Spark-Endpoint, nur mit `interval=1d` — gemessen am 28.07.:
 * `range=1y` liefert ~251 Tageswerte je Symbol, `range=2y` ~500, weiterhin
 * 20 Symbole pro Request.
 *
 * Das entscheidet, wie schnell das Momentum-Ranking den Katalog überhaupt
 * bewerten kann. Vorher las `runMomentum` die Historie symbolweise aus
 * Firestore und holte fehlende über je einen Chart-Fetch nach — gedeckelt auf
 * 20 Symbole pro TAG. Bei 166 Katalog-Symbolen hätte der erste vollständige
 * Ranglisten-Lauf damit rund neun Tage gebraucht, und bis dahin rankte das
 * System nur die Handvoll Symbole, die zufällig schon Historie hatte.
 * „Breit bewerten, schmal beobachten" war also bis dahin bloß eine Absicht.
 *
 * Mit dem Bündel sind es 9 Requests für den ganzen Katalog — der erste Lauf
 * bewertet sofort alles.
 */
export async function getSparkDailyCloses(
  symbols: string[],
  range = '2y',
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += SPARK_CHUNK) {
    chunks.push(symbols.slice(i, i + SPARK_CHUNK));
  }

  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const url =
        `${SPARK_URL}?symbols=${chunk.map(encodeURIComponent).join(',')}` +
        `&range=${range}&interval=1d`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
      if (!res.ok) throw new Error(`Yahoo spark 1d: HTTP ${res.status} (${chunk.length} Symbole)`);
      return (await res.json()) as Record<string, SparkEntry>;
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const [symbol, entry] of Object.entries(r.value)) {
      const closes = sparkCloses(entry);
      if (closes.length > 0) out.set(symbol, closes);
    }
  }
  return out;
}

/**
 * Die Close-Reihe eines Spark-Eintrags, bereinigt.
 *
 * Lücken (Feiertage, Handelspausen) kommen als `null` und fallen raus statt
 * als 0 zu zählen: Eine 0 im Kursverlauf ist kein fehlender Wert, sondern ein
 * Kurssturz auf null — sie würde jede Rendite-Rechnung darüber vergiften und
 * das Symbol im Momentum-Ranking auf den letzten Platz katapultieren.
 */
export function sparkCloses(entry: SparkEntry | undefined): number[] {
  return (entry?.close ?? []).filter((c): c is number => typeof c === 'number' && c > 0);
}

/** Ein Spark-Eintrag → Quote. Exportiert, damit die Zerlegung testbar ist,
 *  ohne Yahoo zu rufen. Liefert null, wenn kein brauchbarer Close dabei ist. */
export function parseSparkEntry(symbol: string, entry: SparkEntry | undefined): SparkQuote | null {
  const closes = entry?.close ?? [];
  const ts = entry?.timestamp ?? [];
  let price = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (typeof c === 'number' && c > 0) {
      price = c;
      break;
    }
  }
  if (price <= 0) return null;

  let lastGridT = 0;
  for (let i = ts.length - 1; i >= 0; i--) {
    const t = ts[i];
    if (typeof t === 'number' && isGridBar(t)) {
      lastGridT = t;
      break;
    }
  }

  const prev = entry?.previousClose ?? entry?.chartPreviousClose ?? 0;
  return {
    symbol,
    price,
    changePct: prev > 0 ? (price / prev - 1) * 100 : 0,
    lastGridT,
  };
}

interface AlpacaBarsResponse {
  bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
}

async function fetchAlpaca(symbol: string, days: number): Promise<MarketSnapshot> {
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  };
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const url =
    `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars` +
    `?timeframe=1Day&start=${encodeURIComponent(start)}&limit=1000&adjustment=split&feed=iex`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Alpaca ${symbol}: HTTP ${res.status}`);
  const json = (await res.json()) as AlpacaBarsResponse;
  const bars: DailyBar[] = (json.bars ?? []).map((b) => ({
    date: b.t.slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
  if (bars.length < 2) throw new Error(`Alpaca ${symbol}: zu wenig Bars`);
  const price = bars[bars.length - 1]!.close;
  const prev = bars[bars.length - 2]!.close;
  return {
    symbol,
    price,
    changePct: prev > 0 ? (price / prev - 1) * 100 : 0,
    bars,
    source: 'alpaca',
  };
}

/**
 * Quote + Tages-Bars für ein Symbol. `range` in Yahoo-Notation ('3mo', '1y').
 * Alpaca (falls konfiguriert) für US-Equities, sonst/bei Fehlern Yahoo.
 */
export async function getMarketSnapshot(symbol: string, range = '3mo'): Promise<MarketSnapshot> {
  if (alpacaConfigured() && isAlpacaTradable(symbol)) {
    try {
      const days = range === '1y' ? 380 : range === '6mo' ? 190 : 100;
      return await fetchAlpaca(symbol, days);
    } catch {
      // Fallback unten — Yahoo kann alle Symbole
    }
  }
  return fetchYahoo(symbol, range);
}
