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
import { marketOpenForClass } from './marketHours.js';

export const KI_BEWERTUNG_V = 1;
/** Ab so vielen bewerteten WIRKSAMEN Fällen spricht das Gewicht (Red-Team 08.10., B3:
 *  bei 20 Fällen erreicht jede achte Münzwurf-KI 65 % — 40 halbiert das). */
export const KI_MIN_FAELLE = 40;
export const KI_GEWICHT_MIN = 0.25;
/**
 * Deckel 1 — Stufe 3 darf DÄMPFEN, nicht verstärken (Red-Team 08.10.):
 * Ohne Benchmark gegen die unbedingte Bewegung und ohne Holdout ist eine
 * Quote über 50 % keine Evidenz für mehr Größe. Verstärkung (bis 2) kommt
 * erst mit Stufe 4 (Out-of-Sample-Prüfung). Die Messung läuft trotzdem
 * vollständig — nur die Wette bleibt die halbe.
 */
export const KI_GEWICHT_MAX = 1;
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
  /** Fassung von Prompts/Schemas beim Urteil (KI_NACHRICHTEN_PROMPT_V) — Bucket `prompt_v{N}`. */
  promptV?: number;
  firstSeenAt?: string;
  decidedAt?: string;
  gespeichertAt?: unknown;
  /** Vom Scan gesetzt, sobald das Urteil tatsächlich eine Einstiegsstimme abgegeben hat (Stufe 3). */
  gestimmtAt?: unknown;
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
      /** Trailing h-Tage-Drift des Symbols vor dem Bezug (Stufe 4a); null ohne Vorlauf oder bei h > 3. */
      marktPct: number | null;
      /** NETTO in Urteilsrichtung minus Drift in Urteilsrichtung — was das Urteil über die eigene Drift hinaus wusste. */
      ueberMarktPct: number | null;
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

/** Kalendertag in New York (Tagesschlüsse tragen das Börsendatum).
 *
 *  Regel für Katalogerweiterungen (Red-Team 08.10., B10): `s.date > bezugTag`
 *  ist nur dann lookahead-frei, wenn keine Börse ihren Tag D+1 schließt, bevor
 *  der ET-Tag D endet. Heutiger Katalog (US, ^N225, ^GDAXI, Krypto in UTC)
 *  erfüllt das; eine Börse in UTC+12/13 (z. B. NZX) bräche es. */
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

/** Wie viele Fenster die Drift-Schätzung mindestens braucht. */
export const BENCHMARK_MIN_FENSTER = 20;
/** Höchstens so viele Handelstage Vorlauf gehen in die Drift ein. */
export const BENCHMARK_MAX_FENSTER = 60;
/**
 * Nur für kurze Horizonte (Red-Team 4a, B4): Fenster überlappen um h−1 Tage;
 * 60 Fenster bei h=10 sind ~6 unabhängige Beobachtungen, die Streuung der
 * Schätzung ist dann so groß wie die Kante selbst. Ab h > 3 keine Drift.
 */
export const BENCHMARK_H_MAX = 3;

/**
 * Symbol-Drift (Stufe 4a, Red-Team B3c): die mittlere h-Tage-Bewegung des
 * Symbols über die letzten Handelstage VOR dem Bezugstag. Ein positives
 * Urteil in einem laufenden Aufwärtstrend bekommt die Drift sonst gratis
 * gutgeschrieben, ein negatives wird dafür bestraft. Es ist die TRAILING-
 * Drift des Symbols (Momentum), kein Marktindex — so heißt sie auch.
 *
 * Nur Kerzen STRIKT vor dem Bezugstag (Red-Team 4a, B3): Der Schluss des
 * Bezugstags liegt zur Bezugszeit noch nicht vor und steckt bei Einstieg aus
 * dem Urteil ohnehin schon im Brutto. null unter BENCHMARK_MIN_FENSTER
 * Fenstern oder bei h > BENCHMARK_H_MAX.
 */
export function benchmarkPct(schluesse: ReadonlyArray<TagesSchluss>, bezugTag: string, h: number): number | null {
  if (h > BENCHMARK_H_MAX) return null;
  const vor = [...schluesse]
    .filter((s) => s.date < bezugTag && Number.isFinite(s.close) && s.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-(BENCHMARK_MAX_FENSTER + h));
  const fenster: number[] = [];
  for (let i = 0; i + h < vor.length; i += 1) fenster.push((vor[i + h]!.close / vor[i]!.close - 1) * 100);
  if (fenster.length < BENCHMARK_MIN_FENSTER) return null;
  return rund(fenster.reduce((s, v) => s + v, 0) / fenster.length);
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

  // Der Kurs im Urteil ist der letzte Trade beim Beginn des Prüf-Laufs. Nach
  // Börsenschluss oder vor der Eröffnung ist das ein Kurs VOR der Nachricht
  // (der Vortagsschluss) — der komplette Gap zählte als „Treffer", obwohl die
  // Engine ihn nie bekommt (Red-Team 08.10., B1). Deshalb nur, wenn der Trade
  // NACH dem ersten Sehen der Meldung lag; sonst der erste Schluss danach.
  const aktuell = u.pruefung?.kurskontext?.aktuell;
  const gesehen = aktuell?.p;
  const gesehenT = zeitMs(aktuell?.t);
  const seitSehen = zeitMs(u.firstSeenAt) ?? zeitMs(u.decidedAt);
  const einstiegAusUrteil =
    typeof gesehen === 'number' && Number.isFinite(gesehen) && gesehen > 0
    && gesehenT !== null && seitSehen !== null && gesehenT >= seitSehen;
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
  const marktPct = benchmarkPct(schluesse, bezugTag, h);
  // Netto, nicht brutto (Red-Team 4a, B5): dieselbe Basis wie `treffer`.
  const ueberMarktPct = marktPct === null ? null : rund(nettoPct - marktPct * richtung);
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
    marktPct,
    ueberMarktPct,
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
  /** Fälle mit Drift-Schätzung (Stufe 4a) — Nenner für die Über-Drift-Quote. */
  nMarkt?: number;
  /** Davon: netto über der Symbol-Drift (ueberMarktPct > 0). */
  trefferMarkt?: number;
  /** Summe von ueberMarktPct (netto) über die Fälle mit Drift-Schätzung. */
  ueberMarktSum?: number;
}

/**
 * Holdout (Stufe 4a, Red-Team B3d): Jeder Fall gehört fest zu Arm A oder B
 * — über einen MISCHENDEN Hash des Fallschlüssels. Die erste Fassung nahm
 * `% 2` eines linearen Hashs: das ist nur das XOR der niedrigsten Bits
 * aller Zeichen, der Arm kippte je Symbol täglich und alle Symbole gleicher
 * Parität saßen am selben Tag im selben Arm (Red-Team 4a, B1). FNV-1a mit
 * Finalizer, dann das HÖCHSTE Bit.
 *
 * Das Gewicht rechnet NUR aus A (KI_GEWICHT_BUCKET); B steuert nichts und
 * ist die Kontrolle, die im Wochenbericht steht und ohne die Stufe 4b keine
 * Verstärkung freigibt.
 */
export function holdoutArm(fall: string): 'a' | 'b' {
  let h = 0x811c9dc5;
  for (let i = 0; i < fall.length; i += 1) {
    h ^= fall.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Finalizer (murmur3 fmix32): mischt die niedrigen Bits in die hohen.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 31) === 0 ? 'a' : 'b';
}

/** War der Markt der Klasse zur Bezugszeit offen? (Nur dann konnte die Engine binnen 120 min handeln.) */
export function handelbarZurBezugszeit(u: KiUrteilRoh): boolean {
  const bezug = bezugZeitMs(u);
  if (bezug === null || typeof u.symbol !== 'string') return false;
  return marketOpenForClass(classify(u.symbol), new Date(bezug));
}

/**
 * Welche Buckets ein bewertetes Urteil füllt: immer `gesamt`, dazu die Stufe,
 * `wirksam_long`/`wirksam_short` oder `schatten`, `handelbar`/`ausserhalb`
 * und das Ereignis.
 *
 * `wirksam` heißt seit dem Red-Team vom 08.10. (B7): Der Scan hat für dieses
 * Urteil TATSÄCHLICH eine Einstiegsstimme abgegeben (`gestimmtAt`) — nicht
 * „hätte dürfen". Nur das misst, was Trades treibt. Long und Short getrennt
 * (B6): Ein negatives Urteil ist für Konten ohne Short ein Veto, kein
 * Short-Gewinn — eine andere Größe. Die wirksamen Long-Fälle teilen sich in
 * die Holdout-Arme; das Gewicht kommt NUR aus Arm A.
 */
export const KI_GEWICHT_BUCKET = 'holdout_a';
/** Die Kontrolle — steuert nichts, wird nur berichtet. */
export const KI_HOLDOUT_BUCKET = 'holdout_b';

export function bucketsFuer(u: KiUrteilRoh): string[] {
  const out = ['gesamt'];
  out.push(u.stufe === 'pruefung' ? 'pruefung' : 'sichtung');
  const gestimmt = zeitMs(u.gestimmtAt) !== null;
  if (gestimmt && u.richtung === 'positiv') {
    out.push('wirksam_long');
    const fall = fallSchluessel(u);
    if (fall !== null) out.push(`holdout_${holdoutArm(fall)}`);
  } else if (gestimmt && u.richtung === 'negativ') out.push('wirksam_short');
  else out.push('schatten');
  out.push(handelbarZurBezugszeit(u) ? 'handelbar' : 'ausserhalb');
  const ereignis = u.sichtung?.ereignis;
  if (typeof ereignis === 'string' && /^[a-z]+$/.test(ereignis)) out.push(`ereignis_${ereignis}`);
  // Task 19 Teil 2b (Red-Team H1): Ein Prompt-Wechsel ist ein Regimewechsel in
  // der Messung. Ohne eigenen Bucket wäre „v2 hilft“ nie belegbar — der
  // Bestand würde gepoolt. Fehlende Fassung = eigener Bucket, nie v1 unterstellt.
  out.push(Number.isInteger(u.promptV) && (u.promptV as number) > 0 ? `prompt_v${u.promptV}` : 'prompt_unbekannt');
  return out;
}

/**
 * Fall statt Dokument (Red-Team 08.10., B3a): Jeder Folgeartikel ist ein
 * eigenes Urteil mit demselben Ergebnis — Stufe 2b handelt je Symbol und
 * 6 h genau einmal. Gezählt wird deshalb ein Fall je (Symbol, Bezugstag);
 * Geschwister bekommen ihre Bewertung, zählen aber nicht ins Aggregat.
 */
export function fallSchluessel(u: KiUrteilRoh): string | null {
  const bezug = bezugZeitMs(u);
  if (bezug === null || typeof u.symbol !== 'string') return null;
  return `${u.symbol}|${etTag(bezug)}`;
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
export const KI_WIRKUNG_TAGE = 3;
/** Mindestens so viele Scans mit HANDELBARER Lage (Urteil ≤ 120 min alt, Markt offen) —
 *  ein einzelnes Urteil liefert höchstens 24 (Red-Team 08.10., B5). */
export const KI_WIRKUNG_LAGE_MIN = 24;

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
/** Kennzahlen eines Buckets für Bericht und Herzschlag — nur Summen, gerundet. */
export function fallKennzahlen(s: Partial<KiFallStat> | null | undefined): {
  n: number;
  quotePct: number | null;
  nettoAvgPct: number | null;
  ueberMarktQuotePct: number | null;
} {
  const n = s?.n ?? 0;
  const nMarkt = s?.nMarkt ?? 0;
  return {
    n,
    quotePct: n > 0 ? Math.round(((s?.treffer ?? 0) / n) * 1000) / 10 : null,
    nettoAvgPct: n > 0 ? Math.round(((s?.nettoSum ?? 0) / n) * 100) / 100 : null,
    ueberMarktQuotePct: nMarkt > 0 ? Math.round(((s?.trefferMarkt ?? 0) / nMarkt) * 1000) / 10 : null,
  };
}

export function wochenNachricht(
  woche: string,
  wirksam: Partial<KiFallStat> | null | undefined,
  gesamt: Partial<KiFallStat> | null | undefined,
  gewicht: number,
  holdout?: Partial<KiFallStat> | null,
): string {
  const q = (s: Partial<KiFallStat> | null | undefined): string => {
    const k = fallKennzahlen(s);
    if (k.n === 0) return 'noch keine bewerteten Fälle';
    const netto = k.nettoAvgPct ?? 0;
    return (
      `${k.n} Fälle, Trefferquote ${Math.round(k.quotePct ?? 0)} %, Ø netto ${netto >= 0 ? '+' : ''}${netto.toFixed(2)} %`
      + (k.ueberMarktQuotePct === null ? '' : `, Anteil über Symbol-Drift ${Math.round(k.ueberMarktQuotePct)} %`)
    );
  };
  return (
    `🤖 System: KI-Wochenbericht ${woche} — Arm A (steuert): ${q(wirksam)}; alle Urteile: ${q(gesamt)}`
    + (holdout ? `; Holdout B (steuert nicht): ${q(holdout)}` : '')
    + `. Gewicht der KI-Stimme: ×${gewicht.toFixed(2)}`
    + (gewicht === 1 && (wirksam?.n ?? 0) < KI_MIN_FAELLE
      ? ` (unter ${KI_MIN_FAELLE} wirksamen Fällen bleibt es bei Stufe 2b).`
      : '.')
  );
}
