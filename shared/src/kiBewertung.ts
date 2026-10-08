/**
 * KI-Kaskade Stufe 3 (08.10.): Jedes KI-Urteil wird nach seinem Horizont
 * gegen den Markt bewertet — netto nach Kosten — und aus der gemessenen
 * Wirkung entsteht ein Gewicht für die KI-Stimme.
 *
 * ── Beweislast ───────────────────────────────────────────────────────────
 *
 * Stufe 2b handelt mit fester Probegröße (die Hälfte) und festem Stimm-
 * gewicht, weil niemand wusste, ob die Urteile etwas taugen. Hier wird es
 * gemessen, mit denselben Regeln wie bei der Prognose (evalForecasts):
 *
 *   - Bezugszeit = das SPÄTESTE von firstSeenAt, decidedAt, gespeichertAt.
 *     Alles davor ist Lookahead: Die Engine konnte das Urteil erst ab dem
 *     Moment kennen, in dem es geschrieben war.
 *   - Einstieg = der Kurs, den die Gegenprobe beim Urteil gesehen hat
 *     (`pruefung.kurskontext.aktuell`), sonst der erste Tagesschluss NACH
 *     dem Bezugstag. Nie ein Kurs, der vor dem Urteil liegt.
 *   - Ziel = der Tagesschluss am Ende des Horizonts (horizontTage
 *     Handelstage nach dem Bezugstag). Bewertet wird erst, wenn dieser Tag
 *     realisiert UND strikt vor heute ist — das Gate ist dasselbe wie bei
 *     der Prognose und genauso heilig.
 *   - Netto = Bruttobewegung in Urteilsrichtung minus Roundtrip-Kosten der
 *     Anlageklasse. Ein Treffer ist ein Fall mit Netto > 0.
 *
 * ── Gewicht ──────────────────────────────────────────────────────────────
 *
 * Unter KI_MIN_FAELLE bleibt alles wie in Stufe 2b (Faktor 1). Danach:
 * Trefferquote 50 % → 1, 65 % → 2 (Deckel), 35 % → 0,25 (Boden). Mehr als
 * 1 gibt es nur, wenn die Netto-Summe positiv ist — eine Quote über 50 %
 * mit negativem Netto bedeutet viele kleine Treffer und wenige große
 * Fehler; so etwas verdient keine größere Position.
 *
 * Der Faktor wirkt nur auf die EINSTIEGS-Seite (Stimmgewicht, Probegröße).
 * Vetos, Stops und Ausstiege bleiben unangetastet: Schutz wird nicht
 * nach Trefferquote gelockert.
 */
import { classify } from './universe.js';
import { roundtripFeeRateForClass } from './strategy.js';

export const KI_BEWERTUNG_V = 1;
/** Ab so vielen bewerteten WIRKSAMEN Fällen spricht das Gewicht. */
export const KI_MIN_FAELLE = 20;
export const KI_GEWICHT_MIN = 0.25;
export const KI_GEWICHT_MAX = 2;
/** Bezugstag älter als so viele Kalendertage ohne genug Kerzen → verfallen (nie bewerten). */
export const KI_VERFALL_TAGE = 30;
/** Horizont-Deckel in Handelstagen (die Gegenprobe klemmt 1–10). */
export const KI_HORIZONT_MAX = 10;
export const KI_HORIZONT_DEFAULT = 3;

/** Urteil, wie es in kiUrteile liegt (Ausschnitt, der für die Bewertung zählt). */
export interface KiUrteilRoh {
  newsId?: string;
  symbol?: string;
  richtung?: 'positiv' | 'negativ' | 'neutral' | null;
  handlungsfaehig?: boolean;
  eingepreist?: 'nein' | 'teilweise' | 'ja' | 'unklar' | null;
  horizontTage?: number | null;
  stufe?: 'sichtung' | 'pruefung';
  firstSeenAt?: string;
  decidedAt?: string;
  gespeichertAt?: unknown;
  sichtung?: { ereignis?: string } | null;
  pruefung?: { kurskontext?: { aktuell?: { p?: number; t?: string } | null } | null } | null;
}

export interface TagesSchluss {
  date: string;
  close: number;
}

export type KiBewertungStand =
  | { stand: 'offen' }
  | { stand: 'verfallen'; grund: 'keine_kerzen' }
  | { stand: 'uebersprungen'; grund: 'neutral' | 'ohne_richtung' | 'ohne_bezug' | 'kein_einstieg' }
  | {
      stand: 'bewertet';
      einstieg: number;
      einstiegQuelle: 'urteil' | 'schluss';
      ziel: number;
      bezugTag: string;
      endTag: string;
      horizontTage: number;
      bruttoPct: number;
      nettoPct: number;
      kostenPct: number;
      treffer: boolean;
    };

/** Zeitwert aus ISO-String, Firestore-Timestamp oder {seconds} — sonst null. */
export function zeitMs(v: unknown): number | null {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (v && typeof v === 'object') {
    const o = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof o.toMillis === 'function') {
      const t = o.toMillis();
      return Number.isFinite(t) ? t : null;
    }
    const s = typeof o.seconds === 'number' ? o.seconds : typeof o._seconds === 'number' ? o._seconds : null;
    return s === null ? null : s * 1000;
  }
  return null;
}

/** Das SPÄTESTE von firstSeenAt, decidedAt, gespeichertAt — ab da war das Urteil bekannt. */
export function bezugZeitMs(u: KiUrteilRoh): number | null {
  const werte = [zeitMs(u.firstSeenAt), zeitMs(u.decidedAt), zeitMs(u.gespeichertAt)].filter(
    (t): t is number => t !== null,
  );
  return werte.length === 0 ? null : Math.max(...werte);
}

/** Kalendertag in New York (Tagesschlüsse tragen das Börsendatum). */
export function etTag(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function horizontVon(u: KiUrteilRoh): number {
  const h = u.horizontTage;
  if (typeof h !== 'number' || !Number.isFinite(h)) return KI_HORIZONT_DEFAULT;
  return Math.min(KI_HORIZONT_MAX, Math.max(1, Math.round(h)));
}

const kalenderTageZwischen = (tagA: string, tagB: string): number =>
  (Date.parse(`${tagB}T00:00:00Z`) - Date.parse(`${tagA}T00:00:00Z`)) / 86_400_000;

const rund = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Ein Urteil gegen realisierte Tagesschlüsse bewerten. Pure; `today` ist das
 * UTC-Datum des Laufs (dasselbe Gate wie evalForecasts: End-Tag strikt < today).
 */
export function bewerteUrteil(
  u: KiUrteilRoh,
  schluesse: ReadonlyArray<TagesSchluss>,
  kostenRoundtripRate: number,
  today: string,
): KiBewertungStand {
  if (u.richtung === null || u.richtung === undefined) return { stand: 'uebersprungen', grund: 'ohne_richtung' };
  if (u.richtung === 'neutral') return { stand: 'uebersprungen', grund: 'neutral' };
  const bezug = bezugZeitMs(u);
  if (bezug === null) return { stand: 'uebersprungen', grund: 'ohne_bezug' };
  const bezugTag = etTag(bezug);
  const h = horizontVon(u);

  const nach = [...schluesse]
    .filter((s) => s.date > bezugTag && Number.isFinite(s.close) && s.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const gesehen = u.pruefung?.kurskontext?.aktuell?.p;
  const einstiegAusUrteil = typeof gesehen === 'number' && Number.isFinite(gesehen) && gesehen > 0;
  // Ohne Kurs im Urteil ist der Einstieg der erste Schluss nach dem Bezug —
  // der Horizont läuft dann ab DIESEM Schluss, nicht ab dem Bezugstag.
  const start = einstiegAusUrteil ? 0 : 1;
  const endIdx = start + h - 1;

  if (nach.length <= endIdx) {
    // Noch nicht genug Kerzen — offen, oder verfallen, wenn der Bezug alt ist
    // (Symbol ohne Kurse, Datenlücke): nie mit Lücken bewerten.
    return kalenderTageZwischen(bezugTag, today) > KI_VERFALL_TAGE
      ? { stand: 'verfallen', grund: 'keine_kerzen' }
      : { stand: 'offen' };
  }
  const ende = nach[endIdx]!;
  if (!(ende.date < today)) return { stand: 'offen' };

  const einstieg = einstiegAusUrteil ? (gesehen as number) : nach[0]!.close;
  if (!(einstieg > 0)) return { stand: 'uebersprungen', grund: 'kein_einstieg' };
  const richtung = u.richtung === 'positiv' ? 1 : -1;
  const bruttoPct = rund((ende.close / einstieg - 1) * 100 * richtung);
  const kostenPct = rund(Math.max(0, kostenRoundtripRate) * 100);
  const nettoPct = rund(bruttoPct - kostenPct);
  return {
    stand: 'bewertet',
    einstieg: rund(einstieg, 6),
    einstiegQuelle: einstiegAusUrteil ? 'urteil' : 'schluss',
    ziel: rund(ende.close, 6),
    bezugTag,
    endTag: ende.date,
    horizontTage: h,
    bruttoPct,
    nettoPct,
    kostenPct,
    treffer: nettoPct > 0,
  };
}

/** Roundtrip-Kostensatz je Symbol (Anlageklasse aus dem Katalog). */
export function kostenRateFuer(symbol: string): number {
  return roundtripFeeRateForClass(classify(symbol));
}

/** Zählwerk eines Buckets in meta/kiStats. */
export interface KiFallStat {
  n: number;
  treffer: number;
  nettoSum: number;
  bruttoSum: number;
}

/**
 * Welche Buckets ein bewertetes Urteil füllt: immer `gesamt`, dazu die Stufe,
 * `wirksam` (hätte in Stufe 2b handeln dürfen) oder `schatten`, und das
 * Ereignis. Das Gewicht kommt NUR aus `wirksam` — gemessen wird, was
 * tatsächlich Trades treibt.
 */
export function bucketsFuer(u: KiUrteilRoh): string[] {
  const out = ['gesamt'];
  out.push(u.stufe === 'pruefung' ? 'pruefung' : 'sichtung');
  const wirksam = u.handlungsfaehig === true && u.eingepreist !== 'ja';
  out.push(wirksam ? 'wirksam' : 'schatten');
  const ereignis = u.sichtung?.ereignis;
  if (typeof ereignis === 'string' && /^[a-z]+$/.test(ereignis)) out.push(`ereignis_${ereignis}`);
  return out;
}

const clamp = (lo: number, hi: number, v: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Gewicht der KI-Stimme aus der gemessenen Wirkung: 1 unter KI_MIN_FAELLE
 * (Stufe 2b unverändert), sonst linear um 50 % (siehe Kopf). Mehr als 1
 * nur mit positiver Netto-Summe.
 */
export function kiGewicht(stat: Partial<KiFallStat> | null | undefined): number {
  const n = stat?.n ?? 0;
  const treffer = stat?.treffer ?? 0;
  if (!Number.isFinite(n) || n < KI_MIN_FAELLE) return 1;
  const quote = treffer / n;
  let f = quote >= 0.5 ? 1 + (quote - 0.5) / 0.15 : 1 - ((0.5 - quote) / 0.15) * 0.75;
  f = clamp(KI_GEWICHT_MIN, KI_GEWICHT_MAX, f);
  if (!((stat?.nettoSum ?? 0) > 0)) f = Math.min(f, 1);
  return Math.round(f * 100) / 100;
}

/* ── Untätigkeits-Alarm ──────────────────────────────────────────────────
 *
 * Der Scan zählt je Lauf, ob eine handlungsfähige KI-Lage vorlag und ob
 * irgendeine KI-Aktion zustande kam. Liegen über zwei Handelstage dauerhaft
 * Urteile vor, ohne dass EINE Aktion folgt, stimmt etwas am Übergang
 * Urteil → Handel (Tore, Schwellen, Budget) — genau die Untätigkeit, vor der
 * der Owner gewarnt hat. Gelb, nicht rot: nichts ist kaputt, es wird nur
 * nicht gehandelt. */
export const KI_WIRKUNG_TAGE = 2;
/** Mindestens so viele Scans mit handlungsfähiger Lage (≈ eine Handelsstunde). */
export const KI_WIRKUNG_LAGE_MIN = 12;

export interface KiWirkungTag {
  tag: string;
  lageScans: number;
  aktionen: number;
}

export interface KiWirkungUrteil {
  ok: boolean;
  text: string;
}

export function bewerteKiWirkung(tage: ReadonlyArray<KiWirkungTag>): KiWirkungUrteil {
  const letzte = [...tage].sort((a, b) => (a.tag < b.tag ? 1 : -1)).slice(0, KI_WIRKUNG_TAGE);
  if (letzte.length < KI_WIRKUNG_TAGE) return { ok: true, text: 'Noch nicht genug Handelstage gemessen — kein Urteil.' };
  const lage = letzte.reduce((s, t) => s + t.lageScans, 0);
  const aktionen = letzte.reduce((s, t) => s + t.aktionen, 0);
  if (lage >= KI_WIRKUNG_LAGE_MIN && aktionen === 0) {
    return {
      ok: false,
      text: `KI-Urteile ohne Wirkung: ${lage} Scans mit handlungsfähiger Lage an ${KI_WIRKUNG_TAGE} Handelstagen, keine einzige KI-Aktion.`,
    };
  }
  return { ok: true, text: `${lage} Scans mit KI-Lage, ${aktionen} KI-Aktionen an ${KI_WIRKUNG_TAGE} Handelstagen.` };
}

/** ISO-Woche (YYYY-Www) eines Zeitpunkts in New York — Marker für den Wochenbericht. */
export function isoWocheEt(ms: number): string {
  const tag = etTag(ms);
  const d = new Date(`${tag}T00:00:00Z`);
  const wochentag = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - wochentag);
  const jahrBeginn = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const woche = Math.ceil(((d.getTime() - jahrBeginn.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(woche).padStart(2, '0')}`;
}

/** Text der Wochen-Nachricht an die Admins (nur Summen, keine Konten). */
export function wochenNachricht(
  woche: string,
  wirksam: Partial<KiFallStat> | null | undefined,
  gesamt: Partial<KiFallStat> | null | undefined,
  gewicht: number,
): string {
  const q = (s: Partial<KiFallStat> | null | undefined): string => {
    const n = s?.n ?? 0;
    if (n === 0) return 'noch keine bewerteten Fälle';
    const quote = Math.round(((s?.treffer ?? 0) / n) * 100);
    const netto = (s?.nettoSum ?? 0) / n;
    return `${n} Fälle, Trefferquote ${quote} %, Ø netto ${netto >= 0 ? '+' : ''}${netto.toFixed(2)} %`;
  };
  return (
    `🤖 System: KI-Wochenbericht ${woche} — wirksame Urteile: ${q(wirksam)}; alle Urteile: ${q(gesamt)}. `
    + `Gewicht der KI-Stimme: ×${gewicht.toFixed(2)}`
    + (gewicht === 1 && (wirksam?.n ?? 0) < KI_MIN_FAELLE
      ? ` (unter ${KI_MIN_FAELLE} wirksamen Fällen bleibt es bei Stufe 2b).`
      : '.')
  );
}
