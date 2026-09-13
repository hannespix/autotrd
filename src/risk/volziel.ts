/**
 * Volatilitätsziel für das PORTFOLIO — ein Skalierungsfaktor auf die
 * Positionsgröße, nicht auf die Latte.
 *
 * ── Der Befund, der das auslöst (Owner, 12.09.2026) ──────────────────────
 *
 * Lauf #9 über neun OOS-Fenster: `mean_reversion` 0,75 Sharpe bei 1,84 %
 * MaxDD und 3,57 % Rendite in vier Jahren; SPY kaufen-und-halten 1,17 bei
 * 19,85 %. Die Strategie riskiert ein ZEHNTEL des Marktes und verdient
 * entsprechend nichts. Das ist kein Kanten-, sondern ein Deployment-Problem:
 * `risk.riskPerTradePct 0,5` und höchstens vier Positionen lassen kaum
 * Kapital arbeiten. Die richtige Antwort darauf ist nicht „mehr Risiko je
 * Trade" (das verschiebt nur die Wette auf den einzelnen Trade), sondern ein
 * ZIEL für die Schwankung des Gesamtdepots: Ist die realisierte Vola der
 * eigenen Equity-Kurve unter dem Ziel, dürfen die Positionen größer werden;
 * liegt sie darüber, werden sie kleiner.
 *
 * Was das NICHT tut: den Sharpe verbessern. Eine Skalierung aller Positionen
 * mit demselben Faktor lässt das Verhältnis von Rendite zu Schwankung
 * unberührt (bis auf Kosten, Stückelung und Deckel) — die Gates werden also
 * nicht geschmeichelt, und `beats_market` wird davon nicht leichter. Was es
 * tut: aus einer Kante mit 1,84 % Drawdown einen nutzbaren Ertrag bei einem
 * Drawdown machen, den man VORHER bestimmt hat, statt bei einem, der sich
 * aus der Stop-Distanz zufällig ergibt.
 *
 * ── Schätzer: exponentiell gewichtete Standardabweichung ─────────────────
 *
 * Gewichte λ^k auf die k-letzte Tagesrendite, λ = 0,5^(1/Halbwertszeit),
 * normiert durch die Gewichtssumme; annualisiert mit √252 (Krypto: √365, der
 * Aufrufer gibt `tageJeJahr`). Der Mittelwert wird als 0 angenommen
 * (RiskMetrics-Konvention): Eine Drift lässt sich aus Tagesrenditen nicht
 * verlässlich schätzen, und die unzentrierte Schätzung ist nie kleiner als
 * die zentrierte — sie überschätzt die Schwankung also eher, was hier die
 * vorsichtige Richtung ist (kleinerer Faktor).
 *
 * Warum EWMA und nicht ein einfaches Fenster: Ein gleitendes Fenster von 60
 * Tagen hält einen Sprung 60 Tage lang in der Schätzung und lässt ihn dann
 * schlagartig fallen („Plateau-Effekt") — die Positionsgröße springt an
 * einem Tag ohne jedes Marktereignis. EWMA vergisst gleichmäßig.
 *
 * GRENZE, nicht wegdefiniert: EWMA reagiert schnell nach oben und
 * ÜBERSCHÄTZT nach einem Sprung für einige Tage — direkt nach einem
 * Crash-Tag fährt das Ziel die Positionen stärker herunter, als die
 * Schwankung der Folgewochen rechtfertigt (prozyklisch: verkauft in die
 * Panik, kauft in die Ruhe). Zweite Grenze: Die Schätzung kommt aus der
 * EIGENEN Equity-Kurve. Wer selten investiert ist, hat eine flache Kurve und
 * bekommt deshalb einen großen Faktor — genau dann, wenn die nächste
 * Position wieder voll im Markt steht. Dagegen stehen `maxFaktor` und die
 * harten Deckel (`maxPositionPct`, `maxGrossExposurePct`, `maxPositions`,
 * Bargeld), die der Faktor NIE aushebelt: Er wirkt allein auf das Budget,
 * nicht auf die Obergrenzen (risk/sizing.ts).
 *
 * Kausal: Die Funktion sieht nur die übergebenen Renditen (jüngste zuletzt).
 * Sie normiert über die Gewichte dieser Reihe, nie über eine Gesamtlänge und
 * nie über einen Gesamtmittelwert — der Faktor eines Tages ändert sich
 * deshalb nicht rückwirkend, wenn später Tage hinzukommen
 * (Präfix-Konsistenz, test/risk/volziel.test.ts).
 */

/** Handelstage je Jahr für die Annualisierung (Aktien). */
export const TAGE_JE_JAHR = 252;

export interface VolZielInput {
  /**
   * Tagesrenditen der EIGENEN Equity-Kurve (nicht des Marktes), jüngste
   * ZULETZT. Anteile, nicht Prozent (0,01 = +1 %). Nicht-finite Werte werden
   * übersprungen und zählen nicht als Beobachtung.
   */
  renditen: readonly number[];
  /** Zielschwankung des Depots in % p. a. (> 0). */
  zielVolPct: number;
  /** Halbwertszeit der Gewichte in Handelstagen (> 0). */
  halbwertszeitTage: number;
  /** Untere Grenze des Faktors (≥ 0). */
  minFaktor: number;
  /** Obere Grenze des Faktors (≥ minFaktor). */
  maxFaktor: number;
  /** Unter so vielen brauchbaren Beobachtungen gilt Faktor 1,0 („Aufwärmphase"). */
  minBeobachtungen: number;
  /** Annualisierung; Default 252 (Krypto: 365). */
  tageJeJahr?: number | undefined;
}

export interface VolZielResult {
  /** Faktor auf das Sizing-Budget, in [minFaktor, maxFaktor]. */
  faktor: number;
  /** Geschätzte annualisierte Schwankung der Equity-Kurve in % (0, solange Aufwärmphase). */
  realisiertVolPct: number;
  /** Brauchbare (finite) Beobachtungen, die in die Schätzung eingingen. */
  beobachtungen: number;
  /** Warum dieser Faktor — steht im Journal und im Bericht. */
  grund: string;
}

/** Faktor 1,0 mit Grund — der neutrale Ausgang (Aufwärmphase, ungültige Vorgabe). */
function neutral(grund: string, beobachtungen = 0): VolZielResult {
  return { faktor: 1, realisiertVolPct: 0, beobachtungen, grund };
}

/**
 * Skalierungsfaktor aus Zielvolatilität und realisierter Volatilität.
 *
 * Reihenfolge (jede Stufe ist ein möglicher Ausgang mit Grund):
 *   1. Vorgabe unbrauchbar (Ziel ≤ 0, Halbwertszeit ≤ 0, Deckel verdreht) ⇒ 1,0.
 *   2. Weniger als `minBeobachtungen` finite Renditen ⇒ 1,0 (Aufwärmphase) —
 *      geraten wird hier nicht.
 *   3. Realisierte Vola 0 (flache Kurve, nie investiert) ⇒ `maxFaktor`,
 *      nicht unendlich.
 *   4. Sonst Ziel / realisiert, auf [minFaktor, maxFaktor] geklemmt.
 */
export function volSkalierung(inp: VolZielInput): VolZielResult {
  const { zielVolPct, halbwertszeitTage, minFaktor, maxFaktor, minBeobachtungen } = inp;
  const jahr = inp.tageJeJahr ?? TAGE_JE_JAHR;
  if (!(zielVolPct > 0) || !Number.isFinite(zielVolPct)) return neutral(`Zielvola ${zielVolPct} unbrauchbar — Faktor 1,0`);
  if (!(halbwertszeitTage > 0) || !Number.isFinite(halbwertszeitTage)) return neutral(`Halbwertszeit ${halbwertszeitTage} unbrauchbar — Faktor 1,0`);
  if (!(minFaktor >= 0) || !(maxFaktor >= minFaktor) || !Number.isFinite(maxFaktor)) {
    return neutral(`Faktor-Deckel [${minFaktor}, ${maxFaktor}] unbrauchbar — Faktor 1,0`);
  }
  if (!(jahr > 0) || !Number.isFinite(jahr)) return neutral(`Annualisierung ${jahr} unbrauchbar — Faktor 1,0`);

  // Gewichte λ^k, k = 0 für die JÜNGSTE Rendite. Läuft von hinten nach vorn,
  // damit die Reihe nur ihre eigene Vergangenheit sieht.
  const lambda = Math.pow(0.5, 1 / halbwertszeitTage);
  let gewicht = 1;
  let summeGewicht = 0;
  let summeQuadrat = 0;
  let n = 0;
  for (let i = inp.renditen.length - 1; i >= 0; i--) {
    const r = inp.renditen[i];
    if (r === undefined || !Number.isFinite(r)) continue;
    summeGewicht += gewicht;
    summeQuadrat += gewicht * r * r;
    gewicht *= lambda;
    n++;
    // Weiter zurück als 1e-12 Gewicht trägt nichts mehr bei (Laufzeit-Deckel,
    // kein Einfluss auf das Ergebnis jenseits der Rechengenauigkeit).
    if (gewicht < 1e-12) break;
  }
  if (n < Math.max(1, minBeobachtungen)) {
    return neutral(`Aufwärmphase: ${n} von ${minBeobachtungen} Beobachtungen — Faktor 1,0`, n);
  }
  const varianz = summeGewicht > 0 ? summeQuadrat / summeGewicht : 0;
  const realisiertVolPct = Math.sqrt(Math.max(0, varianz) * jahr) * 100;
  if (!(realisiertVolPct > 0)) {
    return {
      faktor: maxFaktor,
      realisiertVolPct: 0,
      beobachtungen: n,
      grund: `realisierte Vola 0 % (flache Equity-Kurve) — Faktor auf maxFaktor ${maxFaktor} begrenzt`,
    };
  }
  const roh = zielVolPct / realisiertVolPct;
  const faktor = Math.min(maxFaktor, Math.max(minFaktor, roh));
  const geklemmt = faktor !== roh ? ` (roh ${roh.toFixed(2)}, auf [${minFaktor}, ${maxFaktor}] geklemmt)` : '';
  return {
    faktor,
    realisiertVolPct,
    beobachtungen: n,
    grund: `Vola-Ziel ${zielVolPct} % / realisiert ${realisiertVolPct.toFixed(2)} % p. a. ⇒ Faktor ${faktor.toFixed(2)}${geklemmt}`,
  };
}

/**
 * Tagesrenditen aus einer Reihe von Tages-SCHLUSS-Equity-Marken (älteste
 * zuerst) — dieselbe Definition, mit der der Simulator seine `dailyReturns`
 * bildet (`dayCloseEquity / lastDayEquity − 1`, backtest/simulator.ts). Die
 * Engine führt dieselben Marken im State (`equityHistory`), damit Messung und
 * Handel denselben Faktor rechnen und nicht zwei Definitionen entstehen.
 *
 * Marken ≤ 0 (totes Konto) beenden die Reihe nicht, liefern aber keine
 * Rendite — eine Division durch 0 wäre keine Beobachtung, sondern Rauschen.
 */
export function tagesRenditen(marken: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < marken.length; i++) {
    const a = marken[i - 1];
    const b = marken[i];
    if (a === undefined || b === undefined || !(a > 0) || !Number.isFinite(b)) continue;
    out.push(b / a - 1);
  }
  return out;
}
