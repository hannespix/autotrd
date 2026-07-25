/**
 * Dashboard-View — Port des Frosted-Aurora-Dashboards (M3) auf Firestore.
 * Alle Daten kommen per onSnapshot/getDocs aus market/** und users/{uid},
 * Aktionen laufen über Callables (ensureProfile, saveStrategy). Kein /api/*.
 */

import {
  CLASS_LABELS,
  DEFAULT_STRATEGY,
  MAX_WATCHLIST,
  bollinger,
  ema,
  resolveName,
  sma,
  validateStrategy,
  type Position,
  type Strategy,
  type Wallet,
} from '@autotrd/shared';
import type { Unsubscribe } from 'firebase/firestore';
import { buildPriceChart, type ChartBar, type PriceChartHandle } from './chart.js';
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
  loadPrediction,
  saveUiPrefs,
  watchBars,
  watchLatestAi,
  watchLatestIndicators,
  watchLatestSignal,
  watchMarketDoc,
  watchEvents,
  watchForecastStats,
  watchNews,
  watchPositions,
  watchTrades,
  watchUserDoc,
  type AiDayDoc,
  type EventDay,
  type IndicatorRow,
  type MarketDocData,
  type SignalRow,
  type TradeRow,
  type UniverseClass,
  type WorkspaceDocData,
} from './data.js';
import { emailVerified, logout, refreshUser, sendVerification } from './auth.js';
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
  /** fitContent beim nächsten renderChart (nur Symbol-/Zeitrahmen-Wechsel). */
  chartFitPending: boolean;
  /** Aktive Indikator-Overlays (sma20/sma50/sma200/ema9/ema21/bb). */
  chartLayers: Set<string>;
  /** Aktive User-Prognose (Chart-Pfeil) des aktuellen Symbols. */
  prediction: import('@autotrd/shared').UserPrediction | null;
  predMode: boolean;
  /** Optionale Elemente (Options-Modal ⚙, settings.ui) — ✏ ist Opt-in. */
  ui: { predArrow: boolean; cmpOverlay: boolean; chartGrid: boolean };
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
  /** Link-Bus (M9): Gruppen der verlinkbaren Panels. */
  chartGroup: LinkGroup;
  newsGroup: LinkGroup;
  /** Vergleichs-Chart (M9 Chart-Stack): eigene Gruppe, synchrone Zeitachse. */
  chart2Group: LinkGroup;
  chart2Symbol: string;
  chart2: PriceChartHandle | null;
  chart2Bars: ChartBar[];
  chart2Subs: Unsubscribe[];
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
  wsSaveTimer: number | null;
  paletteDispose: (() => void) | null;
  /** Event-Tage des aktuellen Symbols (für Marker + Crosshair-Tooltip). */
  events: EventDay[];
  /** Layer-Toggles (M6b): Prognose-Overlay / Event-Marker ein- und ausblenden. */
  showForecast: boolean;
  showEvents: boolean;
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
    <a class="hbtn" id="studioLink" href="#/strategy" title="Strategie-Studio">⚡<span class="hide-sm"> Studio</span></a>
    <button class="hbtn" id="optBtn" title="Optionen: Elemente & Paper-Wallet">⚙</button>
    <button class="hbtn" id="themeBtn" title="Hell/Dunkel">◐</button>
    <span class="user">${email.replace(/[<>&]/g, '')}</span>
    <button class="hbtn" id="logoutBtn">Abmelden</button>
    <button class="burg" id="burgR" aria-label="Rechtes Panel">☰</button>
  </header>
  <div class="overlay" id="olv"></div>

  <div class="app">
    <div class="col-l" id="leftCol">
      <div class="card" data-panel="strategy"><div class="sect">Strategie</div><div class="cbody">
        <div class="fld"><label class="lbl">Watchlist</label>
          <div id="wlChips" class="wl-chips"></div>
          <button class="btn btn-n" id="openPickerBtn" style="margin-top:6px">Watchlist wählen</button>
        </div>
        <div class="row">
          <div class="fld"><label class="lbl">RSI Kauf &lt;</label><input id="sRsiLo" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">RSI Verkauf &gt;</label><input id="sRsiHi" class="inp" type="number"></div>
        </div>
        <div class="row">
          <div class="fld"><label class="lbl">Scan (min)</label><input id="sInt" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">Min Konfluenz</label><input id="sConf" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">Periode</label>
            <select id="sPeriod" class="sel"><option>3mo</option><option>6mo</option><option>1y</option></select></div>
        </div>
        <div class="row">
          <div class="fld"><label class="lbl">Max Pos %</label><input id="sMaxP" class="inp" type="number"></div>
          <div class="fld"><label class="lbl">Stop %</label><input id="sSL" class="inp" type="number" step="0.1"></div>
          <div class="fld"><label class="lbl">Take %</label><input id="sTP" class="inp" type="number" step="0.1"></div>
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
        <div class="chart-hd">
          <span class="chart-nm" id="chSym"></span>
          <span class="chart-sub" id="chSub"></span>
          <span class="chart-px" id="chPx">--</span>
          <span class="chart-px" id="chChg">--</span>
        </div>
        <div class="tf-bar">
          <button class="tf-btn" data-intraday="1">1T</button>
          <button class="tf-btn" data-intraday="5">1W</button>
          <button class="tf-btn" data-bars="22">1M</button>
          <button class="tf-btn on" data-bars="66">3M</button>
          <button class="tf-btn" data-bars="0">1J</button>
          <span class="grid-sw" title="Charts im Raster: 1, 2 oder 4 parallel">
            <button class="tf-btn on" data-grid="1">▭</button>
            <button class="tf-btn" data-grid="2">▯▯</button>
            <button class="tf-btn" data-grid="4">⊞</button>
          </span>
          <button class="tf-btn" id="lockMain" hidden
            title="Haupt-Chart in die Lock-Gruppe: Zoom, Sichtbereich und Crosshair laufen auf allen gelockten Charts synchron">🔓</button>
          <button class="tf-btn on" id="lyFc" title="Prognose-Overlay ein/aus" style="margin-left:auto">Prognose</button>
          <button class="tf-btn on" id="lyEv" title="Event-Marker ein/aus">Events</button>
        </div>
        <div class="tf-bar ind-bar">
          <button class="tf-btn" data-layer="sma20" title="Einfacher gleitender Durchschnitt, 20 Bars">SMA20</button>
          <button class="tf-btn" data-layer="sma50" title="SMA 50">SMA50</button>
          <button class="tf-btn" data-layer="sma200" title="SMA 200">SMA200</button>
          <button class="tf-btn" data-layer="ema9" title="Exponentieller Durchschnitt, 9">EMA9</button>
          <button class="tf-btn" data-layer="ema21" title="EMA 21">EMA21</button>
          <button class="tf-btn" data-layer="bb" title="Bollinger-Bänder (20, 2σ)">BB</button>
          <input id="cmpSym" class="inp cmp-inp" placeholder="+ Overlay: SYM" title="Zweiten Kurs als %-Linie überlagern (Tageskerzen)" />
          <button class="tf-btn" id="predBtn" hidden title="Prognose-Pfeil zeichnen: Klick in den Chart setzt den Ziel-Kurs">✏ Pfeil</button>
        </div>
        <div class="hint" id="fcInfo" style="margin-bottom:4px"></div>
        <div id="chartRow" class="chart-row" data-mode="1">
        <div id="chartWrap" class="chart-wrap">
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
        <div class="hint">1T/1W: 5-Minuten-Kerzen · 1M–1J: Tageskerzen —
          aktualisiert der zentrale 5-min-Scan. Zoom bleibt beim Aktualisieren erhalten.</div>
      </div></div>

      <div class="card" data-panel="chart2"><div class="sect">Vergleichs-Chart
        <button class="lchip" id="chipChart2" title="Link-Gruppe wechseln (Vergleichs-Chart folgt dieser Gruppe)">B</button></div><div class="cbody">
        <div class="chart-hd">
          <span class="chart-nm" id="ch2Sym"></span>
          <span class="chart-px" id="ch2Px">--</span>
        </div>
        <div id="chart2Area" style="height:200px"></div>
        <div class="hint">Zeitachse + Crosshair laufen synchron zum Haupt-Chart —
          eigene Link-Gruppe für den Symbol-Vergleich.</div>
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
        <input id="mSym" class="inp" placeholder="Symbol (z.B. AAPL)">
        <input id="mQty" class="inp" type="number" value="1" min="1" placeholder="Menge">
        <div class="row">
          <button class="btn btn-g" id="mtBuy">Buy</button>
          <button class="btn btn-r" id="mtSell">Sell</button>
        </div>
        <div class="hint" id="mtHint">Preis = zentraler Live-Kurs (Paper)</div>
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
        <label class="lbl">Richtungs-Trefferquote</label>
        <div id="fcAcc" class="vbig c-ac">--</div>
        <div class="row" style="gap:12px">
          <div><label class="lbl">Bewertet</label><div id="fcScored" class="smv">0</div></div>
          <div><label class="lbl">Best w</label><div id="fcW" class="smv">--</div></div>
          <div><label class="lbl">Lookback</label><div id="fcLb" class="smv">--</div></div>
        </div>
        <div class="hint" id="fcTuning">Self-Tuning sammelt Evidenz — Defaults aktiv,
          bis genug Prognosen realisiert sind.</div>
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
      <h3>⚙ Optionen</h3>
      <div class="wl-sec">Optionale Elemente</div>
      <label class="opt-row"><input type="checkbox" id="ouPred" />
        <span><b>Prognose-Pfeil (✏)</b> — eigene Kurs-Erwartung im Chart einzeichnen;
        zählt als gewichtete Stimme im Auto-Trading. <i>Beta, standardmäßig aus.</i></span></label>
      <label class="opt-row"><input type="checkbox" id="ouCmp" />
        <span><b>Vergleichs-Overlay</b> — zweites Symbol als %-Linie im Haupt-Chart.</span></label>
      <label class="opt-row"><input type="checkbox" id="ouGrid" />
        <span><b>Multi-Chart-Raster</b> — 1/2/4 Charts parallel mit Lock-Sync.</span></label>
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
  st.events = [];
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
    watchLatestIndicators(sym, (row) => renderIndicatorCards(row)),
    watchLatestSignal(sym, (sig) => {
      const el = $('vSig');
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
  const fit = st.chartFitPending;
  st.chartFitPending = false;
  if (st.intradayDays > 0) {
    st.chart.setBars(st.intradayBars, { fit, timeVisible: true });
    st.chart.setForecast(null); // Prognose ist tagesbasiert
    applyOverlays();
    return;
  }
  const bars = st.range > 0 ? st.bars.slice(-st.range) : st.bars;
  st.chart.setBars(bars, { fit, timeVisible: false });
  applyForecast();
  applyOverlays();
  drawPredictionArrow();
}

/** Indikator-/Vergleichs-Overlays aus den aktuell gezeigten Bars berechnen. */
function applyOverlays(): void {
  if (!st?.chart) return;
  const intraday = st.intradayDays > 0;
  const times: Array<string | number> = intraday
    ? st.intradayBars.map((b) => b.time)
    : (st.range > 0 ? st.bars.slice(-st.range) : st.bars).map((b) => b.date);
  const closes = intraday
    ? st.intradayBars.map((b) => b.close)
    : (st.range > 0 ? st.bars.slice(-st.range) : st.bars).map((b) => b.close);
  const lines: import('./chart.js').OverlayLine[] = [];
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
  // Vergleichs-Overlay (Tageskerzen): %-Entwicklung ab erstem gemeinsamen Tag
  if (!intraday && st.overlaySymbol && st.overlayBars.length > 1) {
    const firstDate = (st.range > 0 ? st.bars.slice(-st.range) : st.bars)[0]?.date ?? '';
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
}

/** Prognose-Pfeil als organische Vektor-Kurve über dem Chart (Dicke = Vertrauen). */
function drawPredictionArrow(): void {
  const svg = document.getElementById('predSvg');
  if (!svg || !st) return;
  svg.innerHTML = '';
  const pred = st.prediction;
  if (!st.ui.predArrow || !pred || !st.chart || st.intradayDays > 0 || st.bars.length === 0) return;
  const last = st.bars[st.bars.length - 1]!;
  const start = st.chart.coords(last.date, last.close);
  const yEnd = st.chart.coords(last.date, pred.targetPrice).y;
  if (start.x === null || start.y === null || yEnd === null) return;
  const box = svg.getBoundingClientRect();
  const x2 = Math.min(box.width - 16, start.x + Math.max(60, box.width * 0.12));
  const w = 1 + pred.confidence * 1.3;
  const midX = (start.x + x2) / 2;
  const up = pred.targetPrice >= last.close;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = `
    <path d="M${start.x},${start.y} Q${midX},${start.y} ${x2},${yEnd}"
      fill="none" stroke="#ffb86b" stroke-width="${w}" stroke-linecap="round" opacity="0.9" />
    <path d="M${x2},${yEnd} l${up ? '-9,3 2,-8' : '-9,-3 2,8'} z" fill="#ffb86b" opacity="0.9" />
    <text x="${x2 - 4}" y="${yEnd + (up ? -10 : 18)}" text-anchor="end" class="pred-label">
      ${pred.targetPrice.toFixed(2)} · ${pred.targetDate.slice(5)}</text>`;
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
  drawPredictionArrow();
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
}

function openOptions(): void {
  if (!st) return;
  ($('ouPred') as HTMLInputElement).checked = st.ui.predArrow;
  ($('ouCmp') as HTMLInputElement).checked = st.ui.cmpOverlay;
  ($('ouGrid') as HTMLInputElement).checked = st.ui.chartGrid;
  ($('owCap') as HTMLInputElement).value = String(st.strategy.broker.initialCapital);
  ($('owMax') as HTMLInputElement).value = String(st.strategy.engine.maxPositionPct);
  ($('owSl') as HTMLInputElement).value = String(st.strategy.engine.stopLossPct);
  ($('owTp') as HTMLInputElement).value = String(st.strategy.engine.takeProfitPct);
  $('optMsg').textContent = '';
  $('optModal').classList.add('show');
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

/** Event-Marker anwenden — respektiert den Events-Layer-Toggle (M6b). */
function applyMarkers(): void {
  if (!st?.chart) return;
  st.chart.setMarkers(
    st.showEvents
      ? st.events.map((e) => ({
          time: e.date,
          position: e.sentiment < -0.12 ? ('aboveBar' as const) : ('belowBar' as const),
          color: e.sentiment > 0.12 ? '#26cf9d' : e.sentiment < -0.12 ? '#f2586b' : '#8b93a8',
          shape: 'circle' as const,
          text: e.count > 1 ? String(e.count) : '',
        }))
      : [],
  );
}

/** Prognose-Overlay + Badge aus market/{sym}.forecast anwenden. */
function applyForecast(): void {
  if (!st?.chart) return;
  const fc = st.forecast;
  const info = $('fcInfo');
  if (!st.showForecast) {
    st.chart.setForecast(null);
    info.textContent = fc ? 'Prognose-Layer ausgeblendet.' : '';
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
  info.textContent =
    `Prognose ${dir} ${fc.predictedPct >= 0 ? '+' : ''}${fc.predictedPct.toFixed(2)} % ` +
    `über ${fc.points.length} Handelstage (w=${fc.w}, Lookback ${fc.lookback}, gestrichelt ±1σ)`;
}

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
  // Lock-Gruppe (Multi-Chart-Raster): Haupt-Chart synct nur, wenn selbst gelockt
  st.chart?.onVisibleRangeChange((range) => {
    if (st?.mainLocked && st.chart) syncLockedRange(st.chart, range);
  });
  st.chart?.onCrosshairDate((date) => {
    if (st?.mainLocked && st.chart) syncLockedCrosshair(st.chart, date);
  });
  void loadPredictionForSymbol();
  st.chart?.onCrosshairDate((date, pos) => {
    showEventTooltip(date, pos);
    if (!crosshairSyncing && st?.chart2) {
      crosshairSyncing = true;
      st.chart2.setCrosshair(date);
      crosshairSyncing = false;
    }
  });
  st.chart?.onVisibleRangeChange((range) => {
    if (rangeSyncing || !range || !st?.chart2) return;
    rangeSyncing = true;
    st.chart2.setVisibleRange(range);
    rangeSyncing = false;
  });
  renderChart();
  applyMarkers();
}

/** Tooltip-Details zum Event-Tag unter dem Crosshair (M6b). */
function showEventTooltip(date: string | null, pos: { x: number; y: number } | null): void {
  const tip = $('evTip');
  const ev = date && st?.showEvents ? st.events.find((e) => e.date === date) : undefined;
  if (!ev || !pos) {
    tip.hidden = true;
    return;
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

// Schutz gegen Sync-Echos: setVisibleRange/setCrosshair lösen auf dem
// Zielchart wieder Events aus — der jeweils aktive Sync setzt das Flag.
let rangeSyncing = false;
let crosshairSyncing = false;
let chart2Epoch = 0;

function renderChart2(): void {
  if (!st?.chart2) return;
  st.chart2.setBars(st.chart2Bars);
}

function wireChart2Ctx(): void {
  if (!st) return;
  clearSubs(st.chart2Subs);
  if (st.wsHidden.has('chart2')) return; // ausgeblendet = keine Listener
  const sym = st.chart2Symbol;
  $('ch2Sym').textContent = sym;
  st.chart2Subs.push(
    watchMarketDoc(sym, (d) => {
      $('ch2Px').textContent = d?.quote ? fmtNum(d.quote.price) : '--';
    }),
    watchBars(sym, (bars) => {
      if (!st) return;
      st.chart2Bars = bars;
      renderChart2();
    }),
  );
}

async function rebuildChart2(): Promise<void> {
  if (!st) return;
  const epoch = ++chart2Epoch;
  st.chart2?.destroy();
  st.chart2 = null;
  if (st.wsHidden.has('chart2')) return;
  const handle = await buildPriceChart($('chart2Area'), st.chart2Symbol);
  if (!st || epoch !== chart2Epoch) {
    handle?.destroy();
    return;
  }
  st.chart2 = handle;
  // Zeit-/Crosshair-Sync zum Haupt-Chart (beidseitig, mit Echo-Schutz)
  st.chart2?.onVisibleRangeChange((range) => {
    if (rangeSyncing || !range || !st?.chart) return;
    rangeSyncing = true;
    st.chart.setVisibleRange(range);
    rangeSyncing = false;
  });
  st.chart2?.onCrosshairDate((date) => {
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
      panels: st.gridPanels.map((p) => ({ sym: p.sym, range: p.range, locked: p.locked })),
    }),
  );
}

function loadGridPrefs(): { mode: 1 | 2 | 4; mainLocked: boolean; panels: Array<{ sym: string; range: number; locked: boolean }> } {
  const fallback = { mode: 1 as const, mainLocked: false, panels: [] };
  try {
    const raw = localStorage.getItem(GRID_LS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as { mode?: number; mainLocked?: boolean; panels?: Array<{ sym?: string; range?: number; locked?: boolean }> };
    const mode = p.mode === 2 || p.mode === 4 ? p.mode : 1;
    return {
      mode,
      mainLocked: p.mainLocked === true,
      panels: (p.panels ?? []).slice(0, 3).map((x) => ({
        sym: typeof x.sym === 'string' && x.sym ? x.sym : 'AAPL',
        range: typeof x.range === 'number' ? x.range : 66,
        locked: x.locked === true,
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

// Lock-Sync nutzt dieselben Echo-Guards wie der Chart-Stack: setVisibleRange/
// setCrosshair feuern die Subscriptions des Zielcharts synchron.
function syncLockedRange(from: PriceChartHandle, range: { from: number; to: number } | null): void {
  if (rangeSyncing || !range) return;
  rangeSyncing = true;
  for (const h of lockedHandles(from)) h.setVisibleRange(range);
  rangeSyncing = false;
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
  p.chart.setBars(p.range > 0 ? p.bars.slice(-p.range) : p.bars, { fit });
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
      renderGridPanelBars(p);
    }),
  );
  const handle = await buildPriceChart(host, p.sym);
  if (!st || epoch !== p.epoch || !st.gridPanels.includes(p)) {
    handle?.destroy();
    return;
  }
  p.chart = handle;
  p.chart?.onVisibleRangeChange((range) => {
    if (p.locked && p.chart) syncLockedRange(p.chart, range);
  });
  p.chart?.onCrosshairDate((date) => {
    if (p.locked && p.chart) syncLockedCrosshair(p.chart, date);
  });
  renderGridPanelBars(p);
}

function unmountGridPanel(p: GridPanel): void {
  p.epoch++;
  clearSubs(p.subs);
  p.chart?.destroy();
  p.chart = null;
}

/** Raster-DOM an gridMode angleichen; Panels mounten/unmounten; persistieren. */
function renderChartGrid(): void {
  if (!st) return;
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
    st.gridPanels.push({ sym, range: 66, locked: false, chart: null, bars: [], subs: [], epoch: 0, fitPending: true });
  }
  $('chartRow').dataset['mode'] = String(st.gridMode);
  ($('lockMain') as HTMLButtonElement).hidden = st.gridMode === 1;
  $('lockMain').textContent = st.mainLocked ? '🔒' : '🔓';
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
          <button class="tf-btn${p.range === 22 ? ' on' : ''}" data-r="22">1M</button>
          <button class="tf-btn${p.range === 66 ? ' on' : ''}" data-r="66">3M</button>
          <button class="tf-btn${p.range === 0 ? ' on' : ''}" data-r="0">1J</button>
        </span>
        <button class="tf-btn gp-lock${p.locked ? ' on' : ''}"
          title="Lock: Zoom, Sichtbereich und Crosshair synchron mit allen gelockten Charts">${p.locked ? '🔒' : '🔓'}</button>
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
    el.querySelectorAll('[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        p.range = Number((b as HTMLElement).dataset['r']);
        p.fitPending = true;
        el.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('on', x === b));
        saveGridPrefs();
        renderGridPanelBars(p);
      }),
    );
    const lockBtn = el.querySelector('.gp-lock') as HTMLButtonElement;
    lockBtn.addEventListener('click', () => {
      p.locked = !p.locked;
      lockBtn.textContent = p.locked ? '🔒' : '🔓';
      lockBtn.classList.toggle('on', p.locked);
      saveGridPrefs();
      // frisch gelockt → sofort auf den Stand der Gruppe ziehen
      if (p.locked && p.chart) {
        const other = lockedHandles(p.chart)[0];
        const r = other?.getVisibleRange();
        if (r) syncLockedRange(other!, r);
      }
    });
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
        Object.keys(PANEL_TITLES).map((id) => [id, { hidden: st!.wsHidden.has(id) }]),
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
  for (const cls of CLASS_ORDER) {
    if (!st.universe[cls]) continue;
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
    tr.querySelectorAll('td')[1]!.textContent = t.symbol + (t.source === 'engine' ? ' ⚙' : '');
    jb.appendChild(tr);
  }
}

async function manualTrade(symbol: string, side: 'buy' | 'sell'): Promise<void> {
  const hint = $('mtHint');
  hint.textContent = 'Sende Order…';
  try {
    const qty = Math.max(1, Number(($('mQty') as HTMLInputElement).value) || 1);
    await callTrade({ symbol, side, ...(side === 'buy' ? { qty } : {}) });
    hint.textContent = `${side === 'buy' ? 'Gekauft' : 'Verkauft'}: ${symbol}`;
  } catch (e) {
    hint.textContent = (e as { message?: string }).message ?? 'Order fehlgeschlagen';
  }
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
    chartFitPending: true,
    prediction: null,
    predMode: false,
    ui: { predArrow: false, cmpOverlay: true, chartGrid: true },
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
    chartGroup: 'A',
    newsGroup: 'A',
    chart2Group: 'B',
    chart2Symbol: DEFAULT_STRATEGY.watchlist[1] ?? 'QQQ',
    chart2: null,
    chart2Bars: [],
    chart2Subs: [],
    lastQuote: null,
    orderSide: 'buy',
    hotkeys: { ...HOTKEY_DEFAULTS },
    newsSymbol: DEFAULT_STRATEGY.watchlist[0] ?? 'QQQ',
    newsSubs: [],
    wsPreset: 'ueberblick',
    wsHidden: new Set(DEFAULT_HIDDEN),
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
    }),
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
    applyPanels();
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
    panelRange: (i: number) => st?.gridPanels[i]?.chart?.getVisibleRange() ?? null,
    setPanelRange: (i: number, r: { from: number; to: number }) => st?.gridPanels[i]?.chart?.setVisibleRange(r),
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
  $('olv').addEventListener('click', () => {
    for (const id of ['leftCol', 'rightCol']) $(id).classList.remove('show');
    $('olv').classList.remove('show');
  });
  $('mtBuy').addEventListener('click', () => {
    const sym = (($('mSym') as HTMLInputElement).value || st?.currentSymbol || '').trim().toUpperCase();
    if (sym) void manualTrade(sym, 'buy');
  });
  $('mtSell').addEventListener('click', () => {
    const sym = (($('mSym') as HTMLInputElement).value || st?.currentSymbol || '').trim().toUpperCase();
    if (sym) void manualTrade(sym, 'sell');
  });
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
      st.intradayDays = parseInt(b.dataset.intraday ?? '0', 10);
      if (b.dataset.bars !== undefined) st.range = parseInt(b.dataset.bars, 10);
      st.chartFitPending = true;
      tfButtons.forEach((el) => el.classList.toggle('on', el === b));
      if (st.intradayDays > 0) void loadIntradayView();
      else renderChart();
    }),
  );
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
    });
  });
  // Prognose-Pfeil: Modus + Popover
  $('predBtn').addEventListener('click', () => {
    if (!st) return;
    if (st.intradayDays > 0) return; // Pfeil nur in der Tages-Ansicht
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
      })
      .catch((e) => alert(`Prognose: ${(e as Error).message}`));
  });

  // Options-Modal (⚙): Element-Toggles sofort wirksam, Wallet-Basics via saveStrategy
  $('optBtn').addEventListener('click', openOptions);
  for (const [id, key] of [
    ['ouPred', 'predArrow'],
    ['ouCmp', 'cmpOverlay'],
    ['ouGrid', 'chartGrid'],
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
    $('lockMain').textContent = st.mainLocked ? '🔒' : '🔓';
    $('lockMain').classList.toggle('on', st.mainLocked);
    saveGridPrefs();
  });
  // Gespeichertes Raster wiederherstellen (localStorage)
  if (st) {
    const prefs = loadGridPrefs();
    st.gridMode = prefs.mode;
    st.mainLocked = prefs.mainLocked;
    st.gridPanels = prefs.panels.map((p) => ({ ...p, chart: null, bars: [], subs: [], epoch: 0, fitPending: true }));
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
  });
  $('lyEv').addEventListener('click', () => {
    if (!st) return;
    st.showEvents = !st.showEvents;
    $('lyEv').classList.toggle('on', st.showEvents);
    applyMarkers();
    if (!st.showEvents) $('evTip').hidden = true;
  });
  document.addEventListener('keydown', onEscape);
}

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeModal('detail');
  closeModal('picker');
  closeModal('options');
  document.getElementById('orderModal')?.classList.remove('show');
  for (const id of ['leftCol', 'rightCol']) document.getElementById(id)?.classList.remove('show');
  document.getElementById('olv')?.classList.remove('show');
}

export function unmountDashboard(): void {
  if (!st) return;
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
  st.chart?.destroy();
  st.chart2?.destroy();
  document.removeEventListener('keydown', onEscape);
  document.removeEventListener('keydown', onGlobalHotkey);
  st = null;
}
