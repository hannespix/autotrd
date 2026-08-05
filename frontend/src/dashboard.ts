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
  CORE_PCT_CAP,
  DEFAULT_CORE_PCT,
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
  lokalerTag,
  marketOpenForClass,
  ema,
  entryAnchor,
  equityCurve,
  exitBreakdown,
  haltedauerTage,
  historySummary,
  labelVariantId,
  levelDistPct,
  macd,
  pnlHistogram,
  positionLevels,
  positionPnl,
  resolveName,
  resolveRisk,
  sma,
  streaks,
  tradeStats,
  validateStrategy,
  vwapSessions,
  tagesPraefix,
  wilderRsi,
  zonenKuerzel,
  type GlobalAxisStats,
  type HistoryTrade,
  type Position,
  type PositionLevels,
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
  type PriceLineSpec,
} from './chart.js';
import { ICONS } from './icons.js';
import { newsChartMarkers, newsForDay } from './newsMarkers.js';
import {
  adminListUsers,
  adminSetAccess,
  adminSetAdmin,
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
  watchHealth,
  watchPositioning,
  watchTuneFleet,
  watchTuneGlobal,
  watchTuneLog,
  type EvaluatedForecastRow,
  type ForecastStatsDoc,
  type HealthDoc,
  type TradeCursor,
  type PositioningDoc,
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
  callBrokerStatus,
  callConnectBroker,
  callDisconnectBroker,
  callLiveMode,
  type LiveModeStatus,
  type BrokerStatusResult,
  callTaxReport,
  type TaxReportResult,
  resetBreaker,
  resetWallet,
} from './data.js';
import {
  emailVerified,
  frischAnmelden,
  logout,
  refreshUser,
  sendVerification,
} from './auth.js';
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
  /** Layer-Toggles: Prognose-Overlay / News-Punkte ein- und ausblenden. */
  showForecast: boolean;
  /** News-Punkte im Chart (Rückkehr 29.07.) — Quelle sind NUR die fürs
   *  Veto ohnehin geladenen Schlagzeilen (market/{sym}.news), kein Nachladen. */
  showNews: boolean;
  /**
   * Positions-Overlay (Owner-Wunsch 04.08.): Einstiegs-Marke, Preislinien für
   * Stop/Trailing/Ziel und die Kurve seit Einstieg — sichtbar, sobald das
   * Chart ein Symbol zeigt, in dem das Konto drinsteckt. Default AN.
   */
  showPos: boolean;
  /** Positions-Chip aufgeklappt? Zu = nur Seite, Stück und Ergebnis. */
  posOpen: boolean;
  /** News-Lage des aktuellen Chart-Symbols (aus dem market-Doc-Watcher). */
  news: MarketDocData['news'];
  /** Zugangsstufe des Kontos — 'pending'/'blocked' heißt: der Scan handelt NICHT. */
  accessLevel: 'pending' | 'approved' | 'blocked';
  /** Kontotyp (Owner 02.08.): Admins sehen die Freischaltungs-Karte. */
  admin: boolean;
  /** Betriebszustand des letzten Scans (meta/health) — Karte „Was die Engine
   *  gerade tut". Öffentlich lesbar, deshalb ohne Callable direkt abonniert. */
  health: HealthDoc | null;
  /** Auffällige Positionierungen des letzten Tageslaufs (meta/positioning). */
  positioning: PositioningDoc | null;
  /** Sockel-Kennzahlen des letzten Momentum-Laufs (meta/momentum). */
  sockelKonten: number | null;
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
  tradesCursor: TradeCursor | null;
  /** Letzter Nachlade-Fehler — sichtbar statt nur in der Konsole. */
  tradesFehler: string | null;
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
  /** News-Lage des Panel-Symbols (News-Punkte in JEDEM Chart, 29.07.). */
  news: MarketDocData['news'];
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
        <p id="accessNote" class="hint" hidden
          style="color:var(--yl,#d9a441);margin-top:6px"></p>
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

      <!-- Admin-Verwaltung (Owner 02.08.): nur für Konten mit admin:true
           sichtbar. Bewusst OHNE data-panel — die Karte gehört nicht in die
           Workspace-Mechanik (applyPanels würde sonst die Admin-Sichtbarkeit
           mit style.display überschreiben). -->
      <div class="card" id="adminCard" hidden><div class="sect">Admin · Freischaltung</div><div class="cbody">
        <div class="hint">Neue Konten starten auf „wartet" und handeln erst
          nach der Freischaltung. Das eigene Konto ist serverseitig tabu.</div>
        <button class="btn btn-n" id="admReload" style="width:100%;margin:6px 0">Konten laden</button>
        <div id="admList"></div>
        <p id="admErr" class="error" hidden></p>
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
          <span id="mktBadge" class="res-badge mono" hidden></span>
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
              <button class="tf-btn on" id="lyNews" title="News-Punkte ein/aus — nur die Schlagzeilen, die die Engine ohnehin fürs News-Veto lädt (kein zusätzlicher Abruf). Grün/rot = Wortlaut der Schlagzeile, gelber Pfeil = Einstiegs-Veto aktiv.">News</button>
              <button class="tf-btn on" id="lyPos" title="Offene Position im Chart: Einstiegs-Marke, Preislinien für Stop/Trailing/Ziel und die Kurslinie seit Einstieg (grün im Gewinn, rot im Verlust). Zeigt sich nur, wenn das Konto in diesem Symbol drinsteckt.">Position</button>
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
            <div id="posHud" class="pos-hud mono" hidden></div>
          </div>
          <div id="chartArea"></div>
          <button id="jumpNow" class="jump-now" hidden
            title="Zurück zur Gegenwart — animierter Sprung zum jüngsten Kurs">Jetzt ⇥</button>
          <div id="evTip" class="evtip" hidden></div>
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

      <!-- Betriebszustand (04.08.): Seit der Performance-Offensive entscheiden
           fünf Mechaniken mit, ob ein Trade zustande kommt — alle unsichtbar.
           „Es passiert nichts" sah bei einer scharfen Regel bisher genauso aus
           wie bei einem toten System. Diese Karte macht den Unterschied. -->
      <div class="card" data-panel="engineWhy"><div class="sect">Was die Engine gerade tut ${iBtn('engineWhy')}</div><div class="cbody">
        <div id="whyAmpel" class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:6px"></div>
        <div id="whyGate"></div>
        <div id="whyExtra" class="hint" style="margin-top:6px"></div>
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

  <!-- ── Nach dem Engine-Stop: Positionen schließen? (Owner 05.08.) ──────
       Der Stop pausiert ALLES, auch Stop-Loss und Take-Profit. Wer danach
       Positionen offen lässt, hält sie ungeschützt. Ein Warnsatz allein
       verlagert die Arbeit auf den Nutzer; dieser Dialog erledigt sie an
       der Stelle, an der die Frage entsteht. -->
  <div class="dmodal" id="stopModal">
    <div class="dmodal-bg" data-close="stop"></div>
    <div class="dsheet" style="width:min(560px,100%)">
      <button class="dclose" data-close="stop">✕</button>
      <h3 style="margin:0 0 6px">Engine gestoppt</h3>
      <p class="hint">Es werden keine neuen Trades mehr eröffnet — und auch
        <b>keine Stop-Loss- oder Take-Profit-Ausführungen</b> mehr. Deine offenen
        Positionen bleiben genau so stehen, wie sie sind, sind ab jetzt aber
        <b>ungeschützt</b>.</p>
      <p class="hint">Was soll damit passieren?</p>
      <div id="stopRows" style="margin-top:8px"></div>
      <div class="row" style="align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-n" id="stopKeep">Offen lassen</button>
        <button class="btn btn-n" id="stopSel">Ausgewählte schließen</button>
        <button class="btn btn-r" id="stopAll">Alle schließen</button>
      </div>
      <div id="stopOut" style="margin-top:8px"></div>
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
      <!-- Startkapital wirkt an ZWEI Stellen verschieden — ohne diesen
           Hinweis wartet man auf einen Kontostand, der sich nie ändert. -->
      <p class="hint">Das <b>Startkapital</b> ändert deinen aktuellen Kontostand
        <b>nicht</b>. Es greift erst bei „Neu anfangen" ganz unten — dann wird das
        Wallet auf diesen Betrag zurückgesetzt. Sofort wirksam ist es nur als
        Rechenbasis für die Positionsgröße, und auch das nur, wenn unten
        <b>Größenbasis „Startkapital"</b> eingestellt ist (Standard ist
        „Kontostand").</p>
      <div class="opt-grid">
        <label>Startkapital $
          <input id="owCap" class="inp st-num" type="number" min="100" step="500" /></label>
        <label>Investment je Trade %
          <input id="owMax" class="inp st-num" type="number" min="1" max="100" step="1" /></label>
        <label>Risiko je Trade % ${iBtn('riskPerTrade')}
          <input id="owRisk" class="inp st-num" type="number" min="0" max="5" step="0.25" /></label>
        <label>Max. gleichzeitige Positionen ${iBtn('maxOpenPositions')}
          <input id="owMaxPos" class="inp st-num" type="number" min="1" max="${MAX_OPEN_POSITIONS_CAP}" step="1" /></label>
        <label>Ruhiger Sockel % ${iBtn('corePct')}
          <input id="owCore" class="inp st-num" type="number" min="0" max="${CORE_PCT_CAP}" step="5" /></label>
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
        <label>Tages-Notbremse (% Verlust) ${iBtn('dailyLossLimit')}
          <input id="owBreak" class="inp st-num" type="number" min="0" max="25" step="0.5" /></label>
        <label class="opt-row" style="align-items:center">
          <input type="checkbox" id="owFcSolo" />
          <span>Prognose darf allein entscheiden ${iBtn('forecastSolo')}</span></label>
        <label class="opt-row" style="align-items:center">
          <input type="checkbox" id="owShort" />
          <span>Shorten erlauben (Leerverkäufe) ${iBtn('allowShort')}</span></label>
        <label class="opt-row" style="align-items:center">
          <input type="checkbox" id="owNewsVeto" />
          <span>News-Veto (Einstiege bei harten Events aussetzen) ${iBtn('newsVeto')}</span></label>
        <label class="opt-check">
          <input type="checkbox" id="owRegimeGate" />
          <span>Markt-Ampel (keine Shorts im Aufwärtstrend, Pause bei Stress) ${iBtn('regimeGate')}</span></label>
        <label class="opt-check">
          <input type="checkbox" id="owFlatten" />
          <span>Bei Notbremse zusätzlich alle Positionen schließen ${iBtn('flattenOnBreach')}</span></label>
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
      <div class="wl-sec" style="margin-top:14px">Kapital je Anlageklasse ${iBtn('classWeights')}</div>
      <p class="hint">Der Regler multipliziert die Positionsgröße in dieser Klasse:
        <b>0</b> = handelt nicht mehr, <b>1</b> = normal, <b>1,5</b> = größere Stücke.
        Bestehende Positionen werden trotzdem immer geschlossen — der Regler
        steuert nur den <b>Einstieg</b>.
        Und: Eine Klasse auf 0 wird weiter <b>gemessen</b> (Schatten-Kante), sie
        kann sich also zurückverdienen. Ohne das wäre jedes Abschalten endgültig.</p>
      <div id="owClsRows" class="cls-grid" style="margin-top:6px"></div>
      <label class="opt-check" style="margin-top:8px">
        <input type="checkbox" id="owClsAuto" />
        <span>Automatisch nachregeln (täglich, in Schritten von 0,25) ${iBtn('classAutoTune')}</span></label>
      <div id="owClsAdvice" style="margin-top:8px"></div>
      <div class="row" style="margin-top:6px">
        <button class="btn btn-n" id="owClsApply" hidden>Vorschlag übernehmen</button>
        <span class="hint" id="owClsMsg"></span>
      </div>
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
      <div class="wl-sec" style="margin-top:14px">Echtgeld-Anbindung ${iBtn('brokerStatus')}</div>
      <p class="hint">Prüft die Verbindung zum Broker, <b>ohne zu handeln</b>, und
        gleicht das eigene Buch mit dem Depot beim Broker ab. Echtgeld verlangt
        zwei Schalter an zwei Orten — ein Klick allein schaltet nichts scharf.</p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
        <input id="bkKey" class="inp" style="flex:1;min-width:150px" type="text"
          autocomplete="off" spellcheck="false" placeholder="API-Key (PK…)" />
        <input id="bkSec" class="inp" style="flex:1;min-width:150px" type="password"
          autocomplete="off" spellcheck="false" placeholder="Secret-Key" />
        <button class="btn btn-n" id="bkSave">Verbinden</button>
      </div>
      <!-- Echtgeld-Schlüssel sind seit 05.08. erlaubt (verschlüsselte Ablage).
           Das Passwortfeld erscheint erst, wenn ein AK…-Schlüssel eingegeben
           wird — für Papierkonten wäre es Reibung ohne Schutzwirkung. -->
      <div id="bkLiveBox" hidden style="margin-top:6px">
        <p class="hint" style="border-left:3px solid var(--rd);padding-left:8px">
          <b>Das ist ein Echtgeld-Schlüssel (AK…).</b> Er wird verschlüsselt
          gespeichert und nie wieder angezeigt. <b>Gehandelt wird damit nicht:</b>
          Dafür braucht es zusätzlich den Live-Modus in den Einstellungen, die
          Server-Freigabe und eine bestandene Live-Reife. Bis dahin siehst du
          dein echtes Depot nur im Abgleich.</p>
        <p class="hint">Zur Sicherheit muss deine Anmeldung frisch sein — eine
          übernommene, offene Sitzung soll genau das hier nicht können.</p>
        <input id="bkPw" class="inp" style="width:100%;margin-top:4px" type="password"
          autocomplete="current-password" placeholder="Dein autotrd-Passwort zur Bestätigung" />
      </div>
      <p class="hint"><b>Papierkonto-Schlüssel</b> beginnen mit „PK",
        <b>Echtgeld-Schlüssel</b> mit „AK". Das Papierkonto ist bei Alpaca gratis
        und sofort da — fang damit an.</p>
      <!-- Die Schlüssel liegen nicht dort, wo man sie sucht: Das Paper-
           Dashboard ist eine eigene Oberfläche, und der Knopf zum Erzeugen
           steht rechts in der Seitenleiste. Ohne diese drei Links kostet der
           erste Versuch mehr Zeit als die ganze Einrichtung. -->
      <p class="hint">
        <a href="https://app.alpaca.markets/signup" target="_blank" rel="noopener noreferrer">1. Konto anlegen</a>
        &nbsp;·&nbsp;
        <a href="https://app.alpaca.markets/paper/dashboard/overview" target="_blank" rel="noopener noreferrer">2. Paper-Dashboard → API-Keys erzeugen</a>
        &nbsp;·&nbsp;
        <a href="https://docs.alpaca.markets/docs/getting-started" target="_blank" rel="noopener noreferrer">Dokumentation</a>
      </p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <button class="btn btn-n" id="bkGo">Verbindung prüfen</button>
        <button class="btn btn-n" id="bkDel">Trennen</button>
      </div>
      <!-- Der LAUFENDE Abgleich, nicht der auf Knopfdruck. Ein sauberer
           Abgleich sieht ohne diese Zeile aus wie gar keiner — und genau
           das war die offene Frage nach dem Verbinden: „Was bringt mir das
           jetzt?" -->
      <p class="hint" id="bkAuto" style="margin-top:8px">—</p>
      <div id="bkOut" style="margin-top:8px"></div>

      <!-- ── Echtgeld scharf stellen (M14, Owner-Go 05.08.) ──────────────
           Der Schalter, den der Owner meint. Er steht bewusst HIER, direkt
           unter der Broker-Karte: Ohne verbundenes Echtgeldkonto ist er
           gegenstandslos, und die Reihenfolge auf dem Bildschirm soll die
           Reihenfolge der Schritte sein. -->
      <div class="wl-sec" style="margin-top:14px">Echtgeld scharf stellen</div>
      <p class="hint">Es geht los, wenn <b>beides</b> gilt: Dieser Schalter steht
        auf ECHTGELD <b>und</b> die Trading-Engine steht auf <b>Start</b>. Ein
        Schalter allein handelt nicht.</p>
      <p class="hint" id="lvState">—</p>
      <div id="lvKrit"></div>
      <div id="lvOn" hidden style="margin-top:8px">
        <p class="hint" style="border-left:3px solid var(--rd);padding-left:8px">
          <b>Ab jetzt fließt echtes Geld.</b> Die Engine kauft und verkauft
          selbstständig auf deinem Alpaca-Echtgeldkonto — ohne weitere
          Rückfrage, rund um die Uhr für Krypto, zu Börsenzeiten für den Rest.
          Verluste sind real und nicht rückgängig zu machen.</p>
        <p class="hint">Zum Bestätigen <b>ECHTGELD</b> tippen. Deine Anmeldung
          muss dabei frisch sein — du wirst nach deinem Passwort gefragt.</p>
        <div class="row" style="align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
          <input id="lvWord" class="inp" style="flex:1;min-width:120px" type="text"
            autocomplete="off" spellcheck="false" placeholder="ECHTGELD" />
          <input id="lvPw" class="inp" style="flex:1;min-width:120px" type="password"
            autocomplete="current-password" placeholder="Dein Passwort" />
        </div>
      </div>
      <div class="row" style="align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-n" id="lvGo">Auf ECHTGELD umstellen</button>
        <button class="btn btn-n" id="lvOff" hidden>Zurück auf Papierhandel</button>
      </div>
      <div id="lvOut" style="margin-top:8px"></div>
      <p class="hint" style="margin-top:8px">
        <b>Was passiert beim Stoppen?</b> Die Engine legt sofort die Hände in den
        Schoß: keine neuen Käufe, keine Verkäufe, auch keine Stop-Loss- oder
        Take-Profit-Ausführungen. Dein Depot bleibt <b>exakt so stehen, wie es
        ist</b> — es wird nichts glattgestellt. Das ist gewollt, hat aber eine
        Kehrseite: Ein gestopptes Konto ist auch ein <b>ungeschütztes</b> Konto.
        Wer über Nacht stoppt und Positionen offen lässt, hat keinen Stop-Loss
        mehr. Für längere Pausen deshalb besser: Positionen von Hand schließen,
        dann stoppen.</p>
      <div class="wl-sec" style="margin-top:14px">Steuer-Export ${iBtn('taxReport')}</div>
      <p class="hint">Paart Käufe und Verkäufe nach <b>FIFO</b>, rechnet Haltedauern
        und sortiert die Ergebnisse in die Töpfe, die das deutsche Recht getrennt
        hält. Bei Krypto zählt die <b>Ein-Jahres-Frist</b> — danach steuerfrei.
        Keine Steuerberatung: Die Zahlen sind eine Aufbereitung für deinen
        Steuerberater, keine Steuerschuld.</p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <select id="txYear" class="inp st-num" style="max-width:110px"></select>
        <label class="hint" style="display:flex;align-items:center;gap:5px">
          <input type="checkbox" id="txReal" /> nur Echtgeld
        </label>
        <button class="btn btn-n" id="txGo">Bericht erstellen</button>
      </div>
      <div id="txOut" style="margin-top:8px"></div>
      <div class="wl-sec" style="margin-top:14px">Tages-Notbremse ${iBtn('dailyLossLimit')}</div>
      <p class="hint" id="bkrState">—</p>
      <div class="row" style="align-items:center;gap:8px">
        <button class="btn btn-n" id="bkrReset">Notbremse lösen</button>
        <span class="hint" id="bkrMsg"></span>
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
      <!-- Startkapital vom Broker (Owner-Frage 05.08.). Bewusst NUR hier:
           Der Kontostand ist die Bezugsgroesse jeder Kennzahl — mitten in der
           Messung gewechselt, beziehen sich alte und neue Zahlen auf
           verschiedene Kapitalbasen. Beim Reset ist die Historie ohnehin weg. -->
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <label class="hint" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="rsFromBroker" />
          Startkapital vom verbundenen Broker übernehmen (statt der Zahl oben)
        </label>
      </div>
      <div class="hint" id="rsMsg"></div>
    </div>
  </div>

`;
}

/** Muss identisch zu RESET_CONFIRM_WORD im Server sein — der prüft es erneut. */
const RESET_CONFIRM_WORD = 'RESET';

/**
 * HTML-Escaping für Text, der aus einer Antwort des Servers stammt.
 *
 * Modul-weit, weil Broker-Meldungen und Steuer-Hinweise dieselbe Behandlung
 * brauchen: Beide enthalten Text, den nicht dieser Code geschrieben hat.
 */
function escText(s: string): string {
  return s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!,
  );
}

/**
 * Broker-Status als Karte.
 *
 * Die drei Schalter stehen einzeln da, weil genau ihr ZUSAMMENSPIEL über
 * echtes Geld entscheidet. Wer nur „live" liest, weiß nicht, ob das am
 * Wunsch, an der Freigabe oder an beidem liegt — und wer nachher fragt,
 * warum nichts passiert ist, soll es hier ablesen können.
 */
function renderBrokerStatus(r: BrokerStatusResult): string {
  const e = escText;
  const ampel = (an: boolean): string =>
    an ? '<span class="up">●</span>' : '<span class="hint">○</span>';
  const k = r.konto;

  const abw =
    r.abweichungen.length > 0
      ? `<table class="tbl st-num" style="width:100%;margin-top:6px">
           <thead><tr><th>Symbol</th><th class="num">eigenes Buch</th>
             <th class="num">Broker</th><th class="num">Differenz</th></tr></thead>
           <tbody>${r.abweichungen
             .map(
               (a) => `<tr><td>${e(a.symbol)}</td><td class="num">${a.eigeneMenge}</td>
                 <td class="num">${a.brokerMenge}</td>
                 <td class="num dn"><b>${a.differenz > 0 ? '+' : ''}${a.differenz}</b></td></tr>`,
             )
             .join('')}</tbody></table>
         <p class="hint">Eine Position, die nur beim Broker liegt, ist ein Risiko,
           von dem die Engine nichts weiß. Eine, die nur im Buch steht, lässt sie
           mit einer Deckung rechnen, die es nicht gibt. Beides vor dem Handeln klären.</p>`
      : '';

  // Die Reife-Liste ist der Kern der Karte: Sie zeigt, wie weit das System
  // noch von echtem Geld entfernt ist — mit Zahlen statt mit einem Gefühl.
  const reifeListe = r.reife.kriterien
    .map(
      (k) => `<tr><td>${ampel(k.erfuellt)} ${e(k.name)}</td>
        <td class="num">${e(k.ist)}</td>
        <td class="num hint">${e(k.soll)}</td></tr>`,
    )
    .join('');

  const kante =
    r.kante.nettoPct !== null
      ? `<p class="hint">Je Trade: <b>${r.kante.bruttoPct?.toFixed(3)} %</b> brutto gegen
         <b>${r.kante.kostenPct?.toFixed(3)} %</b> Kosten ⇒
         <b class="${r.kante.nettoPct >= 0 ? 'up' : 'dn'}">${r.kante.nettoPct.toFixed(3)} %</b> netto.
         Die Kante deckt die Reibung <b>${r.kante.deckung?.toFixed(2)}×</b>${
           (r.kante.deckung ?? 0) < 1
             ? ' — unter 1 heißt: strukturell defizitär, unabhängig von der Marktphase.'
             : '.'
         }</p>`
      : '';

  return `
    <div class="hint" style="margin-bottom:6px"><b>${
      r.modus === 'live' ? 'ECHTGELD' : 'Papierhandel'
    }</b> — ${e(r.meldung)}</div>
    <div class="hint">
      ${ampel(r.schluesselVorhanden)} Schlüssel hinterlegt ·
      ${ampel(r.wunschLive)} Strategie auf Echtgeld ·
      ${ampel(r.envFreigabe)} Umgebungs-Freigabe ·
      ${ampel(r.reife.bereit)} Live-Reife (${r.reife.erfuellt}/${r.reife.gesamt})
    </div>
    <table class="tbl st-num" style="width:100%;margin-top:6px">
      <thead><tr><th>Kriterium</th><th class="num">ist</th><th class="num">soll</th></tr></thead>
      <tbody>${reifeListe}</tbody>
    </table>
    ${kante}
    ${
      k
        ? `<table class="tbl st-num" style="width:100%;margin-top:6px"><tbody>
             <tr><td>Kontostatus</td><td class="num">${e(k.status)}</td></tr>
             <tr><td>Barbestand</td><td class="num">${k.cash.toFixed(2)} ${e(k.currency)}</td></tr>
             <tr><td>Depotwert</td><td class="num">${k.equity.toFixed(2)} ${e(k.currency)}</td></tr>
             <tr><td>Kaufkraft</td><td class="num">${k.buyingPower.toFixed(2)} ${e(k.currency)}</td></tr>
           </tbody></table>`
        : ''
    }
    ${abw}
    ${r.fehler ? `<p class="hint">${e(r.fehler)}</p>` : ''}`;
}

/** Klarnamen der Steuertöpfe — die Kürzel sagen einem Menschen nichts. */
const TOPF_LABEL: Record<string, string> = {
  aktien: 'Aktien (§ 20 Abs. 6 S. 4)',
  sonstige: 'ETFs / Sonstige (§ 20)',
  termin: 'Termingeschäfte / Leerverkäufe',
  privat: 'Krypto — privates Veräußerungsgeschäft (§ 23)',
};

/**
 * Steuerbericht als Karte.
 *
 * Die Töpfe stehen einzeln UND ohne Gesamtsumme. Das ist Absicht: Eine
 * Gesamtsumme wäre die eine Zahl, die jeder ablesen würde — und sie wäre
 * steuerlich bedeutungslos, weil die Töpfe nicht gegeneinander verrechnet
 * werden dürfen. Wer sie zeigt, lädt zum größten Fehler ein.
 */
function renderSteuerbericht(r: TaxReportResult): string {
  const e = escText;
  const geld = (n: number): string =>
    `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.bericht.waehrung}`;
  const eur = (n: number): string =>
    `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const b = r.bericht;

  const zeilen = (Object.keys(TOPF_LABEL) as Array<keyof typeof b.toepfe>)
    .map((k) => ({ k, t: b.toepfe[k] }))
    .filter((x) => x.t.n > 0)
    .map(
      (x) => `<tr>
        <td>${e(TOPF_LABEL[x.k] ?? String(x.k))}</td>
        <td class="num">${x.t.n}</td>
        <td class="num">${geld(x.t.gewinne)}</td>
        <td class="num">${geld(-x.t.verluste)}</td>
        <td class="num ${x.t.saldo >= 0 ? 'up' : 'dn'}"><b>${geld(x.t.saldo)}</b></td>
        <td class="num ${(x.t.eurSaldo ?? 0) >= 0 ? 'up' : 'dn'}">${
          x.t.eurSaldo === null || x.t.eurSaldo === undefined
            ? '<span class="hint">—</span>'
            : `<b>${eur(x.t.eurSaldo)}</b>`
        }</td>
      </tr>`,
    )
    .join('');

  const hinweise: string[] = [];
  if (!b.echtgeld) {
    hinweise.push(
      '<b>Papierhandel.</b> Diese Zahlen sind nicht steuerbar — Papiergewinne sind ' +
        'keine Einkünfte. Der Bericht zeigt, wie er bei Echtgeld aussähe.',
    );
  }
  if (b.privatSteuerfrei !== 0) {
    hinweise.push(
      `<b>${geld(b.privatSteuerfrei)}</b> aus Krypto sind nach der Ein-Jahres-Frist ` +
        'steuerfrei und stehen deshalb in keinem Topf.',
    );
  }
  if (b.privatUnterFreigrenze) {
    hinweise.push(
      `Der § 23-Gewinn von ${geld(b.privatSteuerpflichtig)} liegt unter der Freigrenze ` +
        `von ${b.rechtsstand.privatFreigrenze} € — dann ist er ganz steuerfrei. Achtung: ` +
        'Das ist eine Freigrenze, kein Freibetrag; ein Euro darüber macht den ganzen Betrag steuerpflichtig.',
    );
  }
  if (r.historieUnvollstaendig) {
    hinweise.push(
      '<b>Historie unvollständig.</b> Es wurden nicht alle Trades gelesen — ' +
        'Anschaffungskurse können fehlen und Gewinne dadurch zu hoch stehen.',
    );
  }
  if (b.unpaarbar.length > 0) {
    hinweise.push(
      `${b.unpaarbar.length} Verkäufe ohne passende Anschaffung — sie sind ` +
        'ausgelassen statt geraten.',
    );
  }
  if (b.fxLuecken > 0) {
    hinweise.push(
      `<b>${b.fxLuecken} Vorgänge ohne hinterlegten Wechselkurs.</b> Für sie steht ` +
        'in der Euro-Spalte nichts — ein aus dem Fremdwährungs-Ergebnis hochgerechneter ' +
        'Betrag wäre steuerlich unzulässig. Betroffen sind Trades von vor dem 04.08.2026; ' +
        'seither friert jeder Trade den EZB-Kurs seines Tages mit ein.',
    );
  } else if (b.veraeusserungen.length > 0) {
    hinweise.push(
      'Die Euro-Beträge sind <b>je Vorgang</b> zum EZB-Kurs seines Tages gerechnet — ' +
        'Anschaffung und Veräußerung getrennt. Das Fremdwährungs-Ergebnis am Ende ' +
        'umzurechnen wäre unzulässig und verschluckte genau den Währungsgewinn, ' +
        'der steuerpflichtig ist.',
    );
  }

  const offen = b.offen.length;
  const fristBald = b.offen.filter(
    (o) => typeof o.tageBisJahresfrist === 'number' && o.tageBisJahresfrist > 0,
  );

  return `
    <table class="tbl st-num" style="width:100%">
      <thead><tr><th>Topf</th><th class="num">Fälle</th><th class="num">Gewinne</th>
        <th class="num">Verluste</th><th class="num">Saldo</th><th class="num">Saldo EUR</th></tr></thead>
      <tbody>${zeilen || '<tr><td colspan="6" class="hint">Keine Veräußerungen in diesem Jahr.</td></tr>'}</tbody>
    </table>
    <p class="hint" style="margin-top:6px">Die Töpfe stehen bewusst einzeln und ohne
      Gesamtsumme — sie dürfen nicht gegeneinander verrechnet werden.</p>
    ${hinweise.map((h) => `<p class="hint">${h}</p>`).join('')}
    ${
      offen > 0
        ? `<p class="hint">${offen} offene Position${offen === 1 ? '' : 'en'} — noch nicht
           veräußert, also noch nicht steuerbar.${
             fristBald.length > 0
               ? ` Bei ${fristBald.length} davon läuft die Krypto-Jahresfrist noch
                   (nächste in ${Math.min(...fristBald.map((o) => o.tageBisJahresfrist ?? 0))} Tagen).`
               : ''
           }</p>`
        : ''
    }
    <div class="row" style="gap:8px;margin-top:8px;align-items:center">
      <a class="btn btn-n" id="txCsv" href="#" download>CSV herunterladen</a>
      <span class="hint">${r.gelesen} Trades geprüft · ${b.veraeusserungen.length} Veräußerungen</span>
    </div>
    <p class="hint" style="margin-top:6px">${e(b.rechtsstandHinweis)}</p>
    <p class="hint"><b>Keine Steuerberatung.</b> Es wird bewusst keine Steuerschuld
      gerechnet — sie hängt von Kirchensteuer, Veranlagungsart, Freistellungsaufträgen
      und Verlustvorträgen ab, die dieses System nicht kennt.</p>`;
}

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
        st.news = d?.news ?? null;
        applyForecast();
        applyMarkers(); // News-Punkte folgen dem market-Doc (29.07.)
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
    applyPosition();
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
  applyPosition();
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
  const el = $('resBadge');
  // Zeitzone nur bei Intraday nennen — Tageskerzen tragen den Handelstag in
  // Börsenzeit und haben gar keine Uhrzeit, auf die sich ein Kürzel bezöge.
  const zone = st.intradayDays > 0 ? ` · ${zonenKuerzel(new Date())}` : '';
  el.textContent = (st.autoRes ? `Auto · ${label}` : label) + zone;
  el.title = st.intradayDays > 0
    ? 'Aktive Kerzen-Auflösung — Uhrzeiten auf der Zeitachse und in der Kurszeile stehen in deiner Ortszeit'
    : 'Aktive Kerzen-Auflösung';
  renderMarktBadge();
}

/**
 * Markt-Status des gezeigten Symbols (Owner-Fund 04.08.).
 *
 * Warum das hier steht: Der Owner sah bei GOOGL und AMZN „22:00", während es
 * bei ihm 15:15 war — und hielt es für einen Anzeigefehler. Es war der
 * gestrige US-Schluss (16:00 New York). Vor der Eröffnung um 15:30 unserer
 * Zeit KANN die jüngste Kerze nicht von heute sein; bei Krypto dagegen ist
 * sie es immer. Ohne diesen Hinweis sieht beides gleich aus wie ein Fehler.
 */
function renderMarktBadge(): void {
  if (!st) return;
  const el = $('mktBadge');
  const klasse = classify(st.currentSymbol);
  if (marketOpenForClass(klasse, new Date())) {
    el.hidden = true;
    return;
  }
  el.textContent = 'Markt zu';
  el.title =
    `${st.currentSymbol}: Die Börse dieser Anlageklasse handelt gerade nicht. ` +
    'Die jüngste Kerze stammt deshalb vom letzten Handelstag — die Uhrzeit in ' +
    'der Kurszeile gehört zu ihr, nicht zu jetzt.';
  el.hidden = false;
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
  // Kurslinie seit Einstieg — zuletzt, damit sie über den Indikatoren liegt
  const verlauf = positionsVerlauf(times, closes);
  if (verlauf) lines.push(verlauf);
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
  const time = 'date' in last ? last.date : intradayLabel(last.time);
  return { time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? null };
}

/**
 * Uhrzeit eines Intraday-Bars — mit Tages-Angabe, wenn er nicht von heute ist.
 *
 * Owner-Fund 04.08.: „bei Google und Amazon wird 22 Uhr gezeigt, obwohl hier
 * 15:15 ist". Die 22:00 stimmten — es war der gestrige US-Schluss (16:00 New
 * York). Falsch war nur, dass nichts es sagte: Eine nackte Uhrzeit liest man
 * als „jetzt". Vor der US-Eröffnung um 15:30 unserer Zeit ist die jüngste
 * Kerze zwangsläufig von gestern, bei Krypto dagegen von eben — daher zeigten
 * verschiedene Charts verschiedene Uhrzeiten, ohne dass eine falsch war.
 */
function intradayLabel(sek: number): string {
  const d = new Date(sek * 1000);
  const uhr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const praefix = tagesPraefix(lokalerTag(d), lokalerTag(new Date()));
  return praefix ? `${praefix} ${uhr}` : uhr;
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
    } else if (l.key === 'pos:seit') {
      items.push({
        c: l.color,
        t: 'Seit Einstieg',
        title: 'Kursverlauf ab dem Einstiegs-Bar der offenen Position — grün, wenn die Position gerade im Gewinn liegt',
      });
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
      corePct: Math.min(CORE_PCT_CAP, Math.max(0, num('owCore'))),
      stopLossPct: num('owSl'),
      takeProfitPct: num('owTp'),
      trailingStopPct: num('owTrail'),
      maxHoldDays: num('owHold'),
      atrStopMult: num('owAtrS'),
      atrTakeMult: num('owAtrT'),
      cooldownMin: Math.min(1440, Math.max(5, num('owCd') || 15)),
      dailyLossLimitPct: Math.min(25, Math.max(0, num('owBreak') || 0)),
      flattenOnBreach: ($('owFlatten') as HTMLInputElement).checked,
      // Alle Klassen explizit, auch die auf 1: `saveStrategy` schreibt die
      // Strategie als Ganzes, aber ein weggelassener Schlüssel wäre beim
      // nächsten Öffnen nicht von „bewusst auf 1 gestellt" zu unterscheiden.
      classWeights: klassenGewichteAusForm(),
      classAutoTune: ($('owClsAuto') as HTMLInputElement).checked,
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
      regimeGate: ($('owRegimeGate') as HTMLInputElement).checked,
    },
  };
}

/**
 * Zustand der Tages-Notbremse zeigen (M12).
 *
 * Sie ist eine stille Sperre — ohne diese Zeile sähe ein gebremstes Konto
 * exakt aus wie ein ruhiger Markt. Genau der Fehler, den die Karte „Warum
 * handelt die Engine (nicht)?" für die Filter längst behebt.
 */
function renderBreaker(b: { am: string; grund: string; verlustPct: number | null } | null): void {
  const el = document.getElementById('bkrState');
  if (!el) return;
  const grenze = st?.strategy.engine.dailyLossLimitPct ?? 0;
  if (!b) {
    el.textContent = grenze > 0
      ? `Nicht ausgelöst. Grenze: ${String(grenze).replace('.', ',')} % Tagesverlust.`
      : 'Ausgeschaltet — trage oben eine Grenze ein, um sie zu aktivieren.';
    el.style.color = '';
    return;
  }
  el.innerHTML =
    `<b style="color:var(--rd)">Ausgelöst</b> am ${escText(b.am.slice(0, 16).replace('T', ' '))} Uhr`
    + (b.verlustPct === null ? '' : ` (${b.verlustPct.toFixed(2).replace('.', ',')} % Tagesverlust)`)
    + `.<br />${escText(b.grund)}`;
}

/**
 * Die drei Guards des Echtgeld-Handels anzeigen (M14, 05.08.).
 *
 * Alle drei stehen zusammen in einer Liste, weil die Frage, die hier
 * beantwortet werden muss, immer dieselbe ist: „Warum handelt es noch nicht
 * mit echtem Geld?" Wären sie über drei Karten verteilt, wäre die Antwort
 * eine Suchaufgabe — und der wahrscheinlichste Schluss der falsche
 * („kaputt") statt des richtigen („eine Bedingung fehlt noch").
 */
function renderLiveStatus(s: LiveModeStatus | null, istLive: boolean): void {
  const state = document.getElementById('lvState');
  const krit = document.getElementById('lvKrit');
  const on = document.getElementById('lvOn');
  const go = document.getElementById('lvGo') as HTMLButtonElement | null;
  const off = document.getElementById('lvOff') as HTMLButtonElement | null;
  if (!state || !krit || !on || !go || !off) return;

  // Im Echtgeld-Betrieb steht der Rückweg im Vordergrund, nicht der Hinweg.
  off.hidden = !istLive;
  go.hidden = istLive;
  on.hidden = istLive;
  if (istLive) {
    state.innerHTML = '<b style="color:var(--rd)">ECHTGELD ist scharf.</b> '
      + 'Gehandelt wird, sobald die Engine auf „Start" steht.';
    krit.innerHTML = '';
    return;
  }
  if (!s) {
    state.textContent = 'Zustand wird geladen …';
    return;
  }

  const zeile = (name: string, ok: boolean, text: string): string =>
    `<div class="hint" style="margin-top:4px"><b style="color:${
      ok ? 'var(--gn)' : 'var(--t3)'
    }">${ok ? '✓' : '○'}</b> <b>${escText(name)}</b> — ${escText(text)}</div>`;

  const kontoOk = s.brokerArt === 'live';
  krit.innerHTML =
    zeile(
      'Echtgeldkonto verbunden',
      kontoOk,
      s.brokerArt === null
        ? 'kein Broker hinterlegt'
        : s.brokerArt === 'paper'
          ? 'verbunden ist ein Papierkonto (PK…)'
          : 'Echtgeld-Schlüssel liegt verschlüsselt',
    )
    + zeile(
      'Server-Freigabe',
      s.serverFreigabe,
      s.serverFreigabe
        ? 'der Betreiber hat Echtgeld eingeschaltet'
        : 'ALPACA_ALLOW_LIVE fehlt — nur der Betreiber kann das setzen',
    )
    + zeile(
      `Reife (${s.reife.erfuellt}/${s.reife.gesamt})`,
      s.reife.bereit,
      s.reife.fazit,
    )
    + s.reife.kriterien
        .map(
          (k) =>
            `<div class="hint" style="margin-left:16px;opacity:.8">${
              k.erfuellt ? '✓' : '○'
            } ${escText(k.name)}: ${escText(k.ist)} (nötig ${escText(k.soll)})</div>`,
        )
        .join('');

  const alles = kontoOk && s.serverFreigabe && s.reife.bereit;
  state.innerHTML = alles
    ? '<b>Alle Bedingungen erfüllt.</b> Der Schalter unten stellt scharf.'
    : '<b>Noch nicht scharf schaltbar.</b> Offene Punkte stehen unten — '
      + 'jeder einzelne verhindert Echtgeld-Handel.';
  // Der Knopf bleibt klickbar, auch wenn etwas fehlt: Die Server-Antwort
  // nennt dann den Grund. Ein ausgegrauter Knopf ohne Begründung ist die
  // schlechtere Auskunft.
  on.hidden = !alles;
}

/**
 * Zustand des laufenden Abgleichs Buch ↔ Broker-Depot zeigen (M13).
 *
 * Er läuft bei jedem Scan und meldet sich nur, wenn etwas nicht stimmt —
 * dieselbe Stille wie bei der Notbremse, und dasselbe Problem: Ohne Anzeige
 * ist „läuft sauber" von „läuft gar nicht" nicht zu unterscheiden. Deshalb
 * steht hier auch im Gutfall eine Zeile, mit Zeitstempel.
 */
function renderAbgleich(
  a: {
    at: string;
    status: string;
    anzahl: number;
    /** Im Buch, nicht beim Broker — die gefährliche Richtung, sperrt. */
    fehlbestand?: number;
    /** Nur beim Broker — Fremdbestand, sperrt nicht. */
    fremdbestand?: number;
    verglichen: number;
    brokerPositionen: number;
    fehler: string;
  } | null,
): void {
  const el = document.getElementById('bkAuto');
  if (!el) return;
  if (!a) {
    el.textContent =
      'Kein automatischer Abgleich bisher — er läuft ab dem nächsten Scan, sobald ein Broker verbunden ist.';
    return;
  }
  const wann = escText(a.at.slice(0, 16).replace('T', ' '));
  if (a.status === 'fehler') {
    el.innerHTML =
      `<b>Abgleich nicht möglich</b> (${wann} Uhr): ${escText(a.fehler)}.<br />`
      + 'Der Handel läuft weiter — ein Netzwerkfehler ist kein Beweis für eine Abweichung.';
    return;
  }
  if (a.status === 'drift') {
    /* Zwei Arten von Drift, zwei Aussagen (Live-Fund 05.08.).
     *
     * Fehlbestand heißt: Im Buch stehen Stücke, die der Broker nicht hat —
     * die Engine rechnet mit etwas, das es nicht gibt. Fremdbestand heißt:
     * Beim Broker liegt etwas, das die Engine nie anfassen wird. Nur das
     * erste sperrt. Eine Anzeige, die beides „Abweichung" nennt, treibt
     * einen zur Suche nach einem Fehler, den es nicht gibt. */
    if ((a.fehlbestand ?? a.anzahl) > 0) {
      el.innerHTML =
        `<b style="color:var(--rd)">${a.fehlbestand ?? a.anzahl} Position(en) fehlen beim Broker</b> `
        + `(${wann} Uhr). <b>Neue Einstiege sind gesperrt</b>, Ausstiege bleiben frei.`;
    } else {
      el.innerHTML =
        `<b>${a.fremdbestand ?? a.anzahl} Position(en) nur beim Broker</b> (${wann} Uhr) — `
        + 'nicht von dieser Engine eröffnet. Sie bleiben unangetastet, der Handel läuft weiter.';
    }
    return;
  }
  el.innerHTML =
    `<b style="color:var(--gn)">Buch und Depot stimmen überein</b> (${wann} Uhr) — `
    + `${a.verglichen} eigene, ${a.brokerPositionen} beim Broker.`;
}

/** Aktuelle Reglerstellungen je Anlageklasse aus dem Formular. */
function klassenGewichteAusForm(): Record<string, number> {
  const out: Record<string, number> = {};
  $('owClsRows')
    .querySelectorAll<HTMLInputElement>('input[data-cls]')
    .forEach((r) => {
      const k = r.dataset.cls ?? '';
      if (k) out[k] = Math.min(1.5, Math.max(0, Number(r.value)));
    });
  return out;
}

/** Ein Regler-Wert als Text — „aus" ist eine andere Aussage als „0,00". */
function gewichtText(w: number): string {
  return w === 0 ? 'aus' : `× ${w.toFixed(2).replace('.', ',')}`;
}

/** Schieberegler je Anlageklasse zeichnen (MG2). */
function renderKlassenRegler(): void {
  const gew = st?.strategy.engine.classWeights ?? {};
  $('owClsRows').innerHTML = Object.entries(CLASS_LABELS)
    .map(([k, label]) => {
      const w = Math.min(1.5, Math.max(0, gew[k] ?? 1));
      return `<label class="cls-row">
        <span>${label}</span>
        <input type="range" data-cls="${k}" min="0" max="1.5" step="0.25" value="${w}" />
        <span class="mono cls-val" data-clsval="${k}">${gewichtText(w)}</span>
      </label>`;
    })
    .join('');
  $('owClsRows')
    .querySelectorAll<HTMLInputElement>('input[data-cls]')
    .forEach((r) =>
      r.addEventListener('input', () => {
        const k = r.dataset.cls ?? '';
        const feld = $('owClsRows').querySelector(`[data-clsval="${k}"]`);
        if (feld) feld.textContent = gewichtText(Number(r.value));
      }),
    );
}

/**
 * Empfehlungs-Karte je Anlageklasse (MG2).
 *
 * Die Zahlen kommen fertig vom Tageslauf (`stats/main.classAdvice`) — die
 * Oberfläche rechnet bewusst nichts nach. Zwei Implementierungen derselben
 * Regel wären zwei Wahrheiten, sobald eine davon nachzieht.
 */
function renderKlassenRat(): void {
  const box = $('owClsAdvice');
  const rat = st?.pfStats?.classAdvice;
  const btn = $('owClsApply') as HTMLButtonElement;
  if (!rat || rat.raete.length === 0) {
    btn.hidden = true;
    box.innerHTML =
      '<p class="hint">Noch keine Auswertung. Sie entsteht im Tageslauf nach '
      + 'US-Börsenschluss, sobald eine Klasse genug Trades hat.</p>';
    return;
  }
  const farbe: Record<string, string> = {
    verstaerken: 'var(--gr, #3fa971)',
    zurueckholen: 'var(--gr, #3fa971)',
    behalten: 'var(--c-t3, #8b93a7)',
    drosseln: 'var(--yl, #d9a441)',
    abschalten: 'var(--rd)',
    zu_wenig_daten: 'var(--c-t3, #8b93a7)',
  };
  const wort: Record<string, string> = {
    verstaerken: 'VERSTÄRKEN',
    zurueckholen: 'ZURÜCKHOLEN',
    behalten: 'BEHALTEN',
    drosseln: 'DROSSELN',
    abschalten: 'ABSCHALTEN',
    zu_wenig_daten: 'ZU WENIG DATEN',
  };
  btn.hidden = rat.aenderungen === 0;
  box.innerHTML =
    `<p class="hint"><b>${rat.fazit}</b>`
    + (rat.autoTune ? ' · Auto-Regler ist an.' : ' · Auto-Regler ist aus.')
    + '</p>'
    + rat.raete
        .map((r) => {
          const kante = r.kantePct === null ? '—' : `${r.kantePct.toFixed(3)} %`.replace('.', ',');
          const pfeil =
            Math.abs(r.vorschlag - r.gewicht) > 1e-9
              ? ` · ${gewichtText(r.gewicht)} → <b>${gewichtText(r.vorschlag)}</b>`
              : '';
          return `<div class="hint" style="margin-top:6px">
            <b style="color:${farbe[r.empfehlung] ?? 'inherit'}">${wort[r.empfehlung] ?? r.empfehlung}</b>
            · <b>${CLASS_LABELS[r.klasse] ?? r.klasse}</b>
            · ${kante} je Dollar (${r.n} Trades)${pfeil}<br />${r.grund}</div>`;
        })
        .join('');
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
  // Fehlendes Feld zeigt den Default (Owner-Anweisung 04.08.: „bitte bei
  // jedem Konto automatisch als Standardeinstellung setzen"). Vorher stand
  // hier bewusst 0, weil der Sockel nur für neue Konten galt — mit der
  // Migration corePctAll_2026_08_04 hat jedes Konto einen echten Wert, und
  // das Formular soll dieselbe Wahrheit zeigen wie der Server.
  ($('owCore') as HTMLInputElement).value = String(
    st.strategy.engine.corePct ?? DEFAULT_CORE_PCT);
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
  ($('owRegimeGate') as HTMLInputElement).checked = st.strategy.signals.regimeGate !== false; // fehlend = an
  // Klassen-Profile transparent machen: Sie überschreiben die Werte oben je
  // Asset-Klasse — der User soll wissen, was für sein Symbol tatsächlich gilt.
  const byCls = st.strategy.engine.byClass ?? {};
  const clsTxt = Object.entries(byCls)
    .map(([c, o]) => `${CLASS_LABELS[c] ?? c}: Stop ${o.stopLossPct ?? '–'} % / Ziel ${o.takeProfitPct ?? '–'} %`)
    .join(' · ');
  $('owClassHint').textContent = clsTxt
    ? `Abweichende Profile je Anlageklasse (überschreiben die Werte oben): ${clsTxt}`
    : '';
  ($('owBreak') as HTMLInputElement).value = String(st.strategy.engine.dailyLossLimitPct ?? 0);
  ($('owFlatten') as HTMLInputElement).checked = st.strategy.engine.flattenOnBreach === true;
  ($('owClsAuto') as HTMLInputElement).checked = st.strategy.engine.classAutoTune === true;
  renderKlassenRegler();
  renderKlassenRat();
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
 * Marker auf dem Haupt-Chart — die EINE Stelle für setMarkers (verteilte
 * Aufrufe waren früher die Quelle von Sync-Fehlern).
 *
 * Seit 29.07. wieder mit Inhalt: News-Punkte aus `market/{sym}.news` — den
 * Schlagzeilen, die der Scan ohnehin fürs Einstiegs-Veto lädt (Owner: „nur
 * die auch genutzt werden, nicht extra nach News suchen"). Läuft das Veto,
 * zeigt ein gelber Pfeil den auslösenden Bar.
 */
function applyMarkers(): void {
  if (!st?.chart) return;
  const intraday = st.intradayDays > 0;
  const times: Array<string | number> = intraday
    ? st.shownIntraday.map((b) => b.time)
    : st.bars.map((b) => b.date);
  const markers: ChartMarker[] =
    st.showNews && !st.cleanView
      ? newsChartMarkers(st.news, times, Math.floor(Date.now() / 1000), vetoAnzeige())
      : [];
  const einstieg = positionsMarker(times);
  if (einstieg) markers.push(einstieg);
  st.lastMainMarkers = markers.length; // E2E-Hook
  st.chart.setMarkers(markers);
}

/* ── Offene Position im Chart (Owner-Wunsch 04.08.) ──────────────────────
 * „Wenn man in einem aktiven Trade das Chart öffnet: wann bin ich rein und
 * wie ist es seither gelaufen?" — Antwort in drei Schichten:
 *   1. Marke am Einstiegs-Bar (Pfeil hoch beim Long, runter beim Short),
 *   2. waagerechte Linien für Einstand, Stop, Trailing und Ziel,
 *   3. die Kurslinie SEIT dem Einstieg, gefärbt nach aktuellem Ergebnis.
 * Alle Zahlen stammen aus `positionLevels`/`positionPnl` (shared) — derselben
 * Rechnung wie die Positionstabelle, damit Chart und Tabelle nie widersprechen.
 */
const POS_FARBEN = {
  entry: '#e8c76a',
  stop: '#f2586b',
  trail: '#f0913c',
  target: '#26cf9d',
  gewinn: 'rgba(38,207,157,.9)',
  verlust: 'rgba(242,88,107,.9)',
} as const;

/**
 * Offene Position eines Symbols — null, wenn keine da ist, der Layer aus ist
 * oder der Clean-View läuft (der blendet alles Optionale aus). Gilt für JEDES
 * Chart-Fenster (Grid-Gleichwertigkeit), nicht nur fürs Haupt-Chart.
 */
function posFuerSymbol(sym: string): Position | null {
  if (!st || !st.showPos || st.cleanView) return null;
  return st.positions.find((p) => p.symbol === sym) ?? null;
}

/** Offene Position im gerade gezeigten Haupt-Symbol. */
function posImChart(): Position | null {
  return st ? posFuerSymbol(st.currentSymbol) : null;
}

/** Level der offenen Position (klassen-aufgelöst wie in der Engine). */
function posLevels(p: Position): PositionLevels {
  return positionLevels(p, resolveRisk(st!.strategy.engine, classify(p.symbol)));
}

/** Zuletzt bekannter Kurs der Position (Quote-Abo, sonst letzter Bar). */
function posKurs(p: Position, fallback?: number): number {
  const live = st?.posPrices.get(p.symbol);
  if (live !== undefined && live > 0) return live;
  if (fallback !== undefined && fallback > 0) return fallback;
  const closes = shownSeries().closes;
  return closes[closes.length - 1] ?? p.avgEntry;
}

/**
 * Preislinien für Einstand, Stop, Trailing und Ziel einer Position.
 *
 * Bewusst karg (Owner 04.08.: „überlagert zu viel Info"): NUR der Einstand
 * bekommt einen Preis-Kasten auf der Skala — jeder weitere Kasten überdeckt
 * einen echten Skalenwert, und mit vieren war die Preisachse unlesbar.
 * Titel-Texte im Chart entfallen ganz; sie standen doppelt zum Achsen-Label
 * und lagen quer über den Kerzen. Welche Linie welche ist, sagt die Farbe
 * (rot = Stop, orange = Trailing, grün = Ziel) und der Chip mit den
 * Prozent-Abständen.
 */
function positionsLinien(p: Position): PriceLineSpec[] {
  const lv = posLevels(p);
  const lines: PriceLineSpec[] = [
    { key: 'pos:entry', price: lv.entry, color: POS_FARBEN.entry, style: 0, width: 2 },
  ];
  if (lv.stop !== null) lines.push({ key: 'pos:stop', price: lv.stop, color: POS_FARBEN.stop, style: 2, axisLabel: false });
  if (lv.trail !== null) lines.push({ key: 'pos:trail', price: lv.trail, color: POS_FARBEN.trail, style: 1, axisLabel: false });
  if (lv.target !== null) lines.push({ key: 'pos:target', price: lv.target, color: POS_FARBEN.target, style: 2, axisLabel: false });
  return lines;
}

/**
 * Marke am Einstiegs-Bar — nur wenn der Einstieg IM Fenster liegt.
 *
 * Der Marker hängt (wie die News-Punkte) an der Kerzen-Serie und verschwindet
 * deshalb im Vektor-Look „Kerzen aus". Das ist gewollt: Dort tragen die
 * Einstiegs-Linie und der Beginn der Seit-Einstieg-Kurve dieselbe Aussage,
 * und ein Marker ohne Kerze hätte keinen Bezugspunkt.
 */
function positionsMarker(times: Array<string | number>, sym?: string): ChartMarker | null {
  const p = sym === undefined ? posImChart() : posFuerSymbol(sym);
  if (!p) return null;
  const anker = entryAnchor(times, p.openedAt);
  // vorFenster: Der Einstieg liegt links außerhalb — ein Marker am ersten Bar
  // würde einen Zeitpunkt behaupten, der nicht stimmt.
  if (!anker || anker.vorFenster) return null;
  const short = p.side === 'short';
  return {
    time: times[anker.index]!,
    position: short ? 'aboveBar' : 'belowBar',
    color: POS_FARBEN.entry,
    shape: short ? 'arrowDown' : 'arrowUp',
    // Ohne Preis im Text: Der steht schon auf der Preisskala, und zwei Zahlen
    // für dieselbe Sache verdecken nur Kerzen (Owner 04.08.).
    text: short ? 'Short' : 'Kauf',
  };
}

/** Kurslinie seit Einstieg, grün im Gewinn / rot im Verlust. */
function positionsVerlauf(
  times: Array<string | number>,
  closes: number[],
  sym?: string,
): import('./chart.js').OverlayLine | null {
  const p = sym === undefined ? posImChart() : posFuerSymbol(sym);
  if (!p) return null;
  const anker = entryAnchor(times, p.openedAt);
  if (!anker || closes.length - anker.index < 2) return null;
  const { pnl } = positionPnl(p, posKurs(p, closes[closes.length - 1]));
  const punkte: Array<{ time: string | number; value: number }> = [];
  for (let i = anker.index; i < closes.length; i++) punkte.push({ time: times[i]!, value: closes[i]! });
  // Dünn (1 px): Die Kerzen zeigen den Verlauf, die Linie markiert nur die
  // Strecke seit Einstieg — 2 px legten sich wie ein Balken über die Körper.
  return { key: 'pos:seit', color: pnl >= 0 ? POS_FARBEN.gewinn : POS_FARBEN.verlust, width: 1, points: punkte };
}

/**
 * Preislinien + Chip der offenen Position (aus renderChart).
 *
 * Der Chip ist zweistufig (Owner 04.08.: „überlagert zu viel Info"): Zu sieht
 * man nur die drei Angaben, die man im Vorbeigehen braucht — Seite mit Stück
 * und das laufende Ergebnis. Ein Klick klappt Einstand, Haltedauer und die
 * Abstände zu Stop und Ziel auf. Gleiche Geste wie die OHLC-Zeile darüber,
 * gleicher Speicherort (Gerät-lokal).
 */
function applyPosition(): void {
  if (!st?.chart) return;
  const p = posImChart();
  const hud = $('posHud');
  if (!p) {
    st.chart.setPriceLines([]);
    hud.hidden = true;
    return;
  }
  const lv = posLevels(p);
  st.chart.setPriceLines(positionsLinien(p));

  const short = p.side === 'short';
  const live = posKurs(p);
  const { pnl, pct } = positionPnl(p, live);
  const teile = [
    `<b class="${short ? 'c-rd' : 'c-gn'}">${short ? 'SHORT' : 'LONG'} ${p.qty}</b>`,
    `<b class="${pnlClass(pnl)}">${fmtPct(pct)} · ${money(pnl)}</b>`,
  ];
  if (st.posOpen) {
    const tage = haltedauerTage(p.openedAt, Date.now());
    teile.splice(1, 0, tage === 0 ? 'heute rein' : tage === 1 ? 'seit 1 Tag' : `seit ${tage} Tagen`);
    teile.splice(2, 0, `${fmtNum(lv.entry)} → ${fmtNum(live)}`);
    if (p.core === true) teile.push('<span class="pos-tag">Sockel</span>');
    if (lv.stop !== null) teile.push(`Stop ${fmtPct(levelDistPct(lv.stop, live, 'stop', short))}`);
    else if (lv.stopAtr) teile.push('Stop adaptiv');
    if (lv.target !== null) teile.push(`Ziel ${fmtPct(levelDistPct(lv.target, live, 'target', short))}`);
    else if (lv.targetAtr) teile.push('Ziel adaptiv');
  }
  teile.push(`<span class="pos-fold">${st.posOpen ? '▾' : '▸'}</span>`);
  hud.innerHTML = teile.join(' <span class="pos-sep">·</span> ');
  hud.title = st.posOpen ? 'Details einklappen' : 'Einstand, Haltedauer und Abstände zu Stop/Ziel zeigen';
  hud.hidden = false;
}

/**
 * News-Overlay unterm Crosshair („den News bitte lesbar machen", Owner
 * 29.07.): Fährt/tippt man auf einen Tag mit News-Punkt, erscheinen dessen
 * Schlagzeilen als kleines Overlay — dieselbe Quelle wie die Punkte
 * (market/{sym}.news), kein Nachladen.
 *
 * Die Mechanik ist die bewährte aus der ersten News-Ära: Nur das Chart, das
 * das Overlay geöffnet hat, darf es schließen (Crosshair-SYNCS feuern auf den
 * Ziel-Charts Clear-Events — sonst löscht die Lock-Gruppe jeden Tooltip).
 * Auf Touch-Geräten verschwindet das Crosshair beim Loslassen sofort; das
 * Overlay bleibt dann 4 s stehen, damit man es lesen kann.
 */
let evTipTimer: number | null = null;
let evTipOwner: unknown = null;
const COARSE_POINTER = window.matchMedia?.('(pointer: coarse)').matches ?? false;

/**
 * Zeigt die Anzeige das Veto? NUR wenn der User es nicht abgeschaltet hat
 * (Optionen → „News-Veto"). Seine Engine setzt sonst gar nicht aus — ein
 * Pfeil, der ein Aussetzen behauptet, das nicht stattfindet, war der
 * Owner-Fund vom 29.07. („kann Veto nicht zurücknehmen!?").
 */
const vetoAnzeige = (): boolean => st?.strategy.signals.newsVeto !== false;

function showNewsTooltip(
  date: string | null,
  pos: { x: number; y: number } | null,
  news: MarketDocData['news'],
  owner: unknown,
): void {
  const tip = $('evTip');
  const day = st?.showNews && !st.cleanView
    ? newsForDay(news, date, Math.floor(Date.now() / 1000), vetoAnzeige())
    : null;
  if (!day || !pos) {
    if (owner !== evTipOwner) return; // Fremd-/Sync-Clear: Overlay bleibt
    if (COARSE_POINTER && !tip.hidden) {
      if (evTipTimer !== null) window.clearTimeout(evTipTimer);
      evTipTimer = window.setTimeout(() => {
        tip.hidden = true;
        evTipTimer = null;
      }, 4000);
      return;
    }
    tip.hidden = true;
    return;
  }
  evTipOwner = owner;
  if (evTipTimer !== null) {
    window.clearTimeout(evTipTimer);
    evTipTimer = null;
  }
  const tone = day.sentiment > 0.12 ? 'c-gn' : day.sentiment < -0.12 ? 'c-rd' : 'c-t3';
  tip.innerHTML = `
    <div class="evtip-hd"><span class="mono"></span>
      <span class="${tone}">${day.sentiment >= 0 ? '+' : ''}${day.sentiment.toFixed(2)}</span>
      <span class="evtip-n">${day.items.length} News</span></div>
    ${day.veto ? '<div class="evtip-row" style="color:var(--yl,#d9a441)">⏸ News-Veto aktiv — die Engine setzt neue Einstiege hier gerade aus.</div>' : ''}
    <div class="evtip-list"></div>`;
  tip.querySelector('.mono')!.textContent = day.date;
  const list = tip.querySelector('.evtip-list')!;
  for (const t of day.items.slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'evtip-row';
    row.textContent = `• ${t.title}`;
    const src = document.createElement('span');
    src.className = 'evtip-src';
    src.textContent = ` — ${t.source}`;
    row.appendChild(src);
    list.appendChild(row);
  }
  tip.hidden = false;
  // Ans Viewport clampen (Tooltip ist position:fixed)
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(pos.x + 14, window.innerWidth - w - 8)}px`;
  tip.style.top = `${Math.max(8, Math.min(pos.y - h - 10, window.innerHeight - h - 8))}px`;
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
  st.chart?.onCrosshairDate((date, pos) => {
    showNewsTooltip(date, pos, st?.news ?? null, 'main');
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
      p.news = d?.news ?? null;
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
  st.chart2?.onCrosshairDate((date, pos) => {
    // News-Overlay auch im Vergleichs-Chart — mit den Schlagzeilen des
    // VERGLEICHS-Symbols, nicht denen des Haupt-Charts
    showNewsTooltip(date, pos, st?.chart2P.news ?? null, st?.chart2P ?? 'chart2');
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
  // Offene Position auch im Raster (04.08.): Jedes Fenster zeigt dieselbe
  // Wahrheit über SEIN Symbol — sonst hinge die Antwort davon ab, in welchem
  // Kasten der Kurs gerade steht.
  const pPos = posFuerSymbol(p.sym);
  const pVerlauf = positionsVerlauf(times, closes, p.sym);
  if (pVerlauf) lines.push(pVerlauf);
  p.chart.setOverlays(lines);
  p.chart.setPriceLines(pPos ? positionsLinien(pPos) : []);
  // News-Punkte in JEDEM Chart-Fenster — gleiche Quelle wie der Haupt-Chart
  const pMarkers: ChartMarker[] =
    st !== null && st.showNews && !st.cleanView
      ? newsChartMarkers(p.news, times, Math.floor(Date.now() / 1000), vetoAnzeige())
      : [];
  const pEinstieg = positionsMarker(times, p.sym);
  if (pEinstieg) pMarkers.push(pEinstieg);
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
      p.news = d?.news ?? null;
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
  p.chart?.onCrosshairDate((date, pos) => {
    // News-Overlay auch im Raster-Panel — mit den Schlagzeilen des
    // PANEL-Symbols, nicht denen des Haupt-Charts
    showNewsTooltip(date, pos, p.news, p);
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
    st.gridPanels.push({ sym, range: 66, locked: false, chart: null, bars: [], subs: [], epoch: 0, fitPending: true, forecast: null, forecastIntraday: null, news: null, intradayDays: 0, intradayBars: [], auto: false });
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

/**
 * Freischaltungs-Hinweis in der Engine-Karte (Fund 01.08.: „Engine fängt bei
 * neuem Konto nicht an zu handeln"). Neue Konten stehen auf 'pending', und
 * der Scan überspringt sie STILL — das UI zeigte aber „Engine an". Ein
 * Schalter, der nichts bewirkt und es nicht sagt, ist eine Falle; deshalb
 * steht der Grund jetzt direkt unter dem Knopf.
 */
function renderAccessNote(): void {
  if (!st) return;
  const el = $('accessNote');
  if (st.accessLevel === 'pending') {
    el.textContent =
      '⏳ Dein Zugang wird noch geprüft. Du kannst alles ansehen und einstellen — '
      + 'gehandelt wird erst nach der Freischaltung durch den Betreiber, auch bei Engine AN.';
    el.hidden = false;
  } else if (st.accessLevel === 'blocked') {
    el.textContent = '⛔ Dieses Konto wurde gesperrt. Bitte wende dich an den Betreiber.';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ── Betriebszustand: „Was die Engine gerade tut" (04.08.) ──────────────── */

/**
 * Klartext für die Einstiegs-Zähler des Heartbeats.
 *
 * Die Reihenfolge ist die Rangfolge der Aussagekraft, nicht die des Codes:
 * Wer wissen will, warum nichts passiert, soll oben den wahrscheinlichsten
 * Grund finden. Ein Zähler auf 0 wird ausgeblendet — eine Liste aus lauter
 * Nullen liest niemand zweimal.
 */
const GATE_TEXT: ReadonlyArray<[string, string]> = [
  ['breaker_aktiv', 'Konten mit ausgelöster Tages-Notbremse (keine neuen Einstiege)'],
  ['abgleich_drift', 'Konten gesperrt — Buch und Broker-Depot weichen ab (Ausstiege bleiben frei)'],
  ['klasse_aus', 'abgelehnt — Anlageklasse steht auf 0 (Schatten misst weiter)'],
  ['regime_gegen_trend', 'Leerverkäufe abgelehnt — der Markt steigt'],
  ['regime_stress', 'Einstiege pausiert — Marktstress'],
  ['filter_blockiert', 'geblockt — diese Trade-Sorte verliert nachweislich'],
  ['news_veto', 'News-Veto — hartes Ereignis in den Schlagzeilen'],
  ['unter_kosten', 'zu kleine erwartete Bewegung für die Gebühren'],
  ['cluster_voll', 'abgelehnt — zu viel in derselben Marktgruppe'],
  ['nicht_handelbar', 'übersprungen — kein Broker verkauft das'],
  ['hebel_frei', 'Hebel FREIGEGEBEN (alle fünf Bedingungen erfüllt)'],
];

const REGIME_TEXT: Record<string, { t: string; c: string }> = {
  trend: { t: 'Aufwärtstrend — ruhig', c: 'var(--gn)' },
  seitwaerts: { t: 'Seitwärts', c: 'var(--t3)' },
  stress: { t: 'Stress — Einstiege pausiert', c: 'var(--rd)' },
};

const KALENDER_TEXT: Record<string, string> = {
  fomc: 'Fed-Zinsentscheid',
  nfp: 'US-Arbeitsmarktbericht',
  cpi: 'US-Verbraucherpreise',
};

function whyChip(text: string, farbe: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'hint mono';
  el.style.cssText = `padding:2px 8px;border-radius:999px;border:1px solid ${farbe};color:${farbe}`;
  el.textContent = text;
  return el;
}

/** Rendert den Betriebszustand aus meta/health + meta/positioning. */
function renderEngineWhy(): void {
  if (!st) return;
  const ampel = $('whyAmpel');
  const gate = $('whyGate');
  const extra = $('whyExtra');
  const h = st.health;
  if (!h) {
    ampel.innerHTML = '';
    gate.innerHTML = '<div class="hint">Noch keine Scan-Daten.</div>';
    extra.textContent = '';
    return;
  }

  // Zeile 1: Marktzustand, anstehender Termin, Trades des letzten Scans.
  ampel.innerHTML = '';
  const r = REGIME_TEXT[h.regime?.state ?? ''] ?? { t: 'unbekannt', c: 'var(--t3)' };
  const vix = typeof h.regime?.vix === 'number' ? ` · VIX ${h.regime.vix.toFixed(1)}` : '';
  const vol = typeof h.regime?.realizedVolPct === 'number' ? ` · Vol ${h.regime.realizedVolPct}%` : '';
  ampel.append(whyChip(`${r.t}${vix}${vol}`, r.c));
  if (h.kalender?.bevorstehend) {
    const name = KALENDER_TEXT[h.kalender.bevorstehend] ?? h.kalender.bevorstehend;
    ampel.append(whyChip(`${name} in ${h.kalender.stundenBis ?? '?'} h`, 'var(--yl,#d9a441)'));
  }
  if (h.kalender?.turnOfMonth) ampel.append(whyChip('Monatswende', 'var(--t3)'));
  if (typeof h.trades === 'number') {
    ampel.append(
      whyChip(`${h.trades} Trade(s) im letzten Scan`, h.trades > 0 ? 'var(--gn)' : 'var(--t3)'),
    );
  }
  /* Was die Engine WOLLTE (04.08.) — nicht nur, was sie durfte.
   *
   * Ohne diese Zahl beantwortet die Karte nur die halbe Frage. Ein Scan ohne
   * Trades kann heißen „ruhiger Markt" (viel Halten) oder „die Engine wollte
   * verkaufen, während der Markt steigt" — und nur im zweiten Fall liegt das
   * Problem in der Signal-Logik, nicht in den Filtern.
   *
   * Der Chip färbt sich, wenn Verkaufssignale im Aufwärtstrend überwiegen:
   * genau die Konstellation, in der die Regime-Ampel dauernd blockt. */
  const sd = h.signalDirs;
  if (sd) {
    const buy = sd.buy ?? 0;
    const sell = sd.sell ?? 0;
    const hold = sd.hold ?? 0;
    const gegenTrend = h.regime?.state === 'trend' && sell > buy;
    const chip = whyChip(
      `Signale: ${buy}↑ ${sell}↓ ${hold}·`,
      gegenTrend ? 'var(--rd)' : 'var(--t3)',
    );
    chip.title = gegenTrend
      ? 'Die Konfluenz erzeugt mehr Verkaufs- als Kaufsignale, obwohl der Markt im Aufwärtstrend steht. ' +
        'Die Regime-Ampel blockt diese Einstiege — sie verhindert also Wetten gegen den Trend, statt zu viel zu sperren.'
      : 'Richtungen der Konfluenz-Signale im letzten Scan: Kauf, Verkauf, Halten.';
    ampel.append(chip);
  }
  /* Die zweite Lesart im Schatten (MI, 04.08.).
   *
   * Am 04.08. verfehlten 13 von 13 Signalen die Konfluenz um genau EINE
   * Stimme: RSI und Bollinger sind auf Umkehr parametriert und schweigen im
   * Trend, MACD ist der einzige Trendfolger. Die Variante liest dieselben
   * Indikatoren regime-gerecht und wird NICHT gehandelt — hier steht, was
   * sie signalisiert hätte und was das eingebracht hätte.
   *
   * Der Vergleich der beiden Kanten ist die Entscheidungsgrundlage fürs
   * Umschalten. Solange die Variante nicht besser ist, bleibt alles wie es
   * ist: Mehr Trades bei negativer Kante sind mehr Verlust. */
  const rd = h.regimeDirs;
  if (rd && (rd.buy ?? 0) + (rd.sell ?? 0) + (rd.hold ?? 0) > 0) {
    const chip = whyChip(
      `Variante: ${rd.buy ?? 0}↑ ${rd.sell ?? 0}↓ ${rd.hold ?? 0}·`,
      'var(--t3)',
    );
    /* Netto UND roh (05.08.).
     *
     * Ohne die Rohbewegung lässt eine negative Kante zwei völlig
     * verschiedene Schlüsse zu: „Signal ist Rauschen" oder „Signal trägt
     * Information, aber weniger als diese Anlageklasse an Gebühren
     * verlangt". Der erste Fall erledigt die Variante, der zweite verlegt
     * sie in eine billigere Klasse oder auf einen längeren Horizont. */
    const kante = (
      v?: { n: number; kantePct: number | null; rohPct?: number | null } | null,
    ): string => {
      if (!v || v.kantePct === null) return 'noch keine Daten';
      const netto = `${v.kantePct.toFixed(3)} % je Signal (${v.n})`;
      return v.rohPct === null || v.rohPct === undefined
        ? netto
        : `${netto}, roh ${v.rohPct.toFixed(3)} %`;
    };
    chip.title =
      'Regime-gerechte Lesart derselben Indikatoren — läuft nur im Schatten mit.\n'
      + `Gehandelte Logik: ${kante(h.signalSchatten?.live)}\n`
      + `Variante: ${kante(h.signalSchatten?.regime)}\n`
      + '„roh" ist die Bewegung VOR Gebühren: positiv bei negativer Kante heißt,\n'
      + 'die Richtung stimmt und die Kosten fressen sie — dann liegt es an der\n'
      + 'Anlageklasse, nicht an der Logik.\n'
      + 'Umgeschaltet wird erst, wenn die Variante die gehandelte Logik schlägt.';
    ampel.append(chip);
  }

  // Zeile 2: Warum Einstiege NICHT zustande kamen — nur was wirklich griff.
  gate.innerHTML = '';
  const g = h.entryGate ?? {};
  const zeilen = GATE_TEXT.filter(([k]) => (g[k] ?? 0) > 0);
  if (zeilen.length === 0) {
    const geprueft = g['geprueft'] ?? 0;
    gate.innerHTML = `<div class="hint">Im letzten Scan wurde nichts abgelehnt${
      geprueft > 0 ? ` (${geprueft} Einstiege geprüft)` : ''
    }.</div>`;
  } else {
    for (const [key, text] of zeilen) {
      const z = document.createElement('div');
      z.className = 'hint';
      z.style.cssText = 'display:flex;gap:8px;align-items:baseline';
      const n = document.createElement('span');
      n.className = 'mono';
      n.style.cssText = `min-width:2.5em;text-align:right;color:${
        key === 'hebel_frei' ? 'var(--gn)' : 'inherit'
      }`;
      n.textContent = String(g[key]);
      const t = document.createElement('span');
      t.textContent = text;
      z.append(n, t);
      gate.append(z);
    }
  }

  // Zeile 3: Konten, Sockel und die seltenen Gelegenheiten.
  const teile: string[] = [];
  const k = h.konten;
  if (k) teile.push(`${k['gehandelt'] ?? 0}/${k['laufend'] ?? 0} Konten aktiv`);
  if (typeof st.sockelKonten === 'number') teile.push(`Sockel: ${st.sockelKonten} Konto(s)`);
  const auf = st.positioning?.auffaellig ?? {};
  const squeeze = Object.entries(auf)
    .filter(([, v]) => v?.state === 'short_squeeze_setup')
    .map(([sym]) => sym);
  if (squeeze.length > 0) teile.push(`Squeeze-Setup: ${squeeze.slice(0, 4).join(', ')}`);
  const ueberfuellt = Object.values(auf).filter((v) => v?.state === 'longs_ueberfuellt').length;
  if (ueberfuellt > 0) teile.push(`${ueberfuellt}× überfüllte Longs`);
  extra.textContent = teile.join(' · ');
}

/* ── Admin-Verwaltung (Owner 02.08.: „wie kann man andere User freischalten?") ── */

const ACCESS_BADGE: Record<'pending' | 'approved' | 'blocked', string> = {
  pending: '⏳ wartet',
  approved: '✓ frei',
  blocked: '⛔ gesperrt',
};

/** Karte zeigen/verstecken — der Server prüft das Admin-Recht ohnehin selbst;
 *  die Sichtbarkeit hier ist reine Höflichkeit, kein Schutz. */
function renderAdminCard(): void {
  if (!st) return;
  ($('adminCard') as HTMLElement).hidden = !st.admin;
}

/** Konten laden und als Zeilen mit Aktions-Knöpfen rendern. */
async function loadAdminList(): Promise<void> {
  const list = $('admList');
  const err = $('admErr');
  err.hidden = true;
  list.innerHTML = '<div class="hint">lädt …</div>';
  try {
    const rows = await adminListUsers();
    list.innerHTML = '';
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'row';
      line.style.cssText = 'gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap';
      const who = document.createElement('span');
      who.className = 'mono';
      who.style.cssText = 'flex:1;min-width:140px;overflow:hidden;text-overflow:ellipsis';
      who.textContent = row.email ?? row.uid;
      who.title = row.uid;
      const badge = document.createElement('span');
      badge.className = 'hint';
      badge.textContent = ACCESS_BADGE[row.accessLevel] + (row.admin ? ' · Admin' : '');
      // Gesamt-P&L des Kontos (Owner 02.08.) — Formel identisch zur
      // Performance-Karte des Users, gefärbt nach Vorzeichen.
      const perf = document.createElement('span');
      perf.className = 'mono';
      if (row.pnl !== null) {
        const s = row.pnl >= 0 ? '+' : '';
        perf.textContent = `${s}${row.pnl.toFixed(2)} $`
          + (row.pnlPct !== null ? ` (${s}${row.pnlPct.toFixed(1)} %)` : '');
        perf.style.color = row.pnl > 0 ? 'var(--gn)' : row.pnl < 0 ? 'var(--rd)' : 'var(--t3)';
        if (row.equity !== null) perf.title = `Equity: ${row.equity.toFixed(2)} $`;
      } else {
        perf.textContent = '—';
        perf.style.color = 'var(--t3)';
      }
      line.append(who, perf, badge);
      // Das eigene Konto listet der Server mit, ändern lehnt er ab — dieselbe
      // Regel hier: keine Knöpfe, statt Knöpfe, die immer scheitern.
      if (row.uid !== st?.uid) {
        line.append(
          admBtn(row.accessLevel === 'approved' ? 'Sperren' : 'Freischalten', async () => {
            await adminSetAccess(row.uid, row.accessLevel === 'approved' ? 'blocked' : 'approved');
          }, row.accessLevel === 'approved' ? 'btn-r' : 'btn-g'),
          admBtn(row.admin ? 'Admin entziehen' : 'Zum Admin machen', async () => {
            await adminSetAdmin(row.uid, !row.admin);
          }, 'btn-n'),
        );
      }
      list.append(line);
    }
    if (rows.length === 0) list.innerHTML = '<div class="hint">Keine Konten gefunden.</div>';
  } catch (e) {
    list.innerHTML = '';
    err.textContent = e instanceof Error ? e.message : String(e);
    err.hidden = false;
  }
}

/** Kleiner Aktions-Knopf: führt aus, lädt danach die Liste neu, zeigt Fehler ehrlich. */
function admBtn(label: string, run: () => Promise<void>, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.style.cssText = 'padding:3px 8px;font-size:.78rem';
  b.textContent = label;
  b.addEventListener('click', () => {
    b.disabled = true;
    run()
      .then(() => loadAdminList())
      .catch((e: unknown) => {
        const err = $('admErr');
        err.textContent = e instanceof Error ? e.message : String(e);
        err.hidden = false;
        b.disabled = false;
      });
  });
  return b;
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
  const veto = vetoAnzeige()
    && data?.news?.hardEvent
    && Date.now() / 1000 - data.news.hardEvent.published <= NEWS_VETO_WINDOW_SEC
    ? `<div class="hint" style="color:var(--yl,#d9a441)">⏸ News-Veto aktiv (${esc(data.news.hardEvent.type)}) — die Engine setzt neue Einstiege hier gerade aus. Läuft automatisch 12 h nach dem Ereignis ab; abschaltbar in den Optionen („News-Veto").</div>`
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
  stop: 'stopModal',
} as const;
type ModalName = keyof typeof MODAL_IDS;

function closeModal(which: ModalName): void {
  $(MODAL_IDS[which]).classList.remove('show');
}

/**
 * Nach dem Engine-Stop fragen, was mit den offenen Positionen geschehen soll.
 *
 * ── Warum das ein Dialog ist und kein Hinweissatz ─────────────────────────
 *
 * Der Stop pausiert alles — auch Stop-Loss und Take-Profit. Das ist so
 * gewollt („das Depot genau im Status quo belassen"), hat aber eine
 * Kehrseite, die erst später wehtut: Ein gestopptes Konto mit offenen
 * Positionen ist ein ungeschütztes Konto. Ein Warnsatz verlagert die Arbeit
 * auf den Nutzer und darauf, dass er ihn im richtigen Moment liest. Dieser
 * Dialog erledigt sie an der Stelle, an der die Frage entsteht.
 *
 * Ohne offene Positionen erscheint er nicht — eine Rückfrage ohne Inhalt
 * lehrt nur, Dialoge wegzuklicken.
 */
function zeigeStopDialog(): void {
  if (!st || st.positions.length === 0) return;
  const rows = $('stopRows');
  $('stopOut').textContent = '';
  rows.innerHTML = st.positions
    .map((p) => {
      const kurs = st?.posPrices.get(p.symbol) ?? p.avgEntry;
      const short = p.side === 'short';
      // Vorzeichen dreht beim Short: Ein gefallener Kurs ist dort Gewinn.
      const pnl = (short ? p.avgEntry - kurs : kurs - p.avgEntry) * p.qty;
      const farbe = pnl >= 0 ? 'var(--gn)' : 'var(--rd)';
      return `<label class="hint" style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <input type="checkbox" data-stopsym="${escText(p.symbol)}" checked />
        <b style="min-width:64px">${escText(p.symbol)}</b>
        <span style="flex:1">${short ? 'Short ' : ''}${p.qty} × ${money(p.avgEntry)}</span>
        <span class="mono" style="color:${farbe}">${pnl >= 0 ? '+' : ''}${money(pnl)}</span>
      </label>`;
    })
    .join('');
  $(MODAL_IDS.stop).classList.add('show');
}

/**
 * Ausgewählte Positionen schließen.
 *
 * Nacheinander statt parallel: Jeder Verkauf ist eine eigene Transaktion auf
 * demselben Wallet-Dokument, und gleichzeitige Schreibvorgänge darauf würden
 * sich gegenseitig zum Wiederholen zwingen. Bei einer Handvoll Positionen
 * ist die Reihenfolge schneller als der Konflikt.
 *
 * Ein Fehlschlag stoppt die Reihe NICHT: Wenn ein Symbol nicht handelbar ist
 * (Markt zu), sollen die anderen trotzdem geschlossen werden. Was nicht ging,
 * steht am Ende namentlich da.
 */
async function schliessePositionen(symbole: string[]): Promise<void> {
  const out = $('stopOut');
  const fehler: string[] = [];
  let ok = 0;
  for (const [i, sym] of symbole.entries()) {
    out.innerHTML = `<div class="hint">Schließe ${i + 1}/${symbole.length} …</div>`;
    const pos = st?.positions.find((p) => p.symbol === sym);
    try {
      // Long wird verkauft, Short wird eingedeckt — der Broker schließt in
      // beiden Fällen die GANZE Position, eine Menge ist nicht nötig.
      await callTrade({ symbol: sym, side: pos?.side === 'short' ? 'buy' : 'sell' });
      ok += 1;
    } catch (e) {
      fehler.push(`${sym}: ${(e as Error).message}`);
    }
  }
  out.innerHTML =
    `<div class="hint">${ok} von ${symbole.length} geschlossen.`
    + (fehler.length > 0
      ? `<br />Nicht geschlossen — ${escText(fehler.join(' · '))}`
      : ' Das Depot ist jetzt flach.')
    + '</div>';
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
        // Trailing-Linie und P&L-Chip leben vom Kurs — mitziehen, aber nur
        // fürs gezeigte Symbol (sonst rendert jede fremde Quote das Chart neu)
        if (sym === st.currentSymbol) applyPosition();
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
 *
 * Die Level kommen seit 04.08. aus `positionLevels` (shared) — derselben
 * Rechnung, die auch die Preislinien im Chart setzt. Zwei Rechnungen würden
 * driften, und dann widerspräche die Tabelle der Linie im Chart.
 */
function exitOutlook(p: Position, live: number | undefined): string {
  if (!st || live === undefined || !(live > 0) || !(p.avgEntry > 0)) return '';
  const risk = resolveRisk(st.strategy.engine, classify(p.symbol));
  const lv = positionLevels(p, risk);
  const short = p.side === 'short';
  const parts: string[] = [];
  const candidates: Array<{ label: string; dist: number }> = [];
  const fmt = (v: number): string => `${v.toFixed(1)} %`;

  if (lv.stop !== null) {
    const dist = levelDistPct(lv.stop, live, 'stop', short);
    parts.push(dist <= 0 ? '<b class="c-rd">Stop: löst beim nächsten Scan aus</b>' : `Stop in <b>${fmt(dist)}</b>`);
    candidates.push({ label: 'Stop', dist });
  } else if (lv.stopAtr) {
    parts.push('Stop: <b>ATR-adaptiv</b>');
  }

  if (lv.trail !== null) {
    const dist = levelDistPct(lv.trail, live, 'stop', short);
    parts.push(dist <= 0 ? '<b class="c-rd">Trailing: löst beim nächsten Scan aus</b>' : `Trailing in <b>${fmt(dist)}</b>`);
    candidates.push({ label: 'Trailing', dist });
  } else if (lv.trailWartet) {
    parts.push('Trailing: <span title="Der nachziehende Stop schärft sich erst, wenn die Position im Gewinn war">wartet auf Gewinn</span>');
  }

  if (lv.target !== null) {
    const dist = levelDistPct(lv.target, live, 'target', short);
    parts.push(dist <= 0 ? '<b class="c-gn">Ziel: löst beim nächsten Scan aus</b>' : `Ziel in <b>${fmt(dist)}</b>`);
    candidates.push({ label: 'Ziel', dist });
  } else if (lv.targetAtr) {
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
  // Gesamt-P&L = Equity − Kapitalbasis. NICHT die Summe der geladenen
  // Trades: Die Handelshistorie lädt seitenweise nach, und eine „Gesamt"-
  // Zahl, die mit jedem „Ältere laden" wächst, ist keine (Owner-Fund
  // 29.07.). Equity − Basis enthält zudem ehrlich ALLES — auch Gebühren
  // offener Käufe und Margin-Zinsen, die in keinem Trade-pnl stehen.
  // Realisiert ergibt sich als Differenz zum offenen P&L.
  const basis = st.wallet?.baseCapital ?? st.strategy.broker.initialCapital;
  const totalPnl = cash !== null ? cash + posValue - basis : null;
  const closedPnl = totalPnl !== null ? totalPnl - openPnl : null;
  // Win-Rate bleibt eine Quote über die GELADENEN Abschlüsse (tiefere
  // Historie = mehr Stichprobe) — als Quote verschiebt sie sich beim
  // Nachladen nur, wenn sich die Vergangenheit anders schlug als die
  // Gegenwart; das ist Information, kein Anzeigefehler.
  const closers = st.trades.filter((t) => t.pnl !== undefined && t.pnl !== null);
  const wins = closers.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closers.length > 0 ? Math.round((wins / closers.length) * 100) : null;

  $('vCash').textContent = money(cash);
  $('vEq').textContent = cash !== null ? money(cash + posValue) : '--';
  const pnlEl = $('vPnl');
  pnlEl.textContent = totalPnl === null ? '--' : (totalPnl >= 0 ? '+' : '') + money(totalPnl);
  pnlEl.className = `vbig ${pnlClass(totalPnl ?? 0)}`;
  const closedEl = $('vClosed');
  closedEl.textContent = closedPnl === null ? '--' : money(closedPnl);
  closedEl.className = `smv ${pnlClass(closedPnl ?? 0)}`;
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
    // Klick aufs Symbol holt die Position ins Haupt-Chart (04.08.) — dort
    // zeigen Marke, Preislinien und die Kurve seit Einstieg den ganzen Verlauf
    symTd.className = 'pos-sym';
    symTd.title = 'Im Chart öffnen — mit Einstieg, Stop/Ziel und Verlauf seit Einstieg';
    symTd.addEventListener('click', () => {
      if (!st) return;
      publishSymbol(st.chartGroup, p.symbol);
      $('chartArea').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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

/**
 * Eine ältere Seite anhängen (Knopf „Ältere laden").
 *
 * Zwei Lehren aus dem Owner-Fund vom 04.08. („warum kann man nicht mehr
 * weitere laden?"):
 *
 * 1. Ein Fehler darf hier nicht mehr stumm in der Konsole landen. Vorher sah
 *    ein abgelehnter Zugriff exakt so aus wie eine leere Historie — der Knopf
 *    sprang zurück und nichts geschah, ohne dass irgendwo stand, warum.
 * 2. Bringt eine Seite ausschließlich schon bekannte Zeilen, wird sofort
 *    weitergeblättert statt aufzugeben. Sonst bliebe der Knopf für immer
 *    an derselben Stelle stehen.
 */
async function ladeAeltereTrades(): Promise<void> {
  if (!st || st.tradesLoading || st.tradesDone || !st.tradesCursor) return;
  const uid = st.uid;
  st.tradesLoading = true;
  st.tradesFehler = null;
  renderJournal();
  try {
    // Höchstens fünf Runden je Klick: Eine Seite ohne neue Zeilen ist kein
    // Grund aufzugeben, aber eine Endlosschleife wäre schlimmer als ein Knopf,
    // den man zweimal drückt.
    for (let runde = 0; runde < 5 && st.tradesCursor && !st.tradesDone; runde++) {
      const seite = await loadMoreTrades(uid, st.tradesCursor);
      if (!st) return; // Abmeldung während der Abfrage
      const bekannt = new Set(st.trades.map(tradeKey));
      const neue = seite.rows.filter((t) => !bekannt.has(tradeKey(t)));
      st.trades = [...st.trades, ...neue];
      st.tradesCursor = seite.cursor ?? st.tradesCursor;
      st.tradesDone = seite.done;
      if (neue.length > 0) break;
    }
  } catch (e) {
    st.tradesFehler = e instanceof Error ? e.message : String(e);
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
    // Nie ganz verschwinden lassen: Ein fehlender Knopf sieht aus wie ein
    // Fehler, ein ausgegrauter erklärt sich selbst (Owner-Fund 04.08.).
    mehr.hidden = false;
    mehr.disabled = st.tradesLoading || st.tradesDone;
    mehr.textContent = st.tradesFehler
      ? `Nachladen fehlgeschlagen — nochmal versuchen`
      : st.tradesLoading
        ? 'Lädt …'
        : st.tradesDone
          ? 'Alle Trades geladen'
          : 'Ältere laden';
    if (st.tradesFehler) {
      mehr.disabled = false;
      mehr.title = st.tradesFehler;
    } else {
      mehr.title = st.tradesDone
        ? 'Die Historie ist vollständig geladen'
        : 'Die nächsten 50 älteren Trades holen';
    }
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
    news: null,
    accessLevel: 'approved',
    admin: false,
    health: null,
    positioning: null,
    sockelKonten: null,
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
      news: null,
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
    // News-Punkte an per Default — die Daten liegen ohnehin im market-Doc,
    // der Toggle kostet also nichts; Abwahl bleibt gerätelokal gemerkt.
    showNews: localStorage.getItem('autotrd-chart-news') !== '0',
    showPos: localStorage.getItem('autotrd-chart-pos') !== '0',
    posOpen: localStorage.getItem('autotrd-pos-open') === '1',
    posPrices: new Map(),
    pfStats: null,
    equitySeries: [],
    subs: [],
    symbolSubs: [],
    watchlistSubs: [],
    watched: [],
    tradesCursor: null,
    tradesFehler: null,
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
    watchUserDoc(uid, (u) => {
      const { strategy, wallet, hotkeys, ui, autoTune, accessLevel, admin, breaker } = u;
      if (!st) return;
      renderBreaker(breaker);
      renderAbgleich(u.abgleich);
      st.accessLevel = accessLevel;
      renderAccessNote();
      st.admin = admin;
      renderAdminCard();
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
      // Veto-Anzeige folgt signals.newsVeto SOFORT nach dem Speichern —
      // sonst zeigt das Chart noch minutenlang einen Pfeil für ein
      // Aussetzen, das der User gerade abgeschaltet hat (Fund 29.07.).
      applyMarkers();
      renderAllPanels();
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
      // Eröffnet/geschlossen: Das Chart-Overlay folgt sofort, sonst zeigt es
      // Linien einer Position, die es nicht mehr gibt (oder keine für eine neue)
      applyPosition();
      applyMarkers();
      applyOverlays();
      renderAllPanels(); // gilt in ALLEN Chart-Fenstern
    }),
    // Live-Kopf: die neuesten 50. Nachgeladene ältere Seiten bleiben erhalten
    // und werden hinten angehängt — sonst würde jeder neue Trade (alle fünf
    // Minuten einer) die ganze nachgeladene Historie wieder wegwerfen.
    watchTrades(uid, (kopf, cursor) => {
      if (!st) return;
      const bekannt = new Set(kopf.map(tradeKey));
      const aeltere = st.trades.filter((t) => !bekannt.has(tradeKey(t)));
      st.trades = [...kopf, ...aeltere];
      if (st.tradesCursor === null) {
        st.tradesCursor = cursor;
        st.tradesDone = kopf.length < TRADE_PAGE;
      }
      renderPortfolio();
    }),
    watchPortfolioStats(uid, (stats) => {
      if (!st) return;
      st.pfStats = stats;
      renderPfStats();
      // Die Empfehlung hängt am selben Doc. Ohne das hier bliebe eine
      // geöffnete Options-Ansicht auf dem Stand des Öffnens stehen — und
      // zeigte nach dem Tageslauf die Zahlen von gestern.
      renderKlassenRat();
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
    watchMomentum((doc) => {
      renderMomentum(doc);
      // Die Sockel-Zahl gehört in die Betriebszustands-Karte: Sie beantwortet
      // „läuft der ruhige Teil überhaupt?" — eine 0 dort bei gesetztem
      // corePct hieße, dass der Rebalance-Takt noch nicht fällig war.
      if (st) {
        st.sockelKonten = (doc as { sockelKonten?: number } | null)?.sockelKonten ?? null;
        renderEngineWhy();
      }
    }),
    watchHealth((doc) => {
      if (!st) return;
      st.health = doc;
      renderEngineWhy();
    }),
    watchPositioning((doc) => {
      if (!st) return;
      st.positioning = doc;
      renderEngineWhy();
    }),
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
  // Stop: erst das Flag setzen, DANN fragen. Die Reihenfolge ist wichtig —
  // der Dialog darf den Stop nicht aufhalten. Wer ihn wegklickt, hat
  // trotzdem gestoppt.
  $('engStop').addEventListener('click', () => {
    void submitStrategy(
      { ...formStrategy(), engine: { ...formStrategy().engine, running: false } },
      'Engine-Flag: AUS',
    ).then(() => {
      zeigeStopDialog();
    });
  });
  $('stopKeep').addEventListener('click', () => closeModal('stop'));
  $('stopAll').addEventListener('click', () => {
    void schliessePositionen((st?.positions ?? []).map((p) => p.symbol));
  });
  $('stopSel').addEventListener('click', () => {
    const gewaehlt = [...$('stopRows').querySelectorAll<HTMLInputElement>('input[data-stopsym]')]
      .filter((c) => c.checked)
      .map((c) => c.dataset.stopsym ?? '')
      .filter(Boolean);
    if (gewaehlt.length === 0) {
      $('stopOut').innerHTML = '<div class="hint">Nichts ausgewählt.</div>';
      return;
    }
    void schliessePositionen(gewaehlt);
  });
  $('admReload').addEventListener('click', () => void loadAdminList());
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
  /* ── Echtgeld-Schalter (M14) ────────────────────────────────────────── */
  const ladeLiveStatus = (): void => {
    void callLiveMode({ action: 'status' })
      .then((r) => {
        renderLiveStatus(r.status ?? null, st?.strategy.broker.mode === 'live');
      })
      .catch(() => {
        const el = document.getElementById('lvState');
        if (el) el.textContent = 'Zustand nicht abrufbar.';
      });
  };
  $('optBtn')?.addEventListener('click', ladeLiveStatus);

  $('lvGo')?.addEventListener('click', () => {
    const btn = $('lvGo') as HTMLButtonElement;
    const wort = ($('lvWord') as HTMLInputElement).value.trim();
    btn.disabled = true;
    $('lvOut').innerHTML = '<div class="hint">Bestätige deine Anmeldung …</div>';
    // Reihenfolge wie beim Broker-Schlüssel: erst Anmeldung auffrischen,
    // dann senden. Der Server prüft `auth_time`; ohne Auffrischen käme der
    // Aufruf mit einem alten Zeitstempel an.
    void frischAnmelden(($('lvPw') as HTMLInputElement).value || undefined)
      .then(() => {
        $('lvOut').innerHTML = '<div class="hint">Schalte scharf …</div>';
        return callLiveMode({ live: true, bestaetigung: wort });
      })
      .then((r) => {
        ($('lvWord') as HTMLInputElement).value = '';
        ($('lvPw') as HTMLInputElement).value = '';
        $('lvOut').innerHTML = `<div class="hint">${escText(r.meldung)}</div>`;
        renderLiveStatus(null, true);
      })
      .catch((e) => {
        $('lvOut').innerHTML = `<div class="hint">${escText((e as Error).message)}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  // Zurück auf Papier: sofort, ohne Bestätigung. Eine Sicherung, die das
  // ABSCHALTEN erschwert, ist keine Sicherung.
  $('lvOff')?.addEventListener('click', () => {
    const btn = $('lvOff') as HTMLButtonElement;
    btn.disabled = true;
    void callLiveMode({ live: false })
      .then((r) => {
        $('lvOut').innerHTML = `<div class="hint">${escText(r.meldung)}</div>`;
        ladeLiveStatus();
      })
      .catch((e) => {
        $('lvOut').innerHTML = `<div class="hint">${escText((e as Error).message)}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  // Echtgeld-Feld ein-/ausblenden, sobald erkennbar ist, was eingegeben wird.
  // Reine Anzeige — geprüft wird serverseitig noch einmal am Präfix.
  $('bkKey')?.addEventListener('input', () => {
    const ist = ($('bkKey') as HTMLInputElement).value.trim().toUpperCase().startsWith('AK');
    ($('bkLiveBox') as HTMLElement).hidden = !ist;
  });
  $('bkSave')?.addEventListener('click', () => {
    const btn = $('bkSave') as HTMLButtonElement;
    const key = ($('bkKey') as HTMLInputElement).value.trim();
    const sec = ($('bkSec') as HTMLInputElement).value.trim();
    if (!key || !sec) {
      $('bkOut').innerHTML = '<div class="hint">Beide Schlüssel eingeben.</div>';
      return;
    }
    const istLive = key.toUpperCase().startsWith('AK');
    btn.disabled = true;
    /* Bei Echtgeld ZUERST die Anmeldung auffrischen, dann senden.
     *
     * Die Reihenfolge ist nicht beliebig: Der Server prüft `auth_time` aus
     * dem ID-Token. Ohne vorheriges Auffrischen käme der Aufruf mit dem
     * alten Zeitstempel an und würde abgelehnt — mit einer Fehlermeldung,
     * die wie ein Serverproblem aussieht, obwohl nur die Reihenfolge falsch
     * war. */
    const vorbereitet = istLive
      ? (() => {
          $('bkOut').innerHTML = '<div class="hint">Bestätige deine Anmeldung …</div>';
          return frischAnmelden(($('bkPw') as HTMLInputElement).value || undefined);
        })()
      : Promise.resolve();
    void vorbereitet
      .then(() => {
        $('bkOut').innerHTML = '<div class="hint">Prüfe Schlüssel bei Alpaca …</div>';
        return callConnectBroker(key, sec);
      })
      .then((r) => {
        // Eingaben SOFORT leeren: Der Schlüssel soll nach dem Absenden nicht
        // weiter im Formular stehen — weder für den nächsten am Rechner noch
        // für einen Screenshot.
        ($('bkKey') as HTMLInputElement).value = '';
        ($('bkSec') as HTMLInputElement).value = '';
        ($('bkPw') as HTMLInputElement).value = '';
        ($('bkLiveBox') as HTMLElement).hidden = true;
        $('bkOut').innerHTML =
          `<div class="hint">✓ ${escText(r.maskiert)} verbunden — ` +
          `${escText(r.kontoStatus)}, ${r.cash.toFixed(2)} $ Barbestand. ` +
          `${escText(r.meldung)}</div>`;
      })
      .catch((e) => {
        $('bkOut').innerHTML = `<div class="hint">${escText((e as Error).message)}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  $('bkDel')?.addEventListener('click', () => {
    const btn = $('bkDel') as HTMLButtonElement;
    btn.disabled = true;
    void callDisconnectBroker()
      .then((r) => {
        $('bkOut').innerHTML = `<div class="hint">${
          r.geloescht ? 'Verbindung getrennt, Schlüssel gelöscht.' : 'Es war nichts verbunden.'
        }</div>`;
      })
      .catch((e) => {
        $('bkOut').innerHTML = `<div class="hint">${escText((e as Error).message)}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  $('bkGo')?.addEventListener('click', () => {
    const btn = $('bkGo') as HTMLButtonElement;
    btn.disabled = true;
    $('bkOut').innerHTML = '<div class="hint">Prüfe Verbindung …</div>';
    void callBrokerStatus()
      .then((r) => {
        $('bkOut').innerHTML = renderBrokerStatus(r);
      })
      .catch((e) => {
        $('bkOut').innerHTML = `<div class="hint">${escText((e as Error).message)}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  // Steuer-Export: Jahresauswahl füllen (laufendes Jahr und die fünf davor —
  // weiter zurück gibt es keine Historie, und die Liste bliebe unübersichtlich).
  const txYear = $('txYear') as HTMLSelectElement;
  if (txYear && txYear.options.length === 0) {
    const jetzt = new Date().getUTCFullYear();
    for (let j = jetzt; j >= jetzt - 5; j--) {
      const o = document.createElement('option');
      o.value = String(j);
      o.textContent = String(j);
      txYear.appendChild(o);
    }
  }
  $('txGo')?.addEventListener('click', () => {
    const btn = $('txGo') as HTMLButtonElement;
    const jahr = Number(txYear.value);
    const echtgeld = ($('txReal') as HTMLInputElement).checked;
    btn.disabled = true;
    $('txOut').innerHTML = '<div class="hint">Rechne …</div>';
    void callTaxReport(jahr, echtgeld)
      .then((r) => {
        $('txOut').innerHTML = renderSteuerbericht(r);
        const dl = $('txCsv') as HTMLAnchorElement | null;
        if (dl) {
          // BOM voranstellen: Ohne ihn zeigt deutsches Excel Umlaute kaputt an.
          const blob = new Blob(['﻿' + r.csv], { type: 'text/csv;charset=utf-8' });
          dl.href = URL.createObjectURL(blob);
          dl.download = `autotrd-steuer-${jahr}${echtgeld ? '' : '-papierhandel'}.csv`;
        }
      })
      .catch((e) => {
        $('txOut').innerHTML = `<div class="hint">${escText((e as Error).message)}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  $('rsGo').addEventListener('click', () => {
    const btn = $('rsGo') as HTMLButtonElement;
    btn.disabled = true;
    $('rsMsg').textContent = 'Setze zurück …';
    void resetWallet(RESET_CONFIRM_WORD, ($('rsFromBroker') as HTMLInputElement).checked)
      .then((r) => {
        const n = Object.entries(r.deleted)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        // Die Quelle mitschreiben: „100.000 $" ohne Herkunft laesst offen, ob
        // der Broker gefragt wurde oder die Einstellung gegriffen hat.
        const quelle = r.kapitalQuelle === 'broker' ? ' (vom Broker übernommen)' : '';
        $('rsMsg').textContent =
          `✓ Zurückgesetzt (${n || 'nichts zu löschen'}) — Kontostand ${r.balance} $${quelle}`;
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

  // „Vorschlag übernehmen" (MG2): setzt die Regler auf die empfohlenen Werte
  // und speichert. Bewusst der VOLLE Vorschlag, nicht der 0,25-Schritt des
  // Auto-Reglers — wer von Hand klickt, hat die Zahlen gerade gelesen und
  // trifft eine Entscheidung; die Annäherung schützt nur die Automatik davor,
  // auf jede Momentaufnahme zu springen.
  $('owClsApply').addEventListener('click', () => {
    if (!st) return;
    const rat = st.pfStats?.classAdvice;
    if (!rat) return;
    const gew = { ...klassenGewichteAusForm() };
    for (const r of rat.raete) gew[r.klasse] = r.vorschlag;
    const next: Strategy = {
      ...st.strategy,
      engine: { ...st.strategy.engine, classWeights: gew },
    };
    $('owClsMsg').textContent = 'Übernehme …';
    void saveStrategy(next)
      .then(() => {
        st!.strategy = next;
        renderKlassenRegler();
        renderKlassenRat();
        $('owClsMsg').textContent = `✓ ${rat.aenderungen} Gewicht(e) übernommen`;
      })
      .catch((e) => ($('owClsMsg').textContent = (e as Error).message));
  });

  $('bkrReset').addEventListener('click', () => {
    $('bkrMsg').textContent = 'Löse …';
    void resetBreaker()
      .then((r) => {
        $('bkrMsg').textContent = r.warAusgeloest
          ? '✓ Gelöst — Einstiege sind wieder frei.'
          : 'War nicht ausgelöst.';
      })
      .catch((e) => ($('bkrMsg').textContent = (e as Error).message));
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
    st.gridPanels = prefs.panels.map((p) => ({ ...p, chart: null, bars: [], subs: [], epoch: 0, fitPending: true, forecast: null, forecastIntraday: null, news: null, intradayBars: [] }));
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
  $('lyNews').classList.toggle('on', st?.showNews ?? true);
  $('lyNews').addEventListener('click', () => {
    if (!st) return;
    st.showNews = !st.showNews;
    $('lyNews').classList.toggle('on', st.showNews);
    localStorage.setItem('autotrd-chart-news', st.showNews ? '1' : '0');
    applyMarkers();
    renderAllPanels(); // News-Punkte gelten in ALLEN Charts
  });
  // Klick auf den Chip klappt die Details auf/zu (gleiche Geste wie OHLC)
  $('posHud').addEventListener('click', () => {
    if (!st) return;
    st.posOpen = !st.posOpen;
    localStorage.setItem('autotrd-pos-open', st.posOpen ? '1' : '0');
    applyPosition();
  });
  $('lyPos').classList.toggle('on', st?.showPos ?? true);
  $('lyPos').addEventListener('click', () => {
    if (!st) return;
    st.showPos = !st.showPos;
    $('lyPos').classList.toggle('on', st.showPos);
    localStorage.setItem('autotrd-chart-pos', st.showPos ? '1' : '0');
    applyPosition();
    applyMarkers();
    applyOverlays();
    renderAllPanels(); // Positions-Layer gilt in ALLEN Charts
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
