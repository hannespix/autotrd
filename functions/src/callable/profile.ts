/**
 * ensureProfile — legt users/{uid} beim ersten Login an (idempotent).
 * Die Rules verbieten Client-`create` bewusst (ARCHITECTURE §5); dieses
 * Callable ist der einzige Weg, ein Profil zu erzeugen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { DEFAULT_STRATEGY } from '../../../shared/src/index.js';

export const ensureProfile = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  const ref = getFirestore().doc(`users/${uid}`);
  const snap = await ref.get();
  if (snap.exists) return { created: false };

  const now = new Date().toISOString();
  await ref.set({
    profile: {
      createdAt: now,
      plan: 'free',
    },
    settings: {
      strategy: DEFAULT_STRATEGY,
    },
    // Paper-Wallet: Startkapital aus dem Default — NUR Functions schreiben hier
    wallet: {
      paperBalance: DEFAULT_STRATEGY.broker.initialCapital,
      currency: 'USD',
      updatedAt: now,
    },
  });
  return { created: true };
});
