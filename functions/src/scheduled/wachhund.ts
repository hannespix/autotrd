/**
 * wachhund — der Totmann-Wächter (Audit 13.08., K-4a).
 *
 * Prüft alle 10 Minuten, ob der Scan-Herzschlag (`meta/health.lastRunAt`)
 * noch schlägt und ob die Kursquelle liefert, und schreibt das Urteil nach
 * `meta/health.alarm`. Bei aktivem Alarm schreibt er in JEDEM Tick ein
 * `logger.error` — darauf lässt sich in Cloud Logging ein Log-basierter
 * Alert legen, ohne dass weitere Infrastruktur nötig ist.
 *
 * ── Die ehrliche Grenze dieser Konstruktion ───────────────────────────────
 *
 * Der Wächter läuft selbst im Cloud Scheduler. Stirbt der KOMPLETTE
 * Scheduler (der historische Fall), stirbt er mit. Deshalb ist er nur die
 * zweite von drei Schichten:
 *   1. `healthz` (HTTP) bewertet denselben Herzschlag bei jedem Aufruf und
 *      antwortet 503 — der EXTERNE Uptime-Check (SETUP.md §J) schlägt damit
 *      auch dann an, wenn hier nichts mehr läuft.
 *   2. Dieser Wächter (Log-Alert + `meta/health.alarm`).
 *   3. Das Dashboard rechnet das Urteil clientseitig aus `lastRunAt` —
 *      sichtbar für jeden, der die Seite offen hat.
 *
 * Bewusst KEIN eigenes Scheduler-Intervall unter 10 Minuten: Der Wächter
 * muss nur schneller sein als ein Mensch, nicht schneller als der Scan.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  bewerteHerzschlag,
  naechsterAlarm,
  type AlarmZustand,
  type HerzschlagUrteil,
} from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Ein Wächter-Durchlauf — pur genug, um ihn im Emulator direkt zu treiben. */
export async function wachhundLauf(now = new Date()): Promise<{
  urteil: HerzschlagUrteil;
  alarm: AlarmZustand;
}> {
  const db = getFirestore();
  const health = await db.doc('meta/health').get();

  const urteil = bewerteHerzschlag({
    jetztMs: now.getTime(),
    lastRunAt: health.get('lastRunAt') as string | undefined,
    lastRunSkipped: health.get('lastRunSkipped') as string | null | undefined,
    symbolsOk: health.get('symbolsOk') as number | undefined,
    symbolsFailed: health.get('symbolsFailed') as number | undefined,
  });

  const vorher = health.get('alarm') as AlarmZustand | undefined;
  const alarm = naechsterAlarm(vorher, urteil, now.toISOString());

  // `merge: true`, damit der Wächter NIE den Heartbeat überschreibt, den er
  // bewacht — ein Wächter, der sein eigenes Messobjekt anfasst, taugt nichts.
  await db.doc('meta/health').set({ alarm }, { merge: true });

  if (alarm.aktiv) {
    // error, nicht warn: Genau auf diese Zeile gehört der Log-Alert. Jeder
    // Tick wiederholt sie, solange der Zustand anhält — ein einmaliger
    // Eintrag um 03:12 Uhr weckt niemanden um 08:00.
    logger.error(`WACHHUND: ${alarm.text} (seit ${alarm.seit ?? '?'})`);
  } else if (vorher?.aktiv) {
    logger.info(`WACHHUND: Entwarnung — ${alarm.text} (Alarm lief seit ${vorher.seit ?? '?'})`);
  }

  return { urteil, alarm };
}

/** Alle 10 Minuten; ohne Retry — der nächste Tick ist der Retry. */
export const wachhund = onSchedule(
  { schedule: '*/10 * * * *', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 30 },
  async () => {
    await wachhundLauf();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const wachhundNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'wachhundNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await wachhundLauf());
});
