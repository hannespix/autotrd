/**
 * autotrd Cloud Functions — Einstiegspunkt.
 *
 * M1: `healthz` (Smoke). M2: `scanMarket` (zentrale Marktdaten alle 5 min)
 * + `scanNow` (Emulator-only-Trigger für die lokale Abnahme).
 */

import { initializeApp } from 'firebase-admin/app';
import { onRequest } from 'firebase-functions/v2/https';
import { DEFAULT_STRATEGY } from '../../shared/src/index.js';

initializeApp();

export { scanMarket, scanNow } from './scheduled/scanMarket.js';
export { evalForecasts, evalNow } from './scheduled/evalForecasts.js';
export { tunerReview, tunerNow } from './scheduled/tunerReview.js';
export { ensureProfile } from './callable/profile.js';
export { saveStrategy } from './callable/strategy.js';
export { trade } from './callable/trade.js';

export const healthz = onRequest({ cors: true }, (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'autotrd-functions',
    now: new Date().toISOString(),
    shared: {
      schema: 'flach',
      defaultWatchlist: DEFAULT_STRATEGY.watchlist.length,
    },
  });
});
