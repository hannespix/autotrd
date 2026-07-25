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

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  CATALOG,
  CLASS_LABELS,
  DEFAULT_STRATEGY,
  allSymbols,
  classify,
  isStrategy,
  marketOpenForClass,
  resolveName,
  STRATEGY_PRESETS,
  type Position,
  type Strategy,
  type StrategyDoc,
} from '../../../shared/src/index.js';
import { aggregateSentiment } from '../../../shared/src/index.js';
import { anthropicApiKey, ensureAiDay } from '../core/ai.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { computeIndicatorSnapshot, computeSignal } from '../core/engine.js';
import { executePaperTrade, resolveBrokerMode, riskExitReason } from '../core/broker.js';
import {
  RISK_LIMITS,
  applyPredictionVote,
  buildRuleContext,
  clampStrategyRisk,
  cooldownActive,
  decideTree,
  minuteOfDayEt,
  predictionVote,
  shadowEquity,
  shadowTrade,
  type ShadowBook,
} from '../core/rulesTrading.js';
import { accuracyWeightedVote } from '../../../shared/src/index.js';
import { runForecast, runIntradayForecast, type LiveForecast } from '../core/forecaster.js';
import { evaluateIntradayDue } from './evalForecasts.js';
import { chunkBarsByYear, getDeepDailyBars, getIntradayBars, getMarketSnapshot, getQuickQuote } from '../core/marketData.js';
import { fetchNews, newsDocId, type NewsItem } from '../core/news.js';

const NEWS_TTL_MS = 10 * 60 * 1000; // wie die Referenz: 10-min-Cache

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

/** meta/strategyPresets einmalig seeden (M10 — Presets = Doku). Idempotent. */
async function seedPresets(): Promise<void> {
  const db = getFirestore();
  const ref = db.doc('meta/strategyPresets');
  if ((await ref.get()).exists) return;
  await ref.set({ presets: STRATEGY_PRESETS, seededAt: new Date().toISOString() });
  logger.info('meta/strategyPresets geseedet');
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
}

/**
 * Auto-Trading pro User (MILESTONES M4): Für jeden User mit
 * `settings.strategy.engine.running === true` werden die Signale gegen SEINE
 * Strategie-Parameter neu ausgewertet (Indikator-Mathe in-memory, keine
 * weiteren Fetches) und Paper-Trades transaktional ausgeführt; danach
 * Stop-Loss/Take-Profit über die offenen Positionen.
 */
async function executeUserTrades(marketData: Map<string, SymbolData>): Promise<number> {
  const db = getFirestore();
  let executed = 0;
  const users = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();

  for (const userDoc of users.docs) {
    const uid = userDoc.id;
    const strategy = userDoc.get('settings.strategy') as Strategy | undefined;
    if (!strategy || !isStrategy(strategy)) continue;
    if (resolveBrokerMode(strategy) !== 'paper') continue; // Live bleibt verriegelt (M14)

    try {
      const positionsSnap = await userDoc.ref.collection('positions').get();
      const positions = new Map<string, Position>(
        positionsSnap.docs.map((d) => [d.id, d.data() as Position]),
      );

      // 1) Risiko-Exits zuerst (Port von _check_risk — vor neuen Signalen)
      for (const [symbol, pos] of positions) {
        const data = marketData.get(symbol);
        if (!data) continue;
        const reason = riskExitReason(pos, data.price, strategy);
        if (reason) {
          const r = await executePaperTrade(
            { uid, symbol, side: 'sell', price: data.price, source: 'engine', riskExit: reason },
            strategy,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            logger.info(`Risk-Exit ${uid} ${symbol} (${reason})`);
          }
        }
      }

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
      const clamped = clampStrategyRisk(strategy); // Risiko-Hülle: nie überschreibbar
      const now = new Date();
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
          const snapshot = computeIndicatorSnapshot(data.closes, data.price, strategy.indicators);
          const prevCloses = data.closes.slice(0, -1);
          const prevPrice = prevCloses[prevCloses.length - 1] ?? null;
          const ctx = buildRuleContext({
            price: data.price,
            snapshot,
            prevSnapshot:
              prevPrice !== null && prevCloses.length > 1
                ? computeIndicatorSnapshot(prevCloses, prevPrice, strategy.indicators)
                : null,
            prevPrice,
            closes: data.closes,
            minuteOfDayEt: minuteEt,
            forecastPct: data.forecast?.predictedPct ?? null,
            position: pos
              ? { open: true, unrealizedPct: ((data.price - pos.avgEntry) / pos.avgEntry) * 100 }
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
              // Virtuelles Konto — Risiko-Hülle wie beim echten Handel
              if (dir === 'buy' && !book.positions[symbol]) {
                if (Object.keys(book.positions).length >= RISK_LIMITS.maxOpenPositions) continue;
                if (cooldownActive(doc.lastTrades?.[symbol], now)) continue;
                const r = shadowTrade(book, symbol, 'buy', data.price, clamped.engine.maxPositionPct);
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                }
              } else if (dir === 'sell' && book.positions[symbol]) {
                const r = shadowTrade(book, symbol, 'sell', data.price, clamped.engine.maxPositionPct);
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                }
              }
            }
            continue; // Shadow berührt NIE das echte Wallet
          }

          if (dir === 'buy' && !pos) {
            // Entry-Guards der Risiko-Hülle: Positionslimit + Cooldown
            if (positions.size >= RISK_LIMITS.maxOpenPositions) continue;
            if (cooldownActive(doc.lastTrades?.[symbol], now)) continue;
            const r = await executePaperTrade(
              { uid, symbol, side: 'buy', price: data.price, source: 'engine' },
              clamped,
            );
            if (r.executed) {
              executed += 1;
              // lokaler Marker fürs Positionslimit/Dedup in diesem Scan
              positions.set(symbol, {
                symbol,
                qty: r.trade?.qty ?? 0,
                avgEntry: data.price,
                stopLoss: null,
                takeProfit: null,
                openedAt: now.toISOString(),
              });
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Buy ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'sell' && pos) {
            // Exits blockt der Cooldown NIE (Sicherheitsprinzip)
            const r = await executePaperTrade(
              { uid, symbol, side: 'sell', price: data.price, source: 'engine' },
              clamped,
            );
            if (r.executed) {
              executed += 1;
              positions.delete(symbol);
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Sell ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
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
      for (const symbol of strategy.watchlist) {
        if (strategyOwned.has(symbol)) continue;
        const data = marketData.get(symbol);
        if (!data) continue;
        const sig = computeSignal(
          data.closes,
          data.price,
          strategy.indicators,
          strategy.signals,
          data.forecast,
        );
        // Prognose-Pfeil des Users als zusätzliche gewichtete Stimme
        const direction = applyPredictionVote(
          sig,
          predictionVote(predictions.get(symbol), data.price, todayIso),
        );
        if (direction === 'buy' && !positions.has(symbol)) {
          const r = await executePaperTrade(
            { uid, symbol, side: 'buy', price: data.price, source: 'engine' },
            strategy,
          );
          if (r.executed) {
            executed += 1;
            logger.info(`Engine-Buy ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'sell' && positions.has(symbol)) {
          const r = await executePaperTrade(
            { uid, symbol, side: 'sell', price: data.price, source: 'engine' },
            strategy,
          );
          if (r.executed) {
            executed += 1;
            logger.info(`Engine-Sell ${uid} ${symbol} @ ${data.price}`);
          }
        }
      }
    } catch (err) {
      logger.error(`Auto-Trading-Fehler für ${uid}`, err);
    }
  }
  return executed;
}

/** Obergrenze des zentralen Scan-Sets (Kosten-Guard). */
const MAX_SCAN_SYMBOLS = 40;

/**
 * Scan-Set = Default-Watchlist ∪ alle User-Watchlists (M3: der Picker macht
 * Symbole wählbar; der nächste Scan versorgt sie zentral mit Daten).
 */
async function collectScanSymbols(): Promise<string[]> {
  const db = getFirestore();
  const set = new Set<string>(DEFAULT_STRATEGY.watchlist);
  try {
    const users = await db.collection('users').select('settings.strategy.watchlist').get();
    for (const doc of users.docs) {
      const wl = doc.get('settings.strategy.watchlist') as unknown;
      if (Array.isArray(wl)) {
        for (const sym of wl) {
          if (typeof sym === 'string' && set.size < MAX_SCAN_SYMBOLS) set.add(sym);
        }
      }
    }
  } catch (err) {
    logger.warn('User-Watchlists nicht lesbar — Scan nur über Default', err);
  }
  return [...set];
}

/** Symbole je Versorgungs-Runde (Kosten-Deckel: 12 Scans/h × 15 ≈ voller
 *  Katalog jede Stunde bei nativer 5-min-Kadenz). */
const CATALOG_CHUNK = 15;

/**
 * Katalog-Versorgung (Taschenmesser Teil 2, User-Wunsch 25.07.): ALLE
 * Marktgruppen bekommen Daten, nicht nur die Watchlist — die bleibt der
 * Engine-Scope mit voller 5-min-Tiefe (Indikatoren, News, Intraday).
 * Der Katalog (~166 Symbole) wird als rotierender Chunk je Scan mit einem
 * leichten Quote-Fetch versorgt (+ jüngste Tageskerze aus demselben Fetch).
 * Frische-Gates halten die Kosten klein: offene Klassen ~stündlich, bei
 * geschlossenem Markt reicht die vorhandene letzte Quote.
 */
async function supplyCatalog(scannedSet: Set<string>, now: Date): Promise<number> {
  const db = getFirestore();
  const catalog = allSymbols();
  if (catalog.length === 0) return 0;
  const stateRef = db.doc('meta/catalogSupply');
  const state = await stateRef.get();
  const cursor = (state.get('cursor') as number | undefined) ?? 0;
  // Catch-up (User-Wunsch 25.07. „immer ALLE Daten"): Bis der Katalog einmal
  // komplett durchrotiert ist, große Chunks — Erstbefüllung in ~4 Läufen statt
  // ~11 (wichtig bei dünner Wochenend-Kadenz). Danach sparsame 15er-Rotation.
  const initialDone = state.get('initialDone') === true;
  const chunk = initialDone ? CATALOG_CHUNK : 45;

  const picked: string[] = [];
  for (let n = 0; n < chunk; n++) {
    const sym = catalog[(cursor + n) % catalog.length]!;
    if (!scannedSet.has(sym) && !picked.includes(sym)) picked.push(sym);
  }
  const refs = picked.map((s) => db.collection('market').doc(s));
  const docs = refs.length > 0 ? await db.getAll(...refs) : [];

  const batch = db.batch();
  let fetched = 0;
  for (let i = 0; i < picked.length; i++) {
    const sym = picked[i]!;
    const doc = docs[i]!;
    const quote = doc.get('quote') as { updatedAt?: string } | undefined;
    const ageMin = quote?.updatedAt ? (now.getTime() - Date.parse(quote.updatedAt)) / 60_000 : Infinity;
    // Frische-Gates: geschlossene Klasse + vorhandene Quote = nichts zu tun;
    // offene Klasse erst ab ~50 min Alter erneuern (≈ stündliche Kadenz).
    if (quote && !marketOpenForClass(classify(sym), now)) continue;
    if (ageMin < 50) continue;
    try {
      const q = await getQuickQuote(sym);
      batch.set(
        doc.ref,
        {
          symbol: sym,
          name: resolveName(sym),
          assetClass: classify(sym),
          quote: { price: q.price, changePct: q.changePct, updatedAt: now.toISOString() },
          lastBarDate: q.lastBar.date,
        },
        { merge: true },
      );
      // Tages-Tier: jüngste Kerze idempotent ablegen (Doc-ID = Datum) —
      // Sparklines/Mini-Charts wachsen so für den GANZEN Katalog Tag für Tag.
      batch.set(doc.ref.collection('bars').doc(q.lastBar.date), { ...q.lastBar });
      fetched++;
    } catch (err) {
      logger.warn(`Katalog-Quote ${sym}`, err); // nächste Runde versucht es erneut
    }
  }
  batch.set(
    stateRef,
    {
      cursor: (cursor + chunk) % catalog.length,
      initialDone: initialDone || cursor + chunk >= catalog.length,
      updatedAt: now.toISOString(),
      lastFetched: fetched,
    },
    { merge: true },
  );
  await batch.commit();
  return fetched;
}

/** Ein kompletter Scan-Zyklus über die zentrale Watchlist. */
export async function runScan(force = false): Promise<ScanResult> {
  const now = new Date();
  const scanId = now.toISOString().slice(0, 16) + 'Z'; // Minute = idempotent
  const allSymbols = await collectScanSymbols();
  // Depot-Vision (2026-07-24): gescannt wird je Symbol, dessen ASSET-KLASSE
  // gerade offen ist — Krypto 24/7, Forex/Rohstoffe ~24/5, Rest US-Zeiten.
  const symbols = force
    ? allSymbols
    : allSymbols.filter((s) => marketOpenForClass(classify(s), now));
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
  await seedPresets();
  const db = getFirestore();
  const scanned: string[] = [];
  const errors: Record<string, string> = {};
  const marketData = new Map<string, SymbolData>();
  // Intraday-Selbstdiagnose (Chart-Feedback): landet im öffentlichen
  // meta/health, weil Cloud-Logging ohne GCP-Konsole unsichtbar ist.
  let intradayOk = 0;
  let intradayError: string | null = null;

  // Genauigkeitsgewichtetes Forecast-Vote (Prognose 2.0 Teil 4): Das
  // Stimmgewicht der Prognose folgt ihrer REALISIERTEN Kante über den
  // Münzwurf — einmal je Scan aus der öffentlichen Lernstatistik gelesen.
  let fcVote = { weight: Math.trunc(DEFAULT_STRATEGY.signals.forecastWeight), factor: null as number | null };
  try {
    const statsSnap = await db.doc('meta/forecastStats').get();
    fcVote = accuracyWeightedVote(DEFAULT_STRATEGY.signals.forecastWeight, {
      scored: statsSnap.get('scored') as number | undefined,
      dirAccuracy: statsSnap.get('dirAccuracy') as number | null | undefined,
    });
  } catch (err) {
    logger.warn('forecastStats nicht lesbar — Basisgewicht bleibt', err);
  }
  const effSignals = { ...DEFAULT_STRATEGY.signals, forecastWeight: fcVote.weight };

  for (const symbol of symbols) {
    try {
      const snap = await getMarketSnapshot(symbol, DEFAULT_STRATEGY.signals.period);
      const closes = snap.bars.map((b) => b.close);
      const lastDate = snap.bars[snap.bars.length - 1]!.date;

      const symRef = db.collection('market').doc(symbol);
      const symDoc = await symRef.get();
      const batch = db.batch();

      // News + Sentiment (10-min-TTL wie die Referenz; Feeds nicht hämmern)
      const prevSent = symDoc.get('sentiment') as
        | { overall?: number; updatedAt?: string }
        | undefined;
      let sentimentOverall = prevSent?.overall ?? 0;
      const sentStale =
        !prevSent?.updatedAt || now.getTime() - Date.parse(prevSent.updatedAt) > NEWS_TTL_MS;
      if (sentStale) {
        let news: NewsItem[] = [];
        try {
          news = await fetchNews(symbol);
        } catch (err) {
          logger.warn(`News-Fehler ${symbol}`, err);
        }
        const agg = aggregateSentiment(news);
        sentimentOverall = agg.overall;
        batch.set(
          symRef,
          { sentiment: { ...agg, updatedAt: now.toISOString() } },
          { merge: true },
        );
        for (const item of news.slice(0, 20)) {
          batch.set(symRef.collection('news').doc(newsDocId(item)), { ...item });
        }
        // Event-Tage: News auf Chart-Tage mappen (sentiment-gefärbte Marker)
        const byDay = new Map<string, NewsItem[]>();
        for (const item of news) {
          const day = item.ts.slice(0, 10);
          if (day) byDay.set(day, [...(byDay.get(day) ?? []), item]);
        }
        for (const [day, items] of byDay) {
          const dayAgg = aggregateSentiment(items);
          const top = [...items]
            .sort(
              (a, b) =>
                Math.abs(b.sent.sentiment) + b.sent.magnitude -
                (Math.abs(a.sent.sentiment) + a.sent.magnitude),
            )
            .slice(0, 3)
            .map((i) => ({ title: i.title, source: i.source, url: i.url, kind: i.kind, sent: i.sent }));
          batch.set(symRef.collection('events').doc(day), {
            date: day,
            sentiment: dayAgg.overall,
            label: dayAgg.label,
            count: items.length,
            topEvents: dayAgg.topEvents,
            top,
          });
        }
        // KI-Staffel (M6b): Tages-Doc market/{sym}/ai/{date} — EIN Call-Paar
        // je (Symbol, Tag) für alle User; Cache-Hit = reiner Firestore-Read.
        // Ohne Key/Budget degradiert ensureAiDay sichtbar auf regelbasiert.
        if (news.length > 0) {
          try {
            await ensureAiDay(symbol, lastDate, news, snap.changePct);
          } catch (err) {
            logger.warn(`KI-Tages-Doc-Fehler ${symbol}`, err);
          }
        }
      }

      // Prognose mit ECHTEM News-Sentiment + Shadow-Grid
      let forecast: LiveForecast | null = null;
      try {
        forecast = await runForecast(symbol, closes, lastDate, sentimentOverall);
      } catch (err) {
        logger.warn(`Forecast-Fehler ${symbol}`, err);
      }
      marketData.set(symbol, { closes, price: snap.price, forecast });

      const sig = computeSignal(
        closes,
        snap.price,
        DEFAULT_STRATEGY.indicators,
        effSignals,
        forecast,
      );

      batch.set(
        symRef,
        {
          name: resolveName(symbol),
          assetClass: classify(symbol),
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
                w: forecast.w,
                lookback: forecast.lookback,
                predictedPct: Math.round(forecast.predictedPct * 100) / 100,
                sentiment: forecast.sentiment,
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

      // Tiefe Historie (Chart-Audit 2, 25.07.): einmalig ~5 Jahre Tages-Bars
      // als EIN Doc je Jahr (ohlcDaily/{JAHR}) — nahtloses Rausscrollen im
      // Chart bei ~1 Read je Jahr. Additiv + idempotent (Versions-Marker);
      // die bars-Collection (rollierendes Jahr) bleibt unangetastet.
      if (symDoc.get('deepBackfillV') !== 1) {
        try {
          const deep = await getDeepDailyBars(symbol);
          for (const [year, days] of chunkBarsByYear(deep)) {
            batch.set(
              symRef.collection('ohlcDaily').doc(year),
              { days, updatedAt: now.toISOString() },
              { merge: true },
            );
          }
          batch.set(symRef, { deepBackfillV: 1, deepBackfilledAt: now.toISOString() }, { merge: true });
        } catch (e) {
          logger.warn(`deepBackfill ${symbol}`, e); // nächster Scan versucht es erneut
        }
      }

      // Intraday (5m): Yahoo liefert ~5 Handelstage. Erst-Backfill alle Tage,
      // danach nur der jüngste Tag (1 Chunk-Doc je ET-Tag, idempotent).
      try {
        const intraday = await getIntradayBars(symbol);
        const days = [...intraday.keys()].sort();
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
            sentimentOverall,
            marketOpenForClass(classify(symbol), now),
          );
          batch.set(
            symRef,
            {
              forecastIntraday: ifc
                ? {
                    points: ifc.points,
                    band: ifc.band,
                    w: ifc.w,
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
  let lastError: string | null = null;
  try {
    trades = await executeUserTrades(marketData);
  } catch (err) {
    lastError = `trades: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.error('Trade-Block fehlgeschlagen', err);
  }

  // Katalog-Versorgung (alle Marktgruppen, rotierender Chunk) — geguarded,
  // damit ein Yahoo-/Firestore-Schluckauf nie den Kern-Scan gefährdet.
  let catalogQuotes = 0;
  try {
    catalogQuotes = await supplyCatalog(new Set(scanned), now);
  } catch (err) {
    lastError = lastError ?? `catalog: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.warn('Katalog-Versorgung fehlgeschlagen', err);
  }

  // Intraday-Prognosen bewerten (Prognose 2.0 Teil 2): Kurzfrist-Horizonte
  // realisieren binnen einer Stunde — huckepack im Scan statt täglich 16:30.
  let intradayScored = 0;
  try {
    intradayScored = (await evaluateIntradayDue()).scored;
  } catch (err) {
    lastError = lastError ?? `evalIntraday: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.warn('Intraday-Eval fehlgeschlagen', err);
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
        intradayOk,
        intradayError,
        intradayScored,
        trades,
        catalogQuotes,
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
    secrets: [anthropicApiKey],
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
