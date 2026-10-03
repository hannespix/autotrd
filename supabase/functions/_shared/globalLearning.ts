/**
 * autotrd — kollektives Lernen über alle Konten (Owner-Wunsch 28.07.:
 * „das wäre absolut sinnvoll wenn das tool sich als GESAMTES stetig
 * verbessert, nicht nur per User").
 *
 * ── Was vorher schon geteilt war und was nicht ─────────────────────────────
 *
 * Global lernten bereits: die Prognose-Genauigkeit (`meta/forecastStats`,
 * ein Gitter für alle), das Momentum-Ranking und die Marktdaten. Der
 * HANDELS-Tuner dagegen lief vollständig pro Konto — jeder baute seine
 * eigene Evidenz von null auf, und bei 100 Konten rechnete das System
 * dieselbe Frage hundertmal.
 *
 * ── Warum man Ergebnisse trotzdem NICHT einfach zusammenwirft ──────────────
 *
 * Die Konten starten von verschiedenen Punkten: eigene RSI-Schwellen, eigene
 * Stops, `allowShort` an oder aus. Eine Änderung „Mindest-Haltedauer 60 →
 * 120" kann bei einem Konto helfen und beim nächsten schaden, weil dessen
 * Ausgangsstrategie eine andere ist. Die Ergebnisse zu mitteln hieße, Äpfel
 * und Birnen zu vermengen — und das erzeugt nicht bloß unscharfe Zahlen,
 * sondern FALSCHE Beförderungen, also aktiv schlechtere Strategien.
 *
 * ── Was dieses Modul deshalb tut — und was ausdrücklich nicht ──────────────
 *
 * Es erzeugt ein VORWISSEN, keinen Befehl. Zwei Hebel, beide sicher:
 *
 *  1. **Reihenfolge.** Es gibt mehr Kandidaten als Flottenplätze. Welche
 *     sechs ein Konto testet, entschied bisher eine willkürliche feste
 *     Reihenfolge. Jetzt kommen die zuerst dran, die sich anderswo bewährt
 *     haben — das Konto erreicht die gute Einstellung früher.
 *  2. **Startpunkt neuer Konten.** Ein neues Konto beginnt nicht mehr bei den
 *     Fabrik-Defaults, sondern bei dem, was das Kollektiv gelernt hat. Das
 *     ist der größte Hebel überhaupt und trotzdem harmlos: Es setzt nur den
 *     Anfang, der lokale Tuner korrigiert danach wie bisher.
 *
 * **Was der Prior NIE tut: die lokale Signifikanzschwelle senken.** Das wäre
 * die verlockende Bayes-Variante und genau die falsche: Die Bonferroni-
 * Korrektur im Tuner ist die Absicherung dagegen, dass unter vielen Tests
 * zufällige Sieger befördert werden. Sie mit fremder Evidenz aufzuweichen,
 * die aus ANDEREN Ausgangsstrategien stammt, hebelt genau den Schutz aus,
 * der Geld kostet, wenn er fehlt. Jede Beförderung braucht weiterhin die
 * volle lokale Evidenz.
 *
 * ── Datenschutz ────────────────────────────────────────────────────────────
 *
 * Geteilt werden ausschließlich AGGREGATE je Achsenwert: wie oft geprüft,
 * wie oft befördert, Summe der Vorsprünge, Zahl der beitragenden Konten.
 * Keine einzelnen Trades, keine Beträge eines Kontos, keine Kennung. Aus
 * `{judged: 42, promoted: 7}` lässt sich kein Konto rekonstruieren.
 */

/** Aggregat einer Achsen-Variante über alle Konten. Additiv und idempotent
 *  fortschreibbar — dieselbe Disziplin wie bei den Forecast-Kombis. */
export interface GlobalAxisStat {
  /** Wie oft diese Variante irgendwo geprüft wurde. */
  judged: number;
  /** Wie oft sie dabei lokal signifikant besser war. */
  promoted: number;
  /** Summe der Vorsprünge über alle Prüfungen — auch der negativen. */
  edgeSum: number;
  /** Zahl der Konten, die beigetragen haben (Vertrauensschwelle). */
  accounts: number;
}

export type GlobalAxisStats = Record<string, GlobalAxisStat>;

/** Mindestzahl beitragender Konten, bevor ein Prior überhaupt zählt.
 *
 *  Bei einem einzigen Konto ist der „globale" Wert schlicht dessen eigener —
 *  ihn als Kollektivwissen zu verkaufen, wäre eine Selbsttäuschung mit
 *  zusätzlichen Schritten. */
export const MIN_ACCOUNTS = 3;

/** Mindestzahl Prüfungen, bevor der mittlere Vorsprung etwas bedeutet. */
export const MIN_JUDGED = 10;

export interface GlobalPrior {
  variantId: string;
  /** Mittlerer Vorsprung je Prüfung (Kontowährung je Trade). */
  meanEdge: number;
  /** Anteil der Prüfungen, die zu einer Beförderung führten. */
  promoteRate: number;
  /** 0 … 1 — wie viel Gewicht dieses Vorwissen verdient. */
  confidence: number;
}

/**
 * Ein Prüf-Ergebnis in die globale Statistik einrechnen.
 *
 * `accounts` zählt NICHT jede Prüfung mit: Ein Konto, das dieselbe Variante
 * zwanzig Tage hintereinander prüft, wäre sonst zwanzig „Konten" und
 * täuschte eine Breite vor, die es nicht gibt. Deshalb muss der Aufrufer
 * `neuesKonto` genau dann setzen, wenn dieses Konto zu dieser Variante an
 * diesem Tag zum ersten Mal beiträgt.
 */
export function mergeAxisStat(
  prev: GlobalAxisStat | undefined,
  entry: { promoted: boolean; edge: number },
  neuesKonto: boolean,
): GlobalAxisStat {
  const p = prev ?? { judged: 0, promoted: 0, edgeSum: 0, accounts: 0 };
  const edge = Number.isFinite(entry.edge) ? entry.edge : 0;
  return {
    judged: p.judged + 1,
    promoted: p.promoted + (entry.promoted ? 1 : 0),
    edgeSum: Math.round((p.edgeSum + edge) * 10_000) / 10_000,
    accounts: p.accounts + (neuesKonto ? 1 : 0),
  };
}

/**
 * Aus den Aggregaten das Vorwissen ableiten, nach Aussicht sortiert.
 *
 * `confidence` wächst mit Konten UND Prüfungen und ist bei 1 gedeckelt.
 * Beides ist nötig: Viele Prüfungen aus einem einzigen Konto sind keine
 * Breite, viele Konten mit je zwei Trades sind keine Tiefe.
 */
export function buildPriors(
  stats: GlobalAxisStats,
  minAccounts = MIN_ACCOUNTS,
  minJudged = MIN_JUDGED,
): GlobalPrior[] {
  const out: GlobalPrior[] = [];
  for (const [variantId, s] of Object.entries(stats)) {
    if (!s || s.judged <= 0) continue;
    if (s.accounts < minAccounts || s.judged < minJudged) continue;
    const kontoAnteil = Math.min(1, s.accounts / (minAccounts * 2));
    const pruefAnteil = Math.min(1, s.judged / (minJudged * 3));
    out.push({
      variantId,
      meanEdge: Math.round((s.edgeSum / s.judged) * 10_000) / 10_000,
      promoteRate: Math.round((s.promoted / s.judged) * 10_000) / 10_000,
      confidence: Math.round(Math.min(kontoAnteil, pruefAnteil) * 1000) / 1000,
    });
  }
  // Beförderungsquote schlägt mittleren Vorsprung: Eine Variante, die bei
  // vielen Konten die Signifikanzprüfung bestand, ist verlässlicher als eine
  // mit einem großen Mittelwert, den ein einzelner Glückstreffer trägt.
  return out.sort(
    (a, b) =>
      b.promoteRate * b.confidence - a.promoteRate * a.confidence ||
      b.meanEdge - a.meanEdge,
  );
}

/**
 * Die Flotte nach dem Vorwissen ordnen.
 *
 * Nur eine Umsortierung — es wird KEINE Variante entfernt und keine
 * hinzugefügt. Wer nicht im Prior steht (neue Achse, zu dünne Datenlage),
 * behält seinen Platz in der ursprünglichen Reihenfolge hinter den
 * bewährten. Eine unbekannte Variante zu verwerfen hieße, dass nie wieder
 * etwas Neues geprüft würde — das Kollektiv säße dann in seinem eigenen
 * lokalen Optimum fest.
 */
export function orderByPrior<T extends { id: string }>(
  variants: T[],
  priors: GlobalPrior[],
): T[] {
  const rang = new Map(priors.map((p, i) => [p.variantId, i]));
  return [...variants].sort((a, b) => {
    const ra = rang.get(a.id);
    const rb = rang.get(b.id);
    if (ra === undefined && rb === undefined) return 0; // Ursprungsordnung
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

/**
 * Die global bewährte Startstrategie für ein NEUES Konto.
 *
 * Angewandt wird nur, was sich mehrfach und über mehrere Konten hinweg
 * bewährt hat (`promoteRate` über der Schwelle). Höchstens eine Änderung je
 * Achse — sonst stapelten sich Effekte, die einzeln geprüft wurden und
 * gemeinsam nie.
 *
 * Der Rückgabewert ist eine Liste von Varianten-IDs, keine fertige
 * Strategie: Das Anwenden gehört zu `tuneGrid.ts`, wo die Achsen definiert
 * sind — und die Risiko-Hülle läuft danach ohnehin noch einmal darüber.
 */
export function recommendedStart(
  priors: GlobalPrior[],
  minPromoteRate = 0.5,
): string[] {
  const proAchse = new Map<string, GlobalPrior>();
  for (const p of priors) {
    if (p.promoteRate < minPromoteRate) continue;
    if (p.meanEdge <= 0) continue; // ein Vorsprung ≤ 0 ist keine Empfehlung
    const achse = p.variantId.split('=')[0] ?? p.variantId;
    const bisher = proAchse.get(achse);
    if (!bisher || p.promoteRate * p.confidence > bisher.promoteRate * bisher.confidence) {
      proAchse.set(achse, p);
    }
  }
  return [...proAchse.values()].map((p) => p.variantId);
}
