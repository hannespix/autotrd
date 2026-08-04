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

/**
 * Wie viel der erwarteten Auslenkung ein Signal tatsächlich einfängt.
 *
 * ── Der Denkfehler, den diese Zahl behebt ─────────────────────────────────
 *
 * Die Prüfung oben vergleicht die erwartete BEWEGUNG mit den Kosten. Am
 * 04.08. stand `unter_kosten` bei `geprueft: 12` auf 0 — die Schwelle ließ
 * ausnahmslos alles durch, und der Grund war kein Rechenfehler, sondern ein
 * Denkfehler: Bewegung ist kein Gewinn. Ein Random Walk mit 4 % Auslenkung
 * hat Erwartungswert null. Wer nur die Auslenkung gegen die Kosten hält,
 * misst, ob sich ein Instrument BEWEGT — nicht, ob man an dieser Bewegung
 * verdient.
 *
 * Was zählt, ist der Anteil der Bewegung, den die Signale einfangen. Genau
 * den hat die Klassen-Attribution vom 04.08. sichtbar gemacht, und die
 * Unterschiede sind gewaltig:
 *
 *   etf_thematic   63 Trades   Kante +0,81 %   ⇒ fängt ~60 % der Bewegung
 *   stocks_us      38 Trades   Kante +0,19 %   ⇒ fängt ~25 %
 *   crypto        290 Trades   Kante −0,19 %   ⇒ fängt ~8 %
 *
 * Dieselben Signale, dasselbe Regelwerk — und trotzdem verdient die eine
 * Klasse Geld und die andere verbrennt es. Krypto stellte 55 % aller Trades
 * und den größten Einzelverlust (−1.132,87 $); ohne Krypto stünde das
 * System bei +40,12 $ statt −1.092,75 $.
 *
 * ── Warum diese Werte konservativ und grob sind ───────────────────────────
 *
 * Sie stammen aus EINER Messwoche. Die gemessenen Quoten hier auf die
 * Nachkommastelle zu übernehmen, wäre Überanpassung an eine Marktphase —
 * derselbe Fehler, für den weiter oben der Fünf-Jahres-Backtest verworfen
 * wurde. Deshalb bewusst wenige, runde Stufen, und im Zweifel die
 * niedrigere: Eine zu klein geschätzte Einfangquote lässt einen guten Trade
 * aus (Kosten: entgangener Gewinn), eine zu große lässt einen schlechten zu
 * (Kosten: echtes Geld). Die beiden sind nicht gleich teuer.
 *
 * Der Wert ist eine ANNAHME über die Signalgüte, keine gemessene Konstante.
 * Sobald genug Trades je Klasse vorliegen, gehört er aus der laufenden
 * Attribution nachgeführt statt hier gepflegt.
 */
export const CLASS_CAPTURE: Record<string, number> = {
  etf_thematic: 0.5,
  stocks_us: 0.25,
  stocks_global: 0.25,
  etf_sectors: 0.2,
  etf_regions: 0.2,
  rates_bonds: 0.2,
  commodities: 0.15,
  crypto: 0.1,
};

/**
 * Voreinstellung für unbekannte Klassen.
 *
 * Bewusst am unteren Rand: Eine Klasse, über die nichts bekannt ist, hat
 * keinen Vertrauensvorschuss verdient.
 */
export const DEFAULT_CAPTURE = 0.15;

/** Einfangquote einer Anlageklasse (unbekannt ⇒ DEFAULT_CAPTURE). */
export function captureForClass(assetClass: string | undefined): number {
  return CLASS_CAPTURE[(assetClass ?? '').toLowerCase()] ?? DEFAULT_CAPTURE;
}

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
  /**
   * Anteil der Bewegung, den die Signale einfangen (0…1). Fehlt er, wird
   * die Prüfung wie bisher auf die reine Auslenkung angewandt — damit bleibt
   * jeder bestehende Aufrufer unverändert (siehe `capture`-Kommentar oben).
   */
  capture?: number;
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
  /** Erwarteter GEWINN = Auslenkung × Einfangquote — die Zahl, die zählt. */
  edgePct: number;
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
    return { ok: true, expectedPct: 0, edgePct: 0, costPct, needPct, reason: 'kein_atr' };
  }
  const bars = holdBars(input.minHoldMin, BAR_MINUTES[input.timeframe]);
  const expectedPct = expectedMovePct(atr, bars);
  // Ohne Einfangquote bleibt es beim alten Verhalten: Auslenkung gegen
  // Kosten. Ein Aufrufer, der die Klasse nicht kennt, bekommt damit exakt
  // die Prüfung von vorher — die Verschärfung kommt nur dort an, wo sie
  // begründet werden kann.
  const capture =
    typeof input.capture === 'number' && input.capture > 0 && input.capture <= 1
      ? input.capture
      : 1;
  const edgePct = expectedPct * capture;
  // Mit Toleranz vergleichen — gleiche Konvention wie riskExitReason: Ein
  // Wert, der rechnerisch exakt auf der Schwelle liegt, soll durchkommen.
  // `0.3/√12 × √12` ergibt in Gleitkomma 0.29999999999999993 und verfehlte
  // die 0,3-%-Grenze sonst um ein Bit.
  if (edgePct < needPct - Math.abs(needPct) * 1e-9 - 1e-12) {
    return { ok: false, expectedPct, edgePct, costPct, needPct, reason: 'bewegung_unter_kosten' };
  }
  return { ok: true, expectedPct, edgePct, costPct, needPct };
}
