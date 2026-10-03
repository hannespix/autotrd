/**
 * Schatten-Doppelbuchung der Positionsgröße (Kapital-Panel 21.08., Hebel 2).
 *
 * ── Die Frage ─────────────────────────────────────────────────────────────
 *
 * Owner: „das Bargeld arbeitet zu wenig." Ein Teil der Antwort ist keine
 * Filter-Frage, sondern Arithmetik: Die Tranche rechnet auf dem verfügbaren
 * CASH (`sizingBase: 'balance'`), nicht auf dem Depotwert. Ist der
 * Momentum-Sockel zu 60 % investiert, ist eine „10-%-Position" real 4 % der
 * Equity — und mit jeder weiteren Position schrumpft die nächste.
 *
 * ── Warum nicht einfach umstellen ─────────────────────────────────────────
 *
 * Weil `'balance'` selbst ein Fix war: Mit fixen Tranchen scheiterte jeder
 * Kauf still an `zu_wenig_cash`, sobald der Rest-Cash die Tranche nicht mehr
 * deckte (MA-Audit 26.07., Kommentar in `broker.ts`). Eine Equity-Tranche
 * grösser als der Rest-Cash reproduziert exakt diesen Bug. Deshalb misst
 * diese Datei erst — und zwar BEIDES: um wie viel größer die Position wäre,
 * UND wie oft sie am Cash gescheitert wäre.
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Keine Order ändert sich. Diese Rechnung läuft NEBEN dem gebuchten Trade
 * und schreibt nur Zahlen. Erst wenn die vorregistrierten Schwellen über
 * mindestens 14 Tage und 20 Einstiege halten (Mehr-Investitionsgrad > 10
 * Prozentpunkte, Kollisionsquote < 10 %, Netto nicht schlechter), ist eine
 * Umstellung überhaupt verhandelbar — mit Cash-Klemme, Investitions-Deckel
 * und Sockel-Reservierung, und nur mit Owner-Freigabe.
 */

export interface SizingSchattenEingabe {
  /** Tatsächlich gebuchte Stückzahl (balance-basiert). */
  istQty: number;
  /** Ausführungspreis inklusive Slippage — derselbe für beide Seiten. */
  effPreis: number;
  /** Verfügbarer Cash NACH Kapital-Deckel — die heutige Bemessungsgrundlage. */
  deckung: number;
  /** Depotwert (Cash + Positionswert) zum Zeitpunkt der Entscheidung. */
  equity: number;
  /** Tranche in Prozent (engine.maxPositionPct). */
  maxPositionPct: number;
  /** Überzeugungs-/Klassen-/Regime-Faktor, wie er real angewandt wurde. */
  sizeFactor: number;
  /** Krypto handelt in Bruchteilen. */
  fractional: boolean;
}

export interface SizingSchatten {
  istQty: number;
  sollQty: number;
  istWert: number;
  sollWert: number;
  /** Um wie viel Prozent größer die Position auf Equity-Basis wäre.
   *  `null`, wenn die Ist-Position 0 ist (dann sagt ein Faktor nichts). */
  mehrPct: number | null;
  /** Hätte der verfügbare Cash die Soll-Position NICHT gedeckt? Genau das
   *  ist die `zu_wenig_cash`-Falle, an der die fixe Tranche gescheitert war. */
  kollision: boolean;
}

/** Dieselbe Klemme wie im Broker — der Schatten misst, was real gälte. */
function klemmeFaktor(sizeFactor: number): number {
  return Number.isFinite(sizeFactor) && sizeFactor > 0
    ? Math.min(1.5, Math.max(0.25, sizeFactor))
    : 1;
}

/** Stückelung wie im Broker: Krypto in µ-Einheiten, sonst ganze Stücke. */
function stueckle(roh: number, fractional: boolean): number {
  if (!Number.isFinite(roh) || roh <= 0) return 0;
  return fractional ? Math.floor(roh * 1e6) / 1e6 : Math.floor(roh);
}

/**
 * Was wäre gewesen? — die Equity-basierte Tranche neben der gebuchten.
 *
 * Bewusst OHNE Risiko-Sizing und ohne Margin-Pfad: Diese beiden rechnen
 * ohnehin schon auf dem Eigenkapital (`riskBasedQty`, `sizeWithMargin`) und
 * haben das Problem nicht. Gemessen wird genau der Pfad, der es hat.
 */
export function sizingSchatten(e: SizingSchattenEingabe): SizingSchatten {
  const f = klemmeFaktor(e.sizeFactor);
  const pct = Math.min(25, e.maxPositionPct * f);
  const preis = e.effPreis;
  const istQty = Math.max(0, e.istQty);
  const istWert = istQty * preis;

  const basis = Math.max(0, e.equity);
  const sollQty =
    preis > 0 && Number.isFinite(preis) ? stueckle((basis * pct) / 100 / preis, e.fractional) : 0;
  const sollWert = sollQty * preis;

  return {
    istQty,
    sollQty,
    istWert: runde(istWert),
    sollWert: runde(sollWert),
    mehrPct: istWert > 0 ? runde(((sollWert - istWert) / istWert) * 100) : null,
    // Der Vergleich läuft auf dem WERT, nicht der Stückzahl: Bei Bruchteilen
    // wäre eine Stück-Differenz nichtssagend.
    kollision: sollWert > Math.max(0, e.deckung) + 1e-9,
  };
}

function runde(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Tages-/Laufaggregat über viele Einstiege — die Grundlage der Freigabe. */
export interface SizingSchattenSumme {
  n: number;
  istWert: number;
  sollWert: number;
  kollisionen: number;
  /** Mehr-Investitionsgrad in Prozentpunkten des Ist-Volumens. */
  mehrPct: number | null;
  /** Anteil der Einstiege, die am Cash gescheitert wären. */
  kollisionsQuotePct: number | null;
}

export function fasseSizingSchatten(
  zeilen: readonly SizingSchatten[],
): SizingSchattenSumme {
  const n = zeilen.length;
  const istWert = zeilen.reduce((s, z) => s + z.istWert, 0);
  const sollWert = zeilen.reduce((s, z) => s + z.sollWert, 0);
  const kollisionen = zeilen.filter((z) => z.kollision).length;
  return {
    n,
    istWert: runde(istWert),
    sollWert: runde(sollWert),
    kollisionen,
    mehrPct: istWert > 0 ? runde(((sollWert - istWert) / istWert) * 100) : null,
    kollisionsQuotePct: n > 0 ? runde((kollisionen / n) * 100) : null,
  };
}
