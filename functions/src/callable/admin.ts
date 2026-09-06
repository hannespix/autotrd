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
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  leseNachricht,
  leseRisikoVermerk,
  positionValue,
  pruefeNachricht,
  type Position,
} from '../../../shared/src/index.js';
import { FADEN_LIMIT } from './nachricht.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/quota.js';
import { accessLevelOf, type AccessLevel } from '../core/access.js';
import { reifeFuerKonto } from '../core/liveGate.js';
import { abgleichSperreAusVermerk } from '../core/kontoTore.js';
import { DAILY_DELETE_LIMIT, DELETE_CONFIRM_WORD, loescheKonto, type LoeschBefund } from '../core/kontoLoeschung.js';

/**
 * Abgleich-Vermerk eines fremden Kontos für die Übersicht (21.08.).
 *
 * Die Sperr-Entscheidung kommt aus `abgleichSperreAusVermerk` (Konto-Tore)
 * — derselben Funktion, die die Einstiegs-Tore benutzen. Sie hier
 * nachzubauen hiesse, dass die Admin-Ansicht „gesperrt" sagen könnte,
 * während die Engine handelt (oder umgekehrt): zwei Wahrheiten über
 * dieselbe Sperre. Der Vermerk selbst stammt aus dem Buch/Broker-Abgleich
 * der alten Plattform; ein alter Vermerk sperrt nicht (Frist in den Toren).
 */
function abgleichZeile(vermerk: unknown, jetzt: Date): AdminUserRow['abgleich'] {
  if (typeof vermerk !== 'object' || vermerk === null) return null;
  const v = vermerk as {
    at?: unknown;
    fehlbestand?: unknown;
    fremdbestand?: unknown;
    konto?: { zustand?: unknown };
  };
  const zahl = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    sperre: abgleichSperreAusVermerk(vermerk, jetzt),
    fehlbestand: zahl(v.fehlbestand),
    fremdbestand: zahl(v.fremdbestand),
    kontoZustand: typeof v.konto?.zustand === 'string' ? v.konto.zustand : null,
    at: typeof v.at === 'string' ? v.at : null,
  };
}

const DAILY_LIMIT = 300;
/* Stufen, die per `action: 'set'` gesetzt werden dürfen. `archiviert` ist
 * dabei — es ist eine ABLAGE, kein Löschen: Der Betreiber nimmt ein Konto aus
 * der Liste, ohne etwas zu vernichten, und kann es jederzeit zurückholen. */
const LEVELS: ReadonlySet<string> = new Set(['pending', 'approved', 'blocked', 'archiviert']);

export interface AdminUserRow {
  uid: string;
  email: string | null;
  accessLevel: AccessLevel;
  requestedAt: string | null;
  admin: boolean;
  /** Zustimmung zum Risikohinweis — `null` bei Bestandskonten. */
  risiko: { version: string; at: string } | null;
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
  reife: { bereit: boolean; erfuellt: number; gesamt: number; fazit: string; offeneCodes?: string[] };
  /**
   * Broker-Abgleich des Kontos (Owner 21.08.: „diese Sperre von anderen
   * Usern für Admin sichtbar machen").
   *
   * Der Heartbeat meldet nur eine SUMME („1 Konten gesperrt") — welches
   * Konto es ist, stand nirgends. Ein Admin sah die Sperre also, konnte
   * sie aber keinem Konto zuordnen und schon gar nicht helfen.
   *
   * Gelesen wird der gespeicherte Vermerk `risk.abgleich`, nicht neu
   * gemessen: Die Übersicht listet alle Konten auf einmal: ein Broker-Call
   * je Zeile wäre eine Lawine. Die Sperr-Entscheidung kommt aus derselben
   * Funktion wie im Scan (`abgleichSperreAusVermerk`) — eine zweite
   * Auslegung hier wäre eine zweite Wahrheit.
   *
   * `null` = das Konto hat keinen Broker verbunden (oder noch nie einen
   * Abgleich gehabt).
   */
  abgleich: {
    /** Sperrt der Vermerk gerade Einstiege? */
    sperre: boolean;
    /** Symbole, die das Buch führt und der Broker nicht (gefährlich). */
    fehlbestand: number;
    /** Symbole, die der Broker mehr hält (harmlos). */
    fremdbestand: number;
    /** Cash-/Equity-Vergleich: 'sauber' | 'leicht' | 'grob' | fehlend. */
    kontoZustand: string | null;
    /** Wann der Vermerk entstand (ISO) — ein alter Vermerk sperrt nicht. */
    at: string | null;
  } | null;
}

export const adminUsers = onCall(
  /* 300 s statt der 60-s-Voreinstellung (Red-Team-Befund 24.08.): Nur die
   * `delete`-Action braucht das — sie ruft `trenneBroker` UND danach
   * `recursiveDelete` über den gesamten Konto-Baum (bei gewachsener
   * Historie Minuten). Ein höheres Limit verlangsamt die schnellen Actions
   * (list/set/nachrichten/…) nicht — es gibt ihnen nur mehr Raum, bevor
   * Cloud Functions abbricht, falls sie ihn je bräuchten. */
  { ...CALLABLE_OPTS, timeoutSeconds: 300 },
  async (request) => {
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
      // ACHTUNG: `select()` ist eine Feldmaske — was hier fehlt, liefert
      // `d.get(...)` unten als `undefined`, ohne Fehler und ohne Warnung.
      // `risk.abgleich` fehlte anfangs: Die Sperr-Anzeige blieb deshalb
      // immer leer, obwohl der Vermerk im Dokument stand. Wer unten ein
      // Feld liest, muss es hier eintragen — der Wächter in
      // functions/test/adminFeldmaske.test.ts gleicht beide Listen ab.
      .select(
        'accessLevel',
        'requestedAt',
        'admin',
        'wallet',
        'settings.strategy.broker.initialCapital',
        'risk.abgleich',
        'risiko',
      )
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
    /* EIN Zeitstempel für alle Zeilen: Sonst könnten zwei Konten mit
     * identischem Vermerk verschieden bewertet werden, nur weil die
     * Schleife über die Frist lief. */
    const jetzt = new Date();
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
            // Sprachneutrale Codes der offenen Kriterien — die Oberfläche baut daraus ihren Satz.
            ...(befund.offeneCodes ? { offeneCodes: [...befund.offeneCodes] } : {}),
          },
          abgleich: abgleichZeile(d.get('risk.abgleich'), jetzt),
          /* Risiko-Bestätigung je Konto (Owner 22.08.: „ich will mich nicht
           * angreifbar machen"). Eine Zustimmung, die nur in der Datenbank
           * liegt und nirgends ablesbar ist, hilft im Streitfall nicht. */
          risiko: leseRisikoVermerk(d.get('risiko')),
        };
      }),
    );
    /* Wartende nach oben — sie sind der Grund, warum man die Liste öffnet.
     * Archivierte ganz nach unten: Sie sind abgelegt, nicht offen. Das
     * Frontend blendet sie zusätzlich standardmäßig aus; die Sortierung ist
     * die zweite Linie, falls jemand den Filter ausschaltet. */
    const rang: Record<AccessLevel, number> = { pending: 0, blocked: 1, approved: 2, archiviert: 3 };
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

  /* Endgültig löschen (Owner-Frage 24.08.: „gesperrte Konten löschen …
   * sonst kommt es zu einer Vermüllung der Datenbank" — Antwort: BEIDES,
   * Archiv-Ablage UND ein echter Löschanspruch, siehe AskUserQuestion-
   * Entscheidung „Zusätzlich: den Löschanspruch erfüllen").
   *
   * Bestätigungswort + eigenes, strenges Tageslimit HIER (Callable-Ebene,
   * derselbe Ort wie bei `resetWallet`) — die zehn fachlichen
   * Vorbedingungen (Admin-Ziel-Tabu, Karenzzeit, offene Positionen,
   * laufender Reset, Live-Verbindung, …) prüft `loescheKonto` selbst,
   * gegen frisch gelesene Daten, nicht gegen irgendetwas aus `request`. */
  if (action === 'delete') {
    const { confirm } = (request.data ?? {}) as { confirm?: unknown };
    if (confirm !== DELETE_CONFIRM_WORD) {
      throw new HttpsError('failed-precondition', `srv.loeschenBestaetigen|${DELETE_CONFIRM_WORD}`);
    }
    if (!(await consumeQuota(uid, 'adminDelete', DAILY_DELETE_LIMIT))) {
      throw new HttpsError('resource-exhausted', `srv.hoechstensLoeschungen|${DAILY_DELETE_LIMIT}`);
    }
    targetRef(); // wirft bei fehlender/eigener uid — dieselbe Prüfung wie überall sonst
    const ergebnis: LoeschBefund = await loescheKonto(target as string, uid);
    logger.info(`Admin ${uid} hat Konto ${target as string} endgültig gelöscht`);
    return ergebnis;
  }

  /* Die Aktionen `abgleich` und `uebernahmeVormerken` sind mit dem Rückbau
   * der Handelsplattform entfallen: Es gibt kein eigenes Buch mehr, das
   * gegen den Broker abzugleichen wäre — der Bestand beim Broker ist der
   * Bestand. Ein noch gespeicherter Vermerk `risk.abgleich` wird oben nur
   * noch angezeigt (und verfällt über die Frist in den Konto-Toren). */

  /**
   * Faden eines FREMDEN Kontos lesen (Owner 22.08.: "diese soll der Admin
   * später für jeden Account auch abrufen können").
   *
   * Eigene Tür statt eines Parameters an der Kunden-Callable: "Darf ich
   * fremde Fäden sehen?" hängt so davon ab, WELCHE Funktion man aufruft --
   * und die hier prüft oben bereits `admin: true`.
   */
  if (action === 'nachrichten') {
    const ref = targetRef();
    const snap = await ref.collection('nachrichten').orderBy('at').limit(FADEN_LIMIT).get();
    return {
      nachrichten: snap.docs.map((d) => leseNachricht(d.data())).filter((n) => n !== null),
    };
  }

  /**
   * Antworten -- die andere Hälfte der Unterhaltung.
   *
   * `von: 'admin'` steht FEST und kommt nicht aus der Anfrage: Der Absender
   * ist eine Eigenschaft des Weges, nicht des Inhalts.
   */
  if (action === 'antworten') {
    const ref = targetRef();
    const sauber = pruefeNachricht(an);
    if (sauber === null) throw new HttpsError('invalid-argument', 'srv.nachrichtLeer');
    await ref.collection('nachrichten').add({
      von: 'admin',
      text: sauber,
      at: new Date().toISOString(),
    });
    logger.info(`Admin ${uid} hat ${target} geantwortet`);
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
   * `meta/live.killSwitch` wird in `brokerZugang.brokerVerbindung` bei jeder
   * Live-Verbindung geprüft (60-s-Cache je Instanz, Lesefehler =
   * angehalten). Der Schalter betrifft NUR Echtgeld: Papierkonten und der
   * lesende Blick auf ein Live-Depot laufen unverändert weiter — es geht
   * nur keine neue Live-Order mehr raus. */
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
