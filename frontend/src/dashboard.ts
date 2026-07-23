/**
 * Dashboard-View — Port des Frosted-Aurora-Dashboards (M3) auf Firestore.
 * Alle Daten kommen per onSnapshot/getDocs aus market/** und users/{uid},
 * Aktionen laufen über Callables (ensureProfile, saveStrategy). Kein /api/*.
 */

import {
  CLASS_LABELS,
  DEFAULT_STRATEGY,
  resolveName,
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
  saveStrategy,
  watchBars,
  watchLatestIndicators,
  watchLatestSignal,
  watchMarketDoc,
  watchForecastStats,
  watchPositions,
  watchTrades,
  watchUserDoc,
  type IndicatorRow,
  type MarketDocData,
  type SignalRow,
  type TradeRow,
  type UniverseClass,
} from './data.js';
import { logout } from './auth.js';

const CLASS_ORDER = [
  'indices', 'forex', 'crypto', 'commodities', 'rates_bonds',
  'etf_sectors', 'etf_regions', 'etf_thematic', 'stocks_us', 'stocks_global',
];

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
  pickerSelection: Set<string>;
  wallet: Wallet | null;
  positions: Position[];
  trades: TradeRow[];
  forecast: MarketDocData['forecast'];
  /** Live-Preise der Positions-Symbole (aus market/{sym}.quote). */
  posPrices: Map<string, number>;
  subs: Unsubscribe[]; // globale Subs (Settings, Wallet, Positionen, Trades)
  symbolSubs: Unsubscribe[]; // pro Chart-Symbol
  watchlistSubs: Unsubscribe[]; // pro Watchlist (Livebar + Tabelle)
  positionSubs: Map<string, Unsubscribe>; // Quotes je Positions-Symbol
  timers: number[];
}

let st: DashState | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/* ── Markup ─────────────────────────────────────────────────────────── */

function layout(email: string): string {
  return `
  <header class="hdr">
    <button class="burg" id="burgL" aria-label="Linkes Panel">☰</button>
    <div class="logo">AUTO<span class="c-gn">TRD</span></div>
    <div class="spacer"></div>
    <div id="engBadge" class="badge b-off">Engine aus</div>
    <button class="hbtn" id="themeBtn" title="Hell/Dunkel">◐</button>
    <span class="user">${email.replace(/[<>&]/g, '')}</span>
    <button class="hbtn" id="logoutBtn">Abmelden</button>
    <button class="burg" id="burgR" aria-label="Rechtes Panel">☰</button>
  </header>
  <div class="overlay" id="olv"></div>

  <div class="app">
    <div class="col-l" id="leftCol">
      <div class="card"><div class="sect">Strategie</div><div class="cbody">
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

      <div class="card"><div class="sect">Engine</div><div class="cbody">
        <button class="btn btn-g" id="engStart">Start</button>
        <button class="btn btn-r" id="engStop">Stop</button>
        <div class="hint">Bei Engine AN handelt der zentrale 5-min-Scan
          automatisch nach deiner Strategie (Paper).</div>
      </div></div>

      <div class="card"><div class="sect">Trade-Historie</div><div class="cbody">
        <div class="tw"><table class="tbl">
          <thead><tr><th>Zeit</th><th>Sym</th><th>Side</th><th>Qty</th><th>Preis</th><th>P&amp;L</th></tr></thead>
          <tbody id="jBody"><tr><td colspan="6" class="c-t3">Keine Trades</td></tr></tbody>
        </table></div>
      </div></div>
    </div>

    <div class="col-m">
      <div class="livebar" id="liveBar"></div>

      <div class="card"><div class="sect">Chart · Candlestick + Volumen</div><div class="cbody">
        <div class="chart-hd">
          <span class="chart-nm" id="chSym"></span>
          <span class="chart-sub" id="chSub"></span>
          <span class="chart-px" id="chPx">--</span>
          <span class="chart-px" id="chChg">--</span>
        </div>
        <div class="tf-bar">
          <button class="tf-btn" data-bars="22">1M</button>
          <button class="tf-btn on" data-bars="66">3M</button>
          <button class="tf-btn" data-bars="0">Alle</button>
        </div>
        <div class="hint" id="fcInfo" style="margin-bottom:4px"></div>
        <div id="chartArea"></div>
        <div class="hint">Tageskerzen aus <span class="mono">market/{sym}/bars</span> —
          aktualisiert der zentrale 5-min-Scan.</div>
      </div></div>

      <div class="sig-grid">
        <div class="scard"><div class="slbl">RSI (14)</div><div id="vRSI" class="sval c-ac">--</div></div>
        <div class="scard"><div class="slbl">MACD</div><div id="vMacd" class="sval c-ac">--</div></div>
        <div class="scard"><div class="slbl">BB Pos %</div><div id="vBB" class="sval c-ac">--</div></div>
        <div class="scard"><div class="slbl">Signal</div><div id="vSig" class="sval c-t3">--</div></div>
      </div>

      <div class="card"><div class="sect">Auto-Signale</div><div class="cbody">
        <div class="tw"><table class="tbl">
          <thead><tr><th>Ticker</th><th>RSI</th><th>MACD</th><th>BB %</th><th>Konfluenz</th><th>Signal</th></tr></thead>
          <tbody id="sigBody"><tr><td colspan="6" class="c-t3">Noch kein Scan</td></tr></tbody>
        </table></div>
      </div></div>

      <div class="card"><div class="sect">Aktive Positionen <span id="pCount" style="float:right;color:var(--t3)">0 offen</span></div><div class="cbody">
        <div class="tw"><table class="tbl">
          <thead><tr><th>Sym</th><th>Qty</th><th>Eintritt</th><th>Aktuell</th><th>P&amp;L</th><th>%</th><th></th></tr></thead>
          <tbody id="pBody"><tr><td colspan="7" class="c-t3">Keine offenen Positionen</td></tr></tbody>
        </table></div>
      </div></div>

      <div class="card"><div class="sect">Markt-Übersicht</div><div class="cbody">
        <div class="mkt-tabs" id="mktTabs"></div>
        <div id="mktBody"><span class="c-t3">Lade Katalog…</span></div>
      </div></div>
    </div>

    <div class="col-r" id="rightCol">
      <div class="card"><div class="sect">Performance</div><div class="cbody kpi">
        <label class="lbl">Cash</label><div id="vCash" class="vbig c-ac">--</div>
        <label class="lbl">Equity (live)</label><div id="vEq" class="vbig">--</div>
        <label class="lbl">Gesamt P&amp;L</label><div id="vPnl" class="vbig">--</div>
        <div class="row" style="gap:12px">
          <div><label class="lbl">Realisiert</label><div id="vClosed" class="smv">--</div></div>
          <div><label class="lbl">Offen</label><div id="vUnreal" class="smv">--</div></div>
          <div><label class="lbl">Win Rate</label><div id="vWR" class="smv">--%</div></div>
        </div>
      </div></div>

      <div class="card"><div class="sect">Manueller Trade</div><div class="cbody">
        <input id="mSym" class="inp" placeholder="Symbol (z.B. AAPL)">
        <input id="mQty" class="inp" type="number" value="1" min="1" placeholder="Menge">
        <div class="row">
          <button class="btn btn-g" id="mtBuy">Buy</button>
          <button class="btn btn-r" id="mtSell">Sell</button>
        </div>
        <div class="hint" id="mtHint">Preis = zentraler Live-Kurs (Paper)</div>
      </div></div>

      <div class="card"><div class="sect">Markt-Uhr (ET)</div><div class="cbody">
        <div id="marketClock" class="clock">--:--:--</div>
        <div class="phases">
          <div class="ph" id="phPre">Pre-Mkt</div>
          <div class="ph" id="phMain">Regular</div>
          <div class="ph" id="phAft">After-Hrs</div>
        </div>
      </div></div>

      <div class="card"><div class="sect">Prognose-Genauigkeit</div><div class="cbody kpi">
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

      <div class="card"><div class="sect">News &amp; Sentiment</div><div class="cbody">
        <div class="hint">News-Feeds, Lexikon-Sentiment und KI-Tageszusammenfassung
          folgen mit Milestone M6.</div>
      </div></div>
    </div>
  </div>

  <div class="dmodal" id="detailModal">
    <div class="dmodal-bg" data-close="detail"></div>
    <div class="dsheet" id="detailSheet"></div>
  </div>

  <div class="dmodal" id="wlModal">
    <div class="dmodal-bg" data-close="picker"></div>
    <div class="dsheet" style="width:min(700px,100%)">
      <button class="dclose" data-close="picker">✕</button>
      <h3>Watchlist zusammenstellen</h3>
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

function wireSymbol(): void {
  if (!st) return;
  clearSubs(st.symbolSubs);
  const sym = st.currentSymbol;
  $('chSym').textContent = sym;
  $('chSub').textContent = resolveName(sym);

  st.symbolSubs.push(
    watchMarketDoc(sym, (d) => {
      const q = d?.quote;
      $('chPx').textContent = q ? fmtNum(q.price) : '--';
      const chg = $('chChg');
      chg.textContent = q ? fmtPct(q.changePct) : '--';
      chg.className = `chart-px ${q ? pnlClass(q.changePct) : ''}`;
      if (st) {
        st.forecast = d?.forecast ?? null;
        applyForecast();
      }
    }),
    watchBars(sym, (bars) => {
      if (!st) return;
      st.bars = bars;
      renderChart();
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

function renderIndicatorCards(row: IndicatorRow | null): void {
  $('vRSI').textContent = row?.rsi != null ? row.rsi.toFixed(1) : '--';
  $('vMacd').textContent = row?.macd ? row.macd.line.toFixed(2) : '--';
  $('vBB').textContent = row?.bollinger ? row.bollinger.pctB.toFixed(0) : '--';
}

function renderChart(): void {
  if (!st?.chart) return;
  const bars = st.range > 0 ? st.bars.slice(-st.range) : st.bars;
  st.chart.setBars(bars);
  applyForecast();
}

/** Prognose-Overlay + Badge aus market/{sym}.forecast anwenden. */
function applyForecast(): void {
  if (!st?.chart) return;
  const fc = st.forecast;
  const info = $('fcInfo');
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

async function rebuildChart(): Promise<void> {
  if (!st) return;
  st.chart?.destroy();
  st.chart = await buildPriceChart($('chartArea'), st.currentSymbol);
  renderChart();
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

function selectSymbol(sym: string): void {
  if (!st || st.currentSymbol === sym) return;
  st.currentSymbol = sym;
  document.querySelectorAll('.lb-item').forEach((el) => {
    el.classList.toggle('on', el.querySelector('.lb-sym')?.textContent === sym);
  });
  void rebuildChart();
  wireSymbol();
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
    err.textContent = 'Speichern fehlgeschlagen — bitte erneut versuchen.';
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
          if (st!.pickerSelection.has(symbol)) st!.pickerSelection.delete(symbol);
          else st!.pickerSelection.add(symbol);
          opt.classList.toggle('on');
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

function closeModal(which: 'detail' | 'picker'): void {
  $(which === 'detail' ? 'detailModal' : 'wlModal').classList.remove('show');
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
    pickerSelection: new Set(),
    wallet: null,
    positions: [],
    trades: [],
    forecast: null,
    posPrices: new Map(),
    subs: [],
    symbolSubs: [],
    watchlistSubs: [],
    positionSubs: new Map(),
    timers: [],
  };

  // User-Doc: Strategie (Formular/Watchlist) + Wallet folgen Firestore
  st.subs.push(
    watchUserDoc(uid, ({ strategy, wallet }) => {
      if (!st) return;
      const prevWl = st.strategy.watchlist.join(',');
      st.strategy = strategy ?? DEFAULT_STRATEGY;
      st.wallet = wallet;
      fillForm(st.strategy);
      renderPortfolio();
      if (st.strategy.watchlist.join(',') !== prevWl || $('liveBar').childElementCount === 0) {
        if (!st.strategy.watchlist.includes(st.currentSymbol)) {
          st.currentSymbol = st.strategy.watchlist[0] ?? st.currentSymbol;
          void rebuildChart();
          wireSymbol();
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

  wireWatchlist();
  wireSymbol();
  void rebuildChart();
  void renderMarketTabs();
  updateClock();
  st.timers.push(window.setInterval(updateClock, 1000));

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
    el.addEventListener('click', () => closeModal((el as HTMLElement).dataset.close as 'detail' | 'picker')));
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
  document.addEventListener('keydown', onEscape);
}

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeModal('detail');
  closeModal('picker');
  for (const id of ['leftCol', 'rightCol']) document.getElementById(id)?.classList.remove('show');
  document.getElementById('olv')?.classList.remove('show');
}

export function unmountDashboard(): void {
  if (!st) return;
  clearSubs(st.subs);
  clearSubs(st.symbolSubs);
  clearSubs(st.watchlistSubs);
  for (const u of st.positionSubs.values()) u();
  for (const t of st.timers) clearInterval(t);
  st.chart?.destroy();
  document.removeEventListener('keydown', onEscape);
  st = null;
}
