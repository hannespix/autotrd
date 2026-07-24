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
  buildRuleContext,
  clampStrategyRisk,
  cooldownActive,
  decideTree,
  minuteOfDayEt,
} from '../core/rulesTrading.js';
import { runForecast, type LiveForecast } from '../core/forecaster.js';
import { getMarketSnapshot } from '../core/marketData.js';
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
      const stratSnap = await userDoc.ref
        .collection('strategies')
        .where('status', '==', 'published')
        .get();
      const published = stratSnap.docs
        .map((d) => ({ ref: d.ref, doc: d.data() as StrategyDoc & { lastTrades?: Record<string, string> } }))
        .filter((s) => s.doc.compiled && (s.doc.symbols ?? []).length > 0);
      const strategyOwned = new Set(published.flatMap((s) => s.doc.symbols));
      const clamped = clampStrategyRisk(strategy); // Risiko-Hülle: nie überschreibbar
      const now = new Date();
      const minuteEt = minuteOfDayEt(now);

      for (const { ref, doc } of published) {
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
        if (sig.direction === 'buy' && !positions.has(symbol)) {
          const r = await executePaperTrade(
            { uid, symbol, side: 'buy', price: data.price, source: 'engine' },
            strategy,
          );
          if (r.executed) {
            executed += 1;
            logger.info(`Engine-Buy ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (sig.direction === 'sell' && positions.has(symbol)) {
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
        DEFAULT_STRATEGY.signals,
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
              }
            : null,
        },
        { merge: true },
      );

      // Bars: Erst-Backfill komplett, danach nur der letzte Bar
      const barsToWrite = symDoc.get('barsBackfilledAt')
        ? snap.bars.slice(-1)
        : snap.bars;
      for (const bar of barsToWrite) {
        batch.set(symRef.collection('bars').doc(bar.date), {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        });
      }
      if (!symDoc.get('barsBackfilledAt')) {
        batch.set(symRef, { barsBackfilledAt: now.toISOString() }, { merge: true });
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
      });

      await batch.commit();
      scanned.push(symbol);
    } catch (err) {
      errors[symbol] = err instanceof Error ? err.message : String(err);
      logger.error(`Scan-Fehler ${symbol}`, err);
    }
  }

  // Auto-Trades pro User (1 Marktdaten-Fetch oben, N Auswertungen hier)
  const trades = await executeUserTrades(marketData);

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
        trades,
      },
      { merge: true },
    )
    .catch((err) => logger.warn('Heartbeat-Write fehlgeschlagen', err));

  logger.info(`Scan ${scanId}: ${scanned.length}/${symbols.length} Symbole ok, ${trades} Trade(s)`);
  return { scanId, scanned, errors, trades };
}

/** Alle 5 Minuten; der Gate macht außerhalb der Marktzeiten einen No-Op. */
export const scanMarket = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/New_York',
    retryCount: 0,
    secrets: [anthropicApiKey],
  },
  async () => {
    await runScan(false);
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
