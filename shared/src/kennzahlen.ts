/**
 * Kennzahlen eines Symbols aus dem Yahoo-Chart-Abruf (Task 19, 08.10.) —
 * die Zeile, die auf der Yahoo-Kursseite unter dem Chart steht: Vortag,
 * Öffnen, Tagesspanne, 52-Wochen-Spanne, Volumen, Ø-Volumen. Alles kommt
 * aus dem Abruf, den der Scan ohnehin macht — kein zweiter Request, keine
 * neue Quelle, kein Schlüssel.
 *
 * Zwei Fallen aus der Bestandsaufnahme:
 *  - `chartPreviousClose` ist NICHT der Vortag, sondern der Schluss VOR dem
 *    Abruf-Fenster (bei range=1y der Kurs von vor einem Jahr; gemessen AAPL
 *    5d: 330,32 statt 336,67). Der Vortag ist `bars[n-2].close`.
 *  - FX und Indizes liefern Volumen 0 — das ist „unbekannt", nicht null.
 */

export interface Kennzahlen {
  /** Schlusskurs des Vortags (vorletzte Tageskerze). */
  vortag: number | null;
  /** Eröffnung des laufenden Tages (letzte Tageskerze). */
  oeffnen: number | null;
  tagHoch: number | null;
  tagTief: number | null;
  w52Hoch: number | null;
  w52Tief: number | null;
  /** Volumen des laufenden Tages; 0 (FX, Indizes) wird zu null. */
  volumen: number | null;
  /** Ø Tagesvolumen der letzten VOL_DURCHSCHNITT_TAGE abgeschlossenen Tage. */
  volDurchschnitt3M: number | null;
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
  return {
    vortag: positiv(vorletzte?.close),
    oeffnen: positiv(letzte?.open),
    tagHoch: positiv(meta.regularMarketDayHigh) ?? positiv(letzte?.high),
    tagTief: positiv(meta.regularMarketDayLow) ?? positiv(letzte?.low),
    w52Hoch: positiv(meta.fiftyTwoWeekHigh),
    w52Tief: positiv(meta.fiftyTwoWeekLow),
    volumen: positiv(meta.regularMarketVolume) ?? positiv(letzte?.volume),
    volDurchschnitt3M: durchschnittsVolumen(bars),
    name: typeof meta.longName === 'string' && meta.longName ? meta.longName : typeof meta.shortName === 'string' && meta.shortName ? meta.shortName : null,
    boerse: typeof meta.fullExchangeName === 'string' && meta.fullExchangeName ? meta.fullExchangeName : typeof meta.exchangeName === 'string' && meta.exchangeName ? meta.exchangeName : null,
    waehrung: typeof meta.currency === 'string' && meta.currency ? meta.currency : null,
    updatedAt,
  };
}

/**
 * Felder fürs merge-Schreiben: Ein 5d-Abruf (Katalog-Rotation, quoteNow)
 * kennt kein Ø-Volumen — er darf den 1y-Wert des Scans nicht mit null
 * überschreiben. Firestore `set(…, {merge:true})` mischt verschachtelte
 * Maps feldweise, also fehlt das Feld hier einfach.
 */
export function kennzahlenFelder(k: Kennzahlen): Partial<Kennzahlen> {
  const { volDurchschnitt3M, ...rest } = k;
  return volDurchschnitt3M === null ? rest : { ...rest, volDurchschnitt3M };
}
