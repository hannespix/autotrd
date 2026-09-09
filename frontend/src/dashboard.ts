/**
 * Dashboard-View — die Oberfläche des Auto-Traders.
 *
 * Alle Daten kommen per onSnapshot/getDocs aus users/{uid}, market/** und
 * meta/**; Aktionen laufen über Callables (saveStrategy, engineCommand,
 * connectBroker, …). Kein /api/*, keine Handelslogik im Browser: Der Takt
 * (`functions/src/engine`) entscheidet, die Oberfläche zeigt und schaltet.
 *
 * Karten: Engine (Schalter, Status, Halt/Resume/Flatten) · Einstellungen
 * des Auto-Traders · Admin · Positionen · „Warum handelt die Engine
 * (nicht)?" · Champion · Handelshistorie · Performance. Optionen (⚙):
 * Anzeige, Broker & Echtgeld, Konto & Steuer.
 */

import {
  AUTO_DEFAULTS,
  AUTO_GRENZEN,
  AUTO_SYMBOLS_MAX,
  autoSettingsFromLegacy,
  DEFAULT_STRATEGY,
  closedOnly,
  equityCurve,
  imZeitraum,
  positionLage,
  resolveName,
  validateAutoSettings,
  zeitraumBeginn,
  ZEITRAEUME,
  type AutoSettings,
  type HistoryTrade,
  type Strategy,
  type Wallet,
  type Zeitraum,
} from '@autotrd/shared';
import type { Unsubscribe } from 'firebase/firestore';
import { ICONS } from './icons.js';
import { installiereLogoFallback, schmueckeAvatare, symbolAvatar } from './symbolAvatar.js';
import {
  adminAntworten,
  adminDeleteAccount,
  adminListUsers,
  adminLiveStatus,
  adminNachrichten,
  adminSetAccess,
  adminSetAdmin,
  adminSetKillSwitch,
  callBrokerStatus,
  callConnectBroker,
  callDisconnectBroker,
  callFxNachtragen,
  callLiveMode,
  callTaxReport,
  DEFAULT_UNIVERSE,
  engineCommand,
  loadMoreTrades,
  loadOptimizeReport,
  nachrichtenLesen,
  nachrichtSenden,
  resetWallet,
  saveStrategy,
  TRADE_PAGE,
  watchChampion,
  watchEngineConfig,
  watchEquitySeries,
  watchHealth,
  watchMarketDoc,
  watchPortfolioStats,
  watchPositions,
  watchTrades,
  watchUserDoc,
  type AdminUserRow,
  type BrokerStatusResult,
  type ChampionDoc,
  type EngineCommandAction,
  type EngineMirror,
  type EquitySeriesPoint,
  type FadenNachricht,
  type HealthDoc,
  type LiveModeStatus,
  type PortfolioStatsDoc,
  type PositionRow,
  type TaxReportResult,
  type TradeCursor,
  type TradeRow,
} from './data.js';
import { emailVerified, frischAnmelden, logout, refreshUser, sendVerification } from './auth.js';
import { esc } from './html.js';
import { iBtn, initInfoTips } from './infotips.js';
import { serverText, setzeSprache, sprachWahl, t, uebersetze, valText } from './i18n.js';
import { mountLegalFooter } from './legal.js';

/* ── Karten-Registry ──────────────────────────────────────────────────── */

/* Karten-IDs = data-panel-Attribut: engine · settings · positions · engineWhy ·
 * champion · history · performance. Texte über t() zur MODUL-Ladezeit sind
 * sicher, weil der Sprachwechsel bewusst per location.reload() arbeitet. */

const fmtNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  const dp = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dp });
};
const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined ? '--' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const pnlClass = (n: number): string => (n >= 0 ? 'c-gn' : 'c-rd');
const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? '--' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Zeitstempel als `dd.mm. hh:mm` in der gewählten Sprache — für Status-Zeilen. */
function wann(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(sprachWahl() === 'en' ? 'en-GB' : 'de-DE', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Alter eines Zeitstempels in Minuten; null, wenn unbrauchbar. */
function alterMin(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 60_000) : null;
}

interface DashState {
  uid: string;
  email: string;
  /** Alte Strategie — nur `engine.running` (Schalter) und `broker` (Modus, Kapitalbasis). */
  strategy: Strategy;
  /** Einstellungen des Auto-Traders, mit Defaults aufgefüllt. */
  auto: AutoSettings;
  /** Gespeicherte Symbol-Auswahl (null = ganzes Universum). */
  autoSymbols: string[] | null;
  engine: EngineMirror | null;
  wallet: Wallet | null;
  positions: PositionRow[];
  trades: TradeRow[];
  tradesCursor: TradeCursor | null;
  tradesDone: boolean;
  tradesLoading: boolean;
  tradesFehler: string | null;
  /** Live-Preise der Positions-Symbole (aus market/{sym}.quote). */
  posPrices: Map<string, number>;
  positionSubs: Map<string, Unsubscribe>;
  pfStats: PortfolioStatsDoc | null;
  equitySeries: EquitySeriesPoint[];
  /** Zeitraum der Equity-Kurve (0 = alles). */
  pfZeitraum: Zeitraum;
  health: HealthDoc | null;
  champion: ChampionDoc | null;
  /** Plattform-Universum (meta/engineConfig), Fallback: eingebaute Liste. */
  universe: string[];
  accessLevel: 'pending' | 'approved' | 'blocked' | 'archiviert';
  admin: boolean;
  /** Eingeklappte Karten (Gerät-lokal). */
  collapsed: Set<string>;
  subs: Unsubscribe[];
  timers: number[];
}

let st: DashState | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/* ── Markup ─────────────────────────────────────────────────────────── */

function layout(email: string): string {
  return `
  <header class="hdr">
    <button class="burg" id="burgL" aria-label="${t('nav.panelLinks')}">☰</button>
    <div class="logo">AUTO<span class="c-gn">TRD</span></div>
    <div class="spacer"></div>
    <div id="engBadge" class="badge b-off">${t('nav.engineAus')}</div>
    <button class="hbtn" id="optBtn" title="${t('nav.optionenTitle')}">${ICONS.gear}</button>
    <button class="hbtn sb-tgl" id="sideL" title="${t('nav.spalteLinks')}">◧</button>
    <button class="hbtn sb-tgl" id="sideR" title="${t('nav.spalteRechts')}">◨</button>
    <span class="user">${email.replace(/[<>&]/g, '')}</span>
    <button class="burg" id="burgR" aria-label="${t('nav.panelRechts')}">☰</button>
  </header>
  <div class="overlay" id="olv"></div>

  <div class="app">
    <div class="col-l" id="leftCol">
      <div class="card" data-panel="engine"><div class="sect">${t('panel.engine')} ${iBtn('engine')}</div><div class="cbody">
        <!-- Immer genau EINER sichtbar (renderEngineBadge schaltet um). -->
        <button class="btn btn-g" id="engStart">${t('lay.engineStartKnopf')}</button>
        <button class="btn btn-r" id="engStop" hidden>${t('lay.engineStoppKnopf')}</button>
        <div class="hint">${t('eng.schalterHint')}</div>
        <p id="engMsg" class="hint" hidden></p>
        <p id="accessNote" class="hint" hidden style="color:var(--yl,#d9a441);margin-top:6px"></p>
        <div class="wl-sec">${t('eng.statusTitel')}</div>
        <div id="engStatus" class="eng-status"><div class="hint">${t('eng.keinTakt')}</div></div>
        <div class="wl-sec">${t('eng.kommandos')} ${iBtn('engineKommandos')}</div>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <button class="btn btn-n" id="engHalt">${t('eng.halt')}</button>
          <button class="btn btn-n" id="engResume">${t('eng.resume')}</button>
          <button class="btn btn-r" id="engFlatten">${t('eng.flatten')}</button>
        </div>
        <p class="hint" id="engCmdMsg"></p>
        <!-- Faden zum Admin: direkt unter der Wartemeldung, wo die Frage entsteht. -->
        <div id="fadenBox" style="margin-top:8px">
          <div id="fadenListe" class="faden-liste"></div>
          <textarea id="fadenText" class="inp faden-text" rows="2"
            maxlength="2000" placeholder="${t('fd.platzhalter')}"></textarea>
          <div class="row" style="gap:6px;align-items:center">
            <button class="btn btn-n" id="fadenSend">${t('fd.senden')}</button>
            <span class="hint" id="fadenMsg"></span>
          </div>
        </div>
        <div id="verifyBox" hidden style="margin-top:8px">
          <p class="hint" style="color:var(--rd)">${t('lay.mailUnbestaetigt')}</p>
          <div class="row">
            <button class="btn btn-n" id="verifySend">${t('lay.bestaetigungsMail')}</button>
            <button class="btn btn-n" id="verifyDone">${t('lay.habeBestaetigt')}</button>
          </div>
          <div class="hint" id="verifyHint"></div>
        </div>
      </div></div>

      <div class="card" data-panel="settings"><div class="sect">${t('panel.einstellungen')} ${iBtn('autoSettings')}</div><div class="cbody">
        <p class="hint">${t('as.hint')}</p>
        <div class="opt-grid" id="asGrid">
          <label>${t('as.riskPerTrade')} ${iBtn('riskPerTrade')}
            <input id="asRisk" class="inp st-num" type="number" min="${AUTO_GRENZEN.riskPerTradePct[0]}" max="${AUTO_GRENZEN.riskPerTradePct[1]}" step="0.1" /></label>
          <label>${t('as.maxPositionPct')} ${iBtn('maxPos')}
            <input id="asMaxPct" class="inp st-num" type="number" min="${AUTO_GRENZEN.maxPositionPct[0]}" max="${AUTO_GRENZEN.maxPositionPct[1]}" step="1" /></label>
          <label>${t('as.maxPositions')} ${iBtn('maxOpenPositions')}
            <input id="asMaxN" class="inp st-num" type="number" min="${AUTO_GRENZEN.maxPositions[0]}" max="${AUTO_GRENZEN.maxPositions[1]}" step="1" /></label>
          <label>${t('as.maxDailyLoss')} ${iBtn('dailyLossLimit')}
            <input id="asDaily" class="inp st-num" type="number" min="${AUTO_GRENZEN.maxDailyLossPct[0]}" max="${AUTO_GRENZEN.maxDailyLossPct[1]}" step="0.5" /></label>
          <label>${t('as.maxDrawdown')} ${iBtn('maxDrawdown')}
            <input id="asDd" class="inp st-num" type="number" min="${AUTO_GRENZEN.maxDrawdownPct[0]}" max="${AUTO_GRENZEN.maxDrawdownPct[1]}" step="1" /></label>
          <label class="opt-check">
            <input type="checkbox" id="asShort" />
            <span>${t('as.allowShort')} ${iBtn('allowShort')}</span></label>
          <label class="opt-check">
            <input type="checkbox" id="asTelegram" />
            <span>${t('as.telegram')} ${iBtn('telegram')}</span></label>
          <label class="opt-check">
            <input type="checkbox" id="asBasis" />
            <span>${t('as.basis')} ${iBtn('basis')}</span></label>
        </div>
        <div class="wl-sec">${t('as.symbole')} ${iBtn('symbolauswahl')}</div>
        <div class="row" style="gap:6px;margin-bottom:4px">
          <button class="tf-btn" id="asAlle">${t('as.alle')}</button>
          <button class="tf-btn" id="asKeine">${t('as.keine')}</button>
          <span class="hint" id="asSymCount" style="margin-left:auto"></span>
        </div>
        <div id="asSymbols" class="as-symbols"></div>
        <p id="asErr" class="error" hidden></p>
        <div class="row" style="margin-top:8px;align-items:center">
          <button class="btn btn-g" id="asSave">${t('opt.speichern')}</button>
          <span class="hint" id="asMsg"></span>
        </div>
      </div></div>

      <!-- Admin-Verwaltung: nur für Konten mit admin:true sichtbar. Bewusst
           OHNE data-panel — die Karte gehört nicht in die Klapp-Mechanik. -->
      <div class="card" id="adminCard" hidden><div class="sect">Admin · Freischaltung<span id="admOffen" style="float:right;color:var(--t3)">0</span></div><div class="cbody">
        <div class="hint">${t('lay.neueKonten')}</div>
        <div class="row adm-kopf">
          <button class="hbtn" id="admReload">${t('adm.laden')}</button>
          <input id="admSuche" class="inp adm-suche" placeholder="${t('adm.filterKonto')}" hidden />
          <label class="adm-archiv" hidden>
            <input type="checkbox" id="admArchiv" />
            <span>${t('adm.archivZeigen')}</span>
            <span id="admArchivZahl" class="mono"></span>
          </label>
          <span id="admStand" class="hint mono adm-stand"></span>
        </div>
        <div id="admList"></div>
        <p id="admErr" class="error" hidden></p>
        <div class="wl-sec adm-trenner">Echtgeld-Not-Aus</div>
        <div class="hint">${t('lay.notausHinweis')}</div>
        <div class="row" style="gap:6px;align-items:center;margin-top:6px">
          <span id="admKillState" class="mono hint">Zustand: …</span>
          <button class="btn btn-r" id="admKillBtn" style="margin-left:auto" hidden></button>
        </div>
      </div></div>
    </div>

    <div class="col-m" id="centerCol">
      <div class="card" data-panel="positions"><div class="sect">${t('panel.positionenKopf')} <span id="pCount" style="float:right;color:var(--t3)">0 offen</span></div><div class="cbody">
        <div class="tw"><table class="tbl tbl-karten tbl-kompakt-pos">
          <thead><tr><th>Sym</th><th>Qty</th><th>${t('tab.eintritt')}</th><th>${t('tab.aktuell')}</th><th>P&amp;L</th><th>%</th><th></th></tr></thead>
          <tbody id="pBody"><tr><td colspan="7" class="c-t3">${t('pf.keineOffenen')}</td></tr></tbody>
        </table></div>
        <p class="hint">${t('pos.stopsBeimBroker')}</p>
      </div></div>

      <div class="card" data-panel="engineWhy"><div class="sect">${t('lay.engineWhyKopf')} ${iBtn('engineWhy')}</div><div class="cbody">
        <div id="whyAmpel" class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:6px"></div>
        <div id="whyGate"></div>
        <div id="whyExtra" class="hint" style="margin-top:6px"></div>
      </div></div>

      <div class="card" data-panel="champion"><div class="sect">${t('panel.champion')} ${iBtn('champion')}
        <span id="chStand" class="tn-tag" style="float:right"></span>
      </div><div class="cbody">
        <div id="chList" class="fl-tbl ch-tbl"><div class="hint">${t('ch.keiner')}</div></div>
        <div id="chNoTrade" class="hint"></div>
        <div id="chBasis" class="hint"></div>
        <div class="row" style="align-items:center;gap:8px;margin-top:6px">
          <button class="btn btn-n" id="chReport">${t('ch.berichtOeffnen')}</button>
          <span class="hint" id="chMsg"></span>
        </div>
      </div></div>

      <div class="card" data-panel="history"><div class="sect">${t('panel.historie')}
        <span id="jCount" style="float:right;color:var(--t3)">0</span></div><div class="cbody">
        <div class="row" style="gap:6px;margin-bottom:6px">
          <input id="jFilter" class="inp" placeholder="${t('jn.symbolFiltern')}" style="flex:1">
          <select id="jSide" class="inp" style="max-width:110px">
            <option value="">${t('jn.alle')}</option><option value="buy">${t('lay.nurKaeufe')}</option>
            <option value="sell">${t('lay.nurVerkaeufe')}</option><option value="closed">${t('lay.nurMitPnl')}</option>
          </select>
        </div>
        <div class="tw"><table class="tbl">
          <thead><tr><th>${t('tab.zeit')}</th><th>Sym</th><th>Side</th><th>Qty</th><th>${t('tab.preis')}</th><th>P&amp;L</th></tr></thead>
          <tbody id="jBody"><tr><td colspan="6" class="c-t3">${t('jn.keineTrades')}</td></tr></tbody>
        </table></div>
        <button class="btn btn-n" id="jMore" style="width:100%;margin-top:6px">${t('lay.aeltereLaden')}</button>
      </div></div>
    </div>

    <div class="col-r" id="rightCol">
      <div class="card" data-panel="performance"><div class="sect">${t('panel.performance')}</div><div class="cbody kpi">
        <label class="lbl">Cash</label><div id="vCash" class="vbig c-ac">--</div>
        <!-- Erklärt sich nur, wenn er gebraucht wird (negatives Cash beim
             Short-Buch) — renderPortfolio füllt und zeigt ihn. -->
        <p class="hint" id="vCashHint" hidden style="margin:-4px 0 6px"></p>
        <label class="lbl">Equity (live)</label><div id="vEq" class="vbig">--</div>
        <label class="lbl">${t('pf.gesamtPnl')} ${iBtn('gesamtPnl')}</label><div id="vPnl" class="vbig">--</div>
        <!-- Maßstab der Zahl: Nach einem Depot-Schnitt zählt Gesamt P&L erst
             AB dem Schnitt. renderPortfolio füllt. -->
        <p class="hint" id="vPnlBasis" hidden style="margin:-4px 0 6px"></p>
        <div class="row" style="gap:12px">
          <div><label class="lbl">${t('pf.realisiert')}</label><div id="vClosed" class="smv">--</div></div>
          <div><label class="lbl">${t('pf.offen')}</label><div id="vUnreal" class="smv">--</div></div>
          <div><label class="lbl">${t('pf.winRate')}</label><div id="vWR" class="smv">--%</div></div>
        </div>
        <label class="lbl" style="margin-top:10px">${t('pf.equityKurve')} ${iBtn('equityCurve')}</label>
        <div class="mkt-tabs" id="pfZeit" style="margin:2px 0 4px"></div>
        <svg id="pfSpark" class="pf-spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"></svg>
        <details id="pfDetail" style="margin-top:4px">
          <summary class="hint" style="cursor:pointer">${t('pf.grosseKurve')}</summary>
          <div id="pfCurveMeta" class="hint mono" style="margin-top:6px"></div>
          <svg id="pfCurve" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" style="display:block;width:100%;height:120px"></svg>
          <label class="lbl" style="margin-top:6px">Drawdown ${iBtn('drawdown')}</label>
          <svg id="pfDDCurve" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true" style="display:block;width:100%;height:54px"></svg>
        </details>
        <div class="pf-grid" id="pfGrid" hidden>
          <div><label class="lbl">Sharpe 30 ${iBtn('sharpe')}</label><div id="pfS30" class="smv mono">--</div></div>
          <div><label class="lbl">Sharpe 90</label><div id="pfS90" class="smv mono">--</div></div>
          <div><label class="lbl">${t('pf.maxDrawdown')} ${iBtn('maxdd')}</label><div id="pfDD" class="smv mono">--</div></div>
          <div><label class="lbl">${t('pf.hochwasser')} ${iBtn('hwm')}</label><div id="pfHwm" class="smv mono">--</div></div>
          <div><label class="lbl">${t('pf.profitFaktor')} ${iBtn('profitFactor')}</label><div id="pfPF" class="smv mono">--</div></div>
          <div><label class="lbl">${t('pf.erwartungTrade')} ${iBtn('expectancy')}</label><div id="pfExp" class="smv mono">--</div></div>
        </div>
        <!-- Maßstab der TRADE-Kennzahlen. Ohne ihn stehen „Profit-Faktor 1.56"
             und „Gesamt P&L −297,47 $" unbeschriftet nebeneinander und lesen
             sich als Widerspruch: Die eine Zahl zählt jeden Abschluss der
             Kontohistorie, die andere zählt das Konto erst ab der
             Kapitalbasis. renderPfStats füllt. -->
        <p class="hint" id="pfBasis" hidden style="margin:6px 0 0"></p>
        <div class="hint" id="pfHint">${t('pf.abSnapshot')}</div>
      </div></div>
    </div>
  </div>

  <!-- Optimierer-Bericht (Markdown als vorformatierter Text) -->
  <div class="dmodal" id="reportModal">
    <div class="dmodal-bg" data-close="report"></div>
    <div class="dsheet dsheet-wide">
      <button class="dclose" data-close="report">✕</button>
      <h3 id="reportTitle">${t('ch.bericht')}</h3>
      <p class="hint" id="reportMeta"></p>
      <pre id="reportBody" class="report-pre"></pre>
    </div>
  </div>

  <!-- Bestätigung für Resume (Drawdown) und Flatten -->
  <div class="dmodal" id="cmdModal">
    <div class="dmodal-bg" data-close="cmd"></div>
    <div class="dsheet" style="width:min(520px,100%)">
      <button class="dclose" data-close="cmd">✕</button>
      <h3 id="cmdTitle"></h3>
      <p class="hint" id="cmdText"></p>
      <label class="opt-check" id="cmdAckRow" hidden>
        <input type="checkbox" id="cmdAck" />
        <span id="cmdAckText"></span></label>
      <div class="fld" style="margin-top:8px"><label class="lbl" for="cmdReason">${t('cmd.grund')}</label>
        <input id="cmdReason" class="inp" maxlength="200" autocomplete="off" /></div>
      <p id="cmdErr" class="error" hidden></p>
      <div class="dbtns">
        <button class="dbtn pri" id="cmdGo"></button>
        <button class="dbtn" data-close="cmd">${t('cmd.abbrechen')}</button>
      </div>
    </div>
  </div>

  <div class="dmodal" id="optModal">
    <div class="dmodal-bg" data-close="options"></div>
    <div class="dsheet" style="width:min(560px,100%)">
      <button class="dclose" data-close="options">✕</button>
      <h3>${t('opt.titel')}</h3>
      <div class="otabs" id="owTabs">
        <button class="otab active" data-otab="anzeige">${t('opt.tabAnzeige')}</button>
        <button class="otab" data-otab="broker">${t('opt.tabBroker')}</button>
        <button class="otab" data-otab="konto">${t('opt.tabKonto')}</button>
      </div>
      <div data-opane="anzeige">
      <div class="wl-sec">${t('opt.darstellung')}</div>
      <label class="opt-row"><span>${t('opt.hellDunkel')}</span>
        <select id="ouTheme" class="inp" style="max-width:140px;margin-left:auto">
          <option value="system">${t('opt.themeSystem')}</option>
          <option value="light">${t('opt.themeHell')}</option>
          <option value="dark">${t('opt.themeDunkel')}</option>
        </select></label>
      <label class="opt-row"><span>${t('opt.sprache')}</span>
        <select id="ouLang" class="inp" style="max-width:140px;margin-left:auto">
          <!-- Sprachnamen werden NIE übersetzt — jede Sprache in ihrem
               eigenen Namen, sonst findet niemand aus der falschen heraus. -->
          <option value="de">Deutsch</option>
          <option value="en">English</option>
        </select></label>
      <div class="wl-sec">${t('opt.module')}</div>
      <p class="hint">${t('opt.klappHint')}</p>
      </div>
      <div data-opane="broker" hidden>
      <div class="wl-sec">${t('opt.echtgeldAnbindung')} ${iBtn('brokerStatus')}</div>
      <p class="hint">${t('opt.brokerHint')}</p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
        <input id="bkKey" class="inp" style="flex:1;min-width:150px" type="text"
          autocomplete="off" spellcheck="false" placeholder="API-Key (PK…)" />
        <input id="bkSec" class="inp" style="flex:1;min-width:150px" type="password"
          autocomplete="off" spellcheck="false" placeholder="Secret-Key" />
        <button class="btn btn-n" id="bkSave">${t('opt.verbinden')}</button>
      </div>
      <!-- Das Passwortfeld erscheint erst, wenn ein AK…-Schlüssel eingegeben
           wird — für Papierkonten wäre es Reibung ohne Schutzwirkung. -->
      <div id="bkLiveBox" hidden style="margin-top:6px">
        <p class="hint" style="border-left:3px solid var(--rd);padding-left:8px">
          ${t('opt.liveKeyWarnung')}</p>
        <p class="hint">${t('opt.reauthHint')}</p>
        <input id="bkPw" class="inp" style="width:100%;margin-top:4px" type="password"
          autocomplete="current-password" placeholder="${t('opt.pwPlatzhalter')}" />
      </div>
      <p class="hint">${t('opt.pkAkHint')}</p>
      <p class="hint">
        <a href="https://app.alpaca.markets/signup" target="_blank" rel="noopener noreferrer">${t('opt.linkKonto')}</a>
        &nbsp;·&nbsp;
        <a href="https://app.alpaca.markets/paper/dashboard/overview" target="_blank" rel="noopener noreferrer">${t('opt.linkKeys')}</a>
        &nbsp;·&nbsp;
        <a href="https://docs.alpaca.markets/docs/getting-started" target="_blank" rel="noopener noreferrer">${t('opt.linkDoku')}</a>
      </p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <button class="btn btn-n" id="bkGo">${t('opt.verbindungPruefen')}</button>
        <button class="btn btn-n" id="bkDel">${t('opt.trennen')}</button>
      </div>
      <div id="bkOut" style="margin-top:8px"></div>

      <!-- Echtgeld scharf stellen: direkt unter der Broker-Karte — ohne
           verbundenes Echtgeldkonto ist der Schalter gegenstandslos. Das
           Tipp-Wort ECHTGELD ist serverseitig gepinnt und bleibt in JEDER
           Sprache wörtlich. -->
      <div class="wl-sec" style="margin-top:14px">${t('opt.scharfStellen')}</div>
      <p class="hint">${t('opt.scharfHint')}</p>
      <p class="hint" id="lvState">—</p>
      <div id="lvKrit"></div>
      <div id="lvOn" hidden style="margin-top:8px">
        <p class="hint" style="border-left:3px solid var(--rd);padding-left:8px">
          ${t('opt.echtgeldWarnung')}</p>
        <p class="hint">${t('opt.echtgeldTippen')}</p>
        <div class="row" style="align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
          <input id="lvWord" class="inp" style="flex:1;min-width:120px" type="text"
            autocomplete="off" spellcheck="false" placeholder="ECHTGELD" />
          <input id="lvPw" class="inp" style="flex:1;min-width:120px" type="password"
            autocomplete="current-password" placeholder="${t('opt.pwKurz')}" />
        </div>
      </div>
      <div class="row" style="align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-n" id="lvGo">${t('opt.aufEchtgeld')}</button>
        <button class="btn btn-n" id="lvOff" hidden>${t('opt.zurueckPapier')}</button>
      </div>
      <div id="lvOut" style="margin-top:8px"></div>
      <p class="hint" style="margin-top:8px">
        ${t('opt.stoppWasPassiert')}</p>
      </div>
      <div data-opane="konto" hidden>
      <div class="wl-sec">${t('opt.konto')}</div>
      <div class="row" style="align-items:center;gap:10px">
        <span class="hint" style="flex:1">${t('opt.angemeldetAls')} <b>${email.replace(/[<>&]/g, '')}</b></span>
        <button class="btn btn-n" id="logoutBtn">${t('opt.abmelden')}</button>
      </div>
      <div class="wl-sec" style="margin-top:14px">${t('opt.steuerExport')} ${iBtn('taxReport')}</div>
      <p class="hint">${t('opt.steuerHint')}</p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <select id="txYear" class="inp st-num" style="max-width:110px"></select>
        <label class="hint" style="display:flex;align-items:center;gap:5px">
          <input type="checkbox" id="txReal" /> ${t('opt.nurEchtgeld')}
        </label>
        <button class="btn btn-n" id="txGo">${t('opt.berichtErstellen')}</button>
      </div>
      <div id="txOut" style="margin-top:8px"></div>
      <div class="wl-sec" style="margin-top:14px">${t('opt.neuAnfangen')} ${iBtn('resetWallet')}</div>
      <p class="hint">${t('opt.resetHint')}</p>
      <div class="row" style="align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
        <input id="rsWord" class="inp st-num" style="flex:1;min-width:150px;max-width:220px"
          type="text" autocomplete="off" spellcheck="false" placeholder="${t('opt.resetTippen')}" />
        <button class="btn btn-r" id="rsGo" disabled>${t('opt.kontoZuruecksetzen')}</button>
      </div>
      <!-- Das Tipp-Wort RESET ist serverseitig gepinnt (RESET_CONFIRM_WORD)
           und bleibt in JEDER Sprache wörtlich. -->
      <div class="row" style="align-items:center;gap:8px;margin-top:6px">
        <label class="hint" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="rsFromBroker" />
          ${t('opt.startVomBroker')}
        </label>
      </div>
      <div class="hint" id="rsMsg"></div>
      </div>
    </div>
  </div>
`;
}

/** Muss identisch zu RESET_CONFIRM_WORD im Server sein — der prüft es erneut. */
const RESET_CONFIRM_WORD = 'RESET';

/** Muss identisch zu DELETE_CONFIRM_WORD im Server sein — der prüft es erneut. */
const DELETE_CONFIRM_WORD = 'LOESCHEN';

/** HTML-Escaping für Text, der aus einer Antwort des Servers stammt. */
function escText(s: string): string {
  return esc(s);
}


/* ── Broker-Status & Steuerbericht (Optionen) ───────────────────────── */

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
           <thead><tr><th>${t('br.abwSymbol')}</th><th class="num">${t('br.abwEigenes')}</th>
             <th class="num">${t('br.abwBroker')}</th><th class="num">${t('br.abwDifferenz')}</th></tr></thead>
           <tbody>${r.abweichungen
             .map(
               (a) => `<tr><td data-sym="${e(a.symbol)}">${e(a.symbol)}</td><td class="num">${a.eigeneMenge}</td>
                 <td class="num">${a.brokerMenge}</td>
                 <td class="num dn"><b>${a.differenz > 0 ? '+' : ''}${a.differenz}</b></td></tr>`,
             )
             .join('')}</tbody></table>
         <p class="hint">${t('br.abwHinweis')}</p>`
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
      ? `<p class="hint">${t('br.jeTrade')} <b>${r.kante.bruttoPct?.toFixed(3)} %</b> ${t('br.brutto')}
         <b>${r.kante.kostenPct?.toFixed(3)} %</b> ${t('br.kosten')}
         <b class="${r.kante.nettoPct >= 0 ? 'up' : 'dn'}">${r.kante.nettoPct.toFixed(3)} %</b> ${t('br.netto')}
         ${t('br.deckung')} <b>${r.kante.deckung?.toFixed(2)}×</b>${
           (r.kante.deckung ?? 0) < 1 ? t('br.defizitaer') : '.'
         }</p>`
      : '';

  return `
    <div class="hint" style="margin-bottom:6px"><b>${
      r.modus === 'live' ? t('br.echtgeld') : t('br.papierhandel')
    }</b> — ${e(r.meldung)}</div>
    <div class="hint">
      ${ampel(r.schluesselVorhanden)} ${t('br.schluessel')} ·
      ${ampel(r.wunschLive)} ${t('br.strategieLive')} ·
      ${ampel(r.envFreigabe)} ${t('br.envFreigabe')} ·
      ${ampel(r.reife.bereit)} ${t('br.liveReife')} (${r.reife.erfuellt}/${r.reife.gesamt})
    </div>
    <table class="tbl st-num" style="width:100%;margin-top:6px">
      <thead><tr><th>${t('br.kriterium')}</th><th class="num">${t('br.ist')}</th><th class="num">${t('br.soll')}</th></tr></thead>
      <tbody>${reifeListe}</tbody>
    </table>
    ${kante}
    ${
      k
        ? `<table class="tbl st-num" style="width:100%;margin-top:6px"><tbody>
             <tr><td>${t('br.kontostatus')}</td><td class="num">${e(k.status)}</td></tr>
             <tr><td>${t('br.barbestand')}</td><td class="num">${k.cash.toFixed(2)} ${e(k.currency)}</td></tr>
             <tr><td>${t('br.depotwert')}</td><td class="num">${k.equity.toFixed(2)} ${e(k.currency)}</td></tr>
             <tr><td>${t('br.kaufkraft')}</td><td class="num">${k.buyingPower.toFixed(2)} ${e(k.currency)}</td></tr>
           </tbody></table>`
        : ''
    }
    ${abw}
    ${r.fehler ? `<p class="hint">${e(r.fehler)}</p>` : ''}`;
}

/** Klarnamen der Steuertöpfe — die Kürzel sagen einem Menschen nichts. */
const TOPF_LABEL: Record<string, string> = {
  aktien: t('tax.topfAktien'),
  sonstige: t('tax.topfSonstige'),
  termin: t('tax.topfTermin'),
  privat: t('tax.topfPrivat'),
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
  if (!b.echtgeld) hinweise.push(`<b>${t('tax.papierTitel')}</b> ${t('tax.papierText')}`);
  if (b.privatSteuerfrei !== 0) hinweise.push(`<b>${geld(b.privatSteuerfrei)}</b> ${t('tax.steuerfreiText')}`);
  if (b.privatUnterFreigrenze) {
    hinweise.push(
      `${t('tax.freigrenzeA')} ${geld(b.privatSteuerpflichtig)} ${t('tax.freigrenzeB')} `
        + `${b.rechtsstand.privatFreigrenze} € ${t('tax.freigrenzeC')}`,
    );
  }
  if (r.historieUnvollstaendig) hinweise.push(`<b>${t('tax.histTitel')}</b> ${t('tax.histText')}`);
  if (b.unpaarbar.length > 0) hinweise.push(`${b.unpaarbar.length} ${t('tax.unpaarbar')}`);
  if (b.fxLuecken > 0) {
    hinweise.push(
      `<b>${b.fxLuecken} ${t('tax.fxLuecken')}</b> ${t('tax.fxText1')} `
        + `<button class="btn btn-n" id="txFx" style="vertical-align:middle">${t('tax.fxNachtragen')}</button> `
        + t('tax.fxText2'),
    );
  } else if (b.veraeusserungen.length > 0) {
    hinweise.push(t('tax.fxOk'));
  }

  const offen = b.offen.length;
  const fristBald = b.offen.filter(
    (o) => typeof o.tageBisJahresfrist === 'number' && o.tageBisJahresfrist > 0,
  );

  return `
    <table class="tbl st-num" style="width:100%">
      <thead><tr><th>${t('tax.spTopf')}</th><th class="num">${t('tax.spFaelle')}</th><th class="num">${t('tax.spGewinne')}</th>
        <th class="num">${t('tax.spVerluste')}</th><th class="num">${t('tax.spSaldo')}</th><th class="num">${t('tax.spSaldoEur')}</th></tr></thead>
      <tbody>${zeilen || `<tr><td colspan="6" class="hint">${t('tax.keineVeraeusserungen')}</td></tr>`}</tbody>
    </table>
    <p class="hint" style="margin-top:6px">${t('tax.toepfeEinzeln')}</p>
    ${hinweise.map((h) => `<p class="hint">${h}</p>`).join('')}
    ${
      offen > 0
        ? `<p class="hint">${offen} ${offen === 1 ? t('tax.offen1') : t('tax.offenMehr')} ${t('tax.offenText')}${
             fristBald.length > 0
               ? ` ${t('tax.fristA')} ${fristBald.length} ${t('tax.fristB')}
                   ${Math.min(...fristBald.map((o) => o.tageBisJahresfrist ?? 0))} ${t('tax.fristC')}`
               : ''
           }</p>`
        : ''
    }
    <div class="row" style="gap:8px;margin-top:8px;align-items:center">
      <a class="btn btn-n" id="txCsv" href="#" download>${t('tax.csv')}</a>
      <span class="hint">${r.gelesen} ${t('tax.gepruefte')} · ${b.veraeusserungen.length} ${t('tax.veraeusserungen')}</span>
    </div>
    <p class="hint" style="margin-top:6px">${e(b.rechtsstandHinweis)}</p>
    <p class="hint"><b>${t('tax.keineBeratung')}</b> ${t('tax.keineBeratungText')}</p>`;
}

/* ── Echtgeld-Schalter (Optionen → Broker) ──────────────────────────── */

/** Fazit der Live-Reife in der Sprache des Nutzers — der gespeicherte
 *  deutsche Satz bleibt als Rückfallebene für alte Befunde. */
function reifeFazit(r: {
  bereit: boolean;
  erfuellt: number;
  gesamt: number;
  offeneCodes?: string[];
  fazit: string;
}): string {
  if (!r.offeneCodes) return r.fazit;
  if (r.bereit) return t('lv.reifeBereit');
  const offen = r.offeneCodes.map((c) => t(`lv.krit.${c}` as never)).join(', ');
  return `${t('lv.reifeNochNicht')} (${r.erfuellt}/${r.gesamt}): ${offen}.`;
}

/**
 * Die drei Guards des Echtgeld-Handels anzeigen.
 *
 * Alle drei stehen zusammen in einer Liste, weil die Frage, die hier
 * beantwortet werden muss, immer dieselbe ist: „Warum handelt es noch nicht
 * mit echtem Geld?" — die Antwort ist „eine Bedingung fehlt noch", nicht „kaputt".
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
    state.innerHTML = `<b style="color:var(--rd)">${t('lv.scharf')}</b> ` + t('lv.scharfWann');
    krit.innerHTML = '';
    return;
  }
  if (!s) {
    state.textContent = t('lv.laedt');
    return;
  }

  const zeile = (name: string, ok: boolean, text: string): string =>
    `<div class="hint" style="margin-top:4px"><b style="color:${
      ok ? 'var(--gn)' : 'var(--t3)'
    }">${ok ? '✓' : '○'}</b> <b>${escText(name)}</b> — ${escText(text)}</div>`;

  const kontoOk = s.brokerArt === 'live';
  krit.innerHTML =
    zeile(
      t('lv.kontoVerbunden'),
      kontoOk,
      s.brokerArt === null ? t('lv.keinBroker') : s.brokerArt === 'paper' ? t('lv.papierkonto') : t('lv.schluesselOk'),
    )
    + zeile(t('lv.serverFreigabe'), s.serverFreigabe, s.serverFreigabe ? t('lv.freigabeAn') : t('lv.freigabeAus'))
    + zeile(`${t('lv.reife')} (${s.reife.erfuellt}/${s.reife.gesamt})`, s.reife.bereit, reifeFazit(s.reife))
    + s.reife.kriterien
        .map(
          (k) =>
            `<div class="hint" style="margin-left:16px;opacity:.8">${
              k.erfuellt ? '✓' : '○'
            } ${escText(k.name)}: ${escText(k.ist)} (${t('lv.noetig')} ${escText(k.soll)})</div>`,
        )
        .join('');

  const alles = kontoOk && s.serverFreigabe && s.reife.bereit;
  state.innerHTML = alles
    ? `<b>${t('lv.alleErfuellt')}</b> ${t('lv.schalterScharf')}`
    : `<b>${t('lv.nochNicht')}</b> ${t('lv.offenePunkte')}`;
  // Der Knopf bleibt klickbar, auch wenn etwas fehlt: Die Server-Antwort
  // nennt dann den Grund. Ein ausgegrauter Knopf ohne Begründung ist die
  // schlechtere Auskunft.
  on.hidden = !alles;
}

/* ── Engine-Karte: Schalter, Status, Kommandos ──────────────────────── */

function renderEngineBadge(running: boolean): void {
  const b = $('engBadge');
  b.textContent = running ? t('nav.engineAn') : t('nav.engineAus');
  b.className = `badge ${running ? 'b-on' : 'b-off'}`;
  // Von zwei Knöpfen ist immer genau einer sinnlos — sichtbar ist nur die
  // mögliche Aktion; der Zustand steht ohnehin im Badge daneben.
  ($('engStart') as HTMLButtonElement).hidden = running;
  ($('engStop') as HTMLButtonElement).hidden = !running;
}

/** Klartext je Halt-Grund (`HaltReason` in src/core/types.ts) — die Kürzel sind der Vertrag zum Kern. */
const HALT_TEXT: Record<string, string> = {
  daily_loss: t('halt.dailyLoss'),
  drawdown: t('halt.drawdown'),
  manual: t('halt.manual'),
  errors: t('halt.errors'),
  reconcile: t('halt.reconcile'),
};

/** Drawdown in Prozent zum Peak — die Zahl, an der die Sperre hängt. */
function drawdownPct(e: EngineMirror): number | null {
  if (e.equity === null || e.peakEquity === null || !(e.peakEquity > 0)) return null;
  return ((e.peakEquity - e.equity) / e.peakEquity) * 100;
}

/** Tagesergebnis in Prozent zur Tagesstart-Equity — die Zahl, an der die Notbremse hängt. */
function tagesPct(e: EngineMirror): number | null {
  if (e.equity === null || e.dayStartEquity === null || !(e.dayStartEquity > 0)) return null;
  return ((e.equity - e.dayStartEquity) / e.dayStartEquity) * 100;
}

/** Status-Zeile: Beschriftung links, Wert rechts (mono). */
function statusZeile(label: string, wert: string, farbe = ''): string {
  return `<div class="eng-row"><span class="hint">${label}</span><span class="mono"${
    farbe ? ` style="color:${farbe}"` : ''
  }>${wert}</span></div>`;
}

/**
 * Der Spiegel des letzten Takts. Er ist Anzeige, nie Wahrheit — deshalb
 * steht das Alter des letzten Takts immer dabei: Ein Stand von gestern
 * sieht sonst aus wie ein Stand von jetzt.
 */
function renderEngineStatus(): void {
  if (!st) return;
  const box = $('engStatus');
  const e = st.engine;
  const running = st.strategy.engine.running === true;
  if (!e) {
    box.innerHTML = `<div class="hint">${running ? t('eng.keinTaktNoch') : t('eng.keinTakt')}</div>`;
    return;
  }
  const zeilen: string[] = [];
  zeilen.push(statusZeile(t('eng.modus'), e.mode === 'live' ? t('br.echtgeld') : t('br.papierhandel'), e.mode === 'live' ? 'var(--rd)' : ''));
  const h = e.halt;
  if (h?.halted) {
    const grund = HALT_TEXT[h.reason ?? ''] ?? (h.reason ?? '?');
    const bis = h.until ? ` · ${t('eng.bis')} ${escText(h.until)}` : '';
    zeilen.push(statusZeile(t('eng.zustand'), `${t('eng.gesperrt')}: ${escText(grund)}${bis}`, 'var(--rd)'));
    if (h.note) zeilen.push(`<div class="hint eng-note">${escText(h.note)}</div>`);
  } else {
    zeilen.push(statusZeile(t('eng.zustand'), t('eng.frei'), 'var(--gn)'));
  }
  // Der Kern kann Einstiege auch OHNE Halt sperren (Datenalter, PDT,
  // Positionslimit, Abgleich) — Exits laufen weiter. Das steht hier
  // deutlich, sonst sähe „frei" aus wie „handelt".
  if (e.entryLock) {
    zeilen.push(statusZeile(t('ew.einstiegeGesperrt'), escText(e.entryLock), 'var(--yl,#d9a441)'));
  }
  zeilen.push(statusZeile('Equity', money(e.equity)));
  zeilen.push(statusZeile('Cash', money(e.cash)));
  const tp = tagesPct(e);
  zeilen.push(
    statusZeile(
      t('eng.tagesstart'),
      `${money(e.dayStartEquity)}${tp === null ? '' : ` (${fmtPct(tp)})`}`,
      tp === null ? '' : tp >= 0 ? 'var(--gn)' : 'var(--rd)',
    ),
  );
  const dd = drawdownPct(e);
  zeilen.push(
    statusZeile(
      t('eng.peak'),
      `${money(e.peakEquity)}${dd === null ? '' : ` (${t('eng.drawdown')} ${dd.toFixed(2)} %)`}`,
      dd !== null && dd > 0 ? 'var(--rd)' : '',
    ),
  );
  zeilen.push(
    statusZeile(
      t('eng.dayTrades'),
      `${e.dayTradeCount ?? '--'}${e.localDayTrades ? ` (+${e.localDayTrades})` : ''}${e.patternDayTrader ? ' · PDT' : ''}`,
      e.patternDayTrader ? 'var(--yl,#d9a441)' : '',
    ),
  );
  zeilen.push(statusZeile(t('eng.positionen'), e.positions.length > 0 ? escText(e.positions.join(', ')) : '—'));
  if (e.pendingEntries.length + e.pendingExits.length > 0) {
    zeilen.push(statusZeile(t('eng.offeneOrders'), escText([...e.pendingEntries, ...e.pendingExits].join(', '))));
  }
  if (e.deferred.length > 0) {
    zeilen.push(statusZeile(t('eng.zurueckgestellt'), escText(e.deferred.join(', ')), 'var(--yl,#d9a441)'));
  }
  const alter = alterMin(e.lastTickAt);
  zeilen.push(
    statusZeile(
      t('eng.letzterTakt'),
      `${wann(e.lastTickAt)}${alter === null ? '' : ` (${t('eng.vor')} ${Math.round(alter)} min)`}`,
      alter !== null && alter > 15 && running ? 'var(--yl,#d9a441)' : '',
    ),
  );
  if (e.lastError) zeilen.push(statusZeile(t('eng.fehler'), escText(e.lastError), 'var(--rd)'));
  if (e.consecutiveErrors > 0) zeilen.push(statusZeile(t('eng.fehlerFolge'), String(e.consecutiveErrors), 'var(--rd)'));
  if (e.champion) {
    zeilen.push(
      statusZeile(
        t('eng.champion'),
        e.champion.symbols.length > 0
          ? `${escText(e.champion.symbols.join(', '))} (${escText(e.champion.source)})`
          : t('eng.keinChampion'),
        e.champion.symbols.length > 0 ? '' : 'var(--yl,#d9a441)',
      ),
    );
    if (e.champion.basis.length > 0) zeilen.push(statusZeile(t('eng.basis'), escText(e.champion.basis.join(', '))));
  }
  for (const n of e.notes) zeilen.push(`<div class="hint eng-note">${escText(n)}</div>`);
  if (e.commandAt) zeilen.push(`<div class="hint eng-note">${t('eng.kommandoWartet')} (${wann(e.commandAt)})</div>`);
  box.innerHTML = zeilen.join('');
}

/** Knöpfe der Kommandos: nur das Mögliche ist klickbar; der Grund steht im title. */
function renderEngineCommands(): void {
  if (!st) return;
  const h = st.engine?.halt ?? null;
  const running = st.strategy.engine.running === true;
  const halt = $('engHalt') as HTMLButtonElement;
  const resume = $('engResume') as HTMLButtonElement;
  const flatten = $('engFlatten') as HTMLButtonElement;
  halt.disabled = !running || h?.halted === true;
  halt.title = h?.halted ? t('cmd.bereitsGesperrt') : t('cmd.haltTitel');
  resume.disabled = !running || h?.halted !== true || h.reason === 'daily_loss';
  resume.title =
    h?.halted !== true
      ? t('cmd.keinHalt')
      : h.reason === 'daily_loss'
        ? t('cmd.tagesHaltEndet')
        : t('cmd.resumeTitel');
  flatten.disabled = !running;
  flatten.title = t('cmd.flattenTitel');
}

/** Offene Kommando-Bestätigung (resume/flatten) — null, wenn keine. */
let cmdOffen: EngineCommandAction | null = null;

function zeigeCmdModal(action: 'resume' | 'flatten'): void {
  if (!st) return;
  cmdOffen = action;
  const drawdown = action === 'resume' && st.engine?.halt?.reason === 'drawdown';
  $('cmdTitle').textContent = action === 'resume' ? t('cmd.resumeFrage') : t('cmd.flattenFrage');
  $('cmdText').textContent = action === 'resume' ? t('cmd.resumeText') : t('cmd.flattenText');
  const ackRow = $('cmdAckRow');
  ackRow.hidden = !drawdown;
  ($('cmdAck') as HTMLInputElement).checked = false;
  if (drawdown) {
    const dd = st.engine ? drawdownPct(st.engine) : null;
    $('cmdAckText').textContent = `${t('cmd.ackDrawdown')}${dd === null ? '' : ` (${dd.toFixed(2)} %)`}`;
  }
  ($('cmdReason') as HTMLInputElement).value = '';
  $('cmdErr').hidden = true;
  $('cmdGo').textContent = action === 'resume' ? t('eng.resume') : t('eng.flatten');
  $('cmdModal').classList.add('show');
}

/** Kommando absetzen — die Antwort ist „hinterlegt", nicht „ausgeführt". */
async function sendeKommando(action: EngineCommandAction, reason: string, ackDrawdown: boolean): Promise<void> {
  const msg = $('engCmdMsg');
  msg.textContent = t('cmd.sende');
  try {
    const r = await engineCommand({
      action,
      ...(reason ? { reason } : {}),
      ...(ackDrawdown ? { ackDrawdown: true } : {}),
    });
    msg.textContent = `✓ ${t('cmd.hinterlegt')} (${wann(r.at)}) — ${t('cmd.wirktNaechsterTakt')}`;
  } catch (e) {
    msg.textContent = serverText(e);
  }
}

/** Engine-Schalter — schreibt `settings.strategy.engine.running` über saveStrategy. */
async function setEngineRunning(on: boolean): Promise<void> {
  const msg = $('engMsg');
  msg.hidden = false;
  msg.textContent = t('mt.speichere');
  try {
    await saveStrategy({ engineRunning: on });
    msg.textContent = on ? t('mt.engineFlagAn') : t('mt.engineFlagAus');
  } catch (e) {
    msg.textContent = serverText(e);
  }
}

/* ── Faden zum Betreiber, Zugangs-Hinweis ───────────────────────────── */

function renderFaden(nachrichten: readonly FadenNachricht[]): void {
  const box = document.getElementById('fadenListe');
  if (!box) return;
  box.innerHTML = '';
  for (const n of nachrichten) {
    const zeile = document.createElement('div');
    zeile.className = `faden-zeile faden-${n.von}`;
    const wer = document.createElement('span');
    wer.className = 'faden-wer';
    wer.textContent = n.von === 'admin' ? t('fd.vomBetreiber') : t('fd.vonDir');
    const wannEl = document.createElement('span');
    wannEl.className = 'faden-wann mono';
    wannEl.textContent = n.at.slice(0, 16).replace('T', ' ');
    const text = document.createElement('div');
    // textContent, nicht innerHTML: Der Inhalt kommt von Menschen.
    text.textContent = n.text;
    zeile.append(wer, wannEl, text);
    box.append(zeile);
  }
  box.scrollTop = box.scrollHeight;
}

/** Faden laden und zeichnen; Fehler bleiben still, das ist Beiwerk. */
function ladeFaden(): void {
  void nachrichtenLesen()
    .then(renderFaden)
    .catch(() => undefined);
}

/** Freischaltungs-Hinweis: Ein Schalter, der nichts bewirkt, muss es sagen. */
function renderAccessNote(): void {
  if (!st) return;
  const el = $('accessNote');
  if (st.accessLevel === 'pending') {
    el.textContent = t('acc.pendingA') + t('acc.pendingB');
    el.hidden = false;
  } else if (st.accessLevel === 'blocked' || st.accessLevel === 'archiviert') {
    el.textContent = t('acc.blocked');
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ── „Warum handelt die Engine (nicht)?" ────────────────────────────── */

function whyChip(text: string, farbe: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'hint mono';
  el.style.cssText = `padding:2px 8px;border-radius:999px;border:1px solid ${farbe};color:${farbe}`;
  el.textContent = text;
  return el;
}

/** Ab wie vielen Minuten ohne Herzschlag der Takt als stehend gilt (er feuert jede Minute). */
const HERZSCHLAG_MAX_MIN = 10;

/**
 * Antwort aus dem Nutzer-Spiegel und dem Plattform-Herzschlag. Die
 * Reihenfolge ist die Rangfolge der Aussagekraft: Wer wissen will, warum
 * nichts passiert, findet oben den wahrscheinlichsten Grund.
 */
function renderEngineWhy(): void {
  if (!st) return;
  const ampel = $('whyAmpel');
  const gate = $('whyGate');
  const extra = $('whyExtra');
  ampel.innerHTML = '';
  gate.innerHTML = '';
  const gruende: string[] = [];
  const running = st.strategy.engine.running === true;
  const e = st.engine;
  const h = st.health;

  // Zeile 1: Plattform — steht der Takt überhaupt?
  const herz = alterMin(h?.lastRunAt);
  if (!h) ampel.append(whyChip(t('ew.keineScanDaten'), 'var(--t3)'));
  else if (herz === null || herz > HERZSCHLAG_MAX_MIN) {
    ampel.append(whyChip(`⚠ ${t('ew.taktSteht')} ${herz === null ? '' : `${Math.round(herz)} min`}`, 'var(--rd)'));
    gruende.push(t('ew.g.taktSteht'));
  } else if (h.engine?.skipped === 'market_closed') {
    ampel.append(whyChip(`${t('ew.marktZu')}${h.engine.nextOpen ? ` · ${t('ew.oeffnet')} ${wann(h.engine.nextOpen)}` : ''}`, 'var(--t3)'));
    gruende.push(t('ew.g.marktZu'));
  } else if (h.engine?.error) {
    ampel.append(whyChip(`⚠ ${t('ew.plattformFehler')}`, 'var(--rd)'));
    gruende.push(`${t('ew.g.plattformFehler')} ${h.engine.error}`);
  } else {
    ampel.append(whyChip(`${t('ew.taktLaeuft')} · ${wann(h.lastRunAt)}`, 'var(--gn)'));
  }
  if (h?.alarm?.aktiv) ampel.append(whyChip(`⚠ ${h.alarm.text ?? t('ew.waechterAlarm')}`, 'var(--rd)'));

  // Zeile 2: das eigene Konto.
  if (!running) {
    ampel.append(whyChip(t('nav.engineAus'), 'var(--rd)'));
    gruende.push(t('ew.g.engineAus'));
  }
  if (st.accessLevel !== 'approved') {
    ampel.append(whyChip(t('ew.keinZugang'), 'var(--yl,#d9a441)'));
    gruende.push(st.accessLevel === 'pending' ? t('ew.g.pending') : t('ew.g.gesperrt'));
  }
  if (running && !e) {
    gruende.push(t('ew.g.keinTakt'));
  }
  if (e) {
    if (e.halt?.halted) {
      const grund = HALT_TEXT[e.halt.reason ?? ''] ?? (e.halt.reason ?? '?');
      ampel.append(whyChip(`${t('eng.gesperrt')}: ${grund}`, 'var(--rd)'));
      gruende.push(
        e.halt.reason === 'daily_loss'
          ? t('ew.g.haltTag')
          : e.halt.reason === 'drawdown'
            ? t('ew.g.haltDrawdown')
            : e.halt.reason === 'manual'
              ? t('ew.g.haltManual')
              : e.halt.reason === 'reconcile'
                ? t('ew.g.haltReconcile')
                : t('ew.g.haltErrors'),
      );
      // Die Notiz nennt das KONKRETE: welche Symbole der Fremdbestand betrifft,
      // welcher Fehler die Sperre ausgelöst hat. Ohne sie steht dort nur, DASS
      // etwas abweicht — und niemand kann die Ursache beheben. Eine Sperre soll
      // über die Ursache enden, nie per Override (CLAUDE.md §0.5).
      if (e.halt.note) gruende.push(e.halt.note);
    }
    if (e.entryLock) {
      ampel.append(whyChip(`${t('ew.einstiegeGesperrt')}: ${e.entryLock}`, 'var(--yl,#d9a441)'));
      gruende.push(`${t('ew.g.einstiegeGesperrt')} ${e.entryLock}`);
    }
    if (e.lastError) {
      ampel.append(whyChip(`⚠ ${t('eng.fehler')}`, 'var(--rd)'));
      gruende.push(`${t('ew.g.fehler')} ${e.lastError}`);
    }
    if (e.champion && e.champion.symbols.length === 0) {
      ampel.append(whyChip(t('eng.keinChampion'), 'var(--yl,#d9a441)'));
      gruende.push(t('ew.g.keinChampion'));
    }
    if (e.deferred.length > 0) {
      ampel.append(whyChip(`${e.deferred.length} ${t('ew.zurueckgestellt')}`, 'var(--yl,#d9a441)'));
      gruende.push(t('ew.g.zurueckgestellt'));
    }
    if (e.positions.length >= st.auto.maxPositions) {
      ampel.append(whyChip(`${e.positions.length}/${st.auto.maxPositions} ${t('ew.positionenVoll')}`, 'var(--t3)'));
      gruende.push(t('ew.g.posLimit'));
    }
    if (st.auto.riskPerTradePct <= 0) gruende.push(t('ew.g.risikoNull'));
    // Notizen des Takts (Champion fehlt, Zeitrahmen weicht ab, …) — Klartext vom Kern, nicht übersetzt.
    for (const n of e.notes) gruende.push(n);
    if (e.patternDayTrader) gruende.push(t('ew.g.pdt'));
    if (running && !e.halt?.halted && !e.lastError && gruende.length === 0) {
      ampel.append(whyChip(t('ew.handeltFrei'), 'var(--gn)'));
    }
  }
  if (gruende.length === 0) {
    gate.innerHTML = `<div class="hint">${t('ew.nichtsBlockiert')}</div>`;
  } else {
    const ul = document.createElement('ul');
    ul.className = 'warum-liste';
    for (const g of gruende) {
      const li = document.createElement('li');
      li.textContent = g;
      ul.append(li);
    }
    gate.append(ul);
  }

  // Zeile 3: Plattform-Zahlen des letzten Takts.
  const teile: string[] = [];
  const pe = h?.engine;
  if (pe) {
    if (typeof pe.users === 'number') teile.push(`${pe.ok ?? 0}/${pe.users} ${t('ew.kontenOk')}`);
    if (typeof pe.symbols === 'number') teile.push(`${pe.symbols} ${t('ew.symbole')}`);
    if (typeof pe.champion === 'number') teile.push(`${pe.champion} ${t('ew.mitChampion')}`);
    if (pe.fetchOk === false) teile.push(t('ew.barsFehlten'));
    if (typeof pe.durationMs === 'number') teile.push(`${(pe.durationMs / 1000).toFixed(1)} s`);
  }
  extra.textContent = teile.join(' · ');
}

/* ── Champion-Karte (meta/champion) ─────────────────────────────────── */

function renderChampion(): void {
  if (!st) return;
  const c = st.champion;
  const list = $('chList');
  const stand = $('chStand');
  const noTrade = $('chNoTrade');
  if (!c) {
    list.innerHTML = `<div class="hint">${t('ch.keiner')}</div>`;
    stand.textContent = '';
    noTrade.textContent = '';
    $('chBasis').textContent = '';
    return;
  }
  stand.textContent = c.updatedAt ? `${t('ch.stand')} ${wann(new Date(c.updatedAt).toISOString())}` : '';
  const gewaehlt = st.autoSymbols === null ? null : new Set(st.autoSymbols);
  const zeilen = Object.entries(c.symbols).sort(([a], [b]) => a.localeCompare(b));
  if (zeilen.length === 0) {
    list.innerHTML = `<div class="hint">${t('ch.leer')}</div>`;
  } else {
    const kopf = `<div class="ch-row fl-head"><span>Symbol</span><span>${t('ch.strategie')}</span><span>Score</span><span>${t('ch.trades')}</span><span>${t('ch.netto')}</span><span>${t('ch.folds')}</span></div>`;
    list.innerHTML =
      kopf
      + zeilen
        .map(([sym, e]) => {
          const inaktiv = gewaehlt !== null && !gewaehlt.has(sym);
          const netto = e.oos.netProfit;
          const folds = e.oos.positiveFoldShare;
          return `<div class="ch-row${inaktiv ? ' ch-aus' : ''}" title="${inaktiv ? t('ch.nichtGewaehlt') : ''}">
            <span data-sym="${escText(sym)}"><b>${escText(sym)}</b></span>
            <span>${escText(e.strategy)}${e.timeframe ? ` · ${e.timeframe}m` : ''}</span>
            <span>${e.score === null ? '--' : e.score.toFixed(2)}</span>
            <span>${e.oos.trades ?? '--'}</span>
            <span class="${netto === null ? '' : pnlClass(netto)}">${netto === null ? '--' : money(netto)}</span>
            <span>${folds === null ? '--' : `${Math.round(folds * 100)} %`}</span>
          </div>`;
        })
        .join('');
  }
  const nt = Object.entries(c.noTrade).sort(([a], [b]) => a.localeCompare(b));
  noTrade.innerHTML =
    nt.length === 0
      ? ''
      : `<b>${t('ch.noTrade')}:</b> `
        + nt.map(([sym, e]) => `<span title="${escText(e.reason)}">${escText(sym)}</span>`).join(', ')
        + `<br>${t('ch.noTradeHint')}`;
  renderChampionBasis();
}

/** Die Basis-Stufe unter der Champion-Tabelle: bestanden oder nicht, Korb, Position je Symbol. */
function renderChampionBasis(): void {
  if (!st) return;
  const el = $('chBasis');
  const b = st.champion?.basis ?? null;
  if (!b) {
    el.innerHTML = st.champion ? `<b>${t('ch.basis')}:</b> ${t('ch.basisKeine')}` : '';
    return;
  }
  const gerissen = b.gates.filter((g) => !g.pass).map((g) => g.name);
  const urteil = b.pass
    ? `<span class="stag t-buy">${t('ch.basisBestanden')}</span>`
    : `<span class="stag t-sell" title="${escText(gerissen.join(', '))}">${t('ch.basisNichtBestanden')}</span>`;
  const position = b.positionPct === null ? t('ch.basisOhnePosition') : `${t('ch.basisPosition')} ${b.positionPct} %`;
  el.innerHTML =
    `<b>${t('ch.basis')}:</b> ${escText(b.label)} (${escText(b.strategy)}${b.timeframe ? ` · ${b.timeframe}m` : ''}) ${urteil} · `
    + `<span class="mono">${b.symbols.map(escText).join(', ')}</span> · ${escText(position)}`
    + `<br>${t('ch.basisHint')}`;
}

/** Jüngsten Optimierer-Bericht laden und als vorformatierten Text zeigen. */
async function openReport(): Promise<void> {
  const msg = $('chMsg');
  msg.textContent = t('ch.laedtBericht');
  try {
    const r = await loadOptimizeReport();
    msg.textContent = '';
    if (!r) {
      msg.textContent = t('ch.keinBericht');
      return;
    }
    $('reportTitle').textContent = `${t('ch.bericht')} ${r.date}`;
    $('reportMeta').textContent = r.truncated ? t('ch.berichtGekuerzt') : '';
    // textContent: Markdown als Text, kein Renderer — nichts aus dem Bericht wird als HTML gedeutet.
    $('reportBody').textContent = r.markdown || t('ch.berichtLeer');
    $('reportModal').classList.add('show');
  } catch (e) {
    msg.textContent = serverText(e);
  }
}


/* ── Einstellungen des Auto-Traders (settings.auto) ────────────────── */

/** Formular aus dem gespeicherten Stand füllen — nie aus einem optimistischen. */
function fillAutoForm(): void {
  if (!st) return;
  const a = st.auto;
  ($('asRisk') as HTMLInputElement).value = String(a.riskPerTradePct);
  ($('asMaxPct') as HTMLInputElement).value = String(a.maxPositionPct);
  ($('asMaxN') as HTMLInputElement).value = String(a.maxPositions);
  ($('asDaily') as HTMLInputElement).value = String(a.maxDailyLossPct);
  ($('asDd') as HTMLInputElement).value = String(a.maxDrawdownPct);
  ($('asShort') as HTMLInputElement).checked = a.allowShort === true;
  ($('asTelegram') as HTMLInputElement).checked = a.notifyTelegram === true;
  // Fehlend heißt an (Voreinstellung) — nur ein gespeichertes false schaltet die Basis ab.
  ($('asBasis') as HTMLInputElement).checked = a.basis !== false;
  renderSymbolPicker();
  $('asMsg').textContent = '';
  $('asErr').hidden = true;
}

/**
 * Symbolauswahl als Teilmenge des Plattform-Universums. Gespeichert wird
 * NUR eine echte Teilmenge; sind alle gewählt, fällt das Feld weg und der
 * Takt handelt das ganze Universum — auch wenn es später wächst.
 */
function renderSymbolPicker(): void {
  if (!st) return;
  const box = $('asSymbols');
  const gewaehlt = st.autoSymbols === null ? null : new Set(st.autoSymbols);
  const champ = st.champion;
  box.innerHTML = st.universe
    .map((sym) => {
      const an = gewaehlt === null || gewaehlt.has(sym);
      const mitChampion = champ ? sym in champ.symbols : null;
      const noTrade = champ ? sym in champ.noTrade : false;
      const marke =
        mitChampion === true
          ? `<span class="stag t-buy" title="${t('as.hatChampion')}">✓</span>`
          : noTrade
            ? `<span class="stag t-hold" title="${escText(champ?.noTrade[sym]?.reason ?? '')}">${t('as.noTradeKurz')}</span>`
            : '';
      return `<label class="opt-chk as-sym" title="${escText(resolveName(sym))}">
        <input type="checkbox" data-sym="${escText(sym)}" ${an ? 'checked' : ''} />
        <span class="mono">${escText(sym)}</span> ${marke}
      </label>`;
    })
    .join('');
  box.querySelectorAll<HTMLInputElement>('input[data-sym]').forEach((cb) =>
    cb.addEventListener('change', zaehleSymbole),
  );
  zaehleSymbole();
}

function gewaehlteSymbole(): string[] {
  return [...$('asSymbols').querySelectorAll<HTMLInputElement>('input[data-sym]:checked')].map(
    (cb) => cb.dataset['sym'] ?? '',
  ).filter(Boolean);
}

function zaehleSymbole(): void {
  if (!st) return;
  const n = gewaehlteSymbole().length;
  const el = $('asSymCount');
  el.textContent = `${n}/${st.universe.length}`;
  // Der Server deckelt die Auswahl — die Zahl warnt, bevor das Speichern scheitert.
  el.style.color = n > AUTO_SYMBOLS_MAX ? 'var(--rd)' : '';
  el.title = n > AUTO_SYMBOLS_MAX ? `${t('val.hoechstens').replace('{0}', t('as.symbole')).replace('{1}', String(AUTO_SYMBOLS_MAX))}` : '';
}

/** Die Maske als Einstellungs-Objekt — Zahlen roh, die Prüfung übernimmt validateAutoSettings. */
function autoFormSettings(): AutoSettings {
  const num = (id: string): number => Number(($(id) as HTMLInputElement).value);
  const alle = gewaehlteSymbole();
  const teilmenge = st && alle.length < st.universe.length;
  return {
    riskPerTradePct: num('asRisk'),
    maxPositionPct: num('asMaxPct'),
    maxPositions: num('asMaxN'),
    maxDailyLossPct: num('asDaily'),
    maxDrawdownPct: num('asDd'),
    allowShort: ($('asShort') as HTMLInputElement).checked,
    notifyTelegram: ($('asTelegram') as HTMLInputElement).checked,
    basis: ($('asBasis') as HTMLInputElement).checked,
    ...(teilmenge ? { symbols: alle } : {}),
  };
}

/** Speichern: erst lokal prüfen (Klartext sofort), dann serverseitig — der Server prüft erneut. */
async function submitAuto(): Promise<void> {
  if (!st) return;
  const err = $('asErr');
  const msg = $('asMsg');
  err.hidden = true;
  const auto = autoFormSettings();
  const probe = validateAutoSettings(auto, st.universe);
  if (!probe.ok) {
    err.textContent = probe.fehler.map(valText).join(' · ');
    err.hidden = false;
    return;
  }
  msg.textContent = t('mt.speichere');
  try {
    await saveStrategy({ auto: probe.wert ?? auto });
    msg.textContent = `✓ ${t('mt.gespeichert')}`;
  } catch (e) {
    err.textContent = serverText(e);
    err.hidden = false;
    msg.textContent = '';
  }
}

/* ── Admin-Verwaltung (Owner 02.08.: „wie kann man andere User freischalten?") ── */

const ACCESS_BADGE: Record<'pending' | 'approved' | 'blocked' | 'archiviert', string> = {
  pending: `⏳ ${t('adm.wartet')}`,
  approved: `✓ ${t('adm.frei')}`,
  blocked: `⛔ ${t('adm.gesperrt')}`,
  archiviert: `🗄 ${t('adm.archiviert')}`,
};

/** Karte zeigen/verstecken — der Server prüft das Admin-Recht ohnehin selbst;
 *  die Sichtbarkeit hier ist reine Höflichkeit, kein Schutz. */
function renderAdminCard(): void {
  if (!st) return;
  ($('adminCard') as HTMLElement).hidden = !st.admin;
}

/**
 * Den Faden eines fremden Kontos zeigen und beantworten.
 *
 * Er wird UNTER die Kontozeile gehaengt, nicht in ein eigenes Fenster:
 * Wer gerade entscheidet, ob er freischaltet, will die Unterhaltung neben
 * dem Konto sehen und nicht anstelle davon.
 */
async function zeigeFaden(uid: string, ziel: HTMLElement): Promise<void> {
  const alt = document.getElementById(`faden-${uid}`);
  if (alt) {
    // Zweiter Klick klappt wieder zu -- ein Knopf, zwei Richtungen.
    alt.remove();
    return;
  }
  const box = document.createElement('div');
  box.id = `faden-${uid}`;
  box.className = 'faden-admin';
  ziel.append(box);

  const nachrichten = await adminNachrichten(uid);
  box.innerHTML = '';
  if (nachrichten.length === 0) {
    const leer = document.createElement('div');
    leer.className = 'hint';
    leer.textContent = t('adm.fadenLeer');
    box.append(leer);
  }
  for (const n of nachrichten) {
    const zeile = document.createElement('div');
    zeile.className = `faden-zeile faden-${n.von}`;
    const wer = document.createElement('span');
    wer.className = 'faden-wer';
    // In der ADMIN-Ansicht heisst der Kunde „Kunde", nicht „Du" — der Admin liest fremde Post.
    wer.textContent = n.von === 'admin' ? t('fd.vomBetreiber') : t('adm.vomKunden');
    const wannEl = document.createElement('span');
    wannEl.className = 'faden-wann mono';
    wannEl.textContent = n.at.slice(0, 16).replace('T', ' ');
    const text = document.createElement('div');
    // textContent: Der Inhalt kommt von Menschen, nicht aus dem Code.
    text.textContent = n.text;
    zeile.append(wer, wannEl, text);
    box.append(zeile);
  }

  const feld = document.createElement('textarea');
  feld.className = 'inp faden-text';
  feld.rows = 2;
  feld.maxLength = 2000;
  feld.placeholder = t('adm.antwortPlatzhalter');
  const fehler = document.createElement('span');
  fehler.className = 'hint';
  const senden = document.createElement('button');
  senden.className = 'btn btn-n';
  senden.style.cssText = 'padding:3px 8px;font-size:.78rem';
  senden.textContent = t('adm.antworten');
  senden.addEventListener('click', () => {
    const text = feld.value.trim();
    if (text.length === 0) {
      fehler.textContent = t('fd.leer');
      return;
    }
    senden.disabled = true;
    fehler.textContent = '';
    void adminAntworten(uid, text)
      .then(() => {
        box.remove();
        return zeigeFaden(uid, ziel);
      })
      .catch((e: unknown) => {
        fehler.textContent = serverText(e);
        senden.disabled = false;
      });
  });
  const reihe = document.createElement('div');
  reihe.className = 'row';
  reihe.style.cssText = 'gap:6px;align-items:center';
  reihe.append(senden, fehler);
  box.append(feld, reihe);
}

/* ── Admin-Liste, kompakte Fassung (Owner 22.08.) ──────────────────────────
 *
 * Drei Dinge hat der Owner verlangt, und die Gliederung folgt genau ihnen:
 * uebersichtlich bei sehr vielen Nutzern, Anfragen oben, keine Knopfkolonne.
 */

/** Der zuletzt geholte Stand — Grundlage fuer Filter und Einzelzeilen-Update. */
let admZeilen: AdminUserRow[] = [];
/** Welcher Streifen ist offen? Genau einer, sonst waere die Liste wieder lang. */
let admOffenerStreifen: string | null = null;
/** Armierter Knopf und sein Ruecksetz-Timer (zweistufige Bestaetigung). */
let admArmiert: { btn: HTMLButtonElement; timer: number } | null = null;

function admEntwaffne(): void {
  if (!admArmiert) return;
  window.clearTimeout(admArmiert.timer);
  admArmiert.btn.classList.remove('armed');
  admArmiert.btn.textContent = admArmiert.btn.dataset['ruhe'] ?? admArmiert.btn.textContent;
  admArmiert = null;
}

/**
 * Ein Knopf, der beim ERSTEN Klick nur scharf wird und erst beim zweiten
 * ausfuehrt.
 *
 * Bewusst KEIN `confirm()`: Browser bieten nach wiederholten Dialogen
 * „weitere Dialoge unterdruecken" an, und danach liefert `confirm()`
 * dauerhaft `false` — SPERREN waere dann ein Knopf, der sichtbar nichts tut.
 */
function admArmBtn(
  ruhe: string,
  scharf: string,
  cls: string,
  run: () => Promise<void>,
  nach: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn ${cls} adm-akt`;
  b.dataset['ruhe'] = ruhe;
  b.textContent = ruhe;
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (admArmiert?.btn === b) {
      admEntwaffne();
      b.disabled = true;
      run()
        .then(nach)
        .catch((e: unknown) => {
          const err = $('admErr');
          err.textContent = serverText(e);
          err.hidden = false;
          b.disabled = false;
          void loadAdminList();
        });
      return;
    }
    admEntwaffne();
    b.classList.add('armed');
    b.textContent = scharf;
    // Nach fuenf Sekunden von selbst entschaerfen — ein scharfer Knopf, der
    // scharf bleibt, ist beim naechsten Blick eine Falle.
    admArmiert = { btn: b, timer: window.setTimeout(admEntwaffne, 5000) };
  });
  return b;
}

/** Wartezeit einer Anfrage in Tagen — leer, wenn kein Zeitstempel da ist. */
function admWartetSeit(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const tage = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  return `${t('adm.wartetSeit')} ${tage} ${t('adm.tage')}`;
}

/** Hat dieses Konto einen offenen Vorgang? Die Rangfolge traegt die Sortierung. */
function admOffenGrund(row: AdminUserRow): 'pending' | 'sperre' | null {
  if (row.accessLevel === 'pending') return 'pending';
  if (row.abgleich?.sperre === true) return 'sperre';
  return null;
}

/** Farbpunkt der Zeile — Zustand auf einen Blick, aber nie die EINZIGE Anzeige. */
function admPunktFarbe(row: AdminUserRow): string {
  if (row.abgleich?.sperre === true) return 'var(--rd)';
  if (row.accessLevel === 'pending') return 'var(--yl,#d9a441)';
  if (row.accessLevel === 'blocked') return 'var(--t3)';
  return 'var(--gn)';
}

/**
 * Eine Kontozeile bauen: zweizeiliges Raster plus Aufklapp-Streifen.
 *
 * ZWEIZEILIG und nicht mehrspaltig, weil die Karte rund 254 px breit ist.
 * Der DESKTOP ist damit der engere Fall, nicht die Handy-Schublade.
 */
function admZeile(row: AdminUserRow, inOffen: boolean): HTMLElement {
  const k = document.createElement('div');
  k.className = 'adm-k';
  k.dataset['uid'] = row.uid;
  k.dataset['mail'] = (row.email ?? row.uid).toLowerCase();
  // Der Archiv-Filter unten liest das Attribut, nicht die Zeilen-Daten.
  k.dataset['stufe'] = row.accessLevel;

  const z = document.createElement('div');
  z.className = 'adm-z';
  const z1 = document.createElement('div');
  z1.className = 'adm-z1';
  const punkt = document.createElement('span');
  punkt.className = 'adm-punkt';
  punkt.style.background = admPunktFarbe(row);
  const mail = document.createElement('span');
  mail.className = 'adm-mail mono';
  mail.textContent = row.email ?? row.uid;
  mail.title = `${row.email ?? ''}\n${row.uid}`.trim();
  const ueb = document.createElement('button');
  ueb.className = 'adm-ueb';
  ueb.textContent = '⋯';
  ueb.title = t('adm.mehrAktionen');
  ueb.setAttribute('aria-label', t('adm.mehrAktionen'));
  z1.append(punkt, mail, ueb);

  const z2 = document.createElement('div');
  z2.className = 'adm-z2';
  if (inOffen) {
    if (row.accessLevel === 'pending') {
      const seit = document.createElement('span');
      seit.className = 'adm-meta mono';
      seit.textContent = admWartetSeit(row.requestedAt);
      seit.title = row.requestedAt ?? '';
      z2.append(seit);
    }
    // Die Zugangsstufe als WORT — nur bei Sperr-Zeilen; bei einer wartenden
    // Registrierung steht sie schon im Satz daneben.
    if (row.accessLevel !== 'pending') {
      const stufe = document.createElement('span');
      stufe.className = 'adm-meta';
      stufe.textContent = ACCESS_BADGE[row.accessLevel];
      z2.append(stufe);
    }
  } else {
    const perf = document.createElement('span');
    perf.className = 'adm-pnl mono';
    if (row.pnl !== null) {
      const s = row.pnl >= 0 ? '+' : '';
      perf.textContent = `${s}${row.pnl.toFixed(0)} $`;
      perf.style.color = row.pnl > 0 ? 'var(--gn)' : row.pnl < 0 ? 'var(--rd)' : 'var(--t3)';
      if (row.equity !== null) perf.title = `${t('adm.equity')}: ${row.equity.toFixed(2)} $`;
    } else {
      perf.textContent = '—';
      perf.style.color = 'var(--t3)';
    }
    const meta = document.createElement('span');
    meta.className = 'adm-meta mono';
    meta.textContent = `${row.trades ?? 0} ${t('adm.trades')} · ${t('adm.reife')} ${row.reife.erfuellt}/${row.reife.gesamt}${row.reife.bereit ? ' ✓' : ''}`;
    meta.title = reifeFazit(row.reife);
    z2.append(perf, meta);
  }
  /* Markenzone: kuerzt NIE. Der Sperr-Chip ist die eine Sache, die in dieser
   * Liste niemals geschluckt werden darf. */
  const mark = document.createElement('span');
  mark.className = 'adm-mark';
  if (row.abgleich?.sperre) {
    const chip = document.createElement('span');
    chip.className = 'stag t-sell';
    chip.textContent = t('adm.abgleichKurz');
    chip.title = row.abgleich.fehlbestand > 0
      ? `${row.abgleich.fehlbestand} ${t('adm.abgleichFehlbestand')}`
      : t('adm.abgleichKontoGrob');
    mark.append(chip);
  }
  if (row.admin) {
    const chip = document.createElement('span');
    chip.className = 'stag';
    chip.textContent = t('adm.admin');
    mark.append(chip);
  }
  if (inOffen && row.accessLevel === 'pending' && row.uid !== st?.uid) {
    mark.append(
      admBtn(t('adm.freischalten'), async () => {
        await adminSetAccess(row.uid, 'approved');
      }, 'btn-g', row.uid),
    );
  }
  z2.append(mark);
  z.append(z1, z2);

  const strip = document.createElement('div');
  strip.className = 'adm-strip';
  strip.hidden = true;
  /* ZWEI getrennte Bloecke, und das ist der Kern: `.adm-verw` wird beim
   * Neuzeichnen der Zeile ERNEUT gebaut, `.adm-faden` NIE angefasst. Damit
   * kann ein Verwaltungsklick einen offenen Faden oder einen halb getippten
   * Antworttext nicht mehr fressen. */
  const verw = document.createElement('div');
  verw.className = 'adm-verw';
  const faden = document.createElement('div');
  faden.className = 'adm-faden';
  strip.append(verw, faden);
  admFuelleVerw(verw, row, faden);

  const auf = (ev: Event): void => {
    ev.stopPropagation();
    admEntwaffne();
    const offen = !strip.hidden;
    if (admOffenerStreifen && admOffenerStreifen !== row.uid) {
      const anderer = $('admList').querySelector<HTMLElement>(`.adm-k[data-uid="${admOffenerStreifen}"] .adm-strip`);
      if (anderer) anderer.hidden = true;
    }
    strip.hidden = offen;
    admOffenerStreifen = offen ? null : row.uid;
  };
  ueb.addEventListener('click', auf);
  z.addEventListener('click', auf);

  k.append(z, strip);
  if (admOffenerStreifen === row.uid) strip.hidden = false;
  return k;
}

/** Der Inhalt des Verwaltungs-Streifens. */
function admFuelleVerw(verw: HTMLElement, row: AdminUserRow, fadenBlock: HTMLElement): void {
  verw.innerHTML = '';
  const zeile = (text: string, farbe?: string): void => {
    const d = document.createElement('div');
    d.className = 'hint mono';
    d.textContent = text;
    if (farbe) d.style.color = farbe;
    verw.append(d);
  };
  zeile(row.uid);
  if (row.risiko) zeile(`${t('adm.risikoOk')} ${row.risiko.at.slice(0, 10)} · ${row.risiko.version}`);
  if (row.equity !== null) zeile(`${t('adm.equity')}: ${row.equity.toFixed(2)} $`);
  zeile(reifeFazit(row.reife));
  if (row.abgleich?.sperre) {
    zeile(
      row.abgleich.fehlbestand > 0
        ? `${row.abgleich.fehlbestand} ${t('adm.abgleichFehlbestand')}`
        : t('adm.abgleichKontoGrob'),
      'var(--rd)',
    );
  }
  // Das eigene Konto listet der Server mit, aendern lehnt er ab — dieselbe
  // Regel hier: keine Knoepfe, statt Knoepfe, die immer scheitern.
  if (row.uid === st?.uid) return;

  const nach = (): void => { void loadAdminList(); };
  /* Einstufig, weil herstellend statt zerstoerend: Ein FREISCHALTEN gibt
   * Zugang zurueck. Das SPERREN daneben ist armiert. */
  if (row.accessLevel === 'archiviert') {
    /* Ziel ist bewusst 'pending' und nicht 'approved' — aus der Ablage kommt
     * ein Konto in die Warteschlange zurueck, nicht in den Handel. */
    verw.append(
      admBtn(t('adm.zurueckholen'), async () => {
        await adminSetAccess(row.uid, 'pending');
      }, 'btn-g', row.uid),
    );
  } else if (row.accessLevel !== 'approved') {
    verw.append(
      admBtn(t('adm.freischalten'), async () => {
        await adminSetAccess(row.uid, 'approved');
      }, 'btn-g', row.uid),
    );
    /* Armiert, obwohl nichts vernichtet wird: Die Zeile verschwindet aus der
     * Liste, und eine Aktion, deren sichtbares Ergebnis „weg" ist, soll man
     * nicht mit einem Rutscher ausloesen. */
    verw.append(
      admArmBtn(
        t('adm.archivieren'),
        `${t('adm.wirklichArchivieren')} ${row.email ?? row.uid}`,
        '',
        async () => { await adminSetAccess(row.uid, 'archiviert'); },
        nach,
      ),
    );
  } else {
    verw.append(
      admArmBtn(
        t('adm.sperren'),
        `${t('adm.wirklichSperren')} ${row.email ?? row.uid}`,
        'btn-r',
        async () => { await adminSetAccess(row.uid, 'blocked'); },
        nach,
      ),
    );
  }
  /* Armiert, und ausdruecklich ROT statt neutral: Der Ernannte darf danach
   * den Ernenner entlassen. */
  verw.append(
    admArmBtn(
      row.admin ? t('adm.adminEntziehen') : t('adm.zumAdmin'),
      `${row.admin ? t('adm.wirklichAdminNehmen') : t('adm.wirklichAdminGeben')} ${row.email ?? row.uid}`,
      'btn-r',
      async () => { await adminSetAdmin(row.uid, !row.admin); },
      nach,
    ),
  );
  /* Endgültig löschen (DSGVO Art. 17) — eigener Zweig: Admin-Konten werden
   * gar nicht erst angeboten (Server lehnt sie ohnehin ab). */
  if ((row.accessLevel === 'archiviert' || row.accessLevel === 'blocked') && !row.admin) {
    verw.append(
      admLoeschKnopf(row.uid, async () => {
        await adminDeleteAccount(row.uid, DELETE_CONFIRM_WORD);
      }, nach),
    );
  }
  /* Eigener Knopf statt `admBtn`: Der laedt nach jeder Aktion die Zeile neu
   * — der eben aufgeklappte Faden waere sofort wieder weg. */
  const fadenBtn = document.createElement('button');
  fadenBtn.className = 'btn btn-n adm-akt';
  fadenBtn.textContent = t('adm.faden');
  fadenBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    fadenBtn.disabled = true;
    void zeigeFaden(row.uid, fadenBlock).finally(() => { fadenBtn.disabled = false; });
  });
  verw.append(fadenBtn);
}

/** Ueberschrift eines Abschnitts. */
function admGruppe(text: string, n: number): HTMLElement {
  const h = document.createElement('div');
  h.className = 'adm-grp';
  h.textContent = `${text} (${n})`;
  return h;
}

/**
 * Die Liste zeichnen — Offen oben, darunter das vollstaendige Register.
 *
 * Konten aus OFFEN erscheinen im Register ERNEUT: Offen ist eine SICHT,
 * keine Umlagerung. Sonst faende der Filter ein Konto nicht, das gerade
 * oben steht.
 */
export function renderAdminRows(rows: AdminUserRow[]): void {
  const list = $('admList');
  admZeilen = rows;
  list.innerHTML = '';
  const offen = rows
    .filter((r) => admOffenGrund(r) !== null)
    .sort((a, b) => {
      const rang = (r: AdminUserRow): number => (admOffenGrund(r) === 'pending' ? 0 : 1);
      if (rang(a) !== rang(b)) return rang(a) - rang(b);
      const zeit = (r: AdminUserRow): number =>
        Date.parse(r.requestedAt ?? r.abgleich?.at ?? '') || 0;
      return zeit(a) - zeit(b); // aeltestes zuerst
    });
  list.append(admGruppe(t('adm.offen'), offen.length));
  const offenBox = document.createElement('div');
  offenBox.className = 'adm-liste offen';
  offenBox.id = 'admOffenBox';
  if (offen.length === 0) {
    const leer = document.createElement('div');
    leer.className = 'hint';
    leer.textContent = t('adm.nichtsOffen');
    offenBox.append(leer);
  } else {
    for (const r of offen) offenBox.append(admZeile(r, true));
  }
  list.append(offenBox);

  list.append(admGruppe(t('adm.alleKonten'), rows.length));
  const regBox = document.createElement('div');
  regBox.className = 'adm-liste register';
  regBox.id = 'admRegBox';
  const gruppen: Array<[AdminUserRow['accessLevel'], string]> = [
    ['pending', t('adm.gruppeWartend')],
    ['blocked', t('adm.gruppeGesperrt')],
    ['approved', t('adm.gruppeFrei')],
    ['archiviert', t('adm.gruppeArchiv')],
  ];
  for (const [stufe, name] of gruppen) {
    const teil = rows.filter((r) => r.accessLevel === stufe);
    if (teil.length === 0) continue; // leere Gruppe entfaellt
    regBox.append(admGruppe(name, teil.length));
    for (const r of teil) regBox.append(admZeile(r, false));
  }
  /* Rest-Eimer: Eine Zeile mit einer Stufe, die oben fehlt, fiele sonst
   * durch alle Filter und wuerde gar nicht gezeichnet — ein Konto waere
   * unsichtbar, ohne archiviert oder geloescht zu sein. */
  const bekannt = new Set(gruppen.map(([stufe]) => stufe));
  const rest = rows.filter((r) => !bekannt.has(r.accessLevel));
  if (rest.length > 0) {
    regBox.append(admGruppe('?', rest.length));
    for (const r of rest) regBox.append(admZeile(r, false));
  }
  list.append(regBox);

  const offenZahl = $('admOffen');
  offenZahl.textContent = String(offen.length);
  offenZahl.style.color = offen.length > 0 ? 'var(--ac)' : 'var(--t3)';
  $('admStand').textContent = `${rows.length} ${t('adm.kontenStand')} · ${t('adm.geladen')} ${new Date().toLocaleTimeString(sprachWahl() === 'en' ? 'en-US' : 'de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  // Filter erst ab einer Groesse, die ihn braucht — bei acht Konten waere er Buerokratie.
  const suche = $('admSuche') as HTMLInputElement;
  suche.hidden = rows.length <= 12;
  admFiltere();
}

/** Filtertext anwenden — rein im Browser, ohne Serveraufruf. */
function admFiltere(): void {
  const suche = $('admSuche') as HTMLInputElement;
  const q = suche.value.trim().toLowerCase();
  const archivAn = ($('admArchiv') as HTMLInputElement | null)?.checked === true;
  let archiviert = 0;
  for (const k of $('admList').querySelectorAll<HTMLElement>('.adm-k')) {
    const istArchiv = k.dataset['stufe'] === 'archiviert';
    if (istArchiv) archiviert += 1;
    /* Archivierte sind standardmaessig weg — das ist der ganze Zweck der
     * Stufe. Die Suche findet sie trotzdem. */
    const wegenArchiv = istArchiv && !archivAn && q.length === 0;
    k.hidden = wegenArchiv || (q.length > 0 && !(k.dataset['mail'] ?? '').includes(q));
  }
  const zahl = $('admArchivZahl');
  if (zahl) {
    zahl.textContent = archiviert > 0 ? `(${archiviert})` : '';
    (zahl.parentElement as HTMLElement | null)?.toggleAttribute('hidden', archiviert === 0);
  }
}

async function loadAdminList(): Promise<void> {
  const list = $('admList');
  const err = $('admErr');
  err.hidden = true;
  admEntwaffne();
  list.innerHTML = `<div class="hint">${t('adm.laedt')}</div>`;
  try {
    renderAdminRows(await adminListUsers());
  } catch (e) {
    list.innerHTML = '';
    err.textContent = serverText(e);
    err.hidden = false;
  }
}

/** Zustand des Echtgeld-Not-Aus laden und Knopf/Anzeige setzen. */
async function ladeKillSwitch(): Promise<void> {
  const state = $('admKillState');
  const btn = $('admKillBtn') as HTMLButtonElement;
  try {
    const s = await adminLiveStatus();
    state.textContent = s.killSwitch
      ? `${t('adm.zustand')}: ${t('adm.ausgeloest')}${s.at ? ` (${new Date(s.at).toLocaleString('de-DE')})` : ''}`
      : `${t('adm.zustand')}: ${t('adm.bereit')}`;
    (state as HTMLElement).style.color = s.killSwitch ? 'var(--rd)' : 'var(--t3)';
    btn.textContent = s.killSwitch ? t('adm.notausLoesen') : t('adm.notausAusloesen');
    btn.className = s.killSwitch ? 'btn btn-g' : 'btn btn-r';
    btn.dataset['an'] = s.killSwitch ? '0' : '1';
    btn.hidden = false;
  } catch (e) {
    state.textContent = `${t('adm.zustand')}: ${t('adm.nichtLesbar')} (${serverText(e)})`;
    btn.hidden = true;
  }
}

/**
 * Genau EINE Zeile neu zeichnen, statt die ganze Liste.
 *
 * `loadAdminList()` nach jeder Aktion war die Wurzel von fuenf Folgefehlern
 * gleichzeitig (Filter weg, Scroll springt, Streifen zu, Faden gefressen,
 * volle Runde gegen das Tageslimit). Der Faden (`.adm-faden`) wird nie
 * angefasst, nur `.adm-z` und `.adm-verw` entstehen neu.
 */
async function admAktualisiereZeile(uid: string): Promise<void> {
  const rows = await adminListUsers();
  const vorher = admZeilen.find((r) => r.uid === uid);
  const nachher = rows.find((r) => r.uid === uid);
  admZeilen = rows;
  const k = $('admList').querySelector<HTMLElement>(`.adm-k[data-uid="${uid}"]`);
  // Abschnittswechsel oder Zeile verschwunden ⇒ voller Aufbau.
  if (!k || !nachher || !vorher
    || (admOffenGrund(vorher) === null) !== (admOffenGrund(nachher) === null)
    || vorher.accessLevel !== nachher.accessLevel) {
    renderAdminRows(rows);
    const neu = $('admList').querySelector<HTMLElement>(`.adm-k[data-uid="${uid}"]`);
    neu?.classList.add('adm-puls');
    return;
  }
  const inOffen = k.closest('#admOffenBox') !== null;
  const frisch = admZeile(nachher, inOffen);
  k.querySelector('.adm-z')?.replaceWith(frisch.querySelector('.adm-z')!);
  const verw = k.querySelector<HTMLElement>('.adm-verw');
  const faden = k.querySelector<HTMLElement>('.adm-faden');
  if (verw && faden) admFuelleVerw(verw, nachher, faden);
  k.classList.add('adm-puls');
  window.setTimeout(() => k.classList.remove('adm-puls'), 1400);
}

/** Kleiner Aktions-Knopf: führt aus, frischt DIESE Zeile auf, zeigt Fehler ehrlich. */
function admBtn(
  label: string,
  run: () => Promise<void>,
  cls: string,
  uid: string,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn ${cls} adm-akt`;
  b.textContent = label;
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    b.disabled = true;
    run()
      .then(() => admAktualisiereZeile(uid))
      .catch((e: unknown) => {
        const err = $('admErr');
        err.textContent = serverText(e);
        err.hidden = false;
        b.disabled = false;
        // Bei einem Fehler ist der Zustand unklar — dann lieber ganz frisch.
        void loadAdminList();
      });
  });
  return b;
}

/**
 * Löschen-Knopf mit getipptem Bestätigungswort (DSGVO Art. 17).
 *
 * KEIN `window.prompt()`/`confirm()` — derselbe Grund wie bei admArmBtn.
 * Stattdessen ein echtes Eingabefeld inline, dasselbe Muster wie
 * `rsWord`/`rsGo` beim Wallet-Reset: Der Client-Guard ist Bequemlichkeit,
 * die Sicherung ist serverseitig.
 */
function admLoeschKnopf(uid: string, run: () => Promise<void>, nach: () => void): HTMLElement {
  const host = document.createElement('span');
  host.style.display = 'inline-flex';
  host.style.gap = '6px';
  host.style.alignItems = 'center';

  const zeigeKnopf = (): void => {
    host.replaceChildren();
    const b = document.createElement('button');
    b.className = 'btn btn-r adm-akt';
    b.textContent = t('adm.endgueltigLoeschen');
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      zeigeEingabe();
    });
    host.append(b);
  };

  const zeigeEingabe = (): void => {
    host.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inp st-num';
    input.style.maxWidth = '150px';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = t('adm.loeschenTippen').replace('{0}', DELETE_CONFIRM_WORD);
    const go = document.createElement('button');
    go.className = 'btn btn-r adm-akt';
    go.textContent = t('adm.endgueltigLoeschen');
    go.disabled = true;
    const ab = document.createElement('button');
    ab.className = 'btn btn-n adm-akt';
    ab.textContent = t('adm.abbrechen');
    // Klicks/Tasten im Feld dürfen die Zeile nicht auf-/zuklappen.
    for (const ev of ['click', 'keydown']) {
      input.addEventListener(ev, (e) => e.stopPropagation());
    }
    input.addEventListener('input', () => {
      go.disabled = input.value.trim() !== DELETE_CONFIRM_WORD;
    });
    ab.addEventListener('click', (ev) => {
      ev.stopPropagation();
      zeigeKnopf();
    });
    go.addEventListener('click', (ev) => {
      ev.stopPropagation();
      go.disabled = true;
      input.disabled = true;
      ab.disabled = true;
      run()
        .then(nach)
        .catch((e: unknown) => {
          const err = $('admErr');
          err.textContent = serverText(e);
          err.hidden = false;
          zeigeKnopf();
        });
    });
    host.append(input, go, ab);
    input.focus();
  };

  zeigeKnopf();
  return host;
}


/* ── Positionen & Kennzahlen (Wallet, Positionen, Kurse) ────────────── */

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

/** Stop, Ziel, Strategie und Haltedauer je Position — die Stops liegen beim Broker. */
function positionsAusblick(p: PositionRow): string {
  const teile: string[] = [];
  if (p.stopLoss !== null && p.stopLoss !== undefined) teile.push(`${t('eo.stop')} <b>${fmtNum(p.stopLoss)}</b>`);
  if (p.takeProfit !== null && p.takeProfit !== undefined) teile.push(`${t('eo.ziel')} <b>${fmtNum(p.takeProfit)}</b>`);
  if (p.schutz?.orderId) teile.push(t('pos.schutzBeimBroker'));
  else if (p.stopLoss !== null && p.stopLoss !== undefined) teile.push(t('pos.schutzOhneOrder'));
  if (p.strategy) teile.push(escText(p.strategy));
  // Quelle „Basis": Der Takt stempelt die Stufe, die das Symbol führt (Champion-Block basis).
  if (p.stufe === 'basis') teile.push(`<span class="stag t-hold" title="${t('ch.basis')}">${t('pos.basis')}</span>`);
  const seit = Date.parse(p.openedAt);
  if (Number.isFinite(seit)) {
    const tage = (Date.now() - seit) / 86_400_000;
    teile.push(`${t('pos.seit')} <b>${tage < 1 ? `${Math.round(tage * 24)} h` : `${tage.toFixed(1)} ${t('eo.tg')}`}</b>`);
  }
  return teile.join(' · ');
}

function renderPortfolio(): void {
  if (!st) return;
  const cash = st.wallet?.paperBalance ?? null;
  let openPnl = 0;
  let posValue = 0;
  /* Positionen ohne frischen Kurs: Der Wert bleibt konservativ auf Einstand,
   * aber ihr Ergebnis ist UNBEKANNT, nicht null — und genau das muss
   * dranstehen. */
  let ohneKurs = 0;
  for (const p of st.positions) {
    const lage = positionLage(p, st.posPrices.get(p.symbol) ?? null);
    posValue += lage.wert;
    if (lage.pnl === null) ohneKurs += 1;
    else openPnl += lage.pnl;
  }
  // Gesamt-P&L = Equity − Kapitalbasis. NICHT die Summe der geladenen
  // Trades: Die Historie lädt seitenweise nach, und eine „Gesamt"-Zahl, die
  // mit jedem „Ältere laden" wächst, ist keine.
  const basis = st.wallet?.baseCapital ?? st.strategy.broker.initialCapital;
  const totalPnl = cash !== null ? cash + posValue - basis : null;
  const closedPnl = totalPnl !== null ? totalPnl - openPnl : null;
  // Trefferquote gehört zur SELBEN Familie wie Gesamt-P&L: eine Zahl über
  // ALLE Abschlüsse. Aus `st.trades` gerechnet wäre sie die Quote der
  // geladenen SEITE und spränge bei jedem „Ältere laden" — genau der Fehler,
  // vor dem der Kommentar drei Zeilen weiter oben warnt, eine Zeile später
  // dann doch gemacht (Befund 08.09.: 55 % neben −297,47 $).
  // `users/{uid}/stats/main` hält sie serverseitig über alle Trades; das
  // Dashboard lädt das Dokument ohnehin schon für die Kennzahlen darunter.
  // Die Seite bleibt nur der Notnagel, wenn es fehlt — und sagt das dann.
  const closers = st.trades.filter((t) => t.pnl !== undefined && t.pnl !== null);
  const wins = closers.filter((t) => (t.pnl ?? 0) > 0).length;
  const wrVollstaendig = st.pfStats?.winRatePct ?? null;
  const winRate = wrVollstaendig ?? (closers.length > 0 ? Math.round((wins / closers.length) * 100) : null);
  const wrNurSeite = wrVollstaendig === null && winRate !== null;

  $('vCash').textContent = money(cash);
  /* Negatives Cash ist beim SHORT-Buch Buchungslogik, kein Verlust: Der
   * Broker führt den Leerverkaufs-Erlös im Cash, unser Buch hält die Deckung
   * im Positionswert. Die Zahl bleibt stehen, erklärt sich aber selbst. */
  const cashHint = document.getElementById('vCashHint');
  if (cashHint) {
    const negativ = cash !== null && cash < 0;
    cashHint.hidden = !negativ;
    cashHint.textContent = negativ ? `${t('pf.shortsBinden')} ${money(Math.max(0, cash))}.` : '';
  }
  $('vEq').textContent = cash !== null ? money(cash + posValue) : '--';
  const pnlEl = $('vPnl');
  pnlEl.textContent = totalPnl === null ? '--' : (totalPnl >= 0 ? '+' : '') + money(totalPnl);
  pnlEl.className = `vbig ${pnlClass(totalPnl ?? 0)}`;
  /* Maßstab der Gesamt-P&L: Nach einem Depot-Schnitt ist die Basis neu
   * geankert — die Zeile sagt, ab wann die Zahl zählt. */
  const basisHint = document.getElementById('vPnlBasis');
  if (basisHint) {
    const resetAt = st.wallet?.resetAt;
    const zeit = resetAt ? Date.parse(resetAt) : NaN;
    const datum = Number.isFinite(zeit) ? new Date(zeit).toLocaleDateString('de-DE') : null;
    basisHint.hidden = !datum;
    basisHint.textContent = datum
      ? `${t('pf.seitSchnittA')} ${datum} (${t('pf.basis')} ${money(basis)}) ${t('pf.seitSchnittB')}`
      : '';
  }
  const closedEl = $('vClosed');
  closedEl.textContent = closedPnl === null ? '--' : money(closedPnl);
  closedEl.className = `smv ${pnlClass(closedPnl ?? 0)}`;
  const unrealEl = $('vUnreal');
  unrealEl.textContent = ohneKurs > 0 ? `${money(openPnl)} *` : money(openPnl);
  unrealEl.className = `smv ${pnlClass(openPnl)}`;
  unrealEl.title =
    ohneKurs > 0
      ? `${t('pf.ohneKursA')} ${ohneKurs} ${t('pf.ohneKursB')} ${st.positions.length} ${t('pf.ohneKursC')}`
      : '';
  const wrEl = $('vWR');
  // Der Notnagel wird als solcher gekennzeichnet: Eine Quote aus der
  // geladenen Seite darf nicht wie eine Gesamtquote aussehen.
  wrEl.textContent = winRate === null ? '--%' : `${Math.round(winRate)}%${wrNurSeite ? ' *' : ''}`;
  wrEl.title = wrNurSeite ? `${t('pf.wrNurSeiteA')} ${closers.length} ${t('pf.wrNurSeiteB')}` : '';

  // Positionen-Tabelle
  $('pCount').textContent =
    ohneKurs > 0 ? `${st.positions.length} ${t('pf.offenZaehler')} · ${ohneKurs} ${t('pf.ohneKurs')}` : `${st.positions.length} ${t('pf.offenZaehler')}`;
  const body = $('pBody') as HTMLTableSectionElement;
  body.innerHTML = '';
  if (st.positions.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="c-t3">${t('pf.keineOffenen')}</td></tr>`;
  }
  for (const p of st.positions) {
    const live = st.posPrices.get(p.symbol);
    const short = p.side === 'short';
    // Dieselbe Rechnung wie in der Summe darüber — eine Funktion, damit die
    // Anzeigen nicht auseinanderlaufen.
    const { pnl } = positionLage(p, live ?? null);
    const pct = live !== undefined && p.avgEntry > 0
      ? (short ? (1 - live / p.avgEntry) : (live / p.avgEntry - 1)) * 100
      : null;
    const tr = document.createElement('tr');
    tr.dataset['sym'] = p.symbol;
    // data-th: Labels fürs mobile Karten-Layout (theme.css, 480px-Block).
    tr.innerHTML = `<td style="color:var(--t1);font-weight:700"></td><td data-th="Qty">${p.qty}</td>
      <td data-th="${t('tab.eintritt')}">${fmtNum(p.avgEntry)}</td><td data-th="${t('tab.aktuell')}">${live !== undefined ? fmtNum(live) : '--'}</td>
      <td data-th="P&amp;L" class="${pnl !== null ? pnlClass(pnl) : ''}">${pnl !== null ? money(pnl) : '--'}</td>
      <td data-th="%" class="${pct !== null ? pnlClass(pct) : ''}">${pct !== null ? fmtPct(pct) : '--'}</td>
      <td class="pos-act"><span class="stag ${short ? 't-short' : 't-buy'}" title="${short ? t('pf.leerverkauf') : t('jn.long')}">${short ? 'SHORT' : 'LONG'}</span></td>`;
    const symTd = tr.querySelector('td')!;
    symTd.innerHTML = symbolAvatar(p.symbol);
    symTd.appendChild(document.createTextNode(p.symbol));
    symTd.className = 'pos-sym';
    symTd.title = resolveName(p.symbol);
    body.appendChild(tr);
    const outlook = positionsAusblick(p);
    if (outlook) {
      const sub = document.createElement('tr');
      sub.className = 'pos-sub';
      sub.innerHTML = `<td colspan="7">${outlook}</td>`;
      body.appendChild(sub);
    }
  }

  schmueckeAvatare();
  renderJournal();
}

/* ── Handelshistorie mit Paging ─────────────────────────────────────── */

/** Identität eines Trades ohne Doc-ID: Zeitstempel + Symbol + Seite + Stück. */
function tradeKey(t: TradeRow): string {
  return `${t.executedAt}|${t.symbol}|${t.side}|${t.qty}`;
}

/**
 * Eine ältere Seite anhängen (Knopf „Ältere laden").
 *
 * Ein Fehler landet sichtbar am Knopf, nicht stumm in der Konsole; bringt
 * eine Seite ausschließlich schon bekannte Zeilen, wird sofort
 * weitergeblättert statt aufzugeben.
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
    if (st) st.tradesFehler = serverText(e);
    console.warn('Ältere Trades nicht ladbar:', e);
  } finally {
    // Abmeldung während der Abfrage: Das `return` im try läuft trotzdem
    // durch dieses finally — und `st` ist dann null.
    if (st) {
      st.tradesLoading = false;
      renderPortfolio();
    }
  }
}

/**
 * Richtungs-Marke eines Trades. BUY/SELL allein war zweideutig: Ein
 * Leerverkauf ist ein SELL, sein Eindecken ein BUY. Vier Fälle, vier Marken:
 * Long-Kauf ▲, Long-Verkauf ▼, Short-Eröffnung ▼ (rot umrandet), Cover ▲.
 */
function tradeRichtung(zeile: { side: 'buy' | 'sell'; short?: boolean; cover?: boolean }): {
  klasse: string; pfeil: string; text: string; titel: string;
} {
  // `zeile`, nicht `t`: Der Parametername würde die Übersetzungsfunktion
  // t() verschatten.
  if (zeile.short === true) {
    return { klasse: 't-short', pfeil: '▼', text: t('jn.short'), titel: t('jn.shortAufTitel') };
  }
  if (zeile.cover === true) {
    return { klasse: 't-cover', pfeil: '▲', text: t('jn.short'), titel: t('jn.shortZuTitel') };
  }
  return zeile.side === 'buy'
    ? { klasse: 't-buy', pfeil: '▲', text: t('jn.long'), titel: t('jn.longAufTitel') }
    : { klasse: 't-sell', pfeil: '▼', text: t('jn.long'), titel: t('jn.longZuTitel') };
}

type SortRichtung = 'auf' | 'ab';
const sortZustand: { jn: { idx: number; dir: SortRichtung } | null } = { jn: null };

/** Spalten-Sortierung per Titel-Klick, auf/ab im Wechsel — idempotent über data-wired. */
function wireSortKopf(bodyId: string, anwenden: () => void): void {
  const kopf = document.getElementById(bodyId)?.closest('table')?.querySelector<HTMLTableRowElement>('thead tr');
  if (!kopf || kopf.dataset['wired'] === '1') return;
  kopf.dataset['wired'] = '1';
  const koepfe = [...kopf.querySelectorAll<HTMLTableCellElement>('th')];
  koepfe.forEach((th, idx) => {
    if (th.textContent?.trim() === '') return;
    th.classList.add('sortierbar');
    th.title = t('tab.sortierenTitel');
    th.addEventListener('click', () => {
      const alt = sortZustand.jn;
      const neu: { idx: number; dir: SortRichtung } =
        alt?.idx === idx ? { idx, dir: alt.dir === 'auf' ? 'ab' : 'auf' } : { idx, dir: 'auf' };
      sortZustand.jn = neu;
      koepfe.forEach((h, i) => {
        h.classList.toggle('sort-auf', i === idx && neu.dir === 'auf');
        h.classList.toggle('sort-ab', i === idx && neu.dir === 'ab');
        if (i === idx) h.setAttribute('aria-sort', neu.dir === 'auf' ? 'ascending' : 'descending');
        else h.removeAttribute('aria-sort');
      });
      anwenden();
    });
  });
}

/**
 * Die Handelshistorie als Tabelle: Live-Kopf (50) plus nachgeladene Seiten,
 * mit Zähler und zwei Filtern. Gefiltert wird NUR die Anzeige.
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
  // Spalten-Sortierung — auf den DATEN, nicht den Zellen: „20.08., 15:39"
  // wäre als Text lexikalisch falsch, executedAt (ISO) nicht.
  const sj = sortZustand.jn;
  if (sj) {
    const dir = sj.dir === 'auf' ? 1 : -1;
    const wert = (x: (typeof zeilen)[number]): string | number | null => {
      switch (sj.idx) {
        case 0: return x.executedAt;
        case 1: return x.symbol;
        case 2: return x.side;
        case 3: return x.qty;
        case 4: return x.price;
        default: return x.pnl ?? null; // offene Trades ohne P&L ⇒ ans Ende
      }
    };
    zeilen.sort((a, b) => {
      const va = wert(a);
      const vb = wert(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  const zaehler = $('jCount');
  zaehler.textContent =
    zeilen.length === st.trades.length
      ? `${st.trades.length}${st.tradesDone ? '' : '+'}`
      : `${zeilen.length} / ${st.trades.length}${st.tradesDone ? '' : '+'}`;
  const mehr = $('jMore') as HTMLButtonElement;
  // Nie ganz verschwinden lassen: Ein fehlender Knopf sieht aus wie ein
  // Fehler, ein ausgegrauter erklärt sich selbst.
  mehr.hidden = false;
  mehr.disabled = st.tradesLoading || st.tradesDone;
  mehr.textContent = st.tradesFehler
    ? t('jn.nachladenFehler')
    : st.tradesLoading
      ? t('jn.laedt')
      : st.tradesDone
        ? t('jn.alleGeladen')
        : t('jn.aeltereLaden');
  if (st.tradesFehler) {
    mehr.disabled = false;
    mehr.title = st.tradesFehler;
  } else {
    mehr.title = st.tradesDone ? t('jn.vollstaendigTitel') : t('jn.aeltereTitel');
  }

  jb.innerHTML = '';
  if (zeilen.length === 0) {
    jb.innerHTML = `<tr><td colspan="6" class="c-t3">${
      st.trades.length === 0 ? t('jn.keineTrades') : t('jn.keinTreffer')
    }</td></tr>`;
    return;
  }
  for (const t of zeilen) {
    const tr = document.createElement('tr');
    tr.dataset['sym'] = t.symbol;
    const time = new Date(t.executedAt).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const ri = tradeRichtung(t);
    tr.innerHTML = `<td>${time}</td><td style="color:var(--t1)"></td>
      <td><span class="stag ${ri.klasse}" title="${escText(ri.titel)}" aria-label="${escText(ri.titel)}">${ri.pfeil} ${escText(ri.text)}</span></td>
      <td>${t.qty}</td><td>${fmtNum(t.price)}</td>
      <td class="${t.pnl !== undefined ? pnlClass(t.pnl) : ''}">${t.pnl !== undefined ? money(t.pnl) : '—'}</td>`;
    const symTd = tr.querySelectorAll('td')[1]!;
    symTd.textContent = t.symbol;
    // Ausstiegsgrund, Strategie und Stufe als Tooltip — sie kommen vom Takt, nicht vom Nutzer.
    if (t.exitReason || t.strategy || t.stufe === 'basis') {
      symTd.title = [t.stufe === 'basis' ? uebersetze('ch.basis', sprachWahl()) : '', t.strategy, t.exitReason].filter(Boolean).join(' · ');
    }
    // Quelle „Basis" sichtbar am Symbol (Stufe aus dem Trade-Doc des Takts).
    if (t.stufe === 'basis') {
      const marke = document.createElement('span');
      marke.className = 'stag t-hold';
      marke.textContent = uebersetze('pos.basis', sprachWahl());
      symTd.append(' ', marke);
    }
    jb.appendChild(tr);
  }
}

function wireHistorie(): void {
  $('jFilter').addEventListener('input', renderJournal);
  $('jSide').addEventListener('change', renderJournal);
  $('jMore').addEventListener('click', () => void ladeAeltereTrades());
  wireSortKopf('jBody', renderJournal);
}

/* ── Performance: Equity-Kurve und Kennzahlen ───────────────────────── */

function zeitraumLabelUi(tage: Zeitraum): string {
  if (tage === 0) return t('zr.alles');
  if (tage === 365) return t('zr.jahr');
  return `${tage}${t('zr.tagKuerzel')}`;
}

/**
 * Welche Kurve gezeichnet wird: die Tages-Snapshots (Depotwert inkl.
 * offener Positionen), sobald es zwei gibt — sonst die REALISIERTE Kurve
 * aus den Abschlüssen. Die Meta-Zeile nennt die Herkunft, denn eine
 * realisierte Kurve steht still, während eine offene Position läuft.
 */
function depotKurve(quelle: { snapshots: EquitySeriesPoint[]; trades: HistoryTrade[] }): {
  serie: Array<{ date: string; equity: number }>;
  hinweis: string;
} {
  if (quelle.snapshots.length >= 2) {
    return {
      serie: quelle.snapshots,
      hinweis: `${quelle.snapshots.length} ${t('kv.tagesSnapshots')}`,
    };
  }
  const basis = st?.wallet?.baseCapital ?? st?.strategy.broker.initialCapital ?? 0;
  const geschlossen = closedOnly(quelle.trades);
  const kurve = equityCurve(geschlossen, basis).map((s) => ({ date: s.at.slice(0, 10), equity: s.value }));
  if (kurve.length === 0) return { serie: [], hinweis: t('kv.nochKeine') };
  return {
    serie: [{ date: kurve[0]!.date, equity: basis }, ...kurve],
    hinweis: `${t('kv.ausAbschluessen1')} ${geschlossen.length} ${
      geschlossen.length === 1 ? t('kv.abschluss') : t('kv.abschluesse')
    } ${t('kv.ausAbschluessen2')}`,
  };
}

/** Zeitraum-Chips der Performance-Kurve — fenstern nur die gezeichnete Kurve. */
function renderPfZeitChips(): void {
  const leiste = document.getElementById('pfZeit');
  if (!leiste || !st) return;
  leiste.innerHTML = ZEITRAEUME.map(
    (z) =>
      `<button class="tf-btn${z === st!.pfZeitraum ? ' on' : ''}" data-pfz="${z}">${esc(zeitraumLabelUi(z))}</button>`,
  ).join('');
  for (const b of leiste.querySelectorAll<HTMLButtonElement>('[data-pfz]')) {
    b.addEventListener('click', () => {
      if (!st) return;
      st.pfZeitraum = Number(b.dataset['pfz']) as Zeitraum;
      renderPfStats();
    });
  }
}

function renderPfStats(): void {
  if (!st) return;
  const s = st.pfStats;
  renderPfZeitChips();
  const zr = st.pfZeitraum;
  const ab = zeitraumBeginn(zr, new Date());
  const wahl = depotKurve({
    snapshots: ab === null ? st.equitySeries : st.equitySeries.filter((p) => Date.parse(p.date) >= ab.getTime()),
    trades: imZeitraum(st.trades as HistoryTrade[], zr, new Date()),
  });
  const serie = wahl.serie;
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
  // Die Meta-Zeile nennt das gewählte Fenster — sonst sähe eine 7-Tage-Kurve
  // aus wie die ganze Historie eines jungen Kontos.
  renderPfKurven(serie, (zr === 0 ? '' : `${zeitraumLabelUi(zr)} · `) + wahl.hinweis);

  if (!s || s.equityDays === 0) {
    grid.hidden = true;
    hint.hidden = false;
    hint.textContent = wahl.serie.length >= 2 ? wahl.hinweis : t('pf.abSnapshot');
    return;
  }
  grid.hidden = false;
  const days = s.equityDays;
  // Ehrlichkeit vor Optik: mit wenigen Snapshot-Tagen sind Sharpe & Co. noch
  // Rauschen — der Hinweis bleibt sichtbar, bis eine Woche Kurve da ist.
  hint.hidden = days >= 7;
  if (!hint.hidden) {
    hint.textContent =
      `${t('ps.erst')} ${days} ${days === 1 ? t('ps.snapshotTag') : t('ps.snapshotTage')} ${t('ps.aussagekraeftiger')}`;
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

  /* Maßstab der Trade-Kennzahlen (Befund 08.09.): Ein Nutzer sah
   * „Profit-Faktor 1.56 · Erwartung +20,63 $" direkt neben „Gesamt P&L
   * −297,47 $" und hielt das für einen Widerspruch. Beides stimmt, misst
   * aber Verschiedenes — Trefferquote, Profit-Faktor und Erwartung zählen
   * JEDEN Abschluss der Kontohistorie, Gesamt P&L zählt das Konto erst ab
   * der Kapitalbasis. Nach einem Depot-Schnitt klafft das zwangsläufig
   * auseinander, und genau dann muss es dranstehen: Gesamt P&L trägt seinen
   * Maßstab seit dem 13.08., diese drei trugen keinen. */
  const pfBasis = document.getElementById('pfBasis');
  if (pfBasis) {
    const n = typeof s.trades === 'number' ? s.trades : 0;
    const schnitt = st.wallet?.resetAt;
    const zeit = schnitt ? Date.parse(schnitt) : NaN;
    const datum = Number.isFinite(zeit) ? new Date(zeit).toLocaleDateString('de-DE') : null;
    pfBasis.hidden = n === 0;
    pfBasis.textContent =
      n === 0
        ? ''
        : `${t('pf.ueberAlleA')} ${n} ${n === 1 ? t('pf.abschluss1') : t('pf.abschlussN')}` +
          (datum ? ` ${t('pf.auchVorSchnitt')} ${datum}${t('pf.auchVorSchnittB')}` : '.');
  }
}

/**
 * Große Equity-Kurve + synchronisiertes Drawdown-Panel.
 *
 * Beide Panels zeichnen DIESELBE Serie mit DERSELBEN X-Skala — Tal in der
 * Kurve und Ausschlag im Drawdown stehen exakt untereinander. Die KENNZAHL
 * maxDD kommt weiterhin ausschließlich vom Server (Stats-Doc).
 */
function renderPfKurven(serie: Array<{ date: string; equity: number }>, herkunftHinweis = ''): void {
  const kurve = document.getElementById('pfCurve');
  const ddSvg = document.getElementById('pfDDCurve');
  const meta = document.getElementById('pfCurveMeta');
  if (!kurve || !ddSvg || !meta) return;
  if (serie.length < 2) {
    kurve.innerHTML = '';
    ddSvg.innerHTML = '';
    meta.textContent = herkunftHinweis || t('ps.nochKeineKurve');
    return;
  }
  const eq = serie.map((p) => p.equity);
  const min = Math.min(...eq);
  const max = Math.max(...eq);
  const span = max - min || 1;
  const x = (i: number): string => ((i / (eq.length - 1)) * 100).toFixed(2);
  const pts = eq.map((v, i) => `${x(i)},${(38 - ((v - min) / span) * 36).toFixed(2)}`);
  const up = eq[eq.length - 1]! >= eq[0]!;
  const farbe = up ? 'var(--gn)' : 'var(--rd)';
  const startY = (38 - ((eq[0]! - min) / span) * 36).toFixed(2);
  kurve.innerHTML =
    `<polygon points="0,40 ${pts.join(' ')} 100,40" fill="${up ? 'var(--gn-soft, rgba(52,199,123,.14))' : 'var(--rd-soft, rgba(255,95,95,.14))'}"></polygon>` +
    `<line x1="0" y1="${startY}" x2="100" y2="${startY}" stroke="var(--bd2)" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"></line>` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="${farbe}" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline>`;

  // Drawdown: Abstand zum bisherigen Hochwasser, 0 % oben, tiefster Wert unten.
  let hoch = eq[0]!;
  const dds = eq.map((v) => {
    hoch = Math.max(hoch, v);
    return hoch > 0 ? ((v - hoch) / hoch) * 100 : 0;
  });
  const tiefster = Math.min(...dds, -0.01);
  const ddPts = dds.map((d, i) => `${x(i)},${((d / tiefster) * 16).toFixed(2)}`);
  ddSvg.innerHTML =
    `<polygon points="0,0 ${ddPts.join(' ')} 100,0" fill="var(--rd-soft, rgba(255,95,95,.18))"></polygon>` +
    `<polyline points="${ddPts.join(' ')}" fill="none" stroke="var(--rd)" stroke-width="1.2" vector-effect="non-scaling-stroke"></polyline>`;

  const von = serie[0]!.date;
  const bis = serie[serie.length - 1]!.date;
  meta.textContent =
    `${von} → ${bis} · Start ${money(eq[0]!)} · ${t('ps.ende')} ${money(eq[eq.length - 1]!)} ` +
    `· ${t('ps.hoch')} ${money(max)} · ${t('ps.tief')} ${money(min)} · Drawdown ${tiefster.toFixed(2)} %` +
    (herkunftHinweis ? ` · ${herkunftHinweis}` : '');
}


/* ── Karten-Chrome: Auf-/Zuklappen mit Akkordeon in den Seitenspalten ─ */

const reduzierteBewegung = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
/** Die jeweils JÜNGSTE Klapp-Animation je Körper — nur sie darf ihr Sicherheitsnetz ziehen. */
const aktuelleKlappAnim = new WeakMap<HTMLElement, Animation>();

function setzeKlappzustand(body: HTMLElement, zu: boolean, animiert: boolean): void {
  body.getAnimations().forEach((a) => a.cancel());
  aktuelleKlappAnim.delete(body);
  if (body.hidden === zu) {
    // Schneller Doppel-Toggle: Die soeben gecancelte Zuklapp-Animation
    // hinterließe sonst dauerhaft overflow:hidden.
    body.style.overflow = '';
    return;
  }
  if (!animiert || reduzierteBewegung || typeof body.animate !== 'function') {
    body.hidden = zu;
    return;
  }
  const lauf = { duration: 260, easing: 'cubic-bezier(.4,0,.2,1)' };
  body.style.overflow = 'hidden';
  let anim: Animation;
  let abschliessen: () => void;
  if (zu) {
    anim = body.animate([{ height: `${body.scrollHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }], lauf);
    abschliessen = () => {
      body.hidden = true;
      body.style.overflow = '';
    };
  } else {
    body.hidden = false;
    anim = body.animate([{ height: '0px', opacity: 0 }, { height: `${body.scrollHeight}px`, opacity: 1 }], lauf);
    abschliessen = () => {
      body.style.overflow = '';
    };
  }
  anim.onfinish = abschliessen;
  aktuelleKlappAnim.set(body, anim);
  // Sicherheitsnetz: In gedrosselten Tabs steht die Animations-Uhr — onfinish
  // bliebe aus und die Karte hinge zwischen den Zuständen. Der Timer zieht
  // den Endzustand hart nach; hat inzwischen ein neuerer Toggle übernommen,
  // gilt dessen Zustand und der Timer tut nichts.
  window.setTimeout(() => {
    if (aktuelleKlappAnim.get(body) !== anim) return;
    aktuelleKlappAnim.delete(body);
    anim.cancel();
    abschliessen();
  }, 420);
}

/** Eingeklappte Karten anwenden (nur der Körper zu — Gerät-lokal). */
function applyCollapse(animiert = false): void {
  if (!st) return;
  document.querySelectorAll<HTMLElement>('.card[data-panel]').forEach((card) => {
    const id = card.dataset['panel'] ?? '';
    const body = card.querySelector<HTMLElement>(':scope > .cbody');
    const btn = card.querySelector<HTMLElement>(':scope > .sect [data-col]');
    const on = st!.collapsed.has(id);
    if (body) setzeKlappzustand(body, on, animiert);
    if (btn) {
      // Die Richtung zeigt die CSS-Rotation über aria-expanded — ein
      // Zeichen-Tausch (▸/▾) ließe sich nicht animieren.
      btn.textContent = '▾';
      btn.setAttribute('aria-expanded', String(!on));
    }
  });
}

/**
 * Auf-/Zuklappen einer Karte — mit Sidebar-Akkordeon: Beim AUFklappen in
 * einer Seitenspalte klappen die Geschwister derselben Spalte zu (je Spalte
 * nur eine offen). Die Mittelspalte bleibt frei: Positionen, Gründe,
 * Champion und Historie gleichzeitig zu sehen IST das Dashboard.
 */
function klappUm(id: string, card: HTMLElement): void {
  if (!st) return;
  const aufklappen = st.collapsed.has(id);
  if (aufklappen) st.collapsed.delete(id);
  else st.collapsed.add(id);
  const spalte = card.parentElement;
  const akkordeon = spalte?.id === 'leftCol' || spalte?.id === 'rightCol';
  if (aufklappen && akkordeon && spalte) {
    for (const nachbar of spalte.querySelectorAll<HTMLElement>(':scope > .card[data-panel]')) {
      const gid = nachbar.dataset['panel'] ?? '';
      if (gid && gid !== id) st.collapsed.add(gid);
    }
  }
  localStorage.setItem('autotrd-collapsed', [...st.collapsed].join(','));
  applyCollapse(true);
}

/**
 * Jede Modul-Karte bekommt ihren Kopf-Chrome: Der Klapp-Pfeil sitzt als
 * eigener Knopf ganz LINKS vor dem Titel, die GANZE Titelzeile klappt per
 * Klick. Echte Bedienelemente im Kopf (ⓘ, Badges, Auswahlfelder) bleiben
 * vom Titel-Klick unberührt.
 */
function wirePanelChrome(): void {
  document.querySelectorAll<HTMLElement>('.card[data-panel]').forEach((card) => {
    const sect = card.querySelector<HTMLElement>(':scope > .sect');
    const body = card.querySelector<HTMLElement>(':scope > .cbody');
    const id = card.dataset['panel'] ?? '';
    if (!sect || !body || !id) return;
    if (sect.querySelector(':scope > .sect-fold')) return; // idempotent — nie doppeltes Chrome
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'sect-btn sect-fold';
    fold.dataset['col'] = '';
    fold.title = t('gp.modulKlappen');
    fold.setAttribute('aria-label', t('gp.modulKlappen'));
    fold.textContent = '▾';
    sect.prepend(fold);
    // Kopf in feste Flex-Ordnung bringen: [Pfeil][Titel+ⓘ][Meta-Badges].
    const titel = document.createElement('span');
    titel.className = 'sect-titel';
    const meta = document.createElement('span');
    meta.className = 'sect-meta';
    for (const kind of [...sect.childNodes]) {
      if (kind === fold) continue;
      const istTitelTeil =
        kind.nodeType === Node.TEXT_NODE ||
        (kind instanceof HTMLElement && kind.classList.contains('ibtn'));
      (istTitelTeil ? titel : meta).appendChild(kind);
    }
    sect.appendChild(titel);
    if (meta.childNodes.length > 0) sect.appendChild(meta);
    sect.classList.add('sect-flex');

    fold.addEventListener('click', (ev) => {
      ev.stopPropagation(); // sonst klappt der Titelzeilen-Handler doppelt
      klappUm(id, card);
    });
    sect.addEventListener('click', (ev) => {
      const ziel = ev.target as HTMLElement;
      if (ziel.closest('button, input, select, label, a, .ibtn')) return;
      klappUm(id, card);
    });
  });
  applyCollapse();
}

/* ── Optionen-Modal ─────────────────────────────────────────────────── */

const MODAL_IDS = {
  options: 'optModal',
  report: 'reportModal',
  cmd: 'cmdModal',
} as const;
type ModalName = keyof typeof MODAL_IDS;

function closeModal(which: ModalName): void {
  $(MODAL_IDS[which]).classList.remove('show');
  if (which === 'cmd') cmdOffen = null;
}

function openOptions(): void {
  if (!st) return;
  $('optModal').classList.add('show');
}

/* ── Mount / Unmount ────────────────────────────────────────────────── */

export function mountDashboard(root: HTMLElement, uid: string, email: string): void {
  initInfoTips(); // ⓘ-Erklär-Popover (idempotent)
  root.innerHTML = layout(email);
  st = {
    uid,
    email,
    strategy: DEFAULT_STRATEGY,
    auto: { ...AUTO_DEFAULTS },
    autoSymbols: null,
    engine: null,
    wallet: null,
    positions: [],
    trades: [],
    tradesCursor: null,
    tradesDone: false,
    tradesLoading: false,
    tradesFehler: null,
    posPrices: new Map(),
    positionSubs: new Map(),
    pfStats: null,
    equitySeries: [],
    pfZeitraum: 0,
    health: null,
    champion: null,
    universe: [...DEFAULT_UNIVERSE],
    accessLevel: 'approved',
    admin: false,
    collapsed: new Set((localStorage.getItem('autotrd-collapsed') ?? '').split(',').filter(Boolean)),
    subs: [],
    timers: [],
  };

  // User-Doc: Schalter, Einstellungen, Wallet und Engine-Spiegel folgen Firestore
  st.subs.push(
    watchUserDoc(uid, (u) => {
      if (!st) return;
      st.accessLevel = u.accessLevel;
      renderAccessNote();
      st.admin = u.admin;
      renderAdminCard();
      st.strategy = u.strategy ?? DEFAULT_STRATEGY;
      // Ohne `settings.auto` gilt dieselbe Ableitung aus der alten Strategie
      // wie im Takt — Anzeige und Handel sehen dieselben Zahlen.
      st.auto = u.auto ? { ...AUTO_DEFAULTS, ...u.auto } : autoSettingsFromLegacy(u.strategy);
      st.autoSymbols = Array.isArray(u.auto?.symbols) ? [...u.auto.symbols] : null;
      st.wallet = u.wallet;
      st.engine = u.engine;
      renderEngineBadge(st.strategy.engine.running === true);
      renderEngineStatus();
      renderEngineCommands();
      renderEngineWhy();
      fillAutoForm();
      renderChampion();
      renderPortfolio();
      renderPfStats();
    }),
    watchPositions(uid, (positions) => {
      if (!st) return;
      st.positions = positions;
      syncPositionQuotes();
      renderPortfolio();
    }),
    // Live-Kopf: die neuesten 50. Nachgeladene ältere Seiten bleiben erhalten
    // und werden hinten angehängt.
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
      renderPfStats();
    }),
    watchPortfolioStats(uid, (stats) => {
      if (!st) return;
      st.pfStats = stats;
      // Auch das Portfolio: Die Trefferquote im Kopf stammt jetzt aus diesem
      // Dokument und bliebe sonst auf dem Notnagel aus der geladenen Seite
      // stehen, bis irgendetwas anderes ein Neuzeichnen auslöst.
      renderPortfolio();
      renderPfStats();
    }),
    watchEquitySeries(uid, (points) => {
      if (!st) return;
      st.equitySeries = points;
      renderPfStats();
    }),
    watchHealth((doc) => {
      if (!st) return;
      st.health = doc;
      renderEngineWhy();
    }),
    watchEngineConfig((cfg) => {
      if (!st) return;
      st.universe = cfg?.universe.symbols ?? [...DEFAULT_UNIVERSE];
      renderSymbolPicker();
    }),
    watchChampion((doc) => {
      if (!st) return;
      st.champion = doc;
      renderChampion();
      renderSymbolPicker();
    }),
  );

  // Herzschlag-Alter und „vor n min" altern auch ohne neue Daten.
  st.timers.push(window.setInterval(() => {
    renderEngineStatus();
    renderEngineWhy();
  }, 60_000));

  // Logo-Fallback der Symbol-Chips: kaputte Bilder weg, Monogramm bleibt.
  installiereLogoFallback();
  mountLegalFooter(root);

  // E-Mail-Verifikation: ohne bestätigte Mail bleibt der Engine-Start
  // serverseitig gesperrt — die Box erklärt das und bietet beide Aktionen an.
  $('verifyBox').hidden = emailVerified();
  ladeFaden();
  $('fadenSend').addEventListener('click', () => {
    const feld = $('fadenText') as HTMLTextAreaElement;
    const msg = $('fadenMsg');
    const text = feld.value.trim();
    if (text.length === 0) {
      msg.textContent = t('fd.leer');
      return;
    }
    const knopf = $('fadenSend') as HTMLButtonElement;
    knopf.disabled = true;
    msg.textContent = '';
    void nachrichtSenden(text)
      .then(() => {
        feld.value = '';
        msg.textContent = t('fd.gesendet');
        ladeFaden();
      })
      .catch((e: unknown) => {
        msg.textContent = serverText(e);
      })
      .finally(() => {
        knopf.disabled = false;
      });
  });
  $('verifySend').addEventListener('click', () => {
    sendVerification()
      .then(() => { $('verifyHint').textContent = t('mt.mailUnterwegs'); })
      .catch(() => { $('verifyHint').textContent = t('mt.sendenFehl'); });
  });
  $('verifyDone').addEventListener('click', () => {
    void refreshUser().then((ok) => {
      $('verifyBox').hidden = ok;
      if (!ok) $('verifyHint').textContent = t('mt.nochNichtBestaetigt');
    });
  });

  // Engine-Schalter und Kommandos
  $('engStart').addEventListener('click', () => void setEngineRunning(true));
  $('engStop').addEventListener('click', () => void setEngineRunning(false));
  $('engHalt').addEventListener('click', () => void sendeKommando('halt', '', false));
  $('engResume').addEventListener('click', () => zeigeCmdModal('resume'));
  $('engFlatten').addEventListener('click', () => zeigeCmdModal('flatten'));
  $('cmdGo').addEventListener('click', () => {
    if (!cmdOffen || !st) return;
    const ackRow = $('cmdAckRow');
    const ack = ($('cmdAck') as HTMLInputElement).checked;
    if (!ackRow.hidden && !ack) {
      $('cmdErr').textContent = t('cmd.ackFehlt');
      $('cmdErr').hidden = false;
      return;
    }
    const action = cmdOffen;
    const reason = ($('cmdReason') as HTMLInputElement).value.trim();
    closeModal('cmd');
    void sendeKommando(action, reason, !ackRow.hidden && ack);
  });

  // Einstellungen des Auto-Traders
  $('asSave').addEventListener('click', () => void submitAuto());
  $('asAlle').addEventListener('click', () => {
    $('asSymbols').querySelectorAll<HTMLInputElement>('input[data-sym]').forEach((cb) => { cb.checked = true; });
    zaehleSymbole();
  });
  $('asKeine').addEventListener('click', () => {
    $('asSymbols').querySelectorAll<HTMLInputElement>('input[data-sym]').forEach((cb) => { cb.checked = false; });
    zaehleSymbole();
  });
  /* Das Formular speichert erst per Knopf. Wer etwas ändert und die Karte
   * verlässt, verliert die Änderung STILL — deshalb sagt die Karte ab der
   * ersten Änderung sichtbar, dass noch nichts gespeichert ist. */
  for (const box of [$('asGrid'), $('asSymbols')]) {
    box.addEventListener('input', () => {
      const m = $('asMsg');
      if (m.textContent !== t('mt.speichere')) m.textContent = `⚠ ${t('mt.nichtGespeichert')}`;
    });
  }

  // Champion-Bericht
  $('chReport').addEventListener('click', () => void openReport());

  // Historie
  wireHistorie();

  // Admin
  $('admReload').addEventListener('click', () => void loadAdminList().then(ladeKillSwitch));
  $('admSuche').addEventListener('input', admFiltere);
  $('admArchiv').addEventListener('change', admFiltere);
  $('admKillBtn').addEventListener('click', () => {
    const btn = $('admKillBtn') as HTMLButtonElement;
    const anschalten = btn.dataset['an'] === '1';
    // Der Not-Aus selbst kommt OHNE Rückfrage aus — im Ernstfall zählt jede
    // Sekunde. Nur das LÖSEN fragt nach, denn danach fließt wieder Echtgeld.
    if (!anschalten && !confirm(t('mt.notAusLoesen'))) return;
    btn.disabled = true;
    adminSetKillSwitch(anschalten)
      .then(ladeKillSwitch)
      .catch((e: unknown) => {
        const err = $('admErr');
        err.textContent = serverText(e);
        err.hidden = false;
      })
      .finally(() => { btn.disabled = false; });
  });

  // Modals schließen — delegiert, damit auch dynamisch erzeugte ✕ treffen.
  document.addEventListener('click', (e) => {
    const ziel = (e.target as HTMLElement).closest<HTMLElement>('[data-close]');
    const name = ziel?.dataset['close'];
    if (name && name in MODAL_IDS) closeModal(name as ModalName);
  }, { signal: docListenerSignal() });

  // Mobile Schubladen und Desktop-Spalten
  $('burgL').addEventListener('click', () => { $('leftCol').classList.toggle('show'); $('olv').classList.toggle('show'); });
  $('burgR').addEventListener('click', () => { $('rightCol').classList.toggle('show'); $('olv').classList.toggle('show'); });
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
  $('olv').addEventListener('click', () => {
    for (const id of ['leftCol', 'rightCol']) $(id).classList.remove('show');
    $('olv').classList.remove('show');
  });

  /* Theme-Wahl: Drei Zustände in Optionen → Anzeige. 'system' folgt
   * prefers-color-scheme — auch LIVE, wenn das Gerät umschaltet. */
  const themeWahl = (): 'system' | 'light' | 'dark' => {
    const w = localStorage.getItem('autotrd-theme');
    return w === 'light' || w === 'dark' ? w : 'system';
  };
  const systemDunkel = window.matchMedia?.('(prefers-color-scheme: dark)');
  const wendeThemeAn = (): void => {
    const wahl = themeWahl();
    document.documentElement.dataset['theme'] =
      wahl === 'system' ? (systemDunkel?.matches === false ? 'light' : 'dark') : wahl;
  };
  const ouTheme = $('ouTheme') as HTMLSelectElement;
  ouTheme.value = themeWahl();
  ouTheme.addEventListener('change', () => {
    localStorage.setItem('autotrd-theme', ouTheme.value);
    wendeThemeAn();
  });
  systemDunkel?.addEventListener?.('change', () => {
    if (themeWahl() !== 'system') return;
    wendeThemeAn();
  });
  /* Sprachwahl: Wahl speichern und die App neu laden — der Reload ist der
   * ehrliche Schnitt, ein halb neu gerendertes UI die fehleranfälligste Variante. */
  const ouLang = $('ouLang') as HTMLSelectElement;
  ouLang.value = sprachWahl();
  ouLang.addEventListener('change', () => {
    setzeSprache(ouLang.value === 'en' ? 'en' : 'de');
    location.reload();
  });

  // Options-Modal (⚙)
  $('optBtn').addEventListener('click', openOptions);
  $('owTabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.otab') as HTMLElement | null;
    if (!btn) return;
    const ziel = btn.dataset['otab'];
    document.querySelectorAll('#owTabs .otab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#optModal [data-opane]').forEach((p) => {
      (p as HTMLElement).hidden = (p as HTMLElement).dataset['opane'] !== ziel;
    });
  });
  // Zwei Stufen: Der Knopf bleibt gesperrt, bis das Wort exakt dasteht.
  // Serverseitig wird dasselbe Wort noch einmal geprüft.
  $('rsWord').addEventListener('input', () => {
    ($('rsGo') as HTMLButtonElement).disabled =
      ($('rsWord') as HTMLInputElement).value.trim() !== RESET_CONFIRM_WORD;
  });
  $('logoutBtn').addEventListener('click', () => void logout());

  /* ── Echtgeld-Schalter ─────────────────────────────────────────────── */
  const ladeLiveStatus = (): void => {
    void callLiveMode({ action: 'status' })
      .then((r) => {
        renderLiveStatus(r.status ?? null, st?.strategy.broker.mode === 'live');
      })
      .catch(() => {
        const el = document.getElementById('lvState');
        if (el) el.textContent = t('mt.zustandNichtAbrufbar');
      });
  };
  $('optBtn').addEventListener('click', ladeLiveStatus);

  $('lvGo').addEventListener('click', () => {
    const btn = $('lvGo') as HTMLButtonElement;
    const wort = ($('lvWord') as HTMLInputElement).value.trim();
    btn.disabled = true;
    $('lvOut').innerHTML = `<div class="hint">${t('mt.bestaetigeAnmeldung')}</div>`;
    // Erst Anmeldung auffrischen, dann senden: Der Server prüft `auth_time`.
    void frischAnmelden(($('lvPw') as HTMLInputElement).value || undefined)
      .then(() => {
        $('lvOut').innerHTML = `<div class="hint">${t('mt.schalteScharf')}</div>`;
        return callLiveMode({ live: true, bestaetigung: wort });
      })
      .then((r) => {
        ($('lvWord') as HTMLInputElement).value = '';
        ($('lvPw') as HTMLInputElement).value = '';
        $('lvOut').innerHTML = `<div class="hint">${escText(r.meldung)}</div>`;
        renderLiveStatus(null, true);
      })
      .catch((e) => {
        $('lvOut').innerHTML = `<div class="hint">${escText(serverText(e))}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  // Zurück auf Papier: sofort, ohne Bestätigung. Eine Sicherung, die das
  // ABSCHALTEN erschwert, ist keine Sicherung.
  $('lvOff').addEventListener('click', () => {
    const btn = $('lvOff') as HTMLButtonElement;
    btn.disabled = true;
    void callLiveMode({ live: false })
      .then((r) => {
        $('lvOut').innerHTML = `<div class="hint">${escText(r.meldung)}</div>`;
        ladeLiveStatus();
      })
      .catch((e) => {
        $('lvOut').innerHTML = `<div class="hint">${escText(serverText(e))}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  // Echtgeld-Feld ein-/ausblenden, sobald erkennbar ist, was eingegeben wird.
  $('bkKey').addEventListener('input', () => {
    const ist = ($('bkKey') as HTMLInputElement).value.trim().toUpperCase().startsWith('AK');
    ($('bkLiveBox') as HTMLElement).hidden = !ist;
  });
  $('bkSave').addEventListener('click', () => {
    const btn = $('bkSave') as HTMLButtonElement;
    const key = ($('bkKey') as HTMLInputElement).value.trim();
    const sec = ($('bkSec') as HTMLInputElement).value.trim();
    if (!key || !sec) {
      $('bkOut').innerHTML = `<div class="hint">${t('mt.beideSchluessel')}</div>`;
      return;
    }
    const istLive = key.toUpperCase().startsWith('AK');
    btn.disabled = true;
    // Bei Echtgeld ZUERST die Anmeldung auffrischen, dann senden — der
    // Server prüft `auth_time` aus dem ID-Token.
    const vorbereitet = istLive
      ? (() => {
          $('bkOut').innerHTML = `<div class="hint">${t('mt.bestaetigeAnmeldung')}</div>`;
          return frischAnmelden(($('bkPw') as HTMLInputElement).value || undefined);
        })()
      : Promise.resolve();
    void vorbereitet
      .then(() => {
        $('bkOut').innerHTML = `<div class="hint">${t('mt.pruefeSchluessel')}</div>`;
        return callConnectBroker(key, sec);
      })
      .then((r) => {
        // Eingaben SOFORT leeren: Der Schlüssel soll nach dem Absenden nicht
        // weiter im Formular stehen.
        ($('bkKey') as HTMLInputElement).value = '';
        ($('bkSec') as HTMLInputElement).value = '';
        ($('bkPw') as HTMLInputElement).value = '';
        ($('bkLiveBox') as HTMLElement).hidden = true;
        $('bkOut').innerHTML =
          `<div class="hint">✓ ${escText(r.maskiert)} ${t('mt.verbunden')} — ` +
          `${escText(r.kontoStatus)}, ${r.cash.toFixed(2)} $ ${t('br.barbestand')}. ` +
          `${escText(r.meldung)}</div>`;
      })
      .catch((e) => {
        $('bkOut').innerHTML = `<div class="hint">${escText(serverText(e))}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  $('bkDel').addEventListener('click', () => {
    const btn = $('bkDel') as HTMLButtonElement;
    btn.disabled = true;
    void callDisconnectBroker()
      .then((r) => {
        const teile = [r.geloescht ? t('mt.verbindungGetrennt') : t('mt.nichtsVerbunden')];
        const o = r.orders;
        if (o && o.storniert + o.gefuellt > 0) {
          teile.push(t('mt.ordersStorniert').replace('{0}', String(o.storniert + o.gefuellt)));
        }
        if (o && o.gefuellt > 0) teile.push(t('mt.ordersGefuellt').replace('{0}', String(o.gefuellt)));
        if ((o && (o.fehler > 0 || o.listeFehlgeschlagen || o.moeglicherweiseUnvollstaendig)) || r.sweepUnmoeglich) {
          teile.push(t('mt.ordersRest'));
        }
        if (r.liveOrdersBleiben) teile.push(t('mt.ordersLiveBleiben'));
        $('bkOut').innerHTML = `<div class="hint">${teile.join(' ')}</div>`;
      })
      .catch((e) => {
        $('bkOut').innerHTML = `<div class="hint">${escText(serverText(e))}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  $('bkGo').addEventListener('click', () => {
    const btn = $('bkGo') as HTMLButtonElement;
    btn.disabled = true;
    $('bkOut').innerHTML = `<div class="hint">${t('mt.pruefeVerbindung')}</div>`;
    void callBrokerStatus()
      .then((r) => {
        $('bkOut').innerHTML = renderBrokerStatus(r);
      })
      .catch((e) => {
        $('bkOut').innerHTML = `<div class="hint">${escText(serverText(e))}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });

  // Steuer-Export: Jahresauswahl füllen (laufendes Jahr und die fünf davor).
  const txYear = $('txYear') as HTMLSelectElement;
  if (txYear.options.length === 0) {
    const jetzt = new Date().getUTCFullYear();
    for (let j = jetzt; j >= jetzt - 5; j--) {
      const o = document.createElement('option');
      o.value = String(j);
      o.textContent = String(j);
      txYear.appendChild(o);
    }
  }
  $('txGo').addEventListener('click', () => {
    const btn = $('txGo') as HTMLButtonElement;
    const jahr = Number(txYear.value);
    const echtgeld = ($('txReal') as HTMLInputElement).checked;
    btn.disabled = true;
    $('txOut').innerHTML = `<div class="hint">${t('mt.rechne')}</div>`;
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
        $('txOut').innerHTML = `<div class="hint">${escText(serverText(e))}</div>`;
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
  // Kurs-Nachtrag: Der Knopf entsteht erst MIT dem Bericht — deshalb
  // Delegation auf dem Container.
  $('txOut').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('#txFx') as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t('mt.trageNach');
    void callFxNachtragen()
      .then((r) => {
        btn.textContent =
          `✓ ${r.nachgetragen} ${t('mt.kurseEingefroren')}` +
          (r.ohneKurs > 0 ? `, ${r.ohneKurs} ${t('mt.ohneKurs')}` : '') +
          ` — ${t('mt.berichtNeu')}`;
      })
      .catch((err) => {
        btn.disabled = false;
        btn.textContent = serverText(err);
      });
  });
  $('rsGo').addEventListener('click', () => {
    const btn = $('rsGo') as HTMLButtonElement;
    btn.disabled = true;
    $('rsMsg').textContent = t('mt.setzeZurueck');
    void resetWallet(RESET_CONFIRM_WORD, ($('rsFromBroker') as HTMLInputElement).checked)
      .then((r) => {
        const n = Object.entries(r.deleted)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        const quelle = r.kapitalQuelle === 'broker' ? ` (${t('mt.vomBroker')})` : '';
        $('rsMsg').textContent =
          `✓ ${t('mt.zurueckgesetzt')} (${n || t('mt.nichtsZuLoeschen')}) — ${t('mt.kontostand')} ${r.balance} $${quelle}`
          + (r.hinweis ? ` — ${r.hinweis}` : '');
        ($('rsWord') as HTMLInputElement).value = '';
      })
      .catch((e) => {
        $('rsMsg').textContent = serverText(e);
        btn.disabled = false;
      });
  });

  document.addEventListener('keydown', onEscape);
}

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeModal('options');
  closeModal('report');
  closeModal('cmd');
  for (const id of ['leftCol', 'rightCol']) document.getElementById(id)?.classList.remove('show');
  document.getElementById('olv')?.classList.remove('show');
}

/**
 * Abbruch-Signal je Dashboard-Lauf für die ANONYMEN document-Listener:
 * Ein einziges `abort()` löst sie alle; der nächste Mount bekommt ein
 * frisches Signal. Ohne das sammelten sie sich je Login-Zyklus an und
 * schrieben nach dem Abmelden in ein DOM, das es nicht mehr gibt.
 */
let docListenerAbort: AbortController | null = null;
function docListenerSignal(): AbortSignal {
  docListenerAbort ??= new AbortController();
  return docListenerAbort.signal;
}

/**
 * Modulglobalen Zustand zurücksetzen — beim Abmelden und beim Nutzerwechsel.
 *
 * `unmountDashboard` räumt, was im `st`-Objekt hängt. Alles, was als
 * Modulvariable daneben liegt, überlebte das Abmelden sonst: die Admin-Liste
 * des Vorgängers (fremde Konten beim Nutzerwechsel), ein armierter
 * Admin-Knopf samt Timer, eine offene Kommando-Bestätigung, die
 * Tabellen-Sortierung und die anonymen document-Listener.
 */
export function setzeModulZustandZurueck(): void {
  docListenerAbort?.abort();
  docListenerAbort = null;
  admEntwaffne();
  admZeilen = [];
  admOffenerStreifen = null;
  cmdOffen = null;
  sortZustand.jn = null;
}

export function unmountDashboard(): void {
  if (!st) return;
  for (const u of st.subs) u();
  st.subs.length = 0;
  for (const u of st.positionSubs.values()) u();
  st.positionSubs.clear();
  for (const t of st.timers) clearInterval(t);
  document.removeEventListener('keydown', onEscape);
  // Zuletzt, damit ein Fehler weiter oben den Modulzustand nicht halb
  // zurückgesetzt hinterlässt — und weil `st = null` danach kommt.
  setzeModulZustandZurueck();
  st = null;
}
