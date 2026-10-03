/**
 * Hebel-Ampel (Owner-Direktive 04.08.: „richtig krasse Hebel, wenn sich das
 * Tool sicher ist, welche schnell viel Geld reinspülen. Wenn die Gelegenheit
 * sicher und günstig ist").
 *
 * ── Warum der Hebel bisher am falschen Maß hing ────────────────────────────
 *
 * `effectiveLeverage` (margin.ts) gibt den Hebel frei, sobald die Konfluenz
 * zwei Stimmen über der Einstiegsschwelle liegt. Das misst, wie viele
 * Indikatoren gerade einer Meinung sind — nicht, ob diese Meinung jemals
 * Geld verdient hat. Genau daran ist die Strategie bisher gescheitert: Am
 * 02.08. standen vier Short-Steckbriefe im Trend-Regime bei zusammen 112
 * Trades und 8 Gewinnern. Alle vier hatten Konfluenz. Hebel darauf hätte den
 * Verlust vervielfacht, nicht die Rendite.
 *
 * Deshalb die Reihenfolge, die diese Datei erzwingt: **erst Kante, dann
 * Hebel.** Ein Hebel ist ein Multiplikator — er macht eine positive Kante
 * größer und eine negative auch. Ohne nachgewiesene Kante ist er ein
 * Beschleuniger in eine unbekannte Richtung.
 *
 * ── Die Konjunktion ───────────────────────────────────────────────────────
 *
 * Der Hebel greift NUR, wenn mehrere UNABHÄNGIGE Bedingungen gleichzeitig
 * zutreffen. Unabhängig ist dabei das entscheidende Wort: Fünf Bedingungen,
 * die alle aus dem Preis stammen, sind eine Bedingung in fünf Verkleidungen.
 * Diese hier kommen aus verschiedenen Quellen — Indikatoren, realisierte
 * eigene Handelshistorie, Marktzustand, Positionierungsdaten der Börse und
 * die Kostenrechnung.
 *
 * Dass alle fünf zusammenfallen, ist selten. Das ist beabsichtigt: Der
 * Owner-Wunsch war ausdrücklich „wenn die Gelegenheit sicher und günstig
 * ist" — nicht „öfter".
 */

import { MAX_LEVERAGE, MARGIN_CONFLUENCE_BONUS, MARGIN_MIN_CONFLUENCE } from './margin.js';
import { bucketTStat, type BucketStat } from './tradeFilter.js';
import type { MarketRegime } from './regime.js';
import type { PositioningState } from './positioning.js';

/**
 * t-Wert, ab dem eine Sorte als nachgewiesen profitabel gilt.
 *
 * Spiegelbild von FILTER_T_BLOCK (−1,5), aber bewusst STRENGER: Etwas nicht
 * zu tun ist billig, mit Hebel etwas zu tun ist teuer. Ein t von 2 entspricht
 * grob 95 % Konfidenz, dass der Mittelwert wirklich über null liegt.
 */
export const LEV_T_MIN = 2;
/** t-Wert für den vollen Hebel — deutlich über der bloßen Signifikanz. */
export const LEV_T_FULL = 3;
/** Trades, die eine Sorte braucht, bevor ihr t-Wert überhaupt zählt. */
export const LEV_MIN_SAMPLES = 30;
/**
 * Erwartete Bewegung als Vielfaches der Kosten.
 *
 * Die normale Kostenschwelle liegt bei 2× (costGate). Für einen gehebelten
 * Trade wird 5× verlangt: Der Hebel vervielfacht auch die Kosten, und eine
 * Position, die knapp über der Schwelle liegt, ist mit Hebel eine teure Wette
 * auf ein Rauschen.
 */
export const LEV_MIN_EDGE_MULTIPLE = 5;

/** Was gegen den Hebel sprach — leer heißt: alles erfüllt. */
export type LeverageBlock =
  | 'konfluenz_zu_niedrig'
  | 'regime_nicht_trend'
  | 'keine_belegte_kante'
  | 'positionierung_dagegen'
  | 'bewegung_zu_klein';

export interface LeverageChanceInput {
  /** Erreichte Stimmen des Signals. */
  konfluenz: number;
  /** Konfigurierte Einstiegsschwelle. */
  requiredConfluence: number;
  /** Konfigurierter Maximal-Hebel (1 = aus). */
  leverage: number;
  /** Gemessener Marktzustand. */
  regime: MarketRegime;
  /** Realisierte Statistik GENAU DIESER Trade-Sorte (Steckbrief). */
  bucket: BucketStat | null;
  /** Richtung des geplanten Einstiegs. */
  side: 'long' | 'short';
  /** Positionierungs-Zustand des Symbols (null = unbekannt). */
  positioning: PositioningState | null;
  /** Erwartete Bewegung geteilt durch die Roundtrip-Kosten (null = unbekannt). */
  edgeMultiple: number | null;
}

export interface LeverageChance {
  /** Der freigegebene Hebel: 1 heißt „bar gedeckt wie immer". */
  hebel: number;
  /** Warum NICHT gehebelt wird — für den Heartbeat und die Erklärung. */
  gruende: LeverageBlock[];
}

/**
 * Prüft die Gelegenheit und gibt den Hebel frei — oder eben nicht.
 *
 * Die fünf Bedingungen im Einzelnen:
 *
 * 1. **Konfluenz über der Hebel-Schwelle** (wie bisher): Die Indikatoren
 *    müssen deutlich, nicht knapp einig sein.
 * 2. **Regime = trend**: Im Stress springen Kurse, und ein Stop wird dann
 *    zum nächsten Kurs ausgeführt statt zum Stop-Kurs — mit Hebel ist das
 *    der Weg zum Margin-Call. Im Seitwärtsmarkt fehlt schlicht die
 *    Bewegung, die einen Hebel lohnend macht.
 * 3. **Belegte Kante**: Der Steckbrief dieser Sorte muss mit mindestens 30
 *    Trades ein t ≥ 2 zeigen. Das ist die eigene realisierte Historie, kein
 *    Backtest und keine Theorie — und die einzige Bedingung, die etwas über
 *    die ERTRAGSSEITE aussagt.
 * 4. **Positionierung nicht dagegen**: Ein Kauf in einen überfüllten
 *    Long-Markt hinein ist genau die Konstellation, in der ein normaler
 *    Rücksetzer zur Liquidierungskette wird. Fehlt die Information, ist das
 *    kein Hindernis — nur ein bekanntes Dagegen zählt.
 * 5. **Bewegung ≥ 5× Kosten**: Der Hebel vervielfacht auch die Gebühren.
 *
 * Der Hebel steigt mit der Stärke des Belegs (t ≥ 2 → zweifach, t ≥ 3 →
 * voll), gedeckelt durch den konfigurierten Wert und MAX_LEVERAGE. Warum
 * nicht Kelly: Die saubere Kelly-Formel braucht die Renditeverteilung in
 * Prozent; die Steckbriefe speichern Beträge in Dollar. Eine Kelly-Zahl aus
 * Dollar-Momenten wäre eine Formel mit falscher Einheit — der t-Wert misst
 * dagegen genau das, worauf es hier ankommt: wie sicher die Kante ist.
 */
export function leverageChance(input: LeverageChanceInput): LeverageChance {
  const gruende: LeverageBlock[] = [];
  const konfiguriert = Math.min(Math.max(1, input.leverage), MAX_LEVERAGE);

  const schwelle = Math.max(
    input.requiredConfluence + MARGIN_CONFLUENCE_BONUS,
    MARGIN_MIN_CONFLUENCE,
  );
  if (!(input.konfluenz >= schwelle)) gruende.push('konfluenz_zu_niedrig');
  if (input.regime !== 'trend') gruende.push('regime_nicht_trend');

  const t = input.bucket && input.bucket.n >= LEV_MIN_SAMPLES ? bucketTStat(input.bucket) : null;
  if (t === null || t < LEV_T_MIN) gruende.push('keine_belegte_kante');

  // Nur ein BEKANNTES Dagegen blockiert. Unbekannt ist kein Gegenargument —
  // sonst hinge der Hebel an der Erreichbarkeit einer fremden Börse.
  const dagegen =
    (input.side === 'long' && input.positioning === 'longs_ueberfuellt')
    || (input.side === 'long' && input.positioning === 'rally_ohne_nachschub')
    || (input.side === 'short' && input.positioning === 'short_squeeze_setup');
  if (dagegen) gruende.push('positionierung_dagegen');

  if (input.edgeMultiple === null || input.edgeMultiple < LEV_MIN_EDGE_MULTIPLE) {
    gruende.push('bewegung_zu_klein');
  }

  if (gruende.length > 0 || konfiguriert <= 1) return { hebel: 1, gruende };

  // Stärke des Belegs bestimmt die Höhe — nie über dem konfigurierten Wert.
  const stufe = (t as number) >= LEV_T_FULL ? konfiguriert : Math.min(2, konfiguriert);
  return { hebel: stufe, gruende: [] };
}
