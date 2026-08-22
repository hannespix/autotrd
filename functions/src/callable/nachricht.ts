/**
 * nachricht -- der Faden zwischen Konto-Inhaber und Admin (Owner 22.08.).
 *
 * Diese Callable gehört dem KUNDEN: Sie schreibt und liest ausschliesslich
 * den Faden des eigenen Kontos. Der Admin hat seinen Weg über `adminUsers`
 * -- zwei getrennte Türen, damit "darf ich fremde Fäden sehen?" nicht von
 * einem Parameter abhängt, sondern davon, welche Funktion man aufruft.
 *
 * -- Warum das auch für WARTENDE Konten geht ----------------------------
 *
 * Die erste Nachricht ist die zur Anmeldung ("bitte schaltet mich frei,
 * ich bin ..."). Ein Faden, den man erst nach der Freischaltung benutzen
 * darf, verfehlt genau den Zweck. Es gibt hier deshalb bewusst KEIN
 * `mayTrade` -- geschrieben wird Text, nicht Geld.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { leseNachricht, pruefeNachricht } from '../../../shared/src/index.js';
import { consumeQuota } from '../core/broker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';

/** Genug für eine Unterhaltung, zu wenig zum Zuspammen. */
const TAGESLIMIT = 20;
/** So viele Nachrichten kommen zurück -- neueste zuletzt. */
export const FADEN_LIMIT = 200;

export const nachricht = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');

  const { action, text } = (request.data ?? {}) as { action?: unknown; text?: unknown };
  const db = getFirestore();
  const faden = db.collection('users').doc(uid).collection('nachrichten');

  if (action === 'lesen') {
    const snap = await faden.orderBy('at').limit(FADEN_LIMIT).get();
    return { nachrichten: snap.docs.map((d) => leseNachricht(d.data())).filter((n) => n !== null) };
  }

  if (action === 'senden') {
    const sauber = pruefeNachricht(text);
    if (sauber === null) throw new HttpsError('invalid-argument', 'srv.nachrichtLeer');
    if (!(await consumeQuota(uid, 'nachricht', TAGESLIMIT))) {
      throw new HttpsError('resource-exhausted', 'srv.tageslimitErreicht');
    }
    /* `von: 'kunde'` steht FEST -- es kommt nicht aus der Anfrage. Käme es
     * von dort, könnte sich jeder eine Admin-Antwort in den eigenen Faden
     * schreiben und behaupten, sie sei freigeschaltet worden. */
    await faden.add({ von: 'kunde', text: sauber, at: new Date().toISOString() });
    return { ok: true };
  }

  throw new HttpsError('invalid-argument', 'srv.unbekannteAktion');
});
