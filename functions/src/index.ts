/**
 * autotrd Cloud Functions — Einstiegspunkt.
 *
 * Nach dem Rückbau der alten Handelsplattform bleiben hier: Nutzer und
 * Zugang (`ensureProfile`, `adminUsers`, `nachricht`), Broker-Schlüssel und
 * Live-Schalter (`connectBroker`, `brokerStatus`, `setLiveMode`), Buch-Reset,
 * Steuer/FX (`taxReport`, `fxNachtragen`), Equity-Snapshot, Wächter und
 * `healthz`. Der Handel selbst läuft im Engine-Takt (`scheduled/engineTick`,
 * Kern unter `../src`) — dessen Exporte trägt der Integrator hier ein.
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { bewerteHerzschlag, DEFAULT_STRATEGY } from '../../shared/src/index.js';

initializeApp();

// invoker explizit public: sonst bleibt eine einmal privat angelegte
// Function bei Updates für immer privat (403 ohne CORS-Header im Browser)

export { logo } from './http/logo.js';
export { snapshotEquity, snapshotNow } from './scheduled/snapshotEquity.js';
export { wachhund, wachhundNow } from './scheduled/wachhund.js';
export { ensureProfile } from './callable/profile.js';
export { nachricht } from './callable/nachricht.js';
export { saveStrategy } from './callable/strategy.js';
export { resetWallet } from './callable/reset.js';
export { taxReport } from './callable/taxReport.js';
export { fxNachtragen } from './callable/fxBackfill.js';
export { brokerStatus } from './callable/brokerStatus.js';
export { connectBroker } from './callable/connectBroker.js';
export { setLiveMode } from './callable/setLiveMode.js';
export { adminUsers } from './callable/admin.js';

/**
 * healthz — der EXTERN prüfbare Totmann-Endpunkt (Audit 13.08., K-4a).
 *
 * Bis zum 13.08. antwortete er statisch `ok: true` und bewies damit nur,
 * dass die Function deployt ist — der empfohlene Uptime-Check (SETUP.md §J)
 * hätte einen wochenlang toten Scheduler nie bemerkt, und genau das ist
 * historisch passiert. Jetzt bewertet er bei jedem Aufruf den echten
 * Herzschlag in `meta/health` (`lastRunAt`, geschrieben vom Engine-Takt)
 * und antwortet 503, wenn er steht: Der externe Prüfer schlägt damit auch
 * dann an, wenn der komplette Cloud Scheduler tot ist — die einzige der
 * drei Wächter-Schichten, die dann noch lebt.
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
export { engineTick, engineTickNow } from './scheduled/engineTick.js';
export { engineCommand } from './callable/engineCommand.js';
