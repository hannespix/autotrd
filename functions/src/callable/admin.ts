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
import { positionValue, type Position } from '../../../shared/src/index.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';
import { accessLevelOf, type AccessLevel } from '../core/access.js';
import { reifeFuerKonto } from '../core/liveGate.js';

const DAILY_LIMIT = 300;
const LEVELS: ReadonlySet<string> = new Set(['pending', 'approved', 'blocked']);

export interface AdminUserRow {
  uid: string;
  email: string | null;
  accessLevel: AccessLevel;
  requestedAt: string | null;
  admin: boolean;
  /** Gesamt-P&L = Equity − Kapitalbasis (Owner 02.08.: „deren aktuelle
   *  performance sehen"). Dieselbe Formel wie die Performance-Karte des
   *  Users selbst; null, wenn das Konto (noch) kein Wallet hat. */
  pnl: number | null;
  pnlPct: number | null;
  equity: number | null;
  /** Geschlossene Trades laut stats/main — reine Anzeige-Zahl (Owner 13.08.:
   *  Konten-Übersicht); null, wenn das Konto noch keine Statistik hat. */
  trades: number | null;
  /** Live-Reife-Kurzform. Die Rechnung kommt AUSSCHLIESSLICH aus
   *  `liveGate.reifeFuerKonto` — derselben Funktion, die Scan, brokerStatus
   *  und Order-Routing benutzen. Eine zweite Rechnung hier wäre eine zweite
   *  Wahrheit über die Echtgeld-Freigabe. */
  reife: { bereit: boolean; erfuellt: number; gesamt: number; fazit: string };
}

export const adminUsers = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');
  if (!(await consumeQuota(uid, 'adminUsers', DAILY_LIMIT))) {
    throw new HttpsError('resource-exhausted', 'srv.tageslimitErreicht');
  }

  const db = getFirestore();
  const caller = await db.doc(`users/${uid}`).get();
  if (caller.get('admin') !== true) {
    throw new HttpsError('permission-denied', 'srv.nurBetreiber');
  }

  const { action, target, level, admin, an } = (request.data ?? {}) as {
    action?: unknown;
    target?: unknown;
    level?: unknown;
    admin?: unknown;
    an?: unknown;
  };
  const targetRef = (): FirebaseFirestore.DocumentReference => {
    if (typeof target !== 'string' || target.length === 0 || target.includes('/')) {
      throw new HttpsError('invalid-argument', 'srv.targetUid');
    }
    if (target === uid) {
      throw new HttpsError('failed-precondition', 'srv.eigenesKontoTabu');
    }
    return db.doc(`users/${target}`);
  };

  if (action === 'list') {
    // 500 deckt die Plattform auf absehbare Zeit; sollte sie je darüber
    // wachsen, braucht die Liste ohnehin Suche + Pagination statt mehr Rohdaten.
    const snap = await db
      .collection('users')
      .select('accessLevel', 'requestedAt', 'admin', 'wallet', 'settings.strategy.broker.initialCapital')
      .limit(500)
      .get();
    // Kurs-Cache wie im Equity-Snapshot: je Symbol einmal, nicht je User.
    const preise = new Map<string, number | null>();
    const lastPrice = async (sym: string): Promise<number | null> => {
      if (!preise.has(sym)) {
        try {
          const p = ((await db.collection('market').doc(sym).get()).get('quote') as
            | { price?: number }
            | undefined)?.price;
          preise.set(sym, typeof p === 'number' && p > 0 ? p : null);
        } catch {
          preise.set(sym, null);
        }
      }
      return preise.get(sym) ?? null;
    };
    const rows: AdminUserRow[] = await Promise.all(
      snap.docs.map(async (d) => {
        let email: string | null = null;
        try {
          email = (await getAuth().getUser(d.id)).email ?? null;
        } catch {
          // Auth-Konto gelöscht, Firestore-Doc verwaist — anzeigen statt werfen
        }
        // Gesamt-P&L = Cash + bewertete Positionen − Kapitalbasis. Exakt die
        // Formel der Performance-Karte (Fund 01.08.: lade-unabhängig), damit
        // Admin-Liste und User-Ansicht nie zwei verschiedene Zahlen zeigen.
        let pnl: number | null = null;
        let pnlPct: number | null = null;
        let equity: number | null = null;
        const cash = d.get('wallet.paperBalance') as number | undefined;
        if (typeof cash === 'number' && Number.isFinite(cash)) {
          let posWert = 0;
          for (const p of (await d.ref.collection('positions').get()).docs) {
            const pos = p.data() as Position;
            posWert += positionValue(pos, await lastPrice(pos.symbol ?? p.id));
          }
          equity = Math.round((cash + posWert) * 100) / 100;
          const basis =
            (d.get('wallet.baseCapital') as number | undefined)
            ?? (d.get('settings.strategy.broker.initialCapital') as number | undefined);
          if (typeof basis === 'number' && basis > 0) {
            pnl = Math.round((equity - basis) * 100) / 100;
            pnlPct = Math.round((pnl / basis) * 10000) / 100;
          }
        }
        // Trades-Zahl (Anzeige) + Reife-Befund je Konto. Der Befund kommt aus
        // liveGate (einzige Wahrheit); die Trades-Zahl liest stats/main damit
        // die Übersicht „Equity · Trades · Reife" ohne zweite Ansicht steht.
        const [statsDoc, befund] = await Promise.all([
          d.ref.collection('stats').doc('main').get().catch(() => null),
          reifeFuerKonto(d.id),
        ]);
        const tradesRoh = statsDoc?.get('trades') as number | undefined;
        return {
          uid: d.id,
          email,
          accessLevel: accessLevelOf(d.data()),
          requestedAt: (d.get('requestedAt') as string | undefined) ?? null,
          admin: d.get('admin') === true,
          pnl,
          pnlPct,
          equity,
          trades: typeof tradesRoh === 'number' && Number.isFinite(tradesRoh) ? tradesRoh : null,
          reife: {
            bereit: befund.bereit,
            erfuellt: befund.erfuellt,
            gesamt: befund.gesamt,
            fazit: befund.fazit,
          },
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
      throw new HttpsError('invalid-argument', 'srv.levelUngueltig');
    }
    const ref = targetRef();
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'srv.unbekanntesKonto');
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
      throw new HttpsError('invalid-argument', 'srv.adminBool');
    }
    const ref = targetRef();
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'srv.unbekanntesKonto');
    await ref.set(
      { admin, adminChangedAt: new Date().toISOString(), adminChangedBy: uid },
      { merge: true },
    );
    return { ok: true };
  }

  /* Owner-Kill-Switch (M14): plattformweiter Not-Aus für Echtgeld-Orders.
   *
   * `meta/live.killSwitch` wird vom Order-Routing bei jeder Live-Verbindung
   * geprüft (60-s-Cache je Instanz, Lesefehler = angehalten). Der Schalter
   * betrifft NUR Echtgeld: Paper-Routing, eigenes Buch und der lesende
   * Abgleich laufen unverändert weiter — Positionen werden also weiterhin
   * überwacht, es geht nur keine neue Live-Order mehr raus. */
  if (action === 'liveStatus') {
    const doc = await db.doc('meta/live').get();
    return {
      killSwitch: doc.get('killSwitch') === true,
      at: (doc.get('killSwitchAt') as string | undefined) ?? null,
      von: (doc.get('killSwitchVon') as string | undefined) ?? null,
    };
  }

  if (action === 'setKillSwitch') {
    if (typeof an !== 'boolean') {
      throw new HttpsError('invalid-argument', 'srv.anBool');
    }
    await db.doc('meta/live').set(
      { killSwitch: an, killSwitchAt: new Date().toISOString(), killSwitchVon: uid },
      { merge: true },
    );
    return { ok: true, killSwitch: an };
  }

  throw new HttpsError(
    'invalid-argument',
    'srv.actionUngueltig',
  );
});
