/**
 * resetWallet — Handelshistorie auf null, Kursdaten bleiben.
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * Am 28.07. wurde die Engine an vier Stellen gleichzeitig umgebaut:
 * Kostenschwelle im Einstieg, handelbares Universum (37 der 40 gehandelten
 * Symbole fielen weg), Korrelations-Deckel, zweiter Handels-Modus. Die
 * 297 Trades davor messen damit ein System, das es nicht mehr gibt.
 *
 * Sie einfach stehen zu lassen wäre keine Kleinigkeit, sondern verzerrte die
 * Auswertung MONATELANG: `snapshotEquity` rechnet die Kennzahlen über die
 * letzten 500 Trades. Die neue Engine handelt bewusst viel seltener — bis
 * 500 neue Trades die alten aus dem Fenster geschoben haben, vergeht bei
 * diesem Tempo ein Quartal. Trefferquote, Profitfaktor und Gebührenanteil
 * zeigten so lange eine Mischung aus zwei Systemen, und man könnte nie
 * sagen, ob eine Verbesserung von den Filtern kommt oder nur davon, dass
 * die alten Zahlen verdünnt werden.
 *
 * ── Die Schnittlinie ──────────────────────────────────────────────────────
 *
 * Alles, was aus HANDELSERGEBNISSEN abgeleitet ist, geht.
 * Alles, was aus KURSDATEN abgeleitet ist, bleibt.
 *
 * Die beiden Stellen, an denen man sich dabei vertut:
 *
 *  - Die PROGNOSE-Trefferquoten bleiben. Sie messen, wie gut wir Kurse
 *    vorhersagen — unabhängig davon, ob und wie darauf gehandelt wurde. Das
 *    ist die Trainingshistorie des Selbstoptimierers, und CLAUDE.md §9
 *    verbietet ausdrücklich, sie wegzuwerfen. Sie liegt ohnehin unter
 *    `market/**` und wird hier nie angefasst.
 *  - Die TUNER-Flotte geht. Ihre Kennzahlen stammen aus dem Handel der
 *    Schattenvarianten, also aus derselben vergifteten Quelle. Sie stehen zu
 *    lassen hieße, die neue Engine mit den Vorurteilen der alten zu starten.
 *
 * ── Was NICHT gelöscht wird, obwohl es verlockend wäre ────────────────────
 *
 * Die Strategie-DEFINITIONEN (Regelbäume) und die gezeichneten
 * Prognose-Pfeile bleiben. Beides ist Arbeit des Users, kein Messergebnis.
 * Zurückgesetzt wird bei den Strategien nur ihr Schattendepot und ihre
 * Cooldown-Stempel — die Ergebnisse, nicht die Idee.
 */

import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { DEFAULT_STRATEGY, type Strategy } from '../../../shared/src/index.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';

/**
 * Das Wort, das getippt werden muss.
 *
 * Ein Bestätigungsdialog allein reicht bei einer unumkehrbaren Aktion nicht —
 * „Ja" klickt man weg, ohne es gelesen zu haben. Tippen erzwingt einen
 * bewussten Moment. Serverseitig geprüft, nicht nur in der Oberfläche: Ein
 * Client-Guard ist eine Bequemlichkeit, keine Sicherung.
 */
export const RESET_CONFIRM_WORD = 'RESET';

/** Höchstens fünf Resets am Tag — gegen Versehen, nicht gegen Missbrauch. */
const DAILY_RESET_LIMIT = 5;

/**
 * Unterlisten, die komplett verschwinden.
 *
 * `strategies` und `predictions` stehen bewusst NICHT hier (siehe Modul-Kopf).
 * `trades` stand hier bis zum 04.08. — jetzt werden sie ARCHIVIERT statt
 * gelöscht (siehe `ARCHIV_SAMMLUNG`).
 */
export const GELOESCHTE_SAMMLUNGEN = ['positions', 'equity', 'stats', 'tuning', 'meta'] as const;

/**
 * Wohin die Handelshistorie beim Reset wandert (04.08.).
 *
 * Warum überhaupt: `trades` stand in der Löschliste, und `recursiveDelete`
 * kennt kein Zurück. Ein Reset vernichtete damit das komplette Handelsjournal
 * — beim letzten Mal 297 Einträge. Für die reine Kontostands-Rechnung ist das
 * folgerichtig (der Reset SOLL die Messung schneiden), aber die Historie ist
 * das einzige, was sich nie wiederherstellen lässt: Kurse, Zeitpunkte,
 * Gebühren und Anschaffungsbezüge existieren nirgendwo sonst.
 *
 * Verschieben statt filtern ist bewusst gewählt: Alle bestehenden Leser von
 * `trades` sehen nach dem Reset weiterhin eine leere Liste — das Verhalten
 * ändert sich also an keiner einzigen Stelle. Nur die Daten überleben.
 */
const ARCHIV_SAMMLUNG = 'tradesArchive';

/** Batch-Größe beim Archivieren — Firestore erlaubt 500 Schreibvorgänge. */
const ARCHIV_BATCH = 200;

export interface ResetResult {
  ok: true;
  /** Gelöschte Dokumente je Unterliste — damit die UI zeigen kann, was weg ist. */
  deleted: Record<string, number>;
  /** Kontostand nach dem Reset. */
  balance: number;
  /** Schnittmarke: ab hier ist die Messung sauber. */
  resetAt: string;
}

/**
 * Handelshistorie ins Archiv verschieben und aus `trades` entfernen.
 *
 * Der Reset-Zeitpunkt wird an jedem Eintrag festgehalten (`archivedAt`), damit
 * später erkennbar bleibt, zu welcher Mess-Strecke ein Trade gehörte — bei
 * mehreren Resets sonst nicht mehr auseinanderzuhalten.
 *
 * Fehlertoleranz mit Absicht ASYMMETRISCH: Schlägt das Archivieren fehl,
 * bricht der Reset ab, statt trotzdem zu löschen. Lieber ein Reset, der nicht
 * durchläuft, als einer, der die Historie mitnimmt.
 */
async function archiviereTrades(
  userRef: FirebaseFirestore.DocumentReference,
  resetAt: string,
): Promise<number> {
  const db = getFirestore();
  const quelle = userRef.collection('trades');
  const archiv = userRef.collection(ARCHIV_SAMMLUNG);
  let verschoben = 0;
  for (;;) {
    const seite = await quelle.limit(ARCHIV_BATCH).get();
    if (seite.empty) break;
    const batch = db.batch();
    for (const doc of seite.docs) {
      batch.set(archiv.doc(doc.id), { ...doc.data(), archivedAt: resetAt });
      batch.delete(doc.ref);
    }
    await batch.commit();
    verschoben += seite.size;
    // Schutz gegen eine Endlosschleife, falls das Löschen wirkungslos bliebe
    if (seite.size < ARCHIV_BATCH) break;
  }
  return verschoben;
}

/**
 * Der eigentliche Reset — getrennt vom Callable, damit er gegen echtes
 * Firestore prüfbar ist. Bei einer unumkehrbaren Löschung ist „typecheck ist
 * grün" keine Verifikation: Was zählt, ist, was hinterher noch dasteht.
 */
export async function resetUserWallet(uid: string): Promise<ResetResult> {
  const db = getFirestore();
  const userRef = db.doc(`users/${uid}`);
  const snap = await userRef.get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Profil fehlt');

  const strategy = (snap.get('settings.strategy') as Strategy | undefined) ?? DEFAULT_STRATEGY;
  const startkapital = strategy.broker?.initialCapital;
  const balance =
    typeof startkapital === 'number' && Number.isFinite(startkapital) && startkapital > 0
      ? startkapital
      : DEFAULT_STRATEGY.broker.initialCapital;
  const now = new Date().toISOString();

  const deleted: Record<string, number> = {};
  deleted.tradesArchived = await archiviereTrades(userRef, now);
  for (const name of GELOESCHTE_SAMMLUNGEN) {
    const coll = userRef.collection(name);
    // Vorher zählen: `recursiveDelete` meldet nicht, wie viel es getroffen
    // hat, und ein Reset, der stumm nichts tut, sähe aus wie ein Reset, der
    // funktioniert hat.
    const vorher = (await coll.select().get()).size;
    if (vorher > 0) await db.recursiveDelete(coll);
    deleted[name] = vorher;
  }

  // Schattendepots und Handelsstempel der Regelbäume zurücksetzen — die
  // Bäume selbst bleiben stehen (sie sind eine Idee, kein Messergebnis).
  const stratSnap = await userRef.collection('strategies').get();
  for (const doc of stratSnap.docs) {
    await doc.ref
      .set(
        { shadow: FieldValue.delete(), lastTrades: FieldValue.delete(), lastDirs: FieldValue.delete() },
        { merge: true },
      )
      .catch(() => undefined);
  }
  deleted.strategiesCleared = stratSnap.size;

  await userRef.set(
    {
      wallet: {
        paperBalance: balance,
        currency: 'USD',
        updatedAt: now,
        // Die Schnittmarke ist der wichtigste Teil dieses Aufrufs. Ohne sie
        // täte die Auswertung so, als hätte es die alten Daten nie gegeben —
        // mit ihr kann sie ehrlich „Kennzahlen seit …" schreiben.
        resetAt: now,
        // Kapitalbasis der Gesamt-P&L ab diesem Schnitt (Equity − baseCapital)
        baseCapital: balance,
        marginInterestTotal: FieldValue.delete(),
        marginInterestDate: FieldValue.delete(),
      },
      // Kauf-Pausen beziehen sich auf Trades, die es nicht mehr gibt.
      engineCooldowns: FieldValue.delete(),
    },
    { merge: true },
  );

  logger.info(`Wallet-Reset ${uid}: ${JSON.stringify(deleted)}, Kontostand ${balance}`);
  return { ok: true, deleted, balance, resetAt: now };
}

export const resetWallet = onCall(CALLABLE_OPTS, async (request): Promise<ResetResult> => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  const { confirm } = (request.data ?? {}) as { confirm?: unknown };
  if (confirm !== RESET_CONFIRM_WORD) {
    throw new HttpsError(
      'failed-precondition',
      `Zum Bestätigen „${RESET_CONFIRM_WORD}" eingeben — der Reset lässt sich nicht rückgängig machen.`,
    );
  }
  if (!(await consumeQuota(uid, 'resetWallet', DAILY_RESET_LIMIT))) {
    throw new HttpsError('resource-exhausted', `Höchstens ${DAILY_RESET_LIMIT} Resets am Tag`);
  }
  return resetUserWallet(uid);
});
