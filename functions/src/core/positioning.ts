/**
 * Positionierungs-Daten von Kraken Futures (Owner-Auftrag 04.08.).
 *
 * ── Warum Kraken und nicht Binance ─────────────────────────────────────────
 *
 * Der erste Entwurf lief auf Binance — die größte Perpetual-Börse, deren
 * Funding Rate der Rest des Marktes einpreist. Der Live-Test hat ihn
 * verworfen, bevor er deployt wurde:
 *
 *   "Service unavailable from a restricted location according to
 *    'b. Eligibility' in https://www.binance.com/en/terms."
 *
 * Binance sperrt US-IPs, und die Functions laufen in us-central1. Der Code
 * hätte gebaut, deployt und still nie ein einziges Datum bekommen — der
 * Heartbeat hätte „keine Gelegenheit" gemeldet, wo in Wahrheit „kein Zugang"
 * stand. Bybit scheitert am selben Geoblock (CloudFront), OKX antwortet zwar,
 * verlangt aber einen Aufruf je Symbol.
 *
 * Kraken Futures ist US-reguliert, erreichbar — und für unseren Zweck sogar
 * besser: EIN Aufruf auf `/derivatives/api/v3/tickers` liefert alle ~274
 * Perpetuals samt Funding Rate, Open Interest UND 24-Stunden-Änderung. Ein
 * Request je Lauf, kein Schlüssel, keine Kosten.
 *
 * ── Die zwei Umrechnungen, die man kennen muss ─────────────────────────────
 *
 * 1. Krakens `fundingRate` ist ABSOLUT (in Quote-Währung je Kontrakt), nicht
 *    relativ. Die vergleichbare Rate ist `fundingRate / markPrice`.
 * 2. Kraken bucht STÜNDLICH, die Marktkonvention (und die Schwellen in
 *    shared/positioning.ts) rechnen in 8-Stunden-Perioden. Deshalb × 8.
 *
 * Ohne beides wären die Zahlen um Größenordnungen daneben — und zwar
 * plausibel aussehend daneben, was schlimmer ist als offensichtlich falsch.
 * Die Gegenprobe am 04.08.: BTC 6,4 % p. a., ETH 9,0 %, SOL 11,9 % — genau
 * die Niveaus, die man in einem freundlichen Markt erwartet.
 */

import { logger } from 'firebase-functions/v2';
import { positioningState, type PositioningReading } from '../../../shared/src/index.js';

const FETCH_TIMEOUT_MS = 8000;
const KRAKEN_TICKERS = 'https://futures.kraken.com/derivatives/api/v3/tickers';
/** Kraken bucht stündlich, die Marktkonvention rechnet in 8-h-Perioden. */
const STUNDEN_JE_PERIODE = 8;

interface KrakenTicker {
  symbol?: string;
  tag?: string;
  markPrice?: number;
  fundingRate?: number;
  openInterest?: number;
  change24h?: number;
  suspended?: boolean;
}

/**
 * `BTC-USD` → `PF_XBTUSD`. Kraken führt Bitcoin traditionell als XBT (der
 * ISO-4217-konforme Code für nicht-staatliche Währungen) — eine Abbildung,
 * die man einmal falsch macht und dann lange sucht.
 */
export function krakenSymbol(katalogSymbol: string): string | null {
  const m = /^([A-Z0-9]+)-USD$/.exec(katalogSymbol);
  if (!m) return null;
  const basis = m[1] === 'BTC' ? 'XBT' : m[1];
  return `PF_${basis}USD`;
}

/**
 * Alle Perpetual-Ticker in EINEM Aufruf.
 *
 * Ein Ausfall ist kein Fehlerfall, sondern eine leere Map: Der Aufrufer
 * schreibt dann eine Abdeckung von 0 in den Heartbeat — sichtbar, statt
 * still. Ein fremder Börsen-Endpunkt darf einen Handelslauf nie gefährden.
 */
export async function fetchKrakenTickers(): Promise<Map<string, KrakenTicker>> {
  const out = new Map<string, KrakenTicker>();
  try {
    const res = await fetch(KRAKEN_TICKERS, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return out;
    const data = (await res.json()) as { tickers?: KrakenTicker[] };
    for (const t of data.tickers ?? []) {
      if (t.tag === 'perpetual' && typeof t.symbol === 'string' && t.suspended !== true) {
        out.set(t.symbol, t);
      }
    }
  } catch {
    // Netzfehler, Timeout, Rate-Limit — alles derselbe Fall: keine Daten.
  }
  return out;
}

/**
 * Positionierung für die übergebenen Katalog-Symbole messen.
 *
 * `oiVorher` sind die Open-Interest-Werte des VORHERIGEN Laufs (aus
 * meta/positioning). Kraken liefert nur den Momentanwert, und ein
 * Momentanwert ohne Vergleich sagt nichts — die Aussage steckt in der
 * Veränderung. Deshalb persistiert der Aufrufer die Werte und reicht sie
 * beim nächsten Lauf wieder herein; beim allerersten Lauf fehlt der
 * Vergleich schlicht, und die OI-Regeln greifen dann nicht.
 */
export async function fetchPositioning(
  symbole: readonly string[],
  oiVorher: ReadonlyMap<string, number>,
): Promise<{ readings: Map<string, PositioningReading>; oiJetzt: Map<string, number> }> {
  const readings = new Map<string, PositioningReading>();
  const oiJetzt = new Map<string, number>();
  const kandidaten = symbole.filter((s) => krakenSymbol(s) !== null);
  if (kandidaten.length === 0) return { readings, oiJetzt };

  const ticker = await fetchKrakenTickers();
  if (ticker.size === 0) {
    logger.warn('Positionierung: Kraken-Ticker leer — Endpunkt nicht erreichbar?');
    return { readings, oiJetzt };
  }

  for (const sym of kandidaten) {
    const t = ticker.get(krakenSymbol(sym)!);
    if (!t) continue; // kein Perpetual bei Kraken — kein Fehler
    const mark = t.markPrice;
    // Absolut → relativ → 8-h-Konvention (siehe Dateikopf).
    const rate =
      typeof t.fundingRate === 'number' && typeof mark === 'number' && mark > 0
        ? (t.fundingRate / mark) * STUNDEN_JE_PERIODE
        : null;
    const oi = typeof t.openInterest === 'number' && t.openInterest > 0 ? t.openInterest : null;
    if (oi !== null) oiJetzt.set(sym, oi);
    if (rate === null && oi === null) continue;

    readings.set(
      sym,
      positioningState({
        fundingRate: rate,
        openInterest: oi,
        openInterestPrev: oiVorher.get(sym) ?? null,
        priceChangePct: typeof t.change24h === 'number' ? t.change24h : null,
      }),
    );
  }
  return { readings, oiJetzt };
}
