/**
 * Gemeinsame Typen des Auto-Traders. Alles, was Backtest UND Live-Engine
 * teilen, steht hier — beide laufen über denselben Entscheidungspfad
 * (`core/logic.ts`), damit der Backtest genau die Strategie misst, die
 * live handelt.
 *
 * Zeit: Epoch-Millisekunden (UTC). `Bar.t` ist der BEGINN des Buckets
 * (Alpaca-Konvention). Eine Bar gilt als geschlossen, sobald
 * `t + timeframe` erreicht ist — Strategien sehen nur geschlossene Bars.
 */

export type Ms = number;

export type AssetClass = 'us_equity' | 'crypto';

/** Positionsrichtung. */
export type Side = 'long' | 'short';

/** Zeitrahmen in Minuten; 1440 = Tagesbar (eine Bar je Handelstag). */
export type TimeframeMin = 1 | 2 | 3 | 5 | 10 | 15 | 30 | 60 | 1440;

export const TIMEFRAMES: readonly TimeframeMin[] = [1, 2, 3, 5, 10, 15, 30, 60, 1440];

export interface Bar {
  t: Ms;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Volumengewichteter Durchschnittspreis (Alpaca `vw`), falls bekannt. */
  vw?: number;
  /** Anzahl Trades im Bucket (Alpaca `n`), falls bekannt. */
  n?: number;
}

/** Strategie-Parameter: ausschließlich Zahlen, damit das Suchgitter generisch bleibt. */
export type Params = Record<string, number>;

/**
 * Eine Achse des Suchraums. `step` definiert das Gitter (Nachbarschafts-
 * Stabilität wird in ±1 Schritt gemessen). Booleans als 0/1 mit step 1.
 */
export interface ParamSpec {
  name: string;
  min: number;
  max: number;
  step: number;
  kind?: 'int' | 'float';
  /** Kurze Erklärung für Reports. */
  doc?: string;
}

/* ───────────────────────── Positionen & Orders ───────────────────────── */

export interface PositionState {
  symbol: string;
  side: Side;
  /** Stückzahl > 0 (Richtung steht in `side`). */
  qty: number;
  /** Durchschnittlicher Einstandskurs. */
  entryPrice: number;
  entryTime: Ms;
  /** Aktuelle Schutzmarke (liegt live als Stop-Order beim Broker). */
  stop: number | null;
  /** Kursziel (live als Limit-Leg der Bracket-Order). */
  target: number | null;
  /** Erste Schutzmarke — Basis für R-Multiples. */
  initialStop: number | null;
  /** Höchster Close (Long) bzw. tiefster Close (Short) seit Einstieg — Trailing-Basis. */
  highWater: number;
  /** Strategie-ID, die die Position eröffnet hat. */
  strategy: string;
  /** Anzahl geschlossener Bars seit Einstieg (im Strategie-Zeitrahmen). */
  barsHeld: number;
  /** ET-Handelstag des Einstiegs (YYYY-MM-DD) — für die PDT-Zählung. */
  entryDay: string;
}

/** Was eine Strategie je geschlossener Bar sagen darf. */
export type Decision =
  | { kind: 'hold' }
  | {
      kind: 'enter';
      side: Side;
      /** Schutzmarke — Pflicht. Ohne Stop kein Einstieg. */
      stop: number;
      /** Optionales Kursziel (Bracket-Leg). */
      target?: number;
      reason: string;
    }
  | { kind: 'exit'; reason: string }
  | { kind: 'move_stop'; stop: number; reason: string };

/**
 * Die Naht zwischen Entscheidung und Ausführung. Der Backtest füllt Intents
 * selbst, die Engine schickt sie an Alpaca. Beide bekommen exakt dieselbe
 * Liste aus `core/logic.ts`.
 */
export type OrderIntent =
  | {
      kind: 'enter';
      symbol: string;
      side: Side;
      qty: number;
      stop: number;
      target: number | null;
      /** Referenzkurs (Close der Entscheidungs-Bar) — für Sizing/Plausibilität. */
      refPrice: number;
      reason: string;
      strategy: string;
      decidedAt: Ms;
    }
  | { kind: 'exit'; symbol: string; reason: ExitReason; decidedAt: Ms }
  | { kind: 'move_stop'; symbol: string; stop: number; reason: string; decidedAt: Ms };

export type ExitReason =
  | 'stop'
  | 'target'
  | 'signal'
  | 'eod'
  | 'time'
  | 'kill_switch'
  | 'drawdown'
  | 'manual'
  | 'reconcile'
  /** Position ohne führende Strategie (Symbol aus dem Universum gefallen oder Champion auf noTrade) — siehe engine.ts. */
  | 'unmanaged';

/** Abgeschlossener Trade (Backtest wie Live identisch aufgebaut). */
export interface Trade {
  symbol: string;
  side: Side;
  qty: number;
  entryTime: Ms;
  entryPrice: number;
  exitTime: Ms;
  exitPrice: number;
  /** Brutto vor Kosten, in Kontowährung (USD). */
  grossPnl: number;
  /** Alle Kosten (Slippage-Modell, Gebühren, Leihe). */
  fees: number;
  netPnl: number;
  /** Netto-Ergebnis in Einheiten des Anfangsrisikos (Einstand ↔ Erst-Stop). */
  rMultiple: number | null;
  exitReason: ExitReason;
  strategy: string;
  barsHeld: number;
  /** Ungünstigster/günstigster Kurs während der Haltezeit (für Exit-Statistik). */
  mae: number | null;
  mfe: number | null;
}

/* ───────────────────────── Strategie-Vertrag ───────────────────────── */

/** Kolumnare Bar-Serie (Float64Array-Spalten) — siehe core/bars.ts. */
export interface BarSeriesLike {
  readonly length: number;
  readonly t: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;
  at(i: number): Bar;
  /** Präfix-Sicht auf die ersten n Bars (teilt den Speicher). */
  prefix(n: number): BarSeriesLike;
}

export interface SessionInfo {
  /** Reguläre Sitzung (09:30–16:00 ET); Krypto: immer true. */
  isRegularSession: boolean;
  /** Minuten bis Sitzungsende; Krypto: null. */
  minutesToClose: number | null;
  /** Minuten seit Sitzungsbeginn; Krypto: null. */
  minutesSinceOpen: number | null;
  /** Geschlossene Bars seit Sitzungsbeginn (inkl. aktueller). */
  barsSinceOpen: number;
  /** Letzte Bar des Handelstags (nach Kalender/Zeitrahmen). */
  isLastBarOfDay: boolean;
  /** ET-Handelstag (YYYY-MM-DD). */
  day: string;
}

/**
 * Platz dieses Symbols im Korb an DIESER Bar — für querschnittliche
 * Strategien („ist NVDA stärker als die anderen 29?" statt „steigt NVDA?").
 *
 * `pct` ist der Ranganteil in [0, 1]: 0 = stärkstes Symbol, 1 = schwächstes.
 * Absolute Ränge wären in Backtest und Live nicht vergleichbar, weil live ein
 * Symbol ohne Trade im Bucket fehlen kann — Rang 3 von 30 und Rang 3 von 28
 * meinen dann Verschiedenes. Der Anteil bleibt vergleichbar.
 *
 * Gesetzt wird das ausschließlich in `decide()` (core/logic.ts), aus den
 * geschlossenen Bars desselben Zyklus. Damit ist es in beiden Welten dieselbe
 * Zahl und kann keine Zukunft enthalten.
 */
export interface KorbRang {
  /** Ranganteil in [0, 1]; 0 = stärkstes Symbol des Korbs. */
  pct: number;
  /** 1-basierter Rang (1 = stärkstes). */
  rank: number;
  /** Wie viele Symbole in dieser Bar überhaupt rangiert werden konnten. */
  of: number;
}

export interface SymbolSnapshot {
  symbol: string;
  /** Geschlossene Bars (älteste → neueste), Index i = gerade geschlossene Bar. */
  bars: BarSeriesLike;
  i: number;
  position: PositionState | null;
  session: SessionInfo;
  /** Benchmark (z. B. SPY) für Marktfilter — geschlossene Bars bis inkl. `now`. */
  benchmark?: { bars: BarSeriesLike; i: number } | undefined;
  /**
   * Nur bei Querschnitts-Strategien gesetzt, und nur für Symbole, deren
   * Entscheidungs-Bar zur JÜNGSTEN Bar des Zyklus gehört. Ein Symbol mit
   * veralteter letzter Bar (live: kein Trade im Bucket) rangiert nicht mit —
   * sonst verglichen wir Kennzahlen von verschiedenen Zeitpunkten.
   */
  rank?: KorbRang | undefined;
}

/** Vorberechnete Indikatoren einer Strategie (kausal — Präfix-Konsistenz ist Testpflicht). */
export type IndicatorSet = Record<string, Float64Array>;

export interface Strategy {
  id: string;
  /** Unterstützte Zeitrahmen. */
  timeframes: readonly TimeframeMin[];
  paramSpace: readonly ParamSpec[];
  defaults: Params;
  /** Bars, die vor der ersten Entscheidung geschlossen sein müssen. */
  warmupBars(p: Params): number;
  /** Einmal je (Serie, Params); nur Vergangenheit je Index verwenden. */
  precompute(bars: BarSeriesLike, p: Params): IndicatorSet;
  /** Entscheidung an der geschlossenen Bar `snap.i`. */
  decide(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): Decision;
  /** Hält die Strategie über Nacht? (Intraday-Strategien: false ⇒ EOD-Flatten.) */
  holdsOvernight: boolean;
  /**
   * Querschnitt: Kennzahl, nach der der Korb an dieser Bar rangiert wird
   * (größer = stärker). `null` ⇒ dieses Symbol rangiert nicht mit (Aufwärmphase,
   * fehlende Daten). Fehlt die Funktion ganz, ist die Strategie rein
   * symbolweise — wie die vier Vorlagen.
   *
   * `decide()` ruft sie EINMAL je Bar für alle Symbole des Zyklus und schreibt
   * das Ergebnis als `snap.rank` zurück. Sie sieht dieselben geschlossenen Bars
   * wie `decide` und kann deshalb keine Zukunft enthalten.
   */
  crossScore?(snap: SymbolSnapshot, ind: IndicatorSet, p: Params): number | null;
}

/* ───────────────────────── Konto & Risiko-Zustand ───────────────────────── */

export type HaltReason = 'daily_loss' | 'drawdown' | 'manual' | 'errors' | 'reconcile';

export interface HaltState {
  halted: boolean;
  reason: HaltReason | null;
  since: Ms | null;
  /** ET-Tag, an dem ein Tages-Halt automatisch endet (daily_loss). */
  until: string | null;
  note: string | null;
}

/** Portfolio-Sicht, die Backtest und Engine identisch befüllen. */
export interface AccountView {
  equity: number;
  cash: number;
  /** Equity zu Beginn des ET-Handelstags — Basis der Tages-Notbremse. */
  dayStartEquity: number;
  /** Höchste je gesehene Equity — Basis der Drawdown-Sperre. */
  peakEquity: number;
  /** Alpaca-`daytrade_count` (rollierend 5 Handelstage) bzw. Simulation davon. */
  dayTradeCount: number;
  /** Alpaca-`pattern_day_trader`-Flag, falls bekannt. */
  patternDayTrader: boolean;
}

/* ───────────────────────── Backtest-API (für Optimierer) ───────────────────────── */

export interface Metrics {
  netProfit: number;
  netReturnPct: number;
  cagrPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  profitFactor: number | null;
  winRatePct: number | null;
  expectancy: number | null;
  avgR: number | null;
  trades: number;
  exposurePct: number;
  feeShare: number | null;
  /** Kalendertage des Zeitraums. */
  days: number;
}

export interface EquityPoint {
  t: Ms;
  equity: number;
  /**
   * Brutto-Exposure an dieser Bar als Anteil der Equity (Σ |Stück × Schluss| /
   * Equity; 0 = Kasse, 1 = voll investiert, > 1 nur mit Hebel). Der Simulator
   * setzt es je Bar der Range; Fakes dürfen es weglassen — wer es braucht
   * (Basis-Latte), sagt dann „nicht bewertbar", nie „bestanden".
   */
  exposure?: number;
}

export interface SimResult {
  trades: Trade[];
  equity: EquityPoint[];
  /** Tagesrenditen (ET-Handelstage) — Basis für Sharpe/Sortino/PSR. */
  dailyReturns: number[];
  metrics: Metrics;
  /** Letzter Kontozustand (für Kettung von Fenstern). */
  finalEquity: number;
  notes: string[];
}
