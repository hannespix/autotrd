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

import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  TUNE_AXES,
  buildPriors,
  buildVariants,
  mergeAxisStat,
  orderByPrior,
  type GlobalAxisStats,
  type Strategy,
} from '../../../shared/src/index.js';
import { clampStrategyRisk } from '../core/rulesTrading.js';
import { decideTuning, type FleetState, type JournalEntry } from '../core/tuneFleet.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/** Wie viele Varianten gleichzeitig laufen — siehe tuneGrid zur Begründung. */
export const FLEET_SIZE = 6;
/** Trades des echten Kontos, die als Vergleichsgruppe dienen. */
const LIVE_TRADE_WINDOW = 400;
/** Journal-Einträge je User; ältere fallen raus. */
const JOURNAL_KEEP = 200;

/** Objekt mit sortierten Schlüsseln — für einen Vergleich per JSON. */
function kanonisch(wert: unknown): unknown {
  if (Array.isArray(wert)) return wert.map(kanonisch);
  if (wert !== null && typeof wert === 'object') {
    const o = wert as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = kanonisch(o[k]);
    return out;
  }
  return wert;
}

/**
 * Ist die Strategie noch dieselbe, auf der die Entscheidung beruht?
 *
 * ── Audit-Befund 11.08. ───────────────────────────────────────────────────
 *
 * `tuneAll` liest ALLE Konten einmal zu Beginn und arbeitet sie dann der
 * Reihe nach ab. Zwischen dem Lesen und dem Schreiben liegen mehrere
 * Netzrunden je Konto (Flotte, 400 Trades, Journal). In dieser Zeit kann der
 * Owner in der App an seiner Strategie drehen — und der Tuner schrieb
 * anschließend `settings.strategy` KOMPLETT aus seinem alten Stand plus
 * seiner einen Änderung. Die Änderung des Menschen war damit weg, ohne
 * Meldung, ohne Spur.
 *
 * Der schärfste Fall war `engine.running`: Der Schalter wurde ausdrücklich
 * aus der alten Fassung zurückgeschrieben („gehört dem Owner"). Wer die
 * Engine um 17:45 abschaltet, hätte sie eine Minute später wieder an
 * gehabt.
 *
 * ── Warum der Schalter beim Vergleich außen vor bleibt ────────────────────
 *
 * Ihn umzulegen ist die häufigste und harmloseste Änderung überhaupt. Zählte
 * er als „Basis geändert", verlöre der Tuner seine Beförderung wegen eines
 * Klicks, der mit den Parametern nichts zu tun hat. Stattdessen wird er beim
 * Schreiben aus dem FRISCHEN Stand übernommen — dann gehört er dem Owner
 * wirklich, und zwar in der Fassung von eben.
 */
export function basisUnveraendert(frisch: Strategy | undefined, basis: Strategy): boolean {
  if (!frisch) return false;
  const ohneSchalter = (s: Strategy): string => {
    const k = structuredClone(s);
    k.engine.running = false;
    return JSON.stringify(kanonisch(k));
  };
  return ohneSchalter(frisch) === ohneSchalter(basis);
}

/**
 * Eine Siegerin, die es nicht ins Dokument geschafft hat, im Journal
 * richtigstellen.
 *
 * Ohne das stünde im Journal „übernommen", während die Einstellung
 * unverändert ist — und dieselbe Zahl ginge über `globalDelta` als Erfolg
 * ins kollektive Vorwissen ein. Eine Sache, zwei Antworten.
 *
 * Die Prüfung selbst bleibt stehen: Sie hat stattgefunden, ihr Ergebnis ist
 * gültig, und der Grund gehört sichtbar dazu. Das Journal ist der Ort, an
 * dem der Owner nachvollzieht, warum sich etwas geändert hat — oder eben
 * nicht.
 */
export function markiereNichtUebernommen(entries: JournalEntry[], variantId: string): void {
  for (const e of entries) {
    if (e.variantId !== variantId) continue;
    e.promoted = false;
    e.reason = `${e.reason} — nicht übernommen: Strategie wurde während des Laufs geändert.`;
  }
}

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

  // ── Kollektives Vorwissen (Owner-Wunsch 28.07.) ───────────────────────────
  // EINMAL je Lauf gelesen, für alle Konten. Was hat eine Achsen-Änderung
  // ÜBER ALLE KONTEN hinweg gebracht? Das entscheidet nur die REIHENFOLGE,
  // in der die begrenzte Flotte belegt wird — es gibt mehr Kandidaten als
  // Plätze, und bisher entschied darüber eine willkürliche feste Ordnung.
  //
  // Die lokale Signifikanzprüfung bleibt UNANGETASTET. Sie mit fremder
  // Evidenz aufzuweichen wäre die verlockende Bayes-Variante und genau die
  // falsche: Die Bonferroni-Korrektur schützt davor, unter vielen Tests
  // Zufallssieger zu befördern, und die Konten starten von verschiedenen
  // Ausgangsstrategien. Jede Beförderung braucht weiterhin die volle
  // Evidenz des eigenen Kontos.
  const globalStats = ((await db.doc('meta/tuneGlobal').get()).get('axes') as
    | GlobalAxisStats
    | undefined) ?? {};
  const priors = buildPriors(globalStats);
  const globalDelta: GlobalAxisStats = {};

  let promoted = 0;
  let judged = 0;

  for (const userDoc of snap.docs) {
    try {
      if (userDoc.get('settings.autoTune') === false) continue; // Owner hat abgestellt
      const roh = userDoc.get('settings.strategy') as Strategy | undefined;
      if (!roh) continue;
      const base = clampStrategyRisk(structuredClone(roh));
      // Erst ALLE Kandidaten bilden, dann nach Vorwissen ordnen, dann
      // kappen: Andersherum (erst kappen, dann ordnen) käme das Vorwissen zu
      // spät — es könnte nur noch sortieren, was die feste Ordnung ohnehin
      // schon ausgewählt hat.
      const alle = buildVariants(base, TUNE_AXES.length * 8);
      const variants = orderByPrior(alle, priors).slice(0, FLEET_SIZE);
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
        const fleetRef = userDoc.ref.collection('tuning').doc('fleet');
        // In einer Transaktion, weil zwischen dem Lesen zu Beginn des Laufs
        // und diesem Schreibvorgang Minuten liegen können (siehe
        // `basisUnveraendert`). Ohne sie überschriebe der Tuner still, was
        // der Owner in der Zwischenzeit eingestellt hat.
        const uebernommen = await db.runTransaction(async (tx) => {
          const frisch = await tx.get(userDoc.ref);
          const jetzt = frisch.get('settings.strategy') as Strategy | undefined;
          const jetztGeclampt = jetzt ? clampStrategyRisk(structuredClone(jetzt)) : undefined;
          if (!basisUnveraendert(jetztGeclampt, base)) return false;
          // Der Schalter gehört dem Owner — und zwar so, wie er JETZT steht.
          const schalter = jetzt?.engine?.running;
          neu.engine.running = typeof schalter === 'boolean' ? schalter : base.engine.running;
          tx.set(userDoc.ref, { settings: { strategy: neu } }, { merge: true });
          // Nach der Übernahme ist die Flotte veraltet — die Varianten bezogen
          // sich auf die alte Basis. Frisch anfangen ist ehrlicher, als
          // Ergebnisse aus zwei verschiedenen Welten zu vermischen. Im selben
          // Zug wie die Strategie, sonst gäbe es einen Moment, in dem die neue
          // Basis gegen Schattenkonten der alten geprüft würde.
          tx.set(fleetRef, { variants: {}, rebuiltAt: now.toISOString() });
          return true;
        });
        if (uebernommen) {
          promoted += 1;
          logger.info(`autoTune ${userDoc.id}: „${winner.id}" übernommen`);
        } else {
          markiereNichtUebernommen(entries, winner.id);
          logger.info(
            `autoTune ${userDoc.id}: „${winner.id}" verworfen — Strategie hat sich während des Laufs geändert`,
          );
        }
      }

      // Beitrag zum Kollektiv: NUR Zählwerte je Achsenwert, keine
      // Einzeltrades, keine Beträge, keine Kennung. Aus „42-mal geprüft,
      // 7-mal befördert" lässt sich kein Konto rekonstruieren.
      // `neuesKonto` ist hier immer true, weil jedes Konto je Lauf genau
      // einmal beiträgt — ohne das zählte ein Konto, das dieselbe Variante
      // täglich prüft, als viele und täuschte Breite vor.
      for (const e of entries) {
        globalDelta[e.variantId] = mergeAxisStat(
          globalDelta[e.variantId],
          { promoted: e.promoted, edge: e.edge },
          true,
        );
      }

      await schreibeJournal(userDoc.ref, entries);
    } catch (err) {
      logger.warn(`autoTune: User ${userDoc.id} übersprungen`, err);
    }
  }

  // Kollektiv fortschreiben — additiv über FieldValue.increment, damit
  // zwei gleichzeitige Läufe sich nicht gegenseitig überschreiben (dieselbe
  // Disziplin wie bei den Forecast-Kombis).
  if (Object.keys(globalDelta).length > 0) {
    const ref = db.doc('meta/tuneGlobal');
    const args: unknown[] = [new FieldPath('updatedAt'), now.toISOString()];
    for (const [id, d] of Object.entries(globalDelta)) {
      const key = id.replace(/[/.]/g, '_'); // Punkte würden Pfade verschachteln
      args.push(new FieldPath('axes', key, 'judged'), FieldValue.increment(d.judged));
      args.push(new FieldPath('axes', key, 'promoted'), FieldValue.increment(d.promoted));
      args.push(new FieldPath('axes', key, 'edgeSum'), FieldValue.increment(d.edgeSum));
      args.push(new FieldPath('axes', key, 'accounts'), FieldValue.increment(d.accounts));
    }
    await ref.set({}, { merge: true });
    await (ref.update as (...a: unknown[]) => Promise<unknown>)(...args).catch((err: unknown) =>
      logger.warn('meta/tuneGlobal nicht fortschreibbar', err),
    );
  }

  await db
    .doc('meta/health')
    .set(
      {
        autoTune: {
          at: now.toISOString(),
          date: now.toISOString().slice(0, 10),
          users: snap.size,
          promoted,
          judged,
          // Sichtbar machen, wie breit das Kollektiv gerade ist — sonst
          // bliebe unklar, ob der Prior überhaupt spricht.
          priors: priors.length,
        },
      },
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
