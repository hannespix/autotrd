/**
 * scanMarket — der zentrale Marktdaten-Scan (MILESTONES M2).
 *
 * Läuft alle 5 min via Cloud Scheduler, respektiert den US-Marktzeiten-Gate
 * (Port von reference/deploy/run_scan.sh: Mo–Fr 09:30–16:00 ET) und schreibt
 * geteilte Daten idempotent nach market/{symbol}/** — einmal für ALLE User
 * (ARCHITECTURE §2). Doc-IDs sind fachliche Schlüssel (Datum, Scan-Minute).
 *
 * Schreibdisziplin: Bars werden beim ersten Scan eines Symbols backgefüllt
 * (Marker `barsBackfilledAt` am Symbol-Doc), danach nur noch der letzte Bar
 * pro Scan — sonst wären es ~70 Writes je Symbol alle 5 Minuten.
 */

import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  CATALOG,
  CLASS_LABELS,
  DEFAULT_STRATEGY,
  allSymbols,
  classify,
  clusterHasRoom,
  costGate,
  effectiveLeverage,
  addiereSchatten,
  bestimmeSignalTyp,
  bewerteSchattenSignal,
  leseSchattenSignal,
  pruefeTagSlot,
  regimeRichtung,
  regimeStimmen,
  werteSchattenAus,
  type SchattenBeitrag,
  type SchattenKlasse,
  captureForClass,
  klemmeGewicht,
  feeRateForClass,
  isTradable,
  stopDistancePct,
  isStrategy,
  marginState,
  newsVeto,
  NEWS_TTL_SEC,
  bucketKey,
  bucketVerdict,
  DEFAULT_CORE_PCT,
  convictionFactor,
  marketRegime,
  regimeEntryBlocked,
  leverageChance,
  calendarReading,
  signalSignature,
  type BucketStat,
  type MarketRegime,
  type PositioningState,
  positionValue,
  pruefeBreaker,
  resolveName,
  resolveRisk,
  type NewsSnapshot,
  type Position,
  type Strategy,
  type StrategyDoc,
} from '../../../shared/src/index.js';
import { atrPct, buildVariants } from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { aktualisiereBoersenUhr, boersenOffen, offenMitUhr } from '../core/marktUhr.js';
import { computeIndicatorSnapshot, computeSignal } from '../core/engine.js';
import {
  executePaperTrade,
  executeTrade,
  resolveBrokerMode,
  riskExitReason,
  type MarginBudget,
} from '../core/broker.js';
import { abgleichFuerKonto } from '../core/brokerAbgleich.js';
import { brokerVerbindung } from '../core/orderRouting.js';
import { pflegeSchutz } from '../core/schutzStop.js';
import { reifeFuerKonto } from '../core/liveGate.js';
import { accessLevelOf, mayTrade } from '../core/access.js';
import {
  applyPredictionVote,
  buildRuleContext,
  clampLeverage,
  clampStrategyRisk,
  cooldownActive,
  decideTree,
  maxOpenPositions,
  minHoldActive,
  minuteOfDayEt,
  predictionVote,
  shadowEquity,
  shadowTrade,
  type ShadowBook,
} from '../core/rulesTrading.js';
import { accuracyWeightedVote } from '../../../shared/src/index.js';
import { runForecast, runIntradayForecast, type LiveForecast } from '../core/forecaster.js';
import { fetchNewsSnapshot } from '../core/news.js';
import { evaluateIntradayDue } from './evalForecasts.js';
import { stepFleet, type FleetState } from '../core/tuneFleet.js';
import { FLEET_SIZE } from './autoTune.js';
import {
  chunkBarsByYear,
  getDeepDailyBars,
  getIntradayBars,
  getMarketSnapshot,
  getQuickQuote,
  getSparkBatch,
  type SparkQuote,
} from '../core/marketData.js';

/** Mo–Fr, 09:30 ≤ t < 16:00 in America/New_York (Port des run_scan.sh-Gates). */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
  return hm >= 930 && hm < 1600;
}

/** meta/universe einmalig seeden (Katalog als Array-of-Maps — Firestore
 *  erlaubt keine verschachtelten Arrays). Idempotent. */
async function seedUniverse(): Promise<void> {
  const db = getFirestore();
  const ref = db.doc('meta/universe');
  if ((await ref.get()).exists) return;
  const classes: Record<string, unknown> = {};
  for (const [cls, groups] of Object.entries(CATALOG)) {
    classes[cls] = {
      label: CLASS_LABELS[cls] ?? cls,
      groups: Object.fromEntries(
        Object.entries(groups).map(([g, entries]) => [
          g,
          entries.map(([symbol, name]) => ({ symbol, name })),
        ]),
      ),
    };
  }
  await ref.set({ classes, seededAt: new Date().toISOString() });
  logger.info('meta/universe geseedet');
}

export interface ScanResult {
  scanId: string;
  scanned: string[];
  errors: Record<string, string>;
  trades: number;
  skipped?: string;
}

/** In-Memory-Marktbild eines Scans: 1 Fetch pro Symbol, N User-Auswertungen. */
interface SymbolData {
  closes: number[];
  price: number;
  forecast: LiveForecast | null;
  /** ATR(14) in Prozent des Kurses — Basis volatilitätsadaptiver Stops (MA6). */
  atrPct?: number | null;
  /** 5-min-Closes (~5 Handelstage) — Signal-Basis im 'intraday'-Zeitrahmen
   *  (Owner 26.07.: „Tradefrequenz deutlich erhöhen"). */
  closes5m?: number[];
  /** Kurzfrist-Prognose (nächste Stunde) in % — Forecast-Stimme im
   *  'intraday'-Zeitrahmen (die Tages-Prognose passt dort nicht). */
  intradayPct?: number | null;
  /** News-Lage (Veto-Grundlage + Sentiment-Schatten) — null = keine Daten. */
  news?: NewsSnapshot | null;
}

/** Signal-Quelle je Zeitrahmen: 5-min-Closes, wenn gewünscht UND vorhanden
 *  (mind. ~35 Bars für RSI/MACD-Anlauf), sonst Tages-Closes als Fallback. */
export function signalCloses(data: SymbolData, timeframe: 'daily' | 'intraday'): number[] {
  if (timeframe === 'intraday' && (data.closes5m?.length ?? 0) >= 35) return data.closes5m!;
  return data.closes;
}

/**
 * Auto-Trading pro User (MILESTONES M4): Für jeden User mit
 * `settings.strategy.engine.running === true` werden die Signale gegen SEINE
 * Strategie-Parameter neu ausgewertet (Indikator-Mathe in-memory, keine
 * weiteren Fetches) und Paper-Trades transaktional ausgeführt; danach
 * Stop-Loss/Take-Profit über die offenen Positionen.
 */
/**
 * Was an der Einstiegs-Prüfung passiert ist — landet im Heartbeat.
 *
 * Drei Ablehnungen und, genauso wichtig, EINE Durchlassung: Die
 * Kostenschwelle lässt bewusst durch, wenn keine ATR vorliegt (ein Datenloch
 * darf die Engine nicht still abschalten). Ohne diesen Zähler ist
 * `unter_kosten: 0` zweideutig — es kann „prüft und findet alles lohnend"
 * heißen oder „konnte gar nicht prüfen". Genau diese Zweideutigkeit stand am
 * 28.07. im Heartbeat, und sie machte die wichtigste Änderung des Tages
 * unbeurteilbar.
 *
 * Der Feldname sagt deshalb ausdrücklich DURCHGELASSEN. Eine Pass-Zahl unter
 * dem Namen einer Block-Zahl zu führen wäre derselbe Fehler in neu.
 */
export interface EntryGateStats {
  /** Wie viele Einstiegs-Entscheidungen überhaupt geprüft wurden. Ohne diese
   *  Bezugsgröße hat „14 blockiert" keine Aussagekraft — 14 von 15 ist etwas
   *  völlig anderes als 14 von 400. */
  geprueft: number;
  /** Abgelehnt: Symbol ist bei keinem Broker kaufbar. */
  nicht_handelbar: number;
  /** Abgelehnt: Korrelationsblock bereits voll. */
  cluster_voll: number;
  /** Abgelehnt: frisches hartes News-Ereignis (Gap-Risiko) — News-Rückkehr 29.07. */
  news_veto: number;
  /** Abgelehnt: erwartete Bewegung unter der Kostenschwelle. */
  unter_kosten: number;
  /** Schatten (04.08.): Was die Kanten-Fassung ZUSÄTZLICH blocken würde. */
  kante_wuerde_blocken: number;
  /** Klassen-Regler auf 0 — der Schatten misst weiter. */
  klasse_aus: number;
  /** Abgelehnt: Tages-Notbremse ausgelöst (M12). Zählt je gesperrtem Konto,
   *  nicht je Symbol — die Bremse ist eine Konto-Entscheidung. */
  breaker_aktiv: number;
  /** Einstiege gesperrt, weil Buch und Broker-Depot auseinanderlaufen (M13). */
  abgleich_drift: number;
  /** DURCHGELASSEN, obwohl die Kostenschwelle nicht prüfen konnte (keine
   *  ATR). Steht diese Zahl hoch, ist die Schwelle faktisch abgeschaltet. */
  ohne_atr_durchgelassen: number;
  /** Geblockt vom selbstlernenden Steckbrief-Filter. SCHARF seit 02.08.
   *  (Owner: „alle Konten im Minus — können wir das ändern???"): Die
   *  Schatten-Phase (31.07.) hat ihre Beweislast erfüllt — der Steckbrief
   *  crypto|intraday|bollinger+rsi|short|trend stand bei n=70, 6 Gewinnern,
   *  t=−9,0; JEDER Intraday-Steckbrief war negativ. Blockiert wird nur, was
   *  die eigene Historie mit n≥30 und t≤−1,5 als Verlust-Sorte ausweist
   *  (bucketVerdict); Exits und manuelle Trades bleiben immer frei. */
  filter_blockiert: number;
  /** Abgelehnt: SHORT im Aufwärtstrend (Regime-Ampel Stufe 2, 04.08.).
   *  Die vier Short-Steckbriefe im Trend standen zusammen bei 112 Trades
   *  mit 8 Gewinnern — die Zahl hier zeigt, wie oft die Regel greift. */
  regime_gegen_trend: number;
  /** Abgelehnt: Stress-Regime, gar keine neuen Einstiege. */
  regime_stress: number;
  /** Wie oft die HEBEL-AMPEL einen Großeinsatz freigegeben hat (04.08.).
   *  Erwartungsgemäß selten — sie verlangt fünf unabhängige Bestätigungen
   *  gleichzeitig. Steht sie dauerhaft auf 0, ist der Hebel faktisch aus;
   *  steht sie hoch, ist eine Bedingung wirkungslos geworden. */
  hebel_frei: number;
}

/**
 * Konten-Zähler je Scan (Owner-Fund 02.08.: „10 Stunden später immer noch
 * kein Trade").
 *
 * Ob ein Konto am Handel teilnimmt, entscheiden vier stille continue-Zeilen —
 * und ein übersprungenes Konto sieht von außen exakt aus wie ein ruhiger
 * Markt. Der Fall vom 02.08. war live nicht diagnostizierbar: Ohne Zugriff
 * auf die Firestore-Konsole ließ sich nicht sagen, ob das neue Konto noch
 * auf der Freischaltung wartete oder schlicht kein Signal bekam. Diese
 * Zähler beantworten genau das aus dem öffentlichen Heartbeat — als Summen,
 * ohne Konto-Bezug, denn meta/health darf keine sensiblen Daten tragen.
 */
export interface KontenStats {
  /** Konten mit `engine.running == true` — die Grundgesamtheit des Scans. */
  laufend: number;
  /** Haben den Handelspfad durchlaufen (Exits + Einstiegs-Prüfung). */
  gehandelt: number;
  /** Übersprungen: Zugangsstufe 'pending' — wartet auf die Freischaltung
   *  durch den Betreiber. Steht hier dauerhaft eine Zahl > 0, während ein
   *  User „Engine an" meldet, ist DAS die Antwort. */
  wartet_freischaltung: number;
  /** Übersprungen: Zugangsstufe 'blocked'. */
  gesperrt: number;
  /** Übersprungen: Momentum-Wallet — gehört momentumRun, nicht dem Scan. */
  momentum: number;
  /** Übersprungen: Strategie fehlt oder ist nicht lesbar (Schema-Bruch). */
  ohne_strategie: number;
  /** Übersprungen: Broker-Modus nicht 'paper' (M14-Verriegelung). */
  live_verriegelt: number;
}

/**
 * Broker-Anbindung im Scan (M13) — vier Zahlen, die eine Frage beantworten:
 * Kommt das Order-Routing überhaupt bis zum Broker?
 *
 * Das Motiv ist Nachweisbarkeit ohne Konto-Bezug. `meta/health` ist
 * öffentlich lesbar und darf deshalb nichts über einzelne Nutzer verraten —
 * aggregierte Zahlen verraten nichts und belegen trotzdem, dass die
 * Verbindung im Scan-Pfad greift. Ohne sie wäre „läuft" von „findet den
 * Schlüssel nicht" nicht zu unterscheiden, und beides sähe im Heartbeat
 * gleich aus: Stille.
 */
export interface BrokerStats {
  /** Konten mit hinterlegter Verbindung, für die der Abgleich lief. */
  verbunden: number;
  /** Buch und Depot stimmen überein. */
  sauber: number;
  /** Abweichung gefunden — Einstiege dieses Kontos sind gesperrt. */
  drift: number;
  /** Broker nicht erreichbar — sperrt NICHT, wird aber gezählt. */
  fehler: number;
}

async function executeUserTrades(
  marketData: Map<string, SymbolData>,
  regime: MarketRegime,
  /**
   * Lauf-Kennung des Scans (M13) — wird zur `client_order_id` beim Broker.
   * Sie hängt bewusst am LAUF und nicht an der Uhr: Ein wiederholter Scan
   * derselben Minute trägt dieselbe Kennung, und Alpaca weist die doppelte
   * Order ab, statt eine zweite Position zu eröffnen.
   */
  scanId: string,
): Promise<{
  executed: number;
  gate: EntryGateStats;
  konten: KontenStats;
  broker: BrokerStats;
}> {
  const db = getFirestore();
  let executed = 0;
  const broker: BrokerStats = { verbunden: 0, sauber: 0, drift: 0, fehler: 0 };
  // Ein abgelehnter Einstieg ist ein Nicht-Ereignis und damit unsichtbar.
  // Genau deshalb wird er gezählt: Ein Filter, der zu scharf steht und ALLES
  // blockt, sähe im Log exakt aus wie ein ruhiger Markt.
  const gate: EntryGateStats = {
    geprueft: 0,
    nicht_handelbar: 0,
    cluster_voll: 0,
    news_veto: 0,
    unter_kosten: 0,
    kante_wuerde_blocken: 0,
    klasse_aus: 0,
    breaker_aktiv: 0,
    abgleich_drift: 0,
    ohne_atr_durchgelassen: 0,
    filter_blockiert: 0,
    regime_gegen_trend: 0,
    regime_stress: 0,
    hebel_frei: 0,
  };
  const konten: KontenStats = {
    laufend: 0,
    gehandelt: 0,
    wartet_freischaltung: 0,
    gesperrt: 0,
    momentum: 0,
    ohne_strategie: 0,
    live_verriegelt: 0,
  };
  const users = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();
  konten.laufend = users.size;

  // Beweislast-Umkehr (Owner-Direktive 28.07.): Das Stimmgewicht der Prognose
  // hängt an ihrer REALISIERTEN Trefferquote — einmal je Scan gelesen, für
  // alle User angewandt. Der User konfiguriert das Basisgewicht; ob die
  // Prognose es führen darf, entscheidet die Evidenz. Je Zeitbasis die
  // passende Statistik: 5-min-Signale werden von der Kurzfrist-Prognose
  // gestimmt, Tages-Signale von der Tages-Prognose — die Trefferquote der
  // einen sagt nichts über die andere.
  type FcStats = { scored?: number | undefined; dirAccuracy?: number | null | undefined } | null;
  let fcDaily: FcStats = null;
  let fcIntraday: FcStats = null;
  try {
    const [d, i] = await Promise.all([
      db.doc('meta/forecastStats').get(),
      db.doc('meta/forecastStatsIntraday').get(),
    ]);
    fcDaily = {
      scored: d.get('scored') as number | undefined,
      dirAccuracy: d.get('dirAccuracy') as number | null | undefined,
    };
    fcIntraday = {
      scored: i.get('scored') as number | undefined,
      dirAccuracy: i.get('dirAccuracy') as number | null | undefined,
    };
  } catch {
    // nicht lesbar = keine Evidenz — accuracyWeightedVote(null) ⇒ Stimme 0
  }

  // Steckbrief-Statistik des Trade-Filters — einmal je Scan gelesen; seit
  // 02.08. blockt sie Einstiege nachweislicher Verlust-Sorten (s.
  // EntryGateStats.filter_blockiert). Nicht lesbar ⇒ leere Statistik ⇒
  // bucketVerdict blockt nichts; der Handel fällt also sicher auf.
  let filterBuckets: Record<string, BucketStat> = {};
  try {
    filterBuckets =
      ((await db.doc('meta/tradeFilter').get()).get('buckets') as Record<string, BucketStat> | undefined) ?? {};
  } catch {
    // s. o.
  }

  // Positionierungs-Zustände des letzten Tageslaufs (04.08.) — einmal je
  // Scan gelesen, ausschließlich für die HEBEL-Ampel. Fehlt das Dokument
  // oder ist der Feed ausgefallen, bleibt die Map leer; die Ampel wertet
  // Unbekanntes bewusst NICHT als Gegenargument, sonst hinge der Hebel an
  // der Erreichbarkeit einer fremden Börse.
  const positionierung = new Map<string, PositioningState>();
  try {
    const auf = (await db.doc('meta/positioning').get()).get('auffaellig') as
      | Record<string, { state?: PositioningState }>
      | undefined;
    for (const [sym, r] of Object.entries(auf ?? {})) {
      if (r?.state) positionierung.set(sym, r.state);
    }
  } catch {
    // s. o. — eine Schatten-Messung darf den Handel nie blockieren.
  }

  for (const userDoc of users.docs) {
    const uid = userDoc.id;
    const strategy = userDoc.get('settings.strategy') as Strategy | undefined;
    if (!strategy || !isStrategy(strategy)) {
      konten.ohne_strategie += 1;
      continue;
    }
    // Die Reife entscheidet mit (04.08.). Wichtig ist, was daraus FOLGT:
    // Ein Konto, dessen Schalter auf „live" steht, das aber die Kriterien
    // noch nicht erfüllt, gilt hier als Papierkonto und handelt ganz normal
    // weiter. Es MUSS weiterhandeln — Reife entsteht durch Trades, und ein
    // stillgelegtes Konto würde nie reif werden (siehe core/liveGate.ts).
    // Übersprungen wird nur, wer wirklich live wäre; dort fehlt das
    // Order-Routing noch (M14).
    if (resolveBrokerMode(strategy, await reifeFuerKonto(uid)) !== 'paper') {
      konten.live_verriegelt += 1;
      continue; // Echtgeld-Routing kommt in M14
    }
    // Gate VOR der Risiko-Klammer, damit beide Pfade (Signal + Ausführung)
    // dasselbe gedeckelte Gewicht sehen.
    strategy.signals = {
      ...strategy.signals,
      forecastWeight: accuracyWeightedVote(
        strategy.signals.forecastWeight,
        (strategy.signals.timeframe ?? 'intraday') === 'intraday' ? fcIntraday : fcDaily,
      ).weight,
    };
    // Zugangsstufe (Owner 26.07.): Nicht freigeschaltete Konten dürfen den
    // Schalter zwar umlegen — gehandelt wird für sie trotzdem nicht. Die
    // Prüfung sitzt hier und nicht in der Query, weil ein fehlendes Feld
    // (Bestandskonto) als freigeschaltet gilt und Firestore darauf nicht
    // filtern kann.
    if (!mayTrade(userDoc.data())) {
      if (accessLevelOf(userDoc.data()) === 'pending') konten.wartet_freischaltung += 1;
      else konten.gesperrt += 1;
      continue;
    }
    // Momentum-Wallets gehören momentumRun (Hantel-Umbau 28.07.). Der Scan
    // fasst sie NICHT an — weder Einstieg noch Ausstieg. Täte er es, sähe er
    // eine Momentum-Position ohne Konfluenz-Signal und schlösse sie beim
    // nächsten Lauf; die Wochenstrategie käme nie über einen Tag hinaus.
    // Der Margin-Call im 1-Minuten-Puls greift weiter, denn er ist eine
    // Solvenzgrenze und keine Strategie-Entscheidung.
    if (strategy.engine.mode === 'momentum') {
      konten.momentum += 1;
      continue;
    }
    konten.gehandelt += 1;

    try {
      const positionsSnap = await userDoc.ref.collection('positions').get();
      // BESITZGRENZE des Kern-Satelliten (04.08.): Sockel-Positionen gehören
      // dem Momentum-Lauf und werden hier vollständig ausgeblendet — kein
      // Exit, kein Trailing, und sie zählen nicht gegen maxOpenPositions.
      // Würde der Scan sie sehen, schlösse er sie beim nächsten Rauschen:
      // Er sähe eine Position ohne Konfluenz-Signal und verkaufte sie. Genau
      // das soll der Sockel nicht erleben — er lebt von Ruhe.
      const positions = new Map<string, Position>(
        positionsSnap.docs
          .map((d) => [d.id, d.data() as Position] as const)
          .filter(([, p]) => p.core !== true),
      );
      // Ausgeblendet heißt NICHT „nicht vorhanden". Zwei Stellen müssen den
      // Sockel weiter sehen:
      //   1. Der Einstieg — sonst kauft die aktive Engine ein Symbol nach,
      //      das der Sockel schon hält; der Broker führte beide zu EINER
      //      Position zusammen, und die Besitzgrenze wäre verwischt.
      //   2. Das Klumpenrisiko — Sockel-Positionen sind echtes Marktrisiko,
      //      auch wenn sie eine andere Maschine führt.
      const coreSymbols = new Set(
        positionsSnap.docs.filter((d) => (d.data() as Position).core === true).map((d) => d.id),
      );
      const alleSymbole = (): string[] => [...positions.keys(), ...coreSymbols];
      // Risiko-Hülle GILT FÜR JEDEN TRADE dieses Users (Engine-Audit 26.07.):
      // Sie stand bisher erst weiter unten und deckte nur den Regelbaum-Pfad —
      // der Classic-Pfad kaufte mit ungeklammertem maxPositionPct, für den das
      // Schema kein Obergrenze kennt (100 % Einsatz wäre durchgegangen).
      const clamped = clampStrategyRisk(strategy);
      const now = new Date();

      /* Tages-Notbremse (M12 `core/risk.ts`).
       *
       * Der Stop-Loss schützt eine POSITION. Er hilft nicht gegen den Fall,
       * der Konten wirklich leert: viele kleine Verluste hintereinander,
       * jeder für sich regelkonform gestoppt. Bei 39 Symbolen im
       * 5-Minuten-Takt und ~24 % Trefferquote ist eine Verlustserie kein
       * Ausnahmefall.
       *
       * Die Bezugsgröße `risk.vortagEquity` schreibt der Tageslauf ans
       * User-Dokument — es ist damit schon gelesen und kostet keinen
       * zusätzlichen Read je Scan. Fehlt sie, greift die Bremse nicht: Ein
       * frisches Konto hat keinen Bezugspunkt, aber auch noch nichts
       * verloren.
       *
       * Ausgelöst wird DATUMSBASIERT vermerkt, nicht als Flag. Damit löst
       * sich die Sperre beim Tageswechsel auch dann, wenn der Tageslauf
       * ausfällt — und ein Ausfall des Tageslaufs sperrt kein Konto auf
       * Dauer aus.
       */
      const cashJetzt = (userDoc.get('wallet.paperBalance') as number | undefined) ?? 0;
      let positionsWert = 0;
      for (const d of positionsSnap.docs) {
        const p = d.data() as Position;
        positionsWert += positionValue(p, marketData.get(d.id)?.price ?? p.avgEntry);
      }
      const heuteIso = now.toISOString().slice(0, 10);
      const breaker = pruefeBreaker(
        {
          vortagEquity: (userDoc.get('risk.vortagEquity') as number | undefined) ?? 0,
          jetztEquity: cashJetzt + positionsWert,
          bereitsAusgeloest:
            (userDoc.get('risk.breakerAusgeloestAm') as string | undefined)?.slice(0, 10)
            === heuteIso,
        },
        {
          dailyLossLimitPct: clamped.engine.dailyLossLimitPct,
          flattenOnBreach: clamped.engine.flattenOnBreach,
        },
      );
      if (!breaker.einstiegErlaubt) {
        gate.breaker_aktiv += 1;
        // Grund und Zahl mitschreiben: Eine Sperre ohne Begründung ist im
        // Nachhinein nicht von einem Ausfall zu unterscheiden.
        await userDoc.ref
          .set(
            {
              risk: {
                breakerAusgeloestAm: now.toISOString(),
                breakerGrund: breaker.grund,
                breakerVerlustPct: breaker.verlustPct,
              },
            },
            { merge: true },
          )
          .catch((err: unknown) => logger.warn(`Breaker-Vermerk ${uid}`, err));
      }

      /* Abgleich Buch ↔ Depot (M13).
       *
       * Läuft bei JEDEM Scan und nicht auf Knopfdruck: Ein Abgleich, den
       * jemand auslösen muss, findet genau dann nicht statt, wenn er
       * gebraucht wird. Bei Drift werden EINSTIEGE gesperrt — Exits nie,
       * denn ein Stop, der wegen einer Buchungsdifferenz nicht auslöst,
       * wäre gefährlicher als die Differenz selbst.
       *
       * Konten ohne hinterlegten Broker (der Normalfall) kosten hier genau
       * einen Firestore-Read und keinen HTTP-Aufruf. */
      const abgleichBefund = await abgleichFuerKonto(
        uid,
        positionsSnap.docs.map((d) => d.data() as Position),
        now,
        // Bisheriger Vermerk aus dem SCHON geladenen Doc — das
        // Verlaufsprotokoll kostet so keinen zweiten Read je Konto.
        userDoc.get('risk.abgleich') as
          | { status?: string; verlauf?: import('../core/brokerAbgleich.js').VerlaufEintrag[] }
          | undefined,
      );
      if (abgleichBefund.zustand !== 'kein_broker') {
        broker.verbunden += 1;
        if (abgleichBefund.zustand === 'sauber') broker.sauber += 1;
        else if (abgleichBefund.zustand === 'drift') broker.drift += 1;
        else broker.fehler += 1;
      }
      if (abgleichBefund.sperre) gate.abgleich_drift += 1;
      // Zeitbasis der Signale (Owner 26.07., „Tradefrequenz erhöhen"):
      // 'intraday' rechnet auf 5-min-Kerzen — Signale drehen im Scan-Takt.
      const tf: 'daily' | 'intraday' = strategy.signals.timeframe ?? 'intraday';
      const cdMin = clamped.engine.cooldownMin ?? 15;
      // Positionslimit kommt jetzt aus der Strategie (Owner-Frage 28.07.:
      // „habe es nicht in den Optionen gefunden") — die Hülle klemmt nur noch.
      const posLimit = maxOpenPositions(clamped);
      const hebel = clampLeverage(clamped.broker.leverage);

      // Entry-Cooldown nach Risk-Exits (MA3-Fund 26.07.): Ohne ihn kauft die
      // Konfluenz ein per Stop-Loss verkauftes Symbol im selben/nächsten Scan
      // sofort zurück — Stop-Loss feuert in fallenden Märkten, in denen RSI/
      // Bollinger „überverkauft = kaufen" rufen (Whipsaw); nach Take-Profit
      // wäre es eine Gebühren-Schleife. Persistiert am User-Doc, damit der
      // Cooldown Scans überlebt; Einträge > 1 Tag werden weggeräumt.
      //
      // Geschrieben wird FELDWEISE, nicht als ganze Map. Der Grund kam mit
      // dem 1-Minuten-Puls (28.07.): Der setzt ebenfalls Cooldowns, und ein
      // `update({ engineCooldowns })` hätte dessen Eintrag zwischen Lesen
      // und Schreiben dieses Scans einfach überschrieben — der Scan hätte
      // dann ein Symbol zurückgekauft, das der Puls Sekunden zuvor
      // ausgestoppt hat. Genau der Whipsaw, gegen den der Cooldown da ist.
      // Feldweise Updates sind reihenfolgeunabhängig; Abgelaufenes wird
      // explizit gelöscht statt durch Weglassen (Weglassen entfernt bei
      // merge nichts).
      const engineCooldowns: Record<string, string> = {
        ...((userDoc.get('engineCooldowns') as Record<string, string> | undefined) ?? {}),
      };
      const cooldownUpdates: unknown[] = [];
      for (const [sym, at] of Object.entries(engineCooldowns)) {
        if (!Number.isFinite(Date.parse(at)) || now.getTime() - Date.parse(at) > 86_400_000) {
          delete engineCooldowns[sym];
          cooldownUpdates.push(new FieldPath('engineCooldowns', sym), FieldValue.delete());
        }
      }

      // 1) Risiko-Exits zuerst (Port von _check_risk — vor neuen Signalen).
      // Seit MA2/MA6: klassen-aufgelöste Parameter, ATR-Option, nachziehender
      // Stop (dafür wird highWater bei jedem Scan fortgeschrieben) und
      // Zeitgrenze — alles in riskExitReason gebündelt.
      for (const [symbol, pos] of positions) {
        const data = marketData.get(symbol);
        if (!data) continue;
        const cls = classify(symbol);
        const isShort = pos.side === 'short';
        if (isShort) {
          // Tiefstkurs seit Short-Einstieg mitziehen (Basis des Short-Trailings)
          const trough = Math.min(pos.lowWater ?? pos.avgEntry, data.price);
          if (trough < (pos.lowWater ?? Infinity) - 1e-9) {
            pos.lowWater = trough;
            await userDoc.ref
              .collection('positions')
              .doc(symbol)
              .set({ lowWater: trough }, { merge: true })
              .catch(() => undefined);
          }
        } else {
          // Höchstkurs seit Einstieg mitziehen, BEVOR der Trailing-Stop prüft
          const peak = Math.max(pos.highWater ?? pos.avgEntry, data.price);
          if (peak > (pos.highWater ?? 0) + 1e-9) {
            pos.highWater = peak;
            await userDoc.ref
              .collection('positions')
              .doc(symbol)
              .set({ highWater: peak }, { merge: true })
              .catch(() => undefined);
          }
        }
        // Schutz-Stop-Pflege (Bracket Stufe 1, 06.08.): BEVOR die eigenen
        // Stops prüfen. Hat der Broker-Stop ZWISCHEN den Scans ausgelöst,
        // ist die Position dort schon verkauft — dann wird der echte Fill
        // gebucht statt ein zweiter Verkauf versucht. Steht die Order noch,
        // zieht die Pflege sie dem Trailing nach (nach der Wasserstands-
        // Fortschreibung oben, damit das frische Hoch zählt).
        if (pos.broker === true && pos.schutz?.orderId) {
          const verbindung = await brokerVerbindung(uid);
          if (verbindung) {
            const befund = await pflegeSchutz(
              verbindung,
              uid,
              symbol,
              pos,
              resolveRisk(clamped.engine, cls),
              cls,
              scanId,
            );
            if (befund.stand === 'gefuellt') {
              const r = await executePaperTrade(
                {
                  uid,
                  symbol,
                  side: isShort ? 'buy' : 'sell',
                  price: befund.fillPreis,
                  qty: befund.fillQty,
                  fillPreis: befund.fillPreis,
                  source: 'engine',
                  riskExit: 'stop_loss',
                  assetClass: cls,
                  brokerOrderId: befund.orderId,
                },
                clamped,
              );
              if (r.executed) {
                executed += 1;
                positions.delete(symbol);
                engineCooldowns[symbol] = now.toISOString();
                cooldownUpdates.push(new FieldPath('engineCooldowns', symbol), now.toISOString());
                logger.info(`Broker-Stop gebucht ${uid} ${symbol} @ ${befund.fillPreis}`);
                continue;
              }
              // Fill bekannt, Buchung gescheitert: NICHT weiterprüfen — ein
              // Engine-Exit würde denselben Bestand ein zweites Mal verkaufen.
              logger.error(`Broker-Stop-Fill NICHT gebucht ${uid} ${symbol}: ${r.reason ?? '?'}`);
              continue;
            }
          }
        }
        const reason = riskExitReason(pos, data.price, {
          risk: resolveRisk(clamped.engine, cls),
          atrPct: data.atrPct,
          now,
        });
        if (reason) {
          // Long schließt per Verkauf, Short per Eindecken (buy/Cover)
          const r = await executeTrade(
            { uid, symbol, side: isShort ? 'buy' : 'sell', price: data.price, source: 'engine', riskExit: reason, assetClass: cls },
            clamped,
            scanId,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            engineCooldowns[symbol] = now.toISOString();
            cooldownUpdates.push(
              new FieldPath('engineCooldowns', symbol),
              now.toISOString(),
            );
            logger.info(`Risk-Exit ${uid} ${symbol} (${reason}${isShort ? ', short' : ''})`);
          }
        }
      }

      // ── Hebel-Budget (Owner-Wunsch 28.07.) ─────────────────────────────
      //
      // Bewusst HIER, nach den Risiko-Exits: Ein Konto, das gerade
      // ausgestoppt wurde, hat mehr Kaufkraft als vor dem Scan. Vorher
      // gerechnet wäre das Budget systematisch zu klein — und nach einem
      // Margin-Call sogar noch von der Position belastet, die es gerade
      // losgeworden ist.
      //
      // Zwei Zahlen, weil sie sich beim Short unterscheiden: `kontoWert` ist
      // der Rückfluss beim Schließen (Basis der Equity), `kontoExposure` der
      // am Markt bewegte Gegenwert (Basis der Besicherung).
      const kontoCash = (userDoc.get('wallet.paperBalance') as number | undefined) ?? 0;
      let kontoWert = 0;
      let kontoExposure = 0;
      for (const p of positions.values()) {
        const preis = marketData.get(p.symbol)?.price ?? p.avgEntry;
        kontoWert += positionValue(p, preis);
        kontoExposure += Math.abs(p.qty * preis);
      }
      // In diesem Scan bereits gebundene Kaufkraft. Ohne diesen Zähler stünde
      // JEDEM Kauf desselben Scans das volle Budget zur Verfügung — aus 3×
      // Hebel würden bei zehn Käufen faktisch beliebig viele. Der Broker kann
      // das nicht abfangen: Seine Transaktion sieht nur den Cash, nicht die
      // Kurse der übrigen Positionen. Ausstiege GEBEN hier nichts zurück; das
      // ist bewusst zu wenig statt zu viel.
      let gebundeneKaufkraft = 0;
      /**
       * Margin-Budget für GENAU DIESE Entscheidung — `undefined` heißt: bar
       * gedeckt handeln wie vor dem Hebel.
       *
       * Der Hebel greift nur über der Einstiegsschwelle plus Bonus
       * (Owner-Vorgabe: „nur wenn der Algorithmus sich sehr sicher ist").
       * Ein Grenzsignal handelt weiter mit Bargeld.
       */
      const hebelBudget = (
        konfluenz: number,
        chance?: { bucket: BucketStat | null; side: 'long' | 'short'; symbol: string; edgeMultiple: number | null },
      ): MarginBudget | undefined => {
        if (hebel <= 1) return undefined;
        // HEBEL-AMPEL (04.08.): Konfluenz allein reicht nicht mehr. Sie misst,
        // wie viele Indikatoren einer Meinung sind — nicht, ob diese Meinung
        // je Geld verdient hat. Am 02.08. hatten alle vier verlierenden
        // Short-Steckbriefe Konfluenz; Hebel darauf hätte den Verlust
        // vervielfacht. Jetzt entscheidet die Konjunktion aus Konfluenz,
        // Regime, BELEGTER Kante, Positionierung und Kostenabstand.
        const eff = chance
          ? leverageChance({
              konfluenz,
              requiredConfluence: clamped.signals.minConfluence,
              leverage: hebel,
              regime,
              bucket: chance.bucket,
              side: chance.side,
              positioning: positionierung.get(chance.symbol) ?? null,
              edgeMultiple: chance.edgeMultiple,
            }).hebel
          : effectiveLeverage(konfluenz, clamped.signals.minConfluence, hebel);
        if (eff > 1) gate.hebel_frei += 1;
        if (eff <= 1) return undefined;
        const st = marginState(kontoCash, kontoWert, eff, kontoExposure);
        return {
          equity: st.equity,
          buyingPower: Math.max(0, st.buyingPower - gebundeneKaufkraft),
          leverage: eff,
        };
      };

      /**
       * Die drei Einstiegs-Filter aus der Live-Auswertung vom 28.07.
       *
       * Sie hängen zusammen und stehen deshalb an EINER Stelle: Jeder Pfad
       * (Konfluenz, Regelbaum, Long, Short) muss dieselbe Antwort bekommen.
       * Vier Kopien derselben Regel wären vier Gelegenheiten, eine davon zu
       * vergessen — und ein Filter, der nur in drei von vier Pfaden greift,
       * sieht in der Auswertung aus wie ein Filter, der nicht wirkt.
       *
       * Ausstiege durchlaufen das hier NIE. Eine offene Position muss
       * geschlossen werden können, auch wenn ihr Symbol inzwischen als nicht
       * handelbar gilt oder ihr Block voll ist.
       */
      const entrySperre = (
        symbol: string,
        atrPct: number | null | undefined,
        offen: readonly string[],
        side: 'long' | 'short',
      ):
        | 'nicht_handelbar'
        | 'cluster_voll'
        | 'news_veto'
        | 'unter_kosten'
        | 'klasse_aus'
        | 'breaker_aktiv'
        | 'abgleich_drift'
        | 'regime_gegen_trend'
        | 'regime_stress'
        | null => {
        gate.geprueft += 1;
        // Die Notbremse steht VOR allen anderen Prüfungen: Wenn das Konto
        // heute genug verloren hat, ist jede weitere Abwägung müßig. Der
        // Zähler steht bewusst nicht hier — er zählt je KONTO, nicht je
        // geprüftem Symbol, sonst sähe ein gesperrtes Konto mit 39 Symbolen
        // aus wie 39 Sperren.
        if (!breaker.einstiegErlaubt) return 'breaker_aktiv';
        // Gleich dahinter: Wenn Buch und Depot nicht übereinstimmen, ist
        // jede Größenrechnung für den Einstieg auf Sand gebaut. Zähler
        // ebenfalls je KONTO (siehe oben), nicht je Symbol.
        if (abgleichBefund.sperre) return 'abgleich_drift';
        const handelbar = isTradable(symbol);
        // Regime-Ampel Stufe 2 (04.08.): Im Aufwärtstrend keine Shorts, im
        // Stress gar keine neuen Einstiege. Die Messung dahinter steht an
        // regimeEntryBlocked; abschaltbar je User (signals.regimeGate).
        const regimeSperre =
          clamped.signals.regimeGate !== false ? regimeEntryBlocked(regime, side) : null;
        const platz = handelbar && clusterHasRoom(offen, symbol);
        // News-Veto (29.07.): frisches hartes Ereignis sperrt NEUE Einstiege.
        // Nur Einstiege — Ausstiege durchlaufen entrySperre nie (s. o.).
        // Abschaltbar je User (signals.newsVeto); fehlend = an.
        const veto =
          handelbar && clamped.signals.newsVeto !== false
            ? newsVeto(marketData.get(symbol)?.news, Math.floor(Date.now() / 1000))
            : { blocked: false };
        const klasse = classify(symbol);
        const kostenBasis = {
          atrPct,
          minHoldMin: clamped.engine.minHoldMin,
          timeframe: tf,
          feeRate: feeRateForClass(klasse),
          ...(typeof clamped.signals.minEdgeMultiple === 'number'
            ? { multiple: clamped.signals.minEdgeMultiple }
            : {}),
        };
        // Die Kostenschwelle wird ZWEIMAL gerechnet (04.08.):
        //
        //  `kosten`  wie bisher — Auslenkung gegen Kosten. Diese Fassung
        //            entscheidet, solange `signals.captureGate` nicht an ist.
        //  `mitKante` zusätzlich mit der Einfangquote der Anlageklasse.
        //
        // Warum nicht sofort scharf: Die Einfangquoten stammen aus EINER
        // Messwoche. Sie ungeprüft scharf zu schalten hieße, den Handel auf
        // eine Schätzung zu drosseln — und ein Filter, der zu viel blockt,
        // beendet auch die Datensammlung, die ihn korrigieren würde. Der
        // Schattenzähler zeigt erst, WIE VIELE Einstiege betroffen wären;
        // scharf wird er, wenn die Zahl das rechtfertigt.
        const kostenOhneKante = costGate(kostenBasis);
        const mitKante = costGate({ ...kostenBasis, capture: captureForClass(klasse) });
        const kosten = clamped.signals.captureGate === true ? mitKante : kostenOhneKante;
        // ALLE zutreffenden Gründe zählen, nicht nur den ersten. Der erste
        // Live-Lauf am 28.07. zeigte warum: `cluster_voll` stand auf 13,
        // `unter_kosten` auf 0 — nicht weil die Kostenschwelle nichts tat,
        // sondern weil der Korrelations-Deckel vorher zugeschlagen hatte.
        // Zum Feinjustieren der Schwelle braucht man beide Zahlen.
        if (!handelbar) gate.nicht_handelbar += 1;
        else if (!platz) gate.cluster_voll += 1;
        if (handelbar) {
          if (veto.blocked) gate.news_veto += 1;
          if (!kosten.ok) gate.unter_kosten += 1;
          // Der stille Fall: durchgelassen, weil nicht prüfbar.
          else if (kosten.reason === 'kein_atr') gate.ohne_atr_durchgelassen += 1;
          // Schattenzähler: Was die Kanten-Fassung ZUSÄTZLICH blocken würde.
          // Nur zählen, wenn die scharfe Fassung durchlässt — sonst stünde
          // derselbe Einstieg in beiden Zählern und die Zahl läse sich wie
          // ein doppelter Effekt.
          if (kosten.ok && !mitKante.ok) gate.kante_wuerde_blocken += 1;
          if (klassenGewicht(clamped, symbol) <= 0) gate.klasse_aus += 1;
        }
        if (regimeSperre === 'stress') gate.regime_stress += 1;
        else if (regimeSperre === 'gegen_trend') gate.regime_gegen_trend += 1;
        if (!handelbar) return 'nicht_handelbar';
        if (regimeSperre === 'stress') return 'regime_stress';
        if (regimeSperre === 'gegen_trend') return 'regime_gegen_trend';
        if (!platz) return 'cluster_voll';
        if (veto.blocked) return 'news_veto';
        if (klassenGewicht(clamped, symbol) <= 0) return 'klasse_aus';
        return kosten.ok ? null : 'unter_kosten';
      };

      /**
       * Stop-Abstand dieses Symbols in % — Basis des Risiko-Sizings.
       * Klassen-aufgelöst und mit derselben Vorrangregel wie der spätere
       * Ausstieg (ATR schlägt Prozent), damit Dimensionierung und Stop
       * dieselbe Zahl benutzen.
       */
      /**
       * Erwartete Bewegung geteilt durch die Roundtrip-Kosten — die Zahl, die
       * die Hebel-Ampel als „günstige Gelegenheit" prüft. Dieselben Eingaben
       * wie im Kosten-Tor des Einstiegs, damit beide dieselbe Wette bewerten.
       */
      const kostenVielfaches = (symbol: string, atrPct: number | null | undefined): number | null => {
        const k = costGate({
          atrPct,
          minHoldMin: clamped.engine.minHoldMin,
          timeframe: tf,
          feeRate: feeRateForClass(classify(symbol)),
        });
        return k.costPct > 0 ? k.expectedPct / k.costPct : null;
      };

      const stopAbstand = (symbol: string, atrPct: number | null | undefined): number =>
        stopDistancePct(resolveRisk(clamped.engine, classify(symbol)), atrPct);

      // 2) Regelbaum-Strategien (M10): publizierte Strategien mit Zuordnung
      // handeln ihre Symbole SELBST — der Classic-Pfad überspringt sie.
      // User-Prognosen (Chart-Pfeile): Opt-in übers Options-Modal (Feedback
      // 25.07.) — ohne settings.ui.predArrow === true zählt KEINE Prognose,
      // gespeicherte Pfeile bleiben aber erhalten (Reaktivierung möglich).
      const predArrowOn = userDoc.get('settings.ui.predArrow') === true;
      const predSnap = predArrowOn ? await userDoc.ref.collection('predictions').get() : null;
      const predictions = new Map(
        (predSnap?.docs ?? []).map((d) => [d.id, d.data() as import('../../../shared/src/index.js').UserPrediction]),
      );
      const todayIso = new Date().toISOString();

      const stratSnap = await userDoc.ref
        .collection('strategies')
        .where('status', '==', 'published')
        .get();
      const published = stratSnap.docs
        .map((d) => ({ ref: d.ref, doc: d.data() as StrategyDoc & { lastTrades?: Record<string, string> } }))
        .filter((s) => s.doc.compiled && (s.doc.symbols ?? []).length > 0);
      // Nur PAPER-Strategien besitzen ihre Symbole exklusiv — Shadow
      // beobachtet parallel (A/B) und blockt den Classic-Pfad nicht.
      const strategyOwned = new Set(
        published.filter((s) => (s.doc.mode ?? 'paper') === 'paper').flatMap((s) => s.doc.symbols),
      );
      const minuteEt = minuteOfDayEt(now);

      for (const { ref, doc } of published) {
        const isShadow = (doc.mode ?? 'paper') === 'shadow';
        // Shadow-Konto lokal führen; geschrieben wird EINMAL nach der Schleife
        let book: ShadowBook | null =
          isShadow && doc.shadow
            ? { balance: doc.shadow.balance, positions: { ...doc.shadow.positions } }
            : null;
        let bookChanged = false;
        const lastDirs: Record<string, 'buy' | 'sell' | 'hold'> = { ...(doc.lastDirs ?? {}) };
        let dirsChanged = false;

        for (const symbol of doc.symbols) {
          const data = marketData.get(symbol);
          if (!data) continue; // Klasse geschlossen oder Symbol nicht im Scan
          const pos = positions.get(symbol) ?? null;
          // Regelbaum rechnet auf derselben Zeitbasis wie die Konfluenz
          const closes = signalCloses(data, tf);
          const snapshot = computeIndicatorSnapshot(closes, data.price, strategy.indicators);
          const prevCloses = closes.slice(0, -1);
          const prevPrice = prevCloses[prevCloses.length - 1] ?? null;
          const ctx = buildRuleContext({
            price: data.price,
            snapshot,
            prevSnapshot:
              prevPrice !== null && prevCloses.length > 1
                ? computeIndicatorSnapshot(prevCloses, prevPrice, strategy.indicators)
                : null,
            prevPrice,
            closes,
            minuteOfDayEt: minuteEt,
            forecastPct: tf === 'intraday' ? (data.intradayPct ?? null) : (data.forecast?.predictedPct ?? null),
            position: pos
              ? {
                  open: true,
                  // Shorts verdienen am fallenden Kurs — unrealizedPct gespiegelt
                  unrealizedPct:
                    ((pos.side === 'short' ? pos.avgEntry - data.price : data.price - pos.avgEntry) / pos.avgEntry) * 100,
                }
              : { open: false },
          });
          const dir = decideTree(doc.compiled!, ctx);

          if (isShadow) {
            // shadowSignals NUR beim Entscheidungs-Wechsel (M11)
            if (dir !== (lastDirs[symbol] ?? 'hold')) {
              lastDirs[symbol] = dir;
              dirsChanged = true;
              if (dir !== 'hold') {
                await ref
                  .collection('shadowSignals')
                  .doc(`${new Date().toISOString().slice(0, 16)}Z_${symbol}`)
                  .set({ symbol, direction: dir, price: data.price, at: new Date().toISOString() });
              }
            }
            if (book) {
              // Duell-Fairness (MA4-Fund 26.07.): Das Shadow-Buch lebt unter
              // DENSELBEN Risiko-Regeln wie das echte Paper-Konto — vorher
              // kannte es weder Stop/Trailing/Zeitgrenze noch die Sizing-
              // Basis; Kennzahlen-Duell und „Befördern" verglichen Äpfel mit
              // Birnen. highWater wird wie beim echten Konto je Scan
              // fortgeschrieben, dann prüfen dieselben riskExitReason-Regeln.
              const sPos = book.positions[symbol];
              if (sPos) {
                const sShort = sPos.side === 'short';
                if (sShort) {
                  // Tiefstkurs fortschreiben (Short-Trailing, Parität R2)
                  const trough = Math.min(sPos.lowWater ?? sPos.avgEntry, data.price);
                  if (trough < (sPos.lowWater ?? Infinity) - 1e-9) {
                    book.positions[symbol] = { ...sPos, lowWater: trough };
                    bookChanged = true;
                  }
                } else {
                  const peak = Math.max(sPos.highWater ?? sPos.avgEntry, data.price);
                  if (peak > (sPos.highWater ?? 0) + 1e-9) {
                    book.positions[symbol] = { ...sPos, highWater: peak };
                    bookChanged = true;
                  }
                }
                const cls = classify(symbol);
                const reason = riskExitReason(
                  {
                    symbol,
                    qty: sPos.qty,
                    avgEntry: sPos.avgEntry,
                    stopLoss: null,
                    takeProfit: null,
                    openedAt: sPos.openedAt ?? now.toISOString(),
                    ...(sShort
                      ? { side: 'short' as const, lowWater: Math.min(sPos.lowWater ?? sPos.avgEntry, data.price) }
                      : { highWater: Math.max(sPos.highWater ?? sPos.avgEntry, data.price) }),
                  },
                  data.price,
                  { risk: resolveRisk(clamped.engine, cls), atrPct: data.atrPct, now },
                );
                if (reason) {
                  // Long schließt per Verkauf, Short per Eindecken (Parität)
                  const r = shadowTrade(book, symbol, sShort ? 'buy' : 'sell', data.price, clamped.engine.maxPositionPct);
                  if (r.executed) {
                    book = r.book;
                    bookChanged = true;
                    await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                    await ref
                      .collection('shadowSignals')
                      .doc(`${now.toISOString().slice(0, 16)}Z_${symbol}_risk`)
                      .set({ symbol, direction: sShort ? 'buy' : 'sell', riskExit: reason, price: data.price, at: now.toISOString() });
                    continue; // Position ist zu — Baum-Entscheidung dieses Scans ist erledigt
                  }
                }
              }
              // Virtuelles Konto — Risiko-Hülle wie beim echten Handel
              const sizingCapital = (): number =>
                (clamped.broker.sizingBase ?? 'balance') === 'initial'
                  ? clamped.broker.initialCapital
                  : book!.balance;
              if (dir === 'buy' && book.positions[symbol]?.side === 'short') {
                // Kauf-Signal deckt den Shadow-Short ein (Cover)
                const r = shadowTrade(book, symbol, 'buy', data.price, clamped.engine.maxPositionPct);
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              } else if (dir === 'buy' && !book.positions[symbol]) {
                if (Object.keys(book.positions).length >= posLimit) continue;
                if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
                // Dieselben Filter wie im echten Buch — sonst wäre das
                // A/B-Duell verzerrt: Der Schatten dürfte Trades machen, die
                // dem echten Konto verboten sind, und gewönne aus dem
                // falschen Grund.
                if (entrySperre(symbol, data.atrPct, Object.keys(book.positions), 'long')) continue;
                // Sizing-Parität (MA4): gleiche Basis wie der echte Broker —
                // Cash (Default) oder Startkapital, Deckung prüft der Cash.
                const r = shadowTrade(book, symbol, 'buy', data.price, clamped.engine.maxPositionPct, {
                  capital: sizingCapital(),
                  now,
                  fractional: classify(symbol) === 'crypto',
                });
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  // Cooldown-Parität: Auch Shadow-Entries stempeln lastTrades —
                  // vorher schrieb nur der Paper-Pfad und der Shadow-Cooldown
                  // war wirkungslos (Shadow durfte im 5-min-Takt handeln).
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              } else if (dir === 'sell' && book.positions[symbol] && book.positions[symbol]?.side !== 'short') {
                const r = shadowTrade(book, symbol, 'sell', data.price, clamped.engine.maxPositionPct);
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              } else if (dir === 'sell' && !book.positions[symbol] && strategy.signals.allowShort === true) {
                // Shadow-Short (R2): gleiche Entry-Guards wie der echte Pfad
                if (Object.keys(book.positions).length >= posLimit) continue;
                if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
                if (entrySperre(symbol, data.atrPct, Object.keys(book.positions), 'short')) continue;
                const r = shadowTrade(book, symbol, 'sell', data.price, clamped.engine.maxPositionPct, {
                  capital: sizingCapital(),
                  now,
                  fractional: classify(symbol) === 'crypto',
                  openShort: true,
                });
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              }
            }
            continue; // Shadow berührt NIE das echte Wallet
          }

          if (dir === 'buy' && pos?.side === 'short') {
            // Kauf-Signal deckt den Regelbaum-Short ein (Cover, Short R2);
            // Exits blockt der Cooldown NIE (Sicherheitsprinzip)
            const r = await executeTrade(
              { uid, symbol, side: 'buy', price: data.price, source: 'engine', assetClass: classify(symbol) },
              clamped,
              scanId,
            );
            if (r.executed) {
              executed += 1;
              positions.delete(symbol);
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Cover ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'buy' && !pos) {
            // Entry-Guards der Risiko-Hülle: Positionslimit + Cooldowns
            // (je Strategie UND nach Risk-Exits desselben Wallets)
            if (positions.size >= posLimit) continue;
            if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
            if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
            if (coreSymbols.has(symbol)) continue; // hält der Sockel — Besitzgrenze
            if (entrySperre(symbol, data.atrPct, alleSymbole(), 'long')) continue;
            // assetClass durchreichen (MA3-Fund 26.07.): Ohne sie schrieb der
            // Broker die Stop/Take-LEVEL mit den GLOBALEN Prozenten fest —
            // die MA6-Klassen-Profile (Krypto 6/10 usw.) griffen beim Kauf
            // nie, und gespeicherte Level haben bewusst Vorrang (MA1).
            const r = await executeTrade(
              {
                uid,
                symbol,
                side: 'buy',
                price: data.price,
                source: 'engine',
                assetClass: classify(symbol),
                stopDistancePct: stopAbstand(symbol, data.atrPct),
                // Regelbaum liefert ja/nein statt Vote-Karte — eigener Steckbrief
                bucket: bucketKey({ assetClass: classify(symbol), timeframe: tf, signature: 'regelbaum', side: 'long', regime }),
              },
              clamped,
              scanId,
            );
            if (r.executed) {
              executed += 1;
              // Der Regelbaum handelt bar gedeckt (er liefert ja/nein, kein
              // Maß für Überzeugung — siehe hebelBudget). Sein Kauf bindet
              // aber trotzdem Cash, den der Classic-Pfad gleich nicht mehr
              // hat; ohne diese Zeile wäre dessen Kaufkraft zu groß.
              gebundeneKaufkraft += (r.trade?.qty ?? 0) * (r.trade?.price ?? data.price);
              // lokaler Marker fürs Positionslimit/Dedup in diesem Scan
              positions.set(symbol, {
                symbol,
                qty: r.trade?.qty ?? 0,
                avgEntry: r.trade?.price ?? data.price,
                stopLoss: null,
                takeProfit: null,
                openedAt: now.toISOString(),
              });
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Buy ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'sell' && pos && pos.side !== 'short') {
            // Exits blockt der Cooldown NIE (Sicherheitsprinzip) — die
            // Mindest-Haltedauer bremst dagegen sehr wohl, weil sie nur den
            // SIGNAL-Ausstieg betrifft. Stop/Trailing/Take sind in diesem
            // Scan bereits gelaufen und bleiben jederzeit scharf.
            if (minHoldActive(pos.openedAt, now, clamped.engine.minHoldMin ?? 0)) continue;
            const r = await executeTrade(
              { uid, symbol, side: 'sell', price: data.price, source: 'engine', assetClass: classify(symbol) },
              clamped,
              scanId,
            );
            if (r.executed) {
              executed += 1;
              positions.delete(symbol);
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Sell ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'sell' && !pos && strategy.signals.allowShort === true) {
            // Regelbaum-Short (R2): Verkaufs-Signal ohne Position — gleiche
            // Entry-Guards wie beim Kauf, Level gespiegelt im Broker.
            if (positions.size >= posLimit) continue;
            if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
            if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
            if (coreSymbols.has(symbol)) continue; // hält der Sockel — Besitzgrenze
            if (entrySperre(symbol, data.atrPct, alleSymbole(), 'short')) continue;
            const r = await executeTrade(
              {
                uid,
                symbol,
                side: 'sell',
                price: data.price,
                source: 'engine',
                assetClass: classify(symbol),
                openShort: true,
                stopDistancePct: stopAbstand(symbol, data.atrPct),
                bucket: bucketKey({ assetClass: classify(symbol), timeframe: tf, signature: 'regelbaum', side: 'short', regime }),
              },
              clamped,
              scanId,
            );
            if (r.executed) {
              executed += 1;
              gebundeneKaufkraft += (r.trade?.qty ?? 0) * (r.trade?.price ?? data.price);
              positions.set(symbol, {
                symbol,
                qty: r.trade?.qty ?? 0,
                avgEntry: r.trade?.price ?? data.price,
                side: 'short',
                stopLoss: null,
                takeProfit: null,
                openedAt: now.toISOString(),
              });
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Short ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          }
        }

        if (bookChanged || dirsChanged) {
          const prices = new Map<string, number>();
          for (const sym of doc.symbols) {
            const d = marketData.get(sym);
            if (d) prices.set(sym, d.price);
          }
          const patch: Record<string, unknown> = { updatedAt: now.toISOString() };
          if (dirsChanged) patch.lastDirs = lastDirs;
          if (book && bookChanged) {
            patch.shadow = {
              ...doc.shadow,
              balance: Math.round(book.balance * 100) / 100,
              positions: book.positions,
              equity: shadowEquity(book, prices),
              updatedAt: now.toISOString(),
            };
          }
          await ref.set(patch, { merge: true });
        }
      }

      // 3) Konfluenz-Signale gegen die User-Strategie (inkl. Forecast-Vote);
      // Symbole mit zugeordneter publizierter Strategie gehören dieser (oben).
      //
      // Gehandelt wird ALLES, was der Scan geladen hat — nicht mehr die
      // handverlesene Watchlist (Owner-Frage 28.07.). Das Scan-Set kommt
      // aus dem Momentum-Ranking über den ganzen Katalog plus den offenen
      // Positionen; wer es zusätzlich auf eine Watchlist einschränkte,
      // schöbe eine unbegründete Vorauswahl vor eine begründete.
      for (const symbol of marketData.keys()) {
        if (strategyOwned.has(symbol)) continue;
        const data = marketData.get(symbol);
        if (!data) continue;
        // Positionskontext entscheidet über Ein- oder Ausstiegs-Regeln:
        // Der Ausstieg ist bewusst leichter (MA2) — ein verpasster Verkauf
        // kostet Geld, ein verpasster Kauf nur eine Chance.
        // Zeitbasis 'intraday': 5-min-Kerzen + Kurzfrist-Prognose als
        // Forecast-Stimme (die Tages-Prognose passt nicht zum 5-min-Signal).
        const pos = positions.get(symbol) ?? null;
        const sig = computeSignal(
          signalCloses(data, tf),
          data.price,
          strategy.indicators,
          strategy.signals,
          tf === 'intraday'
            ? (data.intradayPct != null ? { predictedPct: data.intradayPct } : null)
            : data.forecast,
          { hasPosition: pos !== null, ...(pos?.side === 'short' ? { positionSide: 'short' as const } : {}) },
        );
        // Prognose-Pfeil des Users als zusätzliche gewichtete Stimme
        const vote = predictionVote(predictions.get(symbol), data.price, todayIso);
        const direction = applyPredictionVote(sig, vote);
        // Überzeugungsstärke der GEWÄHLTEN Richtung, inklusive Prognose-Pfeil
        // — genau die Zahl, an der der Hebel hängt. `sig.confluence` allein
        // wäre falsch, sobald der Pfeil die Richtung gedreht hat.
        const konfluenz =
          direction === 'buy'
            ? sig.buyVotes + (vote?.dir === 'buy' ? vote.weight : 0)
            : sig.sellVotes + (vote?.dir === 'sell' ? vote.weight : 0);
        const allowShort = strategy.signals.allowShort === true;
        // Ausführung IMMER mit der geklammerten Strategie (Audit 26.07.):
        // Positionsgröße und Stop-Level kommen aus der Risiko-Hülle.
        if (direction === 'buy' && pos?.side === 'short') {
          // Kauf-Signal auf offenen Short = Eindecken (Cover)
          const r = await executeTrade(
            { uid, symbol, side: 'buy', price: data.price, source: 'engine', assetClass: classify(symbol) },
            clamped,
            scanId,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            logger.info(`Engine-Cover ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'buy' && !pos) {
          // Entry-Guards auch im Classic-Pfad (MA3-Fund 26.07.): Das
          // Positionslimit galt vorher nur für Regelbaum-Käufe — die
          // Konfluenz konnte beliebig viele Positionen öffnen. Und nach
          // einem Risk-Exit hält der Cooldown den Sofort-Rückkauf auf.
          if (positions.size >= posLimit) continue;
          if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
          if (coreSymbols.has(symbol)) continue; // hält der Sockel — Besitzgrenze
          if (entrySperre(symbol, data.atrPct, alleSymbole(), 'long')) continue;
          // Steckbrief des Einstiegs (Trade-Filter, scharf seit 02.08.):
          // Sorten, deren EIGENE Historie n≥30 und t≤−1,5 zeigt, werden
          // nicht mehr gehandelt — nur gezählt. Exits bleiben frei.
          const bucket = bucketKey({
            assetClass: classify(symbol),
            timeframe: tf,
            signature: signalSignature(sig.votes, 'buy'),
            side: 'long',
            regime,
          });
          if (bucketVerdict(filterBuckets[bucket]).blocked) {
            gate.filter_blockiert += 1;
            continue;
          }
          // Überzeugungs-Sizing (Owner 01.08.): Einsatz folgt messbarer
          // Überzeugung — Konfluenz-Überschuss plus REALISIERTE Kante des
          // Steckbriefs; nachweislich schwache Sorten handeln halbiert.
          // Klassen-Regler (04.08.) multipliziert auf die Überzeugung. Der
          // Broker deckelt das Produkt weiterhin bei 1,5 und die
          // Klumpengrenze bleibt die letzte Instanz — die beiden Faktoren
          // können sich also nicht zu einem Hebel aufaddieren.
          const sizeFactor =
            convictionFactor({
              konfluenz,
              requiredConfluence: clamped.signals.minConfluence,
              bucket: filterBuckets[bucket] ?? null,
            }) * klassenGewicht(clamped, symbol);
          const budget = hebelBudget(konfluenz, {
            bucket: filterBuckets[bucket] ?? null,
            side: 'long',
            symbol,
            edgeMultiple: kostenVielfaches(symbol, data.atrPct),
          });
          const r = await executeTrade(
            {
              uid,
              symbol,
              side: 'buy',
              price: data.price,
              source: 'engine',
              assetClass: classify(symbol),
              stopDistancePct: stopAbstand(symbol, data.atrPct),
              bucket,
              sizeFactor,
              ...(budget ? { margin: budget } : {}),
            },
            clamped,
            scanId,
          );
          if (r.executed) {
            executed += 1;
            gebundeneKaufkraft += (r.trade?.qty ?? 0) * (r.trade?.price ?? data.price);
            // Map mitführen: Ein Symbol kann in der Watchlist doppelt stehen —
            // ohne das versuchte der Scan denselben Kauf zweimal (der Broker
            // lehnt transaktional ab, aber der Aufruf ist unnötig). Die Level
            // bleiben null: Risk-Exits liefen für diesen Scan bereits oben.
            positions.set(symbol, {
              symbol,
              qty: r.trade?.qty ?? 0,
              avgEntry: r.trade?.price ?? data.price,
              stopLoss: null,
              takeProfit: null,
              openedAt: r.trade?.executedAt ?? now.toISOString(),
            });
            logger.info(`Engine-Buy ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'sell' && pos && pos.side !== 'short') {
          // Signal-Ausstieg erst nach der Mindest-Haltedauer. Die Risiko-Exits
          // (Stop, Trailing, Take) sind oben in diesem Scan bereits gelaufen —
          // das Sicherheitsnetz bleibt also jederzeit scharf, gebremst wird
          // nur das Rausspucken durch eine gekippte Indikator-Stimme.
          if (minHoldActive(pos.openedAt, now, clamped.engine.minHoldMin ?? 0)) continue;
          const r = await executeTrade(
            { uid, symbol, side: 'sell', price: data.price, source: 'engine', assetClass: classify(symbol) },
            clamped,
            scanId,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            logger.info(`Engine-Sell ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'sell' && !pos && allowShort) {
          // Leerverkauf (Opt-in): Verkaufs-Signal ohne Position eröffnet
          // einen Short — gleiche Entry-Guards wie beim Kauf (Limit,
          // Cooldown), gleiche Risiko-Hülle, Level gespiegelt im Broker.
          if (positions.size >= posLimit) continue;
          if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
          if (coreSymbols.has(symbol)) continue; // hält der Sockel — Besitzgrenze
          if (entrySperre(symbol, data.atrPct, alleSymbole(), 'short')) continue;
          const bucket = bucketKey({
            assetClass: classify(symbol),
            timeframe: tf,
            signature: signalSignature(sig.votes, 'sell'),
            side: 'short',
            regime,
          });
          if (bucketVerdict(filterBuckets[bucket]).blocked) {
            gate.filter_blockiert += 1;
            continue;
          }
          // Klassen-Regler (04.08.) multipliziert auf die Überzeugung. Der
          // Broker deckelt das Produkt weiterhin bei 1,5 und die
          // Klumpengrenze bleibt die letzte Instanz — die beiden Faktoren
          // können sich also nicht zu einem Hebel aufaddieren.
          const sizeFactor =
            convictionFactor({
              konfluenz,
              requiredConfluence: clamped.signals.minConfluence,
              bucket: filterBuckets[bucket] ?? null,
            }) * klassenGewicht(clamped, symbol);
          const budget = hebelBudget(konfluenz, {
            bucket: filterBuckets[bucket] ?? null,
            side: 'short',
            symbol,
            edgeMultiple: kostenVielfaches(symbol, data.atrPct),
          });
          const r = await executeTrade(
            {
              uid,
              symbol,
              side: 'sell',
              price: data.price,
              source: 'engine',
              assetClass: classify(symbol),
              openShort: true,
              stopDistancePct: stopAbstand(symbol, data.atrPct),
              bucket,
              sizeFactor,
              ...(budget ? { margin: budget } : {}),
            },
            clamped,
            scanId,
          );
          if (r.executed) {
            executed += 1;
            gebundeneKaufkraft += (r.trade?.qty ?? 0) * (r.trade?.price ?? data.price);
            positions.set(symbol, {
              symbol,
              qty: r.trade?.qty ?? 0,
              avgEntry: r.trade?.price ?? data.price,
              side: 'short',
              stopLoss: null,
              takeProfit: null,
              openedAt: r.trade?.executedAt ?? now.toISOString(),
            });
            logger.info(`Engine-Short ${uid} ${symbol} @ ${data.price}`);
          }
        }
      }

      // Risk-Exit-Cooldowns persistieren (ein Write je User und Scan, nur
      // bei Änderung). update() ersetzt GENAU dieses Feld durch die
      // bereinigte Map — set/merge würde weggeräumte Einträge liegen lassen,
      // set ohne merge das ganze User-Doc (Wallet!) plattmachen.
      if (cooldownUpdates.length > 0) {
        await (userDoc.ref.update as (...a: unknown[]) => Promise<unknown>)(
          ...cooldownUpdates,
        ).catch(() => undefined);
      }

      // Schatten-Flotte des Auto-Tuners (MT2): Jede Parameter-Variante rechnet
      // denselben Scan auf ihrem eigenen virtuellen Konto mit. Das kostet
      // KEINEN zusätzlichen Fetch — die Marktdaten liegen schon hier — und
      // liefert Out-of-Sample-Evidenz, aus der autoTune täglich entscheidet.
      // Ein Fehler hier darf den echten Handel niemals stören, deshalb der
      // eigene Fang.
      if (userDoc.get('settings.autoTune') !== false) {
        try {
          const variants = buildVariants(clamped, FLEET_SIZE);
          if (variants.length > 0) {
            const fleetRef = userDoc.ref.collection('tuning').doc('fleet');
            const vorher =
              ((await fleetRef.get()).get('variants') as FleetState | undefined) ?? {};
            // Die Flotte sieht GENAU dieselben Symbole wie der echte Pfad.
            // Das ist der ganze Zweck der Schatten-Rechnung: Eine Variante,
            // die auf einer anderen Symbolmenge liefe, wäre nicht
            // vergleichbar — und ein nicht vergleichbares Ergebnis ist
            // schlimmer als gar keines, weil es befördert werden könnte.
            const fleetSymbols = [...marketData.keys()];
            const { state } = stepFleet(variants, marketData, vorher, fleetSymbols, now);
            await fleetRef.set({ variants: state, updatedAt: now.toISOString() }, { merge: true });
          }
        } catch (err) {
          logger.warn(`Schatten-Flotte für ${uid} übersprungen`, err);
        }
      }
    } catch (err) {
      logger.error(`Auto-Trading-Fehler für ${uid}`, err);
    }
  }
  return { executed, gate, konten, broker };
}

/** Obergrenze des zentralen Scan-Sets (Kosten-Guard). */
const MAX_SCAN_SYMBOLS = 40;

/**
 * Scan-Set = Default-Watchlist ∪ alle User-Watchlists (M3: der Picker macht
 * Symbole wählbar; der nächste Scan versorgt sie zentral mit Daten).
 */
/**
 * Welche Symbole der Scan beobachtet — die Reihenfolge IST die Priorität,
 * weil `max` abschneidet.
 *
 * Pur gehalten, damit die Rangfolge prüfbar ist: Sie entscheidet, was
 * überhaupt handelbar ist. Ein Fehler hier fällt nirgends auf — es fehlt
 * einfach ein Symbol, und niemand vermisst, was er nie gesehen hat.
 *
 *  1. **Offene Positionen** — immer und zuerst (Verkaufs-Sicherheit 26.07.).
 *     Eine Position, die aus der Beobachtung fiele, verlöre jeden
 *     Exit-Pfad: Stop-Loss, Take-Profit, Konfluenz-Verkauf. Sie muss
 *     beobachtet bleiben, bis sie geschlossen ist — auch wenn ihr Symbol
 *     im Ranking auf Platz 150 steht.
 *  2. **Die Rangliste** des täglichen Momentum-Laufs über den ganzen
 *     Katalog. Bis 27.07. standen hier die handverlesenen Watchlists der
 *     Nutzer — eine Vorauswahl ohne jede Begründung.
 *  3. **Defaults** als Boden. Greift am ersten Tag (noch kein Ranking) und
 *     wenn der Marktfilter die Rangliste kurz hält.
 *  4. **Katalog** als letzter Boden — nur, wenn 1–3 nichts Offenes hergeben.
 *
 * ── Marktzeit gehört in die AUSWAHL, nicht dahinter (Audit-Befund A1) ───────
 *
 * Bis 28.07. wählte diese Funktion die globalen Top-N und `runScan` warf
 * danach alles weg, dessen Klasse gerade geschlossen ist. Das Ergebnis war
 * live messbar: `lastRunSkipped: market_closed` um 12:35 UTC — obwohl Krypto
 * rund um die Uhr handelt und im Katalog steht. Die Default-Liste enthält
 * nur US-Aktien, also tat der Scan außerhalb 13:30–20:00 UTC gar nichts:
 * rund 70 % der Zeit plus Wochenenden.
 *
 * Der Fehler verschwindet nicht mit der ersten Rangliste. Sind deren Top-40
 * überwiegend Aktien — was bei einem aktienlastigen Katalog der Normalfall
 * ist —, bleibt der Scan nachts fast leer. Deshalb filtert `isOpen` schon
 * BEIM Füllen: Das Kontingent geht an die bestplatzierten Symbole, die
 * gerade auch handelbar sind.
 *
 * Positionen bleiben ausdrücklich UNGEFILTERT. Ob ihre Börse offen ist,
 * entscheidet später der Handelspfad; hier ausgesiebt zu werden hieße, eine
 * offene Position aus den Augen zu verlieren — genau das, was Punkt 1
 * verhindert.
 */
export function selectScanSymbols(args: {
  positions: string[];
  /** Watchlists der Konten mit laufender Engine (Fund 01.08.): Die Engine
   *  verspricht, „deine Watchlist" zu handeln — dann muss der Scan sie auch
   *  BEOBACHTEN. Vorher deckten nur Ranking + Default-Liste den Einstieg ab;
   *  ein Konto mit eigener Auswahl konnte nie einen Trade eröffnen. */
  watchlists?: string[];
  ranking: string[];
  defaults: string[];
  /** Letzter Boden (ganzer Katalog), falls 1–3 nichts Offenes liefern. */
  catalog?: string[];
  max: number;
  /** Ist die Asset-Klasse dieses Symbols gerade handelbar? Default: alles. */
  isOpen?: (symbol: string) => boolean;
  /**
   * Darf in dieser Anlageklasse überhaupt gehandelt werden? (05.08.)
   *
   * `false` heißt: KEIN laufendes Konto gewichtet sie über null — der Regler
   * steht überall auf 0. Solche Symbole bekommen nur noch das Kontingent
   * unten, statt die Tiefenplätze zu füllen.
   *
   * Default: alles aktiv (Verhalten wie vorher, wenn niemand etwas übergibt).
   */
  klasseAktiv?: (symbol: string) => boolean;
  /**
   * Wie viele Plätze abgeschaltete Klassen behalten (Anteil 0…1).
   *
   * Sie GANZ auszusperren wäre die naheliegende Sparmaßnahme und wäre der
   * fünfte Fall desselben Fehlers, den dieses Projekt schon viermal hatte:
   * Eine Sperre, die zugleich die Messung beendet, die sie korrigieren
   * würde. Ohne 5-min-Daten misst der Schatten nichts mehr, und ein
   * Abschalten wäre endgültig — auch wenn die Klasse wieder trägt.
   *
   * Mit Kontingent bleibt die Messung am Leben, und die Mehrheit der teuren
   * Tiefenplätze geht dorthin, wo tatsächlich gehandelt wird.
   */
  schattenAnteil?: number;
}): string[] {
  const offen = args.isOpen ?? ((): boolean => true);
  const aktiv = args.klasseAktiv ?? ((): boolean => true);
  const set = new Set<string>();
  for (const sym of args.positions) set.add(sym); // ungedeckelt: siehe 1.

  /* Zwei Durchgänge statt einem: erst die handelnden Klassen, dann — bis zum
   * Kontingent — die abgeschalteten. Ein einziger Durchgang in
   * Prioritätsreihenfolge würde sonst 13 Krypto-Symbole aus der Watchlist
   * vor das erste handelbare Symbol des Rankings setzen, nur weil die
   * Watchlist zuerst drankommt. */
  const schattenPlaetze = Math.max(
    0,
    Math.floor(args.max * Math.min(1, Math.max(0, args.schattenAnteil ?? 0.2))),
  );
  const gruppen = (): string[][] => [
    args.watchlists ?? [],
    args.ranking,
    args.defaults,
    args.catalog ?? [],
  ];
  let imSchatten = 0;

  /* Drei Durchgänge, in dieser Reihenfolge:
   *
   *  1. Handelnde Klassen bis `max − schattenPlaetze`.
   *  2. Abgeschaltete Klassen, aber HÖCHSTENS `schattenPlaetze` Stück.
   *  3. Auffüllen mit handelnden Klassen bis `max`.
   *
   * Der dritte Durchgang darf ausdrücklich KEINE abgeschalteten mehr
   * aufnehmen — sonst wäre das Kontingent aus Schritt 2 wirkungslos, und
   * genau das hat der Test gefunden, bevor es live ging. */
  for (const gruppe of gruppen()) {
    for (const sym of gruppe) {
      if (set.size >= args.max - schattenPlaetze) break;
      if (sym && isTradable(sym) && offen(sym) && aktiv(sym)) set.add(sym);
    }
  }
  for (const gruppe of gruppen()) {
    for (const sym of gruppe) {
      if (imSchatten >= schattenPlaetze || set.size >= args.max) break;
      if (!sym || !isTradable(sym) || !offen(sym) || aktiv(sym) || set.has(sym)) continue;
      set.add(sym);
      imSchatten += 1;
    }
  }
  for (const gruppe of gruppen()) {
    for (const sym of gruppe) {
      if (set.size >= args.max) break;
      // NICHT handelbare Symbole fliegen aus der Tiefenanalyse (Befund
      // 28.07.): Am 28.07. waren 25 der 40 tief analysierten Symbole
      // Aktienindizes, die kein Broker verkauft. Wir haben also Indikatoren,
      // Prognosen und Intraday-Kerzen für Dinge gerechnet, die niemals eine
      // Position werden können — und die 40 Plätze denen weggenommen, die es
      // könnten. Beobachtet werden sie weiterhin (Katalog-Versorgung, Charts,
      // Marktfilter); nur die teure Tiefe bekommen sie nicht mehr.
      //
      // Offene Positionen sind oben schon drin und bleiben es — auch wenn
      // ein Symbol nachträglich als nicht handelbar gilt. Eine Position ohne
      // frische Daten verlöre ihren Stop-Loss.
      if (sym && isTradable(sym) && offen(sym) && aktiv(sym)) set.add(sym);
    }
  }
  if (imSchatten > 0) {
    logger.info(`Scan-Set: ${imSchatten} Platz/Plätze für abgeschaltete Klassen (Schatten misst weiter)`);
  }
  return [...set];
}

/**
 * Union der aktiven Klassen über die Regler-Maps aller laufenden Konten.
 *
 * `null` heißt „kein Filter — alles aktiv": entweder hat gar kein Konto
 * Regler, oder mindestens eines hat keine — und ein Konto ohne Regler
 * handelt in allen Klassen, womit die Frage gegenstandslos ist.
 *
 * Sparse-Map-Falle (05.08.): Die Map darf LÜCKEN haben — das UI-Formular
 * schreibt zwar alle Klassen, aber der Auto-Regler schreibt `{...bestand}`
 * zurück und ältere Konten kennen neu hinzugekommene Klassen nicht. Beim
 * HANDELN gilt ein fehlender Regler als 1 (`klemmeGewicht(undefined)`);
 * zählte der Scan nur explizite `> 0`-Einträge, wären dieselben Klassen im
 * Scan abgeschaltet und im Handel aktiv — das Konto würde still auf die
 * Schatten-Quote verengt. Deshalb: fehlend = aktiv, exakt wie beim Handeln.
 * Inaktiv ist nur, was ausdrücklich auf 0 steht.
 */
export function aktiveKlassenAusGewichten(
  maps: Array<Record<string, number> | undefined>,
): Set<string> | null {
  const gefunden = new Set<string>();
  let mitReglern = 0;
  for (const w of maps) {
    if (!w || Object.keys(w).length === 0) return null;
    mitReglern += 1;
    for (const kl of Object.keys(CATALOG)) {
      const g = w[kl];
      if (g === undefined || g > 0) gefunden.add(kl);
    }
  }
  return mitReglern > 0 ? gefunden : null;
}

async function collectScanSymbols(now: Date, uhrOffen: boolean | null = null): Promise<string[]> {
  const db = getFirestore();

  let positions: string[] = [];
  try {
    const posSnap = await db.collectionGroup('positions').select().get();
    positions = posSnap.docs.map((d) => d.id);
  } catch (err) {
    logger.warn('Positions-Symbole nicht lesbar — Scan ohne Positions-Union', err);
  }

  // Bewertet werden ALLE Katalog-Symbole — das tut `momentumRun` täglich
  // über die volle Tages-Historie. Was hier ausgewählt wird, ist etwas
  // anderes: welche Symbole der 5-Minuten-Scan intraday BEOBACHTET. Beides
  // gleichzusetzen wäre teuer und brächte nichts — 166 Symbole alle fünf
  // Minuten mit 5-min-Bars, RSI, MACD und Bollinger zu holen, kostet das
  // Vielfache und liefert für Rang 120 eine Information, auf die niemand
  // handelt. Breit bewerten, schmal beobachten.
  let ranking: string[] = [];
  try {
    const top = (await db.doc('meta/momentum').get()).get('top') as
      | Array<{ symbol?: unknown }>
      | undefined;
    ranking = (top ?? [])
      .map((e) => e?.symbol)
      .filter((sym): sym is string => typeof sym === 'string' && sym.length > 0);
  } catch (err) {
    logger.warn('Momentum-Ranking nicht lesbar', err);
  }

  // Watchlists aller Konten mit laufender Engine — Einstiegs-Kandidaten
  // haben Vorrang vor dem Ranking (das Ranking ist ein Vorschlag, die
  // Watchlist eine Entscheidung des Users).
  let watchlists: string[] = [];
  /**
   * Klassen, in denen MINDESTENS EIN laufendes Konto handeln darf (05.08.).
   *
   * Der Scan ist geteilt, die Regler sind es nicht — deshalb die
   * Oder-Verknüpfung: Eine Klasse gilt als aktiv, sobald irgendein Konto sie
   * über null gewichtet ODER gar keinen Regler für sie hat (Semantik in
   * `aktiveKlassenAusGewichten`). Alles andere wäre gegenüber dem einen
   * Nutzer unfair, der sie eingeschaltet hat.
   *
   * `null` heißt „konnte nicht ermittelt werden" — dann gilt wie bisher
   * alles als aktiv. Ein Lesefehler darf den Scan nicht verengen.
   */
  let aktiveKlassen: Set<string> | null = null;
  try {
    const engSnap = await db
      .collection('users')
      .where('settings.strategy.engine.running', '==', true)
      .select('settings.strategy.watchlist', 'settings.strategy.engine.classWeights')
      .get();
    watchlists = engSnap.docs.flatMap(
      (d) => (d.get('settings.strategy.watchlist') as string[] | undefined) ?? [],
    );
    aktiveKlassen = aktiveKlassenAusGewichten(
      engSnap.docs.map(
        (d) =>
          d.get('settings.strategy.engine.classWeights') as
            | Record<string, number>
            | undefined,
      ),
    );
  } catch (err) {
    logger.warn('Watchlists nicht lesbar — Scan ohne Watchlist-Union', err);
  }
  return schmiedeAuswahl(aktiveKlassen);

  /** Auswahl mit dem ermittelten Klassen-Filter bauen (eine Stelle, ein Aufruf). */
  function schmiedeAuswahl(aktiv: Set<string> | null): string[] {
    const symbols = selectScanSymbols({
      positions,
      watchlists,
      ranking,
      defaults: [...DEFAULT_STRATEGY.watchlist],
      catalog: allSymbols(),
      max: MAX_SCAN_SYMBOLS,
      isOpen: (sym) => offenMitUhr(sym, now, uhrOffen),
      ...(aktiv ? { klasseAktiv: (sym: string): boolean => aktiv.has(classify(sym)) } : {}),
    });
    logger.info(
      `Scan-Set: ${symbols.length} Symbole (${positions.length} Positionen, `
        + `${ranking.length} im Ranking, aktive Klassen: ${aktiv ? [...aktiv].join('/') : 'alle'})`,
    );
    return symbols;
  }
}

/**
 * Wie viele Tageskerzen je Scan exakt nachgezogen werden.
 *
 * Die Kurse kommen seit dem Batch-Umbau für den GANZEN Katalog aus einem
 * Spark-Request-Bündel. Was Spark nicht liefert, ist die Tageskerze mit
 * Open/High/Low/Volume — dafür braucht es weiter einen Chart-Fetch je Symbol.
 * Der ist reine Historie (Sparklines, Mini-Charts) und darf deshalb langsam
 * rotieren: 10 Symbole je Scan = voller Katalog gut jede Stunde.
 */
const BAR_CHUNK = 10;

/**
 * Katalog-Versorgung — seit 28.07. BATCH statt Rotation.
 *
 * Owner-Frage: „kann das tool nicht alles immer parallel beobachten? markt ist
 * ja dynamisch und ändert sich stetig!" Vorher nicht: `getQuickQuote` kostet
 * einen Yahoo-Fetch je Symbol, also lief der Katalog in 15er-Häppchen mit
 * einem 50-min-Frische-Gate durch — ein Symbol war im schlechtesten Fall eine
 * Stunde alt, und das Momentum-Ranking sah entsprechend alte Kurse.
 *
 * Jetzt: EIN Spark-Bündel (9 Requests für 166 Symbole, gemessen 2,5 s) je
 * Scan. Jedes Symbol des Katalogs ist damit alle 5 Minuten frisch.
 *
 * Geschrieben wird trotzdem nur, was sich bewegen KANN: Symbole mit
 * geschlossener Asset-Klasse überspringt die Schleife. Das ist der ganze
 * Kostenhebel — Firestore-Writes sind teurer als Yahoo-Fetches, und ein
 * geschlossener Markt liefert bis zur Eröffnung denselben Kurs.
 */
async function supplyCatalog(
  scannedSet: Set<string>,
  now: Date,
  uhrOffen: boolean | null = null,
): Promise<{ fresh: number; open: number }> {
  const db = getFirestore();
  const catalog = allSymbols().filter((s) => !scannedSet.has(s));
  if (catalog.length === 0) return { fresh: 0, open: 0 };

  // Nur offene Klassen: ein geschlossener Markt kann keinen neuen Kurs haben.
  const offen = catalog.filter((s) => offenMitUhr(s, now, uhrOffen));
  const quotes: Map<string, SparkQuote> =
    offen.length > 0 ? await getSparkBatch(offen) : new Map();

  const stateRef = db.doc('meta/catalogSupply');
  const cursor = ((await stateRef.get()).get('barCursor') as number | undefined) ?? 0;

  const batch = db.batch();
  let fetched = 0;
  for (const sym of offen) {
    const q = quotes.get(sym);
    if (!q) continue; // dieser Chunk hat gepatzt — nächster Scan in 5 min
    batch.set(
      db.collection('market').doc(sym),
      {
        symbol: sym,
        name: resolveName(sym),
        assetClass: classify(sym),
        quote: { price: q.price, changePct: q.changePct, updatedAt: now.toISOString() },
      },
      { merge: true },
    );
    fetched++;
  }

  // Tages-Tier: exakte Kerzen (OHLCV) rotierend nachziehen — Spark kennt nur
  // Closes. Läuft über den GANZEN Katalog, auch über geschlossene Klassen:
  // Deren Schlusskerze entsteht ja gerade erst nach Handelsschluss.
  const barSyms: string[] = [];
  for (let n = 0; n < BAR_CHUNK; n++) barSyms.push(catalog[(cursor + n) % catalog.length]!);
  for (const sym of new Set(barSyms)) {
    try {
      const qq = await getQuickQuote(sym);
      batch.set(db.collection('market').doc(sym).collection('bars').doc(qq.lastBar.date), {
        ...qq.lastBar,
      });
      batch.set(
        db.collection('market').doc(sym),
        { lastBarDate: qq.lastBar.date },
        { merge: true },
      );
    } catch (err) {
      logger.warn(`Katalog-Tageskerze ${sym}`, err); // nächste Runde erneut
    }
  }

  batch.set(
    stateRef,
    {
      barCursor: (cursor + BAR_CHUNK) % catalog.length,
      updatedAt: now.toISOString(),
      lastFetched: fetched,
      catalogSize: catalog.length,
      openSize: offen.length,
    },
    { merge: true },
  );
  await batch.commit();
  return { fresh: fetched, open: offen.length };
}

/** Ein kompletter Scan-Zyklus über die zentrale Watchlist. */
/**
 * Einmalige Migration (Owner 02.08.: „komplett alle Konten sind im Minus …
 * können wir das irgendwie ändern???"): Bestandskonten von 'intraday' auf
 * 'daily' umstellen.
 *
 * Die Messung war eindeutig und zweifach: Schon am 01.08. stand der
 * 5-min-Takt bei PF 0,18 mit Gebühren = 4,7× Brutto (deshalb ist 'daily'
 * seit dem der Default für NEUE Konten), und am 02.08. zeigte die
 * Steckbrief-Statistik JEDEN Intraday-Steckbrief negativ bei 720 Trades,
 * Gebührenanteil 5,6× Brutto. Die vier Altkonten churnten trotzdem weiter
 * intraday, weil der Default Bestandskonten nicht anfasst.
 *
 * Regeln der Migration: additiv + idempotent (Marker in meta/migrations,
 * §9); Konten mit abgewähltem Auto-Tuner (settings.autoTune === false)
 * werden NICHT angefasst — wer die Selbstverbesserung abbestellt hat, hat
 * das auch hier bestellt. Der Rest der Strategie bleibt unverändert.
 */
async function migrateTimeframeDaily(db: FirebaseFirestore.Firestore): Promise<void> {
  const MARKER = 'timeframeDaily_2026_08_02';
  try {
    const marker = db.doc('meta/migrations');
    if ((await marker.get()).get(MARKER) === true) return;
    const users = await db.collection('users').select('settings').get();
    for (const u of users.docs) {
      if (u.get('settings.autoTune') === false) continue;
      const tf = u.get('settings.strategy.signals.timeframe') as string | undefined;
      if (tf === 'daily' || u.get('settings.strategy') === undefined) continue;
      await u.ref.update(
        new FieldPath('settings', 'strategy', 'signals', 'timeframe'),
        'daily',
      );
      logger.info(`Migration ${MARKER}: ${u.id} intraday→daily`);
    }
    await marker.set({ [MARKER]: true, at: new Date().toISOString() }, { merge: true });
  } catch (err) {
    // Nächster Scan versucht es erneut — der Marker wird erst nach Erfolg gesetzt.
    logger.warn(`Migration ${MARKER} fehlgeschlagen`, err);
  }
}

/**
 * Sockel für BESTANDSKONTEN einschalten (Owner-Anweisung 04.08.: „bitte bei
 * jedem Konto automatisch als Standardeinstellung setzen").
 *
 * Der Kern-Satellit kam bewusst nur für NEUE Konten scharf — eine
 * Kapitalumschichtung sollte nicht die Nebenwirkung eines geänderten
 * Defaults sein. Der Betreiber hat das ausdrücklich anders entschieden, und
 * die Messung stützt es: Der Momentum-Sockel stand am 04.08. bei +4,0 %
 * seit dem 28.07. (null Trades im letzten Lauf), die vier aktiven Konten
 * zwischen −3,2 % und −6,3 %.
 *
 * Anders als die timeframe-Migration überspringt diese Migration KEINE
 * Konten: Der Sockel ist eine Plattform-Grundeinstellung, kein
 * Tuner-Experiment — das `settings.autoTune`-Opt-out betrifft die
 * Selbstverbesserung, nicht die Grundaufteilung des Depots.
 *
 * Angefasst wird ausschließlich `engine.corePct`, und nur dort, wo noch
 * kein eigener Wert > 0 steht: Wer den Sockel selbst eingestellt hat,
 * behält seine Zahl. Additiv + idempotent über den Marker in
 * meta/migrations (§9). Gekauft wird dadurch noch nichts — das entscheidet
 * der nächste Momentum-Lauf, und auch der nur, wenn der SMA200-Marktfilter
 * offen ist.
 */
async function migrateCorePctAll(db: FirebaseFirestore.Firestore): Promise<void> {
  const MARKER = 'corePctAll_2026_08_04';
  try {
    const marker = db.doc('meta/migrations');
    if ((await marker.get()).get(MARKER) === true) return;
    const users = await db.collection('users').select('settings').get();
    let gesetzt = 0;
    for (const u of users.docs) {
      if (u.get('settings.strategy') === undefined) continue;
      const vorhanden = u.get('settings.strategy.engine.corePct') as number | undefined;
      if (typeof vorhanden === 'number' && vorhanden > 0) continue; // eigener Wert bleibt
      await u.ref.update(
        new FieldPath('settings', 'strategy', 'engine', 'corePct'),
        DEFAULT_CORE_PCT,
      );
      gesetzt += 1;
      logger.info(`Migration ${MARKER}: ${u.id} corePct → ${DEFAULT_CORE_PCT}`);
    }
    await marker.set(
      { [MARKER]: true, at: new Date().toISOString(), konten: gesetzt },
      { merge: true },
    );
  } catch (err) {
    // Nächster Scan versucht es erneut — der Marker wird erst nach Erfolg gesetzt.
    logger.warn(`Migration ${MARKER} fehlgeschlagen`, err);
  }
}

/**
 * Kapital-Gewicht einer Anlageklasse (04.08.).
 *
 * `0` heißt: kein neuer Einstieg. Es heißt NICHT „kein Signal" — Signale,
 * Schatten-P&L und die Klassen-Kante entstehen weiter, damit eine
 * abgeschaltete Klasse messbar bleibt und sich zurückverdienen kann. Wer
 * das anders baut, kann eine einmal getroffene Entscheidung nie mehr
 * überprüfen (siehe `shared/src/classAdvisor.ts`).
 *
 * Bestehende Ausstiege bleiben unberührt: Eine offene Position wird immer
 * geschlossen, auch wenn ihre Klasse inzwischen auf 0 steht. Alles andere
 * hieße, jemanden in einer Position festzuhalten, die er nicht mehr will.
 */
/**
 * Hätte ein Signal die Kostenschwelle passiert? (MI2, 05.08.)
 *
 * Bewusst mit DEFAULT_STRATEGY statt einer Konto-Einstellung: Der
 * Signal-Schatten ist eine Systemmessung, keine Kontomessung — er läuft
 * einmal je Symbol, nicht einmal je Nutzer. Dieselbe Entscheidung wie beim
 * Rest des Schattens, der auch die Default-Konfluenz auswertet.
 *
 * Gerechnet wird mit Einfangquote (`capture`), also der SCHARFEN Fassung.
 * Die Frage lautet ja gerade: Was bliebe übrig, wenn man sie scharf
 * schaltet — und verdient das etwas?
 *
 * Ohne ATR ist die Schwelle nicht prüfbar. Dann gilt das Signal als
 * durchgelassen, genau wie im Einstiegs-Tor (`ohne_atr_durchgelassen`):
 * Nicht messen können ist kein Grund, es aus der Messung zu werfen.
 */
function schattenKostenOk(symbol: string, atrPct: number | null | undefined): boolean {
  const klasse = classify(symbol);
  const befund = costGate({
    atrPct,
    minHoldMin: DEFAULT_STRATEGY.engine.minHoldMin,
    timeframe: DEFAULT_STRATEGY.signals.timeframe ?? 'intraday',
    feeRate: feeRateForClass(klasse),
    capture: captureForClass(klasse),
    ...(typeof DEFAULT_STRATEGY.signals.minEdgeMultiple === 'number'
      ? { multiple: DEFAULT_STRATEGY.signals.minEdgeMultiple }
      : {}),
  });
  return befund.ok || befund.reason === 'kein_atr';
}

/**
 * Rohsummen zweier Aggregate zusammenlegen — mit eigenem Zähler.
 *
 * Getrennt vom `n` der Netto-Summe, weil Altbestand keine Rohsumme trägt
 * (siehe SchattenKlasse.nRoh). Fehlen sie auf BEIDEN Seiten, kommt gar kein
 * Feld zurück: Dann liefert die Auswertung `null` — „nicht gemessen" statt
 * einer erfundenen Null.
 */
function summiereRoh(
  a: SchattenKlasse,
  b: SchattenKlasse,
): { summeRohPct?: number; nRoh?: number } {
  const nRoh = (a.nRoh ?? 0) + (b.nRoh ?? 0);
  if (nRoh <= 0) return {};
  return {
    summeRohPct: Math.round(((a.summeRohPct ?? 0) + (b.summeRohPct ?? 0)) * 10_000) / 10_000,
    nRoh,
  };
}

function klassenGewicht(strategy: Strategy, symbol: string): number {
  return klemmeGewicht(strategy.engine.classWeights?.[classify(symbol)]);
}


export async function runScan(force = false): Promise<ScanResult> {
  const now = new Date();
  const scanId = now.toISOString().slice(0, 16) + 'Z'; // Minute = idempotent
  /* Richtungs-Verteilung der Signale dieses Scans (04.08.).
   *
   * Anlass: Am Nachmittag des 04.08. blockte das Einstiegs-Tor 13 von 23
   * geprüften Einstiegen mit `regime_gegen_trend` — also SHORTS in einem
   * Aufwärtstrend. Die Ampel tut damit genau ihre Arbeit; die Frage, die sie
   * aufwirft, beantwortet sie aber nicht: WARUM will die Engine in einem
   * steigenden Markt überwiegend verkaufen?
   *
   * Die Blockade-Zähler allein können das nicht zeigen. Sie sehen nur, was
   * am Tor ankommt — nicht, was die Konfluenz überhaupt produziert. Ein Scan
   * mit lauter Hold-Signalen und einer mit lauter geblockten Shorts sehen im
   * Log identisch aus: beide „keine Trades". */
  const signalDirs = { buy: 0, sell: 0, hold: 0 };
  /** Schatten-Kante je Anlageklasse (MG4) — läuft auch für abgeschaltete Klassen. */
  const schattenKlassen: Record<string, SchattenKlasse> = {};
  /**
   * Schatten-Kante je SIGNAL-LESART (MI): die gehandelte Logik gegen die
   * regime-gerechte Variante. Dieselbe Messung, zwei Signalquellen — damit
   * ein Umschalten der Signal-Logik eine Zahl hinter sich hat und nicht nur
   * eine Vermutung (siehe shared/src/regimeSignal.ts).
   */
  const schattenVarianten: {
    live?: SchattenKlasse;
    regime?: SchattenKlasse;
    /** Nur die Live-Signale, die die scharfe Kostenschwelle passiert hätten. */
    live_kosten?: SchattenKlasse;
    /** Dieselben Live-Signale, am NÄCHSTEN Tag bewertet (Task 94, 05.08.). */
    live_tag?: SchattenKlasse;
    /* Exit-Stil-Messung (Owner-Go 06.08.): dieselben Beiträge, aufgeteilt
     * nach Signaltyp × Horizont. Die Hypothese, die hier eine Zahl bekommt:
     * Trend-Signale verdienen im TAGES-Horizont (laufen lassen), Umkehr-
     * Signale im 5-MINUTEN-Horizont (abräumen). Erst wenn beide Diagonalen
     * stimmen, wird der Exit-Stil je Signaltyp scharf geschaltet. */
    live_trend?: SchattenKlasse;
    live_umkehr?: SchattenKlasse;
    live_tag_trend?: SchattenKlasse;
    live_tag_umkehr?: SchattenKlasse;
  } = {};
  /* Dieselben Varianten, aufgeschlüsselt nach Anlageklasse (05.08.).
   *
   * Der Anlass war eine Zahl, die zwei Deutungen zuließ: −0,496 % Kante je
   * Signal. Nachts handelt nur Krypto, und Krypto kostet 0,50 % Roundtrip —
   * die gemessene Kante war also praktisch identisch mit den Kosten EINER
   * Klasse. Ob dieselbe Signal-Logik in Aktien (0,10 % Roundtrip) trägt,
   * ließ sich aus der Gesamtsumme nicht ablesen; sie hätte eine
   * funktionierende Quelle mit der teuersten Klasse zusammen erledigt. */
  const schattenVariantenKlassen: Record<string, Record<string, SchattenKlasse>> = {};
  const zuVariante = (variante: string, klasse: string, beitrag: SchattenBeitrag): void => {
    const je = (schattenVariantenKlassen[variante] ??= {});
    je[klasse] = addiereSchatten(je[klasse], beitrag);
  };
  /** Richtungsverteilung der Regime-Variante — direkt gegen `signalDirs` lesbar. */
  const regimeDirs = { buy: 0, sell: 0, hold: 0 };
  const regimeVoteDirs: Record<string, { buy: number; sell: number; hold: number }> = {};
  /** Richtungsverteilung je Indikator — s. Kommentar an der Zählstelle. */
  const voteDirs: Record<string, { buy: number; sell: number; hold: number }> = {};
  /** „hold", dem genau EINE Stimme zur Konfluenz fehlte. */
  let knappVerfehlt = 0;
  /* Börsen-Uhr des Brokers (Alpaca-Sync Punkt 2): kennt Feiertage und
   * Halbtage, die unsere Kalenderrechnung nicht kennt. `null` = keine
   * belastbare Ablesung → überall gilt die eigene Rechnung wie bisher.
   * Ein Uhr-Problem darf den Scan nie anhalten, deshalb alles im try. */
  let uhrOffen: boolean | null = null;
  try {
    const laufende = await getFirestore()
      .collection('users')
      .where('settings.strategy.engine.running', '==', true)
      .select()
      .limit(10)
      .get();
    await aktualisiereBoersenUhr(laufende.docs.map((d) => d.id), now.getTime());
    uhrOffen = await boersenOffen(now.getTime());
  } catch (err) {
    logger.warn('Börsen-Uhr nicht verfügbar — eigene Marktzeit-Rechnung gilt', err);
  }
  const scanSet = await collectScanSymbols(now, uhrOffen);
  // Depot-Vision (2026-07-24): gescannt wird je Symbol, dessen ASSET-KLASSE
  // gerade offen ist — Krypto 24/7, Forex/Rohstoffe ~24/5, Rest US-Zeiten.
  //
  // Das Filtern steht seit dem Audit-Befund A1 (28.07.) NICHT mehr allein da:
  // `collectScanSymbols` wählt bereits nur Offenes aus. Hier bleibt es als
  // zweiter Riegel — und für die Positionen, die die Auswahl bewusst
  // ungefiltert durchlässt. Ohne die Auswahl davor war dieses Filter der
  // Grund, warum der Scan ~70 % der Zeit nichts tat: Es warf weg, was die
  // globale Top-N-Wahl vorher blind eingesammelt hatte.
  const symbols = force
    ? scanSet
    : scanSet.filter((s) => offenMitUhr(s, now, uhrOffen));
  if (symbols.length === 0) {
    logger.info(`Alle Märkte geschlossen — Scan übersprungen (${scanId})`);
    // Heartbeat auch im No-Op: „Scheduler lebt" ≠ „Markt offen" (M7-Monitoring)
    await getFirestore()
      .doc('meta/health')
      .set({ lastRunAt: now.toISOString(), lastRunSkipped: 'market_closed' }, { merge: true })
      .catch(() => undefined);
    return { scanId, scanned: [], errors: {}, trades: 0, skipped: 'market_closed' };
  }

  await seedUniverse();
  const db = getFirestore();
  const scanned: string[] = [];
  const errors: Record<string, string> = {};
  const marketData = new Map<string, SymbolData>();
  // Intraday-Selbstdiagnose (Chart-Feedback): landet im öffentlichen
  // meta/health, weil Cloud-Logging ohne GCP-Konsole unsichtbar ist.
  let intradayOk = 0;
  let intradayError: string | null = null;
  // News-Refresh-Deckel je Scan: Bei 4 je Lauf und 45-min-TTL ist jedes der
  // ~13 beobachteten Symbole grob alle 15–20 Minuten frisch — mehr braucht
  // ein 12-h-Veto-Fenster nicht, und der Scan bleibt von den Feeds entkoppelt.
  const NEWS_REFRESH_PER_SCAN = 4;
  let newsFetched = 0;

  // Genauigkeitsgewichtetes Forecast-Vote (Prognose 2.0 Teil 4): Das
  // Stimmgewicht der Prognose folgt ihrer REALISIERTEN Kante über den
  // Münzwurf — einmal je Scan aus der öffentlichen Lernstatistik gelesen.
  // Startwert 0, nicht das Basisgewicht: Ist die Statistik nicht lesbar,
  // gibt es keine Evidenz — und ohne Evidenz stimmt die Prognose nicht mit
  // (Beweislast-Umkehr 28.07., siehe accuracyWeightedVote).
  let fcVote = { weight: 0, factor: null as number | null };
  try {
    const statsSnap = await db.doc('meta/forecastStats').get();
    fcVote = accuracyWeightedVote(DEFAULT_STRATEGY.signals.forecastWeight, {
      scored: statsSnap.get('scored') as number | undefined,
      dirAccuracy: statsSnap.get('dirAccuracy') as number | null | undefined,
    });
  } catch (err) {
    logger.warn('forecastStats nicht lesbar — Prognose stimmt nicht mit', err);
  }
  const effSignals = { ...DEFAULT_STRATEGY.signals, forecastWeight: fcVote.weight };

  // Regime-Ampel (31.07.). Steht seit 04.08. VOR der Symbol-Schleife statt
  // dahinter: Die Schatten-Variante liest dieselben Indikatoren
  // regime-gerecht (MI) und braucht den Zustand deshalb schon beim Bilden
  // des Signals, nicht erst beim Handeln. Quelle sind der S&P 500 (^GSPC,
  // Tages-Closes) und der VIX — beide Gratis-Größen. Ein Fetch-Fehler ergibt
  // die konservative Mitte 'seitwaerts', nie Alarm.
  let regime: ReturnType<typeof marketRegime> = {
    state: 'seitwaerts',
    aboveSma200: null,
    realizedVolPct: null,
    vix: null,
  };
  try {
    const [spy, vixQuote] = await Promise.all([
      getMarketSnapshot('^GSPC', '1y'),
      getQuickQuote('^VIX').catch(() => null),
    ]);
    regime = marketRegime(
      spy.bars.map((b) => b.close),
      vixQuote && vixQuote.price > 0 ? vixQuote.price : null,
    );
  } catch (err) {
    logger.warn('Regime-Messung fehlgeschlagen — seitwaerts angenommen', err);
  }

  for (const symbol of symbols) {
    try {
      const snap = await getMarketSnapshot(symbol, DEFAULT_STRATEGY.signals.period);
      const closes = snap.bars.map((b) => b.close);
      const lastDate = snap.bars[snap.bars.length - 1]!.date;

      const symRef = db.collection('market').doc(symbol);
      const symDoc = await symRef.get();
      const batch = db.batch();

      // News-Lage (News-Rückkehr 29.07.): gespeicherte lesen, bei
      // Überalterung sparsam erneuern — nur handelbare Symbole (das Veto
      // betrifft Einstiege, und Indizes kauft ohnehin niemand). Ein
      // Feed-Ausfall lässt die alte Lage stehen; das Veto-Fenster läuft
      // über die Item-Zeitstempel ab, nicht über den Abruf.
      let news = (symDoc.get('news') as NewsSnapshot | undefined) ?? null;
      const nowSec = Math.floor(now.getTime() / 1000);
      if (
        isTradable(symbol)
        && newsFetched < NEWS_REFRESH_PER_SCAN
        && (!news || nowSec - news.fetchedT > NEWS_TTL_SEC)
      ) {
        try {
          news = await fetchNewsSnapshot(symbol, nowSec);
          newsFetched += 1;
          batch.set(symRef, { news }, { merge: true });
        } catch (err) {
          logger.warn(`News ${symbol}`, err); // alte Lage bleibt; fails open
        }
      }

      // Prognose als reine Preis-Regression + Shadow-Grid
      let forecast: LiveForecast | null = null;
      try {
        forecast = await runForecast(symbol, closes, lastDate, news);
      } catch (err) {
        logger.warn(`Forecast-Fehler ${symbol}`, err);
      }
      // ATR(14) in % — Basis für volatilitätsadaptive Stops (MA6). Wird nur
      // berechnet, nicht erzwungen: Ohne atrStopMult bleibt alles wie gehabt.
      const atrPctVal = atrPct(snap.bars.map((b) => ({ high: b.high, low: b.low, close: b.close })), 14);
      marketData.set(symbol, { closes, price: snap.price, forecast, atrPct: atrPctVal, news });

      const sig = computeSignal(
        closes,
        snap.price,
        DEFAULT_STRATEGY.indicators,
        effSignals,
        forecast,
      );

      // Schatten-Variante (MI): dieselben Indikatorwerte, regime-gerecht
      // gelesen. Kostet nichts — der Snapshot ist bereits berechnet.
      const rStimmen = regimeStimmen(sig.snapshot, regime.state, DEFAULT_STRATEGY.indicators);
      const regimeDir = regimeRichtung(rStimmen, DEFAULT_STRATEGY.signals.minConfluence);
      regimeDirs[regimeDir] += 1;
      for (const [name, richtung] of Object.entries(rStimmen.votes)) {
        const eintrag = regimeVoteDirs[name] ?? { buy: 0, sell: 0, hold: 0 };
        if (richtung === 'buy' || richtung === 'sell' || richtung === 'hold') {
          eintrag[richtung] += 1;
        }
        regimeVoteDirs[name] = eintrag;
      }

      /* Tages-Horizont-Slot (Task 94): Das Signal reift 24 h, statt beim
       * nächsten Scan ersetzt zu werden. `wartet` → Slot nicht anfassen;
       * `reif` wird unten im Schatten-Block bewertet, danach (wie bei
       * `leer`/`verfallen`) mit dem heutigen buy/sell-Signal neu belegt. */
      const tagSlot = pruefeTagSlot(symDoc.get('lastSignalTag'), now.getTime());
      const tagSlotBelegbar =
        tagSlot.status !== 'wartet' && (sig.direction === 'buy' || sig.direction === 'sell');
      /** Trend/Umkehr/gemischt — Grundlage der Exit-Stil-Messung (06.08.). */
      const sigTyp = bestimmeSignalTyp(sig.votes, sig.direction);

      batch.set(
        symRef,
        {
          name: resolveName(symbol),
          assetClass: classify(symbol),
          ...(tagSlotBelegbar
            ? {
                lastSignalTag: {
                  direction: sig.direction,
                  price: sig.price,
                  at: now.toISOString(),
                  ...(sigTyp ? { typ: sigTyp } : {}),
                },
              }
            : {}),
          // Grundlage der Schatten-Kante beim NÄCHSTEN Scan (MG4): Richtung,
          // Kurs und Zeitpunkt dieses Signals. Bewusst am Haupt-Dokument und
          // nicht in einer eigenen Sammlung — es wird ohnehin geschrieben.
          // Der Zeitstempel ist kein Beiwerk: Ohne ihn ließe sich ein Signal
          // von gestern nicht von einem aus dem letzten Lauf unterscheiden
          // (siehe SCHATTEN_MAX_ALTER_MS).
          lastSignal: {
            direction: sig.direction,
            price: sig.price,
            at: now.toISOString(),
            ...(sigTyp ? { typ: sigTyp } : {}),
            /* Hätte dieses Signal die Kostenschwelle passiert? (MI2, 05.08.)
             *
             * Der Anlass ist eine Messung, die die Diagnose umdreht: Die
             * gehandelte Konfluenz trägt Information — Rohbewegung +0,072 %
             * bei n=25 — verdient damit aber die Reibung nicht (stocks_us:
             * 0,10 % Roundtrip). Nicht die Signalquelle ist das Problem,
             * sondern dass im 5-Minuten-Horizont zu wenig passiert.
             *
             * Genau dagegen ist die Kostenschwelle gebaut. Was fehlte, war
             * die Zahl, die ihre Freischaltung rechtfertigt: die Kante der
             * Signale, die sie DURCHLÄSST. `kante_wuerde_blocken` zählt nur,
             * wie viele betroffen wären — das sagt nichts darüber, ob die
             * übrigen verdienen.
             *
             * Mit diesem Feld wird beim nächsten Scan eine dritte Variante
             * bewertet: dieselben Live-Signale, aber nur die geprüften. Ist
             * ihre Kante positiv, ist die Schwelle der Hebel; ist sie es
             * nicht, hilft auch schärferes Filtern nicht — und das zu
             * wissen, ist genauso viel wert. */
            kostenOk: schattenKostenOk(symbol, atrPctVal),
          },
          // Zweite Lesart derselben Indikatoren (MI): regime-gerecht statt
          // fest auf Umkehr. Wird NICHT gehandelt — nur mitgeschrieben und
          // beim nächsten Scan bewertet, damit die Kante beider Lesarten
          // nebeneinander steht, bevor jemand umschaltet.
          lastSignalRegime: {
            direction: regimeDir,
            price: sig.price,
            at: now.toISOString(),
          },
          quote: {
            price: snap.price,
            changePct: snap.changePct,
            updatedAt: now.toISOString(),
          },
          source: snap.source,
          // Live-Prognose fürs Chart-Overlay (Punkte + Band + Kennwerte)
          forecast: forecast
            ? {
                points: forecast.points,
                band: forecast.band,
                lookback: forecast.lookback,
                predictedPct: Math.round(forecast.predictedPct * 100) / 100,
                baseDate: lastDate,
                calib: forecast.calib,
              }
            : null,
        },
        { merge: true },
      );

      // Bars: Erst-Backfill komplett, danach nur der letzte Bar.
      // v2 (Chart-Feedback 24.07.): Historie 1y statt 3mo — Bestandssymbole
      // werden über den Versions-Marker einmalig neu backgefüllt.
      const backfilled = symDoc.get('barsBackfillV') === 2;
      const barsToWrite = backfilled ? snap.bars.slice(-1) : snap.bars;
      for (const bar of barsToWrite) {
        batch.set(symRef.collection('bars').doc(bar.date), {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        });
      }
      if (!backfilled) {
        batch.set(
          symRef,
          { barsBackfillV: 2, barsBackfilledAt: now.toISOString() },
          { merge: true },
        );
      }

      // Tiefe Historie (Chart-Audit 2, 25.07.): einmalig Tages-Bars als EIN
      // Doc je Jahr (ohlcDaily/{JAHR}) — nahtloses Rausscrollen im Chart bei
      // ~1 Read je Jahr. Additiv + idempotent (Versions-Marker); die
      // bars-Collection (rollierendes Jahr) bleibt unangetastet.
      // V2 (Zoom-Kontinuum 06.08.): volle Yahoo-Historie (range=max) statt
      // 5 Jahre — Bestandssymbole werden über den Marker einmalig vertieft.
      // EIGENER Batch-Commit: Ein alter Index bringt ~100 Jahres-Docs mit,
      // und die würden das 500-Ops-Budget des Sammel-Batches sprengen.
      if (symDoc.get('deepBackfillV') !== 2) {
        try {
          const deep = await getDeepDailyBars(symbol);
          const deepBatch = db.batch();
          for (const [year, days] of chunkBarsByYear(deep)) {
            deepBatch.set(
              symRef.collection('ohlcDaily').doc(year),
              { days, updatedAt: now.toISOString() },
              { merge: true },
            );
          }
          deepBatch.set(symRef, { deepBackfillV: 2, deepBackfilledAt: now.toISOString() }, { merge: true });
          await deepBatch.commit();
        } catch (e) {
          logger.warn(`deepBackfill ${symbol}`, e); // nächster Scan versucht es erneut
        }
      }

      // Intraday (5m): Yahoo liefert ~5 Handelstage. Erst-Backfill alle Tage,
      // danach nur der jüngste Tag (1 Chunk-Doc je ET-Tag, idempotent).
      try {
        const intraday = await getIntradayBars(symbol);
        const days = [...intraday.keys()].sort();
        // 5-min-Closes ins Marktbild: Signal-Basis des 'intraday'-Zeitrahmens
        const md = marketData.get(symbol);
        if (md) md.closes5m = days.flatMap((d) => intraday.get(d) ?? []).map((b) => b.c);
        const writeDays = symDoc.get('intradayBackfilledAt') ? days.slice(-1) : days;
        for (const day of writeDays) {
          batch.set(symRef.collection('ohlc5m').doc(day), {
            date: day,
            bars: intraday.get(day),
            updatedAt: now.toISOString(),
          });
        }
        if (!symDoc.get('intradayBackfilledAt')) {
          batch.set(symRef, { intradayBackfilledAt: now.toISOString() }, { merge: true });
        }
        intradayOk += 1;

        // Intraday-Kurzfrist-Prognose (Prognose 2.0 Teil 2): Projektion der
        // nächsten Stunde, bei JEDEM Scan neu berechnet (maximale Update-Rate);
        // Shadow-Gitter loggt nur bei offenem Markt (Session-Gate im Forecaster).
        try {
          const flat = days.flatMap((d) => intraday.get(d) ?? []);
          const ifc = await runIntradayForecast(
            symbol,
            flat,
            offenMitUhr(symbol, now, uhrOffen),
            news,
          );
          if (md) md.intradayPct = ifc?.predictedPct ?? null;
          batch.set(
            symRef,
            {
              forecastIntraday: ifc
                ? {
                    points: ifc.points,
                    band: ifc.band,
                    lookback: ifc.lookback,
                    predictedPct: Math.round(ifc.predictedPct * 100) / 100,
                    baseT: ifc.points[0]!.t - 300,
                    updatedAt: now.toISOString(),
                    calib: ifc.calib,
                  }
                : null,
            },
            { merge: true },
          );
        } catch (err) {
          logger.warn(`Intraday-Forecast-Fehler ${symbol}`, err);
        }
      } catch (err) {
        logger.warn(`Intraday-Fehler ${symbol}`, err);
        intradayError ??= `${symbol}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 180);
      }

      // Indikator-Snapshot des letzten Handelstags (1 Doc/Tag, überschreibend).
      // `date` zusätzlich als Feld: Firestore kann nicht absteigend über
      // Doc-IDs sortieren (kein descending key scan) — Clients sortieren
      // deshalb über dieses Feld.
      batch.set(symRef.collection('indicators').doc(lastDate), {
        ...sig.snapshot,
        date: lastDate,
      });

      // Schatten-Kante je Klasse (MG4, 04.08.): Das Signal des VORIGEN Scans
      // steht am Markt-Dokument; jetzt liegt der Kurs vor, den es
      // vorhergesagt hat. Die Differenz — vorzeichenrichtig zur Richtung,
      // abzüglich Roundtrip-Kosten — ist die Kante dieser Signalquelle.
      //
      // Der Punkt daran: Sie entsteht UNABHÄNGIG davon, ob gehandelt wurde.
      // Steht eine Klasse per Regler auf 0, misst der Schatten weiter, und
      // sie kann sich zurückverdienen. Ohne das wäre jedes Abschalten
      // endgültig (siehe shared/src/classShadow.ts).
      //
      // Kostet nichts: Das Markt-Dokument wird ohnehin gelesen und
      // geschrieben — es kommt nur ein Feld dazu.
      const kosten = feeRateForClass(classify(symbol)) * 2;
      const vorher = leseSchattenSignal(symDoc.get('lastSignal'), now.getTime());
      if (vorher) {
        const kl = classify(symbol);
        const beitrag = bewerteSchattenSignal(vorher, sig.price, kosten);
        schattenKlassen[kl] = addiereSchatten(schattenKlassen[kl], beitrag);
        schattenVarianten.live = addiereSchatten(schattenVarianten.live, beitrag);
        zuVariante('live', kl, beitrag);
        /* Dieselben Signale, gefiltert (MI2). Fehlt das Feld, stammt das
         * Signal aus der Zeit vor der Messung — dann NICHT mitzählen statt
         * `true` anzunehmen: Eine ungefilterte Zahl in einem Zähler namens
         * „gefiltert" wäre schlimmer als ein leerer Zähler. */
        if (vorher.kostenOk === true) {
          schattenVarianten.live_kosten = addiereSchatten(schattenVarianten.live_kosten, beitrag);
          zuVariante('live_kosten', kl, beitrag);
        }
        // Exit-Stil-Messung (06.08.): dieselben Beiträge, nach Signaltyp
        // getrennt. `gemischt` läuft bewusst in KEINE der beiden — die
        // Hypothese handelt von den klaren Fällen.
        if (vorher.typ === 'trend') {
          schattenVarianten.live_trend = addiereSchatten(schattenVarianten.live_trend, beitrag);
        } else if (vorher.typ === 'umkehr') {
          schattenVarianten.live_umkehr = addiereSchatten(schattenVarianten.live_umkehr, beitrag);
        }
      }
      /* Tages-Horizont bewerten (Task 94): Das gereifte Signal gegen den
       * HEUTIGEN Kurs — dieselbe Kosten- und Richtungsrechnung wie beim
       * 5-Minuten-Schatten, nur der Horizont ist ein anderer. Trägt die
       * Kante hier die Kosten, heißt der Hebel „länger halten". */
      if (tagSlot.status === 'reif') {
        const beitragTag = bewerteSchattenSignal(tagSlot.signal, sig.price, kosten);
        schattenVarianten.live_tag = addiereSchatten(schattenVarianten.live_tag, beitragTag);
        zuVariante('live_tag', classify(symbol), beitragTag);
        if (tagSlot.signal.typ === 'trend') {
          schattenVarianten.live_tag_trend
            = addiereSchatten(schattenVarianten.live_tag_trend, beitragTag);
        } else if (tagSlot.signal.typ === 'umkehr') {
          schattenVarianten.live_tag_umkehr
            = addiereSchatten(schattenVarianten.live_tag_umkehr, beitragTag);
        }
      }
      // Dieselbe Bewertung für die regime-gerechte Lesart (MI). Beide
      // Varianten sehen denselben Kurs zur selben Zeit — nur so ist der
      // Vergleich fair. Getrennt geführt, weil eine gemeinsame Summe die
      // Frage, um die es geht, gerade wegmitteln würde.
      const vorherRegime = leseSchattenSignal(symDoc.get('lastSignalRegime'), now.getTime());
      if (vorherRegime) {
        const beitragRegime = bewerteSchattenSignal(vorherRegime, sig.price, kosten);
        schattenVarianten.regime = addiereSchatten(schattenVarianten.regime, beitragRegime);
        zuVariante('regime', classify(symbol), beitragRegime);
      }
      signalDirs[sig.direction] += 1;
      // Stimmen je INDIKATOR (04.08.). Warum das nötig wurde: `signalDirs`
      // zeigte über Stunden `buy: 0, sell: 2, hold: 37` — die Konfluenz
      // erzeugt im Aufwärtstrend fast nur Verkaufssignale, und die
      // Regime-Ampel blockt sie folgerichtig als Shorts gegen den Trend.
      // Ergebnis: Stillstand. Ob das an EINEM Indikator liegt oder an allen
      // dreien, ließ sich aus der Summe nicht ablesen — und ohne diese
      // Unterscheidung wäre jede Änderung an der Konfluenz geraten.
      for (const [name, richtung] of Object.entries(sig.votes)) {
        const eintrag = voteDirs[name] ?? { buy: 0, sell: 0, hold: 0 };
        if (richtung === 'buy' || richtung === 'sell' || richtung === 'hold') {
          eintrag[richtung] += 1;
        }
        voteDirs[name] = eintrag;
      }
      // Wie knapp war es? Ein Signal, dem EINE Stimme zur Konfluenz fehlte,
      // ist etwas anderes als eines, das weit daneben lag: Im ersten Fall
      // würde eine niedrigere Schwelle Trades freisetzen, im zweiten nicht.
      if (sig.direction === 'hold') {
        const beste = Math.max(sig.buyVotes, sig.sellVotes);
        if (beste > 0 && beste === sig.requiredConfluence - 1) knappVerfehlt += 1;
      }
      // Konfluenz-Signal dieses Scans
      batch.set(symRef.collection('signals').doc(scanId), {
        direction: sig.direction,
        confluence: sig.confluence,
        buyVotes: sig.buyVotes,
        sellVotes: sig.sellVotes,
        requiredConfluence: sig.requiredConfluence,
        votes: sig.votes,
        price: sig.price,
        at: now.toISOString(),
        // Transparenz: effektives Prognose-Stimmgewicht dieses Scans
        forecastVote: {
          base: Math.trunc(DEFAULT_STRATEGY.signals.forecastWeight),
          weight: fcVote.weight,
          factor: fcVote.factor,
        },
      });

      await batch.commit();
      scanned.push(symbol);
    } catch (err) {
      errors[symbol] = err instanceof Error ? err.message : String(err);
      logger.error(`Scan-Fehler ${symbol}`, err);
    }
  }

  // Auto-Trades pro User (1 Marktdaten-Fetch oben, N Auswertungen hier).
  // Geguarded: Ein Fehler hier darf den Heartbeat nicht verhindern — sonst
  // bleibt meta/health stehen und die Ursache ist ohne GCP-Konsole unsichtbar.
  let trades = 0;
  let entryGate: EntryGateStats = {
    geprueft: 0,
    nicht_handelbar: 0,
    cluster_voll: 0,
    news_veto: 0,
    unter_kosten: 0,
    kante_wuerde_blocken: 0,
    klasse_aus: 0,
    breaker_aktiv: 0,
    abgleich_drift: 0,
    ohne_atr_durchgelassen: 0,
    filter_blockiert: 0,
    regime_gegen_trend: 0,
    regime_stress: 0,
    hebel_frei: 0,
  };
  let lastError: string | null = null;
  // null = Trade-Block ist gar nicht gelaufen (Fehler davor) — das ist eine
  // andere Aussage als „0 Konten laufend" und darf nicht gleich aussehen.
  let konten: KontenStats | null = null;
  // null = kein Konto hat einen Broker hinterlegt ODER der Block lief nicht.
  // Auch das ist eine Aussage: Ohne verbundenes Konto gibt es nichts zu routen.
  let brokerStats: BrokerStats | null = null;
  try {
    await migrateTimeframeDaily(db);
    await migrateCorePctAll(db);
    const res = await executeUserTrades(marketData, regime.state, scanId);
    trades = res.executed;
    entryGate = res.gate;
    konten = res.konten;
    brokerStats = res.broker;
  } catch (err) {
    lastError = `trades: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.error('Trade-Block fehlgeschlagen', err);
  }

  // Katalog-Versorgung (alle Marktgruppen, rotierender Chunk) — geguarded,
  // damit ein Yahoo-/Firestore-Schluckauf nie den Kern-Scan gefährdet.
  let catalogQuotes = 0;
  let catalogOpen = 0;
  try {
    const supply = await supplyCatalog(new Set(scanned), now, uhrOffen);
    catalogQuotes = supply.fresh;
    catalogOpen = supply.open;
  } catch (err) {
    lastError = lastError ?? `catalog: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.warn('Katalog-Versorgung fehlgeschlagen', err);
  }

  // Intraday-Prognosen bewerten (Prognose 2.0 Teil 2): Kurzfrist-Horizonte
  // realisieren binnen einer Stunde — huckepack im Scan statt täglich 16:30.
  let intradayScored = 0;
  // Die Zwischenstände (offen/fällig/verfallen/noch nicht realisiert) landen
  // mit im Heartbeat: Eine 0 bei „bewertet" allein sagt nicht, WORAN es lag —
  // genau daran hing der Befund vom 27.07., als die Zahl tagelang stand,
  // während gleichzeitig Prognosen entstanden.
  let intradayEval: Record<string, number> | null = null;
  try {
    const res = await evaluateIntradayDue();
    intradayScored = res.scored;
    intradayEval = {
      pending: res.pending,
      due: res.due,
      expired: res.expired,
      unrealized: res.unrealized,
    };
  } catch (err) {
    lastError = lastError ?? `evalIntraday: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.warn('Intraday-Eval fehlgeschlagen', err);
  }

  // Schatten-Kante je Klasse fortschreiben (MG4). Ein Scan liefert ~13
  // Datenpunkte — die Aussage entsteht erst über Tage, also muss das
  // Aggregat dauerhaft leben. `increment` statt Lesen-Rechnen-Schreiben:
  // Ein manuell ausgelöster Scan parallel zum Zeitplan darf keine
  // Datenpunkte verschlucken.
  let schattenStand: Record<string, ReturnType<typeof werteSchattenAus>> | null = null;
  try {
    const ref = db.doc('meta/classShadow');
    const vorstand = await ref.get();
    const alt = (vorstand.get('klassen') as Record<string, SchattenKlasse> | undefined) ?? {};
    if (Object.keys(schattenKlassen).length > 0) {
      const inkremente: Record<string, Record<string, FirebaseFirestore.FieldValue>> = {};
      for (const [kl, k] of Object.entries(schattenKlassen)) {
        inkremente[kl] = {
          n: FieldValue.increment(k.n),
          summePct: FieldValue.increment(k.summePct),
          treffer: FieldValue.increment(k.treffer),
          // Rohbewegung mit eigenem Zähler (05.08.) — trennt „Signal trägt
          // keine Information" von „Gebühren fressen die Information".
          summeRohPct: FieldValue.increment(k.summeRohPct ?? 0),
          nRoh: FieldValue.increment(k.nRoh ?? 0),
        };
      }
      await ref.set(
        {
          klassen: inkremente,
          updatedAt: now.toISOString(),
          ...(vorstand.get('startedAt') ? {} : { startedAt: now.toISOString() }),
        },
        { merge: true },
      );
    }
    // Für den Heartbeat: alter Stand + Beitrag dieses Scans. Die Anzeige
    // rechnet damit dasselbe, was der atomare Write gerade festgeschrieben hat.
    const klassen = new Set([...Object.keys(alt), ...Object.keys(schattenKlassen)]);
    schattenStand = {};
    for (const kl of klassen) {
      const a = alt[kl] ?? { n: 0, summePct: 0, treffer: 0 };
      const b = schattenKlassen[kl] ?? { n: 0, summePct: 0, treffer: 0 };
      schattenStand[kl] = werteSchattenAus({
        n: a.n + b.n,
        summePct: Math.round((a.summePct + b.summePct) * 10_000) / 10_000,
        treffer: a.treffer + b.treffer,
        ...summiereRoh(a, b),
      });
    }
  } catch (err) {
    logger.warn('Schatten-Kante nicht fortgeschrieben', err); // nie den Scan gefährden
  }

  // Dasselbe für den Vergleich der beiden Signal-Lesarten (MI). Eigenes
  // Dokument, weil es eine andere Frage beantwortet: nicht „welche Klasse
  // trägt?", sondern „welche Signal-Logik trägt?".
  let variantenStand: Record<string, ReturnType<typeof werteSchattenAus>> | null = null;
  try {
    const ref = db.doc('meta/signalShadow');
    const vorstand = await ref.get();
    const alt = (vorstand.get('varianten') as Record<string, SchattenKlasse> | undefined) ?? {};
    const beitraege = Object.entries(schattenVarianten).filter(([, v]) => v) as Array<
      [string, SchattenKlasse]
    >;
    if (beitraege.length > 0) {
      const inkremente: Record<string, Record<string, unknown>> = {};
      for (const [name, k] of beitraege) {
        // Klassen-Aufschlüsselung DERSELBEN Beiträge — ein zweites
        // Unterfeld am selben Dokument, kein zweiter Write.
        const jeKlasse: Record<string, Record<string, FirebaseFirestore.FieldValue>> = {};
        for (const [kl, kk] of Object.entries(schattenVariantenKlassen[name] ?? {})) {
          jeKlasse[kl] = {
            n: FieldValue.increment(kk.n),
            summePct: FieldValue.increment(kk.summePct),
            treffer: FieldValue.increment(kk.treffer),
            summeRohPct: FieldValue.increment(kk.summeRohPct ?? 0),
            nRoh: FieldValue.increment(kk.nRoh ?? 0),
          };
        }
        inkremente[name] = {
          n: FieldValue.increment(k.n),
          summePct: FieldValue.increment(k.summePct),
          treffer: FieldValue.increment(k.treffer),
          summeRohPct: FieldValue.increment(k.summeRohPct ?? 0),
          nRoh: FieldValue.increment(k.nRoh ?? 0),
          ...(Object.keys(jeKlasse).length > 0 ? { klassen: jeKlasse } : {}),
        };
      }
      await ref.set(
        {
          varianten: inkremente,
          updatedAt: now.toISOString(),
          ...(vorstand.get('startedAt') ? {} : { startedAt: now.toISOString() }),
        },
        { merge: true },
      );
    }
    const namen = new Set([...Object.keys(alt), ...beitraege.map(([n]) => n)]);
    variantenStand = {};
    for (const name of namen) {
      const a = alt[name] ?? { n: 0, summePct: 0, treffer: 0 };
      const b = schattenVarianten[name as keyof typeof schattenVarianten]
        ?? { n: 0, summePct: 0, treffer: 0 };
      variantenStand[name] = werteSchattenAus({
        n: a.n + b.n,
        summePct: Math.round((a.summePct + b.summePct) * 10_000) / 10_000,
        treffer: a.treffer + b.treffer,
        ...summiereRoh(a, b),
      });
    }
  } catch (err) {
    logger.warn('Varianten-Schatten nicht fortgeschrieben', err);
  }

  // Heartbeat für Monitoring-Alerts (SETUP.md §J): meta/health ist öffentlich
  // lesbar (meta-Rules) und enthält bewusst KEINE sensiblen Daten.
  await db
    .doc('meta/health')
    .set(
      {
        lastScanAt: now.toISOString(),
        lastScanId: scanId,
        lastRunAt: now.toISOString(),
        lastRunSkipped: null,
        symbolsOk: scanned.length,
        symbolsFailed: Object.keys(errors).length,
        // Was gerade beobachtet wird — die Oberfläche zeigt genau diese
        // Symbole an. Ohne die Liste im Heartbeat müsste sie raten oder
        // eine eigene Auswahl treffen, und dann zeigte das Dashboard etwas
        // anderes, als die Engine handelt.
        watched: scanned,
        intradayOk,
        intradayError,
        intradayScored,
        intradayEval,
        trades,
        // Was an der Einstiegs-Prüfung passiert ist (Befund 28.07.). Ohne
        // diese Zahlen wäre der Effekt der Filter nicht messbar: Ein Scan
        // ohne Trades sieht mit und ohne Filter identisch aus. Der
        // Regelkreis: `unter_kosten` über Tage hoch bei `trades: 0` ⇒
        // Schwelle zu scharf; `ohne_atr_durchgelassen` hoch ⇒ die Schwelle
        // prüft gar nicht, und die Ursache liegt bei den Daten, nicht am
        // Parameter.
        entryGate,
        /* Broker-Anbindung (M13): Kommt das Order-Routing bis zum Broker?
         *
         * `verbunden: 0` heißt: Kein Konto hat einen Schlüssel hinterlegt —
         * dann ist Stille im Depot völlig richtig. `verbunden: 1, fehler: 1`
         * heißt etwas ganz anderes, sieht aber ohne diese Zahlen genauso
         * aus. Aggregiert und ohne Konto-Bezug, weil meta/health öffentlich
         * lesbar ist. */
        broker: brokerStats,
        /* Was die Konfluenz überhaupt PRODUZIERT (04.08.).
         *
         * Die Blockade-Zähler oben sehen nur, was am Tor ankommt. Erst diese
         * Verteilung sagt, ob ein Scan ohne Trades ein ruhiger Markt war
         * (viel `hold`) oder ein Markt, in dem die Engine gegen den Trend
         * wollte und dafür gestoppt wurde (viel `sell` bei Regime `trend`).
         * Im Log sehen beide Fälle identisch aus — als „keine Trades".
         *
         * Zusammen mit `regime` darunter ist das die Diagnose: Steht hier
         * dauerhaft `sell` weit über `buy`, während das Regime `trend`
         * meldet, sucht die Signal-Logik Umkehrpunkte in einem laufenden
         * Trend — und die Ampel blockt dann nicht zu viel, sondern rettet. */
        signalDirs,
        voteDirs,
        knappVerfehlt,
        /* Schatten-Kante je Anlageklasse (MG4) — kumuliert, nicht je Scan.
         *
         * Die Zahl beantwortet die Frage, die die Trade-Kante nicht
         * beantworten kann: Wie gut sagen die Signale einer Klasse die
         * Richtung voraus, wenn dort gerade GAR NICHT gehandelt wird? Ohne
         * sie friert die Empfehlung einer abgeschalteten Klasse auf dem
         * Stand des Abschaltens ein — und die Entscheidung wird faktisch
         * endgültig, obwohl der Regler graduell gemeint ist. */
        schatten: schattenStand,
        /* Zweite Signal-Lesart im Schatten (MI, 04.08.).
         *
         * Anlass: `knappVerfehlt` stand bei 13 von 13 — jedes Signal
         * verfehlte die Konfluenz um genau EINE Stimme, und zwar immer
         * dieselbe. RSI und Bollinger sind auf Umkehr parametriert und
         * schweigen im Trend strukturell; MACD ist der einzige Trendfolger.
         * `minConfluence: 2` ist damit im Trend nicht selten unerreichbar,
         * sondern unerreichbar.
         *
         * `regimeDirs` zeigt, was eine regime-gerechte Lesart daraus machen
         * würde, `signalSchatten` was sie verdient hätte — beide gegen
         * dieselben Kurse. Erst wenn die Kante der Variante die der
         * gehandelten Logik schlägt, wird umgeschaltet. Vorher nicht: Mehr
         * Trades bei negativer Kante sind mehr Verlust, kein Fortschritt. */
        regimeDirs,
        regimeVoteDirs,
        signalSchatten: variantenStand,
        // Konten-Zähler (Owner-Fund 02.08.): WER am Handel teilnimmt und wer
        // still übersprungen wird — als Summen, ohne Konto-Bezug. Steht
        // `wartet_freischaltung` > 0 bei einem User mit „Engine an", ist die
        // fehlende Freischaltung die Ursache, nicht der Markt.
        konten,
        // Alter Name, bis die Oberfläche nachzieht — der Inhalt ist derselbe
        // wie `entryGate`, nur ohne die Durchlass-Zahl.
        entryBlocks: {
          nicht_handelbar: entryGate.nicht_handelbar,
          cluster_voll: entryGate.cluster_voll,
          unter_kosten: entryGate.unter_kosten,
        },
        // Katalog-Beobachtung (Owner-Frage 28.07. „alles immer parallel"):
        // `catalogQuotes` = in DIESEM Scan frisch bekurste Katalog-Symbole,
        // `catalogOpen` = wie viele überhaupt einen offenen Markt hatten.
        // Stehen die beiden auseinander, hat ein Spark-Chunk gepatzt — das
        // wäre sonst unsichtbar, weil fehlende Kurse einfach alte bleiben.
        catalogQuotes,
        catalogOpen,
        // News-Rückkehr 29.07.: wie viele Symbole in DIESEM Scan frische
        // Feeds bekamen. Steht die Zahl dauerhaft auf 0, sind die Feeds
        // tot — und das Veto damit still abgeschaltet (fails open). Genau
        // deshalb muss die Zahl hier stehen: Ein stilles Veto sieht sonst
        // aus wie ein Markt ohne Ereignisse.
        newsFetched,
        // Regime-Ampel: Zustand + Eingangsgrößen (Transparenz). Steuert in
        // Stufe 1 nichts — er wird gemessen und in die Steckbriefe des
        // Trade-Filters gestempelt, damit der je Regime getrennt lernt.
        regime,
        // Termin-Kalender (04.08., Schatten): Was steht an, und liegt der Tag
        // im Turn-of-the-Month-Fenster? Steuert noch NICHTS — erst wenn die
        // Auswertung über genug Termine zeigt, dass es sich lohnt. Bis dahin
        // ist es die Datengrundlage, an der sich das später messen lässt.
        kalender: calendarReading(now),
        lastError,
        lastErrorAt: lastError ? now.toISOString() : null,
      },
      { merge: true },
    )
    .catch((err) => logger.warn('Heartbeat-Write fehlgeschlagen', err));

  logger.info(`Scan ${scanId}: ${scanned.length}/${symbols.length} Symbole ok, ${trades} Trade(s)`);
  return { scanId, scanned, errors, trades };
}

/** Alle 5 Minuten; der Gate macht außerhalb der Marktzeiten einen No-Op.
 *  512 MiB statt Default 256 (Live-OOM 25.07.: „Memory limit exceeded with
 *  259–274 MiB" — 5J-Backfill + Katalog-Versorgung + volle Watchlist brauchen
 *  Luft); 180 s Timeout für den Erst-Backfill mehrerer Symbole. */
export const scanMarket = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/New_York',
    retryCount: 0,
    memory: '512MiB',
    timeoutSeconds: 180,
    // Kein KI-Secret mehr: Der Scan ruft seit 28.07. keine Claude-API auf —
    // Der Scan ruft kein Sprachmodell mehr auf (MILESTONES M6).
  },
  async () => {
    try {
      await runScan(false);
    } catch (err) {
      // Selbstdiagnose ohne GCP-Konsole: Die Fehlermeldung (nie Secrets —
      // unsere Fehlerpfade loggen keine Keys) landet im öffentlichen
      // meta/health, damit ein roter Lauf von außen erklärbar ist. Der
      // Fehler wird rethrown, damit Cloud Logging + Monitoring ihn sehen.
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      logger.error('runScan fehlgeschlagen', err);
      await getFirestore()
        .doc('meta/health')
        .set({ lastError: `scan: ${msg}`, lastErrorAt: new Date().toISOString() }, { merge: true })
        .catch(() => undefined);
      throw err;
    }
  },
);

/**
 * Manueller Trigger — NUR im Emulator (lokale Verifikation, MILESTONES M2
 * Abnahme). In Produktion hart 403, damit niemand Scan-Kosten erzeugen kann.
 */
export const scanNow = onRequest(EMULATOR_TRIGGER_OPTS, async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'scanNow ist nur im Emulator verfügbar' });
    return;
  }
  const force = req.query.force === '1';
  const result = await runScan(force);
  res.status(200).json(result);
});
