/**
 * autotune.ts — die Evidenzschwelle des Auto-Tuners (MT3).
 *
 * Warum es das gibt: Am 27.07. sahen zwei Testkonten des Owners sehr
 * unterschiedlich aus — 12 % gegen 39 % Trefferquote. Der exakte Test von
 * Fisher sagt dazu p = 0,12: bei 16 Trades je Konto ist dieser Unterschied
 * REINES RAUSCHEN. Wer daraus „Konto B ist besser eingestellt" abliest, tunt
 * auf Zufall und wirft die Parameter im Wochenrhythmus um.
 *
 * Genau davor schützt dieses Modul. Es beantwortet eine einzige Frage:
 * *Ist eine Variante nachweislich besser als die amtierende — oder sieht sie
 * nur zufällig besser aus?*
 *
 * ── Zur Statistik, ehrlich ──────────────────────────────────────────────────
 * Trade-Ergebnisse sind nicht normalverteilt; sie haben schwere Ränder. Der
 * Welch-Test unterstellt Normalität und ist hier deshalb eine NÄHERUNG. Das
 * ist vertretbar, weil er als **Sperre** benutzt wird, nicht als Beweis: Wir
 * handeln nur, wenn er deutlich anschlägt, und tun im Zweifel nichts. Eine
 * ungenaue Wahrscheinlichkeit führt damit höchstens dazu, dass die amtierende
 * Einstellung bleibt — der harmlose Fehler. Umgekehrt wäre er teuer.
 *
 * Alles hier ist pur und ohne Zufallszahlen: Dieselben Eingaben liefern immer
 * dasselbe Urteil. Ein Tuner, dessen Entscheidungen nicht reproduzierbar
 * sind, ließe sich nicht nachvollziehen — und Nachvollziehbarkeit ist der
 * halbe Sinn der Übung.
 */

/* ── Numerik: unvollständige Beta-Funktion ────────────────────────────────
 * Beide Tests brauchen sie. Die Implementierung ist der Kettenbruch nach
 * Lentz — Standardverfahren, hier bewusst kompakt gehalten und gegen zwei
 * ANALYTISCH exakte Fälle geprüft (t-Verteilung mit 1 und 2 Freiheitsgraden
 * hat eine geschlossene Form; siehe Tests). */

function logGamma(x: number): number {
  // Lanczos-Näherung, g = 7, n = 9 — die übliche Koeffizientenreihe.
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = g[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += g[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const TINY = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** Regularisierte unvollständige Beta-Funktion I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front =
    Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // Der Kettenbruch konvergiert nur links vom Wendepunkt schnell; rechts
  // davon wird über die Symmetrie I_x(a,b) = 1 − I_{1−x}(b,a) gerechnet.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (Math.exp(
        logGamma(a + b) - logGamma(a) - logGamma(b) + b * Math.log(1 - x) + a * Math.log(x),
      ) *
        betaContinuedFraction(b, a, 1 - x)) /
        b;
}

/* ── Welch-Test auf den Erwartungswert je Trade ───────────────────────────── */

export interface WelchResult {
  /** Mittelwert-Differenz (Kandidat − Amtierende). */
  diff: number;
  t: number;
  /** Freiheitsgrade nach Welch–Satterthwaite (nicht ganzzahlig). */
  df: number;
  /** Zweiseitige Wahrscheinlichkeit; `null`, wenn nicht berechenbar. */
  p: number | null;
}

/**
 * Welch-t-Test für zwei unabhängige Stichproben mit ungleicher Varianz.
 *
 * Bewusst Welch und nicht Student: Zwei Parameter-Varianten handeln
 * unterschiedlich oft und unterschiedlich groß — gleiche Varianzen
 * anzunehmen wäre hier schlicht falsch.
 */
export function welchTTest(a: number[], b: number[]): WelchResult {
  const na = a.length;
  const nb = b.length;
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  if (na < 2 || nb < 2) return { diff: 0, t: 0, df: 0, p: null };
  const ma = mean(a);
  const mb = mean(b);
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (na - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (nb - 1);
  const se2 = va / na + vb / nb;
  // Zwei konstante Stichproben haben keine Streuung — dann gibt es keine
  // Prüfgröße. Lieber null als eine erfundene Sicherheit.
  if (!(se2 > 0)) return { diff: ma - mb, t: 0, df: 0, p: null };
  const t = (ma - mb) / Math.sqrt(se2);
  const df =
    se2 ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  const p = incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return { diff: ma - mb, t, df, p: Math.min(1, Math.max(0, p)) };
}

/* ── Exakter Test nach Fisher (2×2) ───────────────────────────────────────── */

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Zweiseitiger exakter Test nach Fisher für Trefferquoten.
 *
 * `a`/`b` = Gewinner/Verlierer der einen Gruppe, `c`/`d` der anderen.
 * Über Logarithmen gerechnet, damit die Binomialkoeffizienten bei großen
 * Stichproben nicht überlaufen.
 *
 * Der Aufruf, der dieses Modul ausgelöst hat: `fisherExact(2, 15, 6, 10)`
 * für 12 % gegen 39 % Trefferquote — Ergebnis 0,12, also kein Beleg.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  if (n === 0) return 1;
  const zeile1 = a + b;
  const spalte1 = a + c;
  const wahrscheinlichkeit = (i: number): number =>
    Math.exp(
      logChoose(zeile1, i) + logChoose(c + d, spalte1 - i) - logChoose(n, spalte1),
    );
  const beobachtet = wahrscheinlichkeit(a);
  let summe = 0;
  const von = Math.max(0, spalte1 - (c + d));
  const bis = Math.min(zeile1, spalte1);
  for (let i = von; i <= bis; i++) {
    const q = wahrscheinlichkeit(i);
    // „Mindestens so extrem" heißt: höchstens so wahrscheinlich wie das
    // Beobachtete. Der Zuschlag fängt Rundungsfehler ab, die sonst den
    // beobachteten Fall selbst ausschließen könnten.
    if (q <= beobachtet * (1 + 1e-9)) summe += q;
  }
  return Math.min(1, summe);
}

/* ── Das Urteil ───────────────────────────────────────────────────────────── */

export interface Kandidat {
  /** Ergebnis je abgeschlossenem Trade, in Kontowährung. */
  pnls: number[];
  label: string;
}

export interface EvidenceOptions {
  /**
   * Mindestzahl abgeschlossener Trades JE Seite. Unter dieser Grenze wird
   * gar nicht erst gerechnet: Bei 16 Trades war der Unterschied zwischen
   * 12 % und 39 % Trefferquote nicht von Zufall zu unterscheiden.
   */
  minTrades?: number;
  /** Höchste zulässige Irrtumswahrscheinlichkeit. */
  alpha?: number;
  /**
   * Mindest-Vorsprung im Erwartungswert je Trade, in Kontowährung. Ein
   * statistisch signifikanter, aber winziger Vorsprung rechtfertigt keine
   * Umstellung — die kostet selbst wieder Trades und Gebühren.
   */
  minEdge?: number;
}

export const EVIDENCE_DEFAULTS: Required<EvidenceOptions> = {
  minTrades: 30,
  alpha: 0.05,
  minEdge: 0.5,
};

export interface Verdict {
  /** Soll die Variante die amtierende Einstellung ablösen? */
  promote: boolean;
  /** Begründung im Klartext — landet im Änderungs-Journal (MT5). */
  reason: string;
  p: number | null;
  /** Vorsprung im Erwartungswert je Trade. */
  edge: number;
  nCandidate: number;
  nIncumbent: number;
}

const eur = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

/**
 * Entscheidet, ob eine Variante die amtierende Einstellung ablösen darf.
 *
 * Die Reihenfolge der Prüfungen ist Absicht: erst Datenmenge, dann Richtung,
 * dann Größe des Vorsprungs, zuletzt Signifikanz. Jede Stufe liefert einen
 * verständlichen Grund, damit im Journal nicht nur „nicht befördert" steht,
 * sondern WARUM — sonst wäre der Tuner eine Blackbox.
 */
export function judgeCandidate(
  candidate: Kandidat,
  incumbent: Kandidat,
  opts: EvidenceOptions = {},
): Verdict {
  const { minTrades, alpha, minEdge } = { ...EVIDENCE_DEFAULTS, ...opts };
  const na = candidate.pnls.length;
  const nb = incumbent.pnls.length;
  const basis: Pick<Verdict, 'nCandidate' | 'nIncumbent'> = { nCandidate: na, nIncumbent: nb };

  if (na < minTrades || nb < minTrades) {
    return {
      promote: false,
      reason: `Zu wenig Evidenz: ${na} gegen ${nb} Trades, nötig sind ${minTrades} je Seite.`,
      p: null,
      edge: 0,
      ...basis,
    };
  }

  const res = welchTTest(candidate.pnls, incumbent.pnls);
  const edge = Math.round(res.diff * 100) / 100;

  if (edge <= 0) {
    return {
      promote: false,
      reason: `„${candidate.label}" liegt nicht vorn (${eur(edge)} $ je Trade).`,
      p: res.p,
      edge,
      ...basis,
    };
  }
  if (edge < minEdge) {
    return {
      promote: false,
      reason: `Vorsprung zu klein: ${eur(edge)} $ je Trade, gefordert sind ${minEdge.toFixed(2)} $.`,
      p: res.p,
      edge,
      ...basis,
    };
  }
  if (res.p === null || res.p >= alpha) {
    return {
      promote: false,
      reason:
        `Vorsprung ${eur(edge)} $ je Trade, aber statistisch nicht belegt ` +
        `(p = ${res.p === null ? '—' : res.p.toFixed(3)}, nötig < ${alpha}).`,
      p: res.p,
      edge,
      ...basis,
    };
  }
  return {
    promote: true,
    reason:
      `„${candidate.label}" schlägt „${incumbent.label}" um ${eur(edge)} $ je Trade ` +
      `(p = ${res.p.toFixed(3)}, ${na} gegen ${nb} Trades).`,
    p: res.p,
    edge,
    ...basis,
  };
}
