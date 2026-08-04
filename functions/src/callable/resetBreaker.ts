/**
 * resetBreaker — die Tages-Notbremse von Hand entriegeln (M12).
 *
 * ── Warum das ein bewusster Klick sein muss ───────────────────────────────
 *
 * Eine Bremse, die sich selbst löst, sobald der Kurs kurz zurückkommt, hätte
 * an genau dem Tag nichts verhindert, an dem sie gebraucht wird. Deshalb
 * bleibt sie bis Tagesende aktiv — und wer früher weiterhandeln will, muss
 * das ausdrücklich tun. Der Klick ist die Stelle, an der jemand die Zahlen
 * noch einmal ansieht.
 *
 * Die Bezugsgröße (`risk.vortagEquity`) wird dabei NICHT angefasst. Wer sie
 * mit zurücksetzte, hätte die Bremse faktisch abgeschaltet: Der Tagesverlust
 * würde ab dem Reset neu gezählt, und dieselbe Grenze ließe sich beliebig
 * oft ausreizen. Nach dem Entriegeln gilt weiterhin der Vortagswert — ein
 * zweites Erreichen der Grenze sperrt sofort wieder.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';

/** Wie oft ein Konto die Bremse am Tag lösen darf. */
const TAGESLIMIT = 5;

export const resetBreaker = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

  // Ein Limit, weil sonst eine Schleife aus „lösen, weiterhandeln, wieder
  // auslösen" möglich wäre — genau das Verhalten, gegen das die Bremse da
  // ist, nur mit Extraschritten.
  if (!(await consumeQuota(uid, 'resetBreaker', TAGESLIMIT))) {
    throw new HttpsError(
      'resource-exhausted',
      `Die Notbremse wurde heute schon ${TAGESLIMIT}-mal gelöst. Das ist der Punkt, `
        + 'an dem eine Pause mehr hilft als ein weiterer Versuch.',
    );
  }

  const ref = getFirestore().doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Profil fehlt');

  const warAusgeloest = typeof snap.get('risk.breakerAusgeloestAm') === 'string';
  await ref.set(
    {
      risk: {
        breakerAusgeloestAm: null,
        breakerGrund: null,
        breakerVerlustPct: null,
        breakerZuletztGeloestAm: new Date().toISOString(),
      },
    },
    { merge: true },
  );
  return { ok: true, warAusgeloest };
});
