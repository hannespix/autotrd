/**
 * savePrediction (Chart-Vision): speichert/entfernt die gezeichnete
 * User-Prognose je Symbol — users/{uid}/predictions/{symbol}, Client-Write
 * per Rules verboten (die Prognose steuert Trades → server-validiert).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { allSymbols, type UserPrediction } from '../../../shared/src/index.js';
import { consumeQuota } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_LIMIT = 100;
const MAX_HORIZON_DAYS = 60;

export const savePrediction = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'prediction', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Tageslimit von ${DAILY_LIMIT} Prognosen erreicht`);
  }

  const data = (request.data ?? {}) as {
    symbol?: unknown;
    targetPrice?: unknown;
    targetDate?: unknown;
    confidence?: unknown;
    basePrice?: unknown;
    clear?: unknown;
  };
  if (typeof data.symbol !== 'string' || !new Set(allSymbols()).has(data.symbol)) {
    throw new HttpsError('invalid-argument', 'Unbekanntes Symbol');
  }
  const ref = getFirestore().doc(`users/${uid}/predictions/${data.symbol}`);

  if (data.clear === true) {
    await ref.delete();
    return { ok: true, cleared: true };
  }

  const targetPrice = Number(data.targetPrice);
  const basePrice = Number(data.basePrice);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(basePrice) || basePrice <= 0) {
    throw new HttpsError('invalid-argument', 'targetPrice/basePrice müssen positive Zahlen sein');
  }
  if (typeof data.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.targetDate)) {
    throw new HttpsError('invalid-argument', "targetDate muss 'YYYY-MM-DD' sein");
  }
  const today = new Date().toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + MAX_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (data.targetDate <= today || data.targetDate > maxDate) {
    throw new HttpsError('invalid-argument', `targetDate muss zwischen morgen und +${MAX_HORIZON_DAYS} Tagen liegen`);
  }
  const confidence = Number(data.confidence);
  if (![1, 2, 3].includes(confidence)) {
    throw new HttpsError('invalid-argument', 'confidence muss 1, 2 oder 3 sein');
  }

  const doc: UserPrediction = {
    symbol: data.symbol,
    targetPrice,
    targetDate: data.targetDate,
    confidence: confidence as 1 | 2 | 3,
    basePrice,
    baseDate: today,
    createdAt: new Date().toISOString(),
  };
  await ref.set(doc);
  return { ok: true };
});
