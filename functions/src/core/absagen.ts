/**
 * Aufbewahrung der „Warum NICHT gekauft"-Tagesdocs (Task 21, Phase 2):
 * `users/{uid}/absagen/{YYYY-MM-DD}` älter als ABSAGE_TAGE werden im
 * täglichen snapshotEquity-Lauf gelöscht — best-effort, je Lauf höchstens 30.
 * Die Doc-ID ist der Handelstag; lexikografisch = chronologisch.
 */
import { FieldPath, type DocumentReference } from 'firebase-admin/firestore';
import { ABSAGE_TAGE } from '../../../shared/src/index.js';

/** Erster Tag, der BLEIBT (alles davor wird gelöscht). */
export function absagenGrenze(jetzt: Date): string {
  return new Date(jetzt.getTime() - ABSAGE_TAGE * 86_400_000).toISOString().slice(0, 10);
}

export async function absagenAufraeumen(userRef: DocumentReference, jetzt: Date): Promise<number> {
  const alt = await userRef.collection('absagen')
    .where(FieldPath.documentId(), '<', absagenGrenze(jetzt))
    .limit(30)
    .get();
  if (alt.empty) return 0;
  const batch = userRef.firestore.batch();
  for (const d of alt.docs) batch.delete(d.ref);
  await batch.commit();
  return alt.size;
}
