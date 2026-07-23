/**
 * evalForecasts — Self-Improvement-Loop (Port von forecast_eval.py).
 *
 * Täglich nach US-Börsenschluss: bewertet alle unbewerteten Prognosen, deren
 * LETZTER Horizont-Tag strikt vor heute liegt und dessen Close realisiert ist
 * (Lookahead-Gate in shared/forecast.ts — nie aufweichen), und schreibt die
 * globale Kombi-Statistik nach meta/forecastStats (Basis für best_params).
 */

import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  bestParams,
  comboKey,
  isForecastDue,
  scoreForecast,
  type ComboStat,
  type ForecastDoc,
} from '../../../shared/src/index.js';
import { getMarketSnapshot } from '../core/marketData.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

const BATCH_LIMIT = 200;

export interface EvalResult {
  scored: number;
  bestParams: { w: number; lookback: number };
}

/** Alle fälligen Prognosen bewerten; liefert Anzahl + neue best_params. */
export async function evaluateDue(): Promise<EvalResult> {
  const db = getFirestore();
  const today = new Date().toISOString().slice(0, 10);

  const pending = await db
    .collectionGroup('forecasts')
    .where('evaluated', '==', false)
    .limit(BATCH_LIMIT)
    .get();

  // Fällige nach Symbol gruppieren (Actuals einmal pro Symbol holen)
  const dueBySymbol = new Map<string, Array<{ ref: FirebaseFirestore.DocumentReference; doc: ForecastDoc }>>();
  for (const snap of pending.docs) {
    const doc = snap.data() as ForecastDoc;
    if (!isForecastDue(doc.points, today)) continue;
    const symbol = snap.ref.parent.parent?.id;
    if (!symbol) continue;
    const list = dueBySymbol.get(symbol) ?? [];
    list.push({ ref: snap.ref, doc });
    dueBySymbol.set(symbol, list);
  }

  let scored = 0;
  const comboDelta = new Map<string, ComboStat>();

  for (const [symbol, entries] of dueBySymbol) {
    let actuals: Record<string, number>;
    try {
      const snap = await getMarketSnapshot(symbol, '6mo');
      actuals = Object.fromEntries(snap.bars.map((b) => [b.date, b.close]));
    } catch (err) {
      logger.warn(`evalForecasts: keine Actuals für ${symbol}`, err);
      continue;
    }

    const batch = db.batch();
    for (const { ref, doc } of entries) {
      const score = scoreForecast(doc.points, doc.baseClose, actuals);
      if (!score) continue; // End-Tag (noch) nicht realisiert → später erneut
      batch.update(ref, {
        evaluated: true,
        evaluatedAt: new Date().toISOString(),
        maePct: score.maePct,
        dirHit: score.dirHit,
        nPoints: score.nPoints,
      });
      const key = comboKey(doc.w, doc.lookback);
      const d = comboDelta.get(key) ?? { n: 0, hits: 0, maeSum: 0 };
      d.n += 1;
      d.hits += score.dirHit ? 1 : 0;
      d.maeSum += score.maePct;
      comboDelta.set(key, d);
      scored += 1;
    }
    await batch.commit();
  }

  // Globale Kombi-Statistik inkrementell fortschreiben (nur realisierte Scores).
  // WICHTIG: Kombi-Schlüssel enthalten Punkte ("0.5_20") — als String-Pfad
  // würde Firestore daran verschachteln; FieldPath-Segmente sind literal.
  const statsRef = db.doc('meta/forecastStats');
  if (comboDelta.size > 0) {
    const args: unknown[] = [new FieldPath('updatedAt'), new Date().toISOString()];
    for (const [key, d] of comboDelta) {
      args.push(new FieldPath('combos', key, 'n'), FieldValue.increment(d.n));
      args.push(new FieldPath('combos', key, 'hits'), FieldValue.increment(d.hits));
      args.push(new FieldPath('combos', key, 'maeSum'), FieldValue.increment(d.maeSum));
    }
    await statsRef.set({}, { merge: true });
    await statsRef.update(
      args[0] as FieldPath,
      args[1],
      ...(args.slice(2) as unknown[]),
    );
  }

  const combos =
    ((await statsRef.get()).get('combos') as Record<string, ComboStat> | undefined) ?? {};
  const bp = bestParams(combos);
  const total = Object.values(combos).reduce((s, d) => s + d.n, 0);
  const hits = Object.values(combos).reduce((s, d) => s + d.hits, 0);
  await statsRef.set(
    {
      best: bp,
      scored: total,
      dirAccuracy: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
      tuningActive: total >= 20,
    },
    { merge: true },
  );

  logger.info(`evalForecasts: ${scored} bewertet, best_params w=${bp.w} lb=${bp.lookback}`);
  return { scored, bestParams: bp };
}

/** Täglich 16:30 ET (nach US-Schluss), Mo–Fr. */
export const evalForecasts = onSchedule(
  { schedule: '30 16 * * 1-5', timeZone: 'America/New_York', retryCount: 0 },
  async () => {
    await evaluateDue();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const evalNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'evalNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await evaluateDue());
});
