/**
 * runSweep (M11): Parameter-Sweep über die Classic-Strategie des Users —
 * ≤ 2 Achsen, ≤ 60 Kombis. Die Tages-Historie des Symbols wird EINMAL
 * geladen; jede Kombi kompiliert die geklonte Strategie (compileClassic)
 * und backtestet im RAM (backtestSpec, Lookahead-fest). Ergebnis geht als
 * Antwort zurück (bewusst kein Firestore-Write und KEIN Auto-Apply — der
 * beste Punkt wird im Studio nur als Entwurf übernommen).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  DEFAULT_STRATEGY,
  allSymbols,
  compileClassic,
  isStrategy,
  type Strategy,
} from '../../../shared/src/index.js';
import { backtestSpec, type BacktestBar } from '../core/backtest.js';
import { applySweepPoint, buildSweepPlan } from '../core/sweep.js';
import { consumeQuota } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_LIMIT = 5; // je Sweep bis zu 60 Backtests — hart deckeln

export const runSweep = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'sweep', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Tageslimit von ${DAILY_LIMIT} Sweeps erreicht`);
  }

  const data = (request.data ?? {}) as {
    symbol?: unknown;
    xParam?: unknown;
    xValues?: unknown;
    yParam?: unknown;
    yValues?: unknown;
  };
  if (typeof data.symbol !== 'string' || !new Set(allSymbols()).has(data.symbol)) {
    throw new HttpsError('invalid-argument', 'Unbekanntes Symbol');
  }
  if (typeof data.xParam !== 'string' || !Array.isArray(data.xValues)) {
    throw new HttpsError('invalid-argument', 'X-Achse fehlt');
  }
  const hasY = data.yParam !== undefined;
  if (hasY && (typeof data.yParam !== 'string' || !Array.isArray(data.yValues))) {
    throw new HttpsError('invalid-argument', 'Y-Achse unvollständig');
  }

  let plan;
  try {
    plan = buildSweepPlan(
      data.xParam,
      data.xValues as number[],
      hasY ? (data.yParam as string) : undefined,
      hasY ? (data.yValues as number[]) : undefined,
    );
  } catch (e) {
    throw new HttpsError('invalid-argument', (e as Error).message);
  }

  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const stored = userSnap.get('settings.strategy') as unknown;
  const base: Strategy = isStrategy(stored) ? stored : DEFAULT_STRATEGY;

  const barsSnap = await db.collection(`market/${data.symbol}/bars`).get();
  const bars: BacktestBar[] = barsSnap.docs
    .map((d) => ({ date: d.id, close: (d.data() as { close: number }).close }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (bars.length < 40) {
    throw new HttpsError('failed-precondition', 'Zu wenig Kurs-Historie im Cache — Symbol erst scannen lassen');
  }

  const rows = plan.map((pt) => {
    const variant = applySweepPoint(base, data.xParam as string, pt.x, hasY ? (data.yParam as string) : undefined, pt.y);
    const r = backtestSpec(compileClassic(variant), bars);
    return {
      x: pt.x,
      y: pt.y,
      totalReturnPct: r.totalReturnPct,
      sharpe: r.sharpe,
      maxDrawdownPct: r.maxDrawdownPct,
      numTrades: r.numTrades,
      winRatePct: r.winRatePct,
    };
  });
  const best = rows.reduce((a, b) =>
    b.totalReturnPct > a.totalReturnPct || (b.totalReturnPct === a.totalReturnPct && b.sharpe > a.sharpe) ? b : a,
  );
  // Kompilierte Spec des Siegers mitgeben: „Als Entwurf übernehmen" nutzt
  // exakt die serverseitig getestete Variante (kein Client-Drift).
  const bestSpec = compileClassic(
    applySweepPoint(base, data.xParam, best.x, hasY ? (data.yParam as string) : undefined, best.y),
  );

  return {
    ok: true,
    rows,
    best,
    bestSpec,
    combos: rows.length,
    barsFrom: bars[0]!.date,
    barsTo: bars[bars.length - 1]!.date,
  };
});
