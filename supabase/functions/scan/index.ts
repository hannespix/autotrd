/**
 * scan — der zentrale Marktdaten-Scan als Supabase Edge Function (MS3).
 *
 * Ersetzt den Marktdaten-Teil von functions/src/scheduled/scanMarket.ts.
 * Läuft in Deno, wird von pg_cron alle 5 Minuten angestoßen und schreibt
 * geteilte Daten nach market_symbols / bars / bars_5m / signals — einmal für
 * ALLE Nutzer, genau wie bisher (ARCHITECTURE §2).
 *
 * WICHTIG — was hier NICHT neu geschrieben wurde: Die gesamte Rechenlogik
 * (RSI, MACD, Bollinger, Konfluenz, Katalog) kommt unverändert aus
 * `shared/` und läuft in Deno, weil sie keine Node-Bibliotheken benutzt.
 * Genau deshalb ist die Migration überhaupt in dieser Größenordnung
 * machbar: Der Wertkern des Projekts wandert unangetastet mit, inklusive
 * seiner Golden-Tests. Portiert wurde nur die Datenbeschaffung (fetch statt
 * Node-Client) und das Schreiben (SQL statt Firestore).
 *
 * Der Nutzer-Handel (Trades, Positionen) folgt im nächsten Paket; dieser
 * Scan versorgt zuerst die Ansichten mit Daten, sonst bliebe die App leer.
 */

import {
  DEFAULT_STRATEGY,
  allSymbols,
  classify,
  computeSignal,
  marketOpenForClass,
  resolveName,
} from '../_shared/mod.ts';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Snapshot {
  symbol: string;
  price: number;
  changePct: number;
  bars: Bar[];
}

/** YYYY-MM-DD in der Börsen-Zeitzone (en-CA liefert genau dieses Format). */
function fmtDate(tsSec: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(tsSec * 1000));
}

/**
 * Kurse von Yahoo (kein Schlüssel nötig, kennt alle Symbolkonventionen des
 * Katalogs: ^GSPC, EURUSD=X, GC=F, BTC-USD). Identische Quelle wie bisher —
 * damit bleiben die Kurse über die Umstellung hinweg vergleichbar.
 */
async function fetchYahoo(symbol: string, range = '6mo', interval = '1d'): Promise<Snapshot> {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (autotrd)' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r || json?.chart?.error) {
    throw new Error(`Yahoo ${symbol}: ${json?.chart?.error?.description ?? 'keine Daten'}`);
  }
  const tz = r.meta?.exchangeTimezoneName ?? 'America/New_York';
  const q = r.indicators?.quote?.[0];
  const ts: number[] = r.timestamp ?? [];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q?.close?.[i];
    if (close === null || close === undefined) continue; // Feiertags-/Lückenzeilen
    bars.push({
      date: fmtDate(ts[i], tz),
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  if (bars.length === 0) throw new Error(`Yahoo ${symbol}: leere Bar-Serie`);
  const price = r.meta?.regularMarketPrice ?? bars[bars.length - 1].close;
  const prev = r.meta?.previousClose ?? (bars.length >= 2 ? bars[bars.length - 2].close : price);
  return { symbol, price, changePct: prev > 0 ? (price / prev - 1) * 100 : 0, bars };
}

/** Schreibzugriff über PostgREST mit dem Server-Schlüssel (umgeht RLS). */
function db(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${Deno.env.get('SUPABASE_URL')}/rest/v1/${path}`;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** upsert = idempotent: Ein zweiter Scan derselben Minute überschreibt. */
async function upsert(table: string, rows: unknown[], onConflict: string): Promise<void> {
  if (rows.length === 0) return;
  const res = await db(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
}

async function scanSymbol(symbol: string, scanId: string): Promise<void> {
  const snap = await fetchYahoo(symbol);
  const closes = snap.bars.map((b) => b.close);
  // Dieselbe Funktion, die auch die Engine benutzt — kein zweiter
  // Rechenweg, keine Abweichung zwischen Anzeige und Handelsentscheidung.
  const sig = computeSignal(
    closes, snap.price, DEFAULT_STRATEGY.indicators, DEFAULT_STRATEGY.signals,
  );
  const now = new Date().toISOString();

  await upsert(
    'market_symbols',
    [{
      symbol,
      name: resolveName(symbol) ?? symbol,
      asset_class: classify(symbol),
      quote_price: snap.price,
      quote_change_pct: Math.round(snap.changePct * 10000) / 10000,
      quote_updated_at: now,
      updated_at: now,
    }],
    'symbol',
  );

  // Bars: beim ersten Mal die ganze Serie, danach nur die letzten Tage —
  // sonst wären es hunderte Zeilen alle fünf Minuten (Schreibdisziplin wie
  // im bisherigen Scan).
  const existing = await db(`bars?symbol=eq.${encodeURIComponent(symbol)}&select=day&limit=1`);
  const hasBars = existing.ok && ((await existing.json()) as unknown[]).length > 0;
  const slice = hasBars ? snap.bars.slice(-3) : snap.bars;
  await upsert(
    'bars',
    slice.map((b) => ({
      symbol, day: b.date, open: b.open, high: b.high, low: b.low,
      close: b.close, volume: Math.round(b.volume),
    })),
    'symbol,day',
  );

  // Signale sind ein Verlauf, kein Zustand — deshalb INSERT statt upsert.
  const sigRes = await db('signals', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{
      symbol,
      scan_id: scanId,
      direction: sig.direction,
      confluence: Math.max(sig.buyVotes, sig.sellVotes),
      price: snap.price,
      detail: {
        rsi: sig.snapshot.rsi,
        macdHist: sig.snapshot.macd?.histogram ?? null,
        bbPct: sig.snapshot.bollinger?.pctB ?? null,
        votes: sig.votes,
      },
    }]),
  });
  if (!sigRes.ok) throw new Error(`signals: HTTP ${sigRes.status} ${await sigRes.text()}`);
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const scanId = new Date().toISOString().slice(0, 16) + 'Z';

  // Marktzeiten-Gate je Anlageklasse: Krypto läuft durch, Aktien nur zur
  // US-Handelszeit. Spart Aufrufe und hält die Kurse ehrlich (kein
  // „aktueller" Kurs von gestern Abend).
  const symbols = allSymbols().filter(
    (s) => force || marketOpenForClass(classify(s), new Date()),
  );

  const errors: Record<string, string> = {};
  let ok = 0;
  // Sequenziell mit kleiner Pause: Yahoo drosselt parallele Anfragen.
  for (const symbol of symbols.slice(0, 60)) {
    try {
      await scanSymbol(symbol, scanId);
      ok++;
    } catch (e) {
      errors[symbol] = String((e as Error).message ?? e);
    }
  }

  const health = {
    key: 'health',
    value: {
      lastRunAt: new Date().toISOString(),
      scanId,
      symbolsOk: ok,
      symbolsFailed: Object.keys(errors).length,
      durationMs: Date.now() - started,
      source: 'supabase-edge',
      lastError: Object.values(errors)[0] ?? null,
    },
    updated_at: new Date().toISOString(),
  };
  await upsert('meta', [health], 'key');

  return new Response(JSON.stringify({ scanId, ok, errors }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
