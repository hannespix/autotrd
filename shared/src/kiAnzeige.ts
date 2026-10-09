/**
 * Anzeige-Kopie der KI-Einordnungen je Symbol (Task 22, Owner 09.10.: „die
 * KI-News-Analysen … tiefer und auf weitere Weisen ins Tool integrieren").
 *
 * Die Urteile selbst (`kiUrteile/*`) sind gesperrt — sie tragen Laufkennungen,
 * Kosten und Modelltext. Für die Anzeige schreibt der KI-Lauf an seinem Ende
 * eine schmale Kopie nach `market/{sym}.ki` (für angemeldete Nutzer lesbar).
 *
 * WHITELIST, nicht Blacklist: Hier landet nur, was ausdrücklich unten steht —
 * strukturierte Felder aus festen Wertelisten. KEIN Freitext (weder `kurz`
 * noch `begruendung`): Beide sind aus der Fremdmeldung (Benzinga über Alpaca)
 * abgeleitet; ob eine Umschreibung davon gezeigt werden darf, ist eine
 * Lizenzfrage, und Freitext aus Fremdquellen ist ein Einschleusungsweg.
 * Ebenso keine Schlagzeile, keine URL, keine Kurse (Alpaca-Daten), keine
 * Kosten, keine Modell- oder Laufkennungen.
 *
 * Pur: Server schreibt, Frontend liest, Tests prüfen dasselbe.
 */
import { EREIGNISSE, type Eingepreist, type Ereignis, type KiRichtung } from './kiNachrichten.js';
import { KI_GUELTIG_STUNDEN, kiSignaleAus } from './kiAktion.js';

export const KI_ANZEIGE_V = 1;
/** So viele Einordnungen je Symbol werden gehalten (jüngste zuerst). */
export const KI_ANZEIGE_MAX = 10;

export interface KiAnzeigeEintrag {
  /** `{newsId}_{symbol}` — dieselbe Kennung wie das Urteil; Join fürs Trade-Journal. */
  id: string;
  newsId: string;
  richtung: KiRichtung;
  /** Lief die Gegenprobe? (`stufe === 'pruefung'`) */
  gegengeprueft: boolean;
  /** Nur bestandene Gegenprobe — nur solche Urteile wirken auf den Handel. */
  handlungsfaehig: boolean;
  /** 0–1, auf 0,1 gerundet. */
  staerke: number;
  eingepreist: Eingepreist | null;
  horizontTage: number | null;
  ereignis: Ereignis | null;
  firstSeenAt: string;
  decidedAt: string;
}

export interface KiAnzeige {
  v: number;
  at: string;
  verlauf: KiAnzeigeEintrag[];
}

const RICHTUNGEN: readonly string[] = ['positiv', 'negativ', 'neutral'];
const EINGEPREIST: readonly string[] = ['nein', 'teilweise', 'ja', 'unklar'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID = /^[A-Za-z0-9._^=-]{1,160}$/;

/**
 * Ein Urteils-Doc → Anzeige-Eintrag. `null`, wenn das Urteil keine Richtung
 * hat (unlesbar) oder ein Pflichtfeld nicht in Form ist — lieber eine Zeile
 * weniger als eine erfundene.
 */
export function kiAnzeigeEintrag(id: string, d: Record<string, unknown>): KiAnzeigeEintrag | null {
  const richtung = d['richtung'];
  if (typeof richtung !== 'string' || !RICHTUNGEN.includes(richtung)) return null;
  const newsId = d['newsId'];
  const firstSeenAt = d['firstSeenAt'];
  const decidedAt = d['decidedAt'];
  if (!ID.test(id) || typeof newsId !== 'string' || !ID.test(newsId)) return null;
  if (typeof firstSeenAt !== 'string' || !ISO.test(firstSeenAt) || typeof decidedAt !== 'string' || !ISO.test(decidedAt)) return null;
  const staerkeRoh = typeof d['staerke'] === 'number' && Number.isFinite(d['staerke']) ? (d['staerke'] as number) : 0;
  const eingepreist = typeof d['eingepreist'] === 'string' && EINGEPREIST.includes(d['eingepreist']) ? (d['eingepreist'] as Eingepreist) : null;
  const horizont = typeof d['horizontTage'] === 'number' && Number.isFinite(d['horizontTage']) && d['horizontTage'] > 0
    ? Math.min(365, Math.round(d['horizontTage'] as number)) : null;
  const sichtung = d['sichtung'];
  const ereignisRoh = sichtung && typeof sichtung === 'object' ? (sichtung as Record<string, unknown>)['ereignis'] : undefined;
  const ereignis = typeof ereignisRoh === 'string' && (EREIGNISSE as readonly string[]).includes(ereignisRoh) ? (ereignisRoh as Ereignis) : null;
  return {
    id,
    newsId,
    richtung: richtung as KiRichtung,
    gegengeprueft: d['stufe'] === 'pruefung',
    handlungsfaehig: d['handlungsfaehig'] === true,
    staerke: Math.round(Math.min(1, Math.max(0, staerkeRoh)) * 10) / 10,
    eingepreist,
    horizontTage: horizont,
    ereignis,
    firstSeenAt,
    decidedAt,
  };
}

/** Ein GESPEICHERTER Eintrag (aus `market/{sym}.ki.verlauf`) — dieselbe Prüfung wie beim Schreiben. */
export function kiAnzeigeGespeichert(x: unknown): KiAnzeigeEintrag | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  return kiAnzeigeEintrag(String(r['id'] ?? ''), {
    ...r,
    stufe: r['gegengeprueft'] === true ? 'pruefung' : 'sichtung',
    sichtung: { ereignis: r['ereignis'] },
  });
}

/** Alt + neu zusammenführen: je Kennung einmal, jüngste Entscheidung zuerst, gedeckelt. */
export function kiAnzeigeMischen(alt: unknown, neu: readonly KiAnzeigeEintrag[]): KiAnzeigeEintrag[] {
  const bisher = Array.isArray(alt) ? alt.map(kiAnzeigeGespeichert).filter((x): x is KiAnzeigeEintrag => x !== null) : [];
  const je = new Map<string, KiAnzeigeEintrag>();
  for (const e of [...bisher, ...neu]) je.set(e.id, e);
  return [...je.values()]
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0))
    .slice(0, KI_ANZEIGE_MAX);
}

/** Die Einträge in die Rohform, die der Handel liest (kiSignaleAus). */
function alsUrteile(verlauf: readonly KiAnzeigeEintrag[], symbol: string): Record<string, unknown>[] {
  return verlauf.map((e) => ({
    symbol, newsId: e.newsId, richtung: e.richtung, handlungsfaehig: e.handlungsfaehig, staerke: e.staerke,
    eingepreist: e.eingepreist, decidedAt: e.decidedAt, firstSeenAt: e.firstSeenAt, stufe: e.gegengeprueft ? 'pruefung' : 'sichtung',
  }));
}

/**
 * Wirkt diese Einordnung JETZT auf den Handel? Dieselben Bedingungen wie
 * `traegt` + Gültigkeit in kiAktion.ts: bestätigt, mit Richtung, nicht schon
 * eingepreist, entschieden vor `jetztMs`, Meldung höchstens
 * KI_GUELTIG_STUNDEN alt (ab dem ersten Sehen). Red-Team 09.10.: Die erste
 * Fassung ließ „eingepreist: ja" und das Alter außer Acht.
 */
export function kiWirkt(e: KiAnzeigeEintrag, jetztMs: number): boolean {
  if (!e.handlungsfaehig || e.richtung === 'neutral' || e.eingepreist === 'ja') return false;
  const entschieden = Date.parse(e.decidedAt);
  const gesehen = Math.min(Date.parse(e.firstSeenAt), entschieden);
  return Number.isFinite(entschieden) && entschieden <= jetztMs && jetztMs - gesehen <= KI_GUELTIG_STUNDEN * 3_600_000;
}

/**
 * Die für den Handel MASSGEBLICHE Einordnung eines Symbols — über dieselbe
 * Rangfolge wie kiSignaleAus (geprüft vor gesichtet vor neutral, dann die
 * jüngste) — und nur, wenn sie auch wirkt. Eine jüngere geprüfte NEUTRALE
 * Einordnung löst im Handel die ältere ab; dann gibt es hier auch kein
 * Abzeichen mehr (Red-Team 09.10., M2a).
 */
export function kiAktuell(verlauf: readonly KiAnzeigeEintrag[] | null | undefined, symbol: string, jetztMs: number): KiAnzeigeEintrag | null {
  const liste = verlauf ?? [];
  const s = kiSignaleAus(alsUrteile(liste, symbol), jetztMs).get(symbol);
  const e = s ? liste.find((x) => x.newsId === s.newsId) ?? null : null;
  return e && kiWirkt(e, jetztMs) ? e : null;
}
