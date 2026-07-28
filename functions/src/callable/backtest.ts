/**
 * runBacktest (M11): backtestet eine Strategie über die gecachten Tages-Bars
 * eines Symbols und schreibt den Report nach
 * users/{uid}/strategies/{id}/runs/{runId} (read-only für den Client).
 *
 * Bewusste Abweichung von „Backtest-on-Save": per Button statt automatisch —
 * Kosten-Kontrolle über eine harte Tages-Quota; runId = ISO-Minute macht
 * Doppel-Klicks idempotent.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { allSymbols, type StrategyDoc, type StrategySpec } from '../../../shared/src/index.js';
import { backtestSpec, type BacktestBar } from '../core/backtest.js';
import { consumeQuota } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_LIMIT = 10;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const runBacktest = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'backtest', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Tageslimit von ${DAILY_LIMIT} Backtests erreicht`);
  }

  const { strategyId, symbol } = (request.data ?? {}) as { strategyId?: unknown; symbol?: unknown };
  if (typeof strategyId !== 'string' || !ID_RE.test(strategyId)) {
    throw new HttpsError('invalid-argument', 'Ungültige Strategie-ID');
  }
  if (typeof symbol !== 'string' || !new Set(allSymbols()).has(symbol)) {
    throw new HttpsError('invalid-argument', 'Unbekanntes Symbol');
  }

  const db = getFirestore();
  const stratRef = db.doc(`users/${uid}/strategies/${strategyId}`);
  const stratSnap = await stratRef.get();
  if (!stratSnap.exists) throw new HttpsError('not-found', 'Strategie existiert nicht');
  const doc = stratSnap.data() as StrategyDoc;
  const specSource: 'compiled' | 'draft' = doc.compiled ? 'compiled' : 'draft';
  const spec: StrategySpec = doc.compiled ?? doc.draft;

  const barsSnap = await db.collection(`market/${symbol}/bars`).get();
  const bars: BacktestBar[] = barsSnap.docs
    .map((d) => ({ date: d.id, close: (d.data() as { close: number }).close }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (bars.length < 40) {
    throw new HttpsError('failed-precondition', 'Zu wenig Kurs-Historie im Cache — Symbol erst scannen lassen');
  }

  const result = backtestSpec(spec, bars, {});
  const now = new Date();
  const runId = now.toISOString().slice(0, 16) + 'Z';
  await stratRef.collection('runs').doc(runId).set({
    ...result,
    symbol,
    specSource,
    barsFrom: bars[0]!.date,
    barsTo: bars[bars.length - 1]!.date,
    at: now.toISOString(),
  });
  return { ok: true, runId, totalReturnPct: result.totalReturnPct, numTrades: result.numTrades };
});
