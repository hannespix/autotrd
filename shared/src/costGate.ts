/**
 * Kostenschwelle — handeln nur, wenn die Bewegung die Reibung schlagen kann.
 *
 * ── Der Befund, der das ausgelöst hat (Live-Daten 28.07.) ──────────────────
 *
 * 297 Trades über vier Konten:
 *
 *   Netto-P&L      −2 430,01 $
 *   Gebühren        1 773,52 $
 *   Brutto-P&L       −656,49 $
 *   Trefferquote        19,87 %
 *   Ausstieg am Signal  94,95 %   ← Gewinnziel hat NIE ausgelöst
 *
 * Drei Viertel des Verlusts sind Reibung. Und die Ursache steht in der
 * vorletzten Zeile: Die Positionen sterben am Signal, lange bevor sie ihr
 * Ziel erreichen. Der durchschnittliche Gewinn lag bei 0,49 %, der
 * durchschnittliche Verlust bei 0,36 % — bei 0,10 bis 0,50 % Roundtrip-
 * Kosten je nach Anlageklasse. Wir haben also systematisch um Beträge
 * gehandelt, die in der Größenordnung der Gebühren lagen.
 *
 * ── Warum es KEINE Schwelle auf das Gewinnziel ist ────────────────────────
 *
 * Der naheliegende Gedanke wäre: „Trade ablehnen, wenn das Ziel die Kosten
 * nicht schlägt." Das würde nichts bewirken. Die Ziele sind groß (4 % global,
 * 10 % Krypto, 2 % Devisen) und liegen weit über jeder Gebühr. Das Problem
 * ist nicht das Ziel, sondern dass es nie erreicht wird.
 *
 * ── Was stattdessen geprüft wird ──────────────────────────────────────────
 *
 * Die Frage muss lauten: Bewegt sich dieses Instrument in der Zeit, die wir
 * es tatsächlich halten, überhaupt genug? Das ist rechenbar:
 *
 *   erwartete Bewegung ≈ ATR je Kerze × √(Anzahl Kerzen)
 *
 * Die Wurzel kommt aus dem Random Walk: Über n Schritte wächst die erwartete
 * Auslenkung mit √n, nicht mit n. Wer linear hochrechnet, überschätzt jede
 * längere Haltedauer massiv — ein Fehler, der eine Kostenschwelle wirkungslos
 * machen würde, weil sie dann immer passiert.
 *
 * Als Haltedauer zählt die Mindest-Haltedauer: Vorher darf der Signal-
 * Ausstieg ohnehin nicht feuern (rulesTrading.minHoldActive), sie ist also
 * die kürzeste Zeit, die eine Position garantiert bekommt. Die konservative
 * Annahme ist hier die richtige.
 *
 * ── Was das konkret aussortiert ───────────────────────────────────────────
 *
 * Ruhige Devisenkreuze. EUR/CHF bewegt sich auf 5-Minuten-Kerzen um
 * Bruchteile eines Promille; über eine Stunde sind das vielleicht 0,05 %,
 * bei 0,06 % Roundtrip-Kosten. Solche Trades KÖNNEN im Mittel nicht
 * aufgehen — egal wie gut das Signal ist. Genau diese Instrumente machten
 * einen großen Teil der 297 Trades aus.
 */

/**
 * Wie viel die erwartete Bewegung über den Kosten liegen muss.
 *
 * 3 ist nicht willkürlich: Bei Faktor 1 wäre der Erwartungswert exakt null
 * (die Bewegung geht ja in beide Richtungen), bei 2 bliebe nach Kosten
 * nichts, was einen Fehlsignal-Anteil von 50 % trüge. Drei heißt: Der Trade
 * muss selbst dann noch tragen, wenn zwei von drei Versuchen danebengehen.
 */
export const MIN_EDGE_MULTIPLE = 3;

/** Kerzenlänge in Minuten je Zeitbasis. */
export const BAR_MINUTES: Record<'intraday' | 'daily', number> = {
  intraday: 5,
  daily: 1440,
};

/** Roundtrip-Kosten in Prozent (beide Seiten) aus dem Satz je Seite. */
export function roundtripCostPct(feeRate: number): number {
  if (!Number.isFinite(feeRate) || feeRate <= 0) return 0;
  return feeRate * 2 * 100;
}

/**
 * Kerzen, die eine Position mindestens gehalten wird.
 *
 * Mindestens 1 — eine Haltedauer von 0 („aus") heißt nicht, dass die Position
 * keine Zeit bekommt, sondern dass der Signal-Ausstieg sofort feuern darf.
 * Dann ist eine Kerze die ehrliche Annahme.
 */
export function holdBars(minHoldMin: number | undefined, barMinutes: number): number {
  if (!(barMinutes > 0)) return 1;
  const min = Number.isFinite(minHoldMin) && (minHoldMin as number) > 0 ? (minHoldMin as number) : 0;
  return Math.max(1, min / barMinutes);
}

/**
 * Erwartete Auslenkung über `bars` Kerzen bei `atrPct` je Kerze.
 *
 * √-Skalierung (Random Walk). Linear zu rechnen wäre der bequeme Fehler:
 * Aus 0,05 % je Kerze würden über 12 Kerzen 0,6 % statt der realistischen
 * 0,17 % — die Schwelle ließe dann praktisch alles durch.
 */
export function expectedMovePct(atrPct: number, bars: number): number {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0;
  if (!Number.isFinite(bars) || bars <= 0) return 0;
  return atrPct * Math.sqrt(bars);
}

export interface CostGateInput {
  /** ATR(14) in Prozent des Kurses, auf der SIGNAL-Zeitbasis gerechnet. */
  atrPct: number | null | undefined;
  /** Mindest-Haltedauer in Minuten (engine.minHoldMin). */
  minHoldMin: number | undefined;
  /** Zeitbasis der Signale — bestimmt die Kerzenlänge. */
  timeframe: 'intraday' | 'daily';
  /** Gebührensatz JE SEITE der Anlageklasse (feeRateForClass). */
  feeRate: number;
  /** Sicherheitsfaktor; Default MIN_EDGE_MULTIPLE. */
  multiple?: number;
}

export interface CostGateResult {
  /** Darf gehandelt werden? */
  ok: boolean;
  /** Erwartete Bewegung über die Mindest-Haltedauer, in %. */
  expectedPct: number;
  /** Roundtrip-Kosten in %. */
  costPct: number;
  /** Was die Bewegung mindestens erreichen muss. */
  needPct: number;
  /** Grund der Ablehnung (nur bei ok === false). */
  reason?: 'bewegung_unter_kosten' | 'kein_atr';
}

/**
 * Trägt dieser Trade seine eigenen Kosten?
 *
 * OHNE ATR wird DURCHGELASSEN, nicht abgelehnt. Das ist die einzige Stelle,
 * an der ich hier bewusst die permissive Richtung wähle, und der Grund ist
 * ein praktischer: Ein fehlender ATR bedeutet nur, dass zu wenige Kerzen
 * vorliegen (frisches Symbol, dünner Handel). Würde das den Trade
 * blockieren, fiele die Engine bei jedem Datenloch still aus — und still
 * ausfallende Systeme sind schlimmer als schlechte, weil niemand es merkt.
 * Der Fall wird deshalb als eigener Grund gezählt und im Heartbeat sichtbar.
 */
export function costGate(input: CostGateInput): CostGateResult {
  const costPct = roundtripCostPct(input.feeRate);
  const needPct = costPct * (input.multiple ?? MIN_EDGE_MULTIPLE);
  const atr = input.atrPct;
  if (typeof atr !== 'number' || !Number.isFinite(atr) || atr <= 0) {
    return { ok: true, expectedPct: 0, costPct, needPct, reason: 'kein_atr' };
  }
  const bars = holdBars(input.minHoldMin, BAR_MINUTES[input.timeframe]);
  const expectedPct = expectedMovePct(atr, bars);
  // Mit Toleranz vergleichen — gleiche Konvention wie riskExitReason: Ein
  // Wert, der rechnerisch exakt auf der Schwelle liegt, soll durchkommen.
  // `0.3/√12 × √12` ergibt in Gleitkomma 0.29999999999999993 und verfehlte
  // die 0,3-%-Grenze sonst um ein Bit.
  if (expectedPct < needPct - Math.abs(needPct) * 1e-9 - 1e-12) {
    return { ok: false, expectedPct, costPct, needPct, reason: 'bewegung_unter_kosten' };
  }
  return { ok: true, expectedPct, costPct, needPct };
}
