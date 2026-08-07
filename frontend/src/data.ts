/**
 * Datenschicht — ausschließlich Firestore (`onSnapshot`/`getDocs`) und
 * Callables; kein fetch-Polling, kein /api/* (MILESTONES M3).
 */

import {
  type GlobalAxisStats,
  type KanteJeTrade,
  type Position,
  type Quote,
  type ReifeBefund,
  type Steuerbericht,
  type Strategy,
  type Wallet,
} from '@autotrd/shared';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot as fsOnSnapshot,
  orderBy,
  query,
  setDoc,
  startAfter,
  updateDoc,
  where,
  documentId,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';

// ── Listener-Buchhaltung (M9): jeder onSnapshot läuft über diesen Wrapper,
// damit Panel-Wechsel nachweislich keine Listener leaken (E2E-Zähler).
// Der Zähler liegt in listeners.ts statt hier, damit ihn auch Module
// hochzählen können, die data.ts nicht importieren.
import { listenerCount, trackListener } from './listeners.js';

export { listenerCount };

const onSnapshot = ((...args: Parameters<typeof fsOnSnapshot>): Unsubscribe =>
  trackListener(
    (fsOnSnapshot as (...a: unknown[]) => Unsubscribe)(...args),
  )) as typeof fsOnSnapshot;
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from './firebase.js';
import { muxWatch } from './mux.js';
import type { ChartBar } from './chart.js';

export interface MarketDocData {
  name?: string;
  assetClass?: string;
  quote?: Quote;
  /** News-Lage (News-Rückkehr 29.07.): Veto-Grundlage + Schlagzeilen-Anzeige. */
  news?: import('@autotrd/shared').NewsSnapshot | null;
  forecast?: {
    points: Array<{ time: string; value: number }>;
    band: Array<{ time: string; upper: number; lower: number }>;
    lookback: number;
    predictedPct: number;
    baseDate: string;
    /** Band-Kalibrierung aus realisierter Fehlerverteilung (null = ±1σ Regression). */
    calib?: { s: number; maePct: number; n: number } | null;
  } | null;
  /** Kurzfrist-Prognose (nächste Stunde, 5-min-Raster) — je Scan erneuert. */
  forecastIntraday?: {
    points: Array<{ t: number; value: number }>;
    band: Array<{ t: number; upper: number; lower: number }>;
    lookback: number;
    predictedPct: number;
    baseT: number;
    updatedAt: string;
    calib?: { s: number; maePct: number; n: number } | null;
  } | null;
}

/** Aggregat je Lookback-Fenster — Rohmaterial des Self-Tunings. */
export interface ComboStatRow {
  n: number;
  hits: number;
  maeSum: number;
}

export interface ForecastStatsDoc {
  scored?: number;
  dirAccuracy?: number | null;
  best?: { lookback: number };
  tuningActive?: boolean;
  combos?: Record<string, ComboStatRow>;
  updatedAt?: string;
}

export function watchForecastStats(cb: (stats: ForecastStatsDoc | null) => void): Unsubscribe {
  return muxWatch(
    'forecastStats',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'forecastStats'), (snap) =>
        emit(snap.exists() ? snap.data() : null),
      ),
    (p) => cb(p as ForecastStatsDoc | null),
  );
}

/** Kurzfrist-Lernstatistik (meta/forecastStatsIntraday) — gleiche Struktur. */
export function watchForecastStatsIntraday(
  cb: (stats: ForecastStatsDoc | null) => void,
): Unsubscribe {
  return muxWatch(
    'forecastStatsIntraday',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'forecastStatsIntraday'), (snap) =>
        emit(snap.exists() ? snap.data() : null),
      ),
    (p) => cb(p as ForecastStatsDoc | null),
  );
}

/** Was die Engine im letzten Scan angefasst hat — zwei Tiefen, eine Quelle. */
export interface WatchScope {
  /** Tief analysiert: 5-min-Kerzen, Indikatoren, Prognose, Handelsentscheidung. */
  symbols: string[];
  /** Katalog-Symbole mit offenem Markt in diesem Scan. */
  catalogOpen: number;
  /** Davon frisch bekurst (Spark-Bündel). Weicht ab ⇒ ein Chunk hat gepatzt. */
  catalogQuotes: number;
}

/**
 * Die Symbole, die die Engine gerade beobachtet und handelt.
 *
 * Quelle ist der Heartbeat des Scans, nicht eine gespeicherte Auswahl: Was
 * das Dashboard zeigt, MUSS das sein, was die Engine tatsächlich anfasst.
 * Bis 28.07. war es eine handverlesene Watchlist — die Anzeige konnte also
 * Symbole zeigen, die längst nicht mehr gehandelt wurden, und umgekehrt.
 *
 * `symbols` ist dabei nur die TIEFE Stufe. Kurse bekommt seit dem
 * Batch-Umbau der ganze Katalog bei jedem Scan (Owner-Frage: „kann das tool
 * nicht alles immer parallel beobachten?"); `catalogOpen`/`catalogQuotes`
 * machen das sichtbar, statt es dem Nutzer als „nur xx Symbole" zu zeigen.
 */
export function watchWatchedSymbols(cb: (scope: WatchScope) => void): Unsubscribe {
  return muxWatch(
    'watched',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'health'), (snap) =>
        emit(
          snap.exists()
            ? {
                symbols: (snap.get('watched') as string[] | undefined) ?? [],
                catalogOpen: (snap.get('catalogOpen') as number | undefined) ?? 0,
                catalogQuotes: (snap.get('catalogQuotes') as number | undefined) ?? 0,
              }
            : { symbols: [], catalogOpen: 0, catalogQuotes: 0 },
        ),
      ),
    (p) => cb(p as WatchScope),
  );
}

/** Bewertete Shadow-Prognose (market/{sym}/forecasts) fürs Prognose-Labor. */
export interface EvaluatedForecastRow {
  baseDate: string;
  lookback: number;
  predictedPct: number;
  evaluated: boolean;
  evaluatedAt?: string;
  maePct?: number;
  dirHit?: boolean;
  nPoints?: number;
}

/**
 * Letzte bewertete Prognosen eines Symbols (Vorhersage vs. Realität).
 * orderBy(evaluatedAt) filtert implizit auf bewertete Docs — unbewertete
 * haben das Feld nicht und fehlen im Index (kein Composite-Index nötig).
 */
export function watchEvaluatedForecasts(
  symbol: string,
  cb: (rows: EvaluatedForecastRow[]) => void,
): Unsubscribe {
  return muxWatch(
    `fclab:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'forecasts'),
        orderBy('evaluatedAt', 'desc'),
        limit(8),
      );
      return onSnapshot(q, (snap) => emit(snap.docs.map((d) => d.data())));
    },
    (p) => cb(p as EvaluatedForecastRow[]),
  );
}

export interface SignalRow {
  direction: 'buy' | 'sell' | 'hold';
  buyVotes: number;
  sellVotes: number;
  requiredConfluence: number;
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger', 'buy' | 'sell' | 'hold'>>;
  price: number;
  at: string;
  /** Genauigkeitsgewichtetes Prognose-Stimmgewicht dieses Scans (Teil 4). */
  forecastVote?: { base: number; weight: number; factor: number | null };
}

export interface IndicatorRow {
  rsi: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  bollinger: { upper: number; middle: number; lower: number; pctB: number } | null;
}

const useEmulators = import.meta.env.VITE_FIREBASE_USE_EMULATORS === '1';
let fnsEmulatorConnected = false;

function fns(): ReturnType<typeof getFunctions> {
  const f = getFunctions(getApp());
  if (!fnsEmulatorConnected && useEmulators) {
    connectFunctionsEmulator(f, '127.0.0.1', 5001);
    fnsEmulatorConnected = true;
  }
  return f;
}

/** Profil (users/{uid}) serverseitig anlegen, falls es noch fehlt. */
export async function ensureProfile(): Promise<void> {
  await httpsCallable(fns(), 'ensureProfile')({});
}

/**
 * Handelshistorie, Positionen und Kennzahlen auf null — Kursdaten bleiben.
 *
 * Das Bestätigungswort geht mit auf die Leitung und wird SERVERSEITIG noch
 * einmal geprüft. Ein Client-Guard allein wäre bei einer unumkehrbaren
 * Aktion keine Sicherung, nur eine Bequemlichkeit.
 */
export async function resetWallet(
  confirm: string,
  /**
   * Startkapital vom verbundenen Broker holen statt aus den Einstellungen.
   *
   * Nur beim Reset moeglich, nicht laufend: Der Kontostand ist die
   * Bezugsgroesse jeder Kennzahl. Wechselt er mitten in der Messung, beziehen
   * sich alte und neue Zahlen auf verschiedene Kapitalbasen.
   */
  vomBroker = false,
): Promise<ResetWalletResult> {
  const r = await httpsCallable(fns(), 'resetWallet')({ confirm, vomBroker });
  return r.data as ResetWalletResult;
}

/** Tages-Notbremse von Hand entriegeln (M12). */
export async function resetBreaker(): Promise<{ ok: true; warAusgeloest: boolean }> {
  const r = await httpsCallable(fns(), 'resetBreaker')({});
  return r.data as { ok: true; warAusgeloest: boolean };
}

export interface ResetWalletResult {
  ok: true;
  deleted: Record<string, number>;
  balance: number;
  resetAt: string;
  /** Woher der Startwert kam — „100.000 $" ohne Herkunft lässt offen, ob der
   *  Broker gefragt wurde oder die Einstellung gegriffen hat. */
  kapitalQuelle: 'einstellung' | 'broker';
  /** Warnung, wenn beim Broker noch Positionen liegen — der Reset leert nur
   *  das Buch, nie das Depot (Vorfall 05.08.). */
  hinweis?: string;
}

export interface TaxReportResult {
  ok: true;
  bericht: Steuerbericht;
  csv: string;
  gelesen: number;
  historieUnvollstaendig: boolean;
}

/**
 * Jahres-Steuerbericht serverseitig rechnen lassen.
 *
 * Bewusst KEIN Client-Rechenweg: Der Bericht braucht die volle Historie
 * inklusive Archiv, und die liegt hinter den Firestore-Regeln. Ihn im Browser
 * zu rechnen hieße, alle Trades aller Jahre zu laden — teuer und langsam,
 * ohne dass der Nutzer etwas davon hätte.
 */
export async function callTaxReport(jahr: number, echtgeld: boolean): Promise<TaxReportResult> {
  const r = await httpsCallable(fns(), 'taxReport')({ jahr, echtgeld });
  return r.data as TaxReportResult;
}

/** Fehlende Wechselkurse historischer Trades einfrieren (Kurs des Handelstages). */
export interface FxNachtragErgebnis {
  ok: true;
  geprueft: number;
  nachgetragen: number;
  ohneKurs: number;
}
export async function callFxNachtragen(): Promise<FxNachtragErgebnis> {
  const r = await httpsCallable(fns(), 'fxNachtragen')({});
  return r.data as FxNachtragErgebnis;
}

export interface BrokerStatusResult {
  ok: true;
  modus: 'paper' | 'live';
  wunschLive: boolean;
  envFreigabe: boolean;
  schluesselVorhanden: boolean;
  reife: ReifeBefund;
  kante: KanteJeTrade;
  konto: {
    id: string;
    status: string;
    currency: string;
    cash: number;
    equity: number;
    buyingPower: number;
    tradingBlocked: boolean;
    accountBlocked: boolean;
    patternDayTrader: boolean;
  } | null;
  abweichungen: Array<{
    symbol: string;
    eigeneMenge: number;
    brokerMenge: number;
    differenz: number;
  }>;
  meldung: string;
  fehler?: string;
}

/**
 * Zustand der Broker-Anbindung prüfen, ohne zu handeln.
 *
 * Bewusst ein reiner Lese-Aufruf: Wer die Anbindung erst beim ersten Trade
 * testet, testet sie mit Geld.
 */
export async function callBrokerStatus(): Promise<BrokerStatusResult> {
  const r = await httpsCallable(fns(), 'brokerStatus')({});
  return r.data as BrokerStatusResult;
}

export interface ConnectResult {
  ok: true;
  maskiert: string;
  /** Papier- oder Echtgeldkonto — bestimmt, wie die Karte es anzeigt. */
  art: 'paper' | 'live';
  /** Liegt das Geheimnis verschlüsselt? Bei Echtgeld immer `true`. */
  verschluesselt: boolean;
  kontoStatus: string;
  cash: number;
  equity: number;
  meldung: string;
}

/**
 * Eigenes Alpaca-PAPIERKONTO verbinden.
 *
 * Die Schlüssel gehen einmal zum Server und kommen nie zurück — auch nicht
 * an den, der sie gerade gesetzt hat. Was zurückkommt, ist der Kontostatus
 * und eine maskierte Kennung. Echtgeld-Schlüssel (AK…) weist der Server ab.
 */
export async function callConnectBroker(
  apiKey: string,
  secretKey: string,
): Promise<ConnectResult> {
  const r = await httpsCallable(fns(), 'connectBroker')({ apiKey, secretKey });
  return r.data as ConnectResult;
}

export interface LiveModeStatus {
  reife: {
    bereit: boolean;
    erfuellt: number;
    gesamt: number;
    fazit: string;
    kriterien: { name: string; erfuellt: boolean; ist: string; soll: string }[];
  };
  brokerArt: 'paper' | 'live' | null;
  serverFreigabe: boolean;
}

export interface LiveModeErgebnis {
  ok: true;
  modus: 'paper' | 'live';
  meldung: string;
  status?: LiveModeStatus;
}

/**
 * Echtgeld-Schalter (M14) — abfragen oder umlegen.
 *
 * Der Server entscheidet, nicht der Client: Reife, verbundene Kontoart und
 * die Frische der Anmeldung werden dort geprüft. Die Oberfläche zeigt nur,
 * was zurückkommt — sonst gäbe es zwei Fassungen derselben Regel, und die
 * im Browser wäre die, die zuerst veraltet.
 */
export async function callLiveMode(
  arg: { action: 'status' } | { live: boolean; bestaetigung?: string },
): Promise<LiveModeErgebnis> {
  const r = await httpsCallable(fns(), 'setLiveMode')(arg);
  return r.data as LiveModeErgebnis;
}

export interface AdoptResult {
  ok: true;
  positionen: number;
  geloescht: number;
  trades: number;
  cash: number;
  meldung: string;
}

/**
 * Depot vom Broker ins Buch übernehmen (Vorfall 05.08.).
 *
 * Liest Bestand, Einstände, Barbestand und die eigene Order-Historie vom
 * Broker und schreibt das Buch darauf um — kauft und verkauft NICHTS. Der
 * Weg zurück zur einen Wahrheit, wenn Buch und Depot auseinandergelaufen
 * sind (z. B. nach „Neu anfangen" mit verbundenem Broker).
 */
export async function callAdoptBroker(): Promise<AdoptResult> {
  const r = await httpsCallable(fns(), 'adoptBroker')({});
  return r.data as AdoptResult;
}

/** Verbindung lösen — der Server löscht das Schlüsselpaar. */
export async function callDisconnectBroker(): Promise<{ ok: true; geloescht: boolean }> {
  const r = await httpsCallable(fns(), 'connectBroker')({ action: 'disconnect' });
  return r.data as { ok: true; geloescht: boolean };
}

/** Strategie serverseitig validieren + speichern (flaches Schema). */
export async function saveStrategy(strategy: Strategy): Promise<void> {
  await httpsCallable(fns(), 'saveStrategy')({ strategy });
}

export function watchMarketDoc(
  symbol: string,
  cb: (data: MarketDocData | null) => void,
): Unsubscribe {
  return muxWatch(
    `marketDoc:${symbol}`,
    (emit) =>
      onSnapshot(doc(db(), 'market', symbol), (snap) => emit(snap.exists() ? snap.data() : null)),
    (p) => cb(p as MarketDocData | null),
  );
}

export function watchBars(symbol: string, cb: (bars: ChartBar[]) => void): Unsubscribe {
  return muxWatch(
    `bars:${symbol}`,
    (emit) => {
      const q = query(collection(db(), 'market', symbol, 'bars'), orderBy(documentId()));
      return onSnapshot(q, (snap) =>
        emit(snap.docs.map((d) => ({ date: d.id, ...(d.data() as Omit<ChartBar, 'date'>) }))),
      );
    },
    (p) => cb(p as ChartBar[]),
  );
}

// Achtung: Firestore unterstützt KEINE absteigenden Key-Scans
// (orderBy(documentId(), 'desc')) — deshalb sortieren beide Queries über
// echte Felder (`at` bzw. `date`), die der Scan mitschreibt.
export function watchLatestSignal(
  symbol: string,
  cb: (sig: SignalRow | null) => void,
): Unsubscribe {
  return muxWatch(
    `signal:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'signals'),
        orderBy('at', 'desc'),
        limit(1),
      );
      return onSnapshot(q, (snap) => emit(snap.empty ? null : snap.docs[0]!.data()));
    },
    (p) => cb(p as SignalRow | null),
  );
}

export function watchLatestIndicators(
  symbol: string,
  cb: (row: IndicatorRow | null) => void,
): Unsubscribe {
  return muxWatch(
    `indicators:${symbol}`,
    (emit) => {
      const q = query(
        collection(db(), 'market', symbol, 'indicators'),
        orderBy('date', 'desc'),
        limit(1),
      );
      return onSnapshot(q, (snap) => emit(snap.empty ? null : snap.docs[0]!.data()));
    },
    (p) => cb(p as IndicatorRow | null),
  );
}

/** Optionale UI-Elemente (Options-Modal ⚙, settings.ui) — synct über Geräte. */
export interface UiPrefs {
  /** Prognose-Pfeil ✏ — Opt-in (Feedback 25.07.): default AUS, gilt auch für den Scan-Vote. */
  predArrow?: boolean;
  /** Vergleichs-Overlay-Eingabe im Chart (default an). */
  cmpOverlay?: boolean;
  /** Multi-Chart-Raster-Umschalter 1/2/4 (default an). */
  chartGrid?: boolean;
  /** Indikator-Extras: VWAP-Chip + RSI/MACD-Unterpanels (default an). */
  subPanels?: boolean;
  /** Marktgruppen-Filter (Taschenmesser Teil 2): Klassen-Key → sichtbar?
   *  Fehlender Eintrag = sichtbar (Opt-out-Filter, default alles an). */
  marketGroups?: Record<string, boolean>;
  /** Onboarding-Tour (MU2) gesehen? Auch Abbrechen zählt — der ?-Knopf im
   *  Header holt sie jederzeit zurück, aufgedrängt wird sie nur einmal. */
  tourGesehen?: boolean;
}

export function watchUserDoc(
  uid: string,
  cb: (data: {
    strategy: Strategy | null;
    wallet: Wallet | null;
    /** Nutzer-Hotkeys (M9, settings.hotkeys) — z. B. { palette, buy, sell }. */
    hotkeys: Record<string, string> | null;
    ui: UiPrefs | null;
    /** Auto-Tuner-Schalter (MT5). Fehlt das Feld, ist der Tuner AN. */
    autoTune: boolean;
    /**
     * Zugangsstufe (Owner 26.07.): 'pending' = angelegt, wartet auf
     * Freischaltung — der Scan überspringt das Konto STILL. Genau deshalb
     * muss die Oberfläche es zeigen (Fund 01.08.: „Engine fängt bei neuem
     * Konto nicht an zu handeln" — sie lief, das Konto war nur nicht frei).
     * Fehlendes Feld = Bestandskonto = freigeschaltet.
     */
    accessLevel: 'pending' | 'approved' | 'blocked';
    /** Kontotyp (Owner 02.08.): Admins sehen die Freischaltungs-Karte.
     *  Das Feld setzt NUR die Konsole bzw. das adminUsers-Callable —
     *  Client-Updates auf dem User-Doc erlauben die Rules nur für `settings`. */
    admin: boolean;
    /**
     * Zustand der Tages-Notbremse (M12) — `null`, solange sie nicht
     * ausgelöst ist. Gehört an dieselbe Stelle wie die Strategie, weil die
     * Oberfläche beides gemeinsam zeigt: die Grenze und ob sie greift.
     */
    breaker: { am: string; grund: string; verlustPct: number | null } | null;
    /**
     * Letzter automatischer Abgleich Buch ↔ Broker-Depot (M13) — `null`,
     * solange kein Broker verbunden ist oder noch kein Scan gelaufen ist.
     *
     * Die Anzeige ist der eigentliche Zweck der Verbindung, nicht Beiwerk:
     * Wer sein Konto verbindet, will sehen, ob die Order dort ankommt.
     * Ohne diese Zeile sieht ein sauberer Abgleich exakt aus wie gar keiner.
     */
    abgleich: {
      at: string;
      status: string;
      anzahl: number;
      /** Im Buch, aber nicht beim Broker — das ist die gefährliche Richtung. */
      fehlbestand: number;
      /** Nur beim Broker — Fremdbestand, sperrt nicht. */
      fremdbestand: number;
      verglichen: number;
      brokerPositionen: number;
      fehler: string;
    } | null;
  }) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid), (snap) => {
    const rawAccess = snap.get('accessLevel') as string | undefined;
    cb({
      accessLevel: rawAccess === 'pending' || rawAccess === 'blocked' ? rawAccess : 'approved',
      admin: snap.get('admin') === true,
      strategy: (snap.get('settings.strategy') as Strategy | undefined) ?? null,
      wallet: (snap.get('wallet') as Wallet | undefined) ?? null,
      hotkeys: (snap.get('settings.hotkeys') as Record<string, string> | undefined) ?? null,
      ui: (snap.get('settings.ui') as UiPrefs | undefined) ?? null,
      // Dieselbe Default-Regel wie im Scheduler (`!== false`): Wer nie etwas
      // eingestellt hat, bekommt die Selbstverbesserung — abstellen ist eine
      // bewusste Entscheidung, nicht der Zufall eines fehlenden Feldes.
      autoTune: snap.get('settings.autoTune') !== false,
      breaker:
        typeof snap.get('risk.breakerAusgeloestAm') === 'string'
          ? {
              am: snap.get('risk.breakerAusgeloestAm') as string,
              grund: (snap.get('risk.breakerGrund') as string | undefined) ?? '',
              verlustPct: (snap.get('risk.breakerVerlustPct') as number | null | undefined) ?? null,
            }
          : null,
      abgleich: leseAbgleich(snap.get('risk.abgleich')),
    });
  });
}

/** `risk.abgleich` in eine Form bringen, auf die sich die Anzeige verlassen kann. */
/** Ein Zustandswechsel im Broker-Verlaufsprotokoll (Owner-Meldung 05.08.). */
export interface AbgleichVerlaufEintrag {
  at: string;
  von: string | null;
  nach: string;
  fehlbestand: number;
  fremdbestand: number;
  fehler: string;
}

function leseAbgleich(roh: unknown): {
  at: string;
  status: string;
  anzahl: number;
  fehlbestand: number;
  fremdbestand: number;
  verglichen: number;
  brokerPositionen: number;
  fehler: string;
  verlauf: AbgleichVerlaufEintrag[];
} | null {
  if (!roh || typeof roh !== 'object') return null;
  const r = roh as Record<string, unknown>;
  if (typeof r['at'] !== 'string') return null;
  const zahl = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const verlauf: AbgleichVerlaufEintrag[] = Array.isArray(r['verlauf'])
    ? (r['verlauf'] as unknown[]).flatMap((e) => {
        if (!e || typeof e !== 'object') return [];
        const v = e as Record<string, unknown>;
        if (typeof v['at'] !== 'string' || typeof v['nach'] !== 'string') return [];
        return [{
          at: v['at'],
          von: typeof v['von'] === 'string' ? v['von'] : null,
          nach: v['nach'],
          fehlbestand: zahl(v['fehlbestand']),
          fremdbestand: zahl(v['fremdbestand']),
          fehler: typeof v['fehler'] === 'string' ? v['fehler'] : '',
        }];
      })
    : [];
  return {
    at: r['at'],
    status: typeof r['status'] === 'string' ? r['status'] : 'unbekannt',
    anzahl: zahl(r['anzahl']),
    fehlbestand: zahl(r['fehlbestand']),
    fremdbestand: zahl(r['fremdbestand']),
    verglichen: zahl(r['verglichen']),
    brokerPositionen: zahl(r['brokerPositionen']),
    fehler: typeof r['fehler'] === 'string' ? r['fehler'] : '',
    verlauf,
  };
}

/** UI-Präferenzen speichern — Rules erlauben Owner-Updates nur aufs settings-Feld. */
export async function saveUiPrefs(uid: string, ui: UiPrefs): Promise<void> {
  await updateDoc(doc(db(), 'users', uid), { 'settings.ui': ui });
}

/** Auto-Tuner an-/abschalten (MT5) — dasselbe Feld, das `tuneAll` prüft. */
export async function saveAutoTune(uid: string, on: boolean): Promise<void> {
  await updateDoc(doc(db(), 'users', uid), { 'settings.autoTune': on });
}

export function watchPositions(uid: string, cb: (positions: Position[]) => void): Unsubscribe {
  return onSnapshot(collection(db(), 'users', uid, 'positions'), (snap) => {
    cb(snap.docs.map((d) => d.data() as Position));
  });
}

export interface TradeRow {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  executedAt: string;
  source: 'engine' | 'manual';
  pnl?: number;
  riskExit?: string;
}

/** Seitengröße der Historie (Owner-Wunsch 28.07.: „über Pagination nachladen
 *  damit nicht immer alle direkt geladen werden"). */
export const TRADE_PAGE = 50;

/**
 * Der LIVE-KOPF der Handelshistorie: die neuesten `pageSize` Trades.
 *
 * Bewusst gedeckelt und bewusst NICHT die ganze Historie: Ein `onSnapshot`
 * ohne Limit hielte jede Zeile dauerhaft im Speicher und im Abrechnungs-
 * zähler — bei einem System, das alle fünf Minuten handeln soll, wächst das
 * unbegrenzt. Ältere Seiten kommen über `loadMoreTrades` als EINMALIGE
 * Abfrage dazu, ohne Listener.
 *
 * Sortiert wird über `executedAt` (ISO-String): lexikografisch identisch mit
 * chronologisch, einfeldrig — also ohne zusammengesetzten Index, und
 * derselbe Schlüssel, den die Seiten-Abfrage als Cursor benutzt. Über zwei
 * verschiedene Felder zu sortieren (`at` live, `executedAt` paginiert) wäre
 * die klassische Quelle für doppelte oder übersprungene Zeilen an der Naht.
 */
export function watchTrades(
  uid: string,
  cb: (trades: TradeRow[], cursor: TradeCursor | null) => void,
  pageSize = TRADE_PAGE,
): Unsubscribe {
  const q = query(
    collection(db(), 'users', uid, 'trades'),
    orderBy('executedAt', 'desc'),
    limit(pageSize),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as TradeRow), snap.docs[snap.docs.length - 1] ?? null);
  });
}

/**
 * Seiten-Cursor der Handelshistorie: das LETZTE Dokument der geladenen Seite,
 * nicht dessen Zeitstempel.
 *
 * Warum das wichtig ist (Owner-Fund 04.08.: „warum kann man nicht mehr weitere
 * laden?"): Ein Zeitstempel-Cursor mit `startAfter(executedAt)` springt über
 * ALLE Zeilen mit exakt diesem Wert hinweg. Der Momentum-Sockel schreibt aber
 * bis zu 38 Orders in einem Rutsch — landen davon zwei in derselben
 * Millisekunde und fällt die Seitengrenze genau dazwischen, verschwinden
 * Zeilen lautlos, und im Extremfall besteht die nächste Seite nur aus schon
 * bekannten Zeilen: Der Knopf reagiert, es passiert nur nichts Sichtbares.
 * Ein Dokument-Cursor ist in Firestore eindeutig und kennt das Problem nicht.
 */
export type TradeCursor = QueryDocumentSnapshot;

export interface TradePage {
  rows: TradeRow[];
  /** Letztes Dokument dieser Seite — Cursor für die nächste. */
  cursor: TradeCursor | null;
  /** Keine weiteren Zeilen mehr (Seite kam unvollständig zurück). */
  done: boolean;
}

/**
 * Eine ÄLTERE Seite nachladen (einmalige Abfrage, kein Listener).
 *
 * `done` wird aus einer unvollständigen Seite abgeleitet, nicht aus einer
 * zusätzlichen Zählabfrage: Kommen weniger als `pageSize` Zeilen zurück, gibt
 * es keine älteren mehr. Das spart eine Abfrage pro Klick — und `count()`
 * über eine wachsende Historie zu rechnen, nur um einen Knopf auszugrauen,
 * wäre genau die Sorte Kosten, die niemand bemerkt.
 */
export async function loadMoreTrades(
  uid: string,
  after: TradeCursor,
  pageSize = TRADE_PAGE,
): Promise<TradePage> {
  const q = query(
    collection(db(), 'users', uid, 'trades'),
    orderBy('executedAt', 'desc'),
    startAfter(after),
    limit(pageSize),
  );
  const snap = await getDocs(q);
  return {
    rows: snap.docs.map((d) => d.data() as TradeRow),
    cursor: snap.docs[snap.docs.length - 1] ?? null,
    done: snap.docs.length < pageSize,
  };
}

/* ── Portfolio-Kennzahlen (M12): schreibt NUR der tägliche snapshotEquity-
   Scheduler — das Dashboard liest genau ein Stats-Doc + die Equity-Serie. ── */

export interface PortfolioStatsDoc {
  equityDays: number;
  sharpe30: number | null;
  sharpe90: number | null;
  hwm: number | null;
  maxDDPct: number | null;
  currentDDPct: number | null;
  trades: number;
  wins: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  bySymbol: Record<string, { pnl: number; n: number }>;
  byClass: Record<string, { pnl: number; n: number }>;
  /**
   * Ausstiegsgründe (MT1): stop_loss · take_profit · trailing_stop · signal.
   * Steht fast alles unter `signal`, sind Stop und Take reine Dekoration —
   * dann entscheidet nicht die Risikosteuerung, sondern eine gekippte
   * Indikator-Stimme über das Ergebnis.
   */
  exits?: Record<string, { n: number; pnl: number; wins: number }>;
  /** Kostenprofil (MT1) — hat die Strategie Luft über der Reibung? */
  costs?: {
    n: number;
    fees: number;
    grossPnl: number;
    feeSharePct: number | null;
    avgWinGrossPct: number | null;
    avgLossGrossPct: number | null;
    roundTripPct: number | null;
    edgeOverCost: number | null;
  };
  /**
   * Empfehlung je Anlageklasse (MG2) — fertig gerechnet vom Tageslauf.
   *
   * Die Oberfläche zeigt sie nur an; die Logik steht in `classAdvisor.ts`
   * und läuft serverseitig. Zwei Implementierungen derselben Regel wären
   * zwei Wahrheiten, sobald eine davon nachzieht.
   */
  classAdvice?: {
    raete: Array<{
      klasse: string;
      n: number;
      kantePct: number | null;
      gewicht: number;
      empfehlung: string;
      vorschlag: number;
      grund: string;
    }>;
    aenderungen: number;
    fazit: string;
    autoTune: boolean;
    bewegt?: Array<{ klasse: string; von: number; nach: number; grund: string }>;
    at: string;
  };
  updatedAt: string;
}

export function watchPortfolioStats(
  uid: string,
  cb: (stats: PortfolioStatsDoc | null) => void,
): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid, 'stats', 'main'), (snap) =>
    cb(snap.exists() ? (snap.data() as PortfolioStatsDoc) : null),
  );
}

export interface EquitySeriesPoint {
  date: string;
  equity: number;
}

export function watchEquitySeries(
  uid: string,
  cb: (points: EquitySeriesPoint[]) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'users', uid, 'equity'),
    orderBy('date', 'desc'),
    limit(120),
  );
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs
        .map((d) => ({ date: d.get('date') as string, equity: d.get('equity') as number }))
        .reverse(),
    );
  });
}

/**
 * Eintrag im Änderungs-Journal des Auto-Tuners (MT5).
 *
 * Es steht bewusst JEDE Prüfung drin, auch die abgelehnten: Ein Journal, das
 * nur Erfolge zeigt, verschweigt das Interessante — wie viele Ideen
 * ausprobiert und verworfen wurden, und woran es lag.
 */
export interface TuneLogRow {
  at: string;
  variantId: string;
  /** Klartext: „Mindest-Haltedauer 60 → 120". */
  change: string;
  reason: string;
  promoted: boolean;
  p: number | null;
  edge: number;
  nCandidate: number;
  nIncumbent: number;
}

export function watchTuneLog(uid: string, cb: (rows: TuneLogRow[]) => void): Unsubscribe {
  const q = query(collection(db(), 'users', uid, 'tuneLog'), orderBy('at', 'desc'), limit(24));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data() as TuneLogRow)));
}

/**
 * Tages-Stand des Momentum-Rankings (meta/momentum).
 *
 * Öffentlich lesbar wie alle meta-Dokumente: Das Ranking ist keine
 * Nutzerdatei, sondern eine Eigenschaft des Marktes — und es kostet keinen
 * zusätzlichen Read, wenn alle dieselbe Zeile lesen.
 */
export interface MomentumDoc {
  at: string;
  date: string;
  /** Bewertbare Symbole (mit genug Historie) von `universum` insgesamt. */
  ranked: number;
  universum: number;
  /** Marktfilter: steht der Leitindex über seiner 200-Tage-Linie? */
  marktOffen: boolean;
  top: Array<{ symbol: string; score: number }>;
  ziel: string[];
  gehalten: string[];
  equity: number;
  trades: number;
  rebalanced: boolean;
  fehlendeHistorie: number;
}

export function watchMomentum(cb: (doc: MomentumDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'meta', 'momentum'), (snap) =>
    cb(snap.exists() ? (snap.data() as MomentumDoc) : null),
  );
}

/**
 * Der Betriebszustand der Engine, wie ihn der Scan hinterlässt (meta/health).
 *
 * Warum das ins Dashboard gehört (Owner 04.08.: „das ist sehr langweilig
 * anzuschauen"): Seit dem 04.08. entscheiden fünf Mechaniken mit, ob ein
 * Trade zustande kommt — Regime-Ampel, Trade-Filter, News-Veto,
 * Kostenschwelle und Hebel-Ampel. Alle arbeiten unsichtbar. Ein Nutzer sieht
 * bisher nur, DASS nichts passiert, und das sieht bei einer scharfen Regel
 * genauso aus wie bei einem toten System. Diese Zahlen machen aus „es tut
 * sich nichts" ein „6 Leerverkäufe abgelehnt, weil der Markt steigt".
 */
export interface HealthDoc {
  lastScanAt?: string;
  trades?: number;
  entryGate?: Record<string, number>;
  /**
   * Richtungs-Verteilung der Signale des letzten Scans (04.08.).
   *
   * Beantwortet die Frage, die die Blockade-Zähler offenlassen: Ein Scan ohne
   * Trades kann ein ruhiger Markt sein (viel `hold`) oder einer, in dem die
   * Engine gegen den Trend wollte und gestoppt wurde (viel `sell` bei Regime
   * `trend`). Beides sieht sonst gleich aus.
   */
  signalDirs?: { buy?: number; sell?: number; hold?: number };
  /**
   * Schatten-Kante je Signal-Variante. `rohPct` ist die Bewegung VOR
   * Gebühren — sie trennt „Signal ist Rauschen" von „Gebühren fressen die
   * Information" und fehlt bei Aggregaten aus der Zeit vor dem 05.08.
   */
  signalSchatten?: Record<
    string,
    { n: number; kantePct: number | null; rohPct?: number | null } | null
  > | null;
  konten?: Record<string, number>;
  regime?: { state?: string; vix?: number | null; realizedVolPct?: number | null; aboveSma200?: boolean | null };
  kalender?: { bevorstehend?: string | null; stundenBis?: number | null; turnOfMonth?: boolean; fomcVeraltet?: boolean };
  watched?: string[];
}

export function watchHealth(cb: (doc: HealthDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'meta', 'health'), (snap) =>
    cb(snap.exists() ? (snap.data() as HealthDoc) : null),
  );
}

/** Auffällige Positionierungen des letzten Tageslaufs (meta/positioning). */
export interface PositioningDoc {
  at?: string;
  abgedeckt?: number;
  zustaende?: Record<string, number>;
  auffaellig?: Record<string, { state?: string; fundingAnnualPct?: number | null; oiChangePct?: number | null }>;
}

export function watchPositioning(cb: (doc: PositioningDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'meta', 'positioning'), (snap) =>
    cb(snap.exists() ? (snap.data() as PositioningDoc) : null),
  );
}

/**
 * Stand EINER Variante der Schatten-Flotte.
 *
 * Ohne diese Zeile zeigte das Journal nur fertige Urteile — und ein Urteil,
 * das „zu wenig Evidenz" lautet, wäre ohne den Fortschritt unlesbar: Man
 * sähe nicht, ob eine Variante gerade erst angefangen hat oder seit Wochen
 * kaum handelt (was selbst schon ein Befund ist).
 */
export interface TuneFleetRow {
  id: string;
  /** Abgeschlossene Schatten-Trades — die Stichprobe des Vergleichs. */
  trades: number;
  /** Summe der Ergebnisse dieser Trades. */
  pnl: number;
  /** Aktuell offene Schatten-Positionen. */
  open: number;
  startedAt: string;
}

interface FleetVariantDoc {
  book?: { positions?: Record<string, unknown> };
  pnls?: number[];
  startedAt?: string;
}

export function watchTuneFleet(uid: string, cb: (rows: TuneFleetRow[]) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid, 'tuning', 'fleet'), (snap) => {
    const variants = (snap.get('variants') as Record<string, FleetVariantDoc> | undefined) ?? {};
    cb(
      Object.entries(variants)
        .map(([id, v]) => {
          const pnls = v.pnls ?? [];
          return {
            id,
            trades: pnls.length,
            pnl: pnls.reduce((a, b) => a + b, 0),
            open: Object.keys(v.book?.positions ?? {}).length,
            startedAt: v.startedAt ?? '',
          };
        })
        .sort((a, b) => b.trades - a.trades || a.id.localeCompare(b.id)),
    );
  });
}

/**
 * Trade-Journal-Zeile (M12): Die FAKTEN legt der Server bei der Buchung an
 * (Doc-ID = Trade-ID), die Review-Felder ergänzt der User — die Rules lassen
 * ihn ausschließlich `notes/tags/mistakes/review` ändern.
 */
export interface JournalRow {
  id: string;
  at: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  source: 'engine' | 'manual';
  assetClass?: string;
  art: 'entry' | 'exit';
  pnl?: number;
  riskExit?: string;
  bucket?: string;
  nachkauf?: boolean;
  /** Eingefrorene Momentaufnahme des Signals — warum die Engine gehandelt hat. */
  signalContext?: {
    typ?: string;
    votes?: Record<string, string>;
    konfluenz?: number;
    minKonfluenz?: number;
    forecast?: { dir?: string; weight?: number };
    regime?: string;
  };
  /* Review-Felder des Users. */
  review?: string;
  notes?: string;
  tags?: string[];
  mistakes?: string[];
}

export function watchJournal(uid: string, cb: (rows: JournalRow[]) => void): Unsubscribe {
  const q = query(collection(db(), 'users', uid, 'journal'), orderBy('at', 'desc'), limit(12));
  return onSnapshot(q, (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<JournalRow, 'id'>) }))),
  );
}

/**
 * Review speichern — bewusst NUR die vier Felder, die die Rules erlauben.
 * Ein versehentlich mitgeschicktes Fakten-Feld ließe die ganze Änderung an
 * den Rules abprallen, und der User sähe ein stummes Nichts.
 */
export async function saveJournalReview(
  uid: string,
  id: string,
  patch: { review?: string; notes?: string; tags?: string[]; mistakes?: string[] },
): Promise<void> {
  const erlaubt: Record<string, unknown> = {};
  if (patch.review !== undefined) erlaubt.review = patch.review;
  if (patch.notes !== undefined) erlaubt.notes = patch.notes;
  if (patch.tags !== undefined) erlaubt.tags = patch.tags;
  if (patch.mistakes !== undefined) erlaubt.mistakes = patch.mistakes;
  await updateDoc(doc(db(), 'users', uid, 'journal', id), erlaubt);
}

/**
 * Prüf-Journal-Zeile der Struktursuche (MO Teil 2) — der Server schreibt
 * jede Prüfung mit ihren Zahlen ins State-Doc, damit „abgelehnt" eine
 * nachrechenbare Aussage ist und keine Behauptung.
 */
export interface StrukturJournalRow {
  at: string;
  art: 'start' | 'kandidat';
  /** Klartext der Mutation, z. B. „Operator gekippt: rsi lt→gt". */
  beschreibung: string;
  befoerdert: boolean;
  /** Such-Sharpe-Vorsprung des Kandidaten gegen den Amtierenden. */
  vorsprung: number | null;
  suchSharpe: number | null;
  testSharpe: number | null;
  /** Deflated-Sharpe-Wahrscheinlichkeit (Beförderung verlangt ≥ 0,95). */
  dsr: number | null;
  /** E[max SR] aus nVersuche Zufallsversuchen — die wachsende Latte. */
  latte: number | null;
  nVersuche: number;
  nSuch: number;
  nTest: number;
  gruende: string[];
}

/** State der Struktursuche (users/{uid}/tuning/struktur, server-geschrieben). */
export interface StrukturDoc {
  amtierendSeit?: string;
  /** KUMULATIV über die Lebenszeit der Suche — die DSR-Latte wächst mit. */
  nVersuche?: number;
  /** Zahl der Beförderungen; Generation 0 ist der kompilierte Startpunkt. */
  generation?: number;
  journal?: StrukturJournalRow[];
  /** Feuer-Statistik der Blätter des amtierenden Baums (je Tageslauf frisch). */
  bedingungen?: {
    at?: string;
    zeilen?: Array<{ seite?: string; label?: string; gefeuert?: number; amSignalTag?: number }>;
  };
  updatedAt?: string;
}

export function watchStruktur(uid: string, cb: (d: StrukturDoc | null) => void): Unsubscribe {
  return onSnapshot(doc(db(), 'users', uid, 'tuning', 'struktur'), (snap) =>
    cb(snap.exists() ? (snap.data() as StrukturDoc) : null),
  );
}

/**
 * Kollektives Vorwissen (`meta/tuneGlobal`) — öffentlich lesbar wie die
 * anderen `meta`-Dokumente, weil es ausschließlich Zählwerte enthält:
 * wie oft eine Einstellungs-Änderung geprüft und wie oft sie übernommen
 * wurde. Keine Trades, keine Beträge, keine Kennungen.
 */
export function watchTuneGlobal(cb: (stats: GlobalAxisStats) => void): Unsubscribe {
  return muxWatch(
    'tuneGlobal',
    (emit) =>
      onSnapshot(doc(db(), 'meta', 'tuneGlobal'), (snap) =>
        emit(snap.exists() ? ((snap.get('axes') as GlobalAxisStats | undefined) ?? {}) : {}),
      ),
    (p) => cb(p as GlobalAxisStats),
  );
}

/** Manueller Paper-Trade über das trade-Callable (Preis kommt vom Server). */
export async function callTrade(input: {
  symbol: string;
  side: 'buy' | 'sell';
  qty?: number;
}): Promise<void> {
  await httpsCallable(fns(), 'trade')(input);
}

/* ── Admin-Verwaltung (Owner 02.08.): Freischalten aus der App ── */

export interface AdminUserRow {
  uid: string;
  email: string | null;
  accessLevel: 'pending' | 'approved' | 'blocked';
  requestedAt: string | null;
  admin: boolean;
  /** Gesamt-P&L (Equity − Kapitalbasis) — dieselbe Formel wie die
   *  Performance-Karte; null ohne Wallet/Kapitalbasis. */
  pnl: number | null;
  pnlPct: number | null;
  equity: number | null;
}

/** Alle Konten (Wartende zuerst) — antwortet nur für Admin-Konten. */
export async function adminListUsers(): Promise<AdminUserRow[]> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'list' });
  return (r.data as { users: AdminUserRow[] }).users;
}

/** Zugangsstufe eines FREMDEN Kontos setzen (das eigene ist serverseitig tabu). */
export async function adminSetAccess(
  target: string,
  level: 'pending' | 'approved' | 'blocked',
): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'set', target, level });
}

/** Admin-Recht eines FREMDEN Kontos vergeben/entziehen. */
export async function adminSetAdmin(target: string, admin: boolean): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'setAdmin', target, admin });
}

/** Zustand des Echtgeld-Not-Aus (M14) — nur für Admin-Konten. */
export interface KillSwitchStatus {
  killSwitch: boolean;
  at: string | null;
  von: string | null;
}

export async function adminLiveStatus(): Promise<KillSwitchStatus> {
  const r = await httpsCallable(fns(), 'adminUsers')({ action: 'liveStatus' });
  return r.data as KillSwitchStatus;
}

/** Not-Aus setzen/lösen: friert plattformweit alle Echtgeld-Order-Pfade ein. */
export async function adminSetKillSwitch(an: boolean): Promise<void> {
  await httpsCallable(fns(), 'adminUsers')({ action: 'setKillSwitch', an });
}

/* ── Bewährte Einstellungen (MU3, meta/bestPractice) ─────────────────────────
 * Täglicher, anonymisierter Snapshot des Kontos mit der besten
 * ENGINE-Attribution — öffentlich lesbar wie alle meta-Dokumente, weil er
 * weder User-Kennung noch Watchlist noch Kapital enthält. */

export interface BestPracticeKennzahlen {
  n: number;
  kantePct: number | null;
  pnl: number;
  fees: number;
  notional: number;
  zeitraumTage: number;
}

export interface BestPractice {
  at: string;
  stand: 'gekuert' | 'kein_kandidat';
  kriterien: { minTrades: number; minTage: number } | null;
  kennzahlen: BestPracticeKennzahlen | null;
  einstellungen: import('@autotrd/shared').BewaehrteEinstellungen | null;
  anwaerter: { kennzahlen: BestPracticeKennzahlen; fehlt: string[] } | null;
}

function parseKennzahlen(roh: unknown): BestPracticeKennzahlen | null {
  if (!roh || typeof roh !== 'object') return null;
  const o = roh as Record<string, unknown>;
  if (typeof o.n !== 'number') return null;
  return {
    n: o.n,
    kantePct: typeof o.kantePct === 'number' ? o.kantePct : null,
    pnl: typeof o.pnl === 'number' ? o.pnl : 0,
    fees: typeof o.fees === 'number' ? o.fees : 0,
    notional: typeof o.notional === 'number' ? o.notional : 0,
    zeitraumTage: typeof o.zeitraumTage === 'number' ? o.zeitraumTage : 0,
  };
}

export async function leseBestPractice(): Promise<BestPractice | null> {
  const snap = await getDoc(doc(db(), 'meta', 'bestPractice'));
  if (!snap.exists()) return null;
  const d = snap.data() as Record<string, unknown>;
  const stand = d.stand === 'gekuert' ? 'gekuert' : 'kein_kandidat';
  const krit = d.kriterien as { minTrades?: unknown; minTage?: unknown } | undefined;
  const anw = d.anwaerter as { kennzahlen?: unknown; fehlt?: unknown } | undefined;
  const anwKz = anw ? parseKennzahlen(anw.kennzahlen) : null;
  const einst = d.einstellungen as Record<string, unknown> | undefined;
  const einstOk =
    einst &&
    typeof einst.engine === 'object' &&
    typeof einst.signals === 'object' &&
    typeof einst.indicators === 'object';
  return {
    at: typeof d.at === 'string' ? d.at : '',
    stand,
    kriterien:
      krit && typeof krit.minTrades === 'number' && typeof krit.minTage === 'number'
        ? { minTrades: krit.minTrades, minTage: krit.minTage }
        : null,
    kennzahlen: parseKennzahlen(d.kennzahlen),
    einstellungen: einstOk
      ? (einst as unknown as import('@autotrd/shared').BewaehrteEinstellungen)
      : null,
    anwaerter:
      anwKz !== null
        ? {
            kennzahlen: anwKz,
            fehlt: Array.isArray(anw?.fehlt) ? anw.fehlt.filter((f) => typeof f === 'string') : [],
          }
        : null,
  };
}

/* ── Eigene Loadouts (MU4, users/{uid}/loadouts) ─────────────────────────────
 * Benannte Einstellungs-Schnappschüsse — reine Präferenz-KOPIEN, per Rules
 * nur vom Owner lesbar/schreibbar. Wirksam wird ein Loadout erst über
 * saveStrategy (Server-Validierung), nie durch das Speichern hier. */

export interface EigenesLoadout {
  id: string;
  name: string;
  at: string;
  einstellungen: import('@autotrd/shared').BewaehrteEinstellungen;
  hebel?: number;
}

export async function leseLoadouts(uid: string): Promise<EigenesLoadout[]> {
  const snap = await getDocs(collection(db(), 'users', uid, 'loadouts'));
  return snap.docs
    .flatMap((d) => {
      const name = d.get('name') as unknown;
      const at = d.get('at') as unknown;
      const e = d.get('einstellungen') as Record<string, unknown> | undefined;
      const hebel = d.get('hebel') as unknown;
      const ok =
        typeof name === 'string' &&
        typeof at === 'string' &&
        e &&
        typeof e.engine === 'object' &&
        typeof e.signals === 'object' &&
        typeof e.indicators === 'object';
      if (!ok) return [];
      return [
        {
          id: d.id,
          name,
          at,
          einstellungen: e as unknown as import('@autotrd/shared').BewaehrteEinstellungen,
          ...(typeof hebel === 'number' ? { hebel } : {}),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function speichereLoadout(
  uid: string,
  name: string,
  einstellungen: import('@autotrd/shared').BewaehrteEinstellungen,
  hebel: number,
): Promise<void> {
  await setDoc(doc(collection(db(), 'users', uid, 'loadouts')), {
    name,
    at: new Date().toISOString(),
    einstellungen,
    ...(hebel > 1 ? { hebel } : {}),
  });
}

export async function loescheLoadout(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(db(), 'users', uid, 'loadouts', id));
}

export interface UniverseEntry {
  symbol: string;
  name: string;
}
export interface UniverseClass {
  label: string;
  groups: Record<string, UniverseEntry[]>;
}

/** Katalog aus meta/universe (einmalig; ändert sich praktisch nie). */
export async function loadUniverse(): Promise<Record<string, UniverseClass> | null> {
  const snap = await getDoc(doc(db(), 'meta', 'universe'));
  if (!snap.exists()) return null;
  return (snap.data() as { classes: Record<string, UniverseClass> }).classes;
}

/* ── Workspace-Persistenz (M9): users/{uid}/workspaces/{wsId} ── */

export interface WorkspaceDocData {
  preset: string;
  /** Panel-Sichtbarkeit + Reihenfolge (id → {hidden, order}); fehlend = sichtbar,
   *  Reihenfolge = DOM-Default (Taschenmesser Teil 3: Module per Drag sortieren). */
  panels: Record<string, { hidden?: boolean; order?: number }>;
  /** Link-Gruppen der verlinkbaren Panels (chart/news → 'A'|'B'|'C'). */
  groups: Record<string, string>;
  /** Zuletzt aktives Symbol je Link-Gruppe. */
  symbols: Record<string, string>;
  updatedAt: string;
}

export async function loadWorkspace(uid: string): Promise<WorkspaceDocData | null> {
  const snap = await getDoc(doc(db(), 'users', uid, 'workspaces', 'default'));
  return snap.exists() ? (snap.data() as WorkspaceDocData) : null;
}

export async function saveWorkspace(uid: string, data: WorkspaceDocData): Promise<void> {
  await setDoc(doc(db(), 'users', uid, 'workspaces', 'default'), data);
}

/** Quotes aller vorhandenen market/**-Docs (für die Markt-Übersicht). */
export async function loadMarketQuotes(): Promise<Map<string, MarketDocData>> {
  const snap = await getDocs(collection(db(), 'market'));
  const map = new Map<string, MarketDocData>();
  for (const d of snap.docs) map.set(d.id, d.data() as MarketDocData);
  return map;
}

/** Tiefe Historie (Chart-Audit 2): EIN Jahres-Chunk market/{sym}/ohlcDaily/{JAHR}. */
export async function loadDailyChunk(symbol: string, year: number): Promise<ChartBar[]> {
  const snap = await getDoc(doc(db(), 'market', symbol, 'ohlcDaily', String(year)));
  if (!snap.exists()) return [];
  const days = (snap.data() as { days?: Record<string, { open: number; high: number; low: number; close: number; volume: number }> }).days ?? {};
  return Object.entries(days)
    .map(([date, b]) => ({ date, ...b }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Kurz-Update fürs aktive Symbol — Server schreibt den frischen Kurs in
 *  market/{sym}.quote (alle Clients sehen ihn via onSnapshot). */
export async function callQuoteNow(symbol: string): Promise<void> {
  await httpsCallable(fns(), 'quoteNow')({ symbol });
}

/** Aktive User-Prognose (Chart-Pfeil) eines Symbols — null wenn keine. */
export async function loadPrediction(
  uid: string,
  symbol: string,
): Promise<import('@autotrd/shared').UserPrediction | null> {
  const snap = await getDoc(doc(db(), 'users', uid, 'predictions', symbol));
  return snap.exists() ? (snap.data() as import('@autotrd/shared').UserPrediction) : null;
}

export async function callSavePrediction(input: {
  symbol: string;
  targetPrice?: number;
  targetDate?: string;
  confidence?: number;
  basePrice?: number;
  clear?: boolean;
}): Promise<void> {
  await httpsCallable(fns(), 'savePrediction')(input);
}

/** Bars einmalig für die Studio-Vorschau (gecachte Tages-Bars, aufsteigend). */
export async function loadBarsOnce(symbol: string): Promise<ChartBar[]> {
  const q = query(collection(db(), 'market', symbol, 'bars'), orderBy(documentId()));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ date: d.id, ...(d.data() as Omit<ChartBar, 'date'>) }));
}

/** ISO-Tag `tage` Kalendertage vor heute (UTC) — Schlüssel-Arithmetik für
 *  die ohlc5m-Chunk-Queries (Doc-IDs sind ET-Tage im Format YYYY-MM-DD). */
export function tagVorTagen(tage: number): string {
  return new Date(Date.now() - tage * 86_400_000).toISOString().slice(0, 10);
}

/** Ein geladener 5m-Chunk: ET-Handelstag + dessen Bars (aufsteigend). */
export interface IntradayChunk {
  day: string;
  bars: import('./chart.js').IntradayChartBar[];
}

/**
 * 5m-Chunks eines Schlüssel-Fensters [vonTag, bisTag] laden (Zoom-Kontinuum
 * 06.08.). Die Doc-IDs sind ET-Tage — ein Range-Scan über die documentId
 * liest also GENAU die gewünschten Tage statt der ganzen Collection. Das ist
 * die Grundlage des dynamischen Nachladens: Die Collection wächst um ein Doc
 * pro Handelstag, und ein Voll-Scan würde jeden Chart-Refresh mit der
 * gesamten Intraday-Geschichte bezahlen.
 */
export async function loadIntradayChunks(
  symbol: string,
  vonTag: string,
  bisTag: string,
): Promise<IntradayChunk[]> {
  const q = query(
    collection(db(), 'market', symbol, 'ohlc5m'),
    where(documentId(), '>=', vonTag),
    where(documentId(), '<=', bisTag),
    orderBy(documentId()),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data() as { bars?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
    return {
      day: d.id,
      bars: (data.bars ?? []).map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })),
    };
  });
}

/** 5m-Intraday-Bars der letzten N Handelstage aus market/{sym}/ohlc5m
 *  (Chunk-Doc je ET-Tag; Chart-Feedback 24.07.: „minutengenaue Daten").
 *  Cutoff mit Wochenend-/Feiertagspuffer, dann auf die letzten N Handelstage
 *  geschnitten — liest ein paar Tage mehr als nötig, nie die ganze Collection. */
export async function loadIntraday(
  symbol: string,
  days: number,
): Promise<import('./chart.js').IntradayChartBar[]> {
  const n = Math.max(days, 1);
  const chunks = await loadIntradayChunks(symbol, tagVorTagen(Math.ceil(n * 1.6) + 4), '9999-12-31');
  return chunks.slice(-n).flatMap((c) => c.bars);
}

