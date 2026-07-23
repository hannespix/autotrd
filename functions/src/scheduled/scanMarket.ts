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
  resolveName,
} from '../../../shared/src/index.js';
import { computeSignal } from '../core/engine.js';
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
  skipped?: string;
}

/** Ein kompletter Scan-Zyklus über die zentrale Watchlist. */
export async function runScan(force = false): Promise<ScanResult> {
  const now = new Date();
  const scanId = now.toISOString().slice(0, 16) + 'Z'; // Minute = idempotent
  if (!force && !isUsMarketOpen(now)) {
    logger.info(`Markt geschlossen — Scan übersprungen (${scanId})`);
    return { scanId, scanned: [], errors: {}, skipped: 'market_closed' };
  }

  await seedUniverse();
  const db = getFirestore();
  const symbols = DEFAULT_STRATEGY.watchlist;
  const scanned: string[] = [];
  const errors: Record<string, string> = {};

  for (const symbol of symbols) {
    try {
      const snap = await getMarketSnapshot(symbol, DEFAULT_STRATEGY.signals.period);
      const closes = snap.bars.map((b) => b.close);
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

      // Indikator-Snapshot des letzten Handelstags (1 Doc/Tag, überschreibend)
      const lastDate = snap.bars[snap.bars.length - 1]!.date;
      batch.set(symRef.collection('indicators').doc(lastDate), { ...sig.snapshot });

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

  logger.info(`Scan ${scanId}: ${scanned.length}/${symbols.length} Symbole ok`);
  return { scanId, scanned, errors };
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
