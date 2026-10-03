/**
 * autotrd — User-Prognosen (Chart-Vision 24.07.): der User zeichnet einen
 * Vektor-Pfeil (Ziel-Kurs + Ziel-Datum, Dicke = Vertrauen 1–3) und der
 * Algorithmus nimmt das als zusätzliche gewichtete Richtungsstimme in die
 * Handels-Entscheidung auf. Doc: users/{uid}/predictions/{symbol} —
 * EINE aktive Prognose je Symbol, Schreiben nur über savePrediction.
 */

export interface UserPrediction {
  symbol: string;
  targetPrice: number;
  /** YYYY-MM-DD — nach diesem Tag ist die Prognose abgelaufen. */
  targetDate: string;
  /** 1 = dünner Pfeil … 3 = fetter Pfeil (= Stimmgewicht). */
  confidence: 1 | 2 | 3;
  createdAt: string;
  /** Kurs beim Zeichnen (Pfeil-Ankerpunkt fürs UI). */
  basePrice: number;
  baseDate: string;
}

/** Mindestabstand Ziel vs. aktueller Kurs, damit eine Richtung zählt (±0,2 %). */
export const PREDICTION_MIN_EDGE_PCT = 0.2;
