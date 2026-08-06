/**
 * Overfitting-Bremse für die Struktursuche (MO Teil 2).
 *
 * ── Warum das der eigentliche Aufwand ist ──────────────────────────────────
 *
 * Ein größerer Suchraum findet ZUVERLÄSSIG Regelbäume, die auf der Historie
 * glänzen und nichts können — nicht vielleicht, sondern garantiert: Wer
 * hundert Varianten über dieselben Daten laufen lässt, bekommt allein durch
 * Zufall welche mit schönem Sharpe. Zwei Werkzeuge halten dagegen:
 *
 * 1. **Walk-Forward**: Gesucht wird auf einem Fenster, BEURTEILT auf den
 *    Daten DANACH. Ein Kandidat, der im Suchfenster gewinnt und im
 *    Testfenster verliert, hat die Vergangenheit auswendig gelernt.
 *
 * 2. **Deflated Sharpe Ratio** (Bailey & López de Prado 2014): Der beste
 *    aus N Versuchen hat einen systematisch geschönten Sharpe. DSR fragt:
 *    Wie wahrscheinlich ist der beobachtete Sharpe ECHT größer als das,
 *    was N Zufallsversuche als Maximum erwarten lassen — unter
 *    Berücksichtigung von Schiefe und schweren Rändern der Renditen?
 *
 * Alles hier ist pur und deterministisch: Zahlen rein, Urteil raus. Die
 * Anbindung (welche Kandidaten, welche Fenster, wohin das Journal) lebt in
 * den Functions; die Statistik lebt hier, wo Tests sie festnageln.
 *
 * Konvention: Sharpe-Werte in diesem Modul sind JE PERIODE (nicht
 * annualisiert) — die DSR-Formeln sind dafür definiert. `sharpeAusRenditen`
 * liefert genau das; wer den annualisierten Backtest-Sharpe (×√252) hat,
 * teilt ihn zuerst durch √252.
 */

// ── Normalverteilung (Näherungen mit dokumentierter Genauigkeit) ────────────

/** Fehlerfunktion, Abramowitz/Stegun 7.1.26 — |Fehler| < 1,5·10⁻⁷. */
export function erf(x: number): number {
  const vz = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return vz * y;
}

/** Standard-Normalverteilung Φ(x). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Quantilfunktion Φ⁻¹(p), Acklam-Näherung (relativer Fehler < 1,15·10⁻⁹).
 * Außerhalb (0,1) gibt es kein Quantil — dann NaN statt einer Erfindung.
 */
export function normalQuantil(p: number): number {
  if (!(p > 0) || !(p < 1)) return Number.NaN;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269,
    -30.6647980661472, 2.50662827745924] as const;
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197,
    -13.2806815528857] as const;
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373,
    4.37466414146497, 2.93816398269878] as const;
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742] as const;
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ── Momente einer Renditeserie ──────────────────────────────────────────────

export interface Momente {
  n: number;
  mittel: number;
  /** Stichproben-Standardabweichung (n−1). */
  sd: number;
  /** Schiefe γ₃ (0 = symmetrisch). */
  schiefe: number;
  /** ROHE Kurtosis γ₄ (Normalverteilung = 3, nicht 0). */
  kurtosis: number;
}

/** Momente — oder null, wenn die Serie zu kurz oder entartet ist. */
export function momente(renditen: readonly number[]): Momente | null {
  const r = renditen.filter((x) => Number.isFinite(x));
  const n = r.length;
  if (n < 3) return null;
  const mittel = r.reduce((s, x) => s + x, 0) / n;
  const var_ = r.reduce((s, x) => s + (x - mittel) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(var_);
  if (!(sd > 0)) return null;
  const schiefe = r.reduce((s, x) => s + ((x - mittel) / sd) ** 3, 0) / n;
  const kurtosis = r.reduce((s, x) => s + ((x - mittel) / sd) ** 4, 0) / n;
  return { n, mittel, sd, schiefe, kurtosis };
}

/** Sharpe je Periode (Mittel/Std der Renditen) — null, wenn nicht rechenbar. */
export function sharpeAusRenditen(renditen: readonly number[]): number | null {
  const m = momente(renditen);
  if (!m) return null;
  return m.mittel / m.sd;
}

// ── Probabilistic & Deflated Sharpe (Bailey/López de Prado) ────────────────

/**
 * PSR: Wahrscheinlichkeit, dass der WAHRE Sharpe über `sr0` liegt, gegeben
 * den beobachteten `sr` aus `n` Renditen mit Schiefe/Kurtosis. Schwere
 * Ränder und Linksschiefe VERGRÖSSERN die Unsicherheit — genau deshalb
 * stehen γ₃/γ₄ im Nenner statt einer Normal-Annahme.
 */
export function probabilisticSharpe(
  sr: number,
  sr0: number,
  n: number,
  schiefe: number,
  kurtosis: number,
): number {
  if (!(n > 1)) return Number.NaN;
  const nenner = Math.sqrt(Math.max(1e-12, 1 - schiefe * sr + ((kurtosis - 1) / 4) * sr * sr));
  return normalCdf(((sr - sr0) * Math.sqrt(n - 1)) / nenner);
}

/** Euler–Mascheroni — Bestandteil der Max-Statistik. */
export const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Erwartetes MAXIMUM des Sharpe über `nVersuche` unkorrelierte
 * Zufalls-Kandidaten mit SR-Schätzvarianz `srVarianz` und wahrem SR 0.
 * Das ist die Latte, die ein Suchergebnis reißen muss: alles darunter
 * hätte auch reines Würfeln geliefert.
 */
export function erwartetesMaxSharpe(nVersuche: number, srVarianz: number): number {
  if (!(nVersuche >= 1) || !(srVarianz >= 0)) return Number.NaN;
  if (nVersuche === 1 || srVarianz === 0) return 0;
  const sd = Math.sqrt(srVarianz);
  const g = EULER_MASCHERONI;
  return sd * ((1 - g) * normalQuantil(1 - 1 / nVersuche) + g * normalQuantil(1 - 1 / (nVersuche * Math.E)));
}

export interface DeflatedSharpeErgebnis {
  /** Beobachteter Sharpe je Periode. */
  sr: number;
  /** Die Zufalls-Latte E[max SR] unter nVersuche. */
  sr0: number;
  /** Wahrscheinlichkeit, dass der Sharpe ECHT über der Latte liegt. */
  dsr: number;
  n: number;
}

/**
 * Deflated Sharpe direkt aus der Renditeserie des Kandidaten.
 *
 * `srVarianz`: Varianz der SR-Schätzungen über die Versuche. Liegt sie
 * nicht vor (die Suche hat nur den Sieger behalten), wird der
 * Schätzfehler des beobachteten SR benutzt — die dokumentierte, eher
 * KONSERVATIVE Näherung: schwere Ränder vergrößern ihn, und damit die
 * Latte.
 */
export function deflatedSharpe(
  renditen: readonly number[],
  nVersuche: number,
  opts: { srVarianz?: number } = {},
): DeflatedSharpeErgebnis | null {
  const m = momente(renditen);
  if (!m || !(nVersuche >= 1)) return null;
  const sr = m.mittel / m.sd;
  const srVarianz =
    opts.srVarianz ??
    Math.max(0, 1 - m.schiefe * sr + ((m.kurtosis - 1) / 4) * sr * sr) / (m.n - 1);
  const sr0 = erwartetesMaxSharpe(nVersuche, srVarianz);
  const dsr = probabilisticSharpe(sr, sr0, m.n, m.schiefe, m.kurtosis);
  return { sr, sr0, dsr, n: m.n };
}

// ── Walk-Forward-Fensterung ─────────────────────────────────────────────────

/**
 * Warmup-Überhang des Testfensters — MUSS dem Backtest-WARMUP entsprechen
 * (MACD-Slow 26): Die ersten `warmup` Bars des Testfensters stammen aus dem
 * Suchfenster und erzeugen im Backtest KEINE Trades; sie füttern nur die
 * Indikatoren, damit der Handel exakt am Testbeginn losgehen kann.
 * Vergangenheit zu sehen ist kein Lookahead — Zukunft wäre es.
 */
export const WALK_FORWARD_WARMUP = 26;

export interface WalkForwardSplit<T> {
  /** Suchfenster: hier darf gesucht, mutiert, optimiert werden. */
  such: T[];
  /** Testfenster inkl. Warmup-Vorlauf: hier wird NUR beurteilt. */
  test: T[];
  /** Index des ersten ECHTEN Test-Bars innerhalb von `test`. */
  testBeginn: number;
}

/**
 * Serie in Such- und Testfenster teilen. Das Testfenster liegt strikt NACH
 * dem Suchfenster; `null`, wenn die Serie für beide Mindestlängen nicht
 * reicht — ein zu kurzes Testfenster beurteilt nichts, es würfelt.
 */
export function teileWalkForward<T>(
  bars: readonly T[],
  opts: { testAnteil?: number; minSuch?: number; minTest?: number; warmup?: number } = {},
): WalkForwardSplit<T> | null {
  const testAnteil = opts.testAnteil ?? 0.3;
  const minSuch = opts.minSuch ?? 120;
  const minTest = opts.minTest ?? 60;
  const warmup = opts.warmup ?? WALK_FORWARD_WARMUP;
  const n = bars.length;
  const testLen = Math.max(minTest, Math.floor(n * testAnteil));
  const suchLen = n - testLen;
  if (suchLen < Math.max(minSuch, warmup) || testLen < minTest) return null;
  return {
    such: bars.slice(0, suchLen),
    test: bars.slice(suchLen - warmup),
    testBeginn: warmup,
  };
}

// ── Das Beförderungs-Urteil ─────────────────────────────────────────────────

/** DSR-Mindestwahrscheinlichkeit — unter 95 % ist ein Suchsieg nicht belegt. */
export const DSR_SCHWELLE = 0.95;
/** Weniger Test-Renditen tragen kein Urteil. */
export const MIN_TEST_RENDITEN = 40;

export interface BefoerderungsUrteil {
  befoerdern: boolean;
  /** Klartext für das Journal — jede Ablehnung nennt ihren Grund. */
  gruende: string[];
  /** Kennzahlen für das Journal. */
  suche: DeflatedSharpeErgebnis | null;
  testSharpe: number | null;
}

/**
 * Darf ein Suchsieger befördert werden?
 *
 * Beide Hürden müssen stehen: (1) Der Such-Sharpe überlebt die Deflation um
 * die Anzahl der Versuche (DSR ≥ 95 %) — sonst ist er das erwartbare
 * Maximum aus Würfeln. (2) Der Kandidat verdient auch im Testfenster (Sharpe
 * > 0) — der Abnahme-Fall des Milestones: Wer in der Suche gewinnt und im
 * Walk-Forward verliert, wird NICHT befördert.
 */
export function beurteileBefoerderung(input: {
  suchRenditen: readonly number[];
  testRenditen: readonly number[];
  nVersuche: number;
}): BefoerderungsUrteil {
  const gruende: string[] = [];
  const suche = deflatedSharpe(input.suchRenditen, input.nVersuche);
  if (!suche) {
    gruende.push('Suchfenster nicht bewertbar (zu wenige oder entartete Renditen)');
  } else if (!(suche.dsr >= DSR_SCHWELLE)) {
    gruende.push(
      `Deflated Sharpe ${suche.dsr.toFixed(3)} < ${DSR_SCHWELLE} — bei ` +
        `${input.nVersuche} Versuchen ist SR ${suche.sr.toFixed(3)} nicht von ` +
        `Würfeln unterscheidbar (Latte ${suche.sr0.toFixed(3)})`,
    );
  }

  const testGefiltert = input.testRenditen.filter((x) => Number.isFinite(x));
  let testSharpe: number | null = null;
  if (testGefiltert.length < MIN_TEST_RENDITEN) {
    gruende.push(
      `Testfenster zu dünn (${testGefiltert.length}/${MIN_TEST_RENDITEN} Renditen)`,
    );
  } else {
    testSharpe = sharpeAusRenditen(testGefiltert);
    if (testSharpe === null || !(testSharpe > 0)) {
      gruende.push(
        `Walk-Forward negativ (Test-Sharpe ${testSharpe === null ? 'nicht rechenbar' : testSharpe.toFixed(3)}) — ` +
          'der Kandidat hat die Vergangenheit auswendig gelernt',
      );
    }
  }

  return { befoerdern: gruende.length === 0, gruende, suche, testSharpe };
}
