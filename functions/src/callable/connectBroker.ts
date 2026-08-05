/**
 * connectBroker — eigenes Alpaca-Papierkonto verbinden und wieder trennen.
 *
 * Owner-Wunsch 04.08.: „ich würde den Schalter auch gerne scharf schalten
 * können und einen Account wirklich verbinden können."
 *
 * ── Warum hier NUR Papierkonten hereinkommen ──────────────────────────────
 *
 * Alpaca-Schlüssel tragen ihre Art im Präfix: `PK…` gehört zum Papierkonto,
 * `AK…` zum Echtgeldkonto. Dieses Callable nimmt ausschließlich `PK…` an.
 *
 * Das ist keine Bequemlichkeit, sondern die Grundlage dafür, dass die App
 * überhaupt Schlüssel entgegennehmen darf. Ein Echtgeld-Schlüssel in einer
 * Datenbank ist ein Schlüssel, den jeder mit Datenbankzugriff hat — der
 * Betreiber, der Anbieter, ein kompromittierter Dienstkonto-Schlüssel. Für
 * ein Papierkonto ist das hinnehmbar, weil daran kein Geld hängt. Für
 * echtes Geld wäre es der teuerste denkbare Kompromiss.
 *
 * Echtgeld-Schlüssel gehören deshalb ausschließlich in die Umgebung
 * (Secret Manager) — an einen Ort, an den weder die Oberfläche noch ein
 * übernommenes Nutzerkonto herankommt. Genau diese Trennung macht den
 * Doppel-Guard erst wirksam: Wäre der Live-Schlüssel über die App setzbar,
 * hinge das ganze Sicherheitsgebäude an einem einzigen Passwort.
 *
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

/** Verbinden ist ein seltener Vorgang — zehn Versuche am Tag sind reichlich. */
const DAILY_CONNECT_LIMIT = 10;

/** Wo das Schlüsselpaar liegt. `private/**` ist für Clients gesperrt. */
export const BROKER_DOC = 'private';
export const BROKER_ID = 'broker';

export interface ConnectResult {
  ok: true;
  /** Maskierte Kennung, z. B. `PKAB…WXYZ` — genug zum Wiedererkennen. */
  maskiert: string;
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
): Promise<ConnectResult> {
  const art = schluesselArt(schluessel.keyId);
  if (art === 'live') {
    throw new HttpsError(
      'invalid-argument',
      'Das ist ein Echtgeld-Schlüssel (AK…). Über die App lassen sich nur ' +
        'Papierkonten verbinden (PK…). Echtgeld-Schlüssel gehören in die ' +
        'Server-Umgebung — sonst hinge das echte Geld an einem Passwort.',
    );
  }
  if (art !== 'paper') {
    throw new HttpsError(
      'invalid-argument',
      'Kein gültiger Alpaca-Schlüssel. Papier-Schlüssel beginnen mit „PK".',
    );
  }
  if (schluessel.secret.trim().length < 20) {
    throw new HttpsError('invalid-argument', 'Der geheime Schlüssel ist zu kurz.');
  }

  // Probe-Call VOR dem Speichern: Ein Schlüsselpaar, das nicht funktioniert,
  // hat in der Datenbank nichts zu suchen — sonst steht dort eine Verbindung,
  // die es nicht gibt, und der Fehler fällt erst beim ersten Trade auf.
  // Hart gegen den PAPIER-Endpunkt, nie gegen den Echtgeld-Endpunkt.
  let konto;
  try {
    konto = await alpacaKonto('paper', schluessel);
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
        mode: 'paper',
        keyId: schluessel.keyId.trim(),
        secretKey: schluessel.secret.trim(),
        accountId: konto.id,
        connectedAt: new Date().toISOString(),
      },
      { merge: true },
    );

  vergissVerbindung(uid);
  // Nur die Kennung ins Log, nie das Geheimnis — und auch die maskiert.
  logger.info(`connectBroker ${uid}: Papierkonto ${maskiere(schluessel.keyId)} verbunden`);
  return {
    ok: true,
    maskiert: maskiere(schluessel.keyId),
    kontoStatus: konto.status,
    cash: konto.cash,
    equity: konto.equity,
    meldung:
      `Papierkonto verbunden (${konto.status}). Ab dem nächsten Scan gehen neue ` +
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
    return verbindeBroker(uid, { keyId: apiKey, secret: secretKey });
  },
);
