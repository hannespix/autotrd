/**
 * Positionierungs-Daten als Gelegenheitsdetektor (Owner-Auftrag 04.08.:
 * „denke um die Ecke, nicht nur mit Algorithmen, sondern vielleicht auch mit
 * anderen Informationen") — Stufe 1: NUR MESSEN.
 *
 * ── Warum das eine andere Sorte Information ist ────────────────────────────
 *
 * RSI, MACD und Bollinger sind allesamt Funktionen desselben Preises. Sie
 * sagen, was der Kurs GETAN hat, und sie sagen es alle gleichzeitig — deshalb
 * bringt die vierte Preis-Kennzahl fast nichts, was die dritte nicht schon
 * gesagt hätte. Funding Rate und Open Interest kommen aus einer anderen
 * Quelle: Sie sagen, WER gerade positioniert ist und was es ihn kostet.
 *
 *  - **Funding Rate**: die Gebühr, die Inhaber von Perpetual-Futures
 *    einander alle acht Stunden zahlen. Positiv heißt: Longs zahlen Shorts —
 *    es stehen mehr Leute gehebelt auf der Kaufseite, und sie bezahlen dafür.
 *  - **Open Interest**: die Summe der offenen Kontrakte. Sie unterscheidet
 *    zwei Bewegungen, die im Chart gleich aussehen: Steigt der Kurs MIT
 *    steigendem OI, kommt neues Geld herein; steigt er bei FALLENDEM OI,
 *    decken sich Shorts ein — dieselbe Kerze, aber ohne Nachschub dahinter.
 *
 * ── Was daraus ein Signal macht ────────────────────────────────────────────
 *
 * Extreme Positionierung ist gefährlich für die Seite, die sie hält: Wenn
 * fast alle gehebelt long sind, ist der nächste Rücksetzer keine gewöhnliche
 * Korrektur, sondern eine Kette von Zwangsliquidierungen. Umgekehrt ist ein
 * steigender Kurs bei negativem Funding die Konstellation, aus der die
 * heftigsten Aufwärtsbewegungen entstehen — die Leerverkäufer zahlen dafür,
 * gegen einen Markt zu stehen, der ihnen davonläuft.
 *
 * ── Stufe 1 heißt: keine Handelswirkung ────────────────────────────────────
 *
 * Dieselbe Beweislast wie beim Trade-Filter (31.07.) und der Regime-Ampel
 * (Stufe 1 am 31.07., Stufe 2 erst am 04.08. nach 112 Trades Evidenz): Diese
 * Datei rechnet und wird protokolliert, sie handelt nicht. Erst wenn die
 * Statistik zeigt, dass die Extremwerte tatsächlich Bewegungen vorhersagen,
 * bekommt das Signal Stimmrecht — in einem eigenen, sichtbaren Schritt.
 */

/** Rohdaten je Symbol, wie sie von den Börsen kommen. */
export interface PositioningRaw {
  /** Aktuelle Funding Rate als Anteil je Periode (0,0001 = 0,01 %). */
  fundingRate: number | null;
  /** Offene Kontrakte, in Kontrakten oder Coins — die EINHEIT ist egal,
   *  weil nur die relative Änderung ausgewertet wird. */
  openInterest: number | null;
  /** Open Interest der Vergleichsmessung (typisch 24 h alt). */
  openInterestPrev?: number | null;
  /** Kursänderung seit derselben Vergleichsmessung, in % . */
  priceChangePct?: number | null;
}

/**
 * Funding-Schwelle für „überfüllt" (Anteil je 8-h-Periode).
 *
 * 0,05 % je Periode sind 0,15 % am Tag und rund 55 % im Jahr — wer so viel
 * zahlt, um long zu bleiben, tut das nicht aus Überzeugung, sondern aus
 * Gier. Der langjährige Normalwert liegt bei 0,01 % je Periode; das Fünffache
 * davon ist die übliche Grenze, ab der von einem überhitzten Markt geredet
 * wird.
 */
export const FUNDING_CROWDED = 0.0005;
/**
 * Funding-Schwelle für „Shorts zahlen" (negativ).
 *
 * Negatives Funding ist selten — es heißt, die Short-Seite ist so überfüllt,
 * dass sie die Longs bezahlt. Schon ein moderater Betrag ist hier
 * aussagekräftig, deshalb die kleinere Schwelle.
 */
export const FUNDING_SHORTS_PAY = -0.0001;
/** OI-Rückgang (%), ab dem eine Aufwärtsbewegung als Eindeckung gilt. */
export const OI_DROP_PCT = -5;
/** OI-Anstieg (%), ab dem neues Geld als bestätigt gilt. */
export const OI_BUILD_PCT = 5;

/**
 * Die vier Zustände, die aus Funding und OI ablesbar sind.
 *
 * Bewusst benannt statt als Zahl: Ein Zustand, den man aussprechen kann,
 * lässt sich in der Statistik gegen seinen realisierten Ausgang prüfen —
 * eine Kennzahl zwischen −1 und 1 könnte man immer irgendwie deuten.
 */
export type PositioningState =
  /** Longs überfüllt und zahlen kräftig — Rücksetzer werden zu Liquidierungsketten. */
  | 'longs_ueberfuellt'
  /** Shorts zahlen, Kurs steigt — die Konstellation der heftigsten Rallyes. */
  | 'short_squeeze_setup'
  /** Kurs steigt, aber offene Kontrakte fallen — Aufwärtsbewegung ohne Nachschub. */
  | 'rally_ohne_nachschub'
  /** Kurs steigt mit neuem Geld — die gesunde Variante. */
  | 'neues_geld'
  /** Nichts Auffälliges oder zu wenig Daten. */
  | 'neutral';

export interface PositioningReading {
  state: PositioningState;
  fundingRate: number | null;
  /** Änderung des Open Interest in % gegenüber der Vergleichsmessung. */
  oiChangePct: number | null;
  /** Funding auf Jahressicht (%) — die anschauliche Größe fürs Dashboard. */
  fundingAnnualPct: number | null;
}

/** Prozentuale Änderung, null wenn nicht berechenbar. */
function changePct(now: number | null | undefined, prev: number | null | undefined): number | null {
  if (typeof now !== 'number' || typeof prev !== 'number') return null;
  if (!(prev > 0) || !Number.isFinite(now)) return null;
  return Math.round((now / prev - 1) * 1000) / 10;
}

/**
 * Bewertet die Positionierung eines Symbols.
 *
 * Reihenfolge der Regeln (die erste, die zieht, gewinnt) — sie folgt der
 * Schärfe der Aussage, nicht der Häufigkeit:
 *
 * 1. **short_squeeze_setup**: Funding negativ UND Kurs gestiegen. Die
 *    seltenste und deutlichste Konstellation: Wer short ist, zahlt UND
 *    liegt falsch. Beides zusammen erzwingt Eindeckungen.
 * 2. **longs_ueberfuellt**: Funding über der Überhitzungsschwelle. Sagt
 *    nichts über die Richtung des nächsten Zuges, aber viel über seine
 *    Heftigkeit, falls er nach unten geht.
 * 3. **rally_ohne_nachschub**: Kurs hoch, OI deutlich runter — was aussieht
 *    wie Stärke, ist das Schließen alter Wetten.
 * 4. **neues_geld**: Kurs hoch, OI deutlich hoch.
 *
 * Fehlen Daten, ist das Ergebnis 'neutral'. Das ist die einzige
 * verantwortbare Antwort: Eine Positionierungsaussage ohne
 * Positionierungsdaten wäre geraten, und geraten sieht in der Statistik
 * später genauso aus wie gemessen.
 */
export function positioningState(raw: PositioningRaw): PositioningReading {
  const oiChangePct = changePct(raw.openInterest, raw.openInterestPrev);
  const f = typeof raw.fundingRate === 'number' && Number.isFinite(raw.fundingRate)
    ? raw.fundingRate
    : null;
  // 3 Perioden am Tag × 365 — die Zahl, die Menschen einordnen können.
  const fundingAnnualPct = f === null ? null : Math.round(f * 3 * 365 * 1000) / 10;
  const preisHoch = typeof raw.priceChangePct === 'number' && raw.priceChangePct > 0;

  const fertig = (state: PositioningState): PositioningReading => ({
    state,
    fundingRate: f,
    oiChangePct,
    fundingAnnualPct,
  });

  if (f !== null && f <= FUNDING_SHORTS_PAY && preisHoch) return fertig('short_squeeze_setup');
  if (f !== null && f >= FUNDING_CROWDED) return fertig('longs_ueberfuellt');
  if (preisHoch && oiChangePct !== null && oiChangePct <= OI_DROP_PCT) {
    return fertig('rally_ohne_nachschub');
  }
  if (preisHoch && oiChangePct !== null && oiChangePct >= OI_BUILD_PCT) return fertig('neues_geld');
  return fertig('neutral');
}

/**
 * Zusammenfassung über mehrere Symbole — das, was in den Heartbeat geht.
 *
 * `abgedeckt` ist die wichtigste Zahl darin: Ohne sie ließe sich ein toter
 * Feed nicht von einem ereignislosen Markt unterscheiden. Genau diese
 * Verwechslung war beim News-Veto der Grund, `newsFetched` mitzuschreiben.
 */
export function positioningSummary(
  readings: ReadonlyMap<string, PositioningReading>,
): { abgedeckt: number; zustaende: Record<string, number> } {
  const zustaende: Record<string, number> = {};
  for (const r of readings.values()) {
    zustaende[r.state] = (zustaende[r.state] ?? 0) + 1;
  }
  return { abgedeckt: readings.size, zustaende };
}
