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
  resolveName,
  type Position,
  type Strategy,
} from '../../../shared/src/index.js';
import { computeSignal } from '../core/engine.js';
import { executePaperTrade, resolveBrokerMode, riskExitReason } from '../core/broker.js';
import { getMarketSnapshot } from '../core/marketData.js';

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

      // 2) Konfluenz-Signale gegen die User-Strategie
      for (const symbol of strategy.watchlist) {
        const data = marketData.get(symbol);
        if (!data) continue;
        const sig = computeSignal(data.closes, data.price, strategy.indicators, strategy.signals);
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
  if (!force && !isUsMarketOpen(now)) {
    logger.info(`Markt geschlossen — Scan übersprungen (${scanId})`);
    return { scanId, scanned: [], errors: {}, trades: 0, skipped: 'market_closed' };
  }

  await seedUniverse();
  const db = getFirestore();
  const symbols = await collectScanSymbols();
  const scanned: string[] = [];
  const errors: Record<string, string> = {};
  const marketData = new Map<string, SymbolData>();

  for (const symbol of symbols) {
    try {
      const snap = await getMarketSnapshot(symbol, DEFAULT_STRATEGY.signals.period);
      const closes = snap.bars.map((b) => b.close);
      marketData.set(symbol, { closes, price: snap.price });
      const sig = computeSignal(
        closes,
        snap.price,
        DEFAULT_STRATEGY.indicators,
        DEFAULT_STRATEGY.signals,
      );

      const symRef = db.collection('market').doc(symbol);
      const symDoc = await symRef.get();
      const batch = db.batch();

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
      const lastDate = snap.bars[snap.bars.length - 1]!.date;
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

  logger.info(`Scan ${scanId}: ${scanned.length}/${symbols.length} Symbole ok, ${trades} Trade(s)`);
  return { scanId, scanned, errors, trades };
}

/** Alle 5 Minuten; der Gate macht außerhalb der Marktzeiten einen No-Op. */
export const scanMarket = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'America/New_York', retryCount: 0 },
  async () => {
    await runScan(false);
  },
);

/**
 * Manueller Trigger — NUR im Emulator (lokale Verifikation, MILESTONES M2
 * Abnahme). In Produktion hart 403, damit niemand Scan-Kosten erzeugen kann.
 */
export const scanNow = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'scanNow ist nur im Emulator verfügbar' });
    return;
  }
  const force = req.query.force === '1';
  const result = await runScan(force);
  res.status(200).json(result);
});
