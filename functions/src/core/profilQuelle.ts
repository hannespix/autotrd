/**
 * Finnhub-Adapter (Task 19, Teil 2) — die EINE Stelle, die den lizenzierten
 * Anbieter anspricht. Bewusst nicht in marketData.ts: Dort pinnt ein Wächter
 * Yahoo als einzige Kursquelle; Profile sind eine andere Sache.
 *
 * Drei Abrufe je Symbol (Profil, Kennzahlen, Gewinntermine), Gratis-Tarif
 * 60 Abrufe/min — der Aufrufer hält den Abstand (`PROFIL_ABSTAND_MS`).
 * Der Schlüssel wandert nur in die URL des Abrufs, nie in Logs oder Fehler.
 */
import {
  type FinnhubEarning,
  type FinnhubMetric,
  type FinnhubProfile2,
  type Profil,
  type ProfilOptionen,
  finnhubSymbol,
  profilAus,
} from '../../../shared/src/index.js';

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BASE = 'https://finnhub.io/api/v1';
/** Abruf-Timeout je Anfrage. */
export const PROFIL_TIMEOUT_MS = 8000;

export class ProfilQuelleFehler extends Error {
  constructor(public readonly grund: 'rate_limit' | 'kein_zugriff' | 'http' | 'timeout', public readonly status?: number) {
    super(`finnhub_${grund}${status ? `_${status}` : ''}`);
  }
}

async function hole(fetchImpl: FetchLike, pfad: string, key: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROFIL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE}/${pfad}&token=${encodeURIComponent(key)}`, { signal: ctrl.signal });
    if (res.status === 429) throw new ProfilQuelleFehler('rate_limit', 429);
    if (res.status === 401 || res.status === 403) throw new ProfilQuelleFehler('kein_zugriff', res.status);
    if (!res.ok) throw new ProfilQuelleFehler('http', res.status);
    return await res.json();
  } catch (err) {
    if (err instanceof ProfilQuelleFehler) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new ProfilQuelleFehler('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Zeitraum des Gewinnkalenders: ab heute, ein halbes Jahr voraus. */
export const GEWINNTERMIN_TAGE = 180;

const tagPlus = (heute: string, tage: number): string =>
  new Date(Date.parse(`${heute}T00:00:00Z`) + tage * 86_400_000).toISOString().slice(0, 10);

/**
 * Profil eines Symbols — drei Abrufe, pure Zusammenstellung. Wirft
 * ProfilQuelleFehler bei Drossel/Zugriff/HTTP, damit der Lauf das als GRUND
 * ins Stand-Dokument schreibt statt still leer zu bleiben.
 */
export async function holeProfil(
  symbol: string,
  key: string,
  heute: string,
  fetchImpl: FetchLike,
  updatedAt = new Date().toISOString(),
  opt: ProfilOptionen = {},
): Promise<Profil> {
  const sym = encodeURIComponent(finnhubSymbol(symbol));
  const profile2 = (await hole(fetchImpl, `stock/profile2?symbol=${sym}`, key)) as FinnhubProfile2 | null;
  const metricRoh = (await hole(fetchImpl, `stock/metric?symbol=${sym}&metric=all`, key)) as { metric?: FinnhubMetric } | null;
  const kalender = (await hole(
    fetchImpl,
    `calendar/earnings?symbol=${sym}&from=${heute}&to=${tagPlus(heute, GEWINNTERMIN_TAGE)}`,
    key,
  )) as { earningsCalendar?: FinnhubEarning[] } | null;
  return profilAus(
    profile2 && typeof profile2 === 'object' ? profile2 : null,
    metricRoh?.metric && typeof metricRoh.metric === 'object' ? metricRoh.metric : null,
    Array.isArray(kalender?.earningsCalendar) ? kalender.earningsCalendar : [],
    heute,
    updatedAt,
    opt,
  );
}
