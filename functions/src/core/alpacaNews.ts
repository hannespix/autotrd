/**
 * Alpaca-Nachrichten — Stufe 1 der KI-Kaskade (05.10.): das FUNDAMENT.
 *
 * Hier wird nichts entschieden und nichts gehandelt. Dieses Modul holt den
 * Nachrichtenstrom, den Alpaca mit denselben Plattform-Schlüsseln liefert,
 * mit denen schon das Universum synchronisiert wird (Benzinga-Meldungen mit
 * maschinell zugeordneten Symbolen), und macht daraus Datensätze, die man
 * später ehrlich auswerten kann.
 *
 * ── Warum zuerst die Messung und dann die KI ──────────────────────────────
 *
 * Der Red-Team-Auftrag zur Kaskade (05.10.) war eindeutig: Ohne drei
 * unveränderliche Zeitstempel je Meldung ist jede spätere Trefferquote
 * Einbildung.
 *
 *   - `publishedAt`  — wann Alpaca die Meldung datiert (`created_at`);
 *   - `firstSeenAt`  — wann WIR sie zum ersten Mal hatten;
 *   - `decidedAt`    — wann die Kaskade entschieden hat (Stufe 2).
 *
 * Bewertet werden darf eine Reaktion nur ab `firstSeenAt`: Eine Meldung, die
 * um 09:31 erschien und die wir um 09:44 sahen, hätten wir frühestens um
 * 09:44 handeln können. Wer ab `publishedAt` misst, rechnet sich die
 * dreizehn Minuten schön, in denen der Kurs schon gelaufen ist — das ist
 * Lookahead (CLAUDE.md §5) in anderer Verkleidung.
 *
 * Aus demselben Grund steht neben jeder Meldung der Kurs, den wir beim
 * ersten Sehen hatten (`kurseGesehen`, mit Zeitstempel des Trades). Nur so
 * lässt sich später sagen, ob eine Nachricht beim Sehen schon eingepreist
 * war.
 *
 * ── Schlüssel ─────────────────────────────────────────────────────────────
 *
 * Es gelten dieselben Regeln wie an der Broker-Grenze: Schlüssel nur aus der
 * Umgebung (`envSchluessel`), jeder Fehlertext läuft durch
 * `keineSchluesselImText`, bevor er irgendwo landet.
 */

import { AlpacaFehler, keineSchluesselImText, vonAlpacaSymbol, zuAlpacaSymbol } from './alpacaBroker.js';
import type { AlpacaSchluessel, FetchLike } from './alpacaBroker.js';

export const ALPACA_DATEN_BASIS = 'https://data.alpaca.markets';

/** Alpacas Höchstwert je Seite. */
export const NACHRICHTEN_SEITE = 50;
/**
 * So viele Seiten höchstens je Lauf. 500 Meldungen in fünf Minuten kommen
 * nicht vor; der Deckel fängt den ersten Lauf und einen Rückstand nach einem
 * Ausfall ab. Was darüber liegt, holt der nächste Lauf — der Cursor bleibt
 * dann an der letzten gesehenen Meldung stehen (aufsteigend sortiert).
 */
export const NACHRICHTEN_MAX_SEITEN = 10;
/**
 * Überlappung je Lauf. Alpaca reicht Meldungen gelegentlich mit einem
 * `created_at` nach, das vor dem Abrufzeitpunkt des Vorlaufs liegt. Doppelt
 * gelesene Meldungen kosten nur einen Lesezugriff — gespeichert wird jede
 * genau einmal (s. `nachrichtenSammeln`).
 */
export const NACHRICHTEN_UEBERLAPPUNG_MS = 30 * 60 * 1000;
/** Ohne Cursor (erster Lauf): so weit zurück. */
export const NACHRICHTEN_ERSTER_RUECKBLICK_MS = 2 * 60 * 60 * 1000;
/** Längenbegrenzung der gespeicherten Texte. */
export const SCHLAGZEILE_MAX = 300;
export const ZUSAMMENFASSUNG_MAX = 600;
/** Sammelmeldungen („Top-Mover des Tages") nennen Dutzende Symbole — gekappt. */
export const SYMBOLE_MAX = 30;

export interface MarktNachricht {
  /** Dokument-ID: `alp-<Alpaca-ID>` — global eindeutig, idempotent. */
  id: string;
  alpacaId: string;
  schlagzeile: string;
  zusammenfassung: string;
  url: string;
  /** Herausgeber laut Alpaca (meist `benzinga`). */
  herausgeber: string;
  /** Nur Symbole, die wir kennen (Katalog ∪ Universum), in UNSERER Schreibweise. */
  symbole: string[];
  /** Wie viele Symbole Alpaca insgesamt nannte — Sammelmeldungen erkennbar. */
  symboleGenannt: number;
  publishedAt: string;
  aktualisiertAt: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Kürzen ohne halbes Wort am Ende, wo es geht; Leerraum zusammenziehen. */
export function kuerze(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const schnitt = t.slice(0, max - 1);
  const leer = schnitt.lastIndexOf(' ');
  return `${leer > max * 0.6 ? schnitt.slice(0, leer) : schnitt}…`;
}

const isoOderNull = (v: unknown): string | null => {
  const ms = Date.parse(text(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Eine Rohmeldung von Alpaca in unseren Datensatz übersetzen — pur.
 *
 * `null`, wenn die Meldung unbrauchbar ist (keine ID, keine Schlagzeile,
 * kein Datum) oder KEIN Symbol nennt, das wir handeln könnten. Die Kaskade
 * entscheidet je Symbol; eine Meldung ohne handelbares Symbol hätte nur
 * Speicher gekostet.
 */
export function normalisiereNachricht(
  roh: unknown,
  bekannt: (symbol: string) => boolean,
): MarktNachricht | null {
  const r = (roh ?? {}) as Record<string, unknown>;
  const idRoh = r['id'];
  const alpacaId =
    typeof idRoh === 'number' && Number.isFinite(idRoh)
      ? String(Math.trunc(idRoh))
      : typeof idRoh === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(idRoh)
        ? idRoh
        : '';
  if (!alpacaId) return null;
  const schlagzeile = kuerze(text(r['headline']), SCHLAGZEILE_MAX);
  if (!schlagzeile) return null;
  const publishedAt = isoOderNull(r['created_at']);
  if (!publishedAt) return null;

  const genannt = Array.isArray(r['symbols']) ? (r['symbols'] as unknown[]).filter((s) => typeof s === 'string') : [];
  const symbole: string[] = [];
  for (const s of genannt as string[]) {
    const unser = vonAlpacaSymbol(s);
    if (bekannt(unser) && !symbole.includes(unser)) symbole.push(unser);
    if (symbole.length >= SYMBOLE_MAX) break;
  }
  if (symbole.length === 0) return null;

  return {
    id: `alp-${alpacaId}`,
    alpacaId,
    schlagzeile,
    zusammenfassung: kuerze(text(r['summary']), ZUSAMMENFASSUNG_MAX),
    url: text(r['url']).slice(0, 500),
    herausgeber: kuerze(text(r['source']), 40),
    symbole,
    symboleGenannt: genannt.length,
    publishedAt,
    aktualisiertAt: isoOderNull(r['updated_at']) ?? publishedAt,
  };
}

/** Ab wann dieser Lauf fragt: Cursor minus Überlappung, ohne Cursor 2 h zurück. */
export function abrufStart(cursorIso: string | null, jetztMs: number): string {
  const cursorMs = cursorIso ? Date.parse(cursorIso) : NaN;
  const basis = Number.isFinite(cursorMs) && cursorMs <= jetztMs
    ? cursorMs - NACHRICHTEN_UEBERLAPPUNG_MS
    : jetztMs - NACHRICHTEN_ERSTER_RUECKBLICK_MS;
  return new Date(basis).toISOString();
}

/**
 * Wohin der Cursor nach einem ERFOLGREICHEN Lauf rückt.
 *
 * Vollständig gelesen → bis zum Abrufzeitpunkt. Abgeschnitten (Seitendeckel)
 * → nur bis zur jüngsten tatsächlich gelesenen Meldung; der Rest kommt im
 * nächsten Lauf. Nie rückwärts: Ein Cursor, der zurückspringt, liest
 * dieselben Stunden immer wieder.
 */
export function naechsterCursor(
  alterCursor: string | null,
  abrufAt: string,
  abgeschnitten: boolean,
  juengsteGelesen: string | null,
): string {
  const ziel = abgeschnitten ? (juengsteGelesen ?? alterCursor ?? abrufAt) : abrufAt;
  if (alterCursor && Date.parse(alterCursor) > Date.parse(ziel)) return alterCursor;
  return ziel;
}

export interface NachrichtenAbruf {
  /** Rohmeldung + Ankunft IHRER Seite — der ehrliche `firstSeenAt`. */
  roh: Array<{ roh: unknown; gesehenAt: string }>;
  seiten: number;
  abgeschnitten: boolean;
  /** Ankunft der ersten Seite — Cursor-Ziel eines vollständigen Laufs. */
  abrufAt: string;
}

async function datenAbruf(
  url: string,
  k: AlpacaSchluessel,
  fetchImpl: FetchLike,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'APCA-API-KEY-ID': k.keyId, 'APCA-API-SECRET-KEY': k.secret },
    });
  } catch (e) {
    throw new AlpacaFehler(keineSchluesselImText(`Netzwerkfehler: ${(e as Error).message}`, k));
  }
  const body = await res.text();
  if (!res.ok) {
    throw new AlpacaFehler(keineSchluesselImText(`HTTP ${res.status}: ${body.slice(0, 300)}`, k), res.status);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AlpacaFehler(keineSchluesselImText(`Unlesbare Antwort: ${body.slice(0, 200)}`, k));
  }
}

/** Alle Meldungen seit `startIso`, aufsteigend, höchstens `maxSeiten` Seiten. */
export async function holeNachrichten(
  k: AlpacaSchluessel,
  startIso: string,
  fetchImpl: FetchLike = fetch,
  jetzt: () => Date = () => new Date(),
  maxSeiten = NACHRICHTEN_MAX_SEITEN,
): Promise<NachrichtenAbruf> {
  const roh: NachrichtenAbruf['roh'] = [];
  let token: string | null = null;
  let seiten = 0;
  let abrufAt = '';
  do {
    const q = new URLSearchParams({
      start: startIso,
      sort: 'asc',
      limit: String(NACHRICHTEN_SEITE),
      include_content: 'false',
    });
    if (token) q.set('page_token', token);
    const d = (await datenAbruf(`${ALPACA_DATEN_BASIS}/v1beta1/news?${q.toString()}`, k, fetchImpl)) as {
      news?: unknown;
      next_page_token?: unknown;
    };
    const gesehenAt = jetzt().toISOString();
    if (seiten === 0) abrufAt = gesehenAt;
    seiten += 1;
    if (Array.isArray(d.news)) for (const n of d.news as unknown[]) roh.push({ roh: n, gesehenAt });
    token = typeof d.next_page_token === 'string' && d.next_page_token.length > 0 ? d.next_page_token : null;
  } while (token && seiten < maxSeiten);
  return { roh, seiten, abgeschnitten: token !== null, abrufAt };
}

export interface GesehenerKurs {
  /** Preis des letzten Trades. */
  p: number;
  /** Zeitpunkt DIESES Trades — nicht der Abfrage; zeigt, wie alt der Kurs war. */
  t: string;
}

/**
 * Letzte Trades für die genannten Symbole — best effort.
 *
 * Aktien über den kostenlosen IEX-Feed (SIP verlangt ein Abo), Krypto über
 * den Krypto-Endpunkt. IEX sieht nur einen Bruchteil des Volumens; der
 * Trade-Zeitstempel steht deshalb mit drin, damit die Auswertung einen
 * veralteten Kurs als solchen erkennt, statt ihn für den Kurs beim Sehen
 * zu halten. Ein Fehler hier kostet den Kurs, nie die Meldung.
 */
export async function holeLetzteKurse(
  k: AlpacaSchluessel,
  symbole: readonly string[],
  istKrypto: (symbol: string) => boolean,
  fetchImpl: FetchLike = fetch,
): Promise<{ kurse: Record<string, GesehenerKurs>; fehler: string[] }> {
  const kurse: Record<string, GesehenerKurs> = {};
  const fehler: string[] = [];
  const aktien = symbole.filter((s) => !istKrypto(s));
  const krypto = symbole.filter((s) => istKrypto(s));
  const uebernehmen = (trades: unknown): void => {
    if (!trades || typeof trades !== 'object') return;
    for (const [alp, tr] of Object.entries(trades as Record<string, unknown>)) {
      const t = (tr ?? {}) as Record<string, unknown>;
      const p = typeof t['p'] === 'number' ? t['p'] : NaN;
      const zeit = isoOderNull(t['t']);
      if (Number.isFinite(p) && p > 0 && zeit) kurse[vonAlpacaSymbol(alp)] = { p, t: zeit };
    }
  };
  // Jeder Abruf für sich: Scheitert der Aktien-Teil, gibt es trotzdem die
  // Krypto-Kurse und umgekehrt.
  const abrufe: string[] = [];
  // 100 Symbole je Aufruf halten die URL kurz.
  for (let i = 0; i < aktien.length; i += 100) {
    const q = new URLSearchParams({ symbols: aktien.slice(i, i + 100).map(zuAlpacaSymbol).join(','), feed: 'iex' });
    abrufe.push(`${ALPACA_DATEN_BASIS}/v2/stocks/trades/latest?${q.toString()}`);
  }
  if (krypto.length > 0) {
    const q = new URLSearchParams({ symbols: krypto.map(zuAlpacaSymbol).join(',') });
    abrufe.push(`${ALPACA_DATEN_BASIS}/v1beta3/crypto/us/latest/trades?${q.toString()}`);
  }
  for (const url of abrufe) {
    try {
      uebernehmen(((await datenAbruf(url, k, fetchImpl)) as { trades?: unknown }).trades);
    } catch (e) {
      fehler.push((e as Error).message.slice(0, 200));
    }
  }
  return { kurse, fehler };
}
