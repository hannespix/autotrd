/**
 * autotrd Cloud Functions — Einstiegspunkt.
 *
 * M1: nur `healthz` als Smoke-Function. Die eigentliche Logik (scanMarket,
 * evalForecasts, trade, …) kommt ab M2 nach src/scheduled|callable und
 * stützt sich auf src/core (siehe functions/README.md).
 */

import { onRequest } from 'firebase-functions/v2/https';
// Import aus shared beweist die Workspace-Verdrahtung (kompiliert mit nach lib/).
import { DEFAULT_STRATEGY } from '../../shared/src/index.js';

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
