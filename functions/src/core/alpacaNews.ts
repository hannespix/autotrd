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
 * Der Red-Team-Auftrag zur Kaskade (05.10.) war eindeutig: Ohne
 * unveränderliche Zeitstempel je Meldung ist jede spätere Trefferquote
 * Einbildung.
 *
 *   - `publishedAt`   — wann Alpaca die Meldung datiert (`created_at`);
 *   - `firstSeenAt`   — wann ihre Seite bei uns ankam;
 *   - `gespeichertAt` — Commit-Zeit (Server); erst AB HIER war sie nutzbar;
 *   - `decidedAt`     — wann die Kaskade entschieden hat (Stufe 2).
 *
 * REGEL FÜR STUFE 3 (hier festgeschrieben, damit sie niemand später
 * „vereinfacht"): Die Basis jeder Wirkungsmessung ist der erste handelbare
 * Kurs AB `max(firstSeenAt, gespeichertAt, decidedAt)`. Nie `publishedAt`
 * (das rechnet sich die Minuten schön, in denen der Kurs schon lief), und
 * nie `kurseGesehen`: Dessen Trade kann Stunden alt sein (IEX nach
 * Börsenschluss, illiquide Coins) — er beschreibt nur, wo der Kurs beim
 * Sehen STAND, damit sich „schon eingepreist?" beantworten lässt. Das Alter
 * steht deshalb an jedem Kurs mit dran (`alterS`). Wer davon abweicht, baut
 * Lookahead (CLAUDE.md §5) in anderer Verkleidung.
 *
 * ── Die Achse ist `updated_at`, nicht `created_at` (Red-Team 05.10.) ──────
 *
 * Alpaca sortiert und blättert nach `updated_at` (das Seiten-Token kodiert
 * `updated_at|id`). Die erste Fassung führte ihren Cursor auf `created_at`
 * und hätte bei einem abgeschnittenen Lauf entweder ewig dieselben Seiten
 * gelesen (Massen-Aktualisierung alter Artikel) oder spät aktualisierte
 * Meldungen übersprungen. Jetzt gilt:
 *
 *   - Ein abgeschnittener Lauf merkt sich SEINE Abfrage samt Seiten-Token
 *     (`fortsetzung`) und macht beim nächsten Lauf genau dort weiter, egal
 *     worauf `start` filtert. Das Token ist eine Position, kein Zustand beim
 *     Anbieter — eine Störung ist deshalb kein Grund, es wegzuwerfen
 *     (Red-Team 05.10.: Verwerfen bei jedem Fehler setzte die Kette auf den
 *     alten Cursor zurück, und bei einer Störung über mehrere Läufe kam der
 *     Sammler nie voran — stumm, weil `fehlerFolge` nur zwischen 0 und 1
 *     pendelte). Verworfen wird nur, was Alpaca als ungültig ablehnt.
 *   - Erst ein vollständig gelesener Durchgang setzt den Cursor, und zwar
 *     auf das größte GELESENE `updated_at` (gedeckelt auf die eigene Uhr,
 *     damit ein Zeitstempel aus der Zukunft ihn nicht festnagelt).
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
 * So viele Seiten höchstens je Lauf. Ein normaler Fünf-Minuten-Lauf liest
 * eine; der Deckel fängt den ersten Lauf und einen Rückstand nach einem
 * Ausfall ab. Den Rest holt die `fortsetzung` im nächsten Lauf.
 */
export const NACHRICHTEN_MAX_SEITEN = 10;
/**
 * Zeitdeckel fürs Blättern. Der Lauf hat 180 s; danach beendet die
 * Plattform ihn hart, ohne dass ein `catch` greift — kein Stand, keine
 * Fehlerzählung. Nach 45 s wird deshalb abgeschnitten wie beim Seitendeckel:
 * Rest per Token im nächsten Lauf, Zeit für Kurse und Commit bleibt.
 */
export const NACHRICHTEN_BLAETTER_FRIST_MS = 45_000;
/**
 * Überlappung je Lauf. Alpaca stellt Meldungen gelegentlich mit einem
 * Zeitstempel bereit, der vor dem Ende des Vorlaufs liegt. Doppelt gelesene
 * Meldungen kosten nur einen Lesezugriff — gespeichert wird jede genau
 * einmal (s. `nachrichtenSammeln`).
 */
export const NACHRICHTEN_UEBERLAPPUNG_MS = 30 * 60 * 1000;
/** Ohne Cursor (erster Lauf): so weit zurück. */
export const NACHRICHTEN_ERSTER_RUECKBLICK_MS = 2 * 60 * 60 * 1000;
/**
 * Älter als das (gemessen an `publishedAt` beim ersten Sehen) wird nicht
 * gespeichert, nur gezählt. Weil die Achse `updated_at` ist, kommt jeder
 * aktualisierte Altartikel wieder vorbei — auch einer von 2024. Auf ihn
 * kann niemand mehr reagieren, und als „neu" gespeichert verzerrte er jede
 * Verzögerungs- und Wirkungsstatistik.
 */
export const NACHRICHT_MAX_ALTER_MS = 72 * 60 * 60 * 1000;
/**
 * Ab dieser Verzögerung zwischen Veröffentlichung und erstem Sehen heißt
 * eine Meldung `nachzuegler`. Stufe 2 darf auf sie nicht wie auf eine
 * frische Nachricht reagieren — der Markt hatte Stunden Vorsprung.
 */
export const NACHZUEGLER_AB_MS = 2 * 60 * 60 * 1000;
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
  /** Nur http(s) — alles andere wird leer (spätere Anzeige, XSS). */
  url: string;
  /** Herausgeber laut Alpaca (meist `benzinga`). */
  herausgeber: string;
  /**
   * Autor laut Alpaca — bei Pressemitteilungen oft der Emittent selbst.
   * Die Gegenprobe prüft damit die Quelle (gefälschte Mitteilungen gab es).
   */
  autor: string;
  /** Nur Symbole, die wir kennen (Katalog ∪ Universum), in UNSERER Schreibweise. */
  symbole: string[];
  /** Wie viele Symbole Alpaca insgesamt nannte — Sammelmeldungen erkennbar. */
  symboleGenannt: number;
  publishedAt: string;
  aktualisiertAt: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Fließtext säubern und kürzen: Tags raus (Pressemitteilungen enthalten
 * HTML), Leerraum zusammenziehen, möglichst nicht mitten im Wort schneiden.
 */
export function kuerze(s: string, max: number): string {
  const t = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
 * Speicher gekostet. Makro-Meldungen ohne Symbol (Fed, CPI) fallen damit
 * bewusst heraus — für sie bräuchte es eine eigene Regime-Stufe.
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

  const url = text(r['url']).trim();
  return {
    id: `alp-${alpacaId}`,
    alpacaId,
    schlagzeile,
    zusammenfassung: kuerze(text(r['summary']), ZUSAMMENFASSUNG_MAX),
    url: /^https?:\/\//i.test(url) ? url.slice(0, 500) : '',
    herausgeber: kuerze(text(r['source']), 40),
    autor: kuerze(text(r['author']), 80),
    symbole,
    symboleGenannt: genannt.length,
    publishedAt,
    aktualisiertAt: isoOderNull(r['updated_at']) ?? publishedAt,
  };
}

/** Der Zeitpunkt einer Rohmeldung auf der API-Achse (`updated_at`, sonst `created_at`). */
export function achsenZeit(roh: unknown): number {
  const r = (roh ?? {}) as Record<string, unknown>;
  const u = Date.parse(text(r['updated_at']));
  return Number.isFinite(u) ? u : Date.parse(text(r['created_at']));
}

/**
 * Ab wann eine NEUE Abfrage fragt: Cursor minus Überlappung, ohne Cursor 2 h
 * zurück — und nie weiter als `NACHRICHT_MAX_ALTER_MS`: Was älter ist, würde
 * ohnehin nur gelesen und als `zuAlt` verworfen; nach einem mehrtägigen
 * Ausfall verlängerte es bloß die Kette.
 */
export function abrufStart(cursorIso: string | null, jetztMs: number): string {
  const cursorMs = cursorIso ? Date.parse(cursorIso) : NaN;
  const basis = Number.isFinite(cursorMs) && cursorMs <= jetztMs
    ? Math.max(cursorMs - NACHRICHTEN_UEBERLAPPUNG_MS, jetztMs - NACHRICHT_MAX_ALTER_MS)
    : jetztMs - NACHRICHTEN_ERSTER_RUECKBLICK_MS;
  return new Date(basis).toISOString();
}

/**
 * Größte gelesene Achsen-Zeit, gedeckelt auf `bisMs` (die eigene Uhr) — pur.
 * `null`, wenn nichts Datiertes gelesen wurde.
 */
export function juengsteAchsenZeit(roh: readonly unknown[], bisMs: number): string | null {
  let max = Number.NEGATIVE_INFINITY;
  for (const r of roh) {
    const t = achsenZeit(r);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return Number.isFinite(max) ? new Date(Math.min(max, bisMs)).toISOString() : null;
}

/** Das Spätere zweier Zeitpunkte (`null` zählt nicht) — Cursor rücken nie rückwärts. */
export function spaeterer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export interface NachrichtenAbfrage {
  start: string;
  /** Seiten-Token, ab dem gelesen wird; `null` = von vorn. */
  token: string | null;
}

export interface NachrichtenAbruf {
  /** Rohmeldung + Ankunft IHRER Seite — der ehrliche `firstSeenAt`. */
  roh: Array<{ roh: unknown; gesehenAt: string }>;
  seiten: number;
  /** Token der nächsten, NICHT gelesenen Seite; `null` = Durchgang vollständig. */
  weiter: string | null;
  /** Ankunft der ersten Seite. */
  abrufAt: string;
  /** Fehler, der das Blättern NACH mindestens einer Seite beendete. */
  fehler: string | null;
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

/**
 * Eine Abfrage (ab `start`, ggf. ab Seiten-Token) blättern — aufsteigend,
 * höchstens `maxSeiten` Seiten bzw. `fristMs`.
 *
 * Scheitert die ERSTE Seite, wirft der Abruf. Scheitert eine spätere, gilt
 * der Abruf als abgeschnitten: Die gelesenen Seiten werden verarbeitet, die
 * gescheiterte kommt per Token im nächsten Lauf wieder — ein einzelner
 * Aussetzer verwirft keine schon gelesenen Meldungen.
 */
export async function holeNachrichten(
  k: AlpacaSchluessel,
  abfrage: NachrichtenAbfrage,
  fetchImpl: FetchLike = fetch,
  jetzt: () => Date = () => new Date(),
  grenzen: { maxSeiten?: number; fristMs?: number } = {},
): Promise<NachrichtenAbruf> {
  const maxSeiten = grenzen.maxSeiten ?? NACHRICHTEN_MAX_SEITEN;
  const fristMs = grenzen.fristMs ?? NACHRICHTEN_BLAETTER_FRIST_MS;
  const beginn = jetzt().getTime();
  const roh: NachrichtenAbruf['roh'] = [];
  let token = abfrage.token;
  let seiten = 0;
  let abrufAt = '';
  let fehler: string | null = null;
  for (;;) {
    const q = new URLSearchParams({
      start: abfrage.start,
      sort: 'asc',
      limit: String(NACHRICHTEN_SEITE),
      include_content: 'false',
    });
    if (token) q.set('page_token', token);
    let d: { news?: unknown; next_page_token?: unknown };
    try {
      d = (await datenAbruf(`${ALPACA_DATEN_BASIS}/v1beta1/news?${q.toString()}`, k, fetchImpl)) as typeof d;
    } catch (e) {
      if (seiten === 0) throw e;
      fehler = (e as Error).message;
      break; // `token` zeigt weiter auf die gescheiterte Seite
    }
    const gesehenAt = jetzt().toISOString();
    if (seiten === 0) abrufAt = gesehenAt;
    seiten += 1;
    if (Array.isArray(d.news)) for (const n of d.news as unknown[]) roh.push({ roh: n, gesehenAt });
    const naechstes =
      typeof d.next_page_token === 'string' && d.next_page_token.length > 0 ? d.next_page_token : null;
    // Ein Token, das auf sich selbst zeigt, wäre eine Endlosschleife über
    // Läufe hinweg — als ungültig behandeln (verwirft die Fortsetzung).
    if (naechstes !== null && naechstes === token) {
      throw new AlpacaFehler('Seiten-Token unverändert — Blättern ohne Fortschritt', 422);
    }
    token = naechstes;
    if (!token || seiten >= maxSeiten || jetzt().getTime() - beginn >= fristMs) break;
  }
  return { roh, seiten, weiter: token, abrufAt, fehler };
}

export interface GesehenerKurs {
  /** Preis des letzten Trades. */
  p: number;
  /** Zeitpunkt DIESES Trades — nicht der Abfrage; zeigt, wie alt der Kurs war. */
  t: string;
}

/** Zeitbudget der Kursabfragen: danach keine weiteren Abrufe (Meldungen gehen vor). */
export interface KursFrist {
  bisMs: number;
  jetzt: () => number;
}

/** Krypto-Symbole, die Alpaca kennt: nur gegen USD (`BTC-EUR` brächte die ganze Abfrage zu Fall). */
const KRYPTO_USD = /^[A-Z0-9]+-USD$/;

/**
 * Letzte Trades für die genannten Symbole — best effort.
 *
 * Aktien über den kostenlosen IEX-Feed (SIP verlangt ein Abo), Krypto über
 * den Krypto-Endpunkt. IEX sieht nur einen Bruchteil des Volumens; der
 * Trade-Zeitstempel steht deshalb mit drin. Ein Fehler hier kostet den
 * Kurs, nie die Meldung.
 */
export async function holeLetzteKurse(
  k: AlpacaSchluessel,
  symbole: readonly string[],
  istKrypto: (symbol: string) => boolean,
  fetchImpl: FetchLike = fetch,
  frist: KursFrist | null = null,
): Promise<{ kurse: Record<string, GesehenerKurs>; fehler: string[] }> {
  const kurse: Record<string, GesehenerKurs> = {};
  const fehler: string[] = [];
  const aktien = symbole.filter((s) => !istKrypto(s));
  const krypto = symbole.filter((s) => istKrypto(s) && KRYPTO_USD.test(s));
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
    // Ohne Budget hingen nacheinander mehrere 15-s-Timeouts vor dem Commit,
    // und die Plattform beendete den Lauf, bevor eine Meldung gespeichert
    // war (Red-Team 05.10.). Fehlende Kurse kosten Kontext, keine Meldung.
    if (frist && frist.jetzt() >= frist.bisMs) {
      fehler.push('Kurs-Frist erreicht — restliche Kurse ausgelassen');
      break;
    }
    try {
      uebernehmen(((await datenAbruf(url, k, fetchImpl)) as { trades?: unknown }).trades);
    } catch (e) {
      fehler.push((e as Error).message.slice(0, 200));
    }
  }
  return { kurse, fehler };
}
