/**
 * portfolio.ts — pure Portfolio-Kennzahlen (M12 Teil 1).
 *
 * Alles hier ist frei von IO und deterministisch testbar. Die Datei lag
 * zuerst unter `functions/src/core/`, gehört aber nach `shared/`: Der
 * tägliche `snapshotEquity`-Scheduler schreibt das Ergebnis nach
 * users/{uid}/stats/main, der Steuer-Export und die Frontend-Kennzahlen
 * rechnen mit denselben Funktionen. Zweimal implementiert würden sie früher
 * oder später verschiedene Zahlen zeigen; so bleibt es eine Quelle mit
 * einer Testreihe.
 *
 * Datums-Konvention: Kalendertage als ISO-Strings (YYYY-MM-DD) — bewusst OHNE
 * Zeitzonen-Arithmetik. Wochenend-/Feiertagslücken und DST-Wechsel sind damit
 * schlicht fehlende Tage in der Serie; eine Tagesrendite entsteht immer
 * zwischen zwei BENACHBARTEN Snapshots, egal wie viele Kalendertage dazwischen
 * liegen (Fr→Mo ist EINE Rendite, kein annualisierungs-verzerrendes Trio).
 */

export interface EquityPoint {
  date: string; // YYYY-MM-DD
  equity: number;
}

/** Geldbeträge/Prozente auf 2 Nachkommastellen. */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Serie säubern: ungültige Punkte raus, je Datum gewinnt der LETZTE Wert
 * (Doppel-Snapshot am selben Tag = Überschreiben, nie Doppelzählung),
 * aufsteigend sortiert.
 */
export function normalizeSeries(points: EquityPoint[]): EquityPoint[] {
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (!p || typeof p.date !== 'string' || p.date.length !== 10) continue;
    if (typeof p.equity !== 'number' || !Number.isFinite(p.equity)) continue;
    byDate.set(p.date, p.equity);
  }
  return [...byDate.entries()]
    .map(([date, equity]) => ({ date, equity }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Tagesrenditen zwischen benachbarten Snapshots; Punkte mit Basis ≤ 0 tragen keine Rendite. */
export function dailyReturns(points: EquityPoint[]): number[] {
  const s = normalizeSeries(points);
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1]!.equity;
    if (prev > 0) out.push((s[i]!.equity - prev) / prev);
  }
  return out;
}

/**
 * Annualisierte Sharpe-Ratio (rf = 0) über Tagesrenditen. `null`, wenn die
 * Serie zu kurz ist (< 2 Renditen) oder flach (Streuung 0) — ein „Sharpe 0"
 * wäre in beiden Fällen eine Falschaussage.
 */
export function sharpe(returns: number[], periodsPerYear = 252): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return r2((mean / std) * Math.sqrt(periodsPerYear));
}

/** High-Water-Mark + maximaler und aktueller Drawdown (in %). */
export function drawdown(points: EquityPoint[]): {
  hwm: number | null;
  maxDDPct: number | null;
  currentDDPct: number | null;
} {
  const s = normalizeSeries(points);
  if (s.length === 0) return { hwm: null, maxDDPct: null, currentDDPct: null };
  let hwm = -Infinity;
  let maxDD = 0;
  for (const p of s) {
    hwm = Math.max(hwm, p.equity);
    if (hwm > 0) maxDD = Math.max(maxDD, (hwm - p.equity) / hwm);
  }
  const last = s[s.length - 1]!.equity;
  const current = hwm > 0 ? (hwm - last) / hwm : 0;
  return { hwm: r2(hwm), maxDDPct: r2(maxDD * 100), currentDDPct: r2(current * 100) };
}

/** Ein GESCHLOSSENER Trade (Verkauf bzw. Short-Cover mit realisiertem P&L). */
export interface ClosedTrade {
  symbol: string;
  /** Ergebnis NACH Gebühren — der Broker rechnet sie in den Ausführungspreis. */
  pnl: number;
  assetClass?: string | null;
  /**
   * Warum die Position geschlossen wurde: `stop_loss` · `take_profit` ·
   * `trailing_stop` · … Fehlend heißt: durch ein SIGNAL geschlossen, nicht
   * durch eine Risiko-Marke.
   */
  riskExit?: string | null;
  /** Positionswert beim Schließen (Stück × Preis) — Basis der Gebührenschätzung. */
  notional?: number | null;
  /** Gebührensatz JE SEITE (Kommission + Slippage), z. B. 0,0015. */
  feeRate?: number | null;
  /** ECHTE Gebühr der Schluss-Seite (`fee`-Feld am Trade, seit 04.08.). */
  fee?: number | null;
  /** Positionswert beim ÖFFNEN (Stück × Einstand) — seit 04.08. am Schluss-Trade. */
  entryNotional?: number | null;
}

/**
 * Roundtrip-Gebühr eines geschlossenen Trades — EINE Quelle für alle
 * Statistiken (Audit 13.08., Hochbefund 4).
 *
 * Bis dahin schätzten Attribution, Kostenprofil und Best-Practice-Bilanz
 * die Gebühren als `notional × feeRate × 2` — obwohl der Broker seit dem
 * 04.08. an jeden Trade die ECHT verbuchte Gebühr schreibt (`fee`). Die
 * Schätzung nimmt die Rate und das Volumen der SCHLUSS-Seite für beide
 * Seiten: Bei einem gelaufenen Kurs stimmt die Einstiegs-Seite nicht, und
 * bei einem echten Broker-Fill galt real die niedrigere Kommissions-Rate
 * ohne Slippage-Aufschlag. Auf genau diesen Zahlen steht die Live-Reife
 * (Profit-Faktor NACH Kosten) — eine Reife-Ampel auf geschätzten Kosten
 * ist keine.
 *
 * Kaskade, ehrlichste zuerst; jede Stufe nutzt nur, was der Trade trägt:
 *  1. `fee` + Einstiegs-Seite aus `entryNotional × feeRate` — Exit echt,
 *     Entry mit echter Basis (Einstand) rekonstruiert.
 *  2. `fee × 2` — Exit echt, Entry als Spiegel angenommen.
 *  3. `notional × feeRate × 2` — Altbestand ohne `fee` (bisherige Rechnung).
 *  4. `null` — es gibt nichts Belastbares; der Trade fällt aus dem
 *     Kostenprofil, statt es mit Annahmen zu verfälschen.
 */
export function roundtripGebuehr(
  t: Pick<ClosedTrade, 'fee' | 'entryNotional' | 'notional' | 'feeRate'>,
): number | null {
  if (typeof t.fee === 'number' && Number.isFinite(t.fee) && t.fee >= 0) {
    if (
      typeof t.entryNotional === 'number' && t.entryNotional > 0
      && typeof t.feeRate === 'number' && t.feeRate >= 0
    ) {
      return t.fee + t.entryNotional * t.feeRate;
    }
    return t.fee * 2;
  }
  if (
    typeof t.notional === 'number' && t.notional > 0
    && typeof t.feeRate === 'number' && t.feeRate >= 0
  ) {
    return t.notional * t.feeRate * 2;
  }
  return null;
}

export interface TradeStats {
  n: number;
  wins: number;
  winRatePct: number | null;
  /** Bruttogewinn / Bruttoverlust; `null` ohne Verluste (statt Infinity). */
  profitFactor: number | null;
  /** Erwartungswert je Trade in Kontowährung. Expectancy-R folgt mit core/risk.ts (R-Multiples). */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
}

export function tradeStats(closed: ClosedTrade[]): TradeStats {
  const valid = closed.filter((t) => typeof t.pnl === 'number' && Number.isFinite(t.pnl));
  const n = valid.length;
  if (n === 0) {
    return { n: 0, wins: 0, winRatePct: null, profitFactor: null, expectancy: null, avgWin: null, avgLoss: null };
  }
  const winners = valid.filter((t) => t.pnl > 0);
  const losers = valid.filter((t) => t.pnl < 0);
  const grossWin = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnl, 0));
  const total = valid.reduce((a, t) => a + t.pnl, 0);
  return {
    n,
    wins: winners.length,
    winRatePct: r2((winners.length / n) * 100),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    expectancy: r2(total / n),
    avgWin: winners.length > 0 ? r2(grossWin / winners.length) : null,
    avgLoss: losers.length > 0 ? r2(-grossLoss / losers.length) : null,
  };
}

/** Firestore-Map-Keys dürfen keine Punkte enthalten (würden Pfade verschachteln). */
function safeKey(raw: string): string {
  return raw.replace(/\./g, '_');
}

export interface AttributionSlice {
  /** Ergebnis NACH Gebühren. */
  pnl: number;
  n: number;
  /**
   * Geschätzte Gebühren dieser Gruppe (beide Seiten). Nur aus Trades, bei
   * denen Positionswert UND Satz bekannt sind — geschätzt wird nichts.
   */
  fees?: number;
  /** Summiertes Handelsvolumen — Nenner für die Rendite je Trade. */
  notional?: number;
  /**
   * NETTO-Rendite je gehandeltem Dollar, in Prozent — also nach Gebühren
   * (`pnl` ist bereits netto). Die eine Zahl, die sagt, ob diese
   * Anlageklasse ihre eigene Reibung verdient. Negativ heißt: Hier wird
   * strukturell Geld verbrannt, egal wie der Markt läuft. `null`, wenn zu
   * wenige Trades Volumen und Satz tragen.
   */
  kantePct?: number | null;
}

/**
 * P&L-Attribution je Symbol und je Asset-Klasse (nur geschlossene Trades).
 *
 * Seit dem 04.08. mit Gebühren, Volumen und der Netto-Kante je Gruppe. Der
 * Grund: Der Gesamtdurchschnitt (+0,143 % brutto gegen 0,300 % Kosten) sagt
 * nur, DASS zu teuer gehandelt wird — nicht WO. Solange das offen ist, wäre
 * jede Änderung an der Kostenschwelle geraten. Eine Anlageklasse mit
 * negativer Kante gehört nicht feinjustiert, sondern abgeschaltet.
 */
export function attribution(closed: ClosedTrade[]): {
  bySymbol: Record<string, AttributionSlice>;
  byClass: Record<string, AttributionSlice>;
} {
  const bySymbol: Record<string, AttributionSlice> = {};
  const byClass: Record<string, AttributionSlice> = {};
  for (const t of closed) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    const sym = safeKey(t.symbol);
    const cls = safeKey(t.assetClass ?? 'unbekannt');
    bySymbol[sym] = { pnl: r2((bySymbol[sym]?.pnl ?? 0) + t.pnl), n: (bySymbol[sym]?.n ?? 0) + 1 };
    const c = byClass[cls] ?? { pnl: 0, n: 0, fees: 0, notional: 0 };
    c.pnl = r2(c.pnl + t.pnl);
    c.n += 1;
    // Gebühren und Volumen nur bei vollständigen Angaben — ein Trade ohne
    // Belastbares würde den Nenner verfälschen und die Kante zu gut
    // aussehen lassen. Die Gebühr kommt aus roundtripGebuehr: echt, wo das
    // fee-Feld steht; geschätzt nur für Altbestand.
    const geb = roundtripGebuehr(t);
    if (geb !== null && typeof t.notional === 'number' && t.notional > 0) {
      c.fees = r2((c.fees ?? 0) + geb);
      c.notional = r2((c.notional ?? 0) + t.notional);
    }
    byClass[cls] = c;
  }
  for (const c of Object.values(byClass)) {
    // Kante = (Ergebnis nach Gebühren) ÷ Volumen. Bewusst NETTO: Die Frage
    // ist nicht, ob die Klasse sich bewegt, sondern ob nach der Reibung
    // etwas übrig bleibt.
    c.kantePct =
      (c.notional ?? 0) > 0 ? Math.round((c.pnl / (c.notional as number)) * 1_000_000) / 10_000 : null;
  }
  return { bySymbol, byClass };
}

export interface PositionLike {
  qty: number;
  avgEntry: number;
  side?: 'long' | 'short';
}

/**
 * Bewertung einer offenen Position zum letzten Kurs — Long ist Marktwert,
 * Short ist Margin + unrealisierter P&L (dieselbe Spiegelung wie im
 * Shadow-Buch/Portfolio-UI: verdient, wenn der Kurs seit Einstieg fiel).
 * Ohne Kurs (null) wird konservativ zum Einstand bewertet.
 */
export function positionValue(pos: PositionLike, price: number | null): number {
  return positionLage(pos, price).wert;
}

export interface PositionLage {
  /** Depotwert dieser Position — ohne Kurs konservativ zum Einstand. */
  wert: number;
  /**
   * Unrealisiertes Ergebnis, oder `null`, wenn kein Kurs vorliegt.
   *
   * `null` und nicht `0`: Ohne Kurs ist das Ergebnis UNBEKANNT, nicht
   * ausgeglichen. Der Unterschied entscheidet, ob die Oberfläche „±0,00 $"
   * schreiben darf (eine Aussage) oder „—" (keine).
   */
  pnl: number | null;
  /** Lag ein brauchbarer Kurs vor? */
  kursBekannt: boolean;
}

/**
 * Wert UND Ergebnis einer offenen Position aus EINER Rechnung.
 *
 * ── Audit-Befund 11.08. (F6) ──────────────────────────────────────────────
 *
 * Das Dashboard rechnete den Positionswert an drei Stellen selbst nach: in
 * der Kennzahlen-Summe, in der Positionstabelle und im Stop-Dialog. Die
 * Formel war überall dieselbe — der Umgang mit einem FEHLENDEN Kurs nicht:
 *
 *   - Die Summe setzte still den Einstand ein und zeigte „P&L ±0,00".
 *   - Die Tabelle zeigte ehrlich „—".
 *   - Der Stop-Dialog zeigte wieder 0.
 *
 * Auf demselben Bildschirm standen damit zwei Antworten auf dieselbe Frage.
 * Und die gefährlichere davon war die Summe: Ein Depotwert, der auf
 * Einstandspreisen beruht, sieht aus wie ein Depotwert — nur dass er
 * bedeutet „hier hat sich nichts bewegt", obwohl niemand weiß, ob das
 * stimmt. Genau die Lage aus dem Owner-Screenshot vom 10.08., in dem 128 von
 * 132 Symbolen keinen Kurs hatten.
 *
 * Der Wert bleibt bewusst konservativ auf Einstand — eine Position aus der
 * Equity zu streichen, weil ihr Kurs fehlt, wäre schlimmer. Aber `pnl` sagt
 * `null`, und `kursBekannt` macht es zählbar.
 */
export function positionLage(pos: PositionLike, price: number | null | undefined): PositionLage {
  const kursBekannt = typeof price === 'number' && Number.isFinite(price) && price > 0;
  const p = kursBekannt ? (price as number) : pos.avgEntry;
  // Short verdient am fallenden Kurs; im Depotwert steckt die hinterlegte
  // Margin (Einstand × Stück) plus unrealisiertes Ergebnis.
  const pnl = (pos.side === 'short' ? pos.avgEntry - p : p - pos.avgEntry) * pos.qty;
  const wert = pos.side === 'short' ? pos.qty * pos.avgEntry + pnl : pos.qty * p;
  return { wert, pnl: kursBekannt ? pnl : null, kursBekannt };
}


/* ── Ausstiegsgründe & Kostenprofil (MT1) ────────────────────────────────────
 *
 * Warum es das gibt: Die Auswertung zweier Testkonten am 27.07. brauchte
 * einen Menschen mit Taschenrechner. Aus „Win Rate 12 %, Profit-Faktor 0,04"
 * musste von Hand zurückgerechnet werden, dass praktisch ALLE Trades am
 * Signal-Ausstieg sterben (nie an Stop oder Take) und die Gebühren 54–86 %
 * des Verlusts ausmachen. Beides war nirgends ablesbar. Ein System, das sich
 * selbst verbessern soll, muss das selbst sehen. */

/** Sammelschlüssel für Trades, die kein Risiko-Exit geschlossen hat. */
export const EXIT_SIGNAL = 'signal';

export interface ExitBucket {
  n: number;
  pnl: number;
  wins: number;
}

/**
 * Trades nach Ausstiegsgrund gruppieren.
 *
 * Die entscheidende Frage, die das beantwortet: Erreichen die Trades ihre
 * Risiko-Marken überhaupt? Steht fast alles unter `signal`, sind Stop und
 * Take reine Dekoration — dann entscheidet nicht die Risikosteuerung über
 * das Ergebnis, sondern das Kippen einer Indikator-Stimme.
 */
export function exitBreakdown(closed: ClosedTrade[]): Record<string, ExitBucket> {
  const out: Record<string, ExitBucket> = {};
  for (const t of closed) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    // Punkte im Schlüssel würden in Firestore eine Verschachtelung erzeugen.
    const key = (t.riskExit || EXIT_SIGNAL).replace(/\./g, '_');
    const b = out[key] ?? { n: 0, pnl: 0, wins: 0 };
    b.n += 1;
    b.pnl = Math.round((b.pnl + t.pnl) * 100) / 100;
    if (t.pnl > 0) b.wins += 1;
    out[key] = b;
  }
  return out;
}

export interface CostProfile {
  /** Trades, bei denen Positionswert und Gebührensatz bekannt sind. */
  n: number;
  /** Geschätzte Gebühren insgesamt (beide Seiten). */
  fees: number;
  /** Ergebnis VOR Gebühren = Netto-Ergebnis + Gebühren. */
  grossPnl: number;
  /** Anteil der Gebühren am Betrag des Netto-Ergebnisses, in Prozent. */
  feeSharePct: number | null;
  /** Ø Gewinnbewegung vor Gebühren, in Prozent des Positionswerts. */
  avgWinGrossPct: number | null;
  /** Ø Verlustbewegung vor Gebühren, in Prozent des Positionswerts. */
  avgLossGrossPct: number | null;
  /** Roundtrip-Kosten in Prozent (beide Seiten). */
  roundTripPct: number | null;
  /**
   * Ø Gewinnbewegung geteilt durch die Roundtrip-Kosten — die EINE Zahl, die
   * sagt, ob eine Strategie überhaupt Luft über der Reibung hat. Unter 2
   * verdient überwiegend der Broker; die Testkonten lagen bei 1,6 und 1,9.
   */
  edgeOverCost: number | null;
}

const LEER: CostProfile = {
  n: 0, fees: 0, grossPnl: 0, feeSharePct: null, avgWinGrossPct: null,
  avgLossGrossPct: null, roundTripPct: null, edgeOverCost: null,
};

/**
 * Kostenprofil der geschlossenen Trades.
 *
 * Die Gebühr steckt bereits im `pnl` (der Broker rechnet sie in den
 * Ausführungspreis) — hier wird sie WIEDER SICHTBAR gemacht. Seit dem
 * 13.08. über `roundtripGebuehr`: echt aus dem `fee`-Feld, wo es steht;
 * die alte Schätzung `Positionswert × Satz × 2` trägt nur noch den
 * Altbestand. Die Live-Reife misst mit `fees`/`grossPnl` von hier.
 */
export function costProfile(closed: ClosedTrade[]): CostProfile {
  const valid = closed.filter(
    (t) =>
      typeof t.pnl === 'number' && Number.isFinite(t.pnl) &&
      typeof t.notional === 'number' && t.notional > 0 &&
      roundtripGebuehr(t) !== null,
  );
  if (valid.length === 0) return { ...LEER };

  let fees = 0;
  let netto = 0;
  let rtSum = 0;
  const winPcts: number[] = [];
  const lossPcts: number[] = [];
  for (const t of valid) {
    const notional = t.notional as number;
    const fee = roundtripGebuehr(t) as number;
    fees += fee;
    netto += t.pnl;
    // Realisierte Roundtrip-Kosten in Prozent des Schluss-Volumens — nicht
    // mehr der NOMINELLE Satz: Bei echten Fills war die Rate real niedriger
    // (nur Kommission), und genau diese Differenz soll die Zahl zeigen.
    rtSum += (fee / notional) * 100;
    const grossPct = ((t.pnl + fee) / notional) * 100;
    if (t.pnl > 0) winPcts.push(grossPct);
    else if (t.pnl < 0) lossPcts.push(Math.abs(grossPct));
  }
  const mittel = (xs: number[]): number | null =>
    xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000;

  const avgWinGrossPct = mittel(winPcts);
  const roundTripPct = Math.round((rtSum / valid.length) * 10000) / 10000;
  return {
    n: valid.length,
    fees: Math.round(fees * 100) / 100,
    grossPnl: Math.round((netto + fees) * 100) / 100,
    // Bei einem Netto-Ergebnis nahe 0 wäre der Anteil beliebig groß — dann
    // sagt die Zahl nichts, also lieber null als eine Scheinpräzision.
    feeSharePct:
      Math.abs(netto) > 0.005 ? Math.round((fees / Math.abs(netto)) * 1000) / 10 : null,
    avgWinGrossPct,
    avgLossGrossPct: mittel(lossPcts),
    roundTripPct,
    edgeOverCost:
      avgWinGrossPct !== null && roundTripPct > 0
        ? Math.round((avgWinGrossPct / roundTripPct) * 100) / 100
        : null,
  };
}
