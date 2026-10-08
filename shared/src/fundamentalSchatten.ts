/**
 * Task 19, Teil 2c — Fundamental-Schatten (08.10.).
 *
 * Zwei Fragen, die der Owner an Yahoo-Daten stellte („können wir das in
 * Entscheidungsprozesse einbauen?"), werden hier zuerst GEMESSEN, nicht
 * entschieden:
 *
 *  1. Gewinntermin: Ein Einstieg kurz vor den Zahlen ist eine Wette auf ein
 *     binäres Ereignis, das die Technik nicht sieht. Wie viele Prüfungen,
 *     die das Kosten-Tor durchlässt, lägen ≤ GEWINNTERMIN_SPERRTAGE vor
 *     dem nächsten Termin?
 *  2. Liquidität: Unter DOLLARVOL_MIN_USD Tagesumsatz frisst der Spread die
 *     Kante; unter MARKTKAP_MIN_MIO ist der Kurs manipulierbar.
 *
 * Die Zähler stehen im Herzschlag (`entryGate.*_wuerde_blocken` je Scan und
 * `fundamentalSchatten` als TAGESSUMME über die US-Scans) und im Lagebericht.
 * Sie blocken NICHTS — ob aus der Messung ein Tor wird, entscheidet die
 * realisierte Kante dieser Einstiege out-of-sample (CLAUDE.md §11).
 *
 * Was die Zahl IST (Red-Team 08.10., M1/M2): Einstiegs-PRÜFUNGEN je Konto
 * und Pfad, die das scharfe Kosten-Tor durchließ — keine Einstiege. Ein
 * Kandidat zählt in jedem 5-Minuten-Scan erneut, solange er nicht
 * eingestiegen ist, und auch dann, wenn ihn später ein anderes Tor
 * ablehnt. Die Zahl ist eine Rate, als solche beschriftet, und nur über
 * den Tag vergleichbar — deshalb das Tagesaggregat.
 */
import type { Kennzahlen } from './kennzahlen.js';
import { PROFIL_KLASSEN, type Profil } from './profil.js';

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
  /** 'bmo' (vor Eröffnung) | 'amc' (nach Schluss) | 'dmh' | null — aus dem Finnhub-Kalender. */
  gewinnterminZeit: string | null;
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
 *
 * Tag 0 (Red-Team N1): Zahlen VOR Eröffnung (bmo) sind beim Tages-Scan
 * schon draußen — der Tag zählt dann nicht als „vor den Zahlen". Nach
 * Schluss (amc) oder unbekannt zählt er; ein Einstieg Stunden vor der
 * Veröffentlichung ist genau der Fall, den die Messung sehen soll.
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
  const zeit = typeof profil?.gewinnterminZeit === 'string' ? profil.gewinnterminZeit : null;
  const vol = kennzahlen?.volDurchschnitt3M;
  const dollarVolUsd =
    typeof vol === 'number' && vol > 0 && typeof preis === 'number' && preis > 0 ? vol * preis : null;
  const mk = profil?.marktkapMio;
  return {
    profilVorhanden: !!profil && typeof profil === 'object',
    tageBisZahlen,
    gewinnterminZeit: zeit,
    gewinnterminNah:
      tageBisZahlen !== null && tageBisZahlen <= GEWINNTERMIN_SPERRTAGE && !(tageBisZahlen === 0 && zeit === 'bmo'),
    dollarVolUsd,
    illiquide: dollarVolUsd !== null && dollarVolUsd < DOLLARVOL_MIN_USD,
    kleinstwert: typeof mk === 'number' && mk > 0 && mk < MARKTKAP_MIN_MIO,
  };
}

/**
 * Tagesaggregat im Herzschlag. Der Lagebericht läuft 18:25 ET und läse
 * sonst den Krypto-Scan von 18:20 (Red-Team H1: Deckung 0, drei Nullen,
 * „Messung" genannt). Deshalb: Nur Scans mit US-Aktien schreiben das Feld,
 * gleicher ET-Tag summiert die Zähler, ein neuer Tag beginnt frisch.
 * Deckung bezieht sich NUR auf Profil-Klassen (Red-Team M5) — Krypto,
 * Forex, Indizes können kein Profil haben und sind keine Lücke.
 */
export interface FundamentalSchattenStand {
  /** ET-Kalendertag des Aggregats. */
  tag: string;
  /** Zahl der US-Scans, die an diesem Tag eingeflossen sind. */
  scans: number;
  /** Zeitpunkt des letzten eingeflossenen Scans. */
  at: string;
  /** Deckung im letzten US-Scan: beurteilte Symbole der Profil-Klassen … */
  usAktien: number;
  /** … davon mit Profil, mit messbarem (künftigem) Gewinntermin, mit Ø-Volumen. */
  mitProfil: number;
  gewinnterminMessbar: number;
  mitVolumen: number;
  /** Tagessummen der Tor-Zähler (Prüfungen je Konto, die das Kosten-Tor durchließ). */
  gewinnterminNah: number;
  illiquide: number;
  kleinstwert: number;
  parameter: { sperrtage: number; dollarVolMinUsd: number; marktkapMinMio: number };
}

export interface FundamentalEintrag {
  klasse: string;
  befund: FundamentalBefund | null | undefined;
}

const zahl = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** null = dieser Scan hatte keine US-Aktien → Feld im Herzschlag unverändert lassen. */
export function fundamentalSchattenTag(
  vorher: Partial<FundamentalSchattenStand> | null | undefined,
  eintraege: Iterable<FundamentalEintrag>,
  zaehler: { gewinntermin_wuerde_blocken: number; illiquide_wuerde_blocken: number; kleinstwert_wuerde_blocken: number },
  tag: string,
  at: string,
): FundamentalSchattenStand | null {
  let usAktien = 0;
  let mitProfil = 0;
  let gewinnterminMessbar = 0;
  let mitVolumen = 0;
  for (const e of eintraege) {
    if (!e.befund || !PROFIL_KLASSEN.includes(e.klasse)) continue;
    usAktien += 1;
    if (e.befund.profilVorhanden) mitProfil += 1;
    if (e.befund.tageBisZahlen !== null) gewinnterminMessbar += 1;
    if (e.befund.dollarVolUsd !== null) mitVolumen += 1;
  }
  if (usAktien === 0) return null;
  const gleicherTag = vorher?.tag === tag;
  const alt = (k: keyof FundamentalSchattenStand): number => (gleicherTag ? zahl(vorher?.[k]) : 0);
  return {
    tag,
    scans: alt('scans') + 1,
    at,
    usAktien,
    mitProfil,
    gewinnterminMessbar,
    mitVolumen,
    gewinnterminNah: alt('gewinnterminNah') + zahl(zaehler.gewinntermin_wuerde_blocken),
    illiquide: alt('illiquide') + zahl(zaehler.illiquide_wuerde_blocken),
    kleinstwert: alt('kleinstwert') + zahl(zaehler.kleinstwert_wuerde_blocken),
    parameter: { sperrtage: GEWINNTERMIN_SPERRTAGE, dollarVolMinUsd: DOLLARVOL_MIN_USD, marktkapMinMio: MARKTKAP_MIN_MIO },
  };
}
