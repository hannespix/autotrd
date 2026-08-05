/**
 * setLiveMode — den Echtgeld-Schalter eines Kontos umlegen (M14, 05.08.).
 *
 * Owner-Go vom 05.08.: „bitte SCHARF stellen! aber mit Sicherheits-Rückfrage
 * und kurzer Erklärung dass es losgeht sobald man einen gewissen Schalter
 * umlegt und bei der Trading Engine auf Starten drückt."
 *
 * ── Warum das ein eigenes Callable ist ────────────────────────────────────
 *
 * `broker.mode` liegt unter `settings.strategy`, und die Firestore-Regeln
 * erlauben dem Eigentümer, `settings` zu schreiben. Rein technisch könnte
 * die App das Feld also direkt setzen. Drei Gründe sprechen dagegen:
 *
 *   1. Die Reife-Prüfung gehört auf den Server. Ein Client, der sie selbst
 *      auswertet, kann sie auch selbst überspringen — und die Fehlermeldung
 *      „warum ging das nicht?" wäre geraten statt gemessen.
 *   2. Ein Wechsel auf Echtgeld gehört protokolliert. Wer, wann, mit welchem
 *      Reifegrad — ohne das ist im Nachhinein nicht rekonstruierbar, ob ein
 *      Verlust auf einem bewussten Schalter beruhte oder auf einem Versehen.
 *   3. Die Reauthentifizierung. Sie wirkt nur, wenn der Server das ID-Token
 *      prüft; ein Client-seitiger Dialog ist eine Höflichkeitsform, keine
 *      Sicherung.
 *
 * ── Was dieser Schalter NICHT tut ─────────────────────────────────────────
 *
 * Er startet keinen Handel. `broker.mode: 'live'` ist EINER von drei Guards;
 * `resolveBrokerMode()` verlangt zusätzlich die Betreiber-Freigabe
 * (`ALPACA_ALLOW_LIVE=1`) und die bestandene Reife. Und selbst wenn alle
 * drei stehen, passiert nichts, solange `engine.running` false ist — das ist
 * der zweite Schalter, den der Owner meint: „und bei der Trading Engine auf
 * Starten drückt".
 *
 * ── Der Rückweg ist immer offen ───────────────────────────────────────────
 *
 * Zurück auf Papier geht IMMER: ohne Reife-Prüfung, ohne
 * Reauthentifizierung, ohne Bestätigungswort. Eine Sicherung, die das
 * Abschalten erschwert, ist keine Sicherung — sie ist ein zusätzliches
 * Risiko in genau dem Moment, in dem jemand es eilig hat.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import type { ReifeBefund } from '../../../shared/src/index.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { reifeFuerKonto } from '../core/liveGate.js';
import { brokerVerbindungLesend } from '../core/orderRouting.js';

/**
 * Wie frisch die Anmeldung sein muss, um auf Echtgeld zu schalten.
 *
 * Dieselben fünf Minuten wie beim Hinterlegen eines Echtgeld-Schlüssels und
 * aus demselben Grund: gegen eine übernommene, bereits offene Sitzung.
 */
export const REAUTH_MAX_S = 300;

/** Das Wort, das getippt werden muss. Bewusst nicht „ja" oder „ok". */
export const BESTAETIGUNG = 'ECHTGELD';

export interface LiveModeErgebnis {
  ok: true;
  modus: 'paper' | 'live';
  /** Klartext für die Oberfläche. */
  meldung: string;
  /** Nur bei `action: 'status'` gesetzt — der Zustand aller drei Guards. */
  status?: {
    reife: ReifeBefund;
    /** Welche Art Konto verbunden ist, oder `null` ohne Verbindung. */
    brokerArt: 'paper' | 'live' | null;
    /** Betreiber-Freigabe `ALPACA_ALLOW_LIVE` auf diesem Server. */
    serverFreigabe: boolean;
  };
}

export const setLiveMode = onCall(
  CALLABLE_OPTS,
  async (request): Promise<LiveModeErgebnis> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

    const { live, bestaetigung, action } = (request.data ?? {}) as {
      live?: unknown;
      bestaetigung?: unknown;
      action?: unknown;
    };
    const db = getFirestore();
    const ref = db.collection('users').doc(uid);

    /* ── Nur nachsehen, nichts ändern ──────────────────────────────────────
     *
     * Die Oberfläche braucht dieselben Zahlen, an denen der Schalter hängt.
     * Sie im Client nachzurechnen wäre die zweite Fassung derselben Regel —
     * und die erste, die veraltet, sobald jemand eine Schwelle anfasst. */
    if (action === 'status') {
      const [reife, verbindung] = await Promise.all([
        reifeFuerKonto(uid),
        brokerVerbindungLesend(uid),
      ]);
      return {
        ok: true,
        modus: 'paper',
        meldung: reife.fazit,
        status: {
          reife,
          brokerArt: verbindung?.mode ?? null,
          // Die Betreiber-Freigabe ist kein Geheimnis — sie zu verschweigen
          // hieße nur, dass niemand versteht, warum nichts passiert.
          serverFreigabe: process.env.ALPACA_ALLOW_LIVE === '1',
        },
      };
    }

    /* ── Zurück auf Papier: sofort, ohne jede Hürde ────────────────────── */
    if (live !== true) {
      await ref.set(
        { settings: { strategy: { broker: { mode: 'paper' } } } },
        { merge: true },
      );
      logger.info(`setLiveMode ${uid}: zurück auf Papierhandel`);
      return {
        ok: true,
        modus: 'paper',
        meldung:
          'Zurück im Papierhandel. Offene Positionen bleiben unverändert — ' +
          'es wurde nichts verkauft.',
      };
    }

    /* ── Auf Echtgeld: alle Bedingungen, in der Reihenfolge ihrer Härte ── */

    if (bestaetigung !== BESTAETIGUNG) {
      throw new HttpsError(
        'invalid-argument',
        `Zum Scharfschalten muss „${BESTAETIGUNG}" bestätigt werden.`,
      );
    }

    // Frische Anmeldung — siehe REAUTH_MAX_S.
    const authTime = request.auth?.token?.auth_time;
    const jetztS = Math.floor(Date.now() / 1000);
    if (typeof authTime !== 'number' || jetztS - authTime > REAUTH_MAX_S) {
      throw new HttpsError(
        'failed-precondition',
        'Deine Anmeldung ist älter als fünf Minuten. Melde dich neu an und ' +
          'lege den Schalter direkt danach um.',
      );
    }

    /* Ein Echtgeld-Konto muss verbunden sein.
     *
     * Ohne diese Prüfung ließe sich der Modus auf „live" stellen, während
     * nur ein Papierkonto hinterlegt ist — der Handel liefe dann weiter auf
     * Papier, aber die Oberfläche zeigte ECHTGELD. Eine Anzeige, die über
     * die Herkunft des Geldes lügt, ist schlimmer als gar keine. */
    const verbindung = await brokerVerbindungLesend(uid);
    if (!verbindung) {
      throw new HttpsError(
        'failed-precondition',
        'Es ist kein Broker-Konto verbunden. Hinterlege zuerst deinen ' +
          'Echtgeld-Schlüssel (AK…) in der Broker-Karte.',
      );
    }
    if (verbindung.mode !== 'live') {
      throw new HttpsError(
        'failed-precondition',
        'Verbunden ist ein PAPIERKONTO (PK…). Für Echtgeld-Handel muss ein ' +
          'Echtgeld-Schlüssel (AK…) hinterlegt sein.',
      );
    }

    /* Die Reife-Prüfung — die eigentliche inhaltliche Hürde.
     *
     * Sie steht bewusst NACH den formalen Prüfungen: Wer sie nicht besteht,
     * soll erfahren, WORAN es liegt, statt an einem Bestätigungsdialog
     * hängenzubleiben. */
    const reife = await reifeFuerKonto(uid);
    if (!reife.bereit) {
      const offen = reife.kriterien
        .filter((k) => !k.erfuellt)
        .map((k) => `${k.name} (${k.ist}, nötig ${k.soll})`)
        .join('; ');
      throw new HttpsError(
        'failed-precondition',
        `Das Konto ist noch nicht reif für Echtgeld. Offen: ${offen}.`,
      );
    }

    await ref.set(
      {
        settings: { strategy: { broker: { mode: 'live' } } },
        // Protokoll am Konto: Ein Wechsel auf echtes Geld ist der Vorgang,
        // bei dem später am ehesten die Frage „wer hat das wann gemacht?"
        // gestellt wird.
        risk: {
          liveScharfAm: new Date().toISOString(),
          liveScharfReife: reife.erfuellt,
        },
      },
      { merge: true },
    );
    logger.warn(`setLiveMode ${uid}: ECHTGELD scharf geschaltet (Reife ${reife.erfuellt}/5)`);
    return {
      ok: true,
      modus: 'live',
      meldung:
        'Echtgeld ist scharf. Gehandelt wird, sobald die Engine auf „Start" ' +
        'steht und der Betreiber die Server-Freigabe gesetzt hat. Stoppen ' +
        'kannst du jederzeit — offene Positionen bleiben dabei unverändert.',
    };
  },
);
