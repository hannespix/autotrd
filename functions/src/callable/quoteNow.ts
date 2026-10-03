/**
 * quoteNow (Chart-Audit 2, 25.07.): kürzest mögliche Update-Intervalle für
 * das AKTIVE Symbol — der Client fragt alle ~45 s nach, der frische Kurs
 * landet im geteilten market/{sym}.quote (alle Clients profitieren via
 * onSnapshot). Bewusst leichtgewichtig: EIN Yahoo-Quote-Fetch, Quota-Deckel
 * je User; die volle Daten-Kadenz bleibt beim 5-min-Scan (bis der
 * M13-Streamer echte Sekunden-Ticks bringt).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { allSymbols } from '../../../shared/src/index.js';
import { consumeQuota } from '../core/broker.js';
import { getQuickQuote } from '../core/marketData.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_LIMIT = 800; // ~10 h aktive Chart-Zeit bei 45-s-Takt

export const quoteNow = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');
  if (!(await consumeQuota(uid, 'quoteNow', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', 'srv.tageslimitKurzUpdates');
  }
  const symbol = (request.data as { symbol?: unknown })?.symbol;
  if (typeof symbol !== 'string' || !new Set(allSymbols()).has(symbol)) {
    throw new HttpsError('invalid-argument', 'srv.unbekanntesSymbol');
  }
  const q = await getQuickQuote(symbol);
  await getFirestore()
    .doc(`market/${symbol}`)
    .set(
      { quote: { price: q.price, changePct: q.changePct, updatedAt: new Date().toISOString() } },
      { merge: true },
    );
  return q;
});
