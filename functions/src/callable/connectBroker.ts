/**
 * connectBroker — eigenes Alpaca-Papierkonto verbinden und wieder trennen.
 *
 * Owner-Wunsch 04.08.: „ich würde den Schalter auch gerne scharf schalten
 * können und einen Account wirklich verbinden können."
 *
 * ── Echtgeld-Schlüssel: warum erst jetzt, und unter welchen Bedingungen ───
 *
 * Alpaca-Schlüssel tragen ihre Art im Präfix: `PK…` Papierkonto, `AK…`
 * Echtgeld. Bis zum 05.08. nahm dieses Callable ausschließlich `PK…` an,
 * mit der Begründung, Echtgeld-Schlüssel gehörten in die Server-Umgebung.
 *
 * Diese Begründung war ungenau. Das Problem war nie die App als Eingabeweg
 * — es war die ABLAGE: Die Schlüssel lagen im Klartext in Firestore. Ein
 * Datenbank-Export, ein kompromittiertes Dienstkonto oder ein Blick in die
 * Konsole hätte gereicht. Für ein Papierkonto hinnehmbar, für echtes Geld
 * nicht.
 *
 * Mit `core/keyVault.ts` liegt das Geheimnis verschlüsselt (AES-256-GCM,
 * Hauptschlüssel im Secret Manager). Damit fällt der Grund weg, und
 * Echtgeld-Schlüssel dürfen herein — unter DREI Bedingungen:
 *
 *   1. Die verschlüsselte Ablage ist einsatzbereit (`vaultBereit()`).
 *      Ohne Hauptschlüssel bleibt es bei `PK…` — lieber abgelehnt als im
 *      Klartext gespeichert.
 *   2. Die Anmeldung ist FRISCH (siehe `REAUTH_MAX_S`). Das ist der zweite
 *      Faktor an der Stelle, wo er wirkt: nicht beim Login, sondern beim
 *      gefährlichen Vorgang. Eine übernommene Sitzung, die irgendwann
 *      einmal angemeldet wurde, reicht damit nicht.
 *   3. Der Handel bleibt trotzdem VERRIEGELT. Ein hinterlegter
 *      Echtgeld-Schlüssel schaltet nichts scharf: Orders verlangen
 *      weiterhin `broker.mode: live` UND `ALPACA_ALLOW_LIVE=1` UND eine
 *      bestandene Live-Reife. Was er ermöglicht, ist der lesende Abgleich
 *      des echten Depots — „startklar, aber nicht scharf".
 *
 * ── Warum die Schlüssel sofort geprüft werden ─────────────────────────────
 * ── Warum die Schlüssel sofort geprüft werden ─────────────────────────────
 *
 * Ein Probe-Call gegen `/v2/account` beweist dreierlei auf einmal: Die
 * Schlüssel sind gültig, sie gehören zum Papier-Endpunkt, und das Konto ist
 * handelbar. Ohne diese Probe fiele ein Tippfehler erst beim ersten Trade
 * auf — also genau dann, wenn niemand hinsieht.
 *
 * ── Ablage ────────────────────────────────────────────────────────────────
 *
 * `users/{uid}/private/broker`. Die Firestore-Regeln sperren `private/**`
 * für JEDEN Client (`read, write: if false`); nur das Admin-SDK der
 * Functions liest dort. Der Schlüssel wird NIE an einen Client
 * zurückgegeben — auch nicht an den, der ihn gerade gesetzt hat. Was
 * zurückkommt, ist der Kontostatus und eine maskierte Kennung.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import {
  alpacaKonto,
  schluesselArt,
  type AlpacaSchluessel,
} from '../core/alpacaBroker.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { consumeQuota } from '../core/broker.js';
import { vergissVerbindung } from '../core/orderRouting.js';
import { vaultBereit, verschluessle } from '../core/keyVault.js';

/** Verbinden ist ein seltener Vorgang — zehn Versuche am Tag sind reichlich. */
const DAILY_CONNECT_LIMIT = 10;

/**
 * Wie frisch die Anmeldung für einen ECHTGELD-Schlüssel sein muss (Sekunden).
 *
 * Firebase stempelt `auth_time` ins ID-Token — den Zeitpunkt der letzten
 * echten Anmeldung, nicht den der letzten Token-Erneuerung. Fünf Minuten
 * heißt: Wer einen Live-Schlüssel hinterlegen will, muss gerade sein
 * Passwort (bzw. seinen zweiten Faktor) eingegeben haben.
 *
 * Das ist wirksamer als 2FA beim Login allein: Ein Angreifer mit einer
 * übernommenen, offenen Sitzung kommt an fast alles in dieser App heran —
 * aber nicht an diesen einen Vorgang, ohne die Zugangsdaten selbst zu
 * kennen. Für Papierkonten gilt die Frist bewusst NICHT; dort steht kein
 * Geld dahinter, und eine Reibung ohne Schutzwirkung ist nur Reibung.
 */
export const REAUTH_MAX_S = 300;

/** Wo das Schlüsselpaar liegt. `private/**` ist für Clients gesperrt. */
export const BROKER_DOC = 'private';
export const BROKER_ID = 'broker';

export interface ConnectResult {
  ok: true;
  /** Maskierte Kennung, z. B. `PKAB…WXYZ` — genug zum Wiedererkennen. */
  maskiert: string;
  /** Was verbunden wurde. Die Oberfläche zeigt Echtgeld anders an. */
  art: 'paper' | 'live';
  /** Liegt das Geheimnis verschlüsselt? Bei Echtgeld immer `true`. */
  verschluesselt: boolean;
  kontoStatus: string;
  /** Barbestand des verbundenen Papierkontos. */
  cash: number;
  equity: number;
  meldung: string;
}

/**
 * Kennung so kürzen, dass sie wiedererkennbar, aber nicht verwendbar ist.
 *
 * Vier Zeichen vorn und hinten: Der Nutzer erkennt, WELCHEN Schlüssel er
 * hinterlegt hat, ohne dass die Anzeige ihn irgendwem nützt.
 */
export function maskiere(keyId: string): string {
  const k = keyId.trim();
  if (k.length <= 10) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export async function verbindeBroker(
  uid: string,
  schluessel: AlpacaSchluessel,
  /** Zeitpunkt der letzten echten Anmeldung (Unix-Sekunden aus `auth_time`). */
  authTimeS?: number,
  jetztS: number = Math.floor(Date.now() / 1000),
): Promise<ConnectResult> {
  const art = schluesselArt(schluessel.keyId);
  if (art !== 'paper' && art !== 'live') {
    throw new HttpsError(
      'invalid-argument',
      'Kein gültiger Alpaca-Schlüssel. Papier-Schlüssel beginnen mit „PK", ' +
        'Echtgeld-Schlüssel mit „AK".',
    );
  }
  if (art === 'live') {
    // Bedingung 1: verschlüsselte Ablage. Ohne Hauptschlüssel landete der
    // Echtgeld-Schlüssel im Klartext — dann lieber gar nicht annehmen.
    if (!vaultBereit()) {
      throw new HttpsError(
        'failed-precondition',
        'Echtgeld-Schlüssel können auf diesem Server noch nicht sicher ' +
          'gespeichert werden: Die verschlüsselte Ablage ist nicht ' +
          'eingerichtet. Papierkonten (PK…) funktionieren weiterhin.',
      );
    }
    // Bedingung 2: frische Anmeldung. Eine übernommene, offene Sitzung soll
    // genau diesen Vorgang nicht ausführen können.
    if (typeof authTimeS !== 'number' || !Number.isFinite(authTimeS)) {
      throw new HttpsError(
        'failed-precondition',
        'Für einen Echtgeld-Schlüssel muss die Anmeldung überprüfbar frisch ' +
          'sein. Bitte ab- und wieder anmelden.',
      );
    }
    if (jetztS - authTimeS > REAUTH_MAX_S) {
      throw new HttpsError(
        'failed-precondition',
        'Deine Anmeldung ist älter als fünf Minuten. Melde dich bitte neu an ' +
          'und hinterlege den Echtgeld-Schlüssel direkt danach.',
      );
    }
  }
  if (schluessel.secret.trim().length < 20) {
    throw new HttpsError('invalid-argument', 'Der geheime Schlüssel ist zu kurz.');
  }

  /* Probe-Call VOR dem Speichern: Ein Schlüsselpaar, das nicht funktioniert,
   * hat in der Datenbank nichts zu suchen — sonst steht dort eine Verbindung,
   * die es nicht gibt, und der Fehler fällt erst beim ersten Trade auf.
   *
   * Der Endpunkt folgt der Schlüsselart, weil ein `AK…` am Papier-Endpunkt
   * ohnehin abgelehnt würde. Das ist ein LESENDER Aufruf (`/v2/account`) und
   * die einzige Stelle hier, die einen Echtgeld-Endpunkt berührt. Über
   * ORDERS entscheidet das nicht — das tut `resolveBrokerMode` mit seinen
   * drei unveränderten Guards. */
  let konto;
  try {
    konto = await alpacaKonto(art, schluessel);
  } catch (e) {
    // Die Meldung ist bereits von Schlüsseln gesäubert (AlpacaFehler).
    throw new HttpsError('failed-precondition', `Verbindung fehlgeschlagen: ${(e as Error).message}`);
  }
  if (konto.accountBlocked || konto.tradingBlocked) {
    throw new HttpsError(
      'failed-precondition',
      `Das Konto ist bei Alpaca gesperrt (Status ${konto.status}).`,
    );
  }

  await getFirestore()
    .collection('users')
    .doc(uid)
    .collection(BROKER_DOC)
    .doc(BROKER_ID)
    .set(
      {
        provider: 'alpaca',
        // `mode` sagt, WOHIN Aufrufe für dieses Konto gehen — abgeleitet aus
        // der Schlüsselart, denn ein `AK…` funktioniert nur am
        // Echtgeld-Endpunkt. Über den HANDEL entscheidet es nicht.
        mode: art,
        keyId: schluessel.keyId.trim(),
        // Verschlüsselt, sobald ein Hauptschlüssel da ist. Papierkonten auf
        // einem Server ohne Vault bleiben im Klartext — festgehalten in
        // `verschluesselt`, damit die Migration weiß, was noch offen ist.
        secretKey: vaultBereit()
          ? verschluessle(schluessel.secret.trim())
          : schluessel.secret.trim(),
        verschluesselt: vaultBereit(),
        accountId: konto.id,
        connectedAt: new Date().toISOString(),
      },
      { merge: true },
    );

  vergissVerbindung(uid);
  // Nur die Kennung ins Log, nie das Geheimnis — und auch die maskiert.
  logger.info(
    `connectBroker ${uid}: ${art === 'live' ? 'Echtgeldkonto' : 'Papierkonto'} ` +
      `${maskiere(schluessel.keyId)} verbunden (verschlüsselt: ${String(vaultBereit())})`,
  );
  return {
    ok: true,
    maskiert: maskiere(schluessel.keyId),
    art,
    verschluesselt: vaultBereit(),
    kontoStatus: konto.status,
    cash: konto.cash,
    equity: konto.equity,
    meldung:
      art === 'live'
        ? `Echtgeldkonto verbunden (${konto.status}). Der Schlüssel liegt ` +
          'verschlüsselt; er wird nie wieder angezeigt und verlässt den Server nicht. ' +
          'GEHANDELT WIRD NICHT: Orders verlangen zusätzlich den Live-Modus in den ' +
          'Einstellungen, die Server-Freigabe ALPACA_ALLOW_LIVE und eine bestandene ' +
          'Live-Reife. Bis dahin siehst du dein echtes Depot nur im Abgleich.'
        : `Papierkonto verbunden (${konto.status}). Ab dem nächsten Scan gehen neue ` +
          'Orders an dieses Konto; das eigene Buch bleibt das führende Journal und ' +
          'wird bei jedem Scan gegen das Depot abgeglichen. Bestehende Positionen ' +
          'aus dem eigenen Buch bleiben dort — der Broker kennt sie nicht.',
  };
}

/** Verbindung lösen — das Schlüsselpaar wird gelöscht, nicht nur deaktiviert. */
export async function trenneBroker(uid: string): Promise<{ ok: true; geloescht: boolean }> {
  const ref = getFirestore()
    .collection('users')
    .doc(uid)
    .collection(BROKER_DOC)
    .doc(BROKER_ID);
  const vorher = await ref.get();
  if (!vorher.exists) return { ok: true, geloescht: false };
  // Löschen statt eines `aktiv: false`-Flags: Ein Schlüssel, der nicht mehr
  // gebraucht wird, soll auch nicht mehr da sein.
  await ref.delete();
  /* Cache dieser Instanz sofort verwerfen (M13).
   *
   * Wirkt NUR lokal: `connectBroker` und `scanMarket` laufen in getrennten
   * Function-Instanzen mit eigenem Speicher. Der Aufruf ist trotzdem richtig
   * — er nimmt mit, was er mitnehmen kann. Die eigentliche Absicherung ist
   * der kurze TTL: Spätestens nach einer Minute liest jede Instanz neu. */
  vergissVerbindung(uid);
  logger.info(`connectBroker ${uid}: Verbindung getrennt`);
  return { ok: true, geloescht: true };
}

export const connectBroker = onCall(
  CALLABLE_OPTS,
  async (request): Promise<ConnectResult | { ok: true; geloescht: boolean }> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Anmeldung erforderlich');

    const { action, apiKey, secretKey } = (request.data ?? {}) as {
      action?: unknown;
      apiKey?: unknown;
      secretKey?: unknown;
    };

    if (action === 'disconnect') return trenneBroker(uid);

    if (typeof apiKey !== 'string' || typeof secretKey !== 'string') {
      throw new HttpsError('invalid-argument', 'apiKey und secretKey sind erforderlich');
    }
    if (!(await consumeQuota(uid, 'connectBroker', DAILY_CONNECT_LIMIT))) {
      throw new HttpsError(
        'resource-exhausted',
        `Höchstens ${DAILY_CONNECT_LIMIT} Verbindungsversuche am Tag`,
      );
    }
    /* Zeitpunkt der letzten echten Anmeldung aus dem ID-Token.
     *
     * `auth_time` setzt Firebase selbst und erneuert es NICHT beim
     * stündlichen Token-Refresh — es steht für „wann hat dieser Mensch
     * zuletzt Zugangsdaten eingegeben". Genau das braucht die
     * Reauth-Prüfung; ein clientseitig mitgeschickter Zeitstempel wäre
     * wertlos, weil ihn derselbe Angreifer setzen könnte.
     *
     * Nur für Echtgeld-Schlüssel ausgewertet (siehe verbindeBroker). */
    const authTime = request.auth?.token?.auth_time;
    return verbindeBroker(
      uid,
      { keyId: apiKey, secret: secretKey },
      typeof authTime === 'number' ? authTime : undefined,
    );
  },
);
