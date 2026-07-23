/**
 * ensureProfile — legt users/{uid} beim ersten Login an (idempotent).
 * Die Rules verbieten Client-`create` bewusst (ARCHITECTURE §5); dieses
 * Callable ist der einzige Weg, ein Profil zu erzeugen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { DEFAULT_STRATEGY } from '../../../shared/src/index.js';
import { consumeQuota } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

const DAILY_LIMIT = 60; // idempotent + 1 Call je Login — 60/Tag ist großzügig

export const ensureProfile = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  if (!(await consumeQuota(uid, 'ensureProfile', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', 'Tageslimit erreicht — bitte später erneut');
  }

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
