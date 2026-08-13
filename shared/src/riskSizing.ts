/**
 * Positionsgröße nach RISIKO statt nach Depotanteil.
 *
 * ── Was vorher galt ───────────────────────────────────────────────────────
 *
 * Jede Position war `maxPositionPct` des Kapitals — 10 %, egal was drinsteht.
 * Bei zehn Positionen sieht das nach gleichmäßiger Streuung aus, ist es aber
 * nicht: Eine 10-%-Position in einem ruhigen Anleihen-ETF (0,3 % Tagesrange)
 * und eine 10-%-Position in einer volatilen Krypto-Wette (5 %) tragen
 * VÖLLIG verschiedene Risiken. Das Depot wird faktisch von den zwei, drei
 * unruhigsten Titeln bestimmt; die ruhigen sind Dekoration.
 *
 * ── Was stattdessen gerechnet wird ────────────────────────────────────────
 *
 * Die Frage dreht sich um: Nicht „wie viel Geld stecke ich hinein", sondern
 * „wie viel darf ich verlieren, wenn der Stop greift". Dieser Betrag ist für
 * alle Positionen gleich; die Stückzahl ergibt sich daraus.
 *
 *   Einsatz = (Eigenkapital × Risiko je Trade) ÷ Stop-Abstand
 *
 * Ein Titel mit 1 % Stop-Abstand bekommt also die fünffache Tranche eines
 * Titels mit 5 % — und beide verlieren im Stop-Fall denselben Betrag. Das
 * ist der Unterschied zwischen behaupteter und tatsächlicher Streuung.
 *
 * ── Warum der Deckel bleibt ───────────────────────────────────────────────
 *
 * Bei sehr engem Stop wächst die Tranche rechnerisch ins Absurde: 0,1 %
 * Stop-Abstand und 1 % Risiko ergäben das Zehnfache des Eigenkapitals.
 * `maxPositionPct` bleibt deshalb als harte Obergrenze stehen. Ein enger
 * Stop ist außerdem nicht dasselbe wie wenig Risiko — er wird nur häufiger
 * ausgelöst, und zwar von Rauschen.
 */

/**
 * Voreinstellung, wenn `engine.riskPerTradePct` fehlt: AUS.
 *
 * Bewusst aus. Die Umstellung ist eine Verbesserung, aber eine UNGEPRÜFTE:
 * Sie zusammen mit Kostenschwelle, Handelbarkeit und Korrelations-Deckel
 * scharf zu schalten hieße, vier Änderungen gleichzeitig zu machen und
 * hinterher zu raten, welche gewirkt hat. Erst messen, dann zuschalten.
 */
export const DEFAULT_RISK_PER_TRADE_PCT = 0;

/** Obergrenze für `riskPerTradePct` — mehr als 5 % je Trade ist kein Risiko-
 *  management mehr, sondern eine Wette auf wenige Ausgänge. */
export const MAX_RISK_PER_TRADE_PCT = 5;

export interface RiskSizeInput {
  /** Eigenkapital (Cash + Positionen zum Marktwert). */
  equity: number;
  /** Anteil des Eigenkapitals, der im Stop-Fall verloren gehen darf, in %. */
  riskPerTradePct: number;
  /** Abstand vom Einstieg bis zum Stop, in % — ATR-basiert oder fest. */
  stopDistancePct: number;
  /** Effektiver Ausführungspreis (inkl. Gebühren). */
  effPrice: number;
  /** Harte Obergrenze je Position, in % des Eigenkapitals. */
  maxPositionPct: number;
  /** Verbleibende Kaufkraft; ohne Angabe deckelt allein maxPositionPct. */
  buyingPower?: number;
  /** Krypto handelt in Bruchteilen. */
  fractional?: boolean;
}

/**
 * Stückzahl, bei der ein ausgelöster Stop genau `riskPerTradePct` kostet.
 *
 * Liefert 0, wenn die Rechnung nicht aufgeht — insbesondere bei fehlendem
 * Stop-Abstand. Das ist die richtige Richtung: Ohne Stop ist der Verlust im
 * Ernstfall unbekannt, und eine Größe, die auf einer unbekannten Zahl
 * beruht, sollte nicht gehandelt werden. Der Aufrufer fällt dann auf die
 * klassische Prozent-Tranche zurück.
 */
export function riskBasedQty(i: RiskSizeInput): number {
  if (!(i.effPrice > 0) || !(i.equity > 0)) return 0;
  if (!(i.riskPerTradePct > 0) || !(i.stopDistancePct > 0)) return 0;
  const risikoBetrag = (i.equity * i.riskPerTradePct) / 100;
  // Der Einsatz, bei dem `stopDistancePct` genau den Risikobetrag kostet.
  let notional = risikoBetrag / (i.stopDistancePct / 100);
  const deckel = (i.equity * i.maxPositionPct) / 100;
  if (deckel > 0) notional = Math.min(notional, deckel);
  if (typeof i.buyingPower === 'number' && Number.isFinite(i.buyingPower)) {
    notional = Math.min(notional, Math.max(0, i.buyingPower));
  }
  if (!(notional > 0)) return 0;
  const roh = notional / i.effPrice;
  return i.fractional ? Math.floor(roh * 1e6) / 1e6 : Math.floor(roh);
}

/**
 * Effektiver Stop-Abstand in Prozent: ATR-Vielfaches, sonst fester Wert.
 *
 * Dieselbe Vorrangregel wie in `riskExitReason` — der ATR-Stop schlägt den
 * Prozentwert. Wäre das hier anders herum, würde die Position mit einem
 * anderen Abstand DIMENSIONIERT als sie später GESTOPPT wird, und der
 * gerechnete Risikobetrag stimmte nie.
 *
 * `atrPct` ist der TAGES-ATR — auch für Konten mit Intraday-Signal-
 * Zeitrahmen, und das ist ABSICHT (geprüft in Task 115, nach dem
 * Einheiten-Fix der Kostenschwelle HOCH-4): Der Stop schützt die POSITION
 * über ihre Lebensdauer, nicht das Signal über seine Kerze. Positionen
 * leben hier mindestens einen Tag (Exit-Umbau: minHoldMin 1440, und das
 * Sicherheitsnetz muss die Overnight-Lücke überstehen, die aus der
 * TAGES-Volatilität kommt). Würde man den Abstand wie bei der
 * Kostenschwelle auf den Halte-Horizont herunterskalieren (ein 60-min-Halt
 * einer Aktie: 2 × 1,5 % × √(60/390) ≈ 1,2 %), läge der Stop INNERHALB
 * des normalen Tagesausschlags von 1,5 % — jeder gewöhnliche Tag wäre ein
 * Zwangsverkauf im Rauschen, genau der Fehler, den die Klassen-Profile
 * (MA6) beheben. Die √-Skalierung gehört zur ERWARTETEN BEWEGUNG
 * (costGate), nicht zum Schutzabstand.
 */
export function stopDistancePct(
  risk: { stopLossPct: number; atrStopMult?: number | undefined },
  atrPct: number | null | undefined,
): number {
  const atrOk = typeof atrPct === 'number' && Number.isFinite(atrPct) && atrPct > 0;
  const mult = risk.atrStopMult;
  if (atrOk && typeof mult === 'number' && Number.isFinite(mult) && mult > 0) {
    return mult * (atrPct as number);
  }
  return Number.isFinite(risk.stopLossPct) && risk.stopLossPct > 0 ? risk.stopLossPct : 0;
}
