/**
 * autoTune — der Kreislauf schließt sich (MT4/MT5).
 *
 * Täglich nach US-Schluss: Für jeden User mit laufender Engine werden die
 * Schattenkonten der Varianten gegen das echte Konto gestellt. Schlägt eine
 * Variante die amtierende Einstellung NACHWEISLICH, wird sie übernommen —
 * und jede Prüfung landet im Journal, ob befördert oder nicht.
 *
 * ── Die Grenzen, die nicht verhandelbar sind ────────────────────────────────
 *
 *  1. **Nur Paper.** Der Tuner rührt Echtgeld unter keinen Umständen an; er
 *     schreibt ausschließlich `settings.strategy`, und der Live-Handel hängt
 *     zusätzlich am Doppelschloss aus broker.mode und ALPACA_ALLOW_LIVE.
 *  2. **Nur innerhalb der Risiko-Hülle.** Was `clampStrategyRisk` nicht
 *     durchlässt, kommt auch vom Tuner nicht durch. Positionsgröße und
 *     Stop/Take stehen ohnehin nicht auf seinen Achsen.
 *  3. **Höchstens eine Änderung je Durchgang.** Sonst wüsste hinterher
 *     niemand, welche geholfen hat.
 *  4. **Nichts ohne Begründung.** Jeder Eintrag nennt Änderung, Vorsprung,
 *     p-Wert und beide Stichprobengrößen. Ein Automat, der unbegründet am
 *     Depot dreht, wäre kein Feature, sondern ein Risiko.
 *
 * Der Schalter `settings.autoTune !== false` lässt den Owner das Ganze
 * abstellen; fehlt das Feld, ist der Tuner AN — das ist der ausdrückliche
 * Wunsch („alles soll vollautomatisch laufen", 27.07.).
 */

import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { buildVariants, type Strategy } from '../../../shared/src/index.js';
import { clampStrategyRisk } from '../core/rulesTrading.js';
import { decideTuning, type FleetState, type JournalEntry } from '../core/tuneFleet.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Wie viele Varianten gleichzeitig laufen — siehe tuneGrid zur Begründung. */
export const FLEET_SIZE = 6;
/** Trades des echten Kontos, die als Vergleichsgruppe dienen. */
const LIVE_TRADE_WINDOW = 400;
/** Journal-Einträge je User; ältere fallen raus. */
const JOURNAL_KEEP = 200;

export interface TuneRunResult {
  users: number;
  promoted: number;
  judged: number;
}

export async function tuneAll(now = new Date()): Promise<TuneRunResult> {
  const db = getFirestore();
  const snap = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();

  let promoted = 0;
  let judged = 0;

  for (const userDoc of snap.docs) {
    try {
      if (userDoc.get('settings.autoTune') === false) continue; // Owner hat abgestellt
      const roh = userDoc.get('settings.strategy') as Strategy | undefined;
      if (!roh) continue;
      const base = clampStrategyRisk(structuredClone(roh));
      const variants = buildVariants(base, FLEET_SIZE);
      if (variants.length === 0) continue;

      const fleetDoc = await userDoc.ref.collection('tuning').doc('fleet').get();
      const fleet = ((fleetDoc.get('variants') as FleetState | undefined) ?? {}) as FleetState;

      // Vergleichsgruppe: die abgeschlossenen Trades des ECHTEN Kontos. Der
      // Vergleich läuft also gegen das, was tatsächlich passiert ist — nicht
      // gegen eine weitere Simulation.
      const tradesSnap = await userDoc.ref
        .collection('trades')
        .orderBy('at', 'desc')
        .limit(LIVE_TRADE_WINDOW)
        .get();
      const livePnls: number[] = [];
      for (const t of tradesSnap.docs) {
        const pnl = t.get('pnl') as number | undefined;
        if (typeof pnl === 'number' && Number.isFinite(pnl)) livePnls.push(pnl);
      }

      const { winner, entries } = decideTuning(base, variants, fleet, livePnls, now);
      judged += entries.length;

      if (winner) {
        // Die Hülle läuft NACH der Übernahme noch einmal: Der Tuner soll
        // nichts durchsetzen können, was ein Mensch über die Oberfläche auch
        // nicht dürfte.
        const neu = clampStrategyRisk(structuredClone(winner.strategy));
        neu.engine.running = base.engine.running; // Schalter gehört dem Owner
        await userDoc.ref.set({ settings: { strategy: neu } }, { merge: true });
        // Nach der Übernahme ist die Flotte veraltet — die Varianten bezogen
        // sich auf die alte Basis. Frisch anfangen ist ehrlicher, als
        // Ergebnisse aus zwei verschiedenen Welten zu vermischen.
        await userDoc.ref.collection('tuning').doc('fleet').set({
          variants: {},
          rebuiltAt: now.toISOString(),
        });
        promoted += 1;
        logger.info(`autoTune ${userDoc.id}: „${winner.id}" übernommen`);
      }

      await schreibeJournal(userDoc.ref, entries);
    } catch (err) {
      logger.warn(`autoTune: User ${userDoc.id} übersprungen`, err);
    }
  }

  await db
    .doc('meta/health')
    .set(
      { autoTune: { at: now.toISOString(), date: now.toISOString().slice(0, 10), users: snap.size, promoted, judged } },
      { merge: true },
    )
    .catch(() => undefined);
  logger.info(`autoTune: ${judged} Prüfungen, ${promoted} Übernahmen bei ${snap.size} Usern`);
  return { users: snap.size, promoted, judged };
}

async function schreibeJournal(
  ref: FirebaseFirestore.DocumentReference,
  entries: JournalEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const coll = ref.collection('tuneLog');
  const batch = getFirestore().batch();
  for (const e of entries) {
    // Doc-ID aus Zeitpunkt und Variante — ein zweiter Lauf derselben Minute
    // überschreibt, statt das Journal zu verdoppeln.
    batch.set(coll.doc(`${e.at.slice(0, 16)}_${e.variantId}`.replace(/[/.]/g, '_')), e);
  }
  await batch.commit();

  // Alte Einträge wegräumen — das Journal soll lesbar bleiben, nicht
  // vollständig bis zum Anfang der Zeit.
  const alle = await coll.orderBy('at', 'desc').offset(JOURNAL_KEEP).limit(200).get();
  if (!alle.empty) {
    const weg = getFirestore().batch();
    for (const d of alle.docs) weg.delete(d.ref);
    await weg.commit();
  }
}

/** Täglich 17:45 ET — nach evalForecasts (16:30) und snapshotEquity (17:15). */
export const autoTune = onSchedule(
  {
    schedule: '45 17 * * *',
    timeZone: 'America/New_York',
    retryCount: 0,
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    await tuneAll();
  },
);

/** Manueller Trigger — NUR im Emulator (Abnahme-Verifikation). */
export const tuneNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'tuneNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await tuneAll());
});
