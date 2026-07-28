/**
 * autotrd — geteilte Typen (Firestore-Schema + Strategie).
 *
 * EINZIGE WAHRHEIT für das Strategie-Schema: FLACH, wie in CLAUDE.md §2 —
 * broker / watchlist / engine / indicators / signals. Niemals verschachteln
 * (strategy.type/indices/risk_management/execution ist die bekannte kaputte
 * Alt-Variante). Frontend UND Functions importieren von hier.
 */

import { MIN_EDGE_MULTIPLE } from './costGate.js';

// ── Strategie (users/{uid}.settings.strategy) ────────────────────────────────

export interface BrokerConfig {
  provider: 'paper' | 'alpaca';
  /** 'live' wird nur wirksam mit serverseitigem Freigabe-Flag (M8). */
  mode: 'paper' | 'live';
  initialCapital: number;
  paperTrading: boolean;
  /**
   * Basis der Positionsgröße (Owner-Feedback 26.07.: „Cash, der nicht
   * arbeitet, bringt nichts"): 'balance' = maxPositionPct vom VERFÜGBAREN
   * Cash — das Wallet arbeitet weiter, auch wenn schon Positionen offen
   * sind. 'initial' = fixe Tranche vom Startkapital (Referenz-Verhalten);
   * scheitert still, sobald der Rest-Cash die Tranche nicht mehr deckt.
   * Fehlend = 'balance' (der Sinn eines Auto-Traders ist, dass er handelt).
   */
  sizingBase?: 'initial' | 'balance';
  /**
   * Hebel der Kaufkraft (Owner-Wunsch 28.07.). Fehlend oder 1 = KEIN Hebel,
   * also strikt bar gedeckt wie bisher; die Risiko-Hülle klemmt bei
   * MAX_LEVERAGE (3). Wirksam wird er nur bei hoher Überzeugung
   * (`effectiveLeverage`, Owner-Vorgabe: „nur wenn der Algorithmus sich sehr
   * sicher ist") und immer zusammen mit Nachschussgrenze und Margin-Zinsen —
   * siehe margin.ts, warum diese drei Dinge untrennbar sind.
   */
  leverage?: number;
}

/**
 * Risiko-Parameter einer Position. Getrennt vom Rest der EngineConfig, weil
 * sie ab MA6 auch PRO ASSET-KLASSE gelten können (Krypto schwankt anders als
 * ein Index) — `engine.byClass.crypto.stopLossPct` überschreibt dann global.
 */
export interface RiskConfig {
  stopLossPct: number;
  takeProfitPct: number;
  /**
   * Nachziehender Stop in % vom höchsten Kurs seit Einstieg (0 = aus).
   * Der wichtigste Ausstiegs-Mechanismus für Trendphasen: Ein starres
   * Take-Profit verkauft zu früh, ein starrer Stop lässt Gewinne
   * zurücklaufen. Greift zusätzlich zu Stop/Take.
   */
  trailingStopPct?: number;
  /**
   * Stop-Abstand als Vielfaches der ATR(14) statt fixer Prozent (0 = aus).
   * Passt sich automatisch an Instrument UND Marktphase an: bei 2 % Stop
   * ist BTC (±4 % Tagesrange) reines Rauschen, ein Index (±0,6 %) dagegen
   * ein echtes Signal. Hat Vorrang vor stopLossPct, wenn gesetzt.
   */
  atrStopMult?: number;
  /** Take-Profit als ATR-Vielfaches (0 = aus, sonst Vorrang vor takeProfitPct). */
  atrTakeMult?: number;
  /** Zwangsausstieg nach N Kalendertagen Haltedauer (0 = aus) — bindet sonst Kapital. */
  maxHoldDays?: number;
}

export interface EngineConfig extends RiskConfig {
  checkIntervalMin: number;
  maxPositionPct: number;
  /** Auto-Trading-Schalter (Dashboard Start/Stop). */
  running: boolean;
  /**
   * Kauf-Pause nach einem Verkauf desselben Symbols in Minuten (Whipsaw-
   * Schutz). Fehlend = 60; die Risiko-Hülle klemmt auf 5–1440 — unter dem
   * 5-min-Scan-Takt wäre die Pause wirkungslos. Kleiner = mehr Trades.
   */
  cooldownMin?: number;
  /**
   * Mindest-Haltedauer in Minuten, bevor ein SIGNAL-Ausstieg greifen darf.
   * Fehlend = 60, 0 schaltet sie ab; die Hülle klemmt auf 0–1440.
   *
   * Stop-Loss, Trailing-Stop und Take-Profit bleiben davon UNBERÜHRT — eine
   * Haltefrist darf das Sicherheitsnetz niemals aushebeln. Sie bremst nur
   * den Signal-Ausstieg, der sonst jede Position im nächsten Rauschen
   * wieder ausspuckt (Owner-Auswertung 27.07.).
   */
  minHoldMin?: number;
  /**
   * Gleichzeitig offene Positionen (Owner-Frage 28.07.: „kann man die Anzahl
   * der maximal aktiven Trades irgendwo einstellen? habe es nicht in den
   * Optionen gefunden"). Konnte man nicht — der Wert stand fest im Code.
   * Fehlend = 10 (bisheriges Verhalten); die Hülle klemmt auf 1–30.
   */
  maxOpenPositions?: number;
  /**
   * Welche Maschine dieses Wallet handelt (Hantel-Umbau 28.07.).
   *
   * 'confluence' (Default, bisheriges Verhalten): der 5-Minuten-Scan aus
   * RSI/MACD/Bollinger + Prognose bzw. der Regelbaum.
   *
   * 'momentum': Cross-Sectional Momentum über den ganzen handelbaren
   * Katalog — Top 8 gleichgewichtet, WÖCHENTLICH umgeschichtet, mit
   * SMA200-Marktfilter. Der Scan lässt dieses Wallet dann komplett in Ruhe.
   *
   * Warum es ein Entweder-oder ist und kein Nebeneinander: Zwei Maschinen
   * auf einem Wallet würden sich gegenseitig die Positionen wegverkaufen —
   * der Scan sähe eine Momentum-Position ohne Signal und schlösse sie.
   * Die gemischte Aufteilung (Hantel) braucht eine Besitzkennzeichnung je
   * Position und kommt getrennt.
   */
  mode?: 'confluence' | 'momentum';
  /**
   * Risiko-Overrides je Asset-Klasse (Katalog-Schlüssel aus universe.ts:
   * crypto, indices, stocks_us, …). Fehlende Felder erben von oben.
   */
  byClass?: Record<string, Partial<RiskConfig>>;
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
  /** Stimmen, die ein EINSTIEG braucht. */
  minConfluence: number;
  period: string; // z. B. '3mo'
  useForecast: boolean;
  forecastWeight: number;
  forecastThresholdPct: number;
  /**
   * Stimmen, die ein AUSSTIEG aus einer offenen Position braucht
   * (Default: eine weniger als der Einstieg, mindestens 1).
   *
   * Bewusst asymmetrisch: Ein verpasster Einstieg kostet eine Chance, ein
   * verpasster Ausstieg kostet Geld. Vorher galt dieselbe Schwelle für
   * beides — zusammen mit der Gleichstandsregel blockierten RSI und
   * Bollinger (die in fallenden Märkten „überverkauft, also kaufen" sagen)
   * genau dann den Verkauf, wenn er nötig gewesen wäre.
   */
  exitConfluence?: number;
  /**
   * Darf die Prognose die Konfluenz IM ALLEINGANG reißen? Default false.
   *
   * Mit forecastWeight 2 und minConfluence 2 entschied bisher die Prognose
   * allein — die „Konfluenz aus drei Indikatoren" war ein Etikett. Bei
   * false wird ihr Gewicht beim Einstieg auf (minConfluence − 1) gedeckelt,
   * mindestens eine echte Indikator-Stimme muss also dazukommen. Beim
   * AUSSTIEG zählt sie immer voll (Risiko-Asymmetrie).
   */
  forecastSolo?: boolean;
  /**
   * Zeitbasis der Signal-Berechnung (Owner-Auftrag 26.07.: „Tradefrequenz
   * deutlich erhöhen"): 'intraday' rechnet RSI/MACD/Bollinger und den
   * Regelbaum auf 5-MINUTEN-Kerzen — Signale drehen dann im Takt des
   * 5-min-Scans statt alle paar Tage. 'daily' ist die ruhige Tages-Sicht.
   * Fehlend = 'intraday' (der Sinn eines Auto-Traders ist, dass er handelt);
   * die Prognose-Stimme nutzt dann die Kurzfrist-Prognose (nächste Stunde).
   * Ehrlicher Hinweis: Mehr Trades = mehr Gebühren (0,1 % + Slippage je
   * Ausführung) — Paper-Trading ist der Ort, das gefahrlos zu erleben.
   */
  timeframe?: 'daily' | 'intraday';
  /**
   * Leerverkäufe erlauben (Owner-Wunsch 26.07.): Ein VERKAUFS-Signal ohne
   * Position eröffnet dann einen Short (verdient am fallenden Kurs), ein
   * KAUF-Signal deckt ihn ein. Default false — bewusst Opt-in: Beim Short
   * sind Verluste theoretisch unbegrenzt (der Kurs kann beliebig steigen);
   * im Paper-Trading begrenzen Stop-Loss und die 25-%-Notbremse real.
   */
  allowShort?: boolean;
  /**
   * Wie viel die erwartete Bewegung über den Handelskosten liegen muss
   * (Befund 28.07.). Fehlend = MIN_EDGE_MULTIPLE (3); 0 schaltet die
   * Kostenschwelle ab.
   *
   * Der Grund steht in costGate.ts: Über 297 Live-Trades waren die Gebühren
   * das 2,7-Fache des Brutto-Ergebnisses. Wir haben um Beträge gehandelt,
   * die in der Größenordnung der Reibung lagen.
   */
  minEdgeMultiple?: number;
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

/**
 * Obergrenze für `engine.maxOpenPositions`.
 *
 * Warum überhaupt eine: Offene Positionen werden dem Scan-Set UNGEDECKELT
 * hinzugefügt (eine Position ohne frischen Kurs verlöre ihren Stop-Loss) —
 * die Zahl treibt also direkt die Fetch- und Schreiblast jedes Scans. Und der
 * 1-Minuten-Puls beobachtet 60 Symbole über ALLE Konten; wer allein 50
 * Positionen hält, drängt die der anderen aus dem schnellen Ausstieg.
 *
 * 30 ist der Kompromiss: mehr als genug für ein breit gestreutes Depot
 * (bei 3 % je Position wäre es voll investiert), ohne dass ein einzelnes
 * Konto den Takt für alle anderen bestimmt.
 */
export const MAX_OPEN_POSITIONS_CAP = 30;
/** Voreinstellung, wenn `engine.maxOpenPositions` fehlt (Altbestand). */
export const DEFAULT_MAX_OPEN_POSITIONS = 10;

export const DEFAULT_STRATEGY: Strategy = {
  broker: {
    provider: 'paper',
    mode: 'paper',
    initialCapital: 25_000,
    paperTrading: true,
    sizingBase: 'balance',
    // Hebel bewusst AUS im Standard: Er verstärkt Verluste genauso wie
    // Gewinne, und ein Konto, das ihn nie eingeschaltet hat, soll auch nie
    // liquidiert werden können.
    leverage: 1,
  },
  watchlist: ['QQQ', 'AAPL', 'TSLA', '^NDX'],
  engine: {
    checkIntervalMin: 5,
    maxPositionPct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    // Nachziehender Stop ist AN (3 %): Ohne ihn schließt eine Position nur
    // beim starren Take-Profit oder beim Stop — in Trendphasen also fast nie.
    trailingStopPct: 3,
    maxHoldDays: 0,
    running: false,
    // Kauf-Pause und Mindest-Haltedauer standen auf „maximale Frequenz"
    // (15 min bzw. gar nicht). Die Auswertung zweier Testkonten am 27.07.
    // zeigte, warum das nicht trägt: Ø-Gewinn 0,49 %, Ø-Verlust 0,36 %,
    // bei 0,30 % Roundtrip-Kosten — die Reibung fraß 54 % bzw. 86 % des
    // Verlusts. Mehr Frequenz hilft nur, wenn jeder Trade Luft über der
    // Kostenschwelle hat.
    cooldownMin: 60,
    minHoldMin: 60,
    maxOpenPositions: 10,
    mode: 'confluence', // Momentum ist Opt-in — siehe EngineConfig.mode
    // Volatilitäts-Realismus (MA6): Krypto und Rohstoffe brauchen weitere
    // Stops, sonst ist jeder normale Tagesausschlag ein Zwangsverkauf.
    // Werte grob an typischen Tagesranges orientiert; per UI änderbar.
    byClass: {
      crypto: { stopLossPct: 6, takeProfitPct: 10, trailingStopPct: 7 },
      commodities: { stopLossPct: 4, takeProfitPct: 7, trailingStopPct: 5 },
      forex: { stopLossPct: 1, takeProfitPct: 2, trailingStopPct: 1.5 },
      indices: { stopLossPct: 1.5, takeProfitPct: 3, trailingStopPct: 2.5 },
      rates_bonds: { stopLossPct: 1, takeProfitPct: 2, trailingStopPct: 1.5 },
    },
  },
  indicators: {
    rsi: { enabled: true, window: 14, thresholdBuy: 30, thresholdSell: 70 },
    macd: { enabled: true, crossoverBuy: true },
    bollinger: { enabled: true, bbBreakoutPct: 95 },
  },
  signals: {
    minConfluence: 2,
    period: '1y',
    useForecast: true,
    forecastWeight: 2,
    forecastThresholdPct: 0.5,
    // Ausstieg stand auf 1 — EINE Gegenstimme von dreien. Auf 5-min-Bars
    // kippt permanent eine, und die Position flog raus, bevor sie Stop oder
    // Take je erreichte. Die Risiko-Asymmetrie bleibt als Option, aber der
    // Standard entspricht jetzt dem Einstieg.
    exitConfluence: 2,
    forecastSolo: false, // Prognose braucht eine zweite Stimme zum Einstieg
    timeframe: 'intraday', // 5-min-Signale: die Engine handelt im Scan-Takt
    allowShort: false, // Leerverkäufe bewusst Opt-in (Options-Modal + ⓘ)
    minEdgeMultiple: MIN_EDGE_MULTIPLE, // Kostenschwelle AN (Befund 28.07.)
  },
};

/* ── Risiko-Auflösung je Asset-Klasse (MA6) ──────────────────────────────── */

/**
 * Effektive Risiko-Parameter für ein Symbol: globale Engine-Werte, von den
 * Klassen-Overrides (`engine.byClass[assetClass]`) feldweise überschrieben.
 * Pure Funktion — Engine, Backtest und UI müssen dieselbe Antwort bekommen.
 */
export function resolveRisk(engine: EngineConfig, assetClass?: string | null): RiskConfig {
  const base: RiskConfig = {
    stopLossPct: engine.stopLossPct,
    takeProfitPct: engine.takeProfitPct,
    ...(engine.trailingStopPct !== undefined ? { trailingStopPct: engine.trailingStopPct } : {}),
    ...(engine.atrStopMult !== undefined ? { atrStopMult: engine.atrStopMult } : {}),
    ...(engine.atrTakeMult !== undefined ? { atrTakeMult: engine.atrTakeMult } : {}),
    ...(engine.maxHoldDays !== undefined ? { maxHoldDays: engine.maxHoldDays } : {}),
  };
  const over = assetClass ? engine.byClass?.[assetClass] : undefined;
  if (!over) return base;
  const out: RiskConfig = { ...base };
  for (const k of ['stopLossPct', 'takeProfitPct', 'trailingStopPct', 'atrStopMult', 'atrTakeMult', 'maxHoldDays'] as const) {
    const v = over[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

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

/* ── Klassenechte Kosten (Owner-Direktive 28.07.: „Kosten Minimierung") ─────
 *
 * Der Pauschalsatz oben (0,105 % je Seite) stammt aus der ersten
 * Paper-Strecke und ist für JEDE Klasse gleich — das ist an zwei Stellen
 * falsch, und beide verzerren die Auswertung:
 *
 *  - US-Aktien und ETFs kosten bei Alpaca **keine Kommission**. Wir haben
 *    sie dreimal zu teuer simuliert und damit funktionierende Aktien-
 *    Strategien künstlich schlechtgerechnet.
 *  - Krypto kostet dort **mehr** als 0,1 % je Seite. Die Auswertung vom
 *    27.07. lief fast nur auf Krypto — wir haben also ausgerechnet dort
 *    zu günstig gerechnet, wo die Engine tatsächlich handelte.
 *
 * Die Sätze sind bewusst eher pessimistisch als optimistisch: Eine
 * Strategie, die unter zu hoch angesetzten Kosten besteht, besteht auch
 * real. Umgekehrt gilt das nicht.
 */
export const CLASS_FEE_RATE: Record<string, number> = {
  stocks_us: 0.0005, // 0 Kommission, ~5 bp Slippage
  etf_sectors: 0.0005,
  etf_regions: 0.0005,
  etf_thematic: 0.0005,
  stocks_global: 0.0015, // Auslandsbörsen: Gebühr + weiterer Spread
  crypto: 0.0025, // Alpaca Krypto ~25 bp je Seite
  forex: 0.0003,
  commodities: 0.001, // Futures/Rohstoff-Proxys
  indices: 0.0005, // über ETF-Proxys handelbar
  rates_bonds: 0.0005,
};

/** Gebührensatz JE SEITE für eine Asset-Klasse; unbekannt ⇒ Pauschalsatz. */
export function feeRateForClass(assetClass?: string | null): number {
  if (!assetClass) return PAPER_FEE_RATE;
  return CLASS_FEE_RATE[assetClass] ?? PAPER_FEE_RATE;
}

/** Effektiver Ausführungspreis mit klassenechtem Satz. */
export function effectivePriceForClass(
  price: number,
  side: 'buy' | 'sell',
  assetClass?: string | null,
): number {
  const rate = feeRateForClass(assetClass);
  return side === 'buy' ? price * (1 + rate) : price * (1 - rate);
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
  lookback: number;
  horizonDays: number;
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
  /**
   * Höchster Kurs seit Einstieg — Bezugspunkt des nachziehenden Stops.
   * Wird bei jedem Scan fortgeschrieben; fehlt er (Altbestand), gilt der
   * Einstand, der Trailing-Stop startet dann konservativ.
   * Bei SHORT-Positionen ist das Pendant `lowWater` zuständig.
   */
  highWater?: number | null;
  /**
   * Leerverkauf (Owner-Wunsch 26.07., „auch schorten"): 'short' verdient am
   * FALLENDEN Kurs. Fehlend = 'long' (additiv, Altbestand bleibt gültig).
   * Beim Short sind Stop (über dem Einstand) und Take (darunter) gespiegelt.
   */
  side?: 'long' | 'short';
  /** Tiefster Kurs seit Short-Einstieg — Bezugspunkt des Short-Trailings. */
  lowWater?: number | null;
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
