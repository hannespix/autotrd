/**
 * Dashboard-View — Port des Frosted-Aurora-Dashboards (M3) auf Firestore.
 * Alle Daten kommen per onSnapshot/getDocs aus market/** und users/{uid},
 * Aktionen laufen über Callables (ensureProfile, saveStrategy). Kein /api/*.
 */

import {
  CLASS_LABELS,
  DEFAULT_MAX_OPEN_POSITIONS,
  DEFAULT_RISK_PER_TRADE_PCT,
  DEFAULT_STRATEGY,
  EVIDENCE_DEFAULTS,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS_CAP,
  MAX_RISK_PER_TRADE_PCT,
  MIN_EDGE_MULTIPLE,
  NEWS_VETO_WINDOW_SEC,
  PAPER_FEE_RATE,
  adviseStrategy,
  aggregateBars,
  applySuggestions,
  bollinger,
  buildPriors,
  byHour,
  bySymbol,
  byWeekday,
  classify,
  closedOnly,
  ema,
  equityCurve,
  exitBreakdown,
  historySummary,
  labelVariantId,
  macd,
  pnlHistogram,
  resolveName,
  resolveRisk,
  sma,
  streaks,
  tradeStats,
  validateStrategy,
  vwapSessions,
  wilderRsi,
  type GlobalAxisStats,
  type HistoryTrade,
  type Position,
  type Strategy,
  type Wallet,
} from '@autotrd/shared';
import type { Unsubscribe } from 'firebase/firestore';
import {
  buildIndicatorPanel,
  buildPriceChart,
  type ChartBar,
  type ChartMarker,
  type ChartType,
  type IndicatorPanelHandle,
  type PanelLine,
  type PriceChartHandle,
} from './chart.js';
import { ICONS } from './icons.js';
import {
  callTrade,
  loadMarketQuotes,
  loadUniverse,
  loadWorkspace,
  saveStrategy,
  saveWorkspace,
  callSavePrediction,
  loadBarsOnce,
  loadIntraday,
  loadDailyChunk,
  loadPrediction,
  callQuoteNow,
  saveAutoTune,
  saveUiPrefs,
  watchBars,
  watchLatestIndicators,
  watchLatestSignal,
  watchMarketDoc,
  watchEvaluatedForecasts,
  watchForecastStats,
  watchForecastStatsIntraday,
  watchPositions,
  watchTrades,
  loadMoreTrades,
  TRADE_PAGE,
  watchUserDoc,
  watchWatchedSymbols,
  watchPortfolioStats,
  watchEquitySeries,
  watchMomentum,
  watchTuneFleet,
  watchTuneGlobal,
  watchTuneLog,
  type EvaluatedForecastRow,
  type ForecastStatsDoc,
  type IndicatorRow,
  type MarketDocData,
  type SignalRow,
  type TradeRow,
  type UniverseClass,
  type WorkspaceDocData,
  type PortfolioStatsDoc,
  type EquitySeriesPoint,
  type MomentumDoc,
  type TuneFleetRow,
  type TuneLogRow,
  resetWallet,
} from './data.js';
import { emailVerified, logout, refreshUser, sendVerification } from './auth.js';
import { esc } from './html.js';
import {
  areaLine,
  barChart,
  donut,
  hBarChart,
  histogram,
} from './svgcharts.js';
import { iBtn, initInfoTips } from './infotips.js';
import { mountLegalFooter } from './legal.js';
import {
  GROUP_COLORS,
  clearSubscribers,
  groupSymbol,
  nextGroup,
  publishSymbol,
  seedSymbols,
  setGroup,
  subscribe as busSubscribe,
  type LinkGroup,
} from './linkbus.js';
import { initPalette, matchesHotkey, type PaletteCommand } from './palette.js';

const CLASS_ORDER = [
  'indices', 'forex', 'crypto', 'commodities', 'rates_bonds',
  'etf_sectors', 'etf_regions', 'etf_thematic', 'stocks_us', 'stocks_global',
];

/* ── Workspace-Panels & Presets (M9) ────────────────────────────────── */

const PANEL_TITLES: Record<string, string> = {
  strategy: 'Strategie',
  engine: 'Engine',
  history: 'Trade-Historie',
  chart: 'Chart',
  sigcards: 'Indikator-Kacheln',
  autosignals: 'Auto-Signale',
  positions: 'Positionen',
  market: 'Markt-Übersicht',
  performance: 'Performance',
  manualtrade: 'Manueller Trade',
  clock: 'Markt-Uhr',
  forecastacc: 'Prognose-Genauigkeit',
  fclab: 'Prognose-Labor',
  momentum: 'Momentum-Ranking',
  tuner: 'Auto-Tuner',
  chart2: 'Vergleichs-Chart',
};

/** Panels, die ohne gespeicherten Workspace ausgeblendet starten.
 *  `news` seit 28.07.: Der Scan holt keine News mehr (Owner-Direktive —
 *  Performance vor Erklärung); die Karte zeigte nur noch stehengebliebene
 *  Einträge. Wer sie sehen will, kann sie im Workspace-Menü einblenden. */
const DEFAULT_HIDDEN = new Set(['chart2', 'news']);

/** Werks-Presets: Sichtbarkeits-Sets über den 13 Panels. */
const WS_PRESETS: Record<string, { label: string; hidden: string[] }> = {
  ueberblick: { label: 'Überblick', hidden: ['chart2', 'news'] },
  fokus: {
    label: 'Ein-Symbol-Fokus',
    hidden: ['market', 'autosignals', 'history', 'clock', 'strategy', 'chart2'],
  },
  jaeger: {
    label: 'Signal-Jäger',
    hidden: ['manualtrade', 'clock', 'market', 'history', 'news', 'chart2'],
  },
};

const fmtNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  const dp = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dp });
};
const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined ? '--' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const pnlClass = (n: number): string => (n >= 0 ? 'c-gn' : 'c-rd');

interface DashState {
  uid: string;
  email: string;
  strategy: Strategy;
  currentSymbol: string;
  universe: Record<string, UniverseClass> | null;
  marketClass: string;
  chart: PriceChartHandle | null;
  bars: ChartBar[];
  range: number; // Anzahl Bars, 0 = alle
  /** Intraday-Zeitrahmen aktiv? Anzahl Handelstage (0 = Tageskerzen). */
  intradayDays: number;
  intradayBars: import('./chart.js').IntradayChartBar[];
  /** Tiefe Historie (Chart-Audit 2): ältere Jahres-Chunks, nahtlos vorn dran. */
  histBars: ChartBar[];
  histOldest: number;
  histLoading: boolean;
  histDone: boolean;
  /** Auto-Auflösung: Kerzengröße folgt der Zoomstufe (TradingView-Gefühl). */
  autoRes: boolean;
  /** Aggregations-Fenster der Intraday-Ansicht in Minuten (5/15/60). */
  aggMinutes: number;
  /** Aktuell GEZEIGTE Intraday-Bars (ggf. aggregiert) — Quelle für Overlays. */
  shownIntraday: import('./chart.js').IntradayChartBar[];
  /** Y-Autoscaling der Preisskala (Anzeige-Option, default an). */
  yAuto: boolean;
  /** fitContent beim nächsten renderChart (nur Symbol-/Zeitrahmen-Wechsel). */
  chartFitPending: boolean;
  /** Aktive Indikator-Overlays (sma20/sma50/sma200/ema9/ema21/bb). */
  chartLayers: Set<string>;
  /** Chart-Typ (TV-Parität Teil 1): candles/hollow/heikin/line/area/baseline/bars. */
  chartTypeSel: ChartType;
  /** Kombi: Linientyp zusätzlich zu den Kerzen (Gerät-lokal). */
  typeCombine: boolean;
  /** Preisskala: 0 = linear, 1 = log, 2 = Prozent. */
  scaleMode: 0 | 1 | 2;
  /** In-Chart-Legende aufgeklappt? (Gerät-lokal; mobil default zu). */
  hudOpen: boolean;
  /** OHLC-Kurszeile aufgeklappt? EIN Zustand für ALLE Fenster (Accordion,
   *  Owner-Wunsch 26.07.) — Gerät-lokal, Klick auf die Zeile toggelt. */
  ohlcOpen: boolean;
  /** Aktive User-Prognose (Chart-Pfeil) des aktuellen Symbols. */
  prediction: import('@autotrd/shared').UserPrediction | null;
  predMode: boolean;
  /** Optionale Elemente (Options-Modal ⚙, settings.ui) — ✏ ist Opt-in. */
  ui: {
    predArrow: boolean;
    cmpOverlay: boolean;
    chartGrid: boolean;
    subPanels: boolean;
    /** Marktgruppen-Filter: Klassen-Key → false = versteckt (fehlend = sichtbar). */
    marketGroups?: Record<string, boolean>;
  };
  /** Eingeklappte Module (nur Karten-Körper zu — Gerät-lokal). */
  collapsed: Set<string>;
  /** Clean-View: blendet alles Optionale aus, ohne die Auswahl zu verlieren. */
  cleanView: boolean;
  /** Richtung des letzten Scan-Signals — färbt den Flächen-Verlauf. */
  lastSignalDir: 'buy' | 'sell' | 'hold';
  /** Indikator-Unterpanels (RSI/MACD) — Zeitachse synchron zum Haupt-Chart. */
  subCharts: { rsi: IndicatorPanelHandle | null; macd: IndicatorPanelHandle | null };
  /** Multi-Chart-Raster (Chart-Vision): 1 = nur Haupt-Chart, 2/4 = Panels daneben. */
  gridMode: 1 | 2 | 4;
  /** Haupt-Chart Teil der Lock-Gruppe (Zoom/Crosshair synchron)? */
  mainLocked: boolean;
  gridPanels: GridPanel[];
  /** Zweites Symbol als %-Vergleichslinie (null = aus). */
  overlaySymbol: string | null;
  overlayBars: import('./chart.js').ChartBar[];
  wallet: Wallet | null;
  positions: Position[];
  trades: TradeRow[];
  forecast: MarketDocData['forecast'];
  /** Kurzfrist-Prognose (Intraday-Ansicht, 5-min-Raster). */
  forecastIntraday: MarketDocData['forecastIntraday'];
  /** Link-Bus (M9): Gruppen der verlinkbaren Panels. */
  chartGroup: LinkGroup;
  /** Vergleichs-Chart (M9 Chart-Stack): eigene Gruppe, synchrone Zeitachse. */
  chart2Group: LinkGroup;
  chart2Symbol: string;
  chart2: PriceChartHandle | null;
  chart2Bars: ChartBar[];
  chart2Subs: Unsubscribe[];
  /** Panel-Zustand des Vergleichs-Charts — volle Grid-Parität (User-Wunsch 25.07.). */
  chart2P: GridPanel;
  /** Letzter Quote des Chart-Symbols (fürs Order-Ticket: Preis + Alter). */
  lastQuote: { price: number; updatedAt: string } | null;
  /** Order-Ticket (Shift+B/S). */
  orderSide: 'buy' | 'sell';
  /** Nutzer-Hotkeys aus settings.hotkeys (Defaults siehe HOTKEY_DEFAULTS). */
  hotkeys: Record<string, string>;
  /** Workspace (M9): Preset + ausgeblendete Panels + Save-Debounce. */
  wsPreset: string;
  wsHidden: Set<string>;
  /** Modul-Reihenfolge je Panel-Id (kleiner = weiter oben; fehlend = DOM-Default). */
  wsOrder: Record<string, number>;
  wsSaveTimer: number | null;
  paletteDispose: (() => void) | null;
  /** Event-Tage des aktuellen Symbols (für Marker + Crosshair-Tooltip). */
  /** Layer-Toggles (M6b): Prognose-Overlay / Event-Marker ein- und ausblenden. */
  showForecast: boolean;
  /** Zuletzt gesetzte News-Punkte im Haupt-Chart (E2E-Hook, 26.07.). */
  lastMainMarkers?: number;
  /** Live-Preise der Positions-Symbole (aus market/{sym}.quote). */
  posPrices: Map<string, number>;
  /** Portfolio-Kennzahlen (M12): schreibt der tägliche snapshotEquity-Lauf. */
  pfStats: PortfolioStatsDoc | null;
  equitySeries: EquitySeriesPoint[];
  subs: Unsubscribe[]; // globale Subs (Settings, Wallet, Positionen, Trades)
  symbolSubs: Unsubscribe[]; // pro Chart-Symbol
  watchlistSubs: Unsubscribe[]; // pro beobachtetem Symbol (Livebar + Tabelle)
  /**
   * Was die Engine gerade beobachtet — kommt aus dem Heartbeat, nicht aus
   * einer gespeicherten Auswahl. Leer, bis der erste Scan geschrieben hat;
   * dann greift der Default als Boden (siehe `watchedSymbols`).
   */
  watched: string[];
  /** Historie: älteste geladene Zeile — Cursor der nächsten Seite. */
  tradesCursor: string | null;
  /** Keine älteren Zeilen mehr — der Knopf verschwindet. */
  tradesDone: boolean;
  tradesLoading: boolean;
  /** Katalog-Symbole mit offenem Markt im letzten Scan (Heartbeat). */
  catalogOpen: number;
  /** Davon frisch bekurst — s. `renderWatchHint`. */
  catalogQuotes: number;
  positionSubs: Map<string, Unsubscribe>; // Quotes je Positions-Symbol
  timers: number[];
}

/** Zusatz-Panel im Multi-Chart-Raster: eigenes Symbol + Zeitrahmen + Lock. */
interface GridPanel {
  sym: string;
  range: number; // Bars (0 = alle, wie Haupt-Chart)
  locked: boolean;
  chart: PriceChartHandle | null;
  bars: ChartBar[];
  subs: Unsubscribe[];
  epoch: number;
  fitPending: boolean;
  /** Prognose des Panel-Symbols (Prognose 2.0: das Herzstück gehört in JEDES Chart). */
  forecast: MarketDocData['forecast'];
  /** Kurzfrist-Prognose des Panel-Symbols (Intraday-Sicht). */
  forecastIntraday: MarketDocData['forecastIntraday'];
  /** 0 = Tages-Sicht; 1/5 = 5-min-Sicht (Grid-Parität, User-Wunsch 25.07.). */
  intradayDays: number;
  intradayBars: import('./chart.js').IntradayChartBar[];
  /** Event-Tage des Panel-Symbols (News-Punkte in JEDEM Chart). */
  /** Zeit-Domäne des letzten Renders (Prognose-Räumung beim Moduswechsel). */
  lastRenderIntraday?: boolean;
  /** Zuletzt gesetzte News-Punkte (E2E-Hook, 26.07.). */
  lastMarkers?: number;
  /** Auto-Zeitrahmen (Grid-Gleichwertigkeit 26.07.): eng zoomen → 5-min-
   *  Sicht, weit zoomen → Tageskerzen — wie „Auto" am Haupt-Chart. */
  auto: boolean;
  /** Wechsel läuft gerade (eigene setVisibleRange-Events ignorieren). */
  autoBusy?: boolean;
  autoTimer?: number | null;
  /** OHLC-Kurszeile des Fensters (In-Chart-Overlay; Accordion-Zustand global). */
  hudEl?: HTMLElement | null;
}

let st: DashState | null = null;

// Bus-Abonnenten-Schlüssel der beiden verlinkbaren Panels (M9)
const CHART_KEY = {};
const CHART2_KEY = {};

const HOTKEY_DEFAULTS: Record<string, string> = {
  palette: 'ctrl+k',
  buy: 'shift+b',
  sell: 'shift+s',
};

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** Katalog flach für die Palette (Symbol + Klarname); Fallback: Watchlist. */
function paletteSymbols(): Array<{ symbol: string; name: string }> {
  if (!st) return [];
  if (st.universe) {
    const out: Array<{ symbol: string; name: string }> = [];
    for (const cls of Object.values(st.universe)) {
      for (const entries of Object.values(cls.groups)) out.push(...entries);
    }
    return out;
  }
  return watchedSymbols().map((symbol) => ({ symbol, name: resolveName(symbol) }));
}

function paletteCommands(): PaletteCommand[] {
  if (!st) return [];
  const cmds: PaletteCommand[] = [];
  for (const [id, p] of Object.entries(WS_PRESETS)) {
    cmds.push({
      id: `preset-${id}`,
      label: `Preset: ${p.label}`,
      hint: 'Workspace',
      run: () => applyPreset(id),
    });
  }
  cmds.push(
    { id: 'theme', label: 'Theme wechseln (hell/dunkel)', run: () => $('themeBtn').click() },
    // Auch hier nur die mögliche Aktion: „Engine starten" in der Palette,
    // während sie läuft, wäre derselbe irreführende Knopf wie in der Karte.
    ...(st.strategy.engine.running
      ? [{ id: 'engine-stop', label: 'Engine stoppen', run: (): void => $('engStop').click() }]
      : [{ id: 'engine-start', label: 'Engine starten (Paper)', run: (): void => $('engStart').click() }]),
    { id: 'link-chart', label: 'Chart: Link-Gruppe wechseln', run: () => $('chipChart').click() },
    { id: 'order-buy', label: 'Kaufen … (Order-Ticket, Shift+B)', hint: 'Order', run: () => openOrderTicket('buy') },
    { id: 'order-sell', label: 'Verkaufen … (Order-Ticket, Shift+S)', hint: 'Order', run: () => openOrderTicket('sell') },
  );
  for (const [id, title] of Object.entries(PANEL_TITLES)) {
    cmds.push({
      id: `panel-${id}`,
      label: `Panel ${st.wsHidden.has(id) ? 'einblenden' : 'ausblenden'}: ${title}`,
      hint: 'Panel',
      run: () => togglePanel(id),
    });
  }
  return cmds;
}

/* ── Markup ─────────────────────────────────────────────────────────── */

function layout(email: string): string {
  return `
  <header class="hdr">
    <button class="burg" id="burgL" aria-label="Linkes Panel">☰</button>
    <div class="logo">AUTO<span class="c-gn">TRD</span></div>
    <div class="spacer"></div>
    <div id="engBadge" class="badge b-off">Engine aus</div>
    <button class="hbtn" id="optBtn" title="Optionen: Elemente, Module & Paper-Wallet">${ICONS.gear}</button>
    <button class="hbtn sb-tgl" id="sideL" title="Linke Spalte ein-/ausblenden">◧</button>
    <button class="hbtn sb-tgl" id="sideR" title="Rechte Spalte ein-/ausblenden">◨</button>
    <button class="hbtn" id="themeBtn" title="Hell/Dunkel">◐</button>
    <span class="user">${email.replace(/[<>&]/g, '')}</span>
    <!-- „Abmelden" saß bis 28.07. hier, direkt neben dem rechten Hamburger —
         und wurde beim Griff nach dem Menü ständig mitgetroffen (Owner-
         Screenshot). Eine Aktion, die die Sitzung beendet, gehört nicht
         fingerbreit neben eine, die man dauernd braucht: Sie steht jetzt
         unten im Options-Modal (⚙). -->
    <button class="burg" id="burgR" aria-label="Rechtes Panel">☰</button>
  </header>
  <div class="overlay" id="olv"></div>

  <div class="app">
    <div class="col-l" id="leftCol">
      <div class="card" data-panel="strategy"><div class="sect">Strategie</div><div class="cbody">
        <div class="fld"><label class="lbl">Beobachtet ${iBtn('watchlist')}</label>
          <div id="wlChips" class="wl-chips"></div>
          <div class="hint" id="wlHint">Automatisch gewählt.</div>
        </div>
        <div class="row">
          <div class="fld"><label class="lbl">RSI Kauf &lt; ${iBtn('rsiBuy')}</label><input id="sRsiLo" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">RSI Verkauf &gt; ${iBtn('rsiSell')}</label><input id="sRsiHi" class="inp" type="number"></div>
        </div>
        <div class="row">
          <div class="fld"><label class="lbl">Scan (min) ${iBtn('scan')}</label><input id="sInt" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">Min Konfluenz ${iBtn('konfluenz')}</label><input id="sConf" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">Periode ${iBtn('periode')}</label>
            <select id="sPeriod" class="sel"><option>3mo</option><option>6mo</option><option>1y</option></select></div>
        </div>
        <div class="row">
          <div class="fld"><label class="lbl">Max Pos % ${iBtn('maxPos')}</label><input id="sMaxP" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">Stop % ${iBtn('stopLoss')}</label><input id="sSL" class="inp" type="number" step="0.1"></div>
          <div class="fld"><label class="lbl">Take % ${iBtn('takeProfit')}</label><input id="sTP" class="inp" type="number" step="0.1"></div>
        </div>
        <p id="stratErr" class="error" hidden></p>
        <button class="btn btn-g" id="saveBtn">Speichern</button>
        <div class="hint" id="saveHint"></div>
      </div></div>

      <div class="card" data-panel="engine"><div class="sect">Engine</div><div class="cbody">
        <!-- Immer genau EINER sichtbar (renderEngineBadge schaltet um).
             Startzustand „aus", passend zum Default engine.running: false —
             sobald die Strategie geladen ist, korrigiert der Renderer das. -->
        <button class="btn btn-g" id="engStart">Engine starten</button>
        <button class="btn btn-r" id="engStop" hidden>Engine stoppen</button>
        <div class="hint">Bei Engine AN handelt der zentrale 5-min-Scan
          automatisch nach deiner Strategie (Paper).</div>
        <div id="verifyBox" hidden style="margin-top:8px">
          <p class="hint" style="color:var(--rd)">E-Mail noch nicht bestätigt —
            der Engine-Start ist bis dahin gesperrt (M7-Schutz).</p>
          <div class="row">
            <button class="btn btn-n" id="verifySend">Bestätigungs-Mail</button>
            <button class="btn btn-n" id="verifyDone">Ich habe bestätigt</button>
          </div>
          <div class="hint" id="verifyHint"></div>
        </div>
      </div></div>

      <div class="card" data-panel="history"><div class="sect">Trade-Historie
        <span id="jCount" style="float:right;color:var(--t3)">0</span></div><div class="cbody">
        <div class="row" style="gap:6px;margin-bottom:6px">
          <input id="jFilter" class="inp" placeholder="Symbol filtern …" style="flex:1">
          <select id="jSide" class="inp" style="max-width:110px">
            <option value="">Alle</option><option value="buy">Nur Käufe</option>
            <option value="sell">Nur Verkäufe</option><option value="closed">Nur mit P&amp;L</option>
          </select>
        </div>
        <div class="tw"><table class="tbl">
          <thead><tr><th>Zeit</th><th>Sym</th><th>Side</th><th>Qty</th><th>Preis</th><th>P&amp;L</th></tr></thead>
          <tbody id="jBody"><tr><td colspan="6" class="c-t3">Keine Trades</td></tr></tbody>
        </table></div>
        <button class="btn btn-n" id="jMore" style="width:100%;margin-top:6px">Ältere laden</button>
      </div></div>
    </div>

    <div class="col-m">
      <div class="livebar" id="liveBar"></div>

      <div class="card" data-panel="chart"><div class="sect">Chart · Candlestick + Volumen <button class="lchip" id="chipChart" title="Link-Gruppe wechseln (Chart folgt dieser Gruppe)">A</button></div><div class="cbody">
        <div id="chartMaxScope">
        <div class="chart-hd">
          <span class="chart-nm" id="chSym"></span>
          <span class="chart-sub" id="chSub"></span>
          <span class="chart-px" id="chPx">--</span>
          <span class="chart-px" id="chChg">--</span>
        </div>
        <div class="tf-bar tf-main">
          <button class="tf-btn" id="autoBtn" title="Auto-Auflösung: Die Kerzengröße folgt der Zoomstufe (1D → 1h → 15m → 5m) — stufenlos zoomen wie in TradingView">Auto</button>
          <button class="tf-btn" data-intraday="1" title="1 Handelstag in 5-Minuten-Kerzen">1T</button>
          <button class="tf-btn" data-intraday="5" title="~5 Handelstage in 5-Minuten-Kerzen">1W</button>
          <button class="tf-btn" data-bars="22" title="1 Monat in Tageskerzen">1M</button>
          <button class="tf-btn on" data-bars="66" title="3 Monate in Tageskerzen">3M</button>
          <button class="tf-btn" data-bars="250" title="1 Jahr in Tageskerzen (~250 Handelstage)">1J</button>
          <span id="resBadge" class="res-badge mono" title="Aktive Kerzen-Auflösung"></span>
          <span id="histHint" class="res-badge mono" hidden>lädt ältere Daten …</span>
          <button class="tf-btn" id="predBtn" hidden title="Prognose-Pfeil zeichnen: Klick in den Chart setzt den Ziel-Kurs">${ICONS.pencil}</button>
          <button class="tf-btn" id="jumpStart" title="Animiert zum Anfang der geladenen Historie springen (lädt am Rand automatisch weiter nach)">⇤</button>
          <button class="tf-btn" id="jumpMid" title="Animiert zur Mitte der Timeline springen">◐</button>
          <button class="tf-btn" id="jumpEnd" title="Animiert ans Ende (aktuellster Kurs) springen">⇥</button>
          <button class="tf-btn" id="maxMain" style="margin-left:auto" title="Chart im Vollbild — Legende und Menüs bleiben verfügbar (Esc schließt)">⛶</button>
          <button class="tf-btn" id="cleanBtn" title="Clean-View: alles Optionale auf einmal ausblenden — nur der Kurs bleibt">Clean</button>
          <span class="tool-anchor">
            <button class="tf-btn" id="indBtn" title="Indikatoren: Overlays im Chart + RSI/MACD-Unterpanels">Indikatoren ▾</button>
            <div id="menuInd" class="tool-menu" hidden>
              <div class="tm-sec">Overlays — Linien in allen Charts</div>
              <button class="tf-btn" data-layer="sma20" title="Einfacher gleitender Durchschnitt, 20 Bars">SMA20</button>
              <button class="tf-btn" data-layer="sma50" title="SMA 50">SMA50</button>
              <button class="tf-btn" data-layer="sma200" title="SMA 200">SMA200</button>
              <button class="tf-btn" data-layer="ema9" title="Exponentieller Durchschnitt, 9">EMA9</button>
              <button class="tf-btn" data-layer="ema21" title="EMA 21">EMA21</button>
              <button class="tf-btn" data-layer="bb" title="Bollinger-Bänder (20, 2σ)">BB</button>
              <button class="tf-btn ind-x" data-layer="vwap" title="VWAP (Intraday 1T/1W): volumengewichteter Durchschnitt je Handelstag">VWAP</button>
              <div class="tm-sec">Chart-Typ (TV-Stil)</div>
              <button class="tf-btn on" data-ctype="candles" title="Klassische Kerzen: Körper = Eröffnung↔Schluss, Docht = Hoch/Tief">Kerzen</button>
              <button class="tf-btn" data-ctype="hollow" title="Hohle Kerzen: steigende Kerzen ohne Füllung — Trendrichtung auf einen Blick">Hohl</button>
              <button class="tf-btn" data-ctype="heikin" title="Heikin-Ashi: geglättete Kerzen (Mittelwerte) — Trends klarer, exakte Kurse verschwimmen">Heikin-Ashi</button>
              <button class="tf-btn" data-ctype="line" title="Linie: nur Schlusskurse — der ruhigste Blick">Linie</button>
              <button class="tf-btn" data-ctype="area" title="Berg: Schlusskurs-Linie mit Farbverlauf darunter">Berg</button>
              <button class="tf-btn" data-ctype="baseline" title="Baseline: grün über/rot unter dem Startkurs des Fensters">Baseline</button>
              <button class="tf-btn" data-ctype="bars" title="OHLC-Bars: klassische Balken mit Eröffnungs-/Schluss-Nasen">Bars</button>
              <button class="tf-btn ind-x" id="ctypeCombine" title="Kombi: Linie/Berg/Baseline ZUSÄTZLICH zu den Kerzen zeichnen (bei Kerzen-Typen und Bars ohne Wirkung)">+ Kerzen</button>
              <div class="tm-sec">Preisskala</div>
              <button class="tf-btn on" data-scale="0" title="Lineare Skala: gleiche Abstände je Euro/Dollar">Lin</button>
              <button class="tf-btn" data-scale="1" title="Logarithmische Skala: gleiche Abstände je PROZENT — bei langen Historien ehrlicher">Log</button>
              <button class="tf-btn" data-scale="2" title="Prozent-Skala: Entwicklung relativ zum Fenster-Start">%</button>
              <div class="tm-sec">Stil</div>
              <button class="tf-btn" data-layer="area" title="Flächen-Verlauf unter der Kurslinie — die Farbe folgt dem aktuellen Signal (grün = Kauf, rot = Verkauf, blau = neutral)">Fläche</button>
              <button class="tf-btn" data-layer="hideCandles" title="Kerzen + Volumen ausblenden (ruhiger Vektor-Look, z. B. mit aktiver Fläche)">Kerzen aus</button>
              <div class="tm-sec">Unterpanels — synchron zum Haupt-Chart</div>
              <button class="tf-btn ind-x" data-layer="rsiPanel" title="RSI(14) als Unterpanel">RSI</button>
              <button class="tf-btn ind-x" data-layer="macdPanel" title="MACD(12/26/9) als Unterpanel">MACD</button>
            </div>
          </span>
          <span class="tool-anchor">
            <button class="tf-btn" id="layBtn" title="Layer, Raster & Vergleich">Layer ▾</button>
            <div id="menuLay" class="tool-menu" hidden>
              <div class="tm-sec">Layer</div>
              <button class="tf-btn on" id="lyFc" title="Prognose-Overlay ein/aus">Prognose</button>
              <button class="tf-btn on" id="yAutoBtn" title="Y-Autoscaling: Preisskala passt sich beim Scrollen/Zoomen automatisch an — ausschalten, um die Y-Achse manuell festzuhalten (Ziehen auf der Preisskala)">Y-Auto</button>
              <div class="tm-sec">Raster — bis zu 4 Kurse parallel</div>
              <span class="grid-sw" title="Charts im Raster: 1, 2 oder 4 parallel">
                <button class="tf-btn on" data-grid="1">▭</button>
                <button class="tf-btn" data-grid="2">▯▯</button>
                <button class="tf-btn" data-grid="4">⊞</button>
              </span>
              <div class="tm-sec">Vergleich</div>
              <input id="cmpSym" class="inp cmp-inp" placeholder="+ Overlay: SYM" title="Zweiten Kurs als %-Linie überlagern (Tageskerzen)" />
            </div>
          </span>
        </div>
        <div class="hint" id="fcInfo" style="margin-bottom:4px"></div>
        <div id="chartRow" class="chart-row" data-mode="1">
        <div id="chartWrap" class="chart-wrap">
          <!-- Kopf NUR im Raster (26.07.): strukturgleich zu .gp-hd, damit das
               Haupt-Fenster exakt so hoch sitzt wie die Panels — vorher fehlte
               ihm deren Kopfzeile und das Chart klebte 38 px zu weit oben. -->
          <div id="mainHd" class="gp-hd" hidden>
            <input id="mainHdSym" class="inp mh-sym" title="Symbol des Haupt-Charts (Enter übernimmt)" />
            <span class="gp-tf">
              <button class="tf-btn" id="mhAuto"
                title="Auto-Zeitrahmen: eng zoomen wechselt in feinere Kerzen, weit zoomen zurück zu Tageskerzen">Auto</button>
              <button class="tf-btn" data-mh-i="1" title="1 Handelstag in 5-Minuten-Kerzen">1T</button>
              <button class="tf-btn" data-mh-i="5" title="~5 Handelstage in 5-Minuten-Kerzen">1W</button>
              <button class="tf-btn" data-mh-r="22">1M</button>
              <button class="tf-btn" data-mh-r="66">3M</button>
              <button class="tf-btn" data-mh-r="0">1J</button>
            </span>
            <button class="tf-btn mh-max" id="mhMax" title="Chart im Vollbild (Esc schließt)">⛶</button>
            <button class="tf-btn mh-lock" id="lockMain"
              title="Haupt-Chart in die Lock-Gruppe: Zoom, Sichtbereich und Crosshair laufen auf allen gelockten Charts synchron">${ICONS.unlock}</button>
          </div>
          <button id="maxExit" class="chart-max-exit" hidden title="Vollbild schließen (Esc)">✕</button>
          <div id="chartHud" class="chart-hud">
            <div class="hud-top">
              <div id="ohlcRow" class="ohlc-row mono" hidden></div>
              <button id="hudTgl" class="hud-tgl" title="Legende ein-/ausklappen">▾</button>
            </div>
            <div id="chartLegend" class="chart-legend" hidden></div>
          </div>
          <div id="chartArea"></div>
          <button id="jumpNow" class="jump-now" hidden
            title="Zurück zur Gegenwart — animierter Sprung zum jüngsten Kurs">Jetzt ⇥</button>
          <svg id="predSvg" class="pred-svg" aria-hidden="true"></svg>
          <div id="predPop" class="pred-pop" hidden>
            <b>Prognose-Pfeil</b>
            <label>Ziel-Kurs <input id="ppPrice" class="inp st-num" type="number" step="0.5" /></label>
            <label>Ziel-Datum <input id="ppDate" class="inp" type="date" /></label>
            <label>Vertrauen
              <span class="st-stepper">
                <button type="button" class="btn btn-n" id="ppConfM">−</button>
                <b class="mono" id="ppConfV">2</b>
                <button type="button" class="btn btn-n" id="ppConfP">+</button>
              </span>
            </label>
            <div class="row">
              <button type="button" class="btn btn-g" id="ppSave">Speichern</button>
              <button type="button" class="btn btn-n" id="ppDel">Löschen</button>
              <button type="button" class="btn btn-n" id="ppClose">✕</button>
            </div>
            <p class="hint">Der Algorithmus nimmt den Pfeil als gewichtete Stimme (Dicke = Vertrauen).</p>
          </div>
        </div>
        <div id="chartGrid"></div>
        </div>
        <div id="chartHDrag" class="chart-h-drag"
          title="Chart-Höhe ziehen — gilt für ALLE Fenster; Doppelklick setzt zurück"></div>
        <div id="rsiPanel" class="sub-panel" hidden></div>
        <div id="macdPanel" class="sub-panel" hidden></div>
        </div>
        <div class="hint">1T/1W: 5-Minuten-Kerzen · 1M–1J: Tageskerzen —
          aktualisiert der zentrale 5-min-Scan. Zoom bleibt beim Aktualisieren erhalten.</div>
      </div></div>

      <div class="card" data-panel="chart2"><div class="sect">Vergleichs-Chart
        <button class="lchip" id="chipChart2" title="Link-Gruppe wechseln (Vergleichs-Chart folgt dieser Gruppe)">B</button></div><div class="cbody">
        <div class="chart-hd">
          <input id="ch2Sym" class="inp mh-sym"
            title="Vergleichs-Symbol — frei wählbar, unabhängig vom Raster (Enter übernimmt)" />
          <span class="chart-px" id="ch2Px">--</span>
          <span class="gp-tf" id="c2tf" style="margin-left:auto">
            <button class="tf-btn" id="c2Auto"
              title="Auto-Zeitrahmen: eng zoomen wechselt in die 5-Minuten-Sicht, weit zoomen zurück zu Tageskerzen">Auto</button>
            <button class="tf-btn" data-c2i="1" title="1 Handelstag in 5-Minuten-Kerzen">1T</button>
            <button class="tf-btn" data-c2i="5" title="~5 Handelstage in 5-Minuten-Kerzen">1W</button>
            <button class="tf-btn" data-c2r="22">1M</button>
            <button class="tf-btn on" data-c2r="66">3M</button>
            <button class="tf-btn" data-c2r="0">1J</button>
          </span>
        </div>
        <div id="chart2Area" style="height:200px"></div>
        <div class="hint">Zeitachse + Crosshair laufen synchron zum Haupt-Chart —
          eigene Link-Gruppe für den Symbol-Vergleich; Zeitrahmen-Wechsel oben
          gelten auch hier.</div>
      </div></div>

      <div class="sig-grid" data-panel="sigcards">
        <div class="scard"><div class="slbl">RSI (14)</div><div id="vRSI" class="sval c-ac">--</div></div>
        <div class="scard"><div class="slbl">MACD</div><div id="vMacd" class="sval c-ac">--</div></div>
        <div class="scard"><div class="slbl">BB Pos %</div><div id="vBB" class="sval c-ac">--</div></div>
        <div class="scard"><div class="slbl">Signal</div><div id="vSig" class="sval c-t3">--</div></div>
      </div>

      <div class="card" data-panel="autosignals"><div class="sect">Auto-Signale</div><div class="cbody">
        <div class="tw"><table class="tbl">
          <thead><tr><th>Ticker</th><th>RSI</th><th>MACD</th><th>BB %</th><th>Konfluenz</th><th>Signal</th></tr></thead>
          <tbody id="sigBody"><tr><td colspan="6" class="c-t3">Noch kein Scan</td></tr></tbody>
        </table></div>
      </div></div>

      <div class="card" data-panel="positions"><div class="sect">Aktive Positionen <span id="pCount" style="float:right;color:var(--t3)">0 offen</span></div><div class="cbody">
        <div class="tw"><table class="tbl">
          <thead><tr><th>Sym</th><th>Qty</th><th>Eintritt</th><th>Aktuell</th><th>P&amp;L</th><th>%</th><th></th></tr></thead>
          <tbody id="pBody"><tr><td colspan="7" class="c-t3">Keine offenen Positionen</td></tr></tbody>
        </table></div>
      </div></div>

      <div class="card" data-panel="market"><div class="sect">Markt-Übersicht</div><div class="cbody">
        <div class="mkt-tabs" id="mktTabs"></div>
        <div id="mktBody"><span class="c-t3">Lade Katalog…</span></div>
      </div></div>
    </div>

    <div class="col-r" id="rightCol">
      <div class="card" data-panel="performance"><div class="sect">Performance</div><div class="cbody kpi">
        <label class="lbl">Cash</label><div id="vCash" class="vbig c-ac">--</div>
        <label class="lbl">Equity (live)</label><div id="vEq" class="vbig">--</div>
        <label class="lbl">Gesamt P&amp;L</label><div id="vPnl" class="vbig">--</div>
        <div class="row" style="gap:12px">
          <div><label class="lbl">Realisiert</label><div id="vClosed" class="smv">--</div></div>
          <div><label class="lbl">Offen</label><div id="vUnreal" class="smv">--</div></div>
          <div><label class="lbl">Win Rate</label><div id="vWR" class="smv">--%</div></div>
        </div>
        <label class="lbl" style="margin-top:10px">Equity-Kurve ${iBtn('equityCurve')}</label>
        <svg id="pfSpark" class="pf-spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="pf-grid" id="pfGrid" hidden>
          <div><label class="lbl">Sharpe 30 ${iBtn('sharpe')}</label><div id="pfS30" class="smv mono">--</div></div>
          <div><label class="lbl">Sharpe 90</label><div id="pfS90" class="smv mono">--</div></div>
          <div><label class="lbl">Max-Drawdown ${iBtn('maxdd')}</label><div id="pfDD" class="smv mono">--</div></div>
          <div><label class="lbl">Hochwasser ${iBtn('hwm')}</label><div id="pfHwm" class="smv mono">--</div></div>
          <div><label class="lbl">Profit-Faktor ${iBtn('profitFactor')}</label><div id="pfPF" class="smv mono">--</div></div>
          <div><label class="lbl">Erwartung/Trade ${iBtn('expectancy')}</label><div id="pfExp" class="smv mono">--</div></div>
        </div>
        <label class="lbl" style="margin-top:10px">Warum geschlossen ${iBtn('exits')}</label>
        <div id="pfExits" class="fl-tbl"><div class="hint">Noch keine geschlossenen Trades.</div></div>
        <label class="lbl" style="margin-top:10px">Reibung ${iBtn('kosten')}</label>
        <div class="pf-grid" id="pfCostGrid" hidden>
          <div><label class="lbl">Gebühren</label><div id="pfFees" class="smv mono">--</div></div>
          <div><label class="lbl">Anteil am Ergebnis</label><div id="pfFeeShare" class="smv mono">--</div></div>
          <div><label class="lbl">Ø Gewinn brutto</label><div id="pfGrossWin" class="smv mono">--</div></div>
          <div><label class="lbl">Ø Verlust brutto</label><div id="pfGrossLoss" class="smv mono">--</div></div>
          <div><label class="lbl">Roundtrip-Kosten</label><div id="pfRt" class="smv mono">--</div></div>
          <div><label class="lbl">Luft über Kosten</label><div id="pfEdge" class="smv mono">--</div></div>
        </div>
        <div class="hint" id="pfCostHint"></div>
        <div class="hint" id="pfHint">Kennzahlen entstehen ab dem ersten Tages-Snapshot (täglich 23:15).</div>
        <!-- Owner-Feedback 28.07.: „man schaut meistens auf die Performance, und
             wenn man die History direkt darunter hat, ist das logischer." Stimmt —
             die Analyse ist die Vertiefung genau dieser Kennzahlen, nicht ein
             Anhängsel der Trade-Tabelle. -->
        <button class="btn btn-g" id="anOpen" style="width:100%;margin-top:8px">Handels-Analyse öffnen</button>
      </div></div>

      <div class="card" data-panel="manualtrade"><div class="sect">Manueller Trade</div><div class="cbody">
        <label class="lbl">Symbol (Katalog)</label>
        <div class="mt-combo">
          <input id="mSym" class="inp" placeholder="Suchen: Name oder Symbol …" autocomplete="off">
          <div id="mSymList" class="mt-list" hidden></div>
        </div>
        <div id="mtInfo" hidden>
          <div class="hint" id="mtName"></div>
          <div class="row mt-inds">
            <div><label class="lbl">Kurs/Einheit</label><div id="mtPx" class="smv mono">--</div></div>
            <div><label class="lbl">Heute</label><div id="mtChg" class="smv mono">--</div></div>
            <div><label class="lbl">RSI ${iBtn('rsi')}</label><div id="mtRsi" class="smv mono">--</div></div>
            <div><label class="lbl">MACD ${iBtn('macd')}</label><div id="mtMacd" class="smv">--</div></div>
            <div><label class="lbl">Signal ${iBtn('signal')}</label><div id="mtSig" class="smv">--</div></div>
          </div>
        </div>
        <label class="lbl">Stückzahl</label>
        <div class="row">
          <input id="mQty" class="inp" type="number" value="1" min="1" style="flex:1">
          <button class="tf-btn" id="mtMax" title="Maximale Stückzahl nach Kaufkraft (inkl. Gebühren)">Max</button>
        </div>
        <div class="mt-sum">
          <div class="mt-row"><span>Zwischensumme</span><span id="mtSub" class="mono">--</span></div>
          <div class="mt-row"><span>Gebühren (0,1 % + 5 bp) ${iBtn('fees')}</span><span id="mtFee" class="mono">--</span></div>
          <div class="mt-row mt-total"><span>Gesamt</span><span id="mtTotal" class="mono">--</span></div>
          <div class="mt-row"><span>Kaufkraft danach ${iBtn('kaufkraft')}</span><span id="mtCash" class="mono">--</span></div>
        </div>
        <div class="row">
          <button class="btn btn-g" id="mtBuy">Kaufen</button>
          <button class="btn btn-r" id="mtSell">Verkaufen</button>
        </div>
        <div class="hint" id="mtHint">Paper-Ausführung zum Live-Kurs inkl. Kommission (0,1 %)
          + Slippage (5 bp) — dieselben Konditionen wie im Backtest.</div>
      </div></div>

      <div class="card" data-panel="clock"><div class="sect">Markt-Uhr (ET)</div><div class="cbody">
        <div id="marketClock" class="clock">--:--:--</div>
        <div class="phases">
          <div class="ph" id="phPre">Pre-Mkt</div>
          <div class="ph" id="phMain">Regular</div>
          <div class="ph" id="phAft">After-Hrs</div>
        </div>
      </div></div>

      <div class="card" data-panel="forecastacc"><div class="sect">Prognose-Genauigkeit</div><div class="cbody kpi">
        <label class="lbl">Richtungs-Trefferquote ${iBtn('fcCombo')}</label>
        <div id="fcAcc" class="vbig c-ac">--</div>
        <div class="row" style="gap:12px">
          <div><label class="lbl">Bewertet</label><div id="fcScored" class="smv">0</div></div>
          <div><label class="lbl">Lookback</label><div id="fcLb" class="smv">--</div></div>
        </div>
        <div class="hint" id="fcTuning">Self-Tuning sammelt Evidenz — Defaults aktiv,
          bis genug Prognosen realisiert sind.</div>
        <div class="hint" id="fcVoteInfo"></div>
      </div></div>

      <div class="card" data-panel="fclab"><div class="sect">Prognose-Labor <span id="flSym" style="float:right;color:var(--t3)"></span></div><div class="cbody">
        <div class="hint">Selbstverbesserung: Jede gespeicherte Prognose wird nach Ablauf
          ihres Horizonts gegen die eingetretene Realität bewertet. Die Trefferquote je
          Lookback-Fenster steuert, welches Fenster künftige Prognosen nutzen — und ob
          die Prognose beim Handeln überhaupt mitstimmen darf.</div>
        <label class="lbl">Kombi-Statistik Tages-Prognose (Lookback-Fenster) ${iBtn('fcCombo')}</label>
        <div id="flCombos" class="fl-tbl"><div class="hint">Noch keine bewerteten Prognosen.</div></div>
        <label class="lbl">Kombi-Statistik Kurzfrist/Intraday (Lookback in 5-min-Bars) ${iBtn('kurzfrist')}</label>
        <div id="flCombosIntra" class="fl-tbl"><div class="hint">Noch keine bewerteten Kurzfrist-Prognosen.</div></div>
        <label class="lbl">Vorhersage vs. Realität ${iBtn('mae')} <span id="flSym2" style="color:var(--t3)"></span></label>
        <div id="flRows" class="fl-tbl"><div class="hint">Noch keine bewerteten Prognosen für dieses Symbol.</div></div>
      </div></div>

      <div class="card" data-panel="momentum"><div class="sect">Momentum-Ranking ${iBtn('momentum')}
        <span id="moFilter" class="tn-tag" style="float:right"></span>
      </div><div class="cbody">
        <div class="hint">Statt einer Watchlist wird der GANZE Katalog nach 12-Monats-Momentum
          sortiert (der letzte Monat zählt nicht mit — auf Monatssicht kehren Kurse eher um).
          Gekauft werden die stärksten acht, gleichgewichtet, mit Wochen-Rhythmus. Das läuft
          als Schattendepot neben deiner Strategie: Umgestellt wird erst, wenn es sie
          nachweislich schlägt.</div>
        <div class="row" style="gap:12px;margin-top:8px">
          <div><label class="lbl">Schatten-Depot</label><div id="moEq" class="smv mono">--</div></div>
          <div><label class="lbl">Trades</label><div id="moTrades" class="smv mono">0</div></div>
          <div><label class="lbl">Bewertbar</label><div id="moRanked" class="smv mono">--</div></div>
        </div>
        <label class="lbl" style="margin-top:10px">Spitze des Universums</label>
        <div id="moTop" class="fl-tbl"><div class="hint">Das erste Ranking entsteht mit dem nächsten Tages-Lauf (18:00 ET).</div></div>
        <div class="hint" id="moHint"></div>
      </div></div>

      <div class="card" data-panel="tuner"><div class="sect">Auto-Tuner ${iBtn('autotuner')}
        <label class="tn-sw" title="Abschalten heißt: Die Einstellungen bleiben, wie du sie gesetzt hast."><input type="checkbox" id="tnOn" checked><span>aktiv</span></label>
      </div><div class="cbody">
        <div class="hint">Jede Variante deiner Einstellung führt ein eigenes Schattenkonto auf
          denselben Kursen. Schlägt eine davon nachweislich die aktuelle — statistisch geprüft,
          nicht nach Bauchgefühl —, wird sie übernommen. Hier steht jede Prüfung, auch die
          abgelehnten.</div>
        <label class="lbl" style="margin-top:8px">Schatten-Flotte — Fortschritt der Beweisaufnahme</label>
        <div id="tnFleet" class="fl-tbl"><div class="hint">Die Flotte startet mit dem nächsten Scan.</div></div>
        <label class="lbl" style="margin-top:10px">Aus allen Konten gelernt ${iBtn('kollektiv')}</label>
        <div id="tnGlobal" class="fl-tbl"><div class="hint">Noch zu wenige Konten für Kollektivwissen.</div></div>
        <label class="lbl" style="margin-top:10px">Änderungs-Journal</label>
        <div id="tnLog" class="tn-log"><div class="hint">Noch keine Prüfung — der Tuner urteilt täglich nach US-Schluss.</div></div>
      </div></div>

    </div>
  </div>

  <div class="dmodal" id="orderModal">
    <div class="dmodal-bg" data-order-close></div>
    <div class="dsheet" style="width:min(420px,100%)">
      <span class="paper-badge">PAPER</span>
      <h3 id="otTitle">Order</h3>
      <div class="fld"><label class="lbl">Symbol</label>
        <input id="otSym" class="inp" autocomplete="off" spellcheck="false"></div>
      <div class="fld"><label class="lbl">Menge</label>
        <input id="otQty" class="inp" type="number" min="1" value="1"></div>
      <div id="otRisk" class="hint" style="margin-top:6px"></div>
      <div id="otAge" class="hint"></div>
      <p id="otErr" class="error" hidden></p>
      <div class="dbtns">
        <button class="dbtn pri" id="otSubmit">Bestätigen (Enter)</button>
        <button class="dbtn" data-order-close>Abbrechen (Esc)</button>
      </div>
    </div>
  </div>

  <div class="dmodal" id="detailModal">
    <div class="dmodal-bg" data-close="detail"></div>
    <div class="dsheet" id="detailSheet"></div>
  </div>

  <!-- Handels-Analyse als eigene Vollbild-Ansicht (Owner-Feedback 28.07.:
       „passt von der Größe nicht" in die 280-px-Spalte). Sechs Diagramme
       sind kein Seitenleisten-Widget: Man schaut sie selten an, dann aber
       gründlich — und dafür brauchen sie die ganze Breite, ohne dem
       Live-Chart Platz wegzunehmen. -->
  <div class="dmodal" id="anModal">
    <div class="dmodal-bg" data-close="analytics"></div>
    <div class="dsheet dsheet-wide">
      <button class="dclose" data-close="analytics">✕</button>
      <h3>Handels-Analyse <span id="anScope" class="an-scope"></span></h3>
      <div id="anBody"><div class="hint">Noch keine geschlossenen Trades.</div></div>
    </div>
  </div>

  <div class="dmodal" id="optModal">
    <div class="dmodal-bg" data-close="options"></div>
    <div class="dsheet" style="width:min(560px,100%)">
      <button class="dclose" data-close="options">✕</button>
      <h3>Optionen</h3>
      <div class="wl-sec">Optionale Elemente</div>
      <label class="opt-row"><input type="checkbox" id="ouPred" />
        <span><b>Prognose-Pfeil</b> — eigene Kurs-Erwartung im Chart einzeichnen;
        zählt als gewichtete Stimme im Auto-Trading. <i>Beta, standardmäßig aus.</i></span></label>
      <label class="opt-row"><input type="checkbox" id="ouCmp" />
        <span><b>Vergleichs-Overlay</b> — zweites Symbol als %-Linie im Haupt-Chart.</span></label>
      <label class="opt-row"><input type="checkbox" id="ouGrid" />
        <span><b>Multi-Chart-Raster</b> — 1/2/4 Charts parallel mit Lock-Sync.</span></label>
      <label class="opt-row"><input type="checkbox" id="ouSub" />
        <span><b>Indikator-Extras</b> — VWAP (Intraday) und RSI/MACD-Unterpanels
        unter dem Haupt-Chart.</span></label>
      <div class="wl-sec">Module</div>
      <div id="ouPanels" class="opt-panels"></div>
      <p class="hint">Abgewählte Module verschwinden komplett (geht auch per ✕ direkt am Modul);
        ▾ am Modul klappt nur zu. Die Auswahl synct über deine Geräte.</p>
      <div class="wl-sec">Marktgruppen</div>
      <div id="ouGroups" class="opt-panels"></div>
      <p class="hint">Abgewählte Gruppen verschwinden aus Markt-Browser und Watchlist-Picker
        (nur Anzeige — die Daten aller Gruppen laufen serverseitig weiter).</p>
      <div class="wl-sec">Paper-Wallet · Grundeinstellungen</div>
      <div class="opt-grid">
        <label>Startkapital $
          <input id="owCap" class="inp st-num" type="number" min="100" step="500" /></label>
        <label>Investment je Trade %
          <input id="owMax" class="inp st-num" type="number" min="1" max="100" step="1" /></label>
        <label>Risiko je Trade % ${iBtn('riskPerTrade')}
          <input id="owRisk" class="inp st-num" type="number" min="0" max="5" step="0.25" /></label>
        <label>Max. gleichzeitige Positionen ${iBtn('maxOpenPositions')}
          <input id="owMaxPos" class="inp st-num" type="number" min="1" max="${MAX_OPEN_POSITIONS_CAP}" step="1" /></label>
        <label>Sizing-Basis ${iBtn('sizingBase')}
          <select id="owSizing" class="inp st-num">
            <option value="balance">Verfügbarer Cash</option>
            <option value="initial">Startkapital (fix)</option>
          </select></label>
        <label>Hebel (Margin) ${iBtn('leverage')}
          <select id="owLev" class="inp st-num">
            <option value="1">1× — kein Hebel (Standard)</option>
            <option value="2">2× — nur bei sehr starkem Signal</option>
            <option value="3">3× — Maximum</option>
          </select></label>
        <label>Stop-Loss % ${iBtn('stopLoss')}
          <input id="owSl" class="inp st-num" type="number" min="0" step="0.5" /></label>
        <label>Take-Profit % ${iBtn('takeProfit')}
          <input id="owTp" class="inp st-num" type="number" min="0" step="0.5" /></label>
        <label>Nachziehender Stop % ${iBtn('trailingStop')}
          <input id="owTrail" class="inp st-num" type="number" min="0" step="0.5" /></label>
        <label>Max. Haltedauer (Tage) ${iBtn('maxHold')}
          <input id="owHold" class="inp st-num" type="number" min="0" step="1" /></label>
        <label>ATR-Stop (×ATR) ${iBtn('atrStop')}
          <input id="owAtrS" class="inp st-num" type="number" min="0" step="0.5" /></label>
        <label>ATR-Ziel (×ATR) ${iBtn('atrTake')}
          <input id="owAtrT" class="inp st-num" type="number" min="0" step="0.5" /></label>
        <label>Handels-Modus ${iBtn('engineMode')}
          <select id="owMode" class="inp st-num">
            <option value="confluence">Konfluenz (5-Min-Signale)</option>
            <option value="momentum">Momentum (wöchentlich)</option>
          </select></label>
        <label>Signal-Zeitrahmen ${iBtn('signalTimeframe')}
          <select id="owTf" class="inp st-num">
            <option value="intraday">5-Minuten (aktiv)</option>
            <option value="daily">Tageskerzen (ruhig)</option>
          </select></label>
        <label>Kauf-Pause nach Verkauf (Min) ${iBtn('cooldownMin')}
          <input id="owCd" class="inp st-num" type="number" min="5" max="1440" step="5" /></label>
        <label>Konfluenz Einstieg ${iBtn('minConfluence')}
          <input id="owMinC" class="inp st-num" type="number" min="1" max="6" step="1" /></label>
        <label>Konfluenz Ausstieg ${iBtn('exitConfluence')}
          <input id="owExitC" class="inp st-num" type="number" min="1" max="6" step="1" /></label>
        <label>Kostenschwelle (× Gebühren) ${iBtn('minEdgeMultiple')}
          <input id="owEdge" class="inp st-num" type="number" min="0" max="10" step="0.5" /></label>
        <label class="opt-row" style="align-items:center">
          <input type="checkbox" id="owFcSolo" />
          <span>Prognose darf allein entscheiden ${iBtn('forecastSolo')}</span></label>
        <label class="opt-row" style="align-items:center">
          <input type="checkbox" id="owShort" />
          <span>Shorten erlauben (Leerverkäufe) ${iBtn('allowShort')}</span></label>
        <label class="opt-row" style="align-items:center">
          <input type="checkbox" id="owNewsVeto" />
          <span>News-Veto (Einstiege bei harten Events aussetzen) ${iBtn('newsVeto')}</span></label>
      </div>
      <p class="hint">0 schaltet eine Regel ab. Der nachziehende Stop sichert
        Gewinne, sobald die Position im Plus war; ATR-Werte ersetzen die festen
        Prozente und passen sich der Schwankungsbreite des Instruments an.
        Der Ausstieg braucht bewusst weniger Stimmen als der Einstieg —
        ein verpasster Verkauf kostet Geld, ein verpasster Kauf nur eine Chance.
        Startkapital greift beim Anlegen/Zurücksetzen des Wallets; Regel-Strategien
        deckeln die Positionsgröße serverseitig bei 25 %.
        Sizing-Basis „Verfügbarer Cash" lässt das ganze Wallet arbeiten —
        jeder Kauf nimmt seinen Prozentsatz vom aktuellen Cash, statt an einer
        fixen Startkapital-Tranche zu scheitern.</p>
      <p class="hint" id="owClassHint" style="margin-top:4px"></p>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-g" id="owSave">Speichern</button>
        <span class="hint" id="optMsg"></span>
      </div>
      <div class="wl-sec" style="margin-top:14px">Einstellungen prüfen ${iBtn('adviseSettings')}</div>
      <div class="row">
        <button class="btn btn-n" id="owCheck">Jetzt prüfen</button>
        <button class="btn btn-g" id="owApply" hidden>Ausgewählte übernehmen</button>
      </div>
      <div id="owAdvice"></div>
      <div class="hint" id="advMsg"></div>
      <div class="wl-sec" style="margin-top:14px">Konto</div>
      <div class="row" style="align-items:center;gap:10px">
        <span class="hint" style="flex:1">Angemeldet als <b>${email.replace(/[<>&]/g, '')}</b></span>
        <button class="btn btn-n" id="logoutBtn">Abmelden</button>
      </div>
      <div class="wl-sec" style="margin-top:14px">Neu anfangen ${iBtn('resetWallet')}</div>
      <p class="hint">Setzt <b>Handelshistorie, offene Positionen, Kontostand und
        Kennzahlen</b> auf null zurück. Kursdaten, Prognose-Trefferquoten und deine
        Strategien bleiben. Nicht rückgängig zu machen.</p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <input id="rsWord" class="inp st-num" style="flex:1;max-width:180px"
          type="text" autocomplete="off" spellcheck="false" placeholder="RESET tippen" />
        <button class="btn btn-r" id="rsGo" disabled>Konto zurücksetzen</button>
      </div>
      <div class="hint" id="rsMsg"></div>
    </div>
  </div>

`;
}

/** Muss identisch zu RESET_CONFIRM_WORD im Server sein — der prüft es erneut. */
const RESET_CONFIRM_WORD = 'RESET';

/* ── Subscriptions ──────────────────────────────────────────────────── */

function clearSubs(list: Unsubscribe[]): void {
  for (const u of list) u();
  list.length = 0;
}

/**
 * Chart-Kontext (Link-Gruppe `chartGroup`): Kursheader, Bars, Prognose,
 * Event-Marker + Indikator-Kacheln — alles, was das Chart-Symbol beschreibt.
 */
function wireChartCtx(): void {
  if (!st) return;
  clearSubs(st.symbolSubs);
  const sym = st.currentSymbol;
  $('chSym').textContent = sym;
  $('chSub').textContent = resolveName(sym);
  $('flSym').textContent = sym;
  $('flSym2').textContent = sym;
  // Nachgeladene Historie ist symbol-spezifisch → beim Wechsel zurücksetzen
  st.histBars = [];
  st.histOldest = 0;
  st.histLoading = false;
  st.histDone = false;

  st.symbolSubs.push(
    watchMarketDoc(sym, (d) => {
      const q = d?.quote;
      if (st) st.lastQuote = q ? { price: q.price, updatedAt: q.updatedAt } : null;
      $('chPx').textContent = q ? fmtNum(q.price) : '--';
      const chg = $('chChg');
      chg.textContent = q ? fmtPct(q.changePct) : '--';
      chg.className = `chart-px ${q ? pnlClass(q.changePct) : ''}`;
      if (st) {
        st.forecast = d?.forecast ?? null;
        st.forecastIntraday = d?.forecastIntraday ?? null;
        applyForecast();
      }
    }),
    watchBars(sym, (bars) => {
      if (!st) return;
      st.bars = bars;
      if (st.intradayDays > 0) void loadIntradayView();
      else renderChart();
    }),
    watchEvaluatedForecasts(sym, (rows) => renderFcLabRows(rows)),
    watchLatestIndicators(sym, (row) => renderIndicatorCards(row)),
    watchLatestSignal(sym, (sig) => {
      const el = $('vSig');
      if (st) {
        st.lastSignalDir = sig?.direction ?? 'hold';
        applyArea(); // Signal-Richtung färbt den Flächen-Verlauf sofort um
      }
      // Genauigkeitsgewichtetes Vote (Teil 4): Transparenz in der Karte
      const fv = sig?.forecastVote;
      $('fcVoteInfo').textContent = fv
        ? fv.factor === null
          ? `Prognose-Stimme: ${fv.weight}× (konfiguriert — Kante noch ohne Evidenz)`
          : `Prognose-Stimme: ${fv.weight}× statt ${fv.base}× (realisierte Kante über Zufall: Faktor ${fv.factor})`
        : '';
      if (!sig) { el.textContent = '--'; el.className = 'sval c-t3'; return; }
      el.textContent = sig.direction.toUpperCase();
      el.className = `sval ${sig.direction === 'buy' ? 'c-gn' : sig.direction === 'sell' ? 'c-rd' : 'c-t3'}`;
    }),
  );
}

/** Link-Chips einfärben (Aurora-Farben je Gruppe). */
function paintChips(): void {
  if (!st) return;
  for (const [id, group] of [
    ['chipChart', st.chartGroup],
    ['chipChart2', st.chart2Group],
  ] as const) {
    const chip = $(id);
    chip.textContent = group;
    chip.style.background = GROUP_COLORS[group];
  }
}

function renderIndicatorCards(row: IndicatorRow | null): void {
  $('vRSI').textContent = row?.rsi != null ? row.rsi.toFixed(1) : '--';
  $('vMacd').textContent = row?.macd ? row.macd.line.toFixed(2) : '--';
  $('vBB').textContent = row?.bollinger ? row.bollinger.pctB.toFixed(0) : '--';
}

function renderChart(): void {
  if (!st?.chart) return;
  // Chart-Typ + Skala aus dem Geräte-Speicher anwenden — das Chart mountet
  // asynchron NACH dem Menü-Wiring (setChartType no-opt bei gleichem Typ).
  st.chart.setChartType(st.chartTypeSel);
  st.chart.setTypeCombine(st.typeCombine);
  st.chart.setPriceScaleMode(st.scaleMode);
  // Zeit-Domänen-Wechsel (ISO-Tage ↔ UNIX-Sekunden): das alte Prognose-
  // Overlay MUSS vor setBars raus — gemischte Zeittypen auf einer Achse
  // korrumpieren sonst den Fit (1W→1J-Regression, E2E 25.07.).
  const intradayView = st.intradayDays > 0;
  if (lastRenderIntraday !== intradayView) st.chart.setForecast(null);
  lastRenderIntraday = intradayView;
  const fit = st.chartFitPending;
  st.chartFitPending = false;
  if (st.intradayDays > 0) {
    // Auto-Auflösung: 5m-Basis ggf. zu 15m/1h-Kerzen bündeln (pure, shared)
    st.shownIntraday = aggregateBars(st.intradayBars, st.aggMinutes) as typeof st.shownIntraday;
    st.chart.setBars(st.shownIntraday, { fit, timeVisible: true });
    applyForecast(); // Kurzfrist-Prognose (nächste Stunde) im Intraday-Chart
    applyMarkers(); // News-Punkte am Tages-Start-Bar (Zeit-Domäne wechselt mit)
    applyOverlays();
    updateSubPanels();
    renderResBadge();
    renderOhlcHud(null);
    return;
  }
  const bars = dailySource();
  // Fit-Ziel deterministisch bestimmen (kein fitContent-Race):
  // Auto-Modus → Startfenster ~120 Tage (alles Ältere per Scrollen erreichbar);
  // aktiver Prognose-Pfeil → rechts Platz einkalkulieren (Feedback 25.07.).
  const arrowActive = st.ui.predArrow && st.prediction !== null && !st.cleanView;
  // Pfeil-Polster HORIZONT-basiert (UI-Audit 25.07.): Handelstage bis zum
  // Prognoseziel + kleine Marge. Nie proportional zur Datenlänge — mit der
  // 5-Jahres-Historie polsterte `len*0.25` sonst hunderte Leertage rechts.
  const lastDate = bars[bars.length - 1]?.date ?? '';
  const arrowPad = arrowActive
    ? Math.min(
        30,
        Math.max(16, Math.ceil(((Date.parse(st.prediction!.targetDate) - Date.parse(lastDate)) / 86_400_000) * (5 / 7)) + 4),
      )
    : 0;
  const fitTo = !fit
    ? undefined
    : st.autoRes && bars.length > 130
      ? { from: bars.length - 120, to: bars.length + (arrowActive ? arrowPad : 3) }
      : arrowActive
        ? { from: -0.5, to: bars.length + arrowPad }
        : undefined;
  st.chart.setBars(bars, { fit, fitTo, timeVisible: false });
  applyForecast();
  applyMarkers(); // Zeit-Domäne der News-Punkte folgt der Sicht (26.07.)
  applyOverlays();
  drawPredictionArrow();
  updateSubPanels();
  renderResBadge();
  renderOhlcHud(null); // HUD auf den letzten Bar (bis das Crosshair übernimmt)
}

/** Tages-Quelle für Chart/Overlays/Panels: nachgeladene Historie + Live-Bars.
 *  Im Auto-Modus IMMER alles (das Fenster steuert der Zoom) — manuelle
 *  Stufen behalten ihre Slices (1M/3M). */
function dailySource(): ChartBar[] {
  if (!st) return [];
  const all = st.histBars.length > 0 ? [...st.histBars, ...st.bars] : st.bars;
  return st.autoRes ? all : st.range > 0 ? all.slice(-st.range) : all;
}

/** Ältere Jahres-Chunks nahtlos vorn anfügen (Links-Scroll ans Datenende). */
async function loadOlderDaily(): Promise<void> {
  if (!st || st.histLoading || st.histDone || st.intradayDays > 0 || st.bars.length === 0) return;
  st.histLoading = true;
  $('histHint').hidden = false;
  try {
    const sym = st.currentSymbol;
    const first = (st.histBars[0] ?? st.bars[0])!;
    const year = st.histOldest > 0 ? st.histOldest - 1 : Number(first.date.slice(0, 4));
    if (year < new Date().getFullYear() - 5) {
      st.histDone = true;
      return;
    }
    const chunk = await loadDailyChunk(sym, year);
    if (!st || st.currentSymbol !== sym) return;
    st.histOldest = year;
    const prepend = chunk.filter((b) => b.date < first.date);
    if (prepend.length === 0) {
      if (chunk.length === 0) st.histDone = true; // Chunk (noch) nicht backgefüllt
      return;
    }
    const r = st.chart?.getVisibleRange();
    st.histBars = [...prepend, ...st.histBars];
    renderChart(); // ohne Fit — und die Position exakt halten:
    if (r && st.chart) {
      st.chart.setVisibleRange({ from: r.from + prepend.length, to: r.to + prepend.length });
    }
  } catch {
    /* nächster Scroll-Versuch */
  } finally {
    if (st) st.histLoading = false;
    $('histHint').hidden = true;
  }
}

/** Badge neben den Zeitrahmen: aktive Kerzen-Auflösung (+ Auto-Hinweis). */
function renderResBadge(): void {
  if (!st) return;
  const label = st.intradayDays > 0 ? (st.aggMinutes >= 60 ? `${st.aggMinutes / 60}h` : `${st.aggMinutes}m`) : '1D';
  $('resBadge').textContent = st.autoRes ? `Auto · ${label}` : label;
}

/** SMA/EMA/BB-Linien für beliebige Bars — gilt für Haupt-Chart UND Grid-Panels
 *  (User-Feedback 25.07.: aktive Overlays auf allen Charts). */
function baseOverlayLines(
  times: Array<string | number>,
  closes: number[],
): import('./chart.js').OverlayLine[] {
  const lines: import('./chart.js').OverlayLine[] = [];
  if (!st) return lines;
  const pts = (series: (number | null)[]): Array<{ time: string | number; value: number }> =>
    series.flatMap((v, i) => (v === null ? [] : [{ time: times[i]!, value: v }]));
  const L = st.chartLayers;
  if (L.has('sma20')) lines.push({ key: 'sma20', color: '#ffb86b', points: pts(sma(closes, 20)) });
  if (L.has('sma50')) lines.push({ key: 'sma50', color: '#25d0ee', points: pts(sma(closes, 50)) });
  if (L.has('sma200')) lines.push({ key: 'sma200', color: '#b98aff', points: pts(sma(closes, 200)) });
  if (L.has('ema9')) lines.push({ key: 'ema9', color: '#40e0b4', points: pts(ema(closes, 9)) });
  if (L.has('ema21')) lines.push({ key: 'ema21', color: '#ff8290', points: pts(ema(closes, 21)) });
  if (L.has('bb')) {
    const b = bollinger(closes);
    lines.push(
      { key: 'bbU', color: 'rgba(37,208,238,.4)', width: 1, points: pts(b.upper) },
      { key: 'bbM', color: 'rgba(37,208,238,.6)', width: 1, points: pts(b.middle) },
      { key: 'bbL', color: 'rgba(37,208,238,.4)', width: 1, points: pts(b.lower) },
    );
  }
  return lines;
}

/** Indikator-/Vergleichs-Overlays aus den aktuell gezeigten Bars berechnen. */
function applyOverlays(): void {
  if (!st?.chart) return;
  const intraday = st.intradayDays > 0;
  const daily = intraday ? [] : dailySource();
  const times: Array<string | number> = intraday
    ? st.shownIntraday.map((b) => b.time)
    : daily.map((b) => b.date);
  const closes = intraday ? st.shownIntraday.map((b) => b.close) : daily.map((b) => b.close);
  const lines = st.cleanView ? [] : baseOverlayLines(times, closes);
  const pts = (series: (number | null)[]): Array<{ time: string | number; value: number }> =>
    series.flatMap((v, i) => (v === null ? [] : [{ time: times[i]!, value: v }]));
  // VWAP nur intraday (Session-Konzept) und nur mit aktivierten Indikator-Extras
  if (!st.cleanView && intraday && st.ui.subPanels && st.chartLayers.has('vwap')) {
    lines.push({ key: 'vwap', color: '#f2d16b', width: 2, points: pts(vwapSessions(st.shownIntraday)) });
  }
  // Vergleichs-Overlay (Tageskerzen): %-Entwicklung ab erstem gemeinsamen Tag
  if (!st.cleanView && !intraday && st.overlaySymbol && st.overlayBars.length > 1) {
    const firstDate = daily[0]?.date ?? '';
    const cmp = st.overlayBars.filter((b) => b.date >= firstDate);
    const base = cmp[0]?.close;
    if (base && base > 0) {
      lines.push({
        key: `cmp:${st.overlaySymbol}`,
        color: '#b98aff',
        width: 2,
        separateScale: true,
        points: cmp.map((b) => ({ time: b.date, value: ((b.close - base) / base) * 100 })),
      });
    }
  }
  st.chart.setOverlays(lines);
  renderLegend(lines, intraday);
  applyArea();
}

/** Signal-Farbtöne des Flächen-Verlaufs (Kauf grün, Verkauf rot, neutral blau). */
const AREA_TONES = {
  buy: { line: '#26cf9d', top: 'rgba(38,207,157,.35)', bottom: 'rgba(38,207,157,0)' },
  sell: { line: '#f2586b', top: 'rgba(242,88,107,.32)', bottom: 'rgba(242,88,107,0)' },
  hold: { line: '#25d0ee', top: 'rgba(37,208,238,.28)', bottom: 'rgba(37,208,238,0)' },
} as const;

/** Flächen-Verlauf (Vektor-Look) + Kerzen-Sichtbarkeit anwenden. */
function applyArea(): void {
  if (!st?.chart) return;
  const want = !st.cleanView && st.chartLayers.has('area');
  const { times, closes } = shownSeries();
  st.chart.setArea(
    want && closes.length > 0 ? closes.map((c, i) => ({ time: times[i]!, value: c })) : null,
    AREA_TONES[st.lastSignalDir],
  );
  // „Kerzen aus" nur sinnvoll, wenn eine Linie/Fläche den Kurs weiter zeigt
  const hide = !st.cleanView && st.chartLayers.has('hideCandles') && want;
  st.chart.setCandlesVisible(!hide);
}

/** OHLC-Bar fürs HUD (Crosshair-Daten oder letzter Bar einer Quelle). */
type HudBar = { time: string; open: number; high: number; low: number; close: number; volume: number | null };

/** Letzten Bar einer Quelle (daily ODER intraday) als HUD-Bar aufbereiten. */
function lastHudBar(
  src: Array<({ date: string } | { time: number }) & { open: number; high: number; low: number; close: number; volume?: number | null }>,
): HudBar | null {
  const last = src[src.length - 1];
  if (!last) return null;
  const time =
    'date' in last
      ? last.date
      : new Date(last.time * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return { time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? null };
}

/** Gemeinsames HUD-Format ALLER Fenster: Symbol · Zeit · O H L C (±%) · Vol. */
function hudHtml(sym: string, bar: HudBar): string {
  const up = bar.close >= bar.open;
  const pct = bar.open > 0 ? ((bar.close / bar.open - 1) * 100).toFixed(2) : '0.00';
  const vol =
    bar.volume === null || bar.volume === 0
      ? ''
      : ` · Vol ${bar.volume >= 1e6 ? `${(bar.volume / 1e6).toFixed(1)}M` : Math.round(bar.volume).toLocaleString('de-DE')}`;
  return `<span class="hud-fold">▾</span> <b>${sym}</b> <span class="c-t3">${bar.time}</span>
    <span class="${up ? 'c-gn' : 'c-rd'}">O ${fmtNum(bar.open)} H ${fmtNum(bar.high)} L ${fmtNum(bar.low)} C ${fmtNum(bar.close)} (${up ? '+' : ''}${pct} %)</span>${vol}`;
}

/** In-Chart-HUD (TV-Stil, UI-Audit 25.07.): Symbol · O H L C · Vol des Bars
 *  unterm Crosshair — ohne Crosshair der letzte Bar. Grün/rot nach C≥O.
 *  Seit 26.07. ein Accordion: Klick klappt die Zeile in ALLEN Fenstern. */
function renderOhlcHud(d: HudBar | null): void {
  if (!st) return;
  const el = $('ohlcRow');
  if (st.cleanView) {
    el.hidden = true;
    return;
  }
  if (!st.ohlcOpen) {
    el.innerHTML = '<span class="hud-fold">▸ OHLC</span>';
    el.hidden = false;
    return;
  }
  const bar = d ?? lastHudBar(st.intradayDays > 0 ? st.shownIntraday : dailySource());
  if (!bar) {
    el.hidden = true;
    return;
  }
  el.innerHTML = hudHtml(st.currentSymbol, bar);
  el.hidden = false;
}

/** OHLC-Kurszeile eines Raster-/Vergleichs-Fensters (Grid-Gleichwertigkeit
 *  26.07.: „alles soll gleichwertig sein") — gleiche Daten, gleicher
 *  Accordion-Zustand wie das Haupt-Fenster. */
function renderPanelHud(p: GridPanel, d: HudBar | null): void {
  const el = p.hudEl;
  if (!el) return;
  if (!st || st.cleanView) {
    el.hidden = true;
    return;
  }
  if (!st.ohlcOpen) {
    el.innerHTML = '<span class="hud-fold">▸ OHLC</span>';
    el.hidden = false;
    return;
  }
  const src = p.intradayDays > 0 ? p.intradayBars : p.range > 0 ? p.bars.slice(-p.range) : p.bars;
  const bar = d ?? lastHudBar(src);
  if (!bar) {
    el.hidden = true;
    return;
  }
  el.innerHTML = hudHtml(p.sym, bar);
  el.hidden = false;
}

/** EIN Klick, ALLE Fenster: Accordion-Zustand der Kurszeile umschalten. */
function toggleOhlcAll(): void {
  if (!st) return;
  st.ohlcOpen = !st.ohlcOpen;
  localStorage.setItem('autotrd-ohlc', st.ohlcOpen ? '1' : '0');
  renderOhlcHud(null);
  for (const p of st.gridPanels) renderPanelHud(p, null);
  renderPanelHud(st.chart2P, null);
}

/** Legende: beschriftet jede aktive Linie mit Farbe (gilt für alle Charts). */
function renderLegend(lines: import('./chart.js').OverlayLine[], intraday: boolean): void {
  const el = $('chartLegend');
  const NAME: Record<string, string> = {
    sma20: 'SMA 20',
    sma50: 'SMA 50',
    sma200: 'SMA 200',
    ema9: 'EMA 9',
    ema21: 'EMA 21',
    bbM: 'Bollinger 20 ±2σ',
    vwap: 'VWAP (Session)',
  };
  const items: Array<{ c: string; t: string; title: string }> = [];
  for (const l of lines) {
    if (l.key === 'bbU' || l.key === 'bbL') continue; // ein Eintrag fürs Band reicht
    if (l.key.startsWith('cmp:')) {
      items.push({ c: l.color, t: `${l.key.slice(4)} % (Vergleich)`, title: 'Prozent-Entwicklung auf eigener Skala' });
    } else if (NAME[l.key]) {
      items.push({ c: l.color, t: NAME[l.key]!, title: 'Gilt in allen Charts mit denselben Overlays' });
    }
  }
  if (st && !st.cleanView && st.chartLayers.has('area')) {
    const toneLabel = st.lastSignalDir === 'buy' ? 'Signal KAUF' : st.lastSignalDir === 'sell' ? 'Signal VERKAUF' : 'Signal neutral';
    items.push({
      c: AREA_TONES[st.lastSignalDir].line,
      t: `Fläche — ${toneLabel}`,
      title: 'Der Verlauf unter der Kurslinie färbt sich nach der aktuellen Signal-Richtung des Scans',
    });
  }
  if (st && !st.cleanView && !intraday && st.ui.predArrow && st.prediction) {
    const lastClose = st.bars[st.bars.length - 1]?.close ?? st.prediction.targetPrice;
    items.push({
      c: st.prediction.targetPrice >= lastClose ? '#26cf9d' : '#f2586b',
      t: 'Meine Prognose — zählt als Stimme im Auto-Trading',
      title: 'Deine manuell eingezeichnete Kurs-Erwartung; der Algorithmus nimmt sie als gewichtete Stimme (Gewicht = Vertrauen 1–3) in die Handels-Entscheidung auf',
    });
  }
  if (!intraday && st?.showForecast && !st.cleanView && st.forecast) {
    items.push({ c: '#25d0ee', t: 'Prognose (gestrichelt, ±1σ)', title: 'Sentiment-gewichtete Regression über die nächsten Handelstage' });
  }
  if (intraday && st?.showForecast && !st.cleanView && st.forecastIntraday) {
    items.push({ c: '#25d0ee', t: 'Kurzfrist-Prognose (nächste Stunde)', title: 'Projektion im 5-Minuten-Raster — bei jedem Scan neu berechnet, lernt aus der eigenen Trefferquote' });
  }
  // Legenden-Akkordeon (Feedback 25.07. abends): eingeklappt = nur OHLC-Zeile
  el.hidden = items.length === 0 || !st?.hudOpen;
  el.innerHTML = items
    .map((i) => `<span class="lg-item" title="${i.title}"><i class="lg-dot" style="background:${i.c}"></i>${i.t}</span>`)
    .join('');
}

/* ── Indikator-Unterpanels (Chart-Vision): RSI/MACD, Zeitachse synchron ── */

const subEpochs = { rsi: 0, macd: 0 };
// Länge der Anker-Zeitachse je Panel (E2E-Hook: Domänen-Parität mit Haupt-Chart)
const subAnchorLens = { rsi: -1, macd: -1 };

/** Zeiten + Schlusskurse der aktuell gezeigten Bars (Tages- oder Intraday-Sicht). */
function shownSeries(): { times: Array<string | number>; closes: number[] } {
  if (!st) return { times: [], closes: [] };
  if (st.intradayDays > 0) {
    return { times: st.shownIntraday.map((b) => b.time), closes: st.shownIntraday.map((b) => b.close) };
  }
  const bars = dailySource();
  return { times: bars.map((b) => b.date), closes: bars.map((b) => b.close) };
}

function renderSubPanel(kind: 'rsi' | 'macd'): void {
  const handle = st?.subCharts[kind];
  if (!st || !handle) return;
  const { times, closes } = shownSeries();
  const pts = (series: (number | null)[]): PanelLine['points'] =>
    series.flatMap((v, i) => (v === null ? [] : [{ time: times[i]!, value: v }]));
  // Zeitachsen-Anker (User-Screenshot 26.07.: „Datumleisten laufen auseinander"):
  // LWC baut die Zeitskala aus der VEREINIGUNG aller Serien-Zeitpunkte. Fehlen
  // dem Panel Zeitpunkte des Haupt-Charts (MACD-Anlauf-Nulls werden gefiltert,
  // Prognose-Whitespace rechts existiert nur im Haupt-Chart), zeigen gleiche
  // logische Indizes VERSCHIEDENE Daten. Die Hilfslinien laufen deshalb über
  // die komplette Haupt-Domäne inkl. der aktiven Prognose-Zukunftspunkte.
  const anchorTimes: Array<string | number> = [...times];
  const lastT = times[times.length - 1];
  if (st.showForecast && !st.cleanView && lastT !== undefined) {
    if (st.intradayDays > 0 && st.forecastIntraday) {
      for (const p of st.forecastIntraday.points) if (p.t > (lastT as number)) anchorTimes.push(p.t);
    } else if (st.intradayDays === 0 && st.forecast) {
      for (const p of st.forecast.points) if (p.time > (lastT as string)) anchorTimes.push(p.time);
    }
  }
  subAnchorLens[kind] = anchorTimes.length; // E2E-Hook (Domänen-Parität)
  if (kind === 'rsi') {
    handle.setSeries([
      { key: 'g70', color: 'rgba(242,88,107,.35)', width: 1, dashed: true, points: anchorTimes.map((t) => ({ time: t, value: 70 })) },
      { key: 'g30', color: 'rgba(38,207,157,.35)', width: 1, dashed: true, points: anchorTimes.map((t) => ({ time: t, value: 30 })) },
      { key: 'rsi', color: '#25d0ee', width: 2, points: pts(wilderRsi(closes, 14)) },
    ]);
  } else {
    const m = macd(closes);
    handle.setSeries([
      // Null-Linie = Zeitachsen-Anker + fachlicher Standard im MACD
      { key: 'g0', color: 'rgba(139,147,168,.3)', width: 1, dashed: true, points: anchorTimes.map((t) => ({ time: t, value: 0 })) },
      {
        key: 'hist',
        color: 'rgba(139,147,168,.4)',
        type: 'histogram',
        points: m.histogram.flatMap((v, i) =>
          v === null
            ? []
            : [{ time: times[i]!, value: v, color: v >= 0 ? 'rgba(38,207,157,.45)' : 'rgba(242,88,107,.45)' }],
        ),
      },
      { key: 'line', color: '#25d0ee', width: 2, points: pts(m.line) },
      { key: 'signal', color: '#ffb86b', width: 1, points: pts(m.signal) },
    ]);
  }
  // Zeitachse ans Haupt-Chart anlegen (pushRange markiert das als Echo)
  const r = st.chart?.getVisibleRange();
  if (r) pushRange(handle, r);
}

async function mountSubPanel(kind: 'rsi' | 'macd'): Promise<void> {
  const epoch = ++subEpochs[kind];
  const handle = await buildIndicatorPanel($(`${kind}Panel`), kind === 'rsi' ? 'RSI 14' : 'MACD 12/26/9');
  if (!st || epoch !== subEpochs[kind] || !handle) {
    handle?.destroy();
    return;
  }
  st.subCharts[kind] = handle;
  // Mini-Legende ins Panel (Beschriftungs-Wunsch 25.07.)
  const lg = document.createElement('div');
  lg.className = 'sub-legend';
  lg.innerHTML =
    kind === 'rsi'
      ? '<span><i class="lg-dot" style="background:#25d0ee"></i>RSI 14</span>' +
        '<span><i class="lg-dot" style="background:rgba(242,88,107,.6)"></i>70 überkauft</span>' +
        '<span><i class="lg-dot" style="background:rgba(38,207,157,.6)"></i>30 überverkauft</span>'
      : '<span><i class="lg-dot" style="background:#25d0ee"></i>MACD</span>' +
        '<span><i class="lg-dot" style="background:#ffb86b"></i>Signal</span>' +
        '<span><i class="lg-dot" style="background:#8b93a8"></i>Histogramm</span>';
  $(`${kind}Panel`).appendChild(lg);
  armGestureTracking($(`${kind}Panel`));
  handle.onVisibleRangeChange((range) => {
    // Unterpanels sind Blätter im Sync-Graph: Echos enden hier. Und ohne
    // frische User-Geste (Daten-Refit!) wird nichts zurückgereicht.
    if (!range || !st || matchEcho(handle, range)) return;
    if (!recentGesture($(`${kind}Panel`))) return;
    pushRange(st.chart, range, handle);
    pushRange(kind === 'rsi' ? st.subCharts.macd : st.subCharts.rsi, range, handle);
  });
  renderSubPanel(kind);
}

/** Panels an Layer-Chips + ⚙-Option angleichen (mount/unmount + Daten). */
function updateSubPanels(): void {
  if (!st) return;
  for (const kind of ['rsi', 'macd'] as const) {
    const want = st.ui.subPanels && !st.cleanView && st.chartLayers.has(`${kind}Panel`);
    const el = $(`${kind}Panel`);
    el.hidden = !want;
    if (!want) {
      subEpochs[kind]++;
      st.subCharts[kind]?.destroy();
      st.subCharts[kind] = null;
      el.innerHTML = '';
      continue;
    }
    if (st.subCharts[kind]) renderSubPanel(kind);
    else void mountSubPanel(kind);
  }
}

/** Prognose-Pfeil im TradingView-Stil (User-Referenz 25.07.): fetter,
 *  gefüllter Vektor-Pfeil — grün = Ziel über Kurs, rot = darunter; Dicke
 *  wächst mit dem Vertrauen, Label als Pille an der Spitze. */
function drawPredictionArrow(): void {
  const svg = document.getElementById('predSvg');
  if (!svg || !st) return;
  svg.innerHTML = '';
  const pred = st.prediction;
  const active =
    st.ui.predArrow && !st.cleanView && pred !== null && st.chart !== null && st.intradayDays === 0 && st.bars.length > 0;
  if (!active || !pred || !st.chart) return;
  const last = st.bars[st.bars.length - 1]!;
  const start = st.chart.coords(last.date, last.close);
  const yEnd = st.chart.coords(last.date, pred.targetPrice).y;
  if (start.x === null || start.y === null || yEnd === null) return;
  const box = svg.getBoundingClientRect();
  const up = pred.targetPrice >= last.close;
  const color = up ? '#26cf9d' : '#f2586b';
  const p0 = { x: start.x, y: start.y };
  const p2 = { x: Math.min(box.width - 28, start.x + Math.max(90, box.width * 0.16)), y: yEnd };
  const p1 = { x: (p0.x + p2.x) / 2, y: p0.y }; // erst flach anlaufen, dann zum Ziel
  const q = (t: number): { x: number; y: number } => ({
    x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t ** 2 * p2.x,
    y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t ** 2 * p2.y,
  });
  const dq = (t: number): { x: number; y: number } => ({
    x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
  });
  // Schaft als Band entlang der Kurve (schmal am Start, breiter zur Spitze)
  const wStart = 1.5 + pred.confidence * 1.2;
  const wEnd = wStart * 2.2;
  const headLen = 12 + pred.confidence * 4;
  const approxLen = Math.hypot(p2.x - p0.x, p2.y - p0.y) * 1.05;
  const tHead = Math.max(0.5, 1 - headLen / approxLen);
  const N = 14;
  const leftPts: string[] = [];
  const rightPts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * tHead;
    const c = q(t);
    const d = dq(t);
    const len = Math.hypot(d.x, d.y) || 1;
    const nx = -d.y / len;
    const ny = d.x / len;
    const w = wStart + (wEnd - wStart) * (i / N);
    leftPts.push(`${(c.x + nx * w).toFixed(1)},${(c.y + ny * w).toFixed(1)}`);
    rightPts.unshift(`${(c.x - nx * w).toFixed(1)},${(c.y - ny * w).toFixed(1)}`);
  }
  // Pfeilspitze: Dreieck tangential zur Kurve, deutlich breiter als der Schaft
  const base = q(tHead);
  const dHead = dq(tHead);
  const hl = Math.hypot(dHead.x, dHead.y) || 1;
  const ux = dHead.x / hl;
  const uy = dHead.y / hl;
  const hx = -uy;
  const hy = ux;
  const hw = wEnd * 2.4;
  const tip = { x: base.x + ux * headLen, y: base.y + uy * headLen };
  const head =
    `${(base.x + hx * hw).toFixed(1)},${(base.y + hy * hw).toFixed(1)} ` +
    `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ` +
    `${(base.x - hx * hw).toFixed(1)},${(base.y - hy * hw).toFixed(1)}`;
  // Label-Pille an der Spitze: markiert den Pfeil klar als MANUELLE
  // User-Prognose (Wunsch 25.07.), Details in Zeile 2 + Erklärung in Legende
  const title = 'Meine Prognose';
  const label = `${pred.targetPrice.toFixed(2)} · ${pred.targetDate.slice(5)}`;
  const pillW = Math.max(title.length, label.length) * 6.6 + 18;
  const pillX = Math.max(4, Math.min(box.width - pillW - 4, tip.x - pillW / 2));
  const pillY = up ? Math.max(4, tip.y - 48) : Math.min(box.height - 38, tip.y + 12);
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = `
    <path d="M${leftPts.join(' L')} L${rightPts.join(' L')} Z" fill="${color}" opacity="0.88" />
    <path d="M${head} Z" fill="${color}" opacity="0.95" />
    <g class="pred-pill">
      <rect x="${pillX}" y="${pillY}" width="${pillW}" height="34" rx="10"
        fill="var(--card-solid, #0e1420)" stroke="${color}" stroke-width="1.2" opacity="0.95" />
      <text x="${pillX + pillW / 2}" y="${pillY + 13}" text-anchor="middle" class="pred-label pred-label-t">${title}</text>
      <text x="${pillX + pillW / 2}" y="${pillY + 27}" text-anchor="middle"
        class="pred-label" style="fill:${color}">${label}</text>
    </g>`;
}

function openPredPop(price: number): void {
  if (!st) return;
  const pop = $('predPop');
  ($('ppPrice') as HTMLInputElement).value = price.toFixed(2);
  ($('ppDate') as HTMLInputElement).value =
    st.prediction?.targetDate ?? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  $('ppConfV').textContent = String(st.prediction?.confidence ?? 2);
  ($('ppDel') as HTMLButtonElement).hidden = !st.prediction;
  pop.hidden = false;
}

async function loadPredictionForSymbol(): Promise<void> {
  if (!st) return;
  const sym = st.currentSymbol;
  const pred = await loadPrediction(st.uid, sym).catch(() => null);
  if (!st || st.currentSymbol !== sym) return;
  st.prediction = pred;
  // Aktiver Pfeil braucht sein Horizont-Polster rechts → Neu-Fit anfordern
  // (renderChart zeichnet Pfeil + Legende dann selbst mit).
  if (st.ui.predArrow && pred && !st.cleanView && st.intradayDays === 0) {
    st.chartFitPending = true;
    renderChart();
    return;
  }
  drawPredictionArrow();
  applyOverlays(); // Legende um den „Meine Prognose"-Eintrag aktualisieren
}

/* ── Options-Modal (⚙, Feedback 25.07.): Elemente + Paper-Wallet-Basics ── */

/** Sichtbarkeit der optionalen Elemente anwenden (settings.ui). */
function applyUiPrefs(): void {
  if (!st) return;
  const u = st.ui;
  ($('predBtn') as HTMLButtonElement).hidden = !u.predArrow;
  if (!u.predArrow) {
    st.predMode = false;
    $('predBtn').classList.remove('on');
    $('predPop').hidden = true;
  }
  drawPredictionArrow();
  ($('cmpSym') as HTMLInputElement).hidden = !u.cmpOverlay;
  if (!u.cmpOverlay && st.overlaySymbol) {
    st.overlaySymbol = null;
    ($('cmpSym') as HTMLInputElement).value = '';
    applyOverlays();
  }
  const sw = document.querySelector('.grid-sw') as HTMLElement | null;
  if (sw) sw.hidden = !u.chartGrid;
  if (!u.chartGrid && st.gridMode !== 1) {
    st.gridMode = 1;
    renderChartGrid();
  }
  if (!u.chartGrid) ($('lockMain') as HTMLButtonElement).hidden = true;
  // Indikator-Extras (VWAP-Chip + RSI/MACD-Unterpanels)
  document.querySelectorAll('.ind-x').forEach((el) => ((el as HTMLElement).hidden = !u.subPanels));
  applyOverlays();
  updateSubPanels();
  applyGroupFilter(); // Marktgruppen (synct über Geräte wie die Module)
}

/**
 * Die Optionen-Maske als Strategie-Objekt.
 *
 * Eigene Funktion, weil sie ZWEI Aufrufer hat: Speichern und Prüfen. Der
 * Prüfer muss den Stand im FORMULAR sehen, nicht den gespeicherten — sonst
 * meldet er nichts, wenn man den Hebel gerade hochgestellt und noch nicht
 * gespeichert hat, und das ist der Moment, in dem man ihn braucht.
 */
function optionsFormStrategy(): Strategy {
  const basis = st?.strategy ?? DEFAULT_STRATEGY;
  const num = (id: string): number => Number(($(id) as HTMLInputElement).value);
  return {
    ...basis,
    broker: {
      ...basis.broker,
      initialCapital: num('owCap'),
      sizingBase: ($('owSizing') as HTMLSelectElement).value === 'initial' ? 'initial' : 'balance',
      leverage: Math.min(MAX_LEVERAGE, Math.max(1, num('owLev') || 1)),
    },
    engine: {
      ...basis.engine,
      maxPositionPct: num('owMax'),
      mode: ($('owMode') as HTMLSelectElement).value === 'momentum' ? 'momentum' : 'confluence',
      riskPerTradePct: Math.min(MAX_RISK_PER_TRADE_PCT, Math.max(0, num('owRisk'))),
      maxOpenPositions: Math.min(
        MAX_OPEN_POSITIONS_CAP,
        Math.max(1, num('owMaxPos') || DEFAULT_MAX_OPEN_POSITIONS)),
      stopLossPct: num('owSl'),
      takeProfitPct: num('owTp'),
      trailingStopPct: num('owTrail'),
      maxHoldDays: num('owHold'),
      atrStopMult: num('owAtrS'),
      atrTakeMult: num('owAtrT'),
      cooldownMin: Math.min(1440, Math.max(5, num('owCd') || 15)),
    },
    signals: {
      ...basis.signals,
      minConfluence: Math.max(1, num('owMinC')),
      exitConfluence: Math.max(1, num('owExitC')),
      minEdgeMultiple: Math.min(10, Math.max(0, num('owEdge'))),
      forecastSolo: ($('owFcSolo') as HTMLInputElement).checked,
      timeframe: ($('owTf') as HTMLSelectElement).value === 'daily' ? 'daily' : 'intraday',
      allowShort: ($('owShort') as HTMLInputElement).checked,
      newsVeto: ($('owNewsVeto') as HTMLInputElement).checked,
    },
  };
}

/**
 * Prüf-Ergebnis rendern.
 *
 * Nichts wird automatisch geändert: Erst anzeigen, dann ankreuzen, dann
 * übernehmen. Ein Knopf, der Einstellungen still umschreibt, nimmt genau die
 * Entscheidung ab, die dem User gehört — und der GRUND steht bei jedem
 * Vorschlag, damit man beim nächsten Mal selbst darauf kommt.
 */
function renderAdvice(): void {
  const box = $('owAdvice');
  const vorschlaege = adviseStrategy(optionsFormStrategy());
  ($('owApply') as HTMLButtonElement).hidden = vorschlaege.length === 0;
  if (vorschlaege.length === 0) {
    // Bewusst nicht „optimal": Der Prüfer kennt keine Rendite, nur
    // Widersprüche. Diese Unterscheidung darf die Oberfläche nicht verwischen.
    box.innerHTML =
      '<p class="hint">✓ Keine widersprüchlichen Einstellungen gefunden. Das heißt nicht ' +
      '„optimal" — der Prüfer kennt keine Rendite, nur Kombinationen, die gegeneinander ' +
      'arbeiten. Was sich rechnet, misst der tägliche Selbstoptimierer.</p>';
    return;
  }
  const farbe: Record<string, string> = {
    kritisch: 'var(--rd)',
    wichtig: 'var(--yl, #d9a441)',
    hinweis: 'var(--c-t3, #8b93a7)',
  };
  box.innerHTML = vorschlaege
    .map(
      (v) => `<label class="opt-row" style="align-items:flex-start;margin-top:10px">
        <input type="checkbox" data-adv="${v.key}" checked />
        <span><b style="color:${farbe[v.severity]}">${v.severity.toUpperCase()}</b> ·
        <b>${v.label}</b>: ${String(v.current)} → <b>${String(v.suggested)}</b><br />
        <span class="hint">${v.reason}</span></span></label>`,
    )
    .join('');
}

function openOptions(): void {
  if (!st) return;
  ($('ouPred') as HTMLInputElement).checked = st.ui.predArrow;
  ($('ouCmp') as HTMLInputElement).checked = st.ui.cmpOverlay;
  ($('ouGrid') as HTMLInputElement).checked = st.ui.chartGrid;
  ($('ouSub') as HTMLInputElement).checked = st.ui.subPanels;
  ($('owCap') as HTMLInputElement).value = String(st.strategy.broker.initialCapital);
  ($('owSizing') as HTMLSelectElement).value = st.strategy.broker.sizingBase ?? 'balance';
  ($('owMax') as HTMLInputElement).value = String(st.strategy.engine.maxPositionPct);
  ($('owRisk') as HTMLInputElement).value = String(
    st.strategy.engine.riskPerTradePct ?? DEFAULT_RISK_PER_TRADE_PCT);
  ($('owMaxPos') as HTMLInputElement).value = String(
    st.strategy.engine.maxOpenPositions ?? DEFAULT_MAX_OPEN_POSITIONS);
  ($('owLev') as HTMLSelectElement).value = String(
    Math.min(MAX_LEVERAGE, Math.max(1, Math.round(st.strategy.broker.leverage ?? 1))));
  ($('owSl') as HTMLInputElement).value = String(st.strategy.engine.stopLossPct);
  ($('owTp') as HTMLInputElement).value = String(st.strategy.engine.takeProfitPct);
  ($('owTrail') as HTMLInputElement).value = String(st.strategy.engine.trailingStopPct ?? 0);
  ($('owHold') as HTMLInputElement).value = String(st.strategy.engine.maxHoldDays ?? 0);
  ($('owAtrS') as HTMLInputElement).value = String(st.strategy.engine.atrStopMult ?? 0);
  ($('owAtrT') as HTMLInputElement).value = String(st.strategy.engine.atrTakeMult ?? 0);
  ($('owMode') as HTMLSelectElement).value = st.strategy.engine.mode ?? 'confluence';
  ($('owTf') as HTMLSelectElement).value = st.strategy.signals.timeframe ?? 'intraday';
  ($('owCd') as HTMLInputElement).value = String(st.strategy.engine.cooldownMin ?? 15);
  ($('owMinC') as HTMLInputElement).value = String(st.strategy.signals.minConfluence);
  ($('owExitC') as HTMLInputElement).value = String(
    st.strategy.signals.exitConfluence ?? Math.max(1, st.strategy.signals.minConfluence - 1));
  ($('owEdge') as HTMLInputElement).value = String(
    st.strategy.signals.minEdgeMultiple ?? MIN_EDGE_MULTIPLE);
  ($('owFcSolo') as HTMLInputElement).checked = st.strategy.signals.forecastSolo === true;
  ($('owShort') as HTMLInputElement).checked = st.strategy.signals.allowShort === true;
  ($('owNewsVeto') as HTMLInputElement).checked = st.strategy.signals.newsVeto !== false; // fehlend = an
  // Klassen-Profile transparent machen: Sie überschreiben die Werte oben je
  // Asset-Klasse — der User soll wissen, was für sein Symbol tatsächlich gilt.
  const byCls = st.strategy.engine.byClass ?? {};
  const clsTxt = Object.entries(byCls)
    .map(([c, o]) => `${CLASS_LABELS[c] ?? c}: Stop ${o.stopLossPct ?? '–'} % / Ziel ${o.takeProfitPct ?? '–'} %`)
    .join(' · ');
  $('owClassHint').textContent = clsTxt
    ? `Abweichende Profile je Anlageklasse (überschreiben die Werte oben): ${clsTxt}`
    : '';
  // Module: Checkbox je Panel — gleiche Wahrheit wie ✕ am Modul und die Palette
  $('ouPanels').innerHTML = Object.entries(PANEL_TITLES)
    .map(
      ([id, title]) =>
        `<label class="opt-chk"><input type="checkbox" data-mod="${id}" ${st!.wsHidden.has(id) ? '' : 'checked'} /> ${title}</label>`,
    )
    .join('');
  $('ouPanels')
    .querySelectorAll<HTMLInputElement>('input[data-mod]')
    .forEach((cb) => cb.addEventListener('change', () => togglePanel(cb.dataset.mod ?? '')));
  // Marktgruppen-Filter (Taschenmesser Teil 2): reine Anzeige-Wahrheit in
  // settings.ui.marketGroups — fehlender Eintrag = sichtbar.
  $('ouGroups').innerHTML = Object.entries(CLASS_LABELS)
    .map(
      ([cls, label]) =>
        `<label class="opt-chk"><input type="checkbox" data-grp="${cls}" ${st!.ui.marketGroups?.[cls] === false ? '' : 'checked'} /> ${label}</label>`,
    )
    .join('');
  $('ouGroups')
    .querySelectorAll<HTMLInputElement>('input[data-grp]')
    .forEach((cb) =>
      cb.addEventListener('change', () => {
        if (!st) return;
        const groups = { ...(st.ui.marketGroups ?? {}) };
        if (cb.checked) delete groups[cb.dataset.grp ?? ''];
        else groups[cb.dataset.grp ?? ''] = false;
        st.ui = { ...st.ui, marketGroups: groups };
        applyGroupFilter();
        void saveUiPrefs(st.uid, st.ui);
      }),
    );
  $('optMsg').textContent = '';
  $('optModal').classList.add('show');
}

/** Marktgruppen-Filter anwenden: Markt-Browser-Tabs neu bauen (die Builder
 *  überspringen versteckte Klassen; der Picker filtert bei jedem Öffnen). */
function applyGroupFilter(): void {
  void renderMarketTabs();
}

/* ── Auto-Auflösung (TradingView-Gefühl, Feedback 25.07.): Die Kerzengröße
   folgt der sichtbaren Zeitspanne — daily ↔ 1h ↔ 15m ↔ 5m, client-seitig
   aggregiert; beim Wechsel bleibt das ZEITfenster erhalten (kein Neu-Fit). ── */

let autoResTimer: number | null = null;
let autoSwitching = false;

function barTimeMs(b: { time: number } | { date: string }): number {
  return 'time' in b ? b.time * 1000 : Date.parse(b.date);
}

function currentSource(): Array<{ time: number } | { date: string }> {
  if (!st) return [];
  return st.intradayDays > 0 ? st.shownIntraday : dailySource();
}

function maybeAutoSwitch(): void {
  if (!st?.autoRes || !st.chart || autoSwitching) return;
  const r = st.chart.getVisibleRange();
  const src = currentSource();
  if (!r || src.length < 2) return;
  let i0 = Math.max(0, Math.min(src.length - 1, Math.floor(r.from)));
  const i1 = Math.max(0, Math.min(src.length - 1, Math.ceil(r.to)));
  // Leerraum rechts (rightOffset/Pan): beide Indizes clampen sonst auf den
  // letzten Bar — dann zählt das kleinste echte Fenster (1 Bar zurück).
  if (i1 <= i0) i0 = Math.max(0, i1 - 1);
  if (i1 <= i0) return;
  const t0 = barTimeMs(src[i0]!);
  const t1 = barTimeMs(src[i1]!);
  const days = (t1 - t0) / 86_400_000;
  // Intraday deckt nur ~5 Handelstage ab — will der User ein deutlich
  // breiteres Fenster (viel Leerraum über die Quelle hinaus), zurück zu daily.
  const wantsWider = st.intradayDays > 0 && r.to - r.from > src.length + 6;
  const level = wantsWider ? 0 : days <= 1.6 ? 5 : days <= 3.5 ? 15 : days <= 8 ? 60 : 0;
  const current = st.intradayDays > 0 ? st.aggMinutes : 0;
  if (level === current) return;
  void switchAutoLevel(level, t0, t1, wantsWider);
}

async function switchAutoLevel(level: number, t0: number, t1: number, refit = false): Promise<void> {
  if (!st) return;
  autoSwitching = true;
  try {
    if (level > 0) {
      if (st.intradayBars.length === 0) {
        const sym = st.currentSymbol;
        const chunks = await loadIntraday(sym, 5);
        if (!st || st.currentSymbol !== sym) return;
        st.intradayBars = chunks;
      }
      if (st.intradayBars.length === 0) return; // keine Intraday-Daten → daily bleiben
      // Fenster außerhalb der ~5-Tage-Abdeckung? Dann bringt Intraday nichts.
      const cover0 = st.intradayBars[0]!.time * 1000;
      if (t0 < cover0 - 12 * 3_600_000) return;
      st.intradayDays = 5;
      st.aggMinutes = level;
    } else {
      st.intradayDays = 0;
    }
    // Beim „will-breiter"-Rücksprung auf daily frisch fitten — das schmale
    // Intraday-Zeitfenster wäre sonst als Mini-Ausschnitt verwirrend.
    if (refit) st.chartFitPending = true;
    renderChart(); // sonst bewusst OHNE Fit — der User-Zoom bestimmt das Fenster
    if (refit) return;
    // Zeitfenster in der neuen Quelle wiederfinden und exakt setzen
    const src = currentSource();
    if (src.length > 1 && st.chart) {
      let i0 = src.findIndex((b) => barTimeMs(b) >= t0);
      if (i0 < 0) i0 = 0;
      let i1 = src.length - 1;
      for (let i = src.length - 1; i >= 0; i--) {
        if (barTimeMs(src[i]!) <= t1) {
          i1 = i;
          break;
        }
      }
      if (i1 > i0) st.chart.setVisibleRange({ from: i0 - 0.5, to: i1 + 0.5 });
    }
  } finally {
    // setVisibleRange feuert selbst Range-Events — Wächter kurz entschärfen
    window.setTimeout(() => {
      autoSwitching = false;
    }, 400);
  }
}

function updateAutoUi(): void {
  if (!st) return;
  $('autoBtn').classList.toggle('on', st.autoRes);
  localStorage.setItem('autotrd-chart-auto', st.autoRes ? '1' : '0');
  renderResBadge();
  syncMainHdTf();
}

/** Raster-Kopf des Haupt-Fensters (Titelleisten-Parität, User-Screenshot
 *  26.07.): on-Klassen der Auto-/Zeitrahmen-Knöpfe an den Haupt-Zustand
 *  angleichen — Gegenstück zu syncPanelTfButtons für die Panels. */
function syncMainHdTf(): void {
  if (!st) return;
  document.querySelectorAll<HTMLElement>('#mainHd [data-mh-r], #mainHd [data-mh-i]').forEach((b) => {
    const on = b.dataset['mhI'] !== undefined
      ? Number(b.dataset['mhI']) === st!.intradayDays && st!.intradayDays > 0
      : st!.intradayDays === 0 && Number(b.dataset['mhR']) === st!.range;
    b.classList.toggle('on', on);
  });
  $('mhAuto').classList.toggle('on', st.autoRes);
}

/** OHLC-Zeile ans CHART koppeln, nicht an den Fenster-Rahmen: Im Raster
 *  schiebt die Kopfzeile das Chart nach unten — der ▸-OHLC-Chip überlappte
 *  sonst das Symbolfeld (User-Screenshot 26.07., „nicht homogen"). */
function positionMainHud(): void {
  $('chartHud').style.top = `${$('chartArea').offsetTop + 6}px`;
}

/* ── Auto-Zeitrahmen je Raster-/Vergleichs-Fenster (Grid-Gleichwertigkeit
   26.07.: „auto view für ALLE grid fenster"): abgespeckte Version des Haupt-
   Auto — zwei Stufen (Tageskerzen ↔ 5-min-Sicht), das ZEITfenster bleibt
   beim Wechsel erhalten. Debounced pro Panel; eigene Wechsel triggern sich
   über autoBusy nicht selbst. ── */

function schedulePanelAuto(p: GridPanel): void {
  if (!p.auto) return;
  if (p.autoTimer != null) window.clearTimeout(p.autoTimer);
  p.autoTimer = window.setTimeout(() => {
    p.autoTimer = null;
    // Wechsel läuft noch (autoBusy)? Wiedervorlage statt verwerfen — sonst
    // verschluckt das Busy-Fenster den direkt folgenden Gegen-Zoom und das
    // Panel bleibt dauerhaft in der falschen Sicht hängen (E2E-Fund 26.07.).
    if (p.autoBusy) {
      schedulePanelAuto(p);
      return;
    }
    void panelMaybeAutoSwitch(p);
  }, 350);
}

/** Quelle des Panels in Render-Reihenfolge (für Index→Zeit-Umrechnung). */
function panelSource(p: GridPanel): Array<{ time: number } | { date: string }> {
  return p.intradayDays > 0 ? p.intradayBars : p.range > 0 ? p.bars.slice(-p.range) : p.bars;
}

async function panelMaybeAutoSwitch(p: GridPanel): Promise<void> {
  if (!p.auto || !p.chart || p.autoBusy) return;
  const r = p.chart.getVisibleRange();
  const src = panelSource(p);
  if (!r || src.length < 2) return;
  let i0 = Math.max(0, Math.min(src.length - 1, Math.floor(r.from)));
  const i1 = Math.max(0, Math.min(src.length - 1, Math.ceil(r.to)));
  if (i1 <= i0) i0 = Math.max(0, i1 - 1);
  if (i1 <= i0) return;
  const t0 = barTimeMs(src[i0]!);
  const t1 = barTimeMs(src[i1]!);
  const days = (t1 - t0) / 86_400_000;
  const intraday = p.intradayDays > 0;
  // Will der User deutlich mehr sehen, als die ~5 Intraday-Tage hergeben?
  const wantsWider = intraday && r.to - r.from > src.length + 6;
  const wantIntraday = !wantsWider && days <= 8;
  if (wantIntraday === intraday) return;
  p.autoBusy = true;
  try {
    if (wantIntraday) {
      // Abdeckung prüfen — vorhandene Bars können aus einer 1T-Sicht stammen
      // und decken das Fenster dann nicht (E2E-Fund 26.07.): dann die vollen
      // ~5 Handelstage nachladen und erneut prüfen.
      const covers = (b: typeof p.intradayBars): boolean =>
        b.length > 0 && t0 >= b[0]!.time * 1000 - 12 * 3_600_000;
      if (!covers(p.intradayBars)) {
        const sym = p.sym;
        const chunks = await loadIntraday(sym, 5);
        if (p.sym !== sym || !p.auto) return;
        if (chunks.length > 0) p.intradayBars = chunks;
      }
      if (!covers(p.intradayBars)) return; // 5-min-Daten decken das Fenster nicht → daily bleiben
      p.intradayDays = 5;
    } else {
      p.intradayDays = 0;
      if (wantsWider) p.fitPending = true; // Rücksprung: frisch fitten (Mini-Ausschnitt wäre verwirrend)
    }
    renderGridPanelBars(p);
    // Zeitfenster in der neuen Quelle wiederfinden — der Zoom bestimmt die Sicht
    if (!wantsWider && p.chart) {
      const dst = panelSource(p);
      if (dst.length > 1) {
        let j0 = dst.findIndex((b) => barTimeMs(b) >= t0);
        if (j0 < 0) j0 = 0;
        let j1 = dst.length - 1;
        for (let i = dst.length - 1; i >= 0; i--) {
          if (barTimeMs(dst[i]!) <= t1) {
            j1 = i;
            break;
          }
        }
        if (j1 > j0) p.chart.setVisibleRange({ from: j0 - 0.5, to: j1 + 0.5 });
      }
    }
    saveGridPrefs();
    syncPanelTfButtons();
  } finally {
    // setVisibleRange feuert selbst Range-Events — Wächter kurz entschärfen
    window.setTimeout(() => {
      p.autoBusy = false;
    }, 400);
  }
}

/** 5m-Chunks laden und rendern (1T/1W) — Chart-Feedback 24.07. */
async function loadIntradayView(): Promise<void> {
  if (!st) return;
  const sym = st.currentSymbol;
  const chunks = await loadIntraday(sym, st.intradayDays);
  if (!st || st.currentSymbol !== sym || st.intradayDays === 0) return;
  st.intradayBars = chunks;
  renderChart();
}

/**
 * Marker auf dem Haupt-Chart.
 *
 * Seit dem Ausbau der News-Strecke (28.07.) gibt es keine Event-Punkte mehr;
 * die Funktion bleibt als EINE Stelle stehen, an der künftige Marker (etwa
 * die eigenen Ein- und Ausstiege) angehängt werden — verteiltes
 * setMarkers-Aufrufen war vorher schon die Quelle von Sync-Fehlern.
 */
function applyMarkers(): void {
  if (!st?.chart) return;
  const markers: ChartMarker[] = [];
  st.lastMainMarkers = markers.length; // E2E-Hook
  st.chart.setMarkers(markers);
}

/**
 * Prognose-Overlay + Badge anwenden — Tages-Prognose in der Tages-Ansicht,
 * Kurzfrist-Prognose (nächste Stunde, 5-min-Raster) in der Intraday-Ansicht.
 */
function applyForecast(): void {
  if (!st?.chart) return;
  const intraday = st.intradayDays > 0;
  const fc = st.forecast;
  const ifc = st.forecastIntraday;
  const info = $('fcInfo');
  if (!st.showForecast || st.cleanView) {
    st.chart.setForecast(null);
    info.textContent = (intraday ? ifc : fc) && !st.cleanView ? 'Prognose-Layer ausgeblendet.' : '';
    return;
  }
  if (intraday) {
    // Nur Punkte NACH dem letzten gezeigten Bar zeichnen (nach Session-Ende
    // wäre eine alte Projektion mitten im Chart irreführend).
    const lastBar = st.shownIntraday[st.shownIntraday.length - 1];
    const pts = ifc && lastBar ? ifc.points.filter((p) => p.t > lastBar.time) : [];
    if (!ifc || !lastBar || pts.length === 0) {
      st.chart.setForecast(null);
      info.textContent = '';
      return;
    }
    st.chart.setForecast(
      {
        points: pts.map((p) => ({ time: p.t, value: p.value })),
        band: ifc.band.filter((b) => b.t > lastBar.time).map((b) => ({ time: b.t, upper: b.upper, lower: b.lower })),
      },
      { time: lastBar.time, value: lastBar.close },
    );
    const dirI = ifc.predictedPct >= 0 ? '↑' : '↓';
    const calI = ifc.calib
      ? `, Band = realisierte Fehlerverteilung (n=${ifc.calib.n})`
      : ', Band = ±1σ';
    info.textContent =
      `Kurzfrist ${dirI} ${ifc.predictedPct >= 0 ? '+' : ''}${ifc.predictedPct.toFixed(2)} % ` +
      `über die nächste Stunde (5-min-Raster, Lookback ${ifc.lookback} Bars${calI})`;
    return;
  }
  if (!fc || fc.points.length === 0) {
    st.chart.setForecast(null);
    info.textContent = '';
    return;
  }
  const last = st.bars[st.bars.length - 1];
  st.chart.setForecast(
    { points: fc.points, band: fc.band },
    last ? { time: last.date, value: last.close } : undefined,
  );
  const dir = fc.predictedPct >= 0 ? '↑' : '↓';
  const cal = fc.calib
    ? `Band = realisierte Fehlerverteilung (n=${fc.calib.n}, MAE ${fc.calib.maePct.toFixed(2)} %)`
    : 'Band = ±1σ der Regression';
  info.textContent =
    `Prognose ${dir} ${fc.predictedPct >= 0 ? '+' : ''}${fc.predictedPct.toFixed(2)} % ` +
    `über ${fc.points.length} Handelstage (Lookback ${fc.lookback}, ${cal})`;
}

/** Prognose-Labor: Kombi-Statistik (Tages- ODER Intraday-Pfad) rendern. */
function renderFcLabStats(hostId: string, stats: ForecastStatsDoc | null): void {
  const host = $(hostId);
  const rows = Object.entries(stats?.combos ?? {})
    .map(([key, c]) => {
      // Schlüssel ist der Lookback. Altbestand im Format "w_lookback" fällt
      // durch die Prüfung und wird nicht angezeigt — eine Zeile mit
      // erfundener Zahl wäre schlimmer als eine fehlende.
      const lb = Number(key);
      return {
        lb: Number.isFinite(lb) && lb > 0 ? lb : null,
        n: c.n,
        hit: c.n > 0 ? (c.hits / c.n) * 100 : 0,
        mae: c.n > 0 ? c.maeSum / c.n : 0,
      };
    })
    .filter((r): r is { lb: number; n: number; hit: number; mae: number } => r.lb !== null)
    .sort((a, b) => b.hit - a.hit || a.mae - b.mae);
  if (rows.length === 0) {
    host.innerHTML =
      '<div class="hint">Noch keine bewerteten Prognosen — die Statistik füllt sich, sobald erste Horizonte realisiert sind.</div>';
    return;
  }
  const best = stats?.best;
  host.innerHTML =
    '<div class="fl-row fl-head"><span>Lookback</span><span>n</span><span>Treffer</span><span>MAE</span></div>' +
    rows
      .map((r) => {
        const isBest = best !== undefined && best.lookback === r.lb;
        return (
          `<div class="fl-row${isBest ? ' fl-best' : ''}"${isBest ? ' title="Bester Lookback — steuert die Live-Prognose"' : ''}>` +
          `<span>${r.lb}</span><span>${r.n}</span>` +
          `<span class="${r.hit >= 50 ? 'c-gn' : 'c-rd'}">${r.hit.toFixed(0)} %</span>` +
          `<span>${r.mae.toFixed(2)} %</span></div>`
        );
      })
      .join('');
}

/** Prognose-Labor: bewertete Prognosen (Vorhersage vs. Realität) des Chart-Symbols. */
function renderFcLabRows(rows: EvaluatedForecastRow[]): void {
  const host = $('flRows');
  const done = rows.filter((r) => r.evaluated && r.evaluatedAt);
  if (done.length === 0) {
    host.innerHTML = '<div class="hint">Noch keine bewerteten Prognosen für dieses Symbol.</div>';
    return;
  }
  host.innerHTML =
    '<div class="fl-row fl-head"><span>Basis</span><span>Lookback</span><span>Prognose</span><span>Richtung</span><span>MAE</span></div>' +
    done
      .map((r) => {
        const hit = r.dirHit === true;
        return (
          '<div class="fl-row">' +
          `<span>${String(r.baseDate).slice(0, 10)}</span><span>${Number(r.lookback)}</span>` +
          `<span>${r.predictedPct >= 0 ? '+' : ''}${Number(r.predictedPct).toFixed(2)} %</span>` +
          `<span class="${hit ? 'c-gn' : 'c-rd'}">${hit ? '✓ getroffen' : '✗ daneben'}</span>` +
          `<span>${Number(r.maePct ?? 0).toFixed(2)} %</span></div>`
        );
      })
      .join('');
}

// Zeit-Domäne des letzten renderChart-Laufs (Intraday vs. Tages-Sicht) —
// steuert das Räumen des Prognose-Overlays beim Moduswechsel.
let lastRenderIntraday: boolean | null = null;

// Schneller Symbolwechsel startet rebuildChart nebenläufig — die Epoche
// sorgt dafür, dass nur der JÜNGSTE Aufbau gewinnt und Callbacks nie auf
// einem bereits zerstörten Chart arbeiten („Object is disposed").
let chartEpoch = 0;

async function rebuildChart(): Promise<void> {
  if (!st) return;
  const epoch = ++chartEpoch;
  st.chart?.destroy();
  st.chart = null; // Snapshots während des Aufbaus laufen ins Leere statt auf ein totes Handle
  const handle = await buildPriceChart($('chartArea'), st.currentSymbol);
  if (!st || epoch !== chartEpoch) {
    handle?.destroy();
    return;
  }
  st.chart = handle;
  st.chartFitPending = true;
  if (st.intradayDays > 0) void loadIntradayView();
  st.chart?.onClick((price) => {
    if (!st?.predMode || price === null) return;
    st.predMode = false;
    $('predBtn').classList.remove('on');
    openPredPop(price);
  });
  st.chart?.onVisibleRangeChange(() => drawPredictionArrow());
  // „Jetzt ⇥"-Chip (User-Screenshot 26.07.): erscheint, sobald der jüngste
  // Bar rechts AUSSERHALB des Fensters liegt — ein Klick springt animiert
  // zurück in die Gegenwart (TradingView-Komfort; position:absolute im
  // chartWrap, NICHT fixed — backdrop-filter-Falle, CLAUDE.md §6).
  st.chart?.onVisibleRangeChange((range) => {
    if (!st) return;
    const len = st.intradayDays > 0 ? st.shownIntraday.length : dailySource().length;
    $('jumpNow').hidden = !(range && len > 0 && range.to < len - 1.5);
  });
  st.chart?.onCrosshairDate((date) => {
    if (st?.mainLocked && st.chart) syncLockedCrosshair(st.chart, date);
  });
  // EIN konsolidierter Range-Sync (Unterpanels + Vergleich + Lock-Gruppe):
  // genau EIN matchEcho pro Event — mehrere Handler würden sich den Ring-
  // Eintrag gegenseitig wegkonsumieren. Nachbarn folgen auch Echos (sonst
  // hängen sie, wenn Vergleich/Lock-Panel das Haupt-Chart treibt), aber nie
  // zurück zum Verursacher — dessen Trägheits-Glide liefe sonst gegen die
  // eigene, einen Frame alte Range (Smartphone-Kinetik 26.07.).
  st.chart?.onVisibleRangeChange((range) => {
    if (!range || !st?.chart) return;
    const echo = matchEcho(st.chart, range);
    const origin = echo ? echo.origin : st.chart;
    pushRange(st.subCharts.rsi, range, origin);
    pushRange(st.subCharts.macd, range, origin);
    pushRange(st.chart2, range, origin);
    if (st.mainLocked) syncLockedRange(st.chart, range, origin);
  });
  // Auto-Auflösung + nahtlose Historie: sichtbare Spanne beobachten (debounced)
  st.chart?.onVisibleRangeChange((range) => {
    if (autoResTimer !== null) window.clearTimeout(autoResTimer);
    const nearLeftEdge = range !== null && range.from < 12;
    autoResTimer = window.setTimeout(() => {
      autoResTimer = null;
      maybeAutoSwitch();
      // Links am Datenrand? Ältere Jahres-Chunks nahtlos nachladen.
      if (nearLeftEdge && st && st.intradayDays === 0 && (st.autoRes || st.range === 0)) {
        void loadOlderDaily();
      }
    }, 300);
  });
  st.chart?.setAutoScale(st.yAuto);
  // Beim Chart-Neuaufbau (Symbol-/Theme-Wechsel) Panels frisch mitziehen
  for (const kind of ['rsi', 'macd'] as const) {
    subEpochs[kind]++;
    st.subCharts[kind]?.destroy();
    st.subCharts[kind] = null;
  }
  void loadPredictionForSymbol();
  st.chart?.onCrosshairDate((date, _pos) => {
    if (!crosshairSyncing && st?.chart2) {
      crosshairSyncing = true;
      st.chart2.setCrosshair(date);
      crosshairSyncing = false;
    }
  });
  // In-Chart-HUD (TV-Stil): OHLC des Bars unterm Crosshair, sonst letzter Bar
  st.chart?.onCrosshairData((d) => renderOhlcHud(d));
  // (Vergleichs-Chart folgt über den konsolidierten Sync-Handler oben)
  renderChart();
  applyMarkers();
}

/** Tooltip-Details zum Event-Tag unter dem Crosshair (M6b). */
/**
 * Die Symbole, die angezeigt werden — dieselben, die die Engine handelt.
 *
 * Vor dem ersten Scan (frisches Projekt, Heartbeat noch leer) fällt die
 * Anzeige auf die Default-Liste zurück. Eine leere Livebar wäre kein
 * ehrlicherer Zustand, sondern nur ein ratloser.
 */
function watchedSymbols(): string[] {
  const w = st?.watched ?? [];
  return w.length > 0 ? w : [...DEFAULT_STRATEGY.watchlist];
}

/**
 * Der Hinweistext unter „Beobachtet".
 *
 * Bis 28.07. stand hier eine feste Behauptung („Spitze des täglichen
 * Rankings über alle 166 Katalog-Symbole"), und darunter eine kurze Liste —
 * was der Owner zu Recht als Widerspruch las: „kann das tool nicht alles
 * immer parallel beobachten?" Konnte es damals nicht, und der Text verschwieg
 * das. Jetzt kommen beide Zahlen aus dem letzten Scan selbst: Kurse für den
 * ganzen offenen Katalog, tiefe Analyse für die Rangliste.
 */
function renderWatchHint(): void {
  const el = document.getElementById('wlHint');
  if (!el || !st) return;
  const tief = watchedSymbols().length;
  el.textContent =
    st.catalogQuotes > 0
      ? `${st.catalogQuotes} von ${st.catalogOpen} offenen Katalog-Symbolen im letzten Scan ` +
        `bekurst (alle 5 min). Davon ${tief} tief analysiert: 5-min-Kerzen, Indikatoren, ` +
        `Prognose, Handel — automatisch gewählt nach Rangliste plus jede offene Position.`
      : `${tief} Symbole tief analysiert — automatisch gewählt nach Rangliste plus jede ` +
        `offene Position. Kurse holt der Scan für den ganzen Katalog.`;
}

function wireWatchlist(): void {
  if (!st) return;
  clearSubs(st.watchlistSubs);
  const wl = watchedSymbols();

  // Livebar
  const bar = $('liveBar');
  bar.innerHTML = '';
  const priceEls = new Map<string, { pr: HTMLElement; ch: HTMLElement; item: HTMLElement }>();
  for (const sym of wl) {
    const item = document.createElement('div');
    item.className = 'lb-item' + (sym === st.currentSymbol ? ' on' : '');
    item.innerHTML = '<div class="lb-sym"></div><div class="lb-pr">--</div><div class="lb-ch"></div>';
    item.querySelector('.lb-sym')!.textContent = sym;
    item.addEventListener('click', () => selectSymbol(sym));
    bar.appendChild(item);
    priceEls.set(sym, {
      pr: item.querySelector('.lb-pr')!,
      ch: item.querySelector('.lb-ch')!,
      item,
    });
  }

  // Signal-Tabelle
  const body = $('sigBody') as HTMLTableSectionElement;
  body.innerHTML = '';
  const rows = new Map<string, { ind: IndicatorRow | null; sig: SignalRow | null; tr: HTMLTableRowElement }>();
  for (const sym of wl) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono" style="color:var(--t1);font-weight:700"></td>
      <td>--</td><td>--</td><td>--</td><td>--</td><td><span class="stag t-hold">HOLD</span></td>`;
    tr.querySelector('td')!.textContent = sym;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => selectSymbol(sym));
    body.appendChild(tr);
    rows.set(sym, { ind: null, sig: null, tr });
  }
  const paintRow = (sym: string): void => {
    const r = rows.get(sym);
    if (!r) return;
    const tds = r.tr.querySelectorAll('td');
    tds[1]!.textContent = r.ind?.rsi != null ? r.ind.rsi.toFixed(1) : '--';
    tds[2]!.textContent = r.ind?.macd ? r.ind.macd.line.toFixed(2) : '--';
    tds[3]!.textContent = r.ind?.bollinger ? r.ind.bollinger.pctB.toFixed(0) : '--';
    if (r.sig) {
      tds[4]!.textContent = `${r.sig.buyVotes}▲ ${r.sig.sellVotes}▼ / ${r.sig.requiredConfluence}`;
      const dir = r.sig.direction;
      tds[5]!.innerHTML = `<span class="stag t-${dir}">${dir.toUpperCase()}</span>`;
    }
  };

  for (const sym of wl) {
    st.watchlistSubs.push(
      watchMarketDoc(sym, (d) => {
        const e = priceEls.get(sym);
        if (!e) return;
        if (d?.quote) {
          e.pr.textContent = fmtNum(d.quote.price);
          e.ch.textContent = fmtPct(d.quote.changePct);
          e.ch.className = `lb-ch ${pnlClass(d.quote.changePct)}`;
        }
      }),
      watchLatestIndicators(sym, (ind) => { const r = rows.get(sym); if (r) { r.ind = ind; paintRow(sym); } }),
      watchLatestSignal(sym, (sig) => { const r = rows.get(sym); if (r) { r.sig = sig; paintRow(sym); } }),
    );
  }

  renderStrategyChips();
  wireHistorie();
}

/**
 * Historie-Bedienung: Nachladen und die zwei Anzeigefilter.
 *
 * Idempotent über ein Daten-Attribut — `wireWatchlist` läuft bei jeder
 * Änderung der beobachteten Symbole erneut, und ein zweiter Listener auf
 * demselben Knopf würde jede Seite doppelt laden.
 */
function wireHistorie(): void {
  const mehr = $('jMore');
  if (mehr && mehr.dataset.wired !== '1') {
    mehr.dataset.wired = '1';
    mehr.addEventListener('click', () => void ladeAeltereTrades());
  }
  const auf = $('anOpen');
  if (auf && auf.dataset.wired !== '1') {
    auf.dataset.wired = '1';
    auf.addEventListener('click', () => {
      renderAnalytics(); // frisch rechnen, nicht den Stand vom letzten Öffnen zeigen
      $('anModal').classList.add('show');
    });
  }
  for (const id of ['jFilter', 'jSide']) {
    const el = $(id);
    if (!el || el.dataset.wired === '1') continue;
    el.dataset.wired = '1';
    el.addEventListener('input', renderJournal);
  }
}

/* ── Vergleichs-Chart (M9 Chart-Stack) ──────────────────────────────── */

// Schutz gegen Sync-Echos — frame-sicher (Smartphone-Kinetik 26.07.):
// setVisibleRange stoppt in LWC JEDE laufende Trägheits-Animation (applyRange
// → stopTimeScaleAnimation), und Range-Events feuern ASYNCHRON im nächsten
// Frame. Ein synchroner Boolean lässt Echos deshalb durch: Haupt-Chart
// gleitet → Sync schiebt die Range in Unterpanel/Vergleich → deren Echo
// prallt einen Frame später zurück und würgt das Touch-/Maus-Momentum ab.
// Stattdessen merkt sich jedes Ziel die zuletzt programmatisch gesetzten
// Ranges (Ring); meldet es exakt so eine Range zurück, ist es ein Echo und
// wird nicht weitergereicht — das Original-Chart gleitet ungestört weiter.
// Jeder Ring-Eintrag trägt den VERURSACHER (origin) mit: Beim Weiterreichen
// eines Echos wird nie zurück zum Verursacher gepusht — dessen Glide-Animation
// bliebe sonst am eigenen, einen Frame alten Range-Stand hängen.
interface RangeTarget {
  setVisibleRange(r: { from: number; to: number }): void;
}
type AppliedRange = { from: number; to: number; origin: RangeTarget | null };
const appliedRanges = new WeakMap<RangeTarget, AppliedRange[]>();

function pushRange(
  target: RangeTarget | null | undefined,
  range: { from: number; to: number },
  origin: RangeTarget | null = null,
): void {
  if (!target || target === origin) return;
  const ring = appliedRanges.get(target) ?? [];
  ring.push({ from: range.from, to: range.to, origin });
  if (ring.length > 6) ring.shift();
  appliedRanges.set(target, ring);
  target.setVisibleRange(range);
}

/** Ist `range` das Echo eines eigenen pushRange? Liefert den Eintrag (mit
 *  Verursacher) und konsumiert ihn — sonst null. */
function matchEcho(target: RangeTarget, range: { from: number; to: number }): AppliedRange | null {
  const ring = appliedRanges.get(target);
  if (!ring) return null;
  const i = ring.findIndex((e) => Math.abs(e.from - range.from) < 1e-4 && Math.abs(e.to - range.to) < 1e-4);
  if (i < 0) return null;
  const hit = ring[i]!;
  ring.splice(0, i + 1); // konsumieren — ältere Einträge sind damit erledigt
  return hit;
}

// Nur ECHTE User-Gesten auf Unterpanel/Vergleich dürfen das Haupt-Chart
// ziehen: Daten-Refits (setData/Fit nach Snapshot oder Mount) feuern
// dieselben Range-Events und würden das Haupt-Chart sonst grundlos
// zurückreißen (E2E-Fund 26.07. — frisch gemountetes MACD-Panel riss den
// Haupt-Zoom auf sein Selbst-Fit-Fenster). 2,5 s decken Drag + Glide ab.
const lastGesture = new WeakMap<HTMLElement, number>();

function armGestureTracking(el: HTMLElement): void {
  if (el.dataset['gestArmed'] === '1') return;
  el.dataset['gestArmed'] = '1';
  const mark = (): void => {
    lastGesture.set(el, performance.now());
  };
  el.addEventListener('pointerdown', mark, true);
  el.addEventListener('wheel', mark, { capture: true, passive: true });
  el.addEventListener('touchstart', mark, { capture: true, passive: true });
}

function recentGesture(el: HTMLElement): boolean {
  return performance.now() - (lastGesture.get(el) ?? Number.NEGATIVE_INFINITY) < 2500;
}

let crosshairSyncing = false;
let chart2Epoch = 0;

/** Vergleichs-Chart rendert über dieselbe Panel-Logik wie das Raster. */
function renderChart2(): void {
  if (!st?.chart2P.chart) return;
  renderGridPanelBars(st.chart2P);
}

function wireChart2Ctx(): void {
  if (!st) return;
  clearSubs(st.chart2Subs);
  if (st.wsHidden.has('chart2')) return; // ausgeblendet = keine Listener
  const sym = st.chart2Symbol;
  const p = st.chart2P;
  p.sym = sym;
  p.epoch++;
  const epoch = p.epoch;
  p.fitPending = true;
  ($('ch2Sym') as HTMLInputElement).value = sym;
  st.chart2Subs.push(
    watchMarketDoc(sym, (d) => {
      $('ch2Px').textContent = d?.quote ? fmtNum(d.quote.price) : '--';
      if (epoch !== p.epoch) return;
      p.forecast = d?.forecast ?? null;
      p.forecastIntraday = d?.forecastIntraday ?? null;
      renderChart2();
    }),
    watchBars(sym, (bars) => {
      if (!st || epoch !== p.epoch) return;
      st.chart2Bars = bars;
      p.bars = bars;
      if (p.intradayDays > 0) void loadPanelIntraday(p);
      else renderChart2();
    }),
  );
}

async function rebuildChart2(): Promise<void> {
  if (!st) return;
  const epoch = ++chart2Epoch;
  st.chart2?.destroy();
  st.chart2 = null;
  st.chart2P.chart = null;
  if (st.wsHidden.has('chart2')) return;
  const handle = await buildPriceChart($('chart2Area'), st.chart2Symbol);
  if (!st || epoch !== chart2Epoch) {
    handle?.destroy();
    return;
  }
  st.chart2 = handle;
  st.chart2P.chart = handle;
  st.chart2P.fitPending = true;
  // OHLC-Kurszeile auch im Vergleichs-Chart (Grid-Gleichwertigkeit 26.07.)
  const hud2 = document.createElement('div');
  hud2.className = 'gp-hud mono';
  hud2.title = 'Kurszeile ein-/ausklappen — wirkt auf alle Chart-Fenster';
  hud2.addEventListener('click', toggleOhlcAll);
  $('chart2Area').appendChild(hud2);
  st.chart2P.hudEl = hud2;
  st.chart2?.onCrosshairData((d) => {
    if (st) renderPanelHud(st.chart2P, d);
  });
  // Zeit-/Crosshair-Sync zum Haupt-Chart (beidseitig, frame-sicherer Echo-
  // Schutz + Gesten-Gate: Daten-Refits des Vergleichs ziehen das Haupt-Chart nicht)
  armGestureTracking($('chart2Area'));
  st.chart2?.onVisibleRangeChange((range) => {
    const h = st?.chart2;
    if (!range || !st?.chart || !h) return;
    if (st.chart2P.auto) schedulePanelAuto(st.chart2P); // Auto-Zeitrahmen wie in den Panels
    if (matchEcho(h, range)) return;
    if (!recentGesture($('chart2Area'))) return;
    pushRange(st.chart, range, h);
  });
  st.chart2?.onCrosshairDate((date, _pos) => {
    // News-Overlay auch im Vergleichs-Chart (Events des Vergleichs-Symbols)
    if (crosshairSyncing || !st?.chart) return;
    crosshairSyncing = true;
    st.chart.setCrosshair(date);
    crosshairSyncing = false;
  });
  renderChart2();
}

/* ── Multi-Chart-Raster (Chart-Vision 24.07.): 1/2/4 Panels + Lock-Sync ── */

const GRID_LS_KEY = 'autotrd-chart-grid';

function saveGridPrefs(): void {
  if (!st) return;
  localStorage.setItem(
    GRID_LS_KEY,
    JSON.stringify({
      mode: st.gridMode,
      mainLocked: st.mainLocked,
      panels: st.gridPanels.map((p) => ({ sym: p.sym, range: p.range, locked: p.locked, intradayDays: p.intradayDays, auto: p.auto })),
    }),
  );
}

function loadGridPrefs(): { mode: 1 | 2 | 4; mainLocked: boolean; panels: Array<{ sym: string; range: number; locked: boolean; intradayDays: number; auto: boolean }> } {
  const fallback = { mode: 1 as const, mainLocked: false, panels: [] };
  try {
    const raw = localStorage.getItem(GRID_LS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as { mode?: number; mainLocked?: boolean; panels?: Array<{ sym?: string; range?: number; locked?: boolean; intradayDays?: number; auto?: boolean }> };
    const mode = p.mode === 2 || p.mode === 4 ? p.mode : 1;
    return {
      mode,
      mainLocked: p.mainLocked === true,
      panels: (p.panels ?? []).slice(0, 3).map((x) => ({
        sym: typeof x.sym === 'string' && x.sym ? x.sym : 'AAPL',
        range: typeof x.range === 'number' ? x.range : 66,
        locked: x.locked === true,
        intradayDays: x.intradayDays === 1 || x.intradayDays === 5 ? x.intradayDays : 0,
        auto: x.auto === true,
      })),
    };
  } catch {
    return fallback;
  }
}

/** Alle gelockten Chart-Handles (Haupt-Chart nur, wenn selbst gelockt). */
function lockedHandles(except: PriceChartHandle): PriceChartHandle[] {
  if (!st) return [];
  const out: PriceChartHandle[] = [];
  if (st.mainLocked && st.chart) out.push(st.chart);
  for (const p of st.gridPanels) if (p.locked && p.chart) out.push(p.chart);
  return out.filter((h) => h !== except);
}

// Lock-Sync nutzt denselben frame-sicheren Echo-Guard wie der Chart-Stack:
// pushRange markiert jede gesetzte Range, matchEcho stoppt den Rückprall.
function syncLockedRange(
  from: PriceChartHandle,
  range: { from: number; to: number } | null,
  origin: RangeTarget | null = from,
): void {
  if (!range) return;
  for (const h of lockedHandles(from)) pushRange(h, range, origin);
}

function syncLockedCrosshair(from: PriceChartHandle, date: string | null): void {
  if (crosshairSyncing) return;
  crosshairSyncing = true;
  for (const h of lockedHandles(from)) h.setCrosshair(date);
  crosshairSyncing = false;
}

function renderGridPanelBars(p: GridPanel): void {
  if (!p.chart) return;
  const intraday = p.intradayDays > 0;
  // Zeit-Domänen-Wechsel (ISO-Tage ↔ UNIX-Sekunden): Prognose-Overlay vor
  // setBars räumen — gleiche Falle wie beim Haupt-Chart (E2E 25.07.).
  if (p.lastRenderIntraday !== intraday) p.chart.setForecast(null);
  p.lastRenderIntraday = intraday;

  const daily = p.range > 0 ? p.bars.slice(-p.range) : p.bars;
  // Fit erst verbrauchen, wenn KERZEN da sind — sonst fittet das Panel auf
  // den Prognose-Whitespace und bleibt nach dem Daten-Eintreffen dort
  // hängen (User-Screenshot 26.07.: AAPL/TSLA zeigten nur Prognose-Linien).
  const fit = p.fitPending && (intraday ? p.intradayBars.length : daily.length) > 0;
  if (fit) p.fitPending = false;
  const shown: Array<{ time: string | number; close: number }> = intraday
    ? p.intradayBars.map((b) => ({ time: b.time, close: b.close }))
    : daily.map((b) => ({ time: b.date, close: b.close }));
  p.chart.setBars(intraday ? p.intradayBars : daily, { fit, timeVisible: intraday });

  // Chart-Typ + Skala + Kombi syncen (TV-Parität): Raster folgt dem Haupt-Stil
  if (st) {
    p.chart.setChartType(st.chartTypeSel);
    p.chart.setTypeCombine(st.typeCombine);
    p.chart.setPriceScaleMode(st.scaleMode);
  }
  // ALLE aktiven Indikator-Overlays gelten auf ALLEN Charts — inkl. VWAP in
  // der Intraday-Sicht (Grid-Parität, User-Wunsch 25.07. nachts).
  const times = shown.map((b) => b.time);
  const closes = shown.map((b) => b.close);
  const lines = st?.cleanView ? [] : baseOverlayLines(times, closes);
  if (intraday && st && !st.cleanView && st.chartLayers.has('vwap')) {
    const pts = vwapSessions(p.intradayBars).flatMap((v, i) =>
      v === null ? [] : [{ time: p.intradayBars[i]!.time, value: v }],
    );
    lines.push({ key: 'vwap', color: '#f2d16b', width: 2, points: pts });
  }
  p.chart.setOverlays(lines);
  const pMarkers: ChartMarker[] = [];
  p.lastMarkers = pMarkers.length; // E2E-Hook
  p.chart.setMarkers(pMarkers);
  // Layer syncen (User-Wunsch 25.07.): Fläche + „Kerzen aus" gelten auch im
  // Raster. Farbton neutral — das Signal gehört zum Haupt-Symbol, nicht zum
  // Panel-Symbol (falsche Grün/Rot-Aussage wäre schlimmer als neutral).
  const wantArea = st !== null && !st.cleanView && st.chartLayers.has('area');
  p.chart.setArea(
    wantArea && shown.length > 0 ? shown.map((b) => ({ time: b.time, value: b.close })) : null,
    AREA_TONES.hold,
  );
  p.chart.setCandlesVisible(!(st !== null && !st.cleanView && st.chartLayers.has('hideCandles') && wantArea));
  // Prognose in JEDEM Chart (Prognose 2.0): Tages-Sicht = Tages-Prognose,
  // Intraday-Sicht = Kurzfrist-Prognose — jeweils vom Panel-Symbol.
  const lastB = shown[shown.length - 1];
  const wantLayer = st !== null && st.showForecast && !st.cleanView;
  if (intraday) {
    const ifc = p.forecastIntraday;
    const pts = wantLayer && ifc && lastB ? ifc.points.filter((x) => x.t > (lastB.time as number)) : [];
    p.chart.setForecast(
      pts.length > 0 && ifc
        ? {
            points: pts.map((x) => ({ time: x.t, value: x.value })),
            band: ifc.band.filter((b) => b.t > (lastB!.time as number)).map((b) => ({ time: b.t, upper: b.upper, lower: b.lower })),
          }
        : null,
      pts.length > 0 && lastB ? { time: lastB.time, value: lastB.close } : undefined,
    );
  } else {
    const fc = p.forecast;
    const wantFc = wantLayer && fc != null && fc.points.length > 0;
    p.chart.setForecast(
      wantFc && fc ? { points: fc.points, band: fc.band } : null,
      wantFc && lastB ? { time: lastB.time, value: lastB.close } : undefined,
    );
  }
  renderPanelHud(p, null); // Kurszeile auf den frischen letzten Bar
}

/** Alle Nebencharts (Raster-Panels + Vergleichs-Chart) neu rendern. */
function renderAllPanels(): void {
  if (!st) return;
  for (const p of st.gridPanels) renderGridPanelBars(p);
  if (st.chart2P.chart) renderGridPanelBars(st.chart2P);
}

/**
 * Zeitrahmen-Sync (User-Wunsch 25.07. nachts): Ein Wechsel oben im Haupt-
 * Chart schaltet ALLE Charts um — Raster-Panels + Vergleichs-Chart. Die
 * lokalen Picker bleiben für gezielte Abweichungen danach.
 */
function propagateTimeframe(intradayDays: number, range: number): void {
  if (!st) return;
  const targets = [...st.gridPanels, st.chart2P];
  for (const p of targets) {
    p.auto = false; // expliziter globaler Zeitrahmen schlägt Panel-Auto (wie am Haupt-Chart)
    p.intradayDays = intradayDays;
    if (intradayDays === 0) p.range = range >= 250 || range === 0 ? 0 : range; // 1J ⇒ alle Panel-Bars (~1 Jahr)
    p.fitPending = true;
    if (p.intradayDays > 0) void loadPanelIntraday(p);
    else if (p.chart) renderGridPanelBars(p);
  }
  saveGridPrefs();
  syncPanelTfButtons();
}

/** on-Klassen der Panel-/Vergleichs-Zeitrahmen-Knöpfe an den State angleichen. */
function syncPanelTfButtons(): void {
  if (!st) return;
  document.querySelectorAll<HTMLElement>('.gpanel').forEach((el, i) => {
    const p = st!.gridPanels[i];
    if (!p) return;
    el.querySelectorAll<HTMLElement>('[data-r], [data-i]').forEach((b) => {
      const on = b.dataset['i'] !== undefined
        ? Number(b.dataset['i']) === p.intradayDays && p.intradayDays > 0
        : p.intradayDays === 0 && Number(b.dataset['r']) === p.range;
      b.classList.toggle('on', on);
    });
    el.querySelector('.gp-auto')?.classList.toggle('on', p.auto);
  });
  const p2 = st.chart2P;
  document.querySelectorAll<HTMLElement>('#c2tf [data-c2r], #c2tf [data-c2i]').forEach((b) => {
    const on = b.dataset['c2i'] !== undefined
      ? Number(b.dataset['c2i']) === p2.intradayDays && p2.intradayDays > 0
      : p2.intradayDays === 0 && Number(b.dataset['c2r']) === p2.range;
    b.classList.toggle('on', on);
  });
  $('c2Auto').classList.toggle('on', p2.auto);
}

/** Intraday-Bars eines Panels laden (epoch-geschützt; Refresh via watchBars). */
async function loadPanelIntraday(p: GridPanel): Promise<void> {
  const epoch = p.epoch;
  const sym = p.sym;
  const chunks = await loadIntraday(sym, p.intradayDays);
  if (epoch !== p.epoch || p.sym !== sym || p.intradayDays === 0) return;
  p.intradayBars = chunks;
  renderGridPanelBars(p);
}

/** Panel (neu) aufbauen: Bars-Watcher + Chart + Lock-Sync-Verdrahtung. */
async function mountGridPanel(p: GridPanel, host: HTMLElement): Promise<void> {
  const epoch = ++p.epoch;
  clearSubs(p.subs);
  p.chart?.destroy();
  p.chart = null;
  p.fitPending = true;
  p.subs.push(
    watchBars(p.sym, (bars) => {
      p.bars = bars;
      // Intraday-Sicht: frische Bars = frischer 5-min-Chunk nachladbar
      if (p.intradayDays > 0) void loadPanelIntraday(p);
      else renderGridPanelBars(p);
    }),
    watchMarketDoc(p.sym, (d) => {
      if (epoch !== p.epoch) return;
      p.forecast = d?.forecast ?? null;
      p.forecastIntraday = d?.forecastIntraday ?? null;
      renderGridPanelBars(p);
    }),
  );
  const handle = await buildPriceChart(host, p.sym);
  if (!st || epoch !== p.epoch || !st.gridPanels.includes(p)) {
    handle?.destroy();
    return;
  }
  p.chart = handle;
  armGestureTracking(host);
  // OHLC-Kurszeile im Fenster (Grid-Gleichwertigkeit 26.07.) — NACH
  // buildPriceChart anhängen, das leert den Container. Klick = Accordion
  // für ALLE Fenster gemeinsam.
  const hud = document.createElement('div');
  hud.className = 'gp-hud mono';
  hud.title = 'Kurszeile ein-/ausklappen — wirkt auf alle Chart-Fenster';
  hud.addEventListener('click', toggleOhlcAll);
  host.appendChild(hud);
  p.hudEl = hud;
  p.chart?.onCrosshairData((d) => renderPanelHud(p, d));
  p.chart?.onVisibleRangeChange((range) => {
    if (!range || !p.chart) return;
    // Auto-Zeitrahmen: JEDE Sichtänderung zählt (auch Lock-Sync — ein
    // gelocktes Panel folgt dann dem Zoom des treibenden Charts).
    schedulePanelAuto(p);
    // Echo eines Lock-Pushes? Nicht zurücksenden — sonst stirbt das
    // Trägheits-Gleiten des treibenden Charts (Smartphone-Kinetik 26.07.).
    // Gesten-Gate: Daten-Refits des Panels ziehen die Lock-Gruppe nicht.
    if (matchEcho(p.chart, range)) return;
    if (p.locked && recentGesture(host)) syncLockedRange(p.chart, range);
  });
  p.chart?.onCrosshairDate((date, _pos) => {
    // News-Overlay auch im Raster-Panel (User-Feedback 26.07.) — mit den
    // Event-Tagen des PANEL-Symbols, nicht denen des Haupt-Charts
    if (p.locked && p.chart) syncLockedCrosshair(p.chart, date);
  });
  renderGridPanelBars(p);
  if (p.intradayDays > 0) void loadPanelIntraday(p); // restaurierte Intraday-Sicht
}

function unmountGridPanel(p: GridPanel): void {
  p.epoch++;
  clearSubs(p.subs);
  p.chart?.destroy();
  p.chart = null;
}

/* Vollbild als Portal: die Glass-Cards tragen backdrop-filter und werden damit
   zum Containing Block für position:fixed — das Element muss deshalb während
   des Vollbilds an document.body hängen und danach exakt zurück. */
const maxHomes = new Map<HTMLElement, Comment>();

function enterMax(el: HTMLElement): void {
  if (maxHomes.has(el)) return;
  const mark = document.createComment('chart-max-home');
  el.before(mark);
  maxHomes.set(el, mark);
  document.body.appendChild(el);
  el.classList.add('chart-max');
}

function leaveMax(el: HTMLElement): void {
  el.classList.remove('chart-max');
  const mark = maxHomes.get(el);
  if (mark) {
    mark.replaceWith(el);
    maxHomes.delete(el);
  }
}

/** Vollbild fürs Haupt-Chart — maximiert den ganzen Scope inkl. Zeitrahmen,
 *  „Anzeige ▾"-Werkzeugen, Legende und Unterpanels (Feedback 25.07.). */
function setMainMax(on: boolean): void {
  const scope = $('chartMaxScope');
  if (on) enterMax(scope);
  else leaveMax(scope);
  ($('maxExit') as HTMLButtonElement).hidden = !on;
  $('maxMain').classList.toggle('on', on);
  // Raster-Kopf-⛶ spiegelt den Zustand wie die Panel-⛶ (Titelleisten-Parität)
  $('mhMax').classList.toggle('on', on);
  $('mhMax').textContent = on ? '✕' : '⛶';
  positionMainHud();
  drawPredictionArrow();
}

/** Alle Vollbild-Zustände beenden (Esc, oder bevor ein anderer Chart maximiert). */
function exitAllMax(): void {
  setMainMax(false);
  document.querySelectorAll('.gpanel.chart-max').forEach((el) => leaveMax(el as HTMLElement));
  document.querySelectorAll('.gp-max.on').forEach((b) => {
    b.classList.remove('on');
    b.textContent = '⛶';
  });
}

/** Raster-DOM an gridMode angleichen; Panels mounten/unmounten; persistieren. */
function renderChartGrid(): void {
  if (!st) return;
  exitAllMax(); // maximierte Panels hängen am body — vor dem Neuaufbau zurückholen
  const grid = $('chartGrid');
  const want = st.gridMode - 1;
  // Panel-Liste angleichen (Defaults aus der Watchlist, nie das Haupt-Symbol)
  while (st.gridPanels.length > want) unmountGridPanel(st.gridPanels.pop()!);
  while (st.gridPanels.length < want) {
    const used = new Set([st.currentSymbol, ...st.gridPanels.map((p) => p.sym)]);
    const sym =
      watchedSymbols().find((s) => !used.has(s)) ??
      ['AAPL', 'TSLA', '^NDX'].find((s) => !used.has(s)) ??
      'AAPL';
    st.gridPanels.push({ sym, range: 66, locked: false, chart: null, bars: [], subs: [], epoch: 0, fitPending: true, forecast: null, forecastIntraday: null, intradayDays: 0, intradayBars: [], auto: false });
  }
  $('chartRow').dataset['mode'] = String(st.gridMode);
  ($('lockMain') as HTMLButtonElement).hidden = st.gridMode === 1;
  // Kopf des Haupt-Fensters nur im Raster (Höhen-Parität mit den Panels)
  $('mainHd').hidden = st.gridMode === 1;
  ($('mainHdSym') as HTMLInputElement).value = st.currentSymbol;
  $('lockMain').innerHTML = st.mainLocked ? ICONS.lock : ICONS.unlock;
  $('lockMain').classList.toggle('on', st.mainLocked);
  syncMainHdTf();
  positionMainHud(); // Kopf sichtbar/versteckt → OHLC-Zeile ans Chart koppeln
  document.querySelectorAll('.tf-btn[data-grid]').forEach((b) => {
    b.classList.toggle('on', Number((b as HTMLElement).dataset['grid']) === st?.gridMode);
  });

  grid.innerHTML = '';
  st.gridPanels.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'gpanel';
    el.innerHTML = `
      <div class="gp-hd">
        <input class="inp gp-sym" value="${p.sym}" title="Symbol (Enter übernimmt)" />
        <span class="gp-tf">
          <button class="tf-btn gp-auto${p.auto ? ' on' : ''}"
            title="Auto-Zeitrahmen: eng zoomen wechselt in die 5-Minuten-Sicht, weit zoomen zurück zu Tageskerzen">Auto</button>
          <button class="tf-btn${p.intradayDays === 1 ? ' on' : ''}" data-i="1" title="1 Handelstag in 5-Minuten-Kerzen">1T</button>
          <button class="tf-btn${p.intradayDays === 5 ? ' on' : ''}" data-i="5" title="~5 Handelstage in 5-Minuten-Kerzen">1W</button>
          <button class="tf-btn${p.intradayDays === 0 && p.range === 22 ? ' on' : ''}" data-r="22">1M</button>
          <button class="tf-btn${p.intradayDays === 0 && p.range === 66 ? ' on' : ''}" data-r="66">3M</button>
          <button class="tf-btn${p.intradayDays === 0 && p.range === 0 ? ' on' : ''}" data-r="0">1J</button>
        </span>
        <button class="tf-btn gp-max" title="Chart im Vollbild (Esc schließt)">⛶</button>
        <button class="tf-btn gp-lock${p.locked ? ' on' : ''}"
          title="Lock: Zoom, Sichtbereich und Crosshair synchron mit allen gelockten Charts">${p.locked ? ICONS.lock : ICONS.unlock}</button>
      </div>
      <div class="gp-chart" data-gp="${i}"></div>`;
    const symInp = el.querySelector('.gp-sym') as HTMLInputElement;
    symInp.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key !== 'Enter') return;
      const sym = symInp.value.trim().toUpperCase();
      if (!sym || sym === p.sym) return;
      p.sym = sym;
      symInp.value = sym;
      saveGridPrefs();
      void mountGridPanel(p, el.querySelector('.gp-chart') as HTMLElement);
    });
    const markTf = (btn: Element): void => {
      el.querySelectorAll('[data-r], [data-i]').forEach((x) => x.classList.toggle('on', x === btn));
      // Manuelle Stufe gewählt → Panel-Auto pausiert (wie am Haupt-Chart)
      p.auto = false;
      el.querySelector('.gp-auto')?.classList.remove('on');
    };
    el.querySelectorAll('[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        p.range = Number((b as HTMLElement).dataset['r']);
        p.intradayDays = 0;
        p.fitPending = true;
        markTf(b);
        saveGridPrefs();
        renderGridPanelBars(p);
      }),
    );
    // Intraday auch im Raster (Grid-Parität, User-Wunsch 25.07. nachts)
    el.querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        p.intradayDays = Number((b as HTMLElement).dataset['i']);
        p.fitPending = true;
        markTf(b);
        saveGridPrefs();
        void loadPanelIntraday(p);
      }),
    );
    // Auto-Zeitrahmen (Grid-Gleichwertigkeit 26.07.): Zoomstufe steuert die Sicht
    const autoBtn = el.querySelector('.gp-auto') as HTMLButtonElement;
    autoBtn.addEventListener('click', () => {
      p.auto = !p.auto;
      autoBtn.classList.toggle('on', p.auto);
      saveGridPrefs();
      if (p.auto) void panelMaybeAutoSwitch(p);
    });
    const maxBtn = el.querySelector('.gp-max') as HTMLButtonElement;
    maxBtn.addEventListener('click', () => {
      const on = !el.classList.contains('chart-max');
      exitAllMax();
      if (on) {
        enterMax(el);
        maxBtn.classList.add('on');
        maxBtn.textContent = '✕';
      }
    });
    (el.querySelector('.gp-chart') as HTMLElement).addEventListener('dblclick', () => {
      p.fitPending = true;
      renderGridPanelBars(p);
    });
    const lockBtn = el.querySelector('.gp-lock') as HTMLButtonElement;
    lockBtn.addEventListener('click', () => {
      p.locked = !p.locked;
      lockBtn.innerHTML = p.locked ? ICONS.lock : ICONS.unlock;
      lockBtn.classList.toggle('on', p.locked);
      saveGridPrefs();
      // frisch gelockt → sofort auf den Stand der Gruppe ziehen
      if (p.locked && p.chart) {
        const other = lockedHandles(p.chart)[0];
        const r = other?.getVisibleRange();
        if (r) syncLockedRange(other!, r);
      }
    });
    // Klick ins Panel = aktives Fenster → News-Kontext folgt (capture, damit
    // auch Klicks auf die LWC-Canvas zählen; p.sym liest den Live-Stand)
    grid.appendChild(el);
    void mountGridPanel(p, el.querySelector('.gp-chart') as HTMLElement);
  });
  saveGridPrefs();
}

/* ── Hotkey-Order-Ticket (M9): Shift+B/S → trade-Callable ───────────── */

function openOrderTicket(side: 'buy' | 'sell'): void {
  if (!st) return;
  st.orderSide = side;
  const title = $('otTitle');
  title.textContent = side === 'buy' ? 'Kaufen — Paper-Order' : 'Verkaufen — Paper-Order';
  title.className = side === 'buy' ? 'c-gn' : 'c-rd';
  ($('otSym') as HTMLInputElement).value = st.currentSymbol;
  ($('otQty') as HTMLInputElement).value = '1';
  $('otErr').hidden = true;
  updateOrderPreview();
  $('orderModal').classList.add('show');
  const qty = $('otQty') as HTMLInputElement;
  qty.focus();
  qty.select();
}

/** Risiko-Vorschau + Kurs-Altersstempel (Kurs = zentraler Scan-Quote). */
function updateOrderPreview(): void {
  if (!st) return;
  const sym = ($('otSym') as HTMLInputElement).value.trim().toUpperCase();
  const qty = Math.max(1, Number(($('otQty') as HTMLInputElement).value) || 1);
  const risk = $('otRisk');
  const age = $('otAge');
  const q = sym === st.currentSymbol ? st.lastQuote : null;
  if (!q) {
    risk.textContent = 'Kein zentraler Kurs für dieses Symbol im Blick — der Server prüft beim Bestätigen.';
    age.textContent = '';
    return;
  }
  const exposure = qty * q.price;
  const cash = st.wallet?.paperBalance ?? null;
  const pct = cash && cash > 0 ? ` (${((exposure / cash) * 100).toFixed(1)} % vom Cash)` : '';
  const sl = st.strategy.engine.stopLossPct;
  const slLevel = st.orderSide === 'buy' ? q.price * (1 - sl / 100) : q.price * (1 + sl / 100);
  risk.textContent =
    `${qty} × ${fmtNum(q.price)} = $${exposure.toLocaleString('en-US', { maximumFractionDigits: 2 })}` +
    `${pct} · Stop-Level ~${fmtNum(slLevel)} (${sl} %)`;
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(q.updatedAt)) / 1000));
  age.textContent = `Kurs ${secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`} alt (zentraler 5-min-Scan)`;
  age.style.color = secs > 600 ? 'var(--rd)' : '';
}

async function submitOrderTicket(): Promise<void> {
  if (!st) return;
  const sym = ($('otSym') as HTMLInputElement).value.trim().toUpperCase();
  const qty = Math.max(1, Math.floor(Number(($('otQty') as HTMLInputElement).value) || 1));
  const err = $('otErr');
  err.hidden = true;
  const btn = $('otSubmit') as HTMLButtonElement;
  btn.disabled = true;
  try {
    await callTrade({ symbol: sym, side: st.orderSide, qty });
    $('orderModal').classList.remove('show');
  } catch (e) {
    err.textContent = e instanceof Error && e.message ? e.message : 'Order fehlgeschlagen.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/** Globale Hotkeys (settings.hotkeys, M9) — nie beim Tippen in Feldern. */
function onGlobalHotkey(e: KeyboardEvent): void {
  if (!st) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (matchesHotkey(e, st.hotkeys.buy ?? 'shift+b')) {
    e.preventDefault();
    openOrderTicket('buy');
  } else if (matchesHotkey(e, st.hotkeys.sell ?? 'shift+s')) {
    e.preventDefault();
    openOrderTicket('sell');
  }
}

/** Watchlist-/Tabellen-Klick: Symbol in die CHART-Gruppe publizieren (M9).
 *  Alle Panels derselben Gruppe (Default: auch News) folgen über den Bus. */
function selectSymbol(sym: string): void {
  if (!st) return;
  publishSymbol(st.chartGroup, sym);
}

function markLivebar(sym: string): void {
  document.querySelectorAll('.lb-item').forEach((el) => {
    el.classList.toggle('on', el.querySelector('.lb-sym')?.textContent === sym);
  });
  const hd = document.getElementById('mainHdSym') as HTMLInputElement | null;
  if (hd) hd.value = sym; // Kopf des Haupt-Fensters folgt dem Symbol
}

/* ── Workspace: Sichtbarkeit, Presets, Persistenz (M9) ──────────────── */

function applyPanels(): void {
  if (!st) return;
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => {
    el.style.display = st!.wsHidden.has(el.dataset.panel ?? '') ? 'none' : '';
  });
  // Vergleichs-Chart lebt nur, wenn sichtbar (keine unsichtbaren Listener)
  wireChart2Ctx();
  void rebuildChart2();
}

function applyPreset(id: string): void {
  const preset = WS_PRESETS[id];
  if (!st || !preset) return;
  st.wsPreset = id;
  st.wsHidden = new Set(preset.hidden);
  applyPanels();
  scheduleWsSave();
}

function togglePanel(id: string): void {
  if (!st) return;
  if (st.wsHidden.has(id)) st.wsHidden.delete(id);
  else st.wsHidden.add(id);
  st.wsPreset = 'custom';
  applyPanels();
  scheduleWsSave();
}

/* ── Taschenmesser Teil 3: Modul-Reihenfolge + Sidebar-Breiten ─────────── */

/** Karten in beiden Sidebars nach wsOrder sortieren (fehlend = DOM-Index —
 *  stabil, weil sort() stabil ist und der Default die aktuelle Position ist). */
function applyPanelOrder(): void {
  if (!st) return;
  for (const colId of ['leftCol', 'rightCol']) {
    const col = document.getElementById(colId);
    if (!col) continue;
    const cards = [...col.querySelectorAll<HTMLElement>(':scope > .card[data-panel]')];
    const pos = new Map(cards.map((c, i) => [c, i]));
    cards
      .sort(
        (a, b) =>
          (st!.wsOrder[a.dataset.panel ?? ''] ?? pos.get(a)!) -
          (st!.wsOrder[b.dataset.panel ?? ''] ?? pos.get(b)!),
      )
      .forEach((c) => col.appendChild(c));
  }
}

/** Reihenfolge aus dem DOM einfrieren (nach einem Drop) und speichern. */
function commitPanelOrder(): void {
  if (!st) return;
  for (const colId of ['leftCol', 'rightCol']) {
    document
      .getElementById(colId)
      ?.querySelectorAll<HTMLElement>(':scope > .card[data-panel]')
      .forEach((c, i) => {
        st!.wsOrder[c.dataset.panel ?? ''] = i;
      });
  }
  scheduleWsSave();
}

/** Ein Modul programmatisch verschieben (Palette/Test-Hook — derselbe Pfad
 *  wie der Drop: DOM umstellen, dann committen). */
function movePanel(id: string, delta: number): void {
  const card = document.querySelector<HTMLElement>(`.card[data-panel="${id}"]`);
  const col = card?.parentElement;
  if (!card || !col || !(col.id === 'leftCol' || col.id === 'rightCol')) return;
  const cards = [...col.querySelectorAll<HTMLElement>(':scope > .card[data-panel]')];
  const idx = cards.indexOf(card);
  const target = cards[idx + delta];
  if (!target) return;
  if (delta > 0) target.after(card);
  else target.before(card);
  commitPanelOrder();
}

/** Spalten-Dragover: die gezogene Karte folgt der Maus (live einsortieren);
 *  Reorder bewusst nur INNERHALB einer Spalte (Karten sind spaltig designt). */
function wireColumnDnD(): void {
  for (const colId of ['leftCol', 'rightCol']) {
    const col = document.getElementById(colId);
    col?.addEventListener('dragover', (ev) => {
      const dragging = col.querySelector<HTMLElement>(':scope > .card.dragging');
      if (!dragging) return;
      ev.preventDefault();
      const y = (ev as DragEvent).clientY;
      const siblings = [...col.querySelectorAll<HTMLElement>(':scope > .card[data-panel]:not(.dragging)')];
      const next = siblings.find((s) => {
        const r = s.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (next) col.insertBefore(dragging, next);
      else col.insertBefore(dragging, col.querySelector(':scope > .sb-rs'));
    });
  }
}

/** Sidebar-Breiten (Desktop): Resize-Handle an der Innenkante, Gerät-lokal. */
function wireSidebarResize(): void {
  const stored = ((): Record<string, number> => {
    try {
      return JSON.parse(localStorage.getItem('autotrd-sbw') ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  })();
  for (const [colId, edge] of [
    ['leftCol', 'right'],
    ['rightCol', 'left'],
  ] as const) {
    const col = document.getElementById(colId);
    if (!col) continue;
    // 260-560 px (26.07.): unter 260 werden News-/KI-Texte zu Ein-Wort-
    // Zeilen; großen Monitoren gönnen wir mehr Maximalbreite.
    if (stored[colId]) col.style.width = `${Math.min(560, Math.max(260, stored[colId]))}px`;
    const grip = document.createElement('div');
    grip.className = `sb-rs sb-rs-${edge}`;
    grip.title = 'Spaltenbreite ziehen (Doppelklick = zurücksetzen)';
    col.appendChild(grip);
    grip.addEventListener('dblclick', () => {
      col.style.width = '';
      delete stored[colId];
      localStorage.setItem('autotrd-sbw', JSON.stringify(stored));
    });
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const startW = col.getBoundingClientRect().width;
      const move = (m: PointerEvent): void => {
        const dx = m.clientX - startX;
        const w = Math.min(560, Math.max(260, edge === 'right' ? startW + dx : startW - dx));
        col.style.width = `${w}px`;
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        stored[colId] = Math.round(col.getBoundingClientRect().width);
        localStorage.setItem('autotrd-sbw', JSON.stringify(stored));
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }
}

/* ── Dashboard-Individualisierung Teil 1 (Taschenmesser-Vision 25.07.) ── */

/** Eingeklappte Karten anwenden (nur der Körper zu — Gerät-lokal). */
function applyCollapse(): void {
  if (!st) return;
  document.querySelectorAll<HTMLElement>('.card[data-panel]').forEach((card) => {
    const id = card.dataset.panel ?? '';
    const body = card.querySelector<HTMLElement>(':scope > .cbody');
    const btn = card.querySelector<HTMLElement>(':scope > .sect [data-col]');
    const on = st!.collapsed.has(id);
    if (body) body.hidden = on;
    if (btn) btn.textContent = on ? '▸' : '▾';
  });
}

/** Jede Modul-Karte bekommt ▾ (einklappen) und ✕ (ausblenden) im Kopf. */
function wirePanelChrome(): void {
  document.querySelectorAll<HTMLElement>('.card[data-panel]').forEach((card) => {
    const sect = card.querySelector<HTMLElement>(':scope > .sect');
    const body = card.querySelector<HTMLElement>(':scope > .cbody');
    const id = card.dataset.panel ?? '';
    if (!sect || !body || !id) return;
    const box = document.createElement('span');
    box.className = 'sect-tools';
    const inSidebar = card.parentElement?.id === 'leftCol' || card.parentElement?.id === 'rightCol';
    box.innerHTML =
      (inSidebar
        ? '<button type="button" class="sect-btn sect-grip" data-grip title="Modul verschieben (ziehen)">⠿</button>'
        : '') +
      '<button type="button" class="sect-btn" data-col title="Modul ein-/ausklappen">▾</button>' +
      '<button type="button" class="sect-btn" data-x title="Modul ausblenden — wieder einblendbar über Optionen → Module">✕</button>';
    sect.appendChild(box);
    // Drag-Reorder (Taschenmesser Teil 3): Karte ist nur draggable, solange
    // der Grip gedrückt ist — sonst stört Drag jede Text-Selektion.
    const grip = box.querySelector<HTMLElement>('[data-grip]');
    if (grip) {
      grip.addEventListener('pointerdown', () => card.setAttribute('draggable', 'true'));
      grip.addEventListener('pointerup', () => card.removeAttribute('draggable'));
      card.addEventListener('dragstart', (ev) => {
        card.classList.add('dragging');
        (ev as DragEvent).dataTransfer?.setData('text/plain', id);
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        card.removeAttribute('draggable');
        commitPanelOrder();
      });
    }
    box.querySelector('[data-col]')!.addEventListener('click', () => {
      if (!st) return;
      if (st.collapsed.has(id)) st.collapsed.delete(id);
      else st.collapsed.add(id);
      localStorage.setItem('autotrd-collapsed', [...st.collapsed].join(','));
      applyCollapse();
    });
    box.querySelector('[data-x]')!.addEventListener('click', () => togglePanel(id));
  });
  applyCollapse();
}

/** Workspace debounced (2 s) nach users/{uid}/workspaces/default schreiben. */
function scheduleWsSave(): void {
  if (!st) return;
  if (st.wsSaveTimer !== null) clearTimeout(st.wsSaveTimer);
  st.wsSaveTimer = window.setTimeout(() => {
    if (!st) return;
    st.wsSaveTimer = null;
    const data: WorkspaceDocData = {
      preset: st.wsPreset,
      panels: Object.fromEntries(
        Object.keys(PANEL_TITLES).map((id) => [
          id,
          {
            hidden: st!.wsHidden.has(id),
            ...(st!.wsOrder[id] !== undefined ? { order: st!.wsOrder[id] } : {}),
          },
        ]),
      ),
      groups: { chart: st.chartGroup, chart2: st.chart2Group },
      symbols: { A: groupSymbol('A'), B: groupSymbol('B'), C: groupSymbol('C') },
      updatedAt: new Date().toISOString(),
    };
    saveWorkspace(st.uid, data).catch((e) => console.warn('saveWorkspace', e));
  }, 2000);
}

/* ── Strategie-Formular ─────────────────────────────────────────────── */

function fillForm(s: Strategy): void {
  ($('sRsiLo') as HTMLInputElement).value = String(s.indicators.rsi.thresholdBuy);
  ($('sRsiHi') as HTMLInputElement).value = String(s.indicators.rsi.thresholdSell);
  ($('sInt') as HTMLInputElement).value = String(s.engine.checkIntervalMin);
  ($('sConf') as HTMLInputElement).value = String(s.signals.minConfluence);
  ($('sPeriod') as HTMLSelectElement).value = s.signals.period;
  ($('sMaxP') as HTMLInputElement).value = String(s.engine.maxPositionPct);
  ($('sSL') as HTMLInputElement).value = String(s.engine.stopLossPct);
  ($('sTP') as HTMLInputElement).value = String(s.engine.takeProfitPct);
  renderEngineBadge(s.engine.running);
}

function renderEngineBadge(running: boolean): void {
  const b = $('engBadge');
  b.textContent = running ? 'Engine an' : 'Engine aus';
  b.className = `badge ${running ? 'b-on' : 'b-off'}`;
  // Owner-Feedback 28.07.: „start/stop müssen doch nicht immer beide angezeigt
  // werden." Stimmt — von zwei Knöpfen ist immer genau einer sinnlos, und ein
  // grüner „Start" neben einer laufenden Engine liest sich wie ein Hinweis,
  // dass sie NICHT läuft. Sichtbar ist nur noch die mögliche Aktion; der
  // Zustand steht ohnehin im Badge daneben.
  ($('engStart') as HTMLButtonElement).hidden = running;
  ($('engStop') as HTMLButtonElement).hidden = !running;
}

function renderStrategyChips(): void {
  if (!st) return;
  const box = $('wlChips');
  box.innerHTML = '';
  for (const sym of watchedSymbols()) {
    const chip = document.createElement('span');
    chip.className = 'wl-chip';
    chip.textContent = sym;
    box.appendChild(chip);
  }
}

function formStrategy(): Strategy {
  const s = st!.strategy;
  return {
    ...s,
    engine: {
      ...s.engine,
      checkIntervalMin: Number(($('sInt') as HTMLInputElement).value) || 5,
      maxPositionPct: Number(($('sMaxP') as HTMLInputElement).value) || 10,
      stopLossPct: Number(($('sSL') as HTMLInputElement).value) || 2,
      takeProfitPct: Number(($('sTP') as HTMLInputElement).value) || 4,
    },
    indicators: {
      ...s.indicators,
      rsi: {
        ...s.indicators.rsi,
        thresholdBuy: Number(($('sRsiLo') as HTMLInputElement).value) || 30,
        thresholdSell: Number(($('sRsiHi') as HTMLInputElement).value) || 70,
      },
    },
    signals: {
      ...s.signals,
      minConfluence: Number(($('sConf') as HTMLInputElement).value) || 2,
      period: ($('sPeriod') as HTMLSelectElement).value || '3mo',
    },
  };
}

async function submitStrategy(next: Strategy, hint: string): Promise<void> {
  const err = $('stratErr');
  const problems = validateStrategy(next);
  if (problems.length > 0) {
    err.textContent = problems[0]!;
    err.hidden = false;
    return;
  }
  err.hidden = true;
  $('saveHint').textContent = 'Speichere…';
  try {
    await saveStrategy(next);
    $('saveHint').textContent = hint;
  } catch (e) {
    // Server-Meldung durchreichen (z. B. „E-Mail zuerst bestätigen", Quota)
    const msg = e instanceof Error && e.message ? e.message : '';
    err.textContent = msg || 'Speichern fehlgeschlagen — bitte erneut versuchen.';
    err.hidden = false;
    $('saveHint').textContent = '';
    console.warn('saveStrategy', e);
  }
}

/* ── Markt-Übersicht + Detail-Sheet ─────────────────────────────────── */

async function renderMarketTabs(): Promise<void> {
  if (!st) return;
  st.universe ??= await loadUniverse();
  const tabs = $('mktTabs');
  tabs.innerHTML = '';
  if (!st.universe) {
    $('mktBody').innerHTML = '<span class="c-t3">Katalog noch nicht geseedet — läuft mit dem ersten Scan.</span>';
    return;
  }
  // Marktgruppen-Filter: steht die aktive Klasse auf „versteckt", zur ersten
  // sichtbaren wechseln, damit Tab-Leiste und Grid konsistent bleiben.
  if (st.ui.marketGroups?.[st.marketClass] === false) {
    const first = CLASS_ORDER.find((c) => st!.universe![c] && st!.ui.marketGroups?.[c] !== false);
    if (first) st.marketClass = first;
  }
  for (const cls of CLASS_ORDER) {
    if (!st.universe[cls]) continue;
    if (st.ui.marketGroups?.[cls] === false) continue;
    const b = document.createElement('button');
    b.className = 'mtab' + (cls === st.marketClass ? ' on' : '');
    b.textContent = CLASS_LABELS[cls] ?? cls;
    b.addEventListener('click', () => {
      st!.marketClass = cls;
      tabs.querySelectorAll('.mtab').forEach((el) => el.classList.toggle('on', el === b));
      void renderMarketGrid();
    });
    tabs.appendChild(b);
  }
  await renderMarketGrid();
}

async function renderMarketGrid(): Promise<void> {
  if (!st?.universe) return;
  const cls = st.universe[st.marketClass];
  const body = $('mktBody');
  if (!cls) { body.innerHTML = ''; return; }
  const quotes = await loadMarketQuotes();
  body.innerHTML = '';
  for (const [group, entries] of Object.entries(cls.groups)) {
    const g = document.createElement('div');
    g.className = 'mkt-group';
    g.innerHTML = `<div class="mkt-glbl"></div><div class="mkt-grid"></div>`;
    g.querySelector('.mkt-glbl')!.textContent = group;
    const grid = g.querySelector('.mkt-grid')!;
    for (const { symbol, name } of entries) {
      const q = quotes.get(symbol)?.quote;
      const cell = document.createElement('div');
      cell.className = 'mkt-cell';
      cell.style.borderLeftColor = q ? (q.changePct >= 0 ? 'var(--gn)' : 'var(--rd)') : 'var(--bd)';
      cell.innerHTML = `<div class="mkt-sym"></div><div class="mkt-cnm"></div>
        <div class="mkt-pr">--</div><div class="mkt-ch"></div>`;
      cell.querySelector('.mkt-sym')!.textContent = symbol;
      cell.querySelector('.mkt-cnm')!.textContent = name;
      if (q) {
        cell.querySelector('.mkt-pr')!.textContent = fmtNum(q.price);
        const ch = cell.querySelector('.mkt-ch')!;
        ch.textContent = fmtPct(q.changePct);
        ch.className = `mkt-ch ${pnlClass(q.changePct)}`;
      }
      cell.addEventListener('click', () => openDetail(symbol, name, quotes.get(symbol) ?? null));
      grid.appendChild(cell);
    }
    body.appendChild(g);
  }
}

function openDetail(symbol: string, name: string, data: MarketDocData | null): void {
  if (!st) return;
  const sheet = $('detailSheet');
  const q = data?.quote;
  // Schlagzeilen aus der News-Lage des Scans (News-Rückkehr 29.07.) — reine
  // Anzeige; dieselben Daten, auf denen das Einstiegs-Veto beruht.
  const esc = (s: string): string => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  const alter = (pub: number): string => {
    const min = Math.max(0, Math.round((Date.now() / 1000 - pub) / 60));
    return min < 60 ? `vor ${min} min` : `vor ${Math.round(min / 60)} h`;
  };
  const newsHtml = (data?.news?.top ?? [])
    .slice(0, 4)
    .map((h) => {
      const dot = h.sentiment > 0.12 ? 'var(--gn)' : h.sentiment < -0.12 ? 'var(--rd)' : 'var(--bd)';
      const link = /^https?:\/\//.test(h.url) ? esc(h.url) : '#';
      return `<a class="dnews-item" href="${link}" target="_blank" rel="noopener noreferrer">
        <span class="dnews-dot" style="background:${dot}"></span>
        <span class="dnews-t">${esc(h.title)}</span>
        <span class="hint mono">${esc(h.source)} · ${alter(h.published)}</span></a>`;
    })
    .join('');
  const veto = data?.news?.hardEvent
    && Date.now() / 1000 - data.news.hardEvent.published <= NEWS_VETO_WINDOW_SEC
    ? `<div class="hint" style="color:var(--yl,#d9a441)">⏸ News-Veto aktiv (${esc(data.news.hardEvent.type)}) — die Engine setzt neue Einstiege hier gerade aus.</div>`
    : '';
  sheet.innerHTML = `
    <button class="dclose" data-close="detail">✕</button>
    <h3></h3>
    <div class="dmeta"><span class="mono"></span><span>${CLASS_LABELS[data?.assetClass ?? ''] ?? ''}</span></div>
    <div class="vbig ${q ? pnlClass(q.changePct) : 'c-t3'}">${q ? fmtNum(q.price) : '—'}</div>
    <div class="smv ${q ? pnlClass(q.changePct) : 'c-t3'}">${q ? fmtPct(q.changePct) : 'Noch keine Scan-Daten — dieses Symbol steht gerade nicht in der Beobachtung.'}</div>
    <div class="dbtns">
      ${q ? '<button class="dbtn pri" id="dOpenChart">Im Chart öffnen</button>' : ''}
    </div>
    ${veto}
    ${newsHtml ? `<div class="wl-sec" style="margin-top:10px">Schlagzeilen</div><div class="dnews">${newsHtml}</div>` : ''}`;
  sheet.querySelector('h3')!.textContent = name;
  sheet.querySelector('.dmeta .mono')!.textContent = symbol;
  $('detailModal').classList.add('show');
  sheet.querySelector('#dOpenChart')?.addEventListener('click', () => {
    closeModal('detail');
    selectSymbol(symbol);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

const MODAL_IDS = {
  detail: 'detailModal',
  options: 'optModal',
  analytics: 'anModal',
} as const;
type ModalName = keyof typeof MODAL_IDS;

function closeModal(which: ModalName): void {
  $(MODAL_IDS[which]).classList.remove('show');
}

/* ── Portfolio (Wallet, Positionen, Trades) ─────────────────────────── */

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? '--' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Quote-Listener für Positions-Symbole nachführen (auf-/abbauen). */
function syncPositionQuotes(): void {
  if (!st) return;
  const needed = new Set(st.positions.map((p) => p.symbol));
  for (const [sym, unsub] of st.positionSubs) {
    if (!needed.has(sym)) {
      unsub();
      st.positionSubs.delete(sym);
      st.posPrices.delete(sym);
    }
  }
  for (const sym of needed) {
    if (st.positionSubs.has(sym)) continue;
    st.positionSubs.set(
      sym,
      watchMarketDoc(sym, (d) => {
        if (!st) return;
        if (d?.quote) st.posPrices.set(sym, d.quote.price);
        renderPortfolio();
      }),
    );
  }
}

/**
 * Exit-Transparenz je Position (Owner-Queue 26.07.: „warum verkauft die
 * Engine (nicht)?"): Abstand des Kurses zu Stop/Trailing/Take in Prozent
 * plus der nächste Exit-Kandidat. Rechnet EXAKT wie die Engine: gespeicherte
 * Level haben Vorrang, sonst die heutigen (klassen-aufgelösten) Prozente;
 * bei Shorts alles gespiegelt. ATR-adaptive Stops zeigt der Client als
 * Modus an (die exakte Schwelle kennt nur der Server-Scan).
 */
function exitOutlook(p: Position, live: number | undefined): string {
  if (!st || live === undefined || !(live > 0) || !(p.avgEntry > 0)) return '';
  const risk = resolveRisk(st.strategy.engine, classify(p.symbol));
  const short = p.side === 'short';
  const parts: string[] = [];
  const candidates: Array<{ label: string; dist: number }> = [];
  const fmt = (v: number): string => `${v.toFixed(1)} %`;

  const atrStop = (risk.atrStopMult ?? 0) > 0;
  const stopLevel = p.stopLoss ?? (atrStop || !(risk.stopLossPct > 0)
    ? null
    : short ? p.avgEntry * (1 + risk.stopLossPct / 100) : p.avgEntry * (1 - risk.stopLossPct / 100));
  if (stopLevel !== null) {
    const dist = (short ? (stopLevel - live) : (live - stopLevel)) / live * 100;
    parts.push(dist <= 0 ? '<b class="c-rd">Stop: löst beim nächsten Scan aus</b>' : `Stop in <b>${fmt(dist)}</b>`);
    candidates.push({ label: 'Stop', dist });
  } else if (atrStop) {
    parts.push('Stop: <b>ATR-adaptiv</b>');
  }

  const trail = risk.trailingStopPct ?? 0;
  if (trail > 0) {
    const armed = short ? (p.lowWater ?? p.avgEntry) < p.avgEntry : (p.highWater ?? 0) > p.avgEntry;
    if (armed) {
      const lvl = short
        ? (p.lowWater ?? p.avgEntry) * (1 + trail / 100)
        : (p.highWater ?? p.avgEntry) * (1 - trail / 100);
      const dist = (short ? (lvl - live) : (live - lvl)) / live * 100;
      parts.push(dist <= 0 ? '<b class="c-rd">Trailing: löst beim nächsten Scan aus</b>' : `Trailing in <b>${fmt(dist)}</b>`);
      candidates.push({ label: 'Trailing', dist });
    } else {
      parts.push('Trailing: <span title="Der nachziehende Stop schärft sich erst, wenn die Position im Gewinn war">wartet auf Gewinn</span>');
    }
  }

  const atrTake = (risk.atrTakeMult ?? 0) > 0;
  const takeLevel = p.takeProfit ?? (atrTake || !(risk.takeProfitPct > 0)
    ? null
    : short ? p.avgEntry * (1 - risk.takeProfitPct / 100) : p.avgEntry * (1 + risk.takeProfitPct / 100));
  if (takeLevel !== null) {
    const dist = (short ? (live - takeLevel) : (takeLevel - live)) / live * 100;
    parts.push(dist <= 0 ? '<b class="c-gn">Ziel: löst beim nächsten Scan aus</b>' : `Ziel in <b>${fmt(dist)}</b>`);
    candidates.push({ label: 'Ziel', dist });
  } else if (atrTake) {
    parts.push('Ziel: <b>ATR-adaptiv</b>');
  }

  // Zeitgrenze läuft in Tagen, nicht in Prozent — sie konkurriert deshalb
  // nicht um „nächster Exit", außer sie ist bereits erreicht.
  const maxDays = risk.maxHoldDays ?? 0;
  if (maxDays > 0 && Number.isFinite(Date.parse(p.openedAt))) {
    const left = maxDays - (Date.now() - Date.parse(p.openedAt)) / 86_400_000;
    parts.push(left <= 0 ? '<b>Zeitgrenze erreicht</b>' : `Zeit: noch <b>${left.toFixed(1)} Tg</b>`);
    if (left <= 0) candidates.push({ label: 'Zeitgrenze', dist: -1 });
  }

  const next = candidates.sort((a, b) => a.dist - b.dist)[0];
  if (next) parts.push(`<span class="pos-next">→ nächster Exit: ${next.label}</span>`);
  return parts.join(' · ');
}

function renderPortfolio(): void {
  if (!st) return;
  const cash = st.wallet?.paperBalance ?? null;
  let openPnl = 0;
  let posValue = 0;
  for (const p of st.positions) {
    const live = st.posPrices.get(p.symbol) ?? p.avgEntry;
    if (p.side === 'short') {
      // Short verdient am fallenden Kurs; im Depotwert steckt die
      // hinterlegte Margin (Einstand × Stück) plus unrealisiertes P&L.
      const pnl = (p.avgEntry - live) * p.qty;
      openPnl += pnl;
      posValue += p.avgEntry * p.qty + pnl;
    } else {
      openPnl += (live - p.avgEntry) * p.qty;
      posValue += live * p.qty;
    }
  }
  // Realisiertes P&L: Long-Verkäufe UND Short-Eindeckungen (buy mit pnl)
  const closers = st.trades.filter((t) => t.pnl !== undefined && t.pnl !== null);
  const closedPnl = closers.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = closers.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closers.length > 0 ? Math.round((wins / closers.length) * 100) : null;
  const totalPnl = closedPnl + openPnl;

  $('vCash').textContent = money(cash);
  $('vEq').textContent = cash !== null ? money(cash + posValue) : '--';
  const pnlEl = $('vPnl');
  pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + money(totalPnl).replace('$', '$');
  pnlEl.className = `vbig ${pnlClass(totalPnl)}`;
  const closedEl = $('vClosed');
  closedEl.textContent = money(closedPnl);
  closedEl.className = `smv ${pnlClass(closedPnl)}`;
  const unrealEl = $('vUnreal');
  unrealEl.textContent = money(openPnl);
  unrealEl.className = `smv ${pnlClass(openPnl)}`;
  $('vWR').textContent = winRate === null ? '--%' : `${winRate}%`;

  // Positionen-Tabelle
  $('pCount').textContent = `${st.positions.length} offen`;
  const body = $('pBody') as HTMLTableSectionElement;
  body.innerHTML = '';
  if (st.positions.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="c-t3">Keine offenen Positionen</td></tr>';
  }
  for (const p of st.positions) {
    const live = st.posPrices.get(p.symbol);
    const short = p.side === 'short';
    // Short: Gewinn bei fallendem Kurs — P&L und % gespiegelt
    const pnl = live !== undefined ? (short ? (p.avgEntry - live) : (live - p.avgEntry)) * p.qty : null;
    const pct = live !== undefined && p.avgEntry > 0
      ? (short ? (1 - live / p.avgEntry) : (live / p.avgEntry - 1)) * 100
      : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="color:var(--t1);font-weight:700"></td><td>${p.qty}</td>
      <td>${fmtNum(p.avgEntry)}</td><td>${live !== undefined ? fmtNum(live) : '--'}</td>
      <td class="${pnl !== null ? pnlClass(pnl) : ''}">${pnl !== null ? money(pnl) : '--'}</td>
      <td class="${pct !== null ? pnlClass(pct) : ''}">${pct !== null ? fmtPct(pct) : '--'}</td>
      <td><button class="hbtn" data-exit style="color:var(--rd)">${short ? 'Cover' : 'Exit'}</button></td>`;
    const symTd = tr.querySelector('td')!;
    symTd.textContent = p.symbol;
    if (short) {
      const tag = document.createElement('span');
      tag.className = 'stag t-sell';
      tag.style.marginLeft = '6px';
      tag.textContent = 'SHORT';
      tag.title = 'Leerverkauf — verdient am fallenden Kurs; „Cover" deckt ein';
      symTd.appendChild(tag);
    }
    tr.querySelector('[data-exit]')!.addEventListener('click', () => {
      // Short schließt per KAUF (Eindecken), Long per Verkauf
      void manualTrade(p.symbol, short ? 'buy' : 'sell');
    });
    body.appendChild(tr);
    // Exit-Transparenz (Owner-Queue): Abstände zu Stop/Trailing/Ziel + der
    // nächste Kandidat — damit sichtbar ist, WARUM die Engine (nicht) verkauft
    const outlook = exitOutlook(p, live);
    if (outlook) {
      const sub = document.createElement('tr');
      sub.className = 'pos-sub';
      sub.innerHTML = `<td colspan="7">${outlook}</td>`;
      body.appendChild(sub);
    }
  }

  renderJournal();
  // Nur nachziehen, wenn die Ansicht offen ist: Sechs Diagramme bei jedem
  // Portfolio-Render neu zu bauen, kostet bei jedem eintreffenden Trade
  // Rechenzeit für Markup, das niemand sieht.
  if ($('anModal')?.classList.contains('show')) renderAnalytics();
}

/**
 * Identität eines Trades ohne Doc-ID.
 *
 * Die Datenschicht liefert nur Feldwerte, keine IDs. Zeitstempel plus Symbol
 * plus Seite plus Stück reicht: Zwei Trades desselben Symbols in derselben
 * Millisekunde mit identischer Menge gibt es nicht — der Broker schreibt sie
 * in einer Transaktion nacheinander.
 */
function tradeKey(t: TradeRow): string {
  return `${t.executedAt}|${t.symbol}|${t.side}|${t.qty}`;
}

/** Eine ältere Seite anhängen (Knopf „Ältere laden"). */
async function ladeAeltereTrades(): Promise<void> {
  if (!st || st.tradesLoading || st.tradesDone || !st.tradesCursor) return;
  const uid = st.uid;
  st.tradesLoading = true;
  renderJournal();
  try {
    const seite = await loadMoreTrades(uid, st.tradesCursor);
    const bekannt = new Set(st.trades.map(tradeKey));
    // Dedup an der Naht: Der Cursor ist ein Zeitstempel, kein Doc-Cursor —
    // zwei Trades in derselben Millisekunde könnten sonst doppelt erscheinen.
    st.trades = [...st.trades, ...seite.rows.filter((t) => !bekannt.has(tradeKey(t)))];
    st.tradesCursor = seite.cursor ?? st.tradesCursor;
    st.tradesDone = seite.done;
  } catch (e) {
    console.warn('Ältere Trades nicht ladbar:', e);
  } finally {
    st.tradesLoading = false;
    renderPortfolio();
  }
}

/**
 * Die Handelshistorie als Tabelle.
 *
 * Bis 28.07. stand hier ein hartes `.slice(0, 20)` — und darüber holte die
 * Abfrage ohnehin nur 40 Zeilen. Der Owner sah also nie mehr als die
 * letzten paar Trades, ohne dass irgendwo stand, dass da noch mehr ist.
 * Jetzt: Live-Kopf (50) plus nachgeladene Seiten, alles sichtbar, mit
 * Zähler und zwei Filtern.
 *
 * Gefiltert wird NUR die Anzeige, nie die Datenbasis der Auswertungen —
 * sonst würde die Analyse-Karte je nach Filterfeld andere Kennzahlen zeigen
 * als die Trades, aus denen sie stammt.
 */
function renderJournal(): void {
  if (!st) return;
  const jb = $('jBody') as HTMLTableSectionElement;
  const filter = ($('jFilter') as HTMLInputElement | null)?.value.trim().toUpperCase() ?? '';
  const seite = ($('jSide') as HTMLSelectElement | null)?.value ?? '';
  const zeilen = st.trades.filter((t) => {
    if (filter && !t.symbol.toUpperCase().includes(filter)) return false;
    if (seite === 'closed') return t.pnl !== undefined && t.pnl !== null;
    if (seite) return t.side === seite;
    return true;
  });

  const zaehler = $('jCount');
  if (zaehler) {
    zaehler.textContent =
      zeilen.length === st.trades.length
        ? `${st.trades.length}${st.tradesDone ? '' : '+'}`
        : `${zeilen.length} / ${st.trades.length}${st.tradesDone ? '' : '+'}`;
  }
  const mehr = $('jMore') as HTMLButtonElement | null;
  if (mehr) {
    mehr.hidden = st.tradesDone;
    mehr.disabled = st.tradesLoading;
    mehr.textContent = st.tradesLoading ? 'Lädt …' : 'Ältere laden';
  }

  jb.innerHTML = '';
  if (zeilen.length === 0) {
    jb.innerHTML = `<tr><td colspan="6" class="c-t3">${
      st.trades.length === 0 ? 'Keine Trades' : 'Kein Treffer für diesen Filter'
    }</td></tr>`;
    return;
  }
  for (const t of zeilen) {
    const tr = document.createElement('tr');
    const time = new Date(t.executedAt).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    tr.innerHTML = `<td>${time}</td><td style="color:var(--t1)"></td>
      <td><span class="stag ${t.side === 'buy' ? 't-buy' : 't-sell'}">${t.side.toUpperCase()}</span></td>
      <td>${t.qty}</td><td>${fmtNum(t.price)}</td>
      <td class="${t.pnl !== undefined ? pnlClass(t.pnl) : ''}">${t.pnl !== undefined ? money(t.pnl) : '—'}</td>`;
    tr.querySelectorAll('td')[1]!.textContent = t.symbol + (t.source === 'engine' ? ' · Auto' : '');
    jb.appendChild(tr);
  }
}

/**
 * Handels-Analyse (Owner-Wunsch 28.07.).
 *
 * Sechs Ansichten auf DIESELBEN geladenen Trades — je mehr Seiten der Nutzer
 * nachlädt, desto tiefer reicht die Auswertung. Der Umfang steht deshalb im
 * Kopf der Karte: Eine Kennzahl aus 50 Trades sieht genauso aus wie eine aus
 * 5000, und ohne die Zahl daneben verwechselt man beides.
 *
 * Alle Aggregationen kommen aus `shared/src/tradeAnalytics.ts` (rein,
 * getestet), alles Gezeichnete aus `svgcharts.ts` (rein, kein DOM). Hier
 * steht nur die Verdrahtung.
 */
function renderAnalytics(): void {
  if (!st) return;
  const box = $('anBody');
  const scope = $('anScope');
  if (!box) return;

  const trades = st.trades as HistoryTrade[];
  const summary = historySummary(trades);
  if (summary.closed === 0) {
    box.innerHTML = '<div class="hint">Noch keine geschlossenen Trades.</div>';
    if (scope) scope.textContent = '';
    return;
  }
  if (scope) {
    scope.textContent = `${summary.closed} geschlossen${st.tradesDone ? '' : ' (geladen)'}`;
  }

  const geschlossen = closedOnly(trades);
  const stats = tradeStats(
    geschlossen.map((t) => ({ symbol: t.symbol, pnl: t.pnl!, riskExit: t.riskExit ?? null })),
  );
  const serie = equityCurve(trades).map((p) => p.value);
  const st_ = streaks(trades);

  // Ausstiegsgründe: die Frage, ob Stop und Take überhaupt erreicht werden
  // oder ob alles am Signal stirbt (MT1-Befund vom 27.07.).
  const exits = exitBreakdown(
    geschlossen.map((t) => ({ symbol: t.symbol, pnl: t.pnl!, riskExit: t.riskExit ?? null })),
  );
  const exitSlices = Object.entries(exits).map(([k, b]) => ({
    label: `${EXIT_LABELS[k] ?? k} (${b.n})`,
    value: b.pnl,
  }));

  const symbole = bySymbol(trades);
  const kpi = (label: string, wert: string, cls = ''): string =>
    `<div class="an-kpi"><span class="lbl">${esc(label)}</span><b class="mono ${cls}">${esc(wert)}</b></div>`;

  box.innerHTML = `
    <div class="an-kpis">
      ${kpi('Ergebnis', money(summary.pnl), pnlClass(summary.pnl))}
      ${kpi('Trefferquote', stats.winRatePct === null ? '—' : `${stats.winRatePct}%`)}
      ${kpi('Profit-Faktor', stats.profitFactor === null ? '—' : String(stats.profitFactor))}
      ${kpi('Ø je Trade', stats.expectancy === null ? '—' : money(stats.expectancy),
            pnlClass(stats.expectancy ?? 0))}
      ${kpi('Bester', summary.bestTrade === null ? '—' : money(summary.bestTrade), 'c-gn')}
      ${kpi('Schlechtester', summary.worstTrade === null ? '—' : money(summary.worstTrade), 'c-rd')}
      ${kpi('Längste Verlustserie', String(st_.longestLoss))}
      ${kpi('Laufende Serie', st_.current === 0 ? '—' : `${st_.current > 0 ? '+' : ''}${st_.current}`,
            st_.current > 0 ? 'c-gn' : st_.current < 0 ? 'c-rd' : '')}
    </div>

    <div class="an-grid">
      <section><h4>Kontoverlauf (realisiert) ${iBtn('anEquity')}</h4>${areaLine(serie)}</section>
      <section><h4>Verteilung der Ergebnisse ${iBtn('anHisto')}</h4>${histogram(pnlHistogram(trades))}</section>
      <section><h4>Ausstiegsgründe ${iBtn('exits')}</h4>${donut(exitSlices)}</section>
      <section><h4>Ergebnis je Symbol</h4>${hBarChart(
        symbole.slice(0, 8).map((b) => ({ label: b.key, value: b.pnl })),
      )}</section>
      <section><h4>Nach Wochentag (ET)</h4>${barChart(
        byWeekday(trades).map((b) => ({ label: b.key, value: b.pnl })),
        { labelJede: 1 },
      )}</section>
      <section><h4>Nach Handelsstunde (ET) ${iBtn('anStunde')}</h4>${barChart(
        byHour(trades).map((b) => ({ label: b.key, value: b.pnl })),
        { labelJede: 3 },
      )}</section>
    </div>`;
}

/** Ausstiegsgründe in Klartext — die Schlüssel kommen aus dem Broker. */
const EXIT_LABELS: Record<string, string> = {
  signal: 'Signal',
  stop_loss: 'Stop-Loss',
  take_profit: 'Take-Profit',
  trailing_stop: 'Trailing-Stop',
  max_hold: 'Haltedauer',
  emergency: 'Notbremse',
};

/* ── Portfolio-Kennzahlen (M12): Stats-Doc + Equity-Sparkline ──────────────
   Datenquelle ist ausschließlich der tägliche snapshotEquity-Lauf (Server) —
   das UI aggregiert hier bewusst NICHTS selbst, damit Live-Ansicht und
   Kennzahlen nie auseinanderlaufen. Sparkline als Inline-SVG (keine
   Chart-Lib-Instanz für 120 Punkte, kein position:fixed in Glass-Cards). */
function renderPfStats(): void {
  if (!st) return;
  const s = st.pfStats;
  const serie = st.equitySeries;
  const grid = $('pfGrid');
  const hint = $('pfHint');
  const spark = $('pfSpark') as unknown as SVGSVGElement;

  // Sparkline: Fläche + Linie; Färbung nach Gesamtrichtung der Serie
  spark.innerHTML = '';
  if (serie.length >= 2) {
    const eq = serie.map((p) => p.equity);
    const min = Math.min(...eq);
    const max = Math.max(...eq);
    const span = max - min || 1;
    const pts = eq.map((v, i) => {
      const x = (i / (eq.length - 1)) * 100;
      const y = 24 - ((v - min) / span) * 22; // 2px Luft oben/unten
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const up = eq[eq.length - 1]! >= eq[0]!;
    const color = up ? 'var(--gn)' : 'var(--rd)';
    spark.innerHTML =
      `<polygon points="0,26 ${pts.join(' ')} 100,26" fill="${up ? 'var(--gn-soft, rgba(52,199,123,.18))' : 'var(--rd-soft, rgba(255,95,95,.18))'}"></polygon>` +
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"></polyline>`;
    spark.removeAttribute('hidden');
  } else {
    spark.setAttribute('hidden', '');
  }

  if (!s || s.equityDays === 0) {
    grid.hidden = true;
    hint.hidden = false;
    return;
  }
  grid.hidden = false;
  const days = s.equityDays;
  // Ehrlichkeit vor Optik: mit wenigen Snapshot-Tagen sind Sharpe & Co. noch
  // Rauschen — der Hinweis bleibt sichtbar, bis eine Woche Kurve da ist.
  hint.hidden = days >= 7;
  if (!hint.hidden) {
    hint.textContent = `Erst ${days} Snapshot-Tag${days === 1 ? '' : 'e'} — Kennzahlen werden mit jeder weiteren Kurve aussagekräftiger (täglich 23:15).`;
  }
  const num = (v: number | null | undefined, digits = 2, suffix = ''): string =>
    v === null || v === undefined ? '--' : `${v.toFixed(digits)}${suffix}`;
  $('pfS30').textContent = num(s.sharpe30);
  $('pfS90').textContent = num(s.sharpe90);
  const dd = $('pfDD');
  dd.textContent = num(s.maxDDPct, 2, ' %');
  dd.className = `smv mono ${s.maxDDPct !== null && s.maxDDPct > 0 ? 'c-rd' : ''}`;
  $('pfHwm').textContent = s.hwm === null ? '--' : money(s.hwm);
  $('pfPF').textContent = num(s.profitFactor);
  const exp = $('pfExp');
  exp.textContent = s.expectancy === null ? '--' : money(s.expectancy);
  exp.className = `smv mono ${s.expectancy !== null ? pnlClass(s.expectancy) : ''}`;
  renderExits(s);
  renderCosts(s);
}

/** Klarnamen der Ausstiegsgründe — `signal` ist der Sammeltopf ohne Risiko-Exit. */
const EXIT_LABEL: Record<string, string> = {
  signal: 'Signal',
  stop_loss: 'Stop-Loss',
  take_profit: 'Take-Profit',
  trailing_stop: 'Trailing-Stop',
  max_hold: 'Haltedauer',
};

/**
 * Ausstiegsgründe (MT1). Die Zeile beantwortet die Frage, die man sonst von
 * Hand zurückrechnen musste: Erreichen die Trades ihre Risiko-Marken
 * überhaupt? Steht fast alles unter „Signal", entscheidet nicht die
 * Risikosteuerung über das Ergebnis, sondern eine gekippte Indikator-Stimme.
 */
function renderExits(s: PortfolioStatsDoc): void {
  const box = $('pfExits');
  const rows = Object.entries(s.exits ?? {}).sort((a, b) => b[1].n - a[1].n);
  const total = rows.reduce((a, [, b]) => a + b.n, 0);
  if (total === 0) {
    box.innerHTML = '<div class="hint">Noch keine geschlossenen Trades.</div>';
    return;
  }
  box.innerHTML = rows
    .map(([key, b]) => {
      const anteil = Math.round((b.n / total) * 100);
      // Unbekannte Schlüssel kommen aus der Datenbank — auf harmlose Zeichen
      // beschränken, statt sie ungeprüft in HTML zu setzen.
      const name = EXIT_LABEL[key] ?? key.replace(/[^\w-]/g, '');
      return (
        `<div class="fl-row"><span>${name}</span>` +
        `<span class="mono">${b.n}× · ${anteil} %</span>` +
        `<span class="mono ${pnlClass(b.pnl)}">${money(b.pnl)}</span></div>`
      );
    })
    .join('');
}

/**
 * Kostenprofil (MT1). `edgeOverCost` ist die eine Zahl, auf die es ankommt:
 * Ø Gewinnbewegung geteilt durch die Roundtrip-Kosten. Unter 2 verdient
 * überwiegend der Broker — die Testkonten des Owners lagen bei 1,6 und 1,9.
 */
function renderCosts(s: PortfolioStatsDoc): void {
  const grid = $('pfCostGrid');
  const hint = $('pfCostHint');
  const c = s.costs;
  if (!c || c.n === 0) {
    grid.hidden = true;
    hint.textContent = 'Reibung wird ab dem ersten geschlossenen Trade mit Gebührensatz gemessen.';
    return;
  }
  grid.hidden = false;
  const pct = (v: number | null): string => (v === null ? '--' : `${v.toFixed(2)} %`);
  $('pfFees').textContent = money(c.fees);
  $('pfFeeShare').textContent = c.feeSharePct === null ? '--' : `${c.feeSharePct.toFixed(0)} %`;
  $('pfGrossWin').textContent = pct(c.avgWinGrossPct);
  $('pfGrossLoss').textContent = pct(c.avgLossGrossPct);
  $('pfRt').textContent = pct(c.roundTripPct);

  const edge = $('pfEdge');
  edge.textContent = c.edgeOverCost === null ? '--' : `${c.edgeOverCost.toFixed(2)}×`;
  // Ampel bewusst streng: Bei Faktor 2 gehen immer noch 50 % jeder
  // Gewinnbewegung an Gebühren und Slippage.
  edge.className = `smv mono ${
    c.edgeOverCost === null ? '' : c.edgeOverCost >= 3 ? 'c-gn' : c.edgeOverCost >= 2 ? '' : 'c-rd'
  }`;
  hint.textContent =
    c.edgeOverCost === null
      ? ''
      : c.edgeOverCost < 2
        ? `Zu wenig Luft: Die durchschnittliche Gewinnbewegung ist nur das ${c.edgeOverCost.toFixed(1)}-Fache der Handelskosten — davon bleibt kaum etwas übrig. Längere Haltedauer oder größerer Zeitrahmen hilft.`
        : `Die durchschnittliche Gewinnbewegung ist das ${c.edgeOverCost.toFixed(1)}-Fache der Handelskosten.`;
}

/**
 * Momentum-Ranking (Owner-Go 28.07.).
 *
 * Zwei Dinge müssen hier sichtbar sein, sonst ist die Karte Dekoration:
 * der Zustand des MARKTFILTERS (steht er zu, ist Flachbleiben die Strategie,
 * kein Fehler) und die Zahl der bewertbaren Symbole (sie wächst, während der
 * Katalog seine Historie nachholt — ein kleines Universum am Anfang ist
 * erwartetes Verhalten, kein Datenverlust).
 */
function renderMomentum(m: MomentumDoc | null): void {
  const box = $('moTop');
  const filter = $('moFilter');
  if (!m) {
    filter.textContent = '';
    box.innerHTML = '<div class="hint">Das erste Ranking entsteht mit dem nächsten Tages-Lauf (18:00 ET).</div>';
    return;
  }
  filter.textContent = m.marktOffen ? 'Markt offen' : 'Markt ZU';
  filter.className = `tn-tag${m.marktOffen ? ' tn-ok' : ''}`;
  $('moEq').textContent = money(m.equity);
  $('moTrades').textContent = String(m.trades);
  $('moRanked').textContent = `${m.ranked}/${m.universum}`;

  const gehalten = new Set(m.gehalten ?? []);
  const top = m.top ?? [];
  box.innerHTML =
    top.length === 0
      ? '<div class="hint">Kein Symbol mit positivem Momentum — das Depot bleibt flach.</div>'
      : top
          .map((t) => {
            const drin = gehalten.has(t.symbol);
            return (
              `<div class="fl-row"><span>${esc(t.symbol)}</span>` +
              `<span class="mono ${pnlClass(t.score)}">${t.score >= 0 ? '+' : ''}${t.score.toFixed(1)} %</span>` +
              `<span class="mono">${drin ? 'gehalten' : '—'}</span></div>`
            );
          })
          .join('');

  const teile: string[] = [];
  if (!m.marktOffen) {
    teile.push(
      'Der Leitindex steht unter seiner 200-Tage-Linie — es wird nichts gekauft. ' +
        'Momentum-Einbrüche passieren fast immer in Erholungsphasen nach Markteinbrüchen; ' +
        'flach zu bleiben ist hier die Strategie, nicht ihr Ausfall.',
    );
  }
  if (m.fehlendeHistorie > 0) {
    teile.push(
      `${m.fehlendeHistorie} Symbol(e) haben noch keine 12-Monats-Historie und nehmen am Ranking nicht teil — ` +
        'die Lücke schließt sich täglich.',
    );
  }
  $('moHint').textContent = teile.join(' ');
}

/* ── Auto-Tuner: Flotte und Journal (MT5) ─────────────────────────────────── */

/**
 * Fortschritt der Schatten-Flotte.
 *
 * Der Balken zeigt die Stichprobe gegen die Evidenzschwelle. Das ist die
 * ehrliche Antwort auf „warum ändert sich nichts?": Meist nicht, weil nichts
 * besser wäre, sondern weil noch keine Variante genug Trades für ein
 * belastbares Urteil hat.
 */
/**
 * Was das KOLLEKTIV gelernt hat (Owner-Wunsch 28.07.).
 *
 * Bewusst mit sichtbarer Vertrauensangabe: Eine Zeile „Kauf-Pause 60 min —
 * 82 % übernommen" ohne die Zahl der beitragenden Konten daneben liest sich
 * wie eine Tatsache, obwohl sie aus drei Konten stammen kann. Wer sich
 * danach richtet, soll sehen, worauf sie steht.
 */
function renderTuneGlobal(stats: GlobalAxisStats): void {
  const box = $('tnGlobal');
  if (!box) return;
  const priors = buildPriors(stats);
  if (priors.length === 0) {
    const roh = Object.keys(stats).length;
    box.innerHTML = `<div class="hint">${
      roh === 0
        ? 'Noch keine Prüfungen im Kollektiv.'
        : `${roh} Einstellung(en) in Beobachtung — es fehlen noch Konten oder Prüfungen für ein belastbares Urteil.`
    }</div>`;
    return;
  }
  box.innerHTML = priors
    .slice(0, 6)
    .map((p) => {
      const s = stats[p.variantId];
      const quote = Math.round(p.promoteRate * 100);
      return (
        `<div class="tn-fl"><span class="tn-nm">${esc(labelVariantId(p.variantId))}</span>` +
        `<span class="tn-bar"><i style="width:${quote}%"></i></span>` +
        `<span class="mono">${quote}% · ${s?.accounts ?? 0} Konten</span>` +
        `<span class="mono ${pnlClass(p.meanEdge)}">${money(p.meanEdge)}</span></div>`
      );
    })
    .join('');
}

function renderTuneFleet(rows: TuneFleetRow[]): void {
  const box = $('tnFleet');
  if (rows.length === 0) {
    box.innerHTML = '<div class="hint">Die Flotte startet mit dem nächsten Scan.</div>';
    return;
  }
  const ziel = EVIDENCE_DEFAULTS.minTrades;
  box.innerHTML = rows
    .map((r) => {
      const anteil = Math.min(100, Math.round((r.trades / ziel) * 100));
      const offen = r.open > 0 ? ` · ${r.open} offen` : '';
      return (
        `<div class="tn-fl"><span class="tn-nm">${esc(labelVariantId(r.id))}</span>` +
        `<span class="tn-bar"><i style="width:${anteil}%"></i></span>` +
        `<span class="mono">${r.trades}/${ziel}${offen}</span>` +
        `<span class="mono ${pnlClass(r.pnl)}">${r.trades > 0 ? money(r.pnl) : '--'}</span></div>`
      );
    })
    .join('');
}

/**
 * Das Änderungs-Journal (MT5).
 *
 * Bewusst mit Begründung UND Zahlen: Ein Automat, der am Depot dreht, muss
 * nachprüfbar sein. Die abgelehnten Prüfungen stehen gleichberechtigt drin —
 * ein Journal, das nur Erfolge zeigt, verschweigt gerade das Interessante.
 */
function renderTuneLog(rows: TuneLogRow[]): void {
  const box = $('tnLog');
  if (rows.length === 0) {
    box.innerHTML =
      '<div class="hint">Noch keine Prüfung — der Tuner urteilt täglich nach US-Schluss.</div>';
    return;
  }
  box.innerHTML = rows
    .map((r) => {
      const zeit = new Date(r.at).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const marke = r.promoted
        ? '<span class="tn-tag tn-ok">übernommen</span>'
        : '<span class="tn-tag">abgelehnt</span>';
      // p-Wert und Stichproben immer mitzeigen: Ohne sie ist „abgelehnt" eine
      // Behauptung, mit ihnen eine nachrechenbare Aussage.
      const zahlen =
        r.nCandidate > 0
          ? `n=${r.nCandidate} vs. ${r.nIncumbent}` +
            (r.p !== null ? ` · p=${r.p.toFixed(3)}` : '') +
            ` · Vorsprung ${r.edge >= 0 ? '+' : ''}${r.edge.toFixed(2)}`
          : 'noch keine Schatten-Trades';
      return (
        `<div class="tn-e"><div class="tn-h"><span class="tn-nm">${esc(r.change || labelVariantId(r.variantId))}</span>${marke}` +
        `<span class="tn-t mono">${zeit}</span></div>` +
        `<div class="tn-r">${esc(r.reason)}</div>` +
        `<div class="tn-n mono">${zahlen}</div></div>`
      );
    })
    .join('');
}

async function manualTrade(symbol: string, side: 'buy' | 'sell'): Promise<void> {
  const hint = $('mtHint');
  hint.textContent = 'Sende Order…';
  try {
    const qty = Math.max(1, Number(($('mQty') as HTMLInputElement).value) || 1);
    await callTrade({ symbol, side, ...(side === 'buy' ? { qty } : {}) });
    hint.textContent = `${side === 'buy' ? 'Gekauft' : 'Verkauft'}: ${symbol} — Ausführung inkl. Gebühren, siehe Trade-Historie.`;
  } catch (e) {
    hint.textContent = (e as { message?: string }).message ?? 'Order fehlgeschlagen';
  }
}

/* ── Trade-Fenster (Redesign, User-Wunsch 25.07.): Katalog-Picker,
   Live-Summen inkl. Gebühren, Kaufkraft-Check, 2-Schritt-Bestätigung ── */

const mtState: {
  sym: string | null;
  price: number | null;
  subs: Unsubscribe[];
  arm: { side: 'buy' | 'sell'; timer: number } | null;
} = { sym: null, price: null, subs: [], arm: null };

function mtDisarm(): void {
  if (mtState.arm !== null) window.clearTimeout(mtState.arm.timer);
  mtState.arm = null;
  $('mtBuy').textContent = 'Kaufen';
  $('mtSell').textContent = 'Verkaufen';
}

/** Summen + Kaufkraft live nachrechnen (gleiche Konditionen wie der Server). */
function mtRecompute(): void {
  const qty = Math.max(1, Number(($('mQty') as HTMLInputElement).value) || 1);
  const price = mtState.price;
  const balance = st?.wallet?.paperBalance ?? null;
  const fmt = (v: number): string => money(v);
  if (price === null || price <= 0) {
    for (const id of ['mtSub', 'mtFee', 'mtTotal', 'mtCash']) $(id).textContent = '--';
    return;
  }
  const sub = qty * price;
  const fee = sub * PAPER_FEE_RATE;
  const total = sub + fee;
  $('mtSub').textContent = fmt(sub);
  $('mtFee').textContent = fmt(fee);
  $('mtTotal').textContent = fmt(total);
  const cashEl = $('mtCash');
  if (balance === null) {
    cashEl.textContent = '--';
  } else {
    const after = balance - total;
    cashEl.textContent = fmt(after);
    cashEl.className = `mono ${after < 0 ? 'c-rd' : ''}`;
  }
}

/** Symbol wählen: Live-Kurs, Tages-%, RSI/MACD/Signal des Symbols abonnieren. */
function mtSelect(sym: string): void {
  mtDisarm();
  mtState.sym = sym;
  mtState.price = null;
  ($('mSym') as HTMLInputElement).value = sym;
  $('mSymList').hidden = true;
  $('mtInfo').hidden = false;
  $('mtName').textContent = resolveName(sym);
  clearSubs(mtState.subs);
  mtState.subs.push(
    watchMarketDoc(sym, (d) => {
      const q = d?.quote;
      mtState.price = q?.price ?? null;
      $('mtPx').textContent = q ? fmtNum(q.price) : '--';
      const chg = $('mtChg');
      chg.textContent = q ? fmtPct(q.changePct) : '--';
      chg.className = `smv mono ${q ? pnlClass(q.changePct) : ''}`;
      mtRecompute();
    }),
    watchLatestIndicators(sym, (row) => {
      $('mtRsi').textContent = row?.rsi != null ? row.rsi.toFixed(1) : '--';
      const m = $('mtMacd');
      if (row?.macd) {
        const bull = row.macd.histogram > 0;
        m.textContent = bull ? '↑ bullisch' : '↓ bärisch';
        m.className = `smv ${bull ? 'c-gn' : 'c-rd'}`;
      } else {
        m.textContent = '--';
        m.className = 'smv';
      }
    }),
    watchLatestSignal(sym, (sig) => {
      const el = $('mtSig');
      el.textContent = sig ? sig.direction.toUpperCase() : '--';
      el.className = `smv ${sig?.direction === 'buy' ? 'c-gn' : sig?.direction === 'sell' ? 'c-rd' : 'c-t3'}`;
    }),
  );
}

function wireManualTrade(): void {
  const inp = $('mSym') as HTMLInputElement;
  const list = $('mSymList');
  const renderList = (filter: string): void => {
    const f = filter.trim().toLowerCase();
    const all = paletteSymbols();
    const hits = (f
      ? all.filter((s) => s.symbol.toLowerCase().includes(f) || s.name.toLowerCase().includes(f))
      : all
    ).slice(0, 12);
    list.innerHTML = hits
      .map((s) => `<button type="button" data-sym="${s.symbol}"><b class="mono">${s.symbol}</b> — ${s.name}</button>`)
      .join('');
    list.hidden = hits.length === 0;
    list.querySelectorAll<HTMLButtonElement>('[data-sym]').forEach((b) =>
      b.addEventListener('click', () => mtSelect(b.dataset['sym']!)),
    );
  };
  inp.addEventListener('input', () => renderList(inp.value));
  inp.addEventListener('focus', () => renderList(inp.value));
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = list.querySelector<HTMLButtonElement>('[data-sym]');
      const typed = inp.value.trim().toUpperCase();
      if (first && !list.hidden) mtSelect(first.dataset['sym']!);
      else if (typed) mtSelect(typed);
    }
    if (ev.key === 'Escape') list.hidden = true;
  });
  document.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('.mt-combo')) list.hidden = true;
  });
  $('mQty').addEventListener('input', () => {
    mtDisarm();
    mtRecompute();
  });
  $('mtMax').addEventListener('click', () => {
    const price = mtState.price;
    const balance = st?.wallet?.paperBalance ?? 0;
    if (price === null || price <= 0) return;
    const max = Math.floor(balance / (price * (1 + PAPER_FEE_RATE)));
    ($('mQty') as HTMLInputElement).value = String(Math.max(1, max));
    mtDisarm();
    mtRecompute();
  });
  const armOrRun = (side: 'buy' | 'sell'): void => {
    const sym = mtState.sym ?? (inp.value || st?.currentSymbol || '').trim().toUpperCase();
    if (!sym) return;
    if (mtState.arm?.side === side) {
      mtDisarm();
      void manualTrade(sym, side);
      return;
    }
    mtDisarm();
    const qty = Math.max(1, Number(($('mQty') as HTMLInputElement).value) || 1);
    const total = mtState.price !== null ? money(qty * mtState.price * (1 + PAPER_FEE_RATE)) : '';
    $(side === 'buy' ? 'mtBuy' : 'mtSell').textContent =
      side === 'buy'
        ? `✓ ${qty} × ${sym}${total ? ` für ${total}` : ''} — bestätigen`
        : `✓ Position ${sym} komplett verkaufen — bestätigen`;
    // 6 s Bedenkzeit, dann entschärfen — verhindert versehentliche Doppelklicks
    mtState.arm = { side, timer: window.setTimeout(mtDisarm, 6000) };
  };
  $('mtBuy').addEventListener('click', () => armOrRun('buy'));
  $('mtSell').addEventListener('click', () => armOrRun('sell'));
  if (st) mtSelect(st.currentSymbol); // Start: aktuelles Chart-Symbol vorwählen
}

/* ── Uhr ────────────────────────────────────────────────────────────── */

function updateClock(): void {
  const et = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  $('marketClock').textContent = et;
  const [h, m] = et.split(':').map(Number);
  const mins = (h ?? 0) * 60 + (m ?? 0);
  for (const id of ['phPre', 'phMain', 'phAft']) $(id).classList.remove('active');
  if (mins >= 570 && mins < 960) $('phMain').classList.add('active');
  else if (mins >= 240 && mins < 570) $('phPre').classList.add('active');
  else $('phAft').classList.add('active');
}

/* ── Mount / Unmount ────────────────────────────────────────────────── */

export function mountDashboard(root: HTMLElement, uid: string, email: string): void {
  initInfoTips(); // ⓘ-Erklär-Popover (idempotent)
  root.innerHTML = layout(email);
  st = {
    uid,
    email,
    strategy: DEFAULT_STRATEGY,
    currentSymbol: DEFAULT_STRATEGY.watchlist[0] ?? 'QQQ',
    universe: null,
    marketClass: 'indices',
    chart: null,
    bars: [],
    range: 66,
    intradayDays: 0,
    intradayBars: [],
    histBars: [],
    histOldest: 0,
    histLoading: false,
    histDone: false,
    autoRes: localStorage.getItem('autotrd-chart-auto') !== '0',
    aggMinutes: 5,
    shownIntraday: [],
    yAuto: localStorage.getItem('autotrd-chart-yauto') !== '0',
    chartFitPending: true,
    prediction: null,
    predMode: false,
    ui: { predArrow: false, cmpOverlay: true, chartGrid: true, subPanels: true },
    collapsed: new Set((localStorage.getItem('autotrd-collapsed') ?? '').split(',').filter(Boolean)),
    cleanView: localStorage.getItem('autotrd-chart-clean') === '1',
    lastSignalDir: 'hold',
    subCharts: { rsi: null, macd: null },
    chartLayers: new Set((localStorage.getItem('autotrd-chart-layers') ?? '').split(',').filter(Boolean)),
    gridMode: 1,
    mainLocked: false,
    gridPanels: [],
    overlaySymbol: null,
    overlayBars: [],
    wallet: null,
    positions: [],
    trades: [],
    forecast: null,
    forecastIntraday: null,
    chartGroup: 'A',
    chart2Group: 'B',
    chart2Symbol: DEFAULT_STRATEGY.watchlist[1] ?? 'QQQ',
    chart2: null,
    chart2Bars: [],
    chart2Subs: [],
    chart2P: {
      sym: DEFAULT_STRATEGY.watchlist[1] ?? 'QQQ',
      range: 66,
      locked: false,
      chart: null,
      bars: [],
      subs: [],
      epoch: 0,
      fitPending: true,
      forecast: null,
      forecastIntraday: null,
      intradayDays: 0,
      intradayBars: [],
      auto: false,
    },
    lastQuote: null,
    orderSide: 'buy',
    hotkeys: { ...HOTKEY_DEFAULTS },
    wsPreset: 'ueberblick',
    wsHidden: new Set(DEFAULT_HIDDEN),
    wsOrder: {},
    chartTypeSel: ((): ChartType => {
      const t = (localStorage.getItem('autotrd-chart-style') ?? '').split('|')[0];
      return ['candles', 'hollow', 'heikin', 'line', 'area', 'baseline', 'bars'].includes(t ?? '')
        ? (t as ChartType)
        : 'candles';
    })(),
    scaleMode: ((): 0 | 1 | 2 => {
      const m = Number((localStorage.getItem('autotrd-chart-style') ?? '').split('|')[1]);
      return m === 1 || m === 2 ? m : 0;
    })(),
    typeCombine: (localStorage.getItem('autotrd-chart-style') ?? '').split('|')[2] === '1',
    hudOpen: (localStorage.getItem('autotrd-hud') ?? (window.innerWidth > 640 ? '1' : '0')) === '1',
    ohlcOpen: (localStorage.getItem('autotrd-ohlc') ?? '1') === '1',
    wsSaveTimer: null,
    paletteDispose: null,
    showForecast: true,
    posPrices: new Map(),
    pfStats: null,
    equitySeries: [],
    subs: [],
    symbolSubs: [],
    watchlistSubs: [],
    watched: [],
    tradesCursor: null,
    tradesDone: false,
    tradesLoading: false,
    catalogOpen: 0,
    catalogQuotes: 0,
    positionSubs: new Map(),
    timers: [],
  };
  seedSymbols({ A: st.currentSymbol, B: st.chart2Symbol, C: st.currentSymbol });

  // Auto-Tuner-Schalter: schreibt genau das Feld, das `tuneAll` serverseitig
  // prüft. Kein Callable nötig — es ist eine Einstellung, kein Geld-Vorgang.
  $('tnOn').addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    void saveAutoTune(uid, box.checked).catch(() => {
      box.checked = !box.checked; // Schreiben fehlgeschlagen → Anzeige ehrlich halten
    });
  });

  // User-Doc: Strategie (Formular/Watchlist) + Wallet folgen Firestore
  st.subs.push(
    watchUserDoc(uid, ({ strategy, wallet, hotkeys, ui, autoTune }) => {
      if (!st) return;
      st.strategy = strategy ?? DEFAULT_STRATEGY;
      st.wallet = wallet;
      ($('tnOn') as HTMLInputElement).checked = autoTune;
      st.ui = {
        predArrow: ui?.predArrow === true,
        cmpOverlay: ui?.cmpOverlay !== false,
        chartGrid: ui?.chartGrid !== false,
        subPanels: ui?.subPanels !== false,
        marketGroups: ui?.marketGroups ?? {},
      };
      applyUiPrefs();
      const prevPalette = st.hotkeys.palette;
      st.hotkeys = { ...HOTKEY_DEFAULTS, ...(hotkeys ?? {}) };
      if (st.hotkeys.palette !== prevPalette && st.paletteDispose) {
        st.paletteDispose();
        st.paletteDispose = initPalette({
          hotkey: st.hotkeys.palette ?? 'ctrl+k',
          symbols: () => paletteSymbols(),
          commands: () => paletteCommands(),
          onSymbol: (sym) => {
            if (st) publishSymbol(st.chartGroup, sym);
          },
        });
      }
      fillForm(st.strategy);
      renderPortfolio();
    }),
    // Beobachtete Symbole: kommen vom Scan, nicht aus der Strategie. Ändert
    // sich die Liste (neues Momentum-Ranking, neue Position), baut sich die
    // Livebar neu auf — sonst zeigte das Dashboard eine Auswahl von gestern.
    watchWatchedSymbols(({ symbols, catalogOpen, catalogQuotes }) => {
      if (!st) return;
      st.catalogOpen = catalogOpen;
      st.catalogQuotes = catalogQuotes;
      renderWatchHint();
      const vorher = st.watched.join(',');
      st.watched = symbols;
      if (symbols.join(',') === vorher && $('liveBar').childElementCount > 0) return;
      const sichtbar = watchedSymbols();
      if (!sichtbar.includes(st.currentSymbol)) {
        publishSymbol(st.chartGroup, sichtbar[0] ?? st.currentSymbol);
      }
      wireWatchlist();
      renderStrategyChips();
    }),
    watchPositions(uid, (positions) => {
      if (!st) return;
      st.positions = positions;
      syncPositionQuotes();
      renderPortfolio();
    }),
    // Live-Kopf: die neuesten 50. Nachgeladene ältere Seiten bleiben erhalten
    // und werden hinten angehängt — sonst würde jeder neue Trade (alle fünf
    // Minuten einer) die ganze nachgeladene Historie wieder wegwerfen.
    watchTrades(uid, (kopf) => {
      if (!st) return;
      const bekannt = new Set(kopf.map(tradeKey));
      const aeltere = st.trades.filter((t) => !bekannt.has(tradeKey(t)));
      st.trades = [...kopf, ...aeltere];
      if (st.tradesCursor === null) {
        st.tradesCursor = kopf[kopf.length - 1]?.executedAt ?? null;
        st.tradesDone = kopf.length < TRADE_PAGE;
      }
      renderPortfolio();
    }),
    watchPortfolioStats(uid, (stats) => {
      if (!st) return;
      st.pfStats = stats;
      renderPfStats();
    }),
    watchEquitySeries(uid, (points) => {
      if (!st) return;
      st.equitySeries = points;
      renderPfStats();
    }),
    watchForecastStats((stats) => {
      $('fcAcc').textContent =
        stats?.dirAccuracy != null ? `${stats.dirAccuracy.toFixed(1)} %` : '--';
      $('fcScored').textContent = String(stats?.scored ?? 0);
      $('fcLb').textContent = stats?.best ? String(stats.best.lookback) : '--';
      $('fcTuning').textContent = stats?.tuningActive
        ? 'Self-Tuning aktiv: Live-Prognosen nutzen die historisch beste Kombi.'
        : 'Self-Tuning sammelt Evidenz — Defaults aktiv, bis genug Prognosen realisiert sind.';
      renderFcLabStats('flCombos', stats);
    }),
    watchForecastStatsIntraday((stats) => renderFcLabStats('flCombosIntra', stats)),
    watchMomentum(renderMomentum),
    watchTuneFleet(uid, renderTuneFleet),
    watchTuneLog(uid, renderTuneLog),
    watchTuneGlobal(renderTuneGlobal),
  );

  // Link-Bus (M9): Chart- und News-Kontext folgen ihrer jeweiligen Gruppe.
  busSubscribe(CHART_KEY, st.chartGroup, (sym) => {
    if (!st || st.currentSymbol === sym) return;
    st.currentSymbol = sym;
    markLivebar(sym);
    void rebuildChart();
    wireChartCtx();
    scheduleWsSave();
  });
  // Gruppen-Wechsel: das Panel NIMMT sein Symbol MIT (die neue Gruppe
  // adoptiert es) — so heißt „News auf B" wirklich „News bleibt stehen,
  // während A weiterschaltet", statt zum alten B-Symbol zu springen.
  busSubscribe(CHART2_KEY, st.chart2Group, (sym) => {
    if (!st || st.chart2Symbol === sym) return;
    st.chart2Symbol = sym;
    wireChart2Ctx();
    void rebuildChart2();
    scheduleWsSave();
  });
  $('chipChart2').addEventListener('click', () => {
    if (!st) return;
    st.chart2Group = nextGroup(st.chart2Group);
    seedSymbols({ [st.chart2Group]: st.chart2Symbol });
    setGroup(CHART2_KEY, st.chart2Group);
    paintChips();
    scheduleWsSave();
  });
  $('chipChart').addEventListener('click', () => {
    if (!st) return;
    st.chartGroup = nextGroup(st.chartGroup);
    seedSymbols({ [st.chartGroup]: st.currentSymbol });
    setGroup(CHART_KEY, st.chartGroup);
    paintChips();
    scheduleWsSave();
  });

  wireWatchlist();
  wireChartCtx();
  wireChart2Ctx();
  paintChips();
  applyPanels();
  void rebuildChart();
  void renderMarketTabs();
  updateClock();
  st.timers.push(window.setInterval(updateClock, 1000));
  // Kurz-Updates (Chart-Audit 2): aktives Symbol alle 45 s frisch vom Server
  // (quoteNow schreibt in market/{sym}.quote — alle Clients sehen es sofort).
  // Nur bei sichtbarem Tab; Quota deckelt serverseitig, Fehler sind still.
  st.timers.push(
    window.setInterval(() => {
      if (!st || document.visibilityState !== 'visible') return;
      callQuoteNow(st.currentSymbol).catch(() => undefined);
    }, 45_000),
  );
  mountLegalFooter(root);

  // Gespeicherten Workspace anwenden (Preset, Panels, Gruppen, Symbole)
  void loadWorkspace(uid).then((ws) => {
    if (!st || !ws) return;
    st.wsPreset = ws.preset ?? 'ueberblick';
    st.wsHidden = new Set(
      Object.keys(PANEL_TITLES).filter((id) => {
        const cfg = ws.panels?.[id];
        return cfg ? cfg.hidden === true : DEFAULT_HIDDEN.has(id);
      }),
    );
    st.wsOrder = Object.fromEntries(
      Object.entries(ws.panels ?? {})
        .filter(([, cfg]) => typeof cfg?.order === 'number')
        .map(([id, cfg]) => [id, cfg.order as number]),
    );
    applyPanels();
    applyPanelOrder();
    const g = (v: unknown): LinkGroup => (v === 'B' || v === 'C' ? v : 'A');
    st.chartGroup = g(ws.groups?.chart);
    st.chart2Group = ws.groups?.chart2 === 'A' || ws.groups?.chart2 === 'C' ? ws.groups.chart2 : 'B';
    const symbols: Partial<Record<LinkGroup, string>> = {};
    for (const grp of ['A', 'B', 'C'] as const) {
      const sym = ws.symbols?.[grp];
      if (typeof sym === 'string' && sym) symbols[grp] = sym;
    }
    seedSymbols(symbols);
    setGroup(CHART_KEY, st.chartGroup);
    setGroup(CHART2_KEY, st.chart2Group);
    paintChips();
  });

  // Test-Hooks (E2E): Chart-Sync von außen mess- und triggerbar
  (window as unknown as { __autotrdCharts?: unknown }).__autotrdCharts = {
    mainRange: () => st?.chart?.getVisibleRange() ?? null,
    secondRange: () => st?.chart2?.getVisibleRange() ?? null,
    setMainRange: (r: { from: number; to: number }) => st?.chart?.setVisibleRange(r),
    refreshMain: () => renderChart(),
    mainOverlays: () => st?.chart?.overlayCount() ?? -1,
    gridPanels: () => st?.gridPanels.length ?? -1,
    gridPanelOverlays: (i: number) => st?.gridPanels[i]?.chart?.overlayCount() ?? -1,
    panelAreaActive: (i: number) => st?.gridPanels[i]?.chart?.areaActive() ?? false,
    panelForecastActive: (i: number) => st?.gridPanels[i]?.chart?.forecastActive() ?? false,
    mainForecastActive: () => st?.chart?.forecastActive() ?? false,
    mainTypeCombine: () => st?.chart?.typeCombineActive() ?? false,
    panelTypeCombine: (i: number) => st?.gridPanels[i]?.chart?.typeCombineActive() ?? false,
    panelMarkerCount: (i: number) => st?.gridPanels[i]?.lastMarkers ?? -1,
    mainMarkerCount: () => st?.lastMainMarkers ?? -1,
    panelCoords: (i: number, time: string | number, price: number) =>
      st?.gridPanels[i]?.chart?.coords(time, price) ?? null,
    panelLastClose: (i: number) => {
      const b = st?.gridPanels[i]?.bars;
      return b && b.length > 0 ? b[b.length - 1]!.close : null;
    },
    panelIntradayDays: (i: number) => st?.gridPanels[i]?.intradayDays ?? -1,
    panelIntradayLen: (i: number) => st?.gridPanels[i]?.intradayBars.length ?? -1,
    panelRangeVal: (i: number) => st?.gridPanels[i]?.range ?? -1,
    chart2IntradayDays: () => st?.chart2P.intradayDays ?? -1,
    chart2IntradayLen: () => st?.chart2P.intradayBars.length ?? -1,
    chart2Sym: () => st?.chart2Symbol ?? '',
    chart2Auto: () => st?.chart2P.auto ?? false,
    panelAutoProbe: (i: number) => {
      const p = st?.gridPanels[i];
      if (!p) return null;
      const r = p.chart?.getVisibleRange() ?? null;
      const src = panelSource(p);
      let days = -1;
      if (r && src.length >= 2) {
        let i0 = Math.max(0, Math.min(src.length - 1, Math.floor(r.from)));
        const i1 = Math.max(0, Math.min(src.length - 1, Math.ceil(r.to)));
        if (i1 > i0 || (i0 = Math.max(0, i1 - 1)) < i1) days = (barTimeMs(src[i1]!) - barTimeMs(src[i0]!)) / 86_400_000;
      }
      return { auto: p.auto, busy: p.autoBusy === true, intradayDays: p.intradayDays, srcLen: src.length, range: r, days };
    },
    panelAuto: (i: number) => st?.gridPanels[i]?.auto ?? false,
    panelHudText: (i: number) => st?.gridPanels[i]?.hudEl?.textContent?.trim() ?? '',
    chart2HudText: () => st?.chart2P.hudEl?.textContent?.trim() ?? '',
    ohlcOpen: () => st?.ohlcOpen ?? false,
    chart2ForecastActive: () => st?.chart2?.forecastActive() ?? false,
    chart2Overlays: () => st?.chart2?.overlayCount() ?? -1,
    mainChartType: () => st?.chart?.chartType() ?? 'candles',
    panelChartType: (i: number) => st?.gridPanels[i]?.chart?.chartType() ?? 'candles',
    panelRange: (i: number) => st?.gridPanels[i]?.chart?.getVisibleRange() ?? null,
    setPanelRange: (i: number, r: { from: number; to: number }) => st?.gridPanels[i]?.chart?.setVisibleRange(r),
    subRange: (k: 'rsi' | 'macd') => st?.subCharts[k]?.getVisibleRange() ?? null,
    subAnchorLen: (k: 'rsi' | 'macd') => subAnchorLens[k],
    subMounted: () => (st ? (st.subCharts.rsi ? 1 : 0) + (st.subCharts.macd ? 1 : 0) : -1),
    areaActive: () => st?.chart?.areaActive() ?? false,
    signalDir: () => st?.lastSignalDir ?? 'hold',
    cleanActive: () => st?.cleanView ?? false,
    autoLevel: () => (st?.autoRes ? (st.intradayDays > 0 ? st.aggMinutes : 0) : -1),
    resBadge: () => document.getElementById('resBadge')?.textContent ?? '',
    dailyLen: () => dailySource().length,
    firstDailyDate: () => dailySource()[0]?.date ?? '',
    mainCoords: (time: string | number, price: number) => st?.chart?.coords(time, price) ?? null,
    lastClose: () => st?.bars[st.bars.length - 1]?.close ?? null,
  };

  // Hotkey-Order-Ticket (M9): Shift+B/S, Enter bestätigt, Esc schließt
  document.addEventListener('keydown', onGlobalHotkey);
  document.querySelectorAll('[data-order-close]').forEach((el) =>
    el.addEventListener('click', () => $('orderModal').classList.remove('show')),
  );
  $('otSubmit').addEventListener('click', () => void submitOrderTicket());
  for (const id of ['otSym', 'otQty']) {
    $(id).addEventListener('input', updateOrderPreview);
    $(id).addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void submitOrderTicket();
    });
  }

  // Command-Palette (Ctrl+K, überschreibbar via settings.hotkeys.palette)
  st.paletteDispose = initPalette({
    hotkey: st.hotkeys.palette ?? 'ctrl+k',
    symbols: () => paletteSymbols(),
    commands: () => paletteCommands(),
    onSymbol: (sym) => {
      if (st) publishSymbol(st.chartGroup, sym);
    },
  });

  // E-Mail-Verifikation (M7): ohne bestätigte Mail bleibt der Engine-Start
  // serverseitig gesperrt — die Box erklärt das und bietet beide Aktionen an.
  $('verifyBox').hidden = emailVerified();
  $('verifySend').addEventListener('click', () => {
    sendVerification()
      .then(() => { $('verifyHint').textContent = 'Mail ist unterwegs (Spam-Ordner prüfen).'; })
      .catch(() => { $('verifyHint').textContent = 'Senden fehlgeschlagen — kurz warten und erneut.'; });
  });
  $('verifyDone').addEventListener('click', () => {
    void refreshUser().then((ok) => {
      $('verifyBox').hidden = ok;
      if (!ok) $('verifyHint').textContent = 'Noch nicht bestätigt — Link in der Mail öffnen.';
    });
  });

  // Interaktionen
  $('logoutBtn').addEventListener('click', () => void logout());
  $('saveBtn').addEventListener('click', () => void submitStrategy(formStrategy(), 'Gespeichert.'));
  $('engStart').addEventListener('click', () =>
    void submitStrategy({ ...formStrategy(), engine: { ...formStrategy().engine, running: true } }, 'Engine-Flag: AN'));
  $('engStop').addEventListener('click', () =>
    void submitStrategy({ ...formStrategy(), engine: { ...formStrategy().engine, running: false } }, 'Engine-Flag: AUS'));
  document.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeModal((el as HTMLElement).dataset.close as ModalName)));
  $('burgL').addEventListener('click', () => { $('leftCol').classList.toggle('show'); $('olv').classList.toggle('show'); });
  $('burgR').addEventListener('click', () => { $('rightCol').classList.toggle('show'); $('olv').classList.toggle('show'); });
  // Desktop-Sidebars ein-/ausblendbar (Taschenmesser Teil 1) — persistiert
  const sbState = ((): { l?: boolean; r?: boolean } => {
    try {
      return JSON.parse(localStorage.getItem('autotrd-sidebars') ?? '{}') as { l?: boolean; r?: boolean };
    } catch {
      return {};
    }
  })();
  const applySidebars = (): void => {
    $('leftCol').classList.toggle('sb-hidden', sbState.l === true);
    $('rightCol').classList.toggle('sb-hidden', sbState.r === true);
    $('sideL').classList.toggle('off', sbState.l === true);
    $('sideR').classList.toggle('off', sbState.r === true);
    localStorage.setItem('autotrd-sidebars', JSON.stringify(sbState));
  };
  $('sideL').addEventListener('click', () => { sbState.l = sbState.l !== true; applySidebars(); });
  $('sideR').addEventListener('click', () => { sbState.r = sbState.r !== true; applySidebars(); });
  applySidebars();
  wirePanelChrome();
  wireColumnDnD();
  wireSidebarResize();
  // Test-Hook (E2E): Reorder über denselben Pfad wie der Drop
  (window as unknown as { __autotrdWs?: unknown }).__autotrdWs = {
    move: (id: string, delta: number) => movePanel(id, delta),
    order: (colId: string) =>
      [...document.querySelectorAll<HTMLElement>(`#${colId} > .card[data-panel]`)].map((c) => c.dataset.panel),
  };
  $('olv').addEventListener('click', () => {
    for (const id of ['leftCol', 'rightCol']) $(id).classList.remove('show');
    $('olv').classList.remove('show');
  });
  wireManualTrade();
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('autotrd-theme', next);
    void rebuildChart();
  });
  // Timeframe-Buttons (1T/1W intraday · 1M/3M/1J Tageskerzen) — jeder
  // Wechsel ist eine explizite Aktion und darf neu fitten.
  const tfButtons = document.querySelectorAll<HTMLButtonElement>('.tf-btn[data-bars], .tf-btn[data-intraday]');
  tfButtons.forEach((b) =>
    b.addEventListener('click', () => {
      if (!st) return;
      st.autoRes = false; // manuelle Stufe gewählt → Auto pausiert bis zum Auto-Klick
      st.intradayDays = parseInt(b.dataset.intraday ?? '0', 10);
      st.aggMinutes = 5; // manuelle Intraday-Stufen zeigen die 5m-Basis
      if (b.dataset.bars !== undefined) st.range = parseInt(b.dataset.bars, 10);
      st.chartFitPending = true;
      tfButtons.forEach((el) => el.classList.toggle('on', el === b));
      updateAutoUi();
      if (st.intradayDays > 0) void loadIntradayView();
      else renderChart();
      // Zeitrahmen-Sync: alle Charts folgen dem Haupt-Picker (User-Wunsch)
      propagateTimeframe(st.intradayDays, st.range);
    }),
  );
  // Vergleichs-Chart: eigener Picker für gezielte Abweichungen
  document.querySelectorAll<HTMLElement>('#c2tf [data-c2r], #c2tf [data-c2i]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!st) return;
      const p = st.chart2P;
      p.auto = false; // manuelle Stufe pausiert Auto (wie überall)
      p.intradayDays = b.dataset['c2i'] !== undefined ? Number(b.dataset['c2i']) : 0;
      if (b.dataset['c2r'] !== undefined) p.range = Number(b.dataset['c2r']);
      p.fitPending = true;
      syncPanelTfButtons();
      if (p.intradayDays > 0) void loadPanelIntraday(p);
      else renderChart2();
    }),
  );
  // Auto-Zeitrahmen des Vergleichs-Charts (Grid-Gleichwertigkeit 26.07.)
  $('c2Auto').addEventListener('click', () => {
    if (!st) return;
    const p = st.chart2P;
    p.auto = !p.auto;
    $('c2Auto').classList.toggle('on', p.auto);
    if (p.auto) void panelMaybeAutoSwitch(p);
  });
  // Vergleichs-Symbol frei wählbar (Owner-Feedback 26.07.: „die Vergleichs-
  // Chart ist momentan immer gleich Grid-Chart 1") — unabhängig vom Raster;
  // die Link-Gruppe (Chip B) kann es weiterhin gezielt mitziehen.
  $('ch2Sym').addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Enter') return;
    const el = $('ch2Sym') as HTMLInputElement;
    const sym = el.value.trim().toUpperCase();
    if (!sym || !st || sym === st.chart2Symbol) return;
    el.value = sym;
    st.chart2Symbol = sym;
    wireChart2Ctx();
    void rebuildChart2();
    scheduleWsSave();
  });
  // Timeline-Sprünge (User-Wunsch 25.07. nachts): animiert zu Anfang/Mitte/
  // Ende — am linken Rand lädt die bestehende Nachlade-Logik automatisch weiter.
  $('jumpStart').addEventListener('click', () => st?.chart?.scrollTo('start'));
  $('jumpMid').addEventListener('click', () => st?.chart?.scrollTo('middle'));
  $('jumpEnd').addEventListener('click', () => st?.chart?.scrollTo('end'));
  $('jumpNow').addEventListener('click', () => st?.chart?.scrollTo('end'));
  // Symbolfeld im Raster-Kopf des Haupt-Fensters (wie in den Panels)
  $('mainHdSym').addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Enter') return;
    const el = $('mainHdSym') as HTMLInputElement;
    const sym = el.value.trim().toUpperCase();
    if (!sym || !st || sym === st.currentSymbol) return;
    el.value = sym;
    selectSymbol(sym);
  });
  // Zeitrahmen im Raster-Kopf (Titelleisten-Parität 26.07.): wirkt LOKAL
  // aufs Haupt-Chart — wie die Picker der Panels; der globale Sync über
  // alle Fenster bleibt bewusst bei der großen Toolbar darüber.
  document.querySelectorAll<HTMLElement>('#mainHd [data-mh-r], #mainHd [data-mh-i]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!st) return;
      st.autoRes = false; // manuelle Stufe pausiert Auto (wie überall)
      st.intradayDays = b.dataset['mhI'] !== undefined ? Number(b.dataset['mhI']) : 0;
      st.aggMinutes = 5;
      if (b.dataset['mhR'] !== undefined) st.range = Number(b.dataset['mhR']);
      st.chartFitPending = true;
      // Toolbar-Knöpfe spiegeln denselben Zustand
      tfButtons.forEach((el) =>
        el.classList.toggle(
          'on',
          st!.intradayDays > 0
            ? el.dataset.intraday === String(st!.intradayDays)
            : el.dataset.intraday === undefined && el.dataset.bars === String(st!.range),
        ),
      );
      updateAutoUi();
      if (st.intradayDays > 0) void loadIntradayView();
      else renderChart();
    }),
  );
  $('mhAuto').addEventListener('click', () => {
    if (!st) return;
    st.autoRes = !st.autoRes;
    updateAutoUi();
    if (st.autoRes) maybeAutoSwitch();
  });
  $('mhMax').addEventListener('click', () => {
    const on = !$('chartMaxScope').classList.contains('chart-max');
    exitAllMax();
    if (on) setMainMax(true);
  });
  // Auto-Auflösung an/aus + Y-Autoscaling (Anzeige-Option, Feedback 25.07.)
  $('autoBtn').addEventListener('click', () => {
    if (!st) return;
    st.autoRes = !st.autoRes;
    updateAutoUi();
    if (st.autoRes) maybeAutoSwitch();
  });
  updateAutoUi();
  $('yAutoBtn').addEventListener('click', () => {
    if (!st) return;
    st.yAuto = !st.yAuto;
    $('yAutoBtn').classList.toggle('on', st.yAuto);
    localStorage.setItem('autotrd-chart-yauto', st.yAuto ? '1' : '0');
    st.chart?.setAutoScale(st.yAuto);
  });
  $('yAutoBtn').classList.toggle('on', st?.yAuto ?? true);
  // Indikator-Layer (SMA/EMA/BB) — Auswahl bleibt über localStorage erhalten
  document.querySelectorAll<HTMLButtonElement>('.tf-btn[data-layer]').forEach((b) => {
    const key = b.dataset.layer!;
    b.classList.toggle('on', st?.chartLayers.has(key) ?? false);
    b.addEventListener('click', () => {
      if (!st) return;
      if (st.chartLayers.has(key)) st.chartLayers.delete(key);
      else st.chartLayers.add(key);
      b.classList.toggle('on', st.chartLayers.has(key));
      localStorage.setItem('autotrd-chart-layers', [...st.chartLayers].join(','));
      applyOverlays();
      updateSubPanels();
      renderAllPanels();
    });
  });
  // Dropdown-Menüs (TV-Stil, UI-Audit 25.07.): „Indikatoren ▾" + „Layer ▾"
  // statt Chip-Wänden. Item-Klicks schließen NICHT (mehrere Toggles am Stück,
  // wie TVs Indikator-Dialog) — zu geht's per Menü-Knopf, Außenklick oder Esc.
  const menus: Array<[string, string]> = [
    ['indBtn', 'menuInd'],
    ['layBtn', 'menuLay'],
  ];
  const closeMenus = (): void => {
    // Null-sicher: die document-Listener unten überleben ein Re-Rendern der
    // Kopfleiste, bei dem die Menü-Knoten kurzzeitig fehlen.
    for (const [b, m] of menus) {
      const menu = document.getElementById(m);
      if (menu) menu.hidden = true;
      document.getElementById(b)?.classList.remove('on');
    }
  };
  // Viewport-Klemmung (Mobil-Bug 25.07.): Die Menüs sind rechtsbündig am
  // Knopf verankert — bricht die Toolbar um (Handy), stünde das Menü links
  // aus dem Bildschirm. Nach dem Öffnen messen und ggf. an die linke
  // Viewport-Kante klemmen (position:fixed wäre wegen der backdrop-filter-
  // Containing-Block-Falle tabu, CLAUDE.md §6).
  const clampMenu = (m: string): void => {
    const menu = $(m);
    const anchor = menu.parentElement;
    if (!anchor) return;
    menu.style.left = '';
    menu.style.right = '';
    const r = menu.getBoundingClientRect();
    if (r.left < 8) {
      menu.style.right = 'auto';
      menu.style.left = `${Math.round(8 - anchor.getBoundingClientRect().left)}px`;
    }
  };
  for (const [b, m] of menus) {
    $(b).addEventListener('click', () => {
      const open = $(m).hidden !== false; // hidden kann auch 'until-found' sein
      closeMenus();
      $(m).hidden = !open;
      $(b).classList.toggle('on', open);
      if (open) clampMenu(m);
    });
  }
  document.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('.tool-anchor')) closeMenus();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenus();
  });

  // Chart-Typ + Preisskala (TV-Parität Teil 1): gelten synchron für den
  // Haupt-Chart und alle Raster-Panels; Gerät-lokal gemerkt.
  const applyChartStyle = (): void => {
    if (!st) return;
    const targets = [st.chart, st.chart2, ...st.gridPanels.map((p) => p.chart)];
    for (const h of targets) {
      h?.setChartType(st.chartTypeSel);
      h?.setTypeCombine(st.typeCombine);
      h?.setPriceScaleMode(st.scaleMode);
    }
    document.querySelectorAll<HTMLElement>('[data-ctype]').forEach((b) =>
      b.classList.toggle('on', b.dataset['ctype'] === st!.chartTypeSel),
    );
    $('ctypeCombine').classList.toggle('on', st.typeCombine);
    document.querySelectorAll<HTMLElement>('[data-scale]').forEach((b) =>
      b.classList.toggle('on', Number(b.dataset['scale']) === st!.scaleMode),
    );
    localStorage.setItem('autotrd-chart-style', `${st.chartTypeSel}|${st.scaleMode}|${st.typeCombine ? 1 : 0}`);
  };
  document.querySelectorAll<HTMLElement>('[data-ctype]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!st) return;
      st.chartTypeSel = (b.dataset['ctype'] ?? 'candles') as ChartType;
      applyChartStyle();
    }),
  );
  $('ctypeCombine').addEventListener('click', () => {
    if (!st) return;
    st.typeCombine = !st.typeCombine;
    applyChartStyle();
  });
  document.querySelectorAll<HTMLElement>('[data-scale]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!st) return;
      st.scaleMode = Number(b.dataset['scale']) as 0 | 1 | 2;
      applyChartStyle();
    }),
  );
  applyChartStyle();

  // HUD-Legende einklappbar (Feedback 25.07. abends: „überlagert zu viel")
  const applyHud = (): void => {
    if (!st) return;
    $('hudTgl').textContent = st.hudOpen ? '▾' : '▸';
    $('hudTgl').classList.toggle('on', st.hudOpen);
    localStorage.setItem('autotrd-hud', st.hudOpen ? '1' : '0');
    applyOverlays(); // renderLegend respektiert hudOpen
  };
  $('hudTgl').addEventListener('click', () => {
    if (!st) return;
    st.hudOpen = !st.hudOpen;
    applyHud();
  });
  applyHud();
  // OHLC-Kurszeile als Accordion (Owner-Wunsch 26.07.): Klick auf die Zeile
  // klappt sie in ALLEN Fenstern gleichzeitig (ein gerätelokaler Zustand)
  $('ohlcRow').addEventListener('click', toggleOhlcAll);

  // Vollbild je Chart (Feedback 25.07., wichtig für Smartphones): CSS-Overlay
  // statt Fullscreen-API (läuft überall, auch iOS/PWA); Esc schließt.
  $('maxMain').addEventListener('click', () => {
    // chartMaxScope trägt die Vollbild-Klasse (nicht chartWrap) — der
    // Toggle prüfte das falsche Element und konnte nie wieder schließen.
    const on = !$('chartMaxScope').classList.contains('chart-max');
    exitAllMax();
    if (on) setMainMax(true);
  });
  $('maxExit').addEventListener('click', () => setMainMax(false));
  // Clean-View: alles Optionale auf einmal weg (Auswahl bleibt gemerkt)
  const applyClean = (): void => {
    if (!st) return;
    $('cleanBtn').classList.toggle('on', st.cleanView);
    localStorage.setItem('autotrd-chart-clean', st.cleanView ? '1' : '0');
    applyOverlays();
    applyMarkers();
    applyForecast();
    updateSubPanels();
    drawPredictionArrow();
    renderAllPanels(); // Raster + Vergleichs-Chart folgen Clean/Layern
  };
  $('cleanBtn').addEventListener('click', () => {
    if (!st) return;
    st.cleanView = !st.cleanView;
    applyClean();
  });
  if (st?.cleanView) applyClean();
  // Doppelklick auf die Chart-Fläche = frischer Fit (X + Y), wie TradingView
  $('chartArea').addEventListener('dblclick', () => {
    if (!st) return;
    st.chartFitPending = true;
    renderChart();
  });
  // Prognose-Pfeil: Modus + Popover
  $('predBtn').addEventListener('click', () => {
    if (!st) return;
    // Pfeil ist tagesbasiert — steht der Chart (z. B. durch die Auto-
    // Auflösung) auf Intraday-Kerzen, erst auf Tageskerzen zurückholen
    // statt stumm nichts zu tun (Bug-Meldung 25.07.).
    if (st.intradayDays > 0) {
      st.intradayDays = 0;
      st.chartFitPending = true;
      renderChart();
    }
    st.predMode = !st.predMode;
    $('predBtn').classList.toggle('on', st.predMode);
  });
  $('ppClose').addEventListener('click', () => ($('predPop').hidden = true));
  $('ppConfM').addEventListener('click', () => {
    const v = Math.max(1, Number($('ppConfV').textContent) - 1);
    $('ppConfV').textContent = String(v);
  });
  $('ppConfP').addEventListener('click', () => {
    const v = Math.min(3, Number($('ppConfV').textContent) + 1);
    $('ppConfV').textContent = String(v);
  });
  $('ppSave').addEventListener('click', () => {
    if (!st) return;
    const last = st.bars[st.bars.length - 1];
    const targetPrice = Number(($('ppPrice') as HTMLInputElement).value);
    const targetDate = ($('ppDate') as HTMLInputElement).value;
    const confidence = Number($('ppConfV').textContent);
    void callSavePrediction({
      symbol: st.currentSymbol,
      targetPrice,
      targetDate,
      confidence,
      basePrice: last?.close ?? targetPrice,
    })
      .then(() => {
        $('predPop').hidden = true;
        return loadPredictionForSymbol();
      })
      .catch((e) => alert(`Prognose: ${(e as Error).message}`));
  });
  $('ppDel').addEventListener('click', () => {
    if (!st) return;
    void callSavePrediction({ symbol: st.currentSymbol, clear: true })
      .then(() => {
        $('predPop').hidden = true;
        st!.prediction = null;
        drawPredictionArrow();
        applyOverlays();
      })
      .catch((e) => alert(`Prognose: ${(e as Error).message}`));
  });

  // Options-Modal (⚙): Element-Toggles sofort wirksam, Wallet-Basics via saveStrategy
  $('optBtn').addEventListener('click', openOptions);
  for (const [id, key] of [
    ['ouPred', 'predArrow'],
    ['ouCmp', 'cmpOverlay'],
    ['ouGrid', 'chartGrid'],
    ['ouSub', 'subPanels'],
  ] as const) {
    $(id).addEventListener('change', () => {
      if (!st) return;
      st.ui = { ...st.ui, [key]: ($(id) as HTMLInputElement).checked };
      applyUiPrefs();
      void saveUiPrefs(st.uid, st.ui).catch(() => undefined);
    });
  }
  // Zwei Stufen: Der Knopf bleibt gesperrt, bis das Wort exakt dasteht.
  // Das ist bewusst umständlich — ein unumkehrbarer Schritt soll sich auch
  // so anfühlen. Serverseitig wird dasselbe Wort noch einmal geprüft; der
  // Client-Guard ist Bequemlichkeit, keine Sicherung.
  $('rsWord').addEventListener('input', () => {
    ($('rsGo') as HTMLButtonElement).disabled =
      ($('rsWord') as HTMLInputElement).value.trim() !== RESET_CONFIRM_WORD;
  });
  $('rsGo').addEventListener('click', () => {
    const btn = $('rsGo') as HTMLButtonElement;
    btn.disabled = true;
    $('rsMsg').textContent = 'Setze zurück …';
    void resetWallet(RESET_CONFIRM_WORD)
      .then((r) => {
        const n = Object.entries(r.deleted)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        $('rsMsg').textContent = `✓ Zurückgesetzt (${n || 'nichts zu löschen'}) — Kontostand ${r.balance} $`;
        ($('rsWord') as HTMLInputElement).value = '';
      })
      .catch((e) => {
        $('rsMsg').textContent = (e as Error).message;
        btn.disabled = false;
      });
  });
  $('owSave').addEventListener('click', () => {
    if (!st) return;
    const strategy = optionsFormStrategy();
    const problems = validateStrategy(strategy);
    if (problems.length > 0) {
      $('optMsg').textContent = problems[0]!;
      return;
    }
    $('optMsg').textContent = 'Speichere …';
    void saveStrategy(strategy)
      .then(() => ($('optMsg').textContent = '✓ Gespeichert'))
      .catch((e) => ($('optMsg').textContent = (e as Error).message));
  });

  $('owCheck').addEventListener('click', () => renderAdvice());
  $('owApply').addEventListener('click', () => {
    if (!st) return;
    const gewaehlt = [...$('owAdvice').querySelectorAll<HTMLInputElement>('input[data-adv]:checked')]
      .map((c) => c.dataset.adv ?? '');
    if (gewaehlt.length === 0) return;
    const next = applySuggestions(optionsFormStrategy(), gewaehlt);
    const problems = validateStrategy(next);
    if (problems.length > 0) {
      $('advMsg').textContent = problems[0]!;
      return;
    }
    $('advMsg').textContent = 'Übernehme …';
    void saveStrategy(next)
      .then(() => {
        st!.strategy = next;
        openOptions(); // Formular auf die neuen Werte ziehen
        renderAdvice(); // und erneut prüfen — die Liste muss sichtbar schrumpfen
        $('advMsg').textContent = `✓ ${gewaehlt.length} übernommen`;
      })
      .catch((e) => ($('advMsg').textContent = (e as Error).message));
  });


  // Multi-Chart-Raster: Umschalter 1/2/4 + Lock fürs Haupt-Chart
  document.querySelectorAll('.tf-btn[data-grid]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!st) return;
      const mode = Number((b as HTMLElement).dataset['grid']);
      st.gridMode = mode === 2 || mode === 4 ? mode : 1;
      renderChartGrid();
    }),
  );
  $('lockMain').addEventListener('click', () => {
    if (!st) return;
    st.mainLocked = !st.mainLocked;
    $('lockMain').innerHTML = st.mainLocked ? ICONS.lock : ICONS.unlock;
    $('lockMain').classList.toggle('on', st.mainLocked);
    saveGridPrefs();
  });
  // Gespeichertes Raster wiederherstellen (localStorage)
  if (st) {
    const prefs = loadGridPrefs();
    st.gridMode = prefs.mode;
    st.mainLocked = prefs.mainLocked;
    st.gridPanels = prefs.panels.map((p) => ({ ...p, chart: null, bars: [], subs: [], epoch: 0, fitPending: true, forecast: null, forecastIntraday: null, intradayBars: [] }));
    // (auto kommt aus prefs mit — loadGridPrefs liefert es garantiert)
    renderChartGrid();
  }

  // Vergleichs-Overlay: Symbol eintippen + Enter (leer = entfernen)
  $('cmpSym').addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Enter' || !st) return;
    const sym = ($('cmpSym') as HTMLInputElement).value.trim().toUpperCase();
    if (!sym) {
      st.overlaySymbol = null;
      st.overlayBars = [];
      applyOverlays();
      return;
    }
    void loadBarsOnce(sym).then((bars) => {
      if (!st) return;
      st.overlaySymbol = sym;
      st.overlayBars = bars;
      applyOverlays();
    });
  });

  $('lyFc').addEventListener('click', () => {
    if (!st) return;
    st.showForecast = !st.showForecast;
    $('lyFc').classList.toggle('on', st.showForecast);
    applyForecast();
    renderAllPanels(); // Prognose-Layer gilt in ALLEN Charts
    updateSubPanels(); // Zeitachsen-Anker der Unterpanels folgt dem Whitespace
  });
  wireChartHeightDrag();
  document.addEventListener('keydown', onEscape);
}

/**
 * Chart-Höhe per Zieh-Griff (User-Wunsch 26.07. „dynamisch skalierbar"):
 * EINE Variable --chart-h steuert Haupt-Chart UND alle Raster-Panels —
 * damit bleiben alle Fenster exakt gleich hoch (LWC folgt via autoSize).
 * Gerät-lokal persistiert; Doppelklick setzt auf den Responsive-Default zurück.
 */
const CHART_H_KEY = 'autotrd-chart-h';

function applyChartHeight(px: number | null): void {
  if (px === null) document.documentElement.style.removeProperty('--chart-h');
  else document.documentElement.style.setProperty('--chart-h', `${px}px`);
}

function wireChartHeightDrag(): void {
  const stored = Number(localStorage.getItem(CHART_H_KEY));
  if (stored >= 220) applyChartHeight(stored);
  const grip = $('chartHDrag');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.classList.add('on');
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = $('chartArea').getBoundingClientRect().height;
    const move = (ev: PointerEvent): void => {
      const h = Math.max(220, Math.min(Math.round(window.innerHeight * 0.75), Math.round(startH + ev.clientY - startY)));
      applyChartHeight(h);
    };
    const up = (): void => {
      grip.classList.remove('on');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      localStorage.setItem(CHART_H_KEY, String(Math.round($('chartArea').getBoundingClientRect().height)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => {
    localStorage.removeItem(CHART_H_KEY);
    applyChartHeight(null);
  });
}

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeModal('detail');
  closeModal('options');
  exitAllMax();
  document.getElementById('orderModal')?.classList.remove('show');
  for (const id of ['leftCol', 'rightCol']) document.getElementById(id)?.classList.remove('show');
  document.getElementById('olv')?.classList.remove('show');
}

export function unmountDashboard(): void {
  if (!st) return;
  exitAllMax(); // Portal-Elemente vom body zurück, bevor die App-Wurzel geleert wird
  clearSubs(st.subs);
  clearSubs(st.symbolSubs);
  clearSubs(st.chart2Subs);
  clearSubs(st.watchlistSubs);
  for (const u of st.positionSubs.values()) u();
  for (const t of st.timers) clearInterval(t);
  if (st.wsSaveTimer !== null) clearTimeout(st.wsSaveTimer);
  st.paletteDispose?.();
  clearSubscribers();
  for (const p of st.gridPanels) unmountGridPanel(p);
  for (const kind of ['rsi', 'macd'] as const) {
    subEpochs[kind]++;
    st.subCharts[kind]?.destroy();
  }
  st.chart?.destroy();
  st.chart2?.destroy();
  document.removeEventListener('keydown', onEscape);
  document.removeEventListener('keydown', onGlobalHotkey);
  st = null;
}
