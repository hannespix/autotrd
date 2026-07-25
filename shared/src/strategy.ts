/**
 * autotrd — geteilte Typen (Firestore-Schema + Strategie).
 *
 * EINZIGE WAHRHEIT für das Strategie-Schema: FLACH, wie in CLAUDE.md §2 —
 * broker / watchlist / engine / indicators / signals. Niemals verschachteln
 * (strategy.type/indices/risk_management/execution ist die bekannte kaputte
 * Alt-Variante). Frontend UND Functions importieren von hier.
 */

// ── Strategie (users/{uid}.settings.strategy) ────────────────────────────────

export interface BrokerConfig {
  provider: 'paper' | 'alpaca';
  /** 'live' wird nur wirksam mit serverseitigem Freigabe-Flag (M8). */
  mode: 'paper' | 'live';
  initialCapital: number;
  paperTrading: boolean;
}

export interface EngineConfig {
  checkIntervalMin: number;
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  /** Auto-Trading-Schalter (Dashboard Start/Stop). */
  running: boolean;
}

export interface RsiConfig {
  enabled: boolean;
  window: number;        // 14
  thresholdBuy: number;  // 30
  thresholdSell: number; // 70
}

export interface MacdConfig {
  enabled: boolean;
  crossoverBuy: boolean;
}

export interface BollingerConfig {
  enabled: boolean;
  bbBreakoutPct: number; // 95
}

export interface IndicatorsConfig {
  rsi: RsiConfig;
  macd: MacdConfig;
  bollinger: BollingerConfig;
}

export interface SignalsConfig {
  minConfluence: number;
  period: string; // z. B. '3mo'
  useForecast: boolean;
  forecastWeight: number;
  forecastThresholdPct: number;
}

export interface Strategy {
  broker: BrokerConfig;
  /** Katalog-Symbole (yfinance-Konventionen: '^NDX', 'BTC-USD', 'EURUSD=X'). */
  watchlist: string[];
  engine: EngineConfig;
  indicators: IndicatorsConfig;
  signals: SignalsConfig;
}

/** Watchlist-Obergrenze je User — Kosten-Guard: jedes Symbol kostet bei
 *  jedem 5-min-Scan echte Fetches/Writes (global deckelt MAX_SCAN_SYMBOLS). */
/** Engine-Volltiefe je Symbol (5-min-Scan: Kurs+Indikatoren+News+Intraday) —
 *  der Deckel begrenzt Fetches/Writes, NICHT die Daten (Katalog-Versorgung
 *  liefert allen ~166 Symbolen Kurse+Tageskerzen). 25.07. von 12 auf 20
 *  angehoben (User-Wunsch; Kosten skalieren linear und bleiben klein). */
export const MAX_WATCHLIST = 20;

export const DEFAULT_STRATEGY: Strategy = {
  broker: { provider: 'paper', mode: 'paper', initialCapital: 25_000, paperTrading: true },
  watchlist: ['QQQ', 'AAPL', 'TSLA', '^NDX'],
  engine: { checkIntervalMin: 5, maxPositionPct: 10, stopLossPct: 2, takeProfitPct: 4, running: false },
  indicators: {
    rsi: { enabled: true, window: 14, thresholdBuy: 30, thresholdSell: 70 },
    macd: { enabled: true, crossoverBuy: true },
    bollinger: { enabled: true, bbBreakoutPct: 95 },
  },
  signals: { minConfluence: 2, period: '1y', useForecast: true, forecastWeight: 2, forecastThresholdPct: 0.5 },
};

/* ── Paper-Ausführungskosten (Realismus, User-Wunsch 25.07.) ────────────────
 * Gleiche Konditionen wie der Backtest: 0,1 % Kommission + 5 bp Slippage je
 * Seite. Angewendet als EFFEKTIVER Preis (buy teurer, sell billiger) in
 * executePaperTrade UND shadowTrade — Live-Buch und Schatten-Buch bleiben
 * im A/B-Duell vergleichbar. */
export const PAPER_COMMISSION_PCT = 0.001;
export const PAPER_SLIPPAGE_BPS = 5;
export const PAPER_FEE_RATE = PAPER_COMMISSION_PCT + PAPER_SLIPPAGE_BPS / 10_000;

/** Effektiver Ausführungspreis der Paper-Strecke (Kommission + Slippage). */
export function paperEffectivePrice(price: number, side: 'buy' | 'sell'): number {
  return side === 'buy' ? price * (1 + PAPER_FEE_RATE) : price * (1 - PAPER_FEE_RATE);
}

// ── Geteilte Marktdaten (market/{symbol}/**, nur Functions schreiben) ────────

export interface Quote {
  price: number;
  changePct: number;
  updatedAt: string; // ISO
}

/** Doc-ID: YYYY-MM-DD */
export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Doc-ID: YYYY-MM-DD */
export interface IndicatorSnapshot {
  rsi: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  bollinger: { upper: number; middle: number; lower: number; pctB: number } | null;
}

export type SignalDirection = 'buy' | 'sell' | 'hold';

/** Doc-ID: scanId (ISO-Timestamp des Scans) */
export interface SignalDoc {
  direction: SignalDirection;
  confluence: number;
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger' | 'forecast', SignalDirection>>;
  price: number;
}

/**
 * Doc-ID: `${baseDate}_${w}_${lookback}` — der fachliche Schlüssel ersetzt den
 * SQLite-UNIQUE-Index (idempotente Writes, keine Doppel-Logs).
 * evalForecasts bewertet NUR wenn der letzte Horizont-Tag strikt vor heute
 * liegt UND sein Close realisiert ist (Lookahead-Gate — niemals aufweichen!).
 */
export interface ForecastDoc {
  baseDate: string; // YYYY-MM-DD
  baseClose: number;
  w: number;
  lookback: number;
  horizonDays: number;
  sentiment: number;
  dailyVol: number;
  points: Array<{ time: string; value: number }>;
  /** Prognostizierte Änderung zum Horizont-Ende in % (für den Engine-Vote). */
  predictedPct: number;
  madeAt: string;
  /** false bis zur Bewertung — Query-Feld für evalForecasts. */
  evaluated: boolean;
  evaluatedAt?: string;
  maePct?: number;
  dirHit?: boolean;
  nPoints?: number;
}

// ── User-Daten (users/{uid}/**) ──────────────────────────────────────────────

export interface Wallet {
  paperBalance: number;
  currency: 'USD';
  updatedAt: string;
}

/** Doc-ID: symbol */
export interface Position {
  symbol: string;
  qty: number;
  avgEntry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
}

export interface Trade {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  executedAt: string;
  source: 'engine' | 'manual';
  paper: boolean;
}
