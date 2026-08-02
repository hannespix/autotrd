/**
 * adminUsers — Freischaltung aus der App heraus (Owner-Frage 02.08.: „wie
 * kann man andere User freischalten?").
 *
 * Die Zugangsstufe war bisher NUR über die Firebase-Konsole änderbar: UID in
 * Authentication suchen, users/{uid} öffnen, accessLevel editieren — drei
 * Werkzeuge für einen Handgriff, je Konto. Dieses Callable macht daraus einen
 * Klick in der App, ohne die Sicherheitslage zu verändern:
 *
 *  - **Der Guard ist `admin: true` auf users/{uid}** — und dieses Feld kann
 *    kein Client direkt schreiben, weil die Rules auf dem User-Dokument
 *    ausschließlich `settings`-Updates erlauben (firestore.rules). Der ERSTE
 *    Admin wird einmalig in der Konsole gesetzt; danach dürfen Admins über
 *    `setAdmin` weitere ernennen oder entlassen (Owner 02.08.: „Admin-
 *    Accounts, die andere freischalten können, und normale User-Accounts").
 *    Es gibt keinen Weg, sich per App SELBST zum Admin zu machen — jede
 *    Ernennung braucht einen bestehenden Admin.
 *  - **Geschrieben wird nur die Zugangsstufe** (+ Audit-Stempel wer/wann).
 *    Wallet, Positionen, Strategie fremder Konten bleiben unerreichbar.
 *  - Die eigene Stufe ist absichtlich tabu — ein Admin sperrt sich nicht
 *    aus Versehen selbst.
 *
 * E-Mails kommen zur Anzeige aus Admin-Auth (getUser je UID) und werden
 * bewusst NICHT in Firestore gespiegelt: keine zweite Quelle, die driftet.
 */

import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';
import { accessLevelOf, type AccessLevel } from '../core/access.js';

const DAILY_LIMIT = 300;
const LEVELS: ReadonlySet<string> = new Set(['pending', 'approved', 'blocked']);

export interface AdminUserRow {
  uid: string;
  email: string | null;
  accessLevel: AccessLevel;
  requestedAt: string | null;
  admin: boolean;
}

export const adminUsers = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');
  if (!(await consumeQuota(uid, 'adminUsers', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', 'Tageslimit erreicht — bitte später erneut');
  }

  const db = getFirestore();
  const caller = await db.doc(`users/${uid}`).get();
  if (caller.get('admin') !== true) {
    throw new HttpsError('permission-denied', 'Nur für Betreiber-Konten');
  }

  const { action, target, level, admin } = (request.data ?? {}) as {
    action?: unknown;
    target?: unknown;
    level?: unknown;
    admin?: unknown;
  };
  const targetRef = (): FirebaseFirestore.DocumentReference => {
    if (typeof target !== 'string' || target.length === 0 || target.includes('/')) {
      throw new HttpsError('invalid-argument', 'target muss eine User-UID sein');
    }
    if (target === uid) {
      throw new HttpsError('failed-precondition', 'Das eigene Konto bleibt tabu (Selbst-Aussperr-Schutz)');
    }
    return db.doc(`users/${target}`);
  };

  if (action === 'list') {
    // 500 deckt die Plattform auf absehbare Zeit; sollte sie je darüber
    // wachsen, braucht die Liste ohnehin Suche + Pagination statt mehr Rohdaten.
    const snap = await db
      .collection('users')
      .select('accessLevel', 'requestedAt', 'admin')
      .limit(500)
      .get();
    const rows: AdminUserRow[] = await Promise.all(
      snap.docs.map(async (d) => {
        let email: string | null = null;
        try {
          email = (await getAuth().getUser(d.id)).email ?? null;
        } catch {
          // Auth-Konto gelöscht, Firestore-Doc verwaist — anzeigen statt werfen
        }
        return {
          uid: d.id,
          email,
          accessLevel: accessLevelOf(d.data()),
          requestedAt: (d.get('requestedAt') as string | undefined) ?? null,
          admin: d.get('admin') === true,
        };
      }),
    );
    // Wartende nach oben — sie sind der Grund, warum man die Liste öffnet.
    const rang: Record<AccessLevel, number> = { pending: 0, blocked: 1, approved: 2 };
    rows.sort(
      (a, b) => rang[a.accessLevel] - rang[b.accessLevel]
        || (a.email ?? '￿').localeCompare(b.email ?? '￿'),
    );
    return { users: rows };
  }

  if (action === 'set') {
    if (typeof level !== 'string' || !LEVELS.has(level)) {
      throw new HttpsError('invalid-argument', "level muss 'pending', 'approved' oder 'blocked' sein");
    }
    const ref = targetRef();
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Unbekanntes Konto');
    await ref.set(
      { accessLevel: level, accessChangedAt: new Date().toISOString(), accessChangedBy: uid },
      { merge: true },
    );
    return { ok: true };
  }

  // Zwei Kontotypen (Owner 02.08.): Admins ernennen/entlassen weitere Admins.
  // Nie sich selbst (targetRef) — so kann ein Admin sich nicht versehentlich
  // entmachten; den letzten Admin stellt zur Not die Konsole wieder her.
  if (action === 'setAdmin') {
    if (typeof admin !== 'boolean') {
      throw new HttpsError('invalid-argument', 'admin muss true oder false sein');
    }
    const ref = targetRef();
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Unbekanntes Konto');
    await ref.set(
      { admin, adminChangedAt: new Date().toISOString(), adminChangedBy: uid },
      { merge: true },
    );
    return { ok: true };
  }

  throw new HttpsError('invalid-argument', "action muss 'list', 'set' oder 'setAdmin' sein");
});
