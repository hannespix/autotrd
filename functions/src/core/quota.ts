/**
 * Tages-Quota je Konto und Aufruf-Art — die Missbrauchsbremse aller Callables.
 *
 * Herausgelöst aus dem alten Order-Routing (`core/broker.ts`, gelöscht mit
 * dem Rückbau der Handelsplattform): Die Quota hat mit Handel nichts zu tun,
 * sie zählt Aufrufe. Jedes Callable, das Serverlast oder Fremd-API-Kosten
 * verursacht, fragt hier VOR seiner Arbeit nach.
 *
 * Ablage: `admin/quotas-{uid}` (Top-Level-Dokument, für Clients per Rules
 * gesperrt). Der Zähler ist anonym — nur `{art}_{tag}: n` unter der uid als
 * Dokument-ID; personenbezogene Daten liegen hier nicht. `kontoLoeschung`
 * löscht das Dokument mit, weil `recursiveDelete` auf `users/{uid}` es
 * nicht erfasst.
 */

import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/** Tages-Quota (admin/quotas-{uid}) transaktional erhöhen; false = Limit erreicht. */
export async function consumeQuota(uid: string, kind: string, dailyLimit: number): Promise<boolean> {
  const db = getFirestore();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.doc(`admin/quotas-${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = `${kind}_${day}`;
    const used = (snap.get(key) as number | undefined) ?? 0;
    if (used >= dailyLimit) return false;
    tx.set(ref, { [key]: FieldValue.increment(1) }, { merge: true });
    return true;
  });
}
