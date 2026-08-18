/**
 * Marktbreite — wie viele Titel tragen den Markt wirklich?
 *
 * ── Warum das eine andere Frage ist als die Ampel (Owner 18.08.) ──────────
 *
 * Die Regime-Ampel liest EINEN Index (^GSPC gegen seinen SMA200) plus VIX.
 * Damit sieht sie den Durchschnitt und nie die Verteilung. Ein Index kann
 * steigen, während drei Viertel seiner Titel fallen — das ist die klassische
 * Spätzyklus-Lage, und sie ist von einem gesunden Anstieg im Index selbst
 * nicht zu unterscheiden.
 *
 * ── Warum diese Kennzahl nichts kostet ────────────────────────────────────
 *
 * Der Momentum-Lauf bewertet ohnehin täglich den GANZEN Katalog mit einem
 * 12-1-Score. Der Anteil der Symbole mit positivem Score ist damit ein
 * `filter().length` auf Daten, die schon da sind — kein zusätzlicher Abruf,
 * kein zusätzlicher Lesevorgang.
 *
 * (Die naheliegendere Variante „Anteil über SMA200" wäre NICHT gratis: Die
 * Tageskerzen des Katalogs zieht die Versorgung nur rotierend nach, und 200
 * Kerzen je Symbol wären ~33 000 Firestore-Reads je Scan.)
 *
 * ── Was sie hier ausdrücklich NICHT tut ───────────────────────────────────
 *
 * Sie verändert den Ampel-ZUSTAND nicht. An `regime.state` hängen inzwischen
 * fünf Mechanismen — Einstiegssperre, Cooldown, Positionsgröße, der
 * Journal-Kontext und seit dem 17.08. die Trendstimme (`trendSolo`). Ein
 * neuer Eingang in den Zustand würde alle fünf auf einmal verstellen, und
 * die wahrscheinlichste Folge wäre, dass „Trend" seltener wird und die
 * Trendstimme wieder verstummt — also genau der Stillstand, den sie beheben
 * sollte.
 *
 * Deshalb erst messen. Wenn die Breite belegt hat, dass sie etwas weiß, das
 * die Ampel nicht schon weiß, gehört sie auf den GRÖSSEN-Regler und nicht
 * auf den Zustands-Schalter — dosieren statt umschalten.
 */

export interface BreiteMessung {
  /** Symbole mit auswertbarem Momentum-Score. */
  n: number;
  /** Davon mit positivem Score. */
  positiv: number;
  /** Anteil 0…1; null, wenn zu wenige Symbole für eine Aussage. */
  anteil: number | null;
  /**
   * Median des Scores — die zweite Hälfte der Verteilung.
   *
   * Der Anteil sagt, WIE VIELE oben sind; der Median sagt, wie deutlich.
   * 51 % knapp positiv ist etwas anderes als 51 % klar positiv, und im Bild
   * eines Index sind beide identisch.
   */
  medianScore: number | null;
}

/**
 * Wie viele Symbole eine Breite-Aussage mindestens tragen muss.
 *
 * Der Katalog hat ~166 Einträge, aber nicht jeder hat genug Historie für
 * einen 12-1-Score. Unter 30 auswertbaren Symbolen ist der Anteil eher ein
 * Bericht über die Datenlage als über den Markt.
 */
export const BREITE_MIN_N = 30;

/** Marktbreite aus den Momentum-Scores des Katalogs. */
export function messeBreite(scores: readonly number[]): BreiteMessung {
  const gueltig = scores.filter((s) => Number.isFinite(s));
  const n = gueltig.length;
  if (n < BREITE_MIN_N) {
    return { n, positiv: gueltig.filter((s) => s > 0).length, anteil: null, medianScore: null };
  }
  const positiv = gueltig.filter((s) => s > 0).length;
  const sortiert = [...gueltig].sort((a, b) => a - b);
  const mitte = Math.floor(n / 2);
  const median =
    n % 2 === 0 ? (sortiert[mitte - 1]! + sortiert[mitte]!) / 2 : sortiert[mitte]!;
  return {
    n,
    positiv,
    anteil: Math.round((positiv / n) * 1000) / 1000,
    medianScore: Math.round(median * 100) / 100,
  };
}

/**
 * Ein Satz für den Bericht — und die Stelle, an der der Spätzyklus-Fall
 * benannt wird.
 *
 * `indexOben` kommt aus derselben Ampel, die auch die Einstiege steuert. Die
 * interessante Kombination ist nicht „beides hoch" oder „beides tief",
 * sondern das AUSEINANDERLAUFEN: Index über dem Durchschnitt, Breite
 * darunter. Das ist die Lage, die ein einzelner Index nicht zeigen kann —
 * und der einzige Grund, diese Messung überhaupt zu führen.
 */
export function breiteSatz(b: BreiteMessung, indexOben: boolean | null): string {
  if (b.anteil === null) {
    return `Marktbreite: erst ${b.n} auswertbare Symbole, belastbar ab ${BREITE_MIN_N}.`;
  }
  const pz = `${(b.anteil * 100).toFixed(0)} %`;
  const basis = `Marktbreite: ${pz} der ${b.n} Katalog-Symbole mit positivem 12-1-Momentum (Median ${b.medianScore}).`;
  if (indexOben === true && b.anteil < 0.4) {
    return `${basis} Der Index steht oben, die Mehrheit der Titel nicht — die Bewegung wird von wenigen getragen.`;
  }
  if (indexOben === false && b.anteil > 0.6) {
    return `${basis} Der Index steht unten, die Mehrheit der Titel aber oben — die Schwäche steckt in wenigen Schwergewichten.`;
  }
  return basis;
}
