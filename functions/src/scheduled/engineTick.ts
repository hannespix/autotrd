/**
 * engineTick — der minütliche Engine-Takt als Cloud Function.
 *
 * Kein Dauerprozess, kein WebSocket: Jede Minute ein Lauf über alle
 * freigeschalteten Nutzer mit deren (verschlüsselten) Alpaca-Schlüsseln,
 * State in Firestore, Champion aus Firestore. Die Logik steht in
 * `../engine/tick.ts` (testbar, Firestore/Alpaca injizierbar) — hier ist nur
 * die Verdrahtung mit dem Admin-SDK, den Secrets und dem Scheduler.
 *
 * Secrets: `BROKER_MASTER_KEY` (Entschlüsselung der Nutzer-Schlüssel,
 * `core/keyVault`), `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` (Plattform-Datenkey —
 * Bars, Kalender, Uhr; ein Paper-Key genügt). Ohne Datenkey laufen keine
 * Einstiege (Datenfrische), Exits über Schutz-Stops beim Broker bleiben.
 *
 * `maxInstances: 1` + Lease in `meta/engineLease`: Zwei Läufe auf einem
 * Konto wären zwei Bücher. `timeoutSeconds: 55` < Takt, `retryCount: 0`:
 * Ein verpasster Takt ist in 60 s ohnehin wieder da.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createAlpacaClient } from '../../../src/alpaca/rest.ts';
import type { AlpacaClient } from '../../../src/alpaca/types.ts';
import { setLogSink } from '../../../src/core/log.ts';
import type { AssetClass } from '../../../src/core/types.ts';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { brokerVerbindung, schluesselArt, type BrokerVerbindung } from '../core/brokerZugang.js';
import { fxFelder } from '../core/fx.js';
import { runEngineTick, type TickDeps, type TickResult } from '../engine/tick.js';

export const ENGINE_TICK_SCHEDULE = '* * * * *';

/**
 * Engine-Log (JSON-Zeilen, bereits geschwärzt) → Cloud Logging mit der
 * passenden Schwere. Ohne diese Senke landete alles als INFO-Text auf stdout,
 * und ein „Halt (errors)" wäre im Log-Explorer nicht von Rauschen zu trennen.
 */
setLogSink((line) => {
  try {
    const rec = JSON.parse(line) as { level?: string; msg?: string } & Record<string, unknown>;
    const severity = rec.level === 'error' ? 'ERROR' : rec.level === 'warn' ? 'WARNING' : rec.level === 'debug' ? 'DEBUG' : 'INFO';
    const { level: _level, msg, ...rest } = rec;
    logger.write({ severity, message: msg ?? line, ...rest });
  } catch {
    logger.info(line);
  }
});

let dataClientCache: { key: string; client: AlpacaClient } | null = null;

/** Plattform-Datenclient aus den Secrets; null ohne Key. Einmal je Instanz und (Feed, Assetklasse). */
export function plattformDatenclient(o: { feed: 'iex' | 'sip'; assetClass: AssetClass }): AlpacaClient | null {
  const keyId = process.env.ALPACA_API_KEY ?? '';
  const secret = process.env.ALPACA_SECRET_KEY ?? '';
  if (!keyId || !secret) return null;
  const key = `${o.feed}|${o.assetClass}|${keyId}`;
  if (dataClientCache && dataClientCache.key === key) return dataClientCache.client;
  // Endpunkt nach Schlüsselart: ein AK-Key gegen paper-api liefert 401. Der Client dient NUR Daten (Bars, Uhr, Kalender, Stammdaten).
  const client = createAlpacaClient({ mode: schluesselArt(keyId), keyId, secret, feed: o.feed, assetClass: o.assetClass });
  dataClientCache = { key, client };
  return client;
}

export function tickDeps(): TickDeps {
  return {
    db: getFirestore(),
    dataClientFor: plattformDatenclient,
    brokerVerbindung: (uid, now) => brokerVerbindung(uid, now),
    clientFor: (v: BrokerVerbindung, o) =>
      createAlpacaClient({ mode: v.mode, keyId: v.schluessel.keyId, secret: v.schluessel.secret, feed: o.feed, assetClass: o.assetClass }),
    fx: (iso, waehrung) => fxFelder(iso, waehrung),
  };
}

function summary(r: TickResult): string {
  if (r.skipped) return `Engine-Takt übersprungen (${r.skipped})`;
  return `Engine-Takt: ${r.ok}/${r.users} Nutzer ok, ${r.failed.length} Fehler, ${r.skippedUsers.length} übersprungen, Bars ${r.symbolsOk}/${r.symbolsOk + r.symbolsFailed}, ${r.durationMs} ms`;
}

export const engineTick = onSchedule(
  {
    schedule: ENGINE_TICK_SCHEDULE,
    timeZone: 'America/New_York',
    memory: '512MiB',
    timeoutSeconds: 55,
    retryCount: 0,
    maxInstances: 1,
    secrets: ['BROKER_MASTER_KEY', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
  },
  async () => {
    const r = await runEngineTick(tickDeps());
    if (r.failed.length > 0) logger.warn(summary(r), { failed: r.failed.length });
    else logger.info(summary(r));
  },
);

/** Emulator-only: `curl -X POST http://127.0.0.1:5001/<projekt>/us-central1/engineTickNow` */
export const engineTickNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'engineTickNow ist nur im Emulator verfügbar' });
    return;
  }
  const r = await runEngineTick(tickDeps());
  res.status(200).json(r);
});
