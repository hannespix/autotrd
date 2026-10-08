/**
 * Task 19, Teil 2c — Fundamental-Schatten (08.10.).
 *
 * Zwei Fragen, die der Owner an Yahoo-Daten stellte („können wir das in
 * Entscheidungsprozesse einbauen?"), werden hier zuerst GEMESSEN, nicht
 * entschieden:
 *
 *  1. Gewinntermin: Ein Einstieg kurz vor den Zahlen ist eine Wette auf ein
 *     binäres Ereignis, das die Technik nicht sieht. Wie viele Einstiege,
 *     die das Kosten-Tor durchlässt, lägen ≤ GEWINNTERMIN_SPERRTAGE vor
 *     dem nächsten Termin?
 *  2. Liquidität: Unter DOLLARVOL_MIN_USD Tagesumsatz frisst der Spread die
 *     Kante; unter MARKTKAP_MIN_MIO ist der Kurs manipulierbar. Wie viele
 *     Einstiege beträfe das?
 *
 * Die Zähler stehen im Herzschlag (`entryGate.*_wuerde_blocken`) neben den
 * anderen Schatten-Toren und im Lagebericht. Sie blocken NICHTS — ob aus
 * der Messung ein Tor wird, entscheidet die realisierte Kante dieser
 * Einstiege out-of-sample (CLAUDE.md §11: jede Verbesserung ist Einbildung,
 * bis sie nach Kosten überlebt).
 */
import type { Kennzahlen } from './kennzahlen.js';
import type { Profil } from './profil.js';

/** Einstieg ≤ so viele Kalendertage vor dem nächsten Gewinntermin (0 = am Tag selbst). */
export const GEWINNTERMIN_SPERRTAGE = 2;
/** Ø-Tagesumsatz (3 Monate × letzter Kurs) unter dieser Schwelle = illiquide. */
export const DOLLARVOL_MIN_USD = 2_000_000;
/** Marktkapitalisierung (Mio USD) unter dieser Schwelle = Kleinstwert. */
export const MARKTKAP_MIN_MIO = 300;

export interface FundamentalBefund {
  /** Es gab ein Profil (Finnhub) — ohne Profil ist nur die Liquidität messbar. */
  profilVorhanden: boolean;
  /** Kalendertage bis zum nächsten Gewinntermin; null ohne Termin oder bei Termin in der Vergangenheit (veraltet). */
  tageBisZahlen: number | null;
  gewinnterminNah: boolean;
  /** Ø-Volumen (3 Monate) × Kurs in USD; null ohne Ø-Volumen. */
  dollarVolUsd: number | null;
  illiquide: boolean;
  kleinstwert: boolean;
}

const TAG_MS = 86_400_000;
const istDatum = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Kalendertage von `heute` bis `termin` (beide YYYY-MM-DD); negativ = vorbei. */
export function tageBis(heute: string, termin: string): number {
  return Math.round((Date.parse(`${termin}T00:00:00Z`) - Date.parse(`${heute}T00:00:00Z`)) / TAG_MS);
}

/**
 * Pure Beurteilung eines Symbols. `preis` ist der letzte Kurs (USD, die
 * Profil-Klassen sind US-Aktien). Alles, was fehlt, ist „nicht messbar",
 * nie „blockieren" — die Zähler sollen Lücken zeigen, nicht füllen.
 */
export function fundamentalBefund(
  profil: Partial<Profil> | null | undefined,
  kennzahlen: Partial<Kennzahlen> | null | undefined,
  preis: number | null | undefined,
  heute: string,
): FundamentalBefund {
  const termin = profil?.gewinntermin;
  const tage = istDatum(termin) && istDatum(heute) ? tageBis(heute, termin) : null;
  // Ein Termin in der Vergangenheit ist ein veraltetes Profil — keine Aussage.
  const tageBisZahlen = tage !== null && tage >= 0 ? tage : null;
  const vol = kennzahlen?.volDurchschnitt3M;
  const dollarVolUsd =
    typeof vol === 'number' && vol > 0 && typeof preis === 'number' && preis > 0 ? vol * preis : null;
  const mk = profil?.marktkapMio;
  return {
    profilVorhanden: !!profil && typeof profil === 'object',
    tageBisZahlen,
    gewinnterminNah: tageBisZahlen !== null && tageBisZahlen <= GEWINNTERMIN_SPERRTAGE,
    dollarVolUsd,
    illiquide: dollarVolUsd !== null && dollarVolUsd < DOLLARVOL_MIN_USD,
    kleinstwert: typeof mk === 'number' && mk > 0 && mk < MARKTKAP_MIN_MIO,
  };
}

/** Deckung der Messung im Herzschlag: Wie viele Symbole konnten überhaupt beurteilt werden? */
export interface FundamentalSchattenStand {
  mitProfil: number;
  ohneProfil: number;
  mitVolumen: number;
  /** Zähler aus dem Einstiegs-Tor (nur was das Kosten-Tor durchließ). */
  gewinnterminNah: number;
  illiquide: number;
  kleinstwert: number;
  parameter: { sperrtage: number; dollarVolMinUsd: number; marktkapMinMio: number };
}

export function fundamentalSchattenStand(
  befunde: Iterable<FundamentalBefund | null | undefined>,
  zaehler: { gewinntermin_wuerde_blocken: number; illiquide_wuerde_blocken: number; kleinstwert_wuerde_blocken: number },
): FundamentalSchattenStand {
  let mitProfil = 0;
  let ohneProfil = 0;
  let mitVolumen = 0;
  for (const b of befunde) {
    if (!b) continue;
    if (b.profilVorhanden) mitProfil += 1;
    else ohneProfil += 1;
    if (b.dollarVolUsd !== null) mitVolumen += 1;
  }
  return {
    mitProfil,
    ohneProfil,
    mitVolumen,
    gewinnterminNah: zaehler.gewinntermin_wuerde_blocken,
    illiquide: zaehler.illiquide_wuerde_blocken,
    kleinstwert: zaehler.kleinstwert_wuerde_blocken,
    parameter: { sperrtage: GEWINNTERMIN_SPERRTAGE, dollarVolMinUsd: DOLLARVOL_MIN_USD, marktkapMinMio: MARKTKAP_MIN_MIO },
  };
}
