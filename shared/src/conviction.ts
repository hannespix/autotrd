/**
 * Überzeugungs-Sizing (Owner-Direktive 01.08.): „Je sicherer und klarer die
 * Gewinn-Chancen bei einem Trade sind, desto mehr soll investiert werden."
 *
 * Der Faktor skaliert die Positionsgröße — aber „sicher und klar" wird hier
 * MESSBAR gemacht, nicht gefühlt:
 *
 * 1. Konfluenz-Überschuss (wie deutlich das Signal über seiner
 *    Einstiegsschwelle liegt): kleiner Bonus, hart gedeckelt. Klein deshalb,
 *    weil die Live-Messung gezeigt hat, dass Indikator-Einigkeit allein
 *    keine Kante garantiert — Enthusiasmus ist kein Beweis.
 * 2. Steckbrief-Evidenz des Trade-Filters (realisierte Trades dieser
 *    Signalsorte): der einzige Weg ÜBER Faktor 1,25 hinaus. Hochskaliert
 *    wird nur, was im echten Handel bereits Geld verdient hat (t ≥ +1,5
 *    über ≥ 15 Trades); nachweislich schwache Sorten werden HALBIERT,
 *    lange bevor der harte Block greift. Das ist gedämpftes Kelly-Denken:
 *    Einsatz folgt bewiesener Kante, in beide Richtungen.
 *
 * Der Faktor kann die Klumpengrenze nie aushebeln — der Broker deckelt die
 * effektive Positionsgröße zusätzlich bei 25 % (sizeOrder).
 */

import { bucketTStat, type BucketStat } from './tradeFilter.js';

/** Härteste Dämpfung — nie ganz null (null wäre ein Block, den entscheidet der Filter). */
export const CONVICTION_MIN = 0.25;
/** Höchste Verstärkung — 1,5× braucht bewiesene Kante UND klaren Überschuss. */
export const CONVICTION_MAX = 1.5;
/**
 * Ab wie vielen realisierten Trades die Steckbrief-Evidenz mitskaliert.
 * Halbe Block-Schwelle: Skalieren ist milder als Blocken, darf also früher
 * auf Evidenz reagieren.
 */
export const CONVICTION_MIN_SAMPLES = 15;
/** t ab hier: bewiesene Kante ⇒ Verstärkung. */
export const CONVICTION_T_UP = 1.5;
/** t bis hier: nachweislich schwach ⇒ Halbierung (Vorstufe des Blocks). */
export const CONVICTION_T_DOWN = -0.75;
/** Bonus je Konfluenz-Stimme über der Schwelle … */
export const CONVICTION_SURPLUS_STEP = 0.125;
/** … gedeckelt: Enthusiasmus allein hebt höchstens auf 1,25. */
export const CONVICTION_SURPLUS_CAP = 0.25;

export interface ConvictionInput {
  /** Stimmen der gewählten Richtung (inkl. Prognose-Pfeil). */
  konfluenz: number;
  /** Einstiegsschwelle der Strategie. */
  requiredConfluence: number;
  /** Realisierte Statistik des Einstiegs-Steckbriefs (Trade-Filter). */
  bucket?: BucketStat | null;
}

/** Positionsgrößen-Faktor aus messbarer Überzeugung, geklemmt auf [0,25; 1,5]. */
export function convictionFactor(input: ConvictionInput): number {
  const { konfluenz, requiredConfluence } = input;
  let f = 1;

  if (Number.isFinite(konfluenz) && Number.isFinite(requiredConfluence)) {
    const surplus = Math.max(0, konfluenz - requiredConfluence);
    f += Math.min(CONVICTION_SURPLUS_CAP, surplus * CONVICTION_SURPLUS_STEP);
  }

  const stat = input.bucket ?? null;
  if (stat && stat.n >= CONVICTION_MIN_SAMPLES) {
    const t = bucketTStat(stat);
    if (t !== null) {
      if (t >= CONVICTION_T_UP) f += CONVICTION_SURPLUS_CAP;
      // Zwischen Halbierung und hartem Block (FILTER_T_BLOCK im Filter)
      // liegt bewusst eine Stufe: erst wird der Einsatz klein, dann fällt
      // das Handelsrecht.
      else if (t <= CONVICTION_T_DOWN) f *= 0.5;
    }
  }

  return Math.min(CONVICTION_MAX, Math.max(CONVICTION_MIN, Math.round(f * 1000) / 1000));
}
