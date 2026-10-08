/**
 * Firmenprofil und Fundamentaldaten (Task 19, Teil 2) — das, was die
 * Yahoo-Kursseite unter „Übersicht" und in der Kennzahlen-Zeile zeigt und
 * der Chart-Abruf NICHT hergibt: Branche, Land, Börsengang, Website,
 * Marktkapitalisierung, Beta, KGV, EPS, Dividendenrendite, nächster
 * Gewinntermin. Quelle ist ein lizenzierter Anbieter (Finnhub, Gratis-
 * Tarif) über `functions/src/core/profilQuelle.ts`; hier steht nur die pure
 * Zusammenstellung, damit sie ohne Netz testbar ist.
 *
 * Grenzen des Gratis-Tarifs, ehrlich: Firmenbeschreibung, Mitarbeiterzahl
 * und Kursziel sind kostenpflichtig — die Beschreibung kommt weiter aus den
 * kuratierten Steckbriefen, Kursziel gibt es nicht. Krypto, Devisen und
 * Indizes haben kein Profil.
 */

export interface Profil {
  name: string | null;
  branche: string | null;
  land: string | null;
  boerse: string | null;
  website: string | null;
  /** Notierungswährung laut profile2 — Marktkap und EPS stehen darin, nie stillschweigend `$`. */
  waehrung: string | null;
  /** Börsengang, YYYY-MM-DD. */
  ipo: string | null;
  /** Marktkapitalisierung in Millionen der Handelswährung. */
  marktkapMio: number | null;
  beta: number | null;
  /** KGV der letzten 12 Monate; null bei Verlust. */
  kgvTtm: number | null;
  /** Gewinn je Aktie der letzten 12 Monate. */
  epsTtm: number | null;
  w52Hoch: number | null;
  w52Tief: number | null;
  /** Angezeigte Jahres-Dividendenrendite in Prozent. */
  dividendenrenditePct: number | null;
  /** Nächster Gewinntermin ≥ heute, YYYY-MM-DD; null, wenn keiner gemeldet. */
  gewinntermin: string | null;
  /** 'bmo' (vor Eröffnung) | 'amc' (nach Schluss) | 'dmh' | null — Finnhub `hour` zum nächsten Termin. */
  gewinnterminZeit: string | null;
  /**
   * Red-Team 08.10.: `metric` kam für CCG mit EPS −26,11 und 52W-Hoch 43,05,
   * Yahoo zeigt −2,20 / 18,16 (Berichtswährung statt Notierung). Weicht das
   * 52W-Hoch um mehr als METRIC_ABWEICHUNG_MAX vom Yahoo-Wert desselben
   * Dokuments ab, bleiben die metric-Werte leer und dieses Flag steht.
   */
  metricVerdacht: boolean;
  quelle: 'finnhub';
  updatedAt: string;
}

/** Klassen mit Profil beim Gratis-Tarif — US-Aktien; ETFs liefern dort meist ein leeres Profil. */
export const PROFIL_KLASSEN: readonly string[] = ['stocks_us'];

/** Rohform von Finnhub `stock/profile2` — nur die Felder, die wir lesen. */
export interface FinnhubProfile2 {
  name?: unknown;
  finnhubIndustry?: unknown;
  country?: unknown;
  exchange?: unknown;
  weburl?: unknown;
  currency?: unknown;
  ipo?: unknown;
  marketCapitalization?: unknown;
}

/** Rohform von Finnhub `stock/metric?metric=all` → `metric`. */
export interface FinnhubMetric {
  marketCapitalization?: unknown;
  beta?: unknown;
  peTTM?: unknown;
  epsTTM?: unknown;
  '52WeekHigh'?: unknown;
  '52WeekLow'?: unknown;
  dividendYieldIndicatedAnnual?: unknown;
}

/** Rohform von Finnhub `calendar/earnings` → `earningsCalendar[]`. */
export interface FinnhubEarning {
  date?: unknown;
  /** 'bmo' | 'amc' | 'dmh' — Tageszeit der Veröffentlichung. */
  hour?: unknown;
}

/** Zulässige relative Abweichung Finnhub-52W-Hoch ↔ Yahoo-52W-Hoch. */
export const METRIC_ABWEICHUNG_MAX = 0.1;

export interface ProfilOptionen {
  /** Lauf nach Börsenschluss (ET): ein Termin von HEUTE ist dann vorbei (bmo wie amc). */
  nachSchluss?: boolean;
  /** 52W-Hoch aus den Yahoo-Kennzahlen desselben Dokuments (Teil 1) — Plausibilitätsanker. */
  yahooW52Hoch?: number | null;
}

/** Weicht der Finnhub-Wert um mehr als METRIC_ABWEICHUNG_MAX vom Yahoo-Anker ab? Ohne Anker: nein. */
export function metricAbweichend(finnhub: number | null, yahoo: number | null | undefined): boolean {
  if (finnhub === null || typeof yahoo !== 'number' || !Number.isFinite(yahoo) || yahoo <= 0) return false;
  return Math.abs(finnhub / yahoo - 1) > METRIC_ABWEICHUNG_MAX;
}

const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const positiv = (v: unknown): number | null => {
  const z = zahl(v);
  return z !== null && z > 0 ? z : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const datum = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * Frühester gemeldeter Termin ≥ `heute` (YYYY-MM-DD); null ohne Treffer.
 * Nach Börsenschluss zählt der heutige Termin nicht mehr (Red-Team M3: um
 * 17:45 ET sind „vor Eröffnung" und „nach Schluss" beide vorbei).
 */
export function naechsterGewinntermin(termine: readonly FinnhubEarning[], heute: string, nachSchluss = false): string | null {
  let best: string | null = null;
  for (const e of termine) {
    const d = datum(e.date);
    if (d === null || d < heute || (nachSchluss && d === heute)) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

/** Tageszeit ('bmo' | 'amc' | 'dmh') des Termins `datum`; null, wenn unbekannt. */
export function gewinnterminZeitVon(termine: readonly FinnhubEarning[], datumWert: string | null): string | null {
  if (datumWert === null) return null;
  for (const e of termine) {
    if (datum(e.date) !== datumWert) continue;
    const h = typeof e.hour === 'string' ? e.hour.trim().toLowerCase() : '';
    return h === 'bmo' || h === 'amc' || h === 'dmh' ? h : null;
  }
  return null;
}

/**
 * Pure Zusammenstellung. Marktkapitalisierung: `profile2` und `metric`
 * liefern beide Millionen — `metric` gewinnt (tagesaktuell), `profile2` ist
 * der Rückfall. Kein Feld wird je `undefined` (Firestore lehnt das ab).
 */
export function profilAus(
  profile2: FinnhubProfile2 | null,
  metric: FinnhubMetric | null,
  termine: readonly FinnhubEarning[],
  heute: string,
  updatedAt: string,
  opt: ProfilOptionen = {},
): Profil {
  const w52Hoch = positiv(metric?.['52WeekHigh']);
  const verdacht = metricAbweichend(w52Hoch, opt.yahooW52Hoch);
  const gewinntermin = naechsterGewinntermin(termine, heute, opt.nachSchluss === true);
  return {
    name: text(profile2?.name),
    branche: text(profile2?.finnhubIndustry),
    land: text(profile2?.country),
    boerse: text(profile2?.exchange),
    website: (() => {
      const w = text(profile2?.weburl);
      return w && /^https?:\/\//i.test(w) ? w : null;
    })(),
    waehrung: text(profile2?.currency)?.toUpperCase() ?? null,
    ipo: datum(profile2?.ipo),
    // Unter Verdacht nur der profile2-Wert; Beta ist dimensionslos und bleibt.
    marktkapMio: verdacht
      ? positiv(profile2?.marketCapitalization)
      : positiv(metric?.marketCapitalization) ?? positiv(profile2?.marketCapitalization),
    beta: zahl(metric?.beta),
    kgvTtm: verdacht ? null : positiv(metric?.peTTM),
    epsTtm: verdacht ? null : zahl(metric?.epsTTM),
    w52Hoch: verdacht ? null : w52Hoch,
    w52Tief: verdacht ? null : positiv(metric?.['52WeekLow']),
    dividendenrenditePct: verdacht ? null : positiv(metric?.dividendYieldIndicatedAnnual),
    gewinntermin,
    gewinnterminZeit: gewinnterminZeitVon(termine, gewinntermin),
    metricVerdacht: verdacht,
    quelle: 'finnhub',
    updatedAt,
  };
}

/** Hat das Profil überhaupt Substanz (sonst nicht schreiben — leere Hülle hilft niemandem)? */
export function profilHatInhalt(p: Profil): boolean {
  return p.name !== null || p.branche !== null || p.marktkapMio !== null || p.epsTtm !== null || p.gewinntermin !== null;
}

/**
 * Yahoo-Symbol → Finnhub-Symbol für US-Aktien: Klassen-Suffixe schreibt
 * Yahoo mit Bindestrich (BRK-B), Finnhub mit Punkt (BRK.B).
 */
export function finnhubSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-([A-Z])$/, '.$1');
}
