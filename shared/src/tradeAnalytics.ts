/**
 * autotrd — Auswertungen der Handelshistorie (Owner-Wunsch 28.07.:
 * „detaillierte Aufschlüsselung, Charts, Pies, sinnvolle Analyse-Diagramme").
 *
 * Alles hier ist PUR: rein aus einer Trade-Liste gerechnet, keine Datenbank,
 * keine Uhr, kein Zufall. Damit sind die Zahlen testbar und in jedem Backend
 * identisch — sie überleben also den Supabase-Umstieg unverändert.
 *
 * ── Abgrenzung zu portfolio.ts ─────────────────────────────────────────────
 *
 * `portfolio.ts` beantwortet „wie steht das Depot": Sharpe, Drawdown,
 * Trefferquote, Ausstiegsgründe, Kostenanteil. Diese Datei beantwortet
 * „WANN und WORAN verdient oder verliert die Strategie": Verlauf, Verteilung,
 * Uhrzeit, Wochentag, Serien.
 *
 * Der Unterschied ist nicht kosmetisch. Eine Strategie mit Trefferquote 55 %
 * kann trotzdem ruinös sein, wenn die Verluste fünfmal so groß sind wie die
 * Gewinne — das sieht man erst in der VERTEILUNG. Und eine Strategie, die
 * ihr ganzes Minus in der ersten Handelsstunde einfährt, braucht keine neuen
 * Indikatoren, sondern ein Zeitfenster.
 */

/** Ein geschlossener Trade mit Zeitstempel — die Eingabe aller Auswertungen. */
export interface HistoryTrade {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  /** ISO-8601 (UTC), wie der Broker ihn schreibt. */
  executedAt: string;
  source?: 'engine' | 'manual';
  /** Nur an schließenden Trades gesetzt; fehlend = Eröffnung. */
  pnl?: number | null;
  riskExit?: string | null;
  assetClass?: string | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Nur die Trades, die ein Ergebnis realisiert haben. */
export function closedOnly(trades: HistoryTrade[]): HistoryTrade[] {
  return trades.filter((t) => typeof t.pnl === 'number' && Number.isFinite(t.pnl));
}

/** Älteste zuerst — die Firestore-Abfrage liefert absteigend. */
export function chronological(trades: HistoryTrade[]): HistoryTrade[] {
  return [...trades].sort((a, b) => a.executedAt.localeCompare(b.executedAt));
}

export interface EquityStep {
  at: string;
  /** Kontostand NACH diesem Trade (Start + kumuliertes Ergebnis). */
  value: number;
  /** Ergebnis genau dieses Trades. */
  pnl: number;
  symbol: string;
}

/**
 * Kontoverlauf allein aus den Trades.
 *
 * Bewusst NICHT dasselbe wie die Equity-Serie aus `snapshotEquity`: Die zeigt
 * einen Wert pro TAG inklusive unrealisierter Buchgewinne offener Positionen.
 * Diese Kurve springt pro TRADE und zeigt nur Realisiertes. Wer wissen will,
 * ob die Strategie Geld verdient, will diese hier — Buchgewinne einer noch
 * offenen Position sind eine Meinung, kein Ergebnis.
 */
export function equityCurve(trades: HistoryTrade[], startBalance = 0): EquityStep[] {
  let lauf = startBalance;
  return chronological(closedOnly(trades)).map((t) => {
    lauf += t.pnl!;
    return { at: t.executedAt, value: r2(lauf), pnl: r2(t.pnl!), symbol: t.symbol };
  });
}

export interface HistogramBin {
  /** Untere Kante (einschließlich). */
  from: number;
  /** Obere Kante (ausschließlich; im letzten Fach einschließlich). */
  to: number;
  n: number;
}

/**
 * Verteilung der Trade-Ergebnisse.
 *
 * Die Fächer werden IMMER symmetrisch um 0 gelegt, nie einfach von min bis
 * max: Sonst könnte die Null mitten in einem Fach liegen, und ein Fach, das
 * Gewinne und Verluste mischt, macht die eine Frage unbeantwortbar, für die
 * man das Diagramm überhaupt anschaut.
 */
export function pnlHistogram(trades: HistoryTrade[], bins = 11): HistogramBin[] {
  const werte = closedOnly(trades).map((t) => t.pnl!);
  if (werte.length === 0 || bins < 1) return [];
  const spanne = Math.max(...werte.map(Math.abs));
  if (spanne === 0) return [{ from: 0, to: 0, n: werte.length }];

  // Ungerade Fachzahl erzwingen, damit ein Fach exakt auf der Null zentriert
  // sitzt und die Grenze zwischen Gewinn und Verlust nie mitten hineinfällt.
  const n = bins % 2 === 0 ? bins + 1 : bins;
  const breite = (2 * spanne) / n;
  const out: HistogramBin[] = Array.from({ length: n }, (_, i) => ({
    from: r2(-spanne + i * breite),
    to: r2(-spanne + (i + 1) * breite),
    n: 0,
  }));
  for (const w of werte) {
    let idx = Math.floor((w + spanne) / breite);
    if (idx >= n) idx = n - 1; // exakter Höchstwert gehört ins letzte Fach
    if (idx < 0) idx = 0;
    out[idx]!.n += 1;
  }
  return out;
}

export interface Bucket {
  /** Beschriftung (Wochentag, Stunde, Symbol …). */
  key: string;
  n: number;
  pnl: number;
  wins: number;
  /** Trefferquote in Prozent; null ohne Trades. */
  winRatePct: number | null;
}

function buildBucket(key: string): Bucket {
  return { key, n: 0, pnl: 0, wins: 0, winRatePct: null };
}

function finish(buckets: Bucket[]): Bucket[] {
  for (const b of buckets) {
    b.pnl = r2(b.pnl);
    b.winRatePct = b.n > 0 ? r2((b.wins / b.n) * 100) : null;
  }
  return buckets;
}

/**
 * Stunde des Handelstags in der BÖRSEN-Zeitzone (Standard: New York).
 *
 * UTC wäre hier eine Falle: Die US-Eröffnung liegt im Sommer auf 13:30 UTC,
 * im Winter auf 14:30. Eine Auswertung „nach Uhrzeit" über UTC würde die
 * Eröffnungsstunde zweimal im Jahr in ein anderes Fach schieben und den
 * auffälligsten Effekt des Handelstags über zwei Balken verschmieren.
 */
export function hourInZone(iso: string, timeZone = 'America/New_York'): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return Number.parseInt(h, 10) % 24;
}

/** Wochentag 0 = Montag … 6 = Sonntag, ebenfalls in der Börsen-Zeitzone. */
export function weekdayInZone(iso: string, timeZone = 'America/New_York'): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(iso),
  );
  const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
  return idx < 0 ? 0 : idx;
}

export const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;

/** Ergebnis je Wochentag — alle sieben Fächer, auch die leeren. */
export function byWeekday(trades: HistoryTrade[], timeZone = 'America/New_York'): Bucket[] {
  // Leere Tage bleiben drin: Eine Lücke IST die Information („samstags wird
  // nur Krypto gehandelt"). Fehlende Balken würden das verschweigen.
  const out = WEEKDAY_LABELS.map((l) => buildBucket(l));
  for (const t of closedOnly(trades)) {
    const b = out[weekdayInZone(t.executedAt, timeZone)]!;
    b.n += 1;
    b.pnl += t.pnl!;
    if (t.pnl! > 0) b.wins += 1;
  }
  return finish(out);
}

/** Ergebnis je Stunde (0–23) der Börsen-Zeitzone. */
export function byHour(trades: HistoryTrade[], timeZone = 'America/New_York'): Bucket[] {
  const out = Array.from({ length: 24 }, (_, i) => buildBucket(String(i).padStart(2, '0')));
  for (const t of closedOnly(trades)) {
    const b = out[hourInZone(t.executedAt, timeZone)]!;
    b.n += 1;
    b.pnl += t.pnl!;
    if (t.pnl! > 0) b.wins += 1;
  }
  return finish(out);
}

/** Ergebnis je Symbol, nach Betrag sortiert — die größten Hebel zuerst. */
export function bySymbol(trades: HistoryTrade[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of closedOnly(trades)) {
    const b = map.get(t.symbol) ?? buildBucket(t.symbol);
    b.n += 1;
    b.pnl += t.pnl!;
    if (t.pnl! > 0) b.wins += 1;
    map.set(t.symbol, b);
  }
  return finish([...map.values()]).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

export interface StreakInfo {
  /** Längste Serie in Folge gewonnener Trades. */
  longestWin: number;
  /** Längste Serie in Folge verlorener Trades. */
  longestLoss: number;
  /** Laufende Serie; positiv = Gewinne, negativ = Verluste, 0 = keine Trades. */
  current: number;
}

/**
 * Gewinn- und Verlustserien.
 *
 * Die längste Verlustserie ist die praktisch wichtigste Zahl der ganzen
 * Auswertung — nicht statistisch, sondern menschlich: Sie sagt, wie viele
 * Fehlschläge in Folge man aushalten muss, bevor die Strategie wieder
 * liefert. Wer das nicht weiß, schaltet mitten in einer normalen Serie ab.
 *
 * Nullergebnisse brechen keine Serie: Sie sind weder Gewinn noch Verlust.
 */
export function streaks(trades: HistoryTrade[]): StreakInfo {
  let longestWin = 0;
  let longestLoss = 0;
  let lauf = 0;
  for (const t of chronological(closedOnly(trades))) {
    const pnl = t.pnl!;
    if (pnl === 0) continue;
    const gewinn = pnl > 0;
    lauf = gewinn ? (lauf > 0 ? lauf + 1 : 1) : lauf < 0 ? lauf - 1 : -1;
    if (lauf > longestWin) longestWin = lauf;
    if (-lauf > longestLoss) longestLoss = -lauf;
  }
  return { longestWin, longestLoss, current: lauf };
}

export interface HistorySummary {
  total: number;
  closed: number;
  open: number;
  pnl: number;
  bestTrade: number | null;
  worstTrade: number | null;
  /** Erster und letzter Zeitstempel der Historie (ISO), null wenn leer. */
  from: string | null;
  to: string | null;
}

/** Kopfzahlen der Historie — bewusst getrennt von `tradeStats` (dort liegen
 *  die Qualitätsmaße, hier der reine Umfang). */
export function historySummary(trades: HistoryTrade[]): HistorySummary {
  const closed = closedOnly(trades);
  const pnls = closed.map((t) => t.pnl!);
  const sortiert = chronological(trades);
  return {
    total: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    pnl: r2(pnls.reduce((a, b) => a + b, 0)),
    bestTrade: pnls.length > 0 ? r2(Math.max(...pnls)) : null,
    worstTrade: pnls.length > 0 ? r2(Math.min(...pnls)) : null,
    from: sortiert[0]?.executedAt ?? null,
    to: sortiert[sortiert.length - 1]?.executedAt ?? null,
  };
}
