/**
 * Die Vergleichslinie: Was wäre aus demselben Geld geworden, wenn es einfach
 * im Markt gelegen hätte?
 *
 * ── Warum das die wichtigste fehlende Zahl war (Owner 18.08.) ─────────────
 *
 * Auf die Frage nach „Buffett-Tricks" ist die ehrlichste Antwort aus der
 * Literatur die unbequemste: Buffetts bekanntester Rat an Privatanleger ist
 * ein Indexfonds. Solange die Depot-Kurve nicht gegen genau diese Linie
 * gezeichnet ist, beantwortet das Tool die eine Frage nicht, auf die es
 * gebaut wurde — schafft es Wert, oder erzeugt es nur Bewegung?
 *
 * Der Anlass war konkret: „gestern waren wir noch knapp 4000 im plus", und
 * am nächsten Tag stand die realisierte Bilanz bei 1 140 $. Ohne
 * Vergleichslinie lässt sich nicht sagen, ob das ein schlechter Markt war
 * oder eine schlechte Woche des Systems. Mit ihr steht es in einer Zahl.
 *
 * ── Warum der Kurs gespeichert wird und nicht die fertige Kurve ───────────
 *
 * Der Index-Schlusskurs ist ein FAKT des Tages; die Vergleichskurve ist eine
 * ABLEITUNG daraus, und zwar eine, die von der Basis abhängt. Speichert man
 * die Ableitung, muss man sie bei jedem Basiswechsel nachrechnen — und der
 * teuerste Fehler dieser Bauart wäre eine Linie, die über einen
 * Depot-Schnitt (`wallet.resetAt`, Übernahme) hinwegläuft und damit zwei
 * verschiedene Zeiträume vergleicht.
 *
 * Weil der Schnitt die Equity-Dokumente VOR heute löscht (siehe
 * `uebernahmeSchnitt.ts`), wandert die Basis hier von selbst mit: Die
 * Vergleichslinie beginnt immer am ersten Punkt, der noch da ist. Das ist
 * kein Zufall, sondern der Grund für diese Aufteilung.
 */

/** Ein Tagespunkt der Equity-Serie, wie er in Firestore steht. */
export interface BenchPunkt {
  date: string;
  equity: number;
  /**
   * Schlusskurs des Vergleichsindex an diesem Tag.
   *
   * Fehlend heißt „an diesem Tag nicht erhoben" — Altbestand aus der Zeit
   * vor dieser Messung oder ein Tag, an dem der Indexabruf scheiterte.
   */
  benchClose?: number | null;
}

export interface BenchKurvenPunkt {
  date: string;
  equity: number;
  /** Was dasselbe Startkapital im Index wert wäre; null = nicht vergleichbar. */
  bench: number | null;
}

export interface BenchAuswertung {
  kurve: BenchKurvenPunkt[];
  /**
   * Vorsprung in PROZENTPUNKTEN: Depot-Rendite minus Index-Rendite über
   * denselben Zeitraum. Positiv = das Tool war besser als Halten.
   * `null`, solange kein vergleichbarer Zeitraum vorliegt.
   */
  vorsprungPct: number | null;
  /** Rendite des Depots über den vergleichbaren Zeitraum, in Prozent. */
  depotPct: number | null;
  /** Rendite des Index über denselben Zeitraum, in Prozent. */
  indexPct: number | null;
  /** Wie viele Tage der Serie überhaupt einen Indexkurs tragen. */
  abdeckung: number;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Trägt dieser Punkt einen brauchbaren Indexkurs? */
function kurs(p: BenchPunkt): number | null {
  return typeof p.benchClose === 'number' && Number.isFinite(p.benchClose) && p.benchClose > 0
    ? p.benchClose
    : null;
}

/**
 * Vergleichskurve und Vorsprung aus einer Equity-Serie.
 *
 * Die Basis ist der ERSTE Punkt der Serie, der beides trägt — Equity und
 * Indexkurs. Ab dort läuft die Vergleichslinie mit derselben prozentualen
 * Bewegung wie der Index, gestartet mit demselben Kapital.
 *
 * Lücken werden NICHT überbrückt. Eine gerade Linie durch einen fehlenden
 * Tag sähe aus wie eine Messung und wäre eine Erfindung; an solchen Tagen
 * steht `bench: null`, und die Anzeige darf die Linie dort unterbrechen.
 */
export function benchmarkKurve(punkte: readonly BenchPunkt[]): BenchAuswertung {
  const leer: BenchAuswertung = {
    kurve: punkte.map((p) => ({ date: p.date, equity: p.equity, bench: null })),
    vorsprungPct: null,
    depotPct: null,
    indexPct: null,
    abdeckung: 0,
  };
  const basisIdx = punkte.findIndex((p) => kurs(p) !== null && p.equity > 0);
  if (basisIdx < 0) return leer;

  const basis = punkte[basisIdx]!;
  const basisKurs = kurs(basis)!;
  const basisEquity = basis.equity;

  const kurve: BenchKurvenPunkt[] = punkte.map((p, i) => {
    const k = kurs(p);
    return {
      date: p.date,
      equity: p.equity,
      // Vor der Basis gibt es keine Vergleichslinie — dort fehlte der Kurs.
      bench: i < basisIdx || k === null ? null : r2(basisEquity * (k / basisKurs)),
    };
  });

  const abdeckung = punkte.filter((p) => kurs(p) !== null).length;
  // Ein einzelner Punkt ist kein Zeitraum: Vorsprung braucht zwei Enden.
  const letzterIdx = kurve.map((p) => p.bench !== null).lastIndexOf(true);
  if (letzterIdx <= basisIdx) {
    return { ...leer, kurve, abdeckung };
  }

  const letzte = kurve[letzterIdx]!;
  const depotPct = r2((letzte.equity / basisEquity - 1) * 100);
  const indexPct = r2((letzte.bench! / basisEquity - 1) * 100);
  return {
    kurve,
    depotPct,
    indexPct,
    vorsprungPct: r2(depotPct - indexPct),
    abdeckung,
  };
}

/**
 * Ein Satz für die Oberfläche.
 *
 * Bewusst ohne Beschönigung: Wenn das Tool hinter dem Index liegt, steht das
 * genau so da. Eine Vergleichslinie, die nur die guten Phasen benennt, wäre
 * dasselbe wie keine.
 */
export function benchmarkSatz(a: BenchAuswertung, indexName = 'S&P 500'): string {
  if (a.vorsprungPct === null || a.depotPct === null || a.indexPct === null) {
    return `Noch kein Vergleich möglich — der ${indexName} wird erst seit ${a.abdeckung} Tag(en) mitgeschrieben.`;
  }
  const pz = (x: number): string => `${x > 0 ? '+' : ''}${x.toFixed(2).replace('.', ',')} %`;
  if (Math.abs(a.vorsprungPct) < 0.05) {
    return `Gleichstand mit dem ${indexName} (Depot ${pz(a.depotPct)}, Index ${pz(a.indexPct)}).`;
  }
  return a.vorsprungPct > 0
    ? `${pz(a.vorsprungPct)} Punkte VOR dem ${indexName} (Depot ${pz(a.depotPct)}, Index ${pz(a.indexPct)}).`
    : `${pz(a.vorsprungPct)} Punkte HINTER dem ${indexName} (Depot ${pz(a.depotPct)}, Index ${pz(a.indexPct)}). Einfaches Halten wäre besser gewesen.`;
}
