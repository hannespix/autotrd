/**
 * Dashboard-View — Port des Frosted-Aurora-Dashboards (M3) auf Firestore.
 * Alle Daten kommen per onSnapshot/getDocs aus market/** und users/{uid},
 * Aktionen laufen über Callables (ensureProfile, saveStrategy). Kein /api/*.
 */

import {
  CLASS_LABELS,
  DEFAULT_STRATEGY,
  MAX_WATCHLIST,
  PAPER_FEE_RATE,
  aggregateBars,
  bollinger,
  ema,
  macd,
  resolveName,
  sma,
  validateStrategy,
  vwapSessions,
  wilderRsi,
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
  saveUiPrefs,
  watchBars,
  watchLatestAi,
  watchLatestIndicators,
  watchLatestSignal,
  watchMarketDoc,
  watchEvaluatedForecasts,
  watchEvents,
  watchForecastStats,
  watchForecastStatsIntraday,
  watchNews,
  watchPositions,
  watchTrades,
  watchUserDoc,
  type AiDayDoc,
  type EvaluatedForecastRow,
  type EventDay,
  type ForecastStatsDoc,
  type IndicatorRow,
  type MarketDocData,
  type SignalRow,
  type TradeRow,
  type UniverseClass,
  type WorkspaceDocData,
} from './data.js';
import { emailVerified, logout, refreshUser, sendVerification } from './auth.js';
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
  news: 'News & Sentiment',
  chart2: 'Vergleichs-Chart',
};

/** Panels, die ohne gespeicherten Workspace ausgeblendet starten. */
const DEFAULT_HIDDEN = new Set(['chart2']);

/** Werks-Presets: Sichtbarkeits-Sets über den 13 Panels. */
const WS_PRESETS: Record<string, { label: string; hidden: string[] }> = {
  ueberblick: { label: 'Überblick', hidden: ['chart2'] },
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
  pickerSelection: Set<string>;
  wallet: Wallet | null;
  positions: Position[];
  trades: TradeRow[];
  forecast: MarketDocData['forecast'];
  /** Kurzfrist-Prognose (Intraday-Ansicht, 5-min-Raster). */
  forecastIntraday: MarketDocData['forecastIntraday'];
  /** Link-Bus (M9): Gruppen der verlinkbaren Panels. */
  chartGroup: LinkGroup;
  newsGroup: LinkGroup;
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
  /** Symbol des News-Panels (folgt newsGroup — kann vom Chart abweichen). */
  newsSymbol: string;
  newsSubs: Unsubscribe[];
  /** Workspace (M9): Preset + ausgeblendete Panels + Save-Debounce. */
  wsPreset: string;
  wsHidden: Set<string>;
  /** Modul-Reihenfolge je Panel-Id (kleiner = weiter oben; fehlend = DOM-Default). */
  wsOrder: Record<string, number>;
  wsSaveTimer: number | null;
  paletteDispose: (() => void) | null;
  /** Event-Tage des aktuellen Symbols (für Marker + Crosshair-Tooltip). */
  events: EventDay[];
  /** Layer-Toggles (M6b): Prognose-Overlay / Event-Marker ein- und ausblenden. */
  showForecast: boolean;
  showEvents: boolean;
  /** Zuletzt gesetzte News-Punkte im Haupt-Chart (E2E-Hook, 26.07.). */
  lastMainMarkers?: number;
  /** Live-Preise der Positions-Symbole (aus market/{sym}.quote). */
  posPrices: Map<string, number>;
  subs: Unsubscribe[]; // globale Subs (Settings, Wallet, Positionen, Trades)
  symbolSubs: Unsubscribe[]; // pro Chart-Symbol
  watchlistSubs: Unsubscribe[]; // pro Watchlist (Livebar + Tabelle)
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
  events: EventDay[];
  /** Zeit-Domäne des letzten Renders (Prognose-Räumung beim Moduswechsel). */
  lastRenderIntraday?: boolean;
  /** Zuletzt gesetzte News-Punkte (E2E-Hook, 26.07.). */
  lastMarkers?: number;
}

let st: DashState | null = null;

// Bus-Abonnenten-Schlüssel der beiden verlinkbaren Panels (M9)
const CHART_KEY = {};
const NEWS_KEY = {};
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
  return st.strategy.watchlist.map((symbol) => ({ symbol, name: resolveName(symbol) }));
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
    { id: 'engine-start', label: 'Engine starten (Paper)', run: () => $('engStart').click() },
    { id: 'engine-stop', label: 'Engine stoppen', run: () => $('engStop').click() },
    { id: 'link-chart', label: 'Chart: Link-Gruppe wechseln', run: () => $('chipChart').click() },
    { id: 'link-news', label: 'News-Panel: Link-Gruppe wechseln', run: () => $('chipNews').click() },
    { id: 'picker', label: 'Watchlist bearbeiten', run: () => $('openPickerBtn').click() },
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
    <a class="hbtn" id="studioLink" href="#/strategy" title="Strategie-Studio">${ICONS.bolt}<span class="hide-sm"> Studio</span></a>
    <button class="hbtn" id="optBtn" title="Optionen: Elemente, Module & Paper-Wallet">${ICONS.gear}</button>
    <button class="hbtn sb-tgl" id="sideL" title="Linke Spalte ein-/ausblenden">◧</button>
    <button class="hbtn sb-tgl" id="sideR" title="Rechte Spalte ein-/ausblenden">◨</button>
    <button class="hbtn" id="themeBtn" title="Hell/Dunkel">◐</button>
    <span class="user">${email.replace(/[<>&]/g, '')}</span>
    <button class="hbtn" id="logoutBtn">Abmelden</button>
    <button class="burg" id="burgR" aria-label="Rechtes Panel">☰</button>
  </header>
  <div class="overlay" id="olv"></div>

  <div class="app">
    <div class="col-l" id="leftCol">
      <div class="card" data-panel="strategy"><div class="sect">Strategie</div><div class="cbody">
        <div class="fld"><label class="lbl">Watchlist ${iBtn('watchlist')}</label>
          <div id="wlChips" class="wl-chips"></div>
          <button class="btn btn-n" id="openPickerBtn" style="margin-top:6px">Watchlist wählen</button>
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
        <button class="btn btn-g" id="engStart">Start</button>
        <button class="btn btn-r" id="engStop">Stop</button>
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

      <div class="card" data-panel="history"><div class="sect">Trade-Historie</div><div class="cbody">
        <div class="tw"><table class="tbl">
          <thead><tr><th>Zeit</th><th>Sym</th><th>Side</th><th>Qty</th><th>Preis</th><th>P&amp;L</th></tr></thead>
          <tbody id="jBody"><tr><td colspan="6" class="c-t3">Keine Trades</td></tr></tbody>
        </table></div>
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
              <button class="tf-btn on" id="lyEv" title="Event-Marker ein/aus">Events</button>
              <button class="tf-btn on" id="yAutoBtn" title="Y-Autoscaling: Preisskala passt sich beim Scrollen/Zoomen automatisch an — ausschalten, um die Y-Achse manuell festzuhalten (Ziehen auf der Preisskala)">Y-Auto</button>
              <div class="tm-sec">Raster — bis zu 4 Kurse parallel</div>
              <span class="grid-sw" title="Charts im Raster: 1, 2 oder 4 parallel">
                <button class="tf-btn on" data-grid="1">▭</button>
                <button class="tf-btn" data-grid="2">▯▯</button>
                <button class="tf-btn" data-grid="4">⊞</button>
              </span>
              <button class="tf-btn" id="lockMain" hidden
                title="Haupt-Chart in die Lock-Gruppe: Zoom, Sichtbereich und Crosshair laufen auf allen gelockten Charts synchron">${ICONS.unlock}</button>
              <div class="tm-sec">Vergleich</div>
              <input id="cmpSym" class="inp cmp-inp" placeholder="+ Overlay: SYM" title="Zweiten Kurs als %-Linie überlagern (Tageskerzen)" />
            </div>
          </span>
        </div>
        <div class="hint" id="fcInfo" style="margin-bottom:4px"></div>
        <div id="chartRow" class="chart-row" data-mode="1">
        <div id="chartWrap" class="chart-wrap">
          <button id="maxExit" class="chart-max-exit" hidden title="Vollbild schließen (Esc)">✕</button>
          <div id="chartHud" class="chart-hud">
            <div class="hud-top">
              <div id="ohlcRow" class="ohlc-row mono" hidden></div>
              <button id="hudTgl" class="hud-tgl" title="Legende ein-/ausklappen">▾</button>
            </div>
            <div id="chartLegend" class="chart-legend" hidden></div>
          </div>
          <div id="chartArea"></div>
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
        <div id="rsiPanel" class="sub-panel" hidden></div>
        <div id="macdPanel" class="sub-panel" hidden></div>
        </div>
        <div class="hint">1T/1W: 5-Minuten-Kerzen · 1M–1J: Tageskerzen —
          aktualisiert der zentrale 5-min-Scan. Zoom bleibt beim Aktualisieren erhalten.</div>
      </div></div>

      <div class="card" data-panel="chart2"><div class="sect">Vergleichs-Chart
        <button class="lchip" id="chipChart2" title="Link-Gruppe wechseln (Vergleichs-Chart folgt dieser Gruppe)">B</button></div><div class="cbody">
        <div class="chart-hd">
          <span class="chart-nm" id="ch2Sym"></span>
          <span class="chart-px" id="ch2Px">--</span>
          <span class="gp-tf" id="c2tf" style="margin-left:auto">
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
          <div><label class="lbl">Best w</label><div id="fcW" class="smv">--</div></div>
          <div><label class="lbl">Lookback</label><div id="fcLb" class="smv">--</div></div>
        </div>
        <div class="hint" id="fcTuning">Self-Tuning sammelt Evidenz — Defaults aktiv,
          bis genug Prognosen realisiert sind.</div>
        <div class="hint" id="fcVoteInfo"></div>
      </div></div>

      <div class="card" data-panel="fclab"><div class="sect">Prognose-Labor <span id="flSym" style="float:right;color:var(--t3)"></span></div><div class="cbody">
        <div class="hint">Selbstverbesserung: Jede gespeicherte Prognose wird nach Ablauf
          ihres Horizonts gegen die eingetretene Realität bewertet. Die Trefferquote je
          Kombi aus Sentiment-Gewicht (w) und Lookback steuert, welche Parameter
          künftige Prognosen nutzen — das System lernt aus jedem Fehler.</div>
        <label class="lbl">Kombi-Statistik Tages-Prognose (w × Lookback) ${iBtn('fcCombo')}</label>
        <div id="flCombos" class="fl-tbl"><div class="hint">Noch keine bewerteten Prognosen.</div></div>
        <label class="lbl">Kombi-Statistik Kurzfrist/Intraday (w × Lookback in 5-min-Bars) ${iBtn('kurzfrist')}</label>
        <div id="flCombosIntra" class="fl-tbl"><div class="hint">Noch keine bewerteten Kurzfrist-Prognosen.</div></div>
        <label class="lbl">Vorhersage vs. Realität ${iBtn('mae')} <span id="flSym2" style="color:var(--t3)"></span></label>
        <div id="flRows" class="fl-tbl"><div class="hint">Noch keine bewerteten Prognosen für dieses Symbol.</div></div>
      </div></div>

      <div class="card" data-panel="news"><div class="sect">News &amp; Sentiment <span id="nsSym" style="float:right;color:var(--t3)"></span> <button class="lchip" id="chipNews" title="Link-Gruppe wechseln (News folgen dieser Gruppe)" style="float:right;margin-right:8px">A</button></div><div class="cbody">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span id="nsLabel" class="vbig" style="font-size:18px">–</span>
          <span id="nsScore" class="smv">–</span>
          <span id="nsCount" class="hint" style="margin-left:auto"></span>
        </div>
        <div style="height:8px;border-radius:5px;background:linear-gradient(90deg,var(--rd),var(--t3) 50%,var(--gn));position:relative;margin:6px 0 3px">
          <div id="nsPin" style="position:absolute;top:-3px;left:50%;width:3px;height:14px;background:var(--t1);border-radius:2px;transition:left .5s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:8px;color:var(--t3);text-transform:uppercase"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>
        <div class="wl-sec" style="margin-top:10px">Warum bewegt sich <span id="aiSym">…</span>?</div>
        <div id="aiSummary" style="font-size:11.5px;line-height:1.45;color:var(--t1)">Noch keine KI-Zusammenfassung — kommt mit dem nächsten Scan mit News.</div>
        <div id="aiMeta" class="hint" style="margin-top:3px"></div>
        <div id="aiTags" class="wl-chips" style="margin-top:5px;min-height:0"></div>
        <div id="newsFeed" style="display:flex;flex-direction:column;max-height:300px;overflow-y:auto;margin-top:8px"></div>
      </div></div>
    </div>
  </div>

  <!-- Event-Tooltip am Crosshair (position:fixed — CLAUDE.md §6) -->
  <div id="evTip" class="evtip" hidden></div>

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
        <label>Stop-Loss %
          <input id="owSl" class="inp st-num" type="number" min="0.5" step="0.5" /></label>
        <label>Take-Profit %
          <input id="owTp" class="inp st-num" type="number" min="0.5" step="0.5" /></label>
      </div>
      <p class="hint">Startkapital greift beim Anlegen/Zurücksetzen des Wallets.
        Investment je Trade bestimmt die Positionsgröße der Engine (Regel-Strategien
        deckeln serverseitig bei 25 %).</p>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-g" id="owSave">Speichern</button>
        <span class="hint" id="optMsg"></span>
      </div>
    </div>
  </div>

  <div class="dmodal" id="wlModal">
    <div class="dmodal-bg" data-close="picker"></div>
    <div class="dsheet" style="width:min(700px,100%)">
      <button class="dclose" data-close="picker">✕</button>
      <h3>Watchlist zusammenstellen <span id="wlCount" class="chip"></span></h3>
      <div class="wl-sec">Deine Auswahl</div>
      <div id="wlCurrent" class="wl-chips"></div>
      <div class="wl-sec">Nach Kategorie durchsuchen</div>
      <div class="mkt-tabs" id="wlTabs"></div>
      <div id="wlBrowse" class="wl-browse"></div>
      <div class="dbtns">
        <button class="dbtn pri" id="wlSaveBtn">Übernehmen &amp; speichern</button>
        <button class="dbtn" data-close="picker">Abbrechen</button>
      </div>
    </div>
  </div>`;
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
  st.events = [];
  // Nachgeladene Historie ist symbol-spezifisch → beim Wechsel zurücksetzen
  st.histBars = [];
  st.histOldest = 0;
  st.histLoading = false;
  st.histDone = false;
  $('evTip').hidden = true;

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
    watchEvents(sym, (events) => {
      if (!st) return;
      st.events = events;
      applyMarkers();
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

/**
 * News-Kontext (Link-Gruppe `newsGroup`): Sentiment-Gauge, News-Feed,
 * KI-Tageskarte — kann über den Link-Chip vom Chart entkoppelt werden.
 */
function wireNewsCtx(): void {
  if (!st) return;
  clearSubs(st.newsSubs);
  const sym = st.newsSymbol;
  renderAiCard(null);

  st.newsSubs.push(
    watchMarketDoc(sym, (d) => renderSentimentGauge(d?.sentiment)),
    watchLatestAi(sym, (ai) => renderAiCard(ai)),
    watchNews(sym, (news) => renderNewsFeed(news)),
  );
}

/**
 * News-Fokus (User-Wunsch 26.07.): Ein Klick in IRGENDEIN Chart-Fenster
 * (Haupt, Raster-Panel, Vergleich) lädt News/Sentiment/KI-Karte für DESSEN
 * Symbol — nicht nur fürs erste Chart. Bewusst am Link-Bus vorbei: Nur der
 * News-Kontext wechselt, die Charts selbst bleiben, wie sie sind. Der
 * nächste Bus-Wechsel (Watchlist-Klick in der News-Gruppe) übernimmt wieder.
 */
function focusNews(sym: string): void {
  if (!st || !sym || st.newsSymbol === sym) return;
  st.newsSymbol = sym;
  wireNewsCtx();
  scheduleWsSave();
}

/** Link-Chips einfärben (Aurora-Farben je Gruppe). */
function paintChips(): void {
  if (!st) return;
  for (const [id, group] of [
    ['chipChart', st.chartGroup],
    ['chipNews', st.newsGroup],
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

/** In-Chart-HUD (TV-Stil, UI-Audit 25.07.): Symbol · O H L C · Vol des Bars
 *  unterm Crosshair — ohne Crosshair der letzte Bar. Grün/rot nach C≥O. */
function renderOhlcHud(
  d: { time: string; open: number; high: number; low: number; close: number; volume: number | null } | null,
): void {
  if (!st) return;
  const el = $('ohlcRow');
  if (st.cleanView) {
    el.hidden = true;
    return;
  }
  let bar = d;
  if (!bar) {
    const src = st.intradayDays > 0 ? st.shownIntraday : dailySource();
    const last = src[src.length - 1];
    if (!last) {
      el.hidden = true;
      return;
    }
    const time =
      'date' in last
        ? (last as { date: string }).date
        : new Date((last as { time: number }).time * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    bar = { time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? null };
  }
  const up = bar.close >= bar.open;
  const pct = bar.open > 0 ? ((bar.close / bar.open - 1) * 100).toFixed(2) : '0.00';
  const vol =
    bar.volume === null || bar.volume === 0
      ? ''
      : ` · Vol ${bar.volume >= 1e6 ? `${(bar.volume / 1e6).toFixed(1)}M` : Math.round(bar.volume).toLocaleString('de-DE')}`;
  el.innerHTML = `<b>${st.currentSymbol}</b> <span class="c-t3">${bar.time}</span>
    <span class="${up ? 'c-gn' : 'c-rd'}">O ${fmtNum(bar.open)} H ${fmtNum(bar.high)} L ${fmtNum(bar.low)} C ${fmtNum(bar.close)} (${up ? '+' : ''}${pct} %)</span>${vol}`;
  el.hidden = false;
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
  if (st?.showEvents && !st.cleanView && (st.events.length ?? 0) > 0) {
    items.push({ c: '#26cf9d', t: 'Event-Punkte (News)', title: 'Überfahren zeigt die News des Tages — Intraday sitzt der Punkt am ersten Bar des Handelstags' });
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

function openOptions(): void {
  if (!st) return;
  ($('ouPred') as HTMLInputElement).checked = st.ui.predArrow;
  ($('ouCmp') as HTMLInputElement).checked = st.ui.cmpOverlay;
  ($('ouGrid') as HTMLInputElement).checked = st.ui.chartGrid;
  ($('ouSub') as HTMLInputElement).checked = st.ui.subPanels;
  ($('owCap') as HTMLInputElement).value = String(st.strategy.broker.initialCapital);
  ($('owMax') as HTMLInputElement).value = String(st.strategy.engine.maxPositionPct);
  ($('owSl') as HTMLInputElement).value = String(st.strategy.engine.stopLossPct);
  ($('owTp') as HTMLInputElement).value = String(st.strategy.engine.takeProfitPct);
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
 * News-Punkte fürs Chart (User-Wunsch 26.07.: „in allen Ansichten"): in der
 * Tages-Sicht direkt am Datum, in der Intraday-Sicht am ERSTEN Bar des
 * jeweiligen Handelstags (UTC-Datum der Bar-Zeit — deckt US- wie EU-Sessions).
 */
function newsMarkers(events: EventDay[], intradayBars: Array<{ time: number }> | null): ChartMarker[] {
  const mark = (e: EventDay, time: string | number): ChartMarker => ({
    time,
    position: e.sentiment < -0.12 ? 'aboveBar' : 'belowBar',
    color: e.sentiment > 0.12 ? '#26cf9d' : e.sentiment < -0.12 ? '#f2586b' : '#8b93a8',
    shape: 'circle',
    text: e.count > 1 ? String(e.count) : '',
  });
  if (!intradayBars) return events.map((e) => mark(e, e.date));
  const firstOfDay = new Map<string, number>();
  for (const b of intradayBars) {
    const day = new Date(b.time * 1000).toISOString().slice(0, 10);
    if (!firstOfDay.has(day)) firstOfDay.set(day, b.time);
  }
  return events.flatMap((e) => {
    const t = firstOfDay.get(e.date);
    return t === undefined ? [] : [mark(e, t)];
  });
}

/** Event-Marker anwenden — respektiert den Events-Layer-Toggle (M6b). */
function applyMarkers(): void {
  if (!st?.chart) return;
  const markers =
    st.showEvents && !st.cleanView
      ? newsMarkers(st.events, st.intradayDays > 0 ? st.shownIntraday : null)
      : [];
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
      `über die nächste Stunde (5-min-Raster, w=${ifc.w}, Lookback ${ifc.lookback} Bars${calI})`;
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
    `über ${fc.points.length} Handelstage (w=${fc.w}, Lookback ${fc.lookback}, ${cal})`;
}

/** Prognose-Labor: Kombi-Statistik (Tages- ODER Intraday-Pfad) rendern. */
function renderFcLabStats(hostId: string, stats: ForecastStatsDoc | null): void {
  const host = $(hostId);
  const rows = Object.entries(stats?.combos ?? {})
    .map(([key, c]) => {
      const [wS, lbS] = key.split('_');
      const w = Number(wS);
      const lb = Number(lbS);
      return {
        w: Number.isFinite(w) ? w : 0,
        lb: Number.isFinite(lb) ? lb : 0,
        n: c.n,
        hit: c.n > 0 ? (c.hits / c.n) * 100 : 0,
        mae: c.n > 0 ? c.maeSum / c.n : 0,
      };
    })
    .sort((a, b) => b.hit - a.hit || a.mae - b.mae);
  if (rows.length === 0) {
    host.innerHTML =
      '<div class="hint">Noch keine bewerteten Prognosen — die Statistik füllt sich, sobald erste Horizonte realisiert sind.</div>';
    return;
  }
  const best = stats?.best;
  host.innerHTML =
    '<div class="fl-row fl-head"><span>w</span><span>Lookback</span><span>n</span><span>Treffer</span><span>MAE</span></div>' +
    rows
      .map((r) => {
        const isBest = best !== undefined && best.w === r.w && best.lookback === r.lb;
        return (
          `<div class="fl-row${isBest ? ' fl-best' : ''}"${isBest ? ' title="Beste Kombi — steuert die Live-Prognose"' : ''}>` +
          `<span>${r.w}</span><span>${r.lb}</span><span>${r.n}</span>` +
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
    '<div class="fl-row fl-head"><span>Basis</span><span>w/Lb</span><span>Prognose</span><span>Richtung</span><span>MAE</span></div>' +
    done
      .map((r) => {
        const hit = r.dirHit === true;
        return (
          '<div class="fl-row">' +
          `<span>${String(r.baseDate).slice(0, 10)}</span><span>${Number(r.w)}/${Number(r.lookback)}</span>` +
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
    showEventTooltip(date, pos);
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
let evTipTimer: number | null = null;
// Besitzer des (einen) Overlays: Crosshair-SYNCS feuern auf den Ziel-Charts
// Clear-Events (param.point fehlt) — nur das Chart, das das Overlay geöffnet
// hat, darf es auch schließen, sonst löscht die Lock-Gruppe jeden Tooltip.
let evTipOwner: unknown = null;
const COARSE_POINTER = window.matchMedia?.('(pointer: coarse)').matches ?? false;

function showEventTooltip(
  date: string | null,
  pos: { x: number; y: number } | null,
  // News-Overlay in JEDEM Chart-Fenster (User-Feedback 26.07.): Raster-
  // Panels/Vergleich reichen ihre EIGENEN Event-Tage herein — default Haupt-Chart.
  events?: EventDay[],
  owner: unknown = 'main',
): void {
  const tip = $('evTip');
  const src = events ?? st?.events ?? [];
  const ev = date && st?.showEvents ? src.find((e) => e.date === date) : undefined;
  if (!ev || !pos) {
    if (owner !== evTipOwner) return; // Fremd-/Sync-Clear: Overlay bleibt
    // Touch (Handy): Nach dem Loslassen verschwindet das Crosshair sofort —
    // das Overlay bliebe sonst nur einen Wimpernschlag („nicht sauber",
    // Feedback 25.07.). Kurz stehen lassen, dann ausblenden.
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
  const tone = ev.sentiment > 0.12 ? 'c-gn' : ev.sentiment < -0.12 ? 'c-rd' : 'c-t3';
  tip.innerHTML = `
    <div class="evtip-hd"><span class="mono"></span>
      <span class="${tone}">${ev.sentiment >= 0 ? '+' : ''}${ev.sentiment.toFixed(2)}</span>
      <span class="evtip-n">${ev.count} News</span></div>
    <div class="evtip-list"></div>`;
  tip.querySelector('.mono')!.textContent = ev.date;
  const list = tip.querySelector('.evtip-list')!;
  for (const t of ev.top.slice(0, 3)) {
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

function wireWatchlist(): void {
  if (!st) return;
  clearSubs(st.watchlistSubs);
  const wl = st.strategy.watchlist;

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
  $('ch2Sym').textContent = sym;
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
    watchEvents(sym, (events) => {
      if (epoch !== p.epoch) return;
      p.events = events;
      renderChart2();
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
  // Zeit-/Crosshair-Sync zum Haupt-Chart (beidseitig, frame-sicherer Echo-
  // Schutz + Gesten-Gate: Daten-Refits des Vergleichs ziehen das Haupt-Chart nicht)
  armGestureTracking($('chart2Area'));
  st.chart2?.onVisibleRangeChange((range) => {
    const h = st?.chart2;
    if (!range || !st?.chart || !h || matchEcho(h, range)) return;
    if (!recentGesture($('chart2Area'))) return;
    pushRange(st.chart, range, h);
  });
  st.chart2?.onCrosshairDate((date, pos) => {
    // News-Overlay auch im Vergleichs-Chart (Events des Vergleichs-Symbols)
    showEventTooltip(date, pos, st?.chart2P.events, 'chart2');
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
      panels: st.gridPanels.map((p) => ({ sym: p.sym, range: p.range, locked: p.locked, intradayDays: p.intradayDays })),
    }),
  );
}

function loadGridPrefs(): { mode: 1 | 2 | 4; mainLocked: boolean; panels: Array<{ sym: string; range: number; locked: boolean; intradayDays: number }> } {
  const fallback = { mode: 1 as const, mainLocked: false, panels: [] };
  try {
    const raw = localStorage.getItem(GRID_LS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as { mode?: number; mainLocked?: boolean; panels?: Array<{ sym?: string; range?: number; locked?: boolean; intradayDays?: number }> };
    const mode = p.mode === 2 || p.mode === 4 ? p.mode : 1;
    return {
      mode,
      mainLocked: p.mainLocked === true,
      panels: (p.panels ?? []).slice(0, 3).map((x) => ({
        sym: typeof x.sym === 'string' && x.sym ? x.sym : 'AAPL',
        range: typeof x.range === 'number' ? x.range : 66,
        locked: x.locked === true,
        intradayDays: x.intradayDays === 1 || x.intradayDays === 5 ? x.intradayDays : 0,
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
  const fit = p.fitPending;
  p.fitPending = false;
  const intraday = p.intradayDays > 0;
  // Zeit-Domänen-Wechsel (ISO-Tage ↔ UNIX-Sekunden): Prognose-Overlay vor
  // setBars räumen — gleiche Falle wie beim Haupt-Chart (E2E 25.07.).
  if (p.lastRenderIntraday !== intraday) p.chart.setForecast(null);
  p.lastRenderIntraday = intraday;

  const daily = p.range > 0 ? p.bars.slice(-p.range) : p.bars;
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
  // News-Punkte in JEDEM Chart und JEDER Sicht (User-Wunsch 26.07.):
  // Tages-Sicht am Datum, Intraday-Sicht am ersten Bar des Handelstags.
  const pMarkers =
    st !== null && st.showEvents && !st.cleanView
      ? newsMarkers(p.events, intraday ? p.intradayBars : null)
      : [];
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
  });
  const p2 = st.chart2P;
  document.querySelectorAll<HTMLElement>('#c2tf [data-c2r], #c2tf [data-c2i]').forEach((b) => {
    const on = b.dataset['c2i'] !== undefined
      ? Number(b.dataset['c2i']) === p2.intradayDays && p2.intradayDays > 0
      : p2.intradayDays === 0 && Number(b.dataset['c2r']) === p2.range;
    b.classList.toggle('on', on);
  });
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
    watchEvents(p.sym, (events) => {
      if (epoch !== p.epoch) return;
      p.events = events;
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
  p.chart?.onVisibleRangeChange((range) => {
    // Echo eines Lock-Pushes? Nicht zurücksenden — sonst stirbt das
    // Trägheits-Gleiten des treibenden Charts (Smartphone-Kinetik 26.07.).
    // Gesten-Gate: Daten-Refits des Panels ziehen die Lock-Gruppe nicht.
    if (!range || !p.chart || matchEcho(p.chart, range)) return;
    if (p.locked && recentGesture(host)) syncLockedRange(p.chart, range);
  });
  p.chart?.onCrosshairDate((date, pos) => {
    // News-Overlay auch im Raster-Panel (User-Feedback 26.07.) — mit den
    // Event-Tagen des PANEL-Symbols, nicht denen des Haupt-Charts
    showEventTooltip(date, pos, p.events, p);
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
      st.strategy.watchlist.find((s) => !used.has(s)) ??
      ['AAPL', 'TSLA', '^NDX'].find((s) => !used.has(s)) ??
      'AAPL';
    st.gridPanels.push({ sym, range: 66, locked: false, chart: null, bars: [], subs: [], epoch: 0, fitPending: true, forecast: null, forecastIntraday: null, intradayDays: 0, intradayBars: [], events: [] });
  }
  $('chartRow').dataset['mode'] = String(st.gridMode);
  ($('lockMain') as HTMLButtonElement).hidden = st.gridMode === 1;
  $('lockMain').innerHTML = st.mainLocked ? ICONS.lock : ICONS.unlock;
  $('lockMain').classList.toggle('on', st.mainLocked);
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
      focusNews(sym); // neues Symbol im aktiven Fenster → News folgen sofort
    });
    const markTf = (btn: Element): void =>
      el.querySelectorAll('[data-r], [data-i]').forEach((x) => x.classList.toggle('on', x === btn));
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
    el.addEventListener('pointerdown', () => focusNews(p.sym), true);
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
    if (stored[colId]) col.style.width = `${Math.min(440, Math.max(220, stored[colId]))}px`;
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
        const w = Math.min(440, Math.max(220, edge === 'right' ? startW + dx : startW - dx));
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
      groups: { chart: st.chartGroup, news: st.newsGroup, chart2: st.chart2Group },
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
}

function renderStrategyChips(): void {
  if (!st) return;
  const box = $('wlChips');
  box.innerHTML = '';
  for (const sym of st.strategy.watchlist) {
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
  const inWl = st.strategy.watchlist.includes(symbol);
  sheet.innerHTML = `
    <button class="dclose" data-close="detail">✕</button>
    <h3></h3>
    <div class="dmeta"><span class="mono"></span><span>${CLASS_LABELS[data?.assetClass ?? ''] ?? ''}</span></div>
    <div class="vbig ${q ? pnlClass(q.changePct) : 'c-t3'}">${q ? fmtNum(q.price) : '—'}</div>
    <div class="smv ${q ? pnlClass(q.changePct) : 'c-t3'}">${q ? fmtPct(q.changePct) : 'Noch keine Scan-Daten — Symbol wird nach Aufnahme in eine Watchlist erfasst.'}</div>
    <div class="dbtns">
      ${q ? '<button class="dbtn pri" id="dOpenChart">Im Chart öffnen</button>' : ''}
      <button class="dbtn" id="dAddWl">${inWl ? 'In Watchlist ✓' : 'Zur Watchlist hinzufügen'}</button>
    </div>`;
  sheet.querySelector('h3')!.textContent = name;
  sheet.querySelector('.dmeta .mono')!.textContent = symbol;
  $('detailModal').classList.add('show');
  sheet.querySelector('#dOpenChart')?.addEventListener('click', () => {
    closeModal('detail');
    selectSymbol(symbol);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  sheet.querySelector('#dAddWl')?.addEventListener('click', () => {
    if (!st || st.strategy.watchlist.includes(symbol)) return;
    void submitStrategy(
      { ...st.strategy, watchlist: [...st.strategy.watchlist, symbol] },
      `${symbol} zur Watchlist hinzugefügt — Daten kommen mit dem nächsten Scan.`,
    );
    closeModal('detail');
  });
}

/* ── Watchlist-Picker ───────────────────────────────────────────────── */

async function openPicker(): Promise<void> {
  if (!st) return;
  st.pickerSelection = new Set(st.strategy.watchlist);
  st.universe ??= await loadUniverse();
  $('wlModal').classList.add('show');
  renderPickerChips();

  const tabs = $('wlTabs');
  tabs.innerHTML = '';
  if (!st.universe) {
    $('wlBrowse').innerHTML = '<span class="c-t3">Katalog noch nicht geseedet.</span>';
    return;
  }
  let active = st.marketClass;
  const renderBrowse = (cls: string): void => {
    const box = $('wlBrowse');
    box.innerHTML = '';
    for (const entries of Object.values(st!.universe![cls]?.groups ?? {})) {
      for (const { symbol, name } of entries) {
        const opt = document.createElement('div');
        opt.className = 'wl-opt' + (st!.pickerSelection.has(symbol) ? ' on' : '');
        opt.innerHTML = `<span class="box"></span><span class="s"></span><span class="n"></span>`;
        opt.querySelector('.s')!.textContent = symbol;
        opt.querySelector('.n')!.textContent = name;
        opt.addEventListener('click', () => {
          if (st!.pickerSelection.has(symbol)) {
            st!.pickerSelection.delete(symbol);
          } else {
            // Kosten-Guard: mehr als MAX_WATCHLIST lehnt der Server ab —
            // deshalb hier blocken statt beim Speichern scheitern.
            if (st!.pickerSelection.size >= MAX_WATCHLIST) {
              const c = $('wlCount');
              c.classList.add('wl-full');
              setTimeout(() => c.classList.remove('wl-full'), 600);
              return;
            }
            st!.pickerSelection.add(symbol);
          }
          opt.classList.toggle('on', st!.pickerSelection.has(symbol));
          renderPickerChips();
        });
        box.appendChild(opt);
      }
    }
  };
  for (const cls of CLASS_ORDER) {
    if (!st.universe[cls]) continue;
    if (st.ui.marketGroups?.[cls] === false) continue; // Marktgruppen-Filter
    const b = document.createElement('button');
    b.className = 'mtab' + (cls === active ? ' on' : '');
    b.textContent = CLASS_LABELS[cls] ?? cls;
    b.addEventListener('click', () => {
      active = cls;
      tabs.querySelectorAll('.mtab').forEach((el) => el.classList.toggle('on', el === b));
      renderBrowse(cls);
    });
    tabs.appendChild(b);
  }
  renderBrowse(active);
}

function renderPickerChips(): void {
  if (!st) return;
  const count = $('wlCount');
  count.textContent = `${st.pickerSelection.size}/${MAX_WATCHLIST}`;
  count.classList.toggle('c-rd', st.pickerSelection.size >= MAX_WATCHLIST);
  const box = $('wlCurrent');
  box.innerHTML = '';
  for (const sym of st.pickerSelection) {
    const chip = document.createElement('span');
    chip.className = 'wl-chip';
    const label = document.createElement('span');
    label.textContent = sym;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', () => {
      st!.pickerSelection.delete(sym);
      renderPickerChips();
      document.querySelectorAll('#wlBrowse .wl-opt').forEach((el) => {
        if (el.querySelector('.s')?.textContent === sym) el.classList.remove('on');
      });
    });
    chip.append(label, x);
    box.appendChild(chip);
  }
  if (st.pickerSelection.size === 0) box.innerHTML = '<span class="c-t3" style="font-size:11px">Keine Symbole gewählt</span>';
}

function closeModal(which: 'detail' | 'picker' | 'options'): void {
  $(which === 'detail' ? 'detailModal' : which === 'picker' ? 'wlModal' : 'optModal').classList.remove('show');
}

/* ── News & Sentiment ───────────────────────────────────────────────── */

function renderSentimentGauge(s: import('./data.js').SentimentField | undefined): void {
  if (!st) return;
  $('nsSym').textContent = st.newsSymbol;
  if (!s) {
    $('nsLabel').textContent = '–';
    $('nsScore').textContent = '–';
    $('nsCount').textContent = '';
    return;
  }
  const label = $('nsLabel');
  label.textContent = s.label === 'bullish' ? 'Bullish' : s.label === 'bearish' ? 'Bearish' : 'Neutral';
  label.className = `vbig ${s.overall > 0.12 ? 'c-gn' : s.overall < -0.12 ? 'c-rd' : 'c-t3'}`;
  label.style.fontSize = '18px';
  $('nsScore').textContent = (s.overall >= 0 ? '+' : '') + s.overall.toFixed(2);
  $('nsCount').textContent = `${s.n} Quellen`;
  $('nsPin').style.left = `${Math.max(2, Math.min(98, 50 + s.overall * 50))}%`;
}

/** KI-Tageskarte „Warum bewegt sich X?“ aus market/{sym}/ai/{date} (M6b). */
function renderAiCard(ai: AiDayDoc | null): void {
  if (!st) return;
  $('aiSym').textContent = st.newsSymbol;
  const sum = $('aiSummary');
  const meta = $('aiMeta');
  const tags = $('aiTags');
  tags.innerHTML = '';
  if (!ai) {
    sum.textContent = 'Noch keine KI-Zusammenfassung — kommt mit dem nächsten Scan mit News.';
    meta.textContent = '';
    return;
  }
  sum.textContent = ai.summary;
  if (ai.degraded) {
    const why =
      ai.reason === 'no_api_key'
        ? 'kein API-Key hinterlegt'
        : ai.reason === 'budget_exceeded'
          ? 'Tages-Tokenbudget erschöpft'
          : 'KI-Fehler';
    meta.textContent = `${ai.date} · regelbasiert (${why}) — Lexikon-Stufe 0 aktiv`;
  } else {
    const conf = ai.confidence != null ? ` · Konfidenz ${(ai.confidence * 100).toFixed(0)} %` : '';
    meta.textContent = `${ai.date} · KI (${ai.model ?? '–'})${conf}${ai.cause ? ` · ${ai.cause}` : ''}`;
  }
  for (const t of ai.tags.slice(0, 6)) {
    const chip = document.createElement('span');
    chip.className = 'wl-chip';
    chip.style.cssText = 'font-size:9px;padding:2px 7px';
    chip.textContent = t.count > 1 ? `${t.type} ×${t.count}` : t.type;
    tags.appendChild(chip);
  }
}

function renderNewsFeed(news: import('./data.js').NewsRow[]): void {
  const feed = $('newsFeed');
  feed.innerHTML = '';
  if (news.length === 0) {
    feed.innerHTML = '<span class="hint" style="padding:8px 0">Noch keine News — kommen mit dem nächsten Scan.</span>';
    return;
  }
  for (const n of news) {
    const row = document.createElement('a');
    row.href = n.url || '#';
    row.target = '_blank';
    row.rel = 'noopener';
    row.style.cssText = 'display:flex;gap:8px;padding:7px 2px;border-bottom:1px solid var(--hair);text-decoration:none';
    const dotColor = n.sent.sentiment > 0.12 ? 'var(--gn)' : n.sent.sentiment < -0.12 ? 'var(--rd)' : 'var(--t3)';
    row.innerHTML = `
      <span style="flex:0 0 6px;width:6px;height:6px;border-radius:50%;margin-top:6px;background:${dotColor}"></span>
      <span style="flex:1;min-width:0">
        <span class="nhl" style="display:block;font-size:11px;color:var(--t1);line-height:1.35"></span>
        <span class="hint"></span>
      </span>`;
    row.querySelector('.nhl')!.textContent = n.title;
    row.querySelector('.hint')!.textContent =
      `${n.source}${n.kind !== 'news' ? ` · ${n.kind}` : ''}${n.ts ? ` · ${n.ts.slice(0, 10)}` : ''}`;
    feed.appendChild(row);
  }
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

function renderPortfolio(): void {
  if (!st) return;
  const cash = st.wallet?.paperBalance ?? null;
  let openPnl = 0;
  let posValue = 0;
  for (const p of st.positions) {
    const live = st.posPrices.get(p.symbol) ?? p.avgEntry;
    openPnl += (live - p.avgEntry) * p.qty;
    posValue += live * p.qty;
  }
  const sells = st.trades.filter((t) => t.side === 'sell' && t.pnl !== undefined);
  const closedPnl = sells.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = sells.length > 0 ? Math.round((wins / sells.length) * 100) : null;
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
    const pnl = live !== undefined ? (live - p.avgEntry) * p.qty : null;
    const pct = live !== undefined && p.avgEntry > 0 ? (live / p.avgEntry - 1) * 100 : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="color:var(--t1);font-weight:700"></td><td>${p.qty}</td>
      <td>${fmtNum(p.avgEntry)}</td><td>${live !== undefined ? fmtNum(live) : '--'}</td>
      <td class="${pnl !== null ? pnlClass(pnl) : ''}">${pnl !== null ? money(pnl) : '--'}</td>
      <td class="${pct !== null ? pnlClass(pct) : ''}">${pct !== null ? fmtPct(pct) : '--'}</td>
      <td><button class="hbtn" data-exit style="color:var(--rd)">Exit</button></td>`;
    tr.querySelector('td')!.textContent = p.symbol;
    tr.querySelector('[data-exit]')!.addEventListener('click', () => {
      void manualTrade(p.symbol, 'sell');
    });
    body.appendChild(tr);
  }

  // Trade-Historie
  const jb = $('jBody') as HTMLTableSectionElement;
  jb.innerHTML = '';
  if (st.trades.length === 0) {
    jb.innerHTML = '<tr><td colspan="6" class="c-t3">Keine Trades</td></tr>';
  }
  for (const t of st.trades.slice(0, 20)) {
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
    pickerSelection: new Set(),
    wallet: null,
    positions: [],
    trades: [],
    forecast: null,
    forecastIntraday: null,
    chartGroup: 'A',
    newsGroup: 'A',
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
      events: [],
    },
    lastQuote: null,
    orderSide: 'buy',
    hotkeys: { ...HOTKEY_DEFAULTS },
    newsSymbol: DEFAULT_STRATEGY.watchlist[0] ?? 'QQQ',
    newsSubs: [],
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
    wsSaveTimer: null,
    paletteDispose: null,
    events: [],
    showForecast: true,
    showEvents: true,
    posPrices: new Map(),
    subs: [],
    symbolSubs: [],
    watchlistSubs: [],
    positionSubs: new Map(),
    timers: [],
  };
  seedSymbols({ A: st.currentSymbol, B: st.chart2Symbol, C: st.currentSymbol });

  // User-Doc: Strategie (Formular/Watchlist) + Wallet folgen Firestore
  st.subs.push(
    watchUserDoc(uid, ({ strategy, wallet, hotkeys, ui }) => {
      if (!st) return;
      const prevWl = st.strategy.watchlist.join(',');
      st.strategy = strategy ?? DEFAULT_STRATEGY;
      st.wallet = wallet;
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
      if (st.strategy.watchlist.join(',') !== prevWl || $('liveBar').childElementCount === 0) {
        if (!st.strategy.watchlist.includes(st.currentSymbol)) {
          publishSymbol(st.chartGroup, st.strategy.watchlist[0] ?? st.currentSymbol);
        }
        wireWatchlist();
      }
    }),
    watchPositions(uid, (positions) => {
      if (!st) return;
      st.positions = positions;
      syncPositionQuotes();
      renderPortfolio();
    }),
    watchTrades(uid, (trades) => {
      if (!st) return;
      st.trades = trades;
      renderPortfolio();
    }),
    watchForecastStats((stats) => {
      $('fcAcc').textContent =
        stats?.dirAccuracy != null ? `${stats.dirAccuracy.toFixed(1)} %` : '--';
      $('fcScored').textContent = String(stats?.scored ?? 0);
      $('fcW').textContent = stats?.best ? String(stats.best.w) : '--';
      $('fcLb').textContent = stats?.best ? String(stats.best.lookback) : '--';
      $('fcTuning').textContent = stats?.tuningActive
        ? 'Self-Tuning aktiv: Live-Prognosen nutzen die historisch beste Kombi.'
        : 'Self-Tuning sammelt Evidenz — Defaults aktiv, bis genug Prognosen realisiert sind.';
      renderFcLabStats('flCombos', stats);
    }),
    watchForecastStatsIntraday((stats) => renderFcLabStats('flCombosIntra', stats)),
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
  busSubscribe(NEWS_KEY, st.newsGroup, (sym) => {
    if (!st || st.newsSymbol === sym) return;
    st.newsSymbol = sym;
    wireNewsCtx();
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
  $('chipNews').addEventListener('click', () => {
    if (!st) return;
    st.newsGroup = nextGroup(st.newsGroup);
    seedSymbols({ [st.newsGroup]: st.newsSymbol });
    setGroup(NEWS_KEY, st.newsGroup);
    paintChips();
    scheduleWsSave();
  });

  wireWatchlist();
  wireChartCtx();
  wireNewsCtx();
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
    st.newsGroup = g(ws.groups?.news);
    st.chart2Group = ws.groups?.chart2 === 'A' || ws.groups?.chart2 === 'C' ? ws.groups.chart2 : 'B';
    const symbols: Partial<Record<LinkGroup, string>> = {};
    for (const grp of ['A', 'B', 'C'] as const) {
      const sym = ws.symbols?.[grp];
      if (typeof sym === 'string' && sym) symbols[grp] = sym;
    }
    seedSymbols(symbols);
    setGroup(CHART_KEY, st.chartGroup);
    setGroup(NEWS_KEY, st.newsGroup);
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
    panelEventCount: (i: number) => st?.gridPanels[i]?.events.length ?? -1,
    panelMarkerCount: (i: number) => st?.gridPanels[i]?.lastMarkers ?? -1,
    mainMarkerCount: () => st?.lastMainMarkers ?? -1,
    newsSym: () => st?.newsSymbol ?? '',
    panelEventDates: (i: number) => st?.gridPanels[i]?.events.map((e) => e.date) ?? [],
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
    chart2ForecastActive: () => st?.chart2?.forecastActive() ?? false,
    chart2Overlays: () => st?.chart2?.overlayCount() ?? -1,
    mainChartType: () => st?.chart?.chartType() ?? 'candles',
    panelChartType: (i: number) => st?.gridPanels[i]?.chart?.chartType() ?? 'candles',
    panelRange: (i: number) => st?.gridPanels[i]?.chart?.getVisibleRange() ?? null,
    setPanelRange: (i: number, r: { from: number; to: number }) => st?.gridPanels[i]?.chart?.setVisibleRange(r),
    subRange: (k: 'rsi' | 'macd') => st?.subCharts[k]?.getVisibleRange() ?? null,
    subAnchorLen: (k: 'rsi' | 'macd') => subAnchorLens[k],
    subMounted: () => (st ? (st.subCharts.rsi ? 1 : 0) + (st.subCharts.macd ? 1 : 0) : -1),
    eventCount: () => st?.events.length ?? -1,
    areaActive: () => st?.chart?.areaActive() ?? false,
    signalDir: () => st?.lastSignalDir ?? 'hold',
    cleanActive: () => st?.cleanView ?? false,
    autoLevel: () => (st?.autoRes ? (st.intradayDays > 0 ? st.aggMinutes : 0) : -1),
    resBadge: () => document.getElementById('resBadge')?.textContent ?? '',
    dailyLen: () => dailySource().length,
    firstDailyDate: () => dailySource()[0]?.date ?? '',
    eventDates: () => st?.events.map((e) => e.date) ?? [],
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
  $('openPickerBtn').addEventListener('click', () => void openPicker());
  $('wlSaveBtn').addEventListener('click', () => {
    if (!st) return;
    const wl = [...st.pickerSelection];
    if (wl.length === 0) return;
    void submitStrategy({ ...st.strategy, watchlist: wl }, 'Watchlist gespeichert.');
    closeModal('picker');
  });
  document.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeModal((el as HTMLElement).dataset.close as 'detail' | 'picker' | 'options')));
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
      p.intradayDays = b.dataset['c2i'] !== undefined ? Number(b.dataset['c2i']) : 0;
      if (b.dataset['c2r'] !== undefined) p.range = Number(b.dataset['c2r']);
      p.fitPending = true;
      syncPanelTfButtons();
      if (p.intradayDays > 0) void loadPanelIntraday(p);
      else renderChart2();
    }),
  );
  // Timeline-Sprünge (User-Wunsch 25.07. nachts): animiert zu Anfang/Mitte/
  // Ende — am linken Rand lädt die bestehende Nachlade-Logik automatisch weiter.
  $('jumpStart').addEventListener('click', () => st?.chart?.scrollTo('start'));
  $('jumpMid').addEventListener('click', () => st?.chart?.scrollTo('middle'));
  $('jumpEnd').addEventListener('click', () => st?.chart?.scrollTo('end'));
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
    // Null-sicher: die document-Listener unten überleben den Routen-Wechsel
    // (#/strategy) — dort existieren die Menü-Knoten nicht mehr.
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

  // Vollbild je Chart (Feedback 25.07., wichtig für Smartphones): CSS-Overlay
  // statt Fullscreen-API (läuft überall, auch iOS/PWA); Esc schließt.
  $('maxMain').addEventListener('click', () => {
    const on = !$('chartWrap').classList.contains('chart-max');
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
  $('owSave').addEventListener('click', () => {
    if (!st) return;
    const num = (id: string): number => Number(($(id) as HTMLInputElement).value);
    const strategy: Strategy = {
      ...st.strategy,
      broker: { ...st.strategy.broker, initialCapital: num('owCap') },
      engine: {
        ...st.strategy.engine,
        maxPositionPct: num('owMax'),
        stopLossPct: num('owSl'),
        takeProfitPct: num('owTp'),
      },
    };
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
    st.gridPanels = prefs.panels.map((p) => ({ ...p, chart: null, bars: [], subs: [], epoch: 0, fitPending: true, forecast: null, forecastIntraday: null, intradayBars: [], events: [] }));
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
  $('lyEv').addEventListener('click', () => {
    if (!st) return;
    st.showEvents = !st.showEvents;
    $('lyEv').classList.toggle('on', st.showEvents);
    applyMarkers();
    renderAllPanels(); // News-Punkte in ALLEN Charts
    if (!st.showEvents) $('evTip').hidden = true;
  });
  // Aktives Fenster = News-Kontext (User-Wunsch 26.07.): Klick in Haupt-
  // oder Vergleichs-Chart lädt dessen News (Raster-Panels analog in renderGrid)
  $('chartWrap').addEventListener('pointerdown', () => focusNews(st?.currentSymbol ?? ''), true);
  $('chart2Area').addEventListener('pointerdown', () => focusNews(st?.chart2Symbol ?? ''), true);
  document.addEventListener('keydown', onEscape);
}

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeModal('detail');
  closeModal('picker');
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
  clearSubs(st.newsSubs);
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
