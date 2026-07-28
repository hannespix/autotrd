/**
 * snapshotEquity — täglicher Equity-Snapshot + Kennzahlen (M12 Teil 1).
 *
 * Läuft täglich nach US-Börsenschluss (auch am Wochenende — Krypto handelt
 * durch) und schreibt je User:
 *   - users/{uid}/equity/{YYYY-MM-DD}: Equity (Cash + bewertete Positionen,
 *     Shorts gespiegelt), idempotent per Datums-Doc-ID — ein Rerun am selben
 *     Tag überschreibt statt doppelt zu zählen.
 *   - users/{uid}/stats/main: Sharpe 30/90, HWM/MaxDD, WinRate, ProfitFactor,
 *     Expectancy, Attribution je Symbol/Asset-Klasse — das Dashboard liest
 *     später GENAU EIN Doc statt die Trade-Historie zu aggregieren.
 *
 * `walletId: 'main'` ist der Vorgriff auf die M12-Multi-Wallet-Migration:
 * heute gibt es genau ein Paper-Wallet je User; nach der Migration hängt
 * dieselbe Logik je Wallet-Doc.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  aggregateTradingHealth,
  attribution,
  classify,
  costProfile,
  exitBreakdown,
  dailyReturns,
  drawdown,
  positionValue,
  sharpe,
  tradeStats,
  tradingVerdict,
  type AccountContribution,
  type ClosedTrade,
  type EquityPoint,
  type Position,
} from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** ~ein halbes Handelsjahr Serie — reicht für Sharpe 90 + MaxDD-Fenster. */
const EQUITY_WINDOW = 120;
/** Jüngste Trades für WinRate/Attribution (geschlossene werden rausgefiltert). */
const TRADES_WINDOW = 500;

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface SnapshotResult {
  users: number;
  snapped: number;
}

/** Snapshot + Kennzahlen für alle User; Fehler je User isoliert (ein kaputtes Konto stoppt nicht den Rest). */
export async function snapshotAll(now = new Date()): Promise<SnapshotResult> {
  const db = getFirestore();
  const date = now.toISOString().slice(0, 10);
  const users = await db.collection('users').select('wallet').get();

  // Kurs-Cache: market/{sym}.quote.price einmal je Symbol lesen, nicht je User.
  const priceCache = new Map<string, number | null>();
  async function lastPrice(sym: string): Promise<number | null> {
    if (!priceCache.has(sym)) {
      try {
        const doc = await db.collection('market').doc(sym).get();
        const p = (doc.get('quote') as { price?: number } | undefined)?.price;
        priceCache.set(sym, typeof p === 'number' && p > 0 ? p : null);
      } catch {
        priceCache.set(sym, null);
      }
    }
    return priceCache.get(sym) ?? null;
  }

  let snapped = 0;
  const beitraege: AccountContribution[] = [];
  for (const userDoc of users.docs) {
    try {
      const balance = userDoc.get('wallet.paperBalance') as number | undefined;
      if (typeof balance !== 'number' || !Number.isFinite(balance)) continue; // kein Wallet → kein Snapshot

      const posSnap = await userDoc.ref.collection('positions').get();
      let positionsValue = 0;
      for (const d of posSnap.docs) {
        const pos = d.data() as Position;
        positionsValue += positionValue(pos, await lastPrice(pos.symbol ?? d.id));
      }
      positionsValue = r2(positionsValue);
      const equity = r2(balance + positionsValue);

      await userDoc.ref.collection('equity').doc(date).set({
        walletId: 'main',
        date,
        equity,
        balance: r2(balance),
        positionsValue,
        positionsCount: posSnap.size,
        updatedAt: now.toISOString(),
      });

      // Serie (jüngste EQUITY_WINDOW Snapshots, inkl. dem gerade geschriebenen)
      const serieSnap = await userDoc.ref
        .collection('equity')
        .orderBy('date', 'desc')
        .limit(EQUITY_WINDOW)
        .get();
      const serie: EquityPoint[] = serieSnap.docs
        .map((d) => ({ date: d.get('date') as string, equity: d.get('equity') as number }))
        .reverse();
      const returns = dailyReturns(serie);
      const dd = drawdown(serie);

      const tradesSnap = await userDoc.ref
        .collection('trades')
        .orderBy('at', 'desc')
        .limit(TRADES_WINDOW)
        .get();
      const closed: ClosedTrade[] = [];
      for (const t of tradesSnap.docs) {
        const pnl = t.get('pnl') as number | undefined;
        const symbol = t.get('symbol') as string | undefined;
        if (typeof pnl === 'number' && Number.isFinite(pnl) && symbol) {
          // qty × price ist der Positionswert beim Schließen — Basis der
          // Gebührenschätzung. Der Satz steht am Trade (feeRate), weil er
          // sich ändern kann; alte Trades ohne das Feld fallen aus dem
          // Kostenprofil heraus statt es mit Annahmen zu verfälschen.
          const qty = t.get('qty') as number | undefined;
          const price = t.get('price') as number | undefined;
          const feeRate = t.get('feeRate') as number | undefined;
          const riskExit = t.get('riskExit') as string | undefined;
          closed.push({
            symbol,
            pnl,
            assetClass: classify(symbol),
            ...(riskExit ? { riskExit } : {}),
            ...(typeof qty === 'number' && typeof price === 'number'
              ? { notional: qty * price }
              : {}),
            ...(typeof feeRate === 'number' ? { feeRate } : {}),
          });
        }
      }
      const ts = tradeStats(closed);
      const attr = attribution(closed);
      // MT1: Woran sterben die Trades, und wie viel davon frisst die Reibung?
      // Beides war bis 27.07. nirgends ablesbar und musste von Hand
      // zurückgerechnet werden.
      const exits = exitBreakdown(closed);
      const costs = costProfile(closed);

      await userDoc.ref.collection('stats').doc('main').set({
        walletId: 'main',
        equityDays: serie.length,
        sharpe30: sharpe(returns.slice(-30)),
        sharpe90: sharpe(returns.slice(-90)),
        hwm: dd.hwm,
        maxDDPct: dd.maxDDPct,
        currentDDPct: dd.currentDDPct,
        trades: ts.n,
        wins: ts.wins,
        winRatePct: ts.winRatePct,
        profitFactor: ts.profitFactor,
        expectancy: ts.expectancy,
        avgWin: ts.avgWin,
        avgLoss: ts.avgLoss,
        bySymbol: attr.bySymbol,
        byClass: attr.byClass,
        exits,
        costs,
        updatedAt: now.toISOString(),
      });
      // Beitrag zum öffentlichen Gesamtbild — die Kennzahlen fallen hier
      // ohnehin an. Was daraus veröffentlicht wird, entscheidet
      // `aggregateTradingHealth`: Quoten immer, Beträge erst ab genug Konten.
      beitraege.push({
        stats: {
          n: ts.n,
          wins: ts.wins,
          profitFactor: ts.profitFactor,
          expectancy: ts.expectancy,
          avgWin: ts.avgWin,
          avgLoss: ts.avgLoss,
        },
        exits,
        costs: { n: costs.n, fees: costs.fees, grossPnl: costs.grossPnl },
      });

      snapped += 1;
    } catch (err) {
      logger.warn(`snapshotEquity: User ${userDoc.id} übersprungen`, err);
    }
  }

  // ── Handelsqualität öffentlich machen (Owner-Frage 28.07.) ────────────────
  // Bis hierher trug `meta/health` nur BETRIEBS-Zahlen: gescannt, gescheitert,
  // Anzahl Trades. Damit sieht man, ob die Maschine läuft — nicht, ob sie
  // etwas taugt. Die Diagnose „sterben alle Trades am Signal?" stand
  // ausschließlich in `users/{uid}/stats/main` und war von außen unsichtbar;
  // am 27.07. musste ein Mensch sie mit dem Taschenrechner zurückrechnen.
  const health = aggregateTradingHealth(beitraege);
  await db.doc('meta/health').set(
    {
      equitySnapshot: { at: now.toISOString(), date, users: users.size, snapped },
      trading: { ...health, verdict: tradingVerdict(health), at: now.toISOString() },
    },
    { merge: true },
  );
  logger.info(`snapshotEquity: ${snapped}/${users.size} User gesnapshottet (${date})`);
  return { users: users.size, snapped };
}

/** Täglich 17:15 ET (nach US-Schluss); 7 Tage — Krypto bewegt Equity auch am Wochenende. */
export const snapshotEquity = onSchedule(
  {
    schedule: '15 17 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    // Der Lauf liest je User Positionen + Trades und je Symbol den Kurs; der
    // 60-s-Default würde mit wachsender Nutzerzahl irgendwann mitten in der
    // Schleife abbrechen — und ein halb geschriebener Snapshot-Tag verzerrt
    // Sharpe und Drawdown dauerhaft, weil die Serie eine Lücke bekäme.
    timeoutSeconds: 180,
  },
  async () => {
    await snapshotAll();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const snapshotNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'snapshotNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await snapshotAll());
});
