/**
 * Kennzahlen eines Symbols aus dem Yahoo-Chart-Abruf (Task 19, 08.10.) —
 * die Zeile, die auf der Yahoo-Kursseite unter dem Chart steht: Vortag,
 * Öffnen, Tagesspanne, 52-Wochen-Spanne, Volumen, Ø-Volumen. Alles kommt
 * aus dem Abruf, den der Scan ohnehin macht — kein zweiter Request, keine
 * neue Quelle, kein Schlüssel.
 *
 * Drei Fallen aus Bestandsaufnahme und Red-Team (08.10.):
 *  - `chartPreviousClose` ist NICHT der Vortag, sondern der Schluss VOR dem
 *    Abruf-Fenster (bei range=1y der Kurs von vor einem Jahr; gemessen AAPL
 *    5d: 330,32 statt 336,67). Der Vortag ist `bars[n-2].close` — genauer:
 *    der Schluss der Session VOR der letzten gelieferten Kerze. Am Samstag
 *    oder vorbörslich ist die letzte Kerze die letzte SESSION; „Vortag" ist
 *    dann wie Yahoos „Previous Close" der Tag davor — konsistent mit
 *    `changePct`, das genauso rechnet.
 *  - FX liefert Volumen 0 — das ist „unbekannt", nicht null. Indizes tragen
 *    in `regularMarketVolume` einen ANDEREN Maßstab als ihre Tageskerzen
 *    (^NDX: 805 M gegen 7,9 Mrd.); deshalb kommt `volumen` aus der Kerze,
 *    aus derselben Quelle wie das Ø — Meta ist nur der Rückfall.
 *  - Ein 5d-Abruf (Katalog-Rotation, quoteNow alle 45 s) kennt kein
 *    Ø-Volumen und kann degradiert antworten; `kennzahlenFelder` schreibt
 *    deshalb NUR gefüllte Felder ins merge — null löscht nie einen
 *    Scan-Wert.
 */

export interface Kennzahlen {
  /** Schluss der Session VOR der letzten Kerze (Yahoo „Previous Close"). */
  vortag: number | null;
  /** Eröffnung der letzten Session (letzte Tageskerze). */
  oeffnen: number | null;
  tagHoch: number | null;
  tagTief: number | null;
  w52Hoch: number | null;
  w52Tief: number | null;
  /** Volumen der letzten Session aus der Kerze (Rückfall Meta); 0 (FX) wird zu null. */
  volumen: number | null;
  /** Ø Tagesvolumen der letzten VOL_DURCHSCHNITT_TAGE abgeschlossenen Tage. */
  volDurchschnitt3M: number | null;
  /**
   * Wann das Ø zuletzt gerechnet wurde — nur der 1y-Scan (≤ 40 Symbole)
   * rechnet es; das Sheet zeigt es nur, solange es frisch ist, sonst „—"
   * neben einem frischen Tagesvolumen wäre eine eingefrorene Zahl.
   */
  volDurchschnittAt: string | null;
  name: string | null;
  boerse: string | null;
  waehrung: string | null;
  updatedAt: string;
}

/** Ø-Volumen über so viele abgeschlossene Handelstage (≈ 3 Monate) … */
export const VOL_DURCHSCHNITT_TAGE = 63;
/** … aber erst ab so vielen Tagen mit Volumen — sonst null statt Rauschen. */
export const VOL_DURCHSCHNITT_MIN = 40;

export interface KennzahlenMeta {
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketVolume?: number;
  longName?: string;
  shortName?: string;
  fullExchangeName?: string;
  exchangeName?: string;
  currency?: string;
}

export interface KennzahlenBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const positiv = (v: unknown): number | null => {
  const z = zahl(v);
  return z !== null && z > 0 ? z : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Ø-Volumen gilt als frisch, solange es jünger ist als so viele Tage (Wochenende inklusive). */
export const VOL_DURCHSCHNITT_FRISCH_TAGE = 4;

/**
 * Ø Tagesvolumen der letzten `tage` ABGESCHLOSSENEN Kerzen (die letzte,
 * laufende Kerze zählt nicht mit — ihr Volumen wächst noch). Null, wenn
 * weniger als `min` Kerzen ein Volumen tragen (junge Listings, FX).
 */
export function durchschnittsVolumen(
  bars: readonly KennzahlenBar[],
  tage = VOL_DURCHSCHNITT_TAGE,
  min = VOL_DURCHSCHNITT_MIN,
): number | null {
  if (bars.length < 2) return null;
  const fenster = bars.slice(Math.max(0, bars.length - 1 - tage), bars.length - 1);
  const mitVolumen = fenster.filter((b) => Number.isFinite(b.volume) && b.volume > 0);
  if (mitVolumen.length < min) return null;
  const summe = mitVolumen.reduce((s, b) => s + b.volume, 0);
  return Math.round(summe / mitVolumen.length);
}

/** Pure Zusammenstellung aus Chart-Meta und Tageskerzen (jüngste zuletzt). */
export function kennzahlenAus(meta: KennzahlenMeta, bars: readonly KennzahlenBar[], updatedAt: string): Kennzahlen {
  const letzte = bars[bars.length - 1];
  const vorletzte = bars.length >= 2 ? bars[bars.length - 2] : undefined;
  const avg = durchschnittsVolumen(bars);
  return {
    vortag: positiv(vorletzte?.close),
    oeffnen: positiv(letzte?.open),
    tagHoch: positiv(meta.regularMarketDayHigh) ?? positiv(letzte?.high),
    tagTief: positiv(meta.regularMarketDayLow) ?? positiv(letzte?.low),
    w52Hoch: positiv(meta.fiftyTwoWeekHigh),
    w52Tief: positiv(meta.fiftyTwoWeekLow),
    volumen: positiv(letzte?.volume) ?? positiv(meta.regularMarketVolume),
    volDurchschnitt3M: avg,
    volDurchschnittAt: avg === null ? null : updatedAt,
    name: text(meta.longName) ?? text(meta.shortName),
    boerse: text(meta.fullExchangeName) ?? text(meta.exchangeName),
    waehrung: text(meta.currency),
    updatedAt,
  };
}

/** Ist das Ø-Volumen noch frisch genug fürs Sheet? */
export function volDurchschnittFrisch(at: string | null | undefined, jetztMs = Date.now()): boolean {
  if (typeof at !== 'string') return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && jetztMs - t <= VOL_DURCHSCHNITT_FRISCH_TAGE * 86_400_000;
}

/**
 * Felder fürs merge-Schreiben: NUR gefüllte Felder (plus updatedAt). Ein
 * 5d-Abruf (Katalog-Rotation, quoteNow alle 45 s) kennt kein Ø-Volumen und
 * kann degradiert antworten (eine Kerze, kein fiftyTwoWeek*) — null würde
 * bei `set(…, {merge:true})` den Scan-Wert LÖSCHEN und das Sheet flackern
 * lassen (Red-Team M2). Firestore mischt verschachtelte Maps feldweise,
 * also fehlt das Feld hier einfach. `undefined` (Mock ohne kennzahlen)
 * ergibt ein leeres Objekt statt eines Absturzes.
 */
export function kennzahlenFelder(k: Kennzahlen | null | undefined): Partial<Kennzahlen> {
  if (!k) return {};
  const out: Partial<Kennzahlen> = {};
  for (const [key, value] of Object.entries(k) as [keyof Kennzahlen, Kennzahlen[keyof Kennzahlen]][]) {
    if (value !== null && value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
