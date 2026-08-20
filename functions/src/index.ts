/**
 * autotrd Cloud Functions — Einstiegspunkt.
 *
 * M1: `healthz` (Smoke). M2: `scanMarket` (zentrale Marktdaten alle 5 min)
 * + `scanNow` (Emulator-only-Trigger für die lokale Abnahme).
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { bewerteHerzschlag, DEFAULT_STRATEGY } from '../../shared/src/index.js';

initializeApp();

// invoker explizit public: sonst bleibt eine einmal privat angelegte
// Function bei Updates für immer privat (403 ohne CORS-Header im Browser)

export { scanMarket, scanNow } from './scheduled/scanMarket.js';
export { logo } from './http/logo.js';
export { evalForecasts, evalNow } from './scheduled/evalForecasts.js';
export { snapshotEquity, snapshotNow } from './scheduled/snapshotEquity.js';
export { autoTune, tuneNow } from './scheduled/autoTune.js';
export { strukturSuche, strukturNow } from './scheduled/strukturSuche.js';
export { momentumRun, momentumNow } from './scheduled/momentumRun.js';
export { universumSync, universumSyncNow } from './scheduled/universumSync.js';
export { tagRueckblick, tagRueckblickNow } from './scheduled/tagRueckblick.js';
export { riskPulse, pulseNow } from './scheduled/riskPulse.js';
export { wachhund, wachhundNow } from './scheduled/wachhund.js';
export { kiBericht, kiBerichtNow } from './scheduled/kiBericht.js';
export { ensureProfile } from './callable/profile.js';
export { saveStrategy } from './callable/strategy.js';
export { resetBreaker } from './callable/resetBreaker.js';
export { quoteNow } from './callable/quoteNow.js';
export { savePrediction } from './callable/prediction.js';
export { trade } from './callable/trade.js';
export { resetWallet } from './callable/reset.js';
export { taxReport } from './callable/taxReport.js';
export { fxNachtragen } from './callable/fxBackfill.js';
export { brokerStatus } from './callable/brokerStatus.js';
export { connectBroker } from './callable/connectBroker.js';
export { adoptBroker } from './callable/adoptBroker.js';
export { setLiveMode } from './callable/setLiveMode.js';
export { adminUsers } from './callable/admin.js';

/**
 * healthz — der EXTERN prüfbare Totmann-Endpunkt (Audit 13.08., K-4a).
 *
 * Bis zum 13.08. antwortete er statisch `ok: true` und bewies damit nur,
 * dass die Function deployt ist — der empfohlene Uptime-Check (SETUP.md §J)
 * hätte einen wochenlang toten Scheduler nie bemerkt, und genau das ist
 * historisch passiert. Jetzt bewertet er bei jedem Aufruf den echten
 * Scan-Herzschlag und antwortet 503, wenn er steht: Der externe Prüfer
 * schlägt damit auch dann an, wenn der komplette Cloud Scheduler tot ist —
 * die einzige der drei Wächter-Schichten, die dann noch lebt.
 *
 * Fail-closed: Ist `meta/health` nicht lesbar, ist das KEIN „ok" — ein
 * Wächter, der bei kaputter Messleitung grün zeigt, ist gefährlicher als
 * gar keiner.
 */
export const healthz = onRequest({ cors: true, invoker: 'public' }, async (_req, res) => {
  const now = new Date();
  const basis = {
    service: 'autotrd-functions',
    now: now.toISOString(),
    shared: { schema: 'flach', defaultWatchlist: DEFAULT_STRATEGY.watchlist.length },
  };
  try {
    const health = await getFirestore().doc('meta/health').get();
    const urteil = bewerteHerzschlag({
      jetztMs: now.getTime(),
      lastRunAt: health.get('lastRunAt') as string | undefined,
      lastRunSkipped: health.get('lastRunSkipped') as string | null | undefined,
      symbolsOk: health.get('symbolsOk') as number | undefined,
      symbolsFailed: health.get('symbolsFailed') as number | undefined,
    });
    res.status(urteil.ok ? 200 : 503).json({
      ok: urteil.ok,
      ...basis,
      herzschlag: urteil,
    });
  } catch {
    res.status(503).json({
      ok: false,
      ...basis,
      herzschlag: { ok: false, grund: 'health_nicht_lesbar', text: 'meta/health nicht lesbar.' },
    });
  }
});
