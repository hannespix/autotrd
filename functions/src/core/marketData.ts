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
  return (await fetchYahoo(symbol, '5y')).bars;
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
