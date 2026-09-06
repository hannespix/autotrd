/**
 * connectBroker — eigenes Alpaca-Konto verbinden und wieder trennen.
 *
 * Owner-Wunsch 04.08.: „ich würde den Schalter auch gerne scharf schalten
 * können und einen Account wirklich verbinden können."
 *
 * ── Echtgeld-Schlüssel: unter welchen Bedingungen ─────────────────────────
 *
 * Alpaca-Schlüssel tragen ihre Art im Präfix: `PK…` Papierkonto, `AK…`
 * Echtgeld. Mit `core/keyVault.ts` liegt das Geheimnis verschlüsselt
 * (AES-256-GCM, Hauptschlüssel im Secret Manager). Echtgeld-Schlüssel dürfen
 * herein — unter DREI Bedingungen:
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
 *      weiterhin `broker.mode: live` UND `ALPACA_ALLOW_LIVE=1` UND einen
 *      ausgeschalteten Kill-Switch UND eine bestandene Live-Reife — die
 *      Kette in `core/brokerZugang.ts`. Was der Schlüssel ermöglicht, ist
 *      der lesende Blick aufs echte Depot — „startklar, aber nicht scharf".
 *
 * ── Warum die Schlüssel sofort geprüft werden ─────────────────────────────
 *
 * Ein Probe-Call gegen `/v2/account` (neuer Client, `src/alpaca/rest.ts`)
 * beweist dreierlei auf einmal: Die Schlüssel sind gültig, sie gehören zum
 * Endpunkt ihrer Art, und das Konto ist handelbar. Ohne diese Probe fiele
 * ein Tippfehler erst beim ersten Takt der Engine auf — also genau dann,
 * wenn niemand hinsieht.
 *
 * ── Ablage ────────────────────────────────────────────────────────────────
 *
 * `users/{uid}/private/broker`. Die Firestore-Regeln sperren `private/**`
 * für JEDEN Client (`read, write: if false`); nur das Admin-SDK der
 * Functions liest dort. Der Schlüssel wird NIE an einen Client
 * zurückgegeben — auch nicht an den, der ihn gerade gesetzt hat. Was
 * zurückkommt, ist der Kontostatus und eine maskierte Kennung.
 *
 * ── Trennen ohne Order-Sweep (Rückbau der Handelsplattform) ───────────────
 *
 * Bis zum Rückbau stornierte das Trennen die eigenen GTC-Schutz-Stops beim
 * Broker, weil das alte Buch sie nach dem Trennen nicht mehr erreicht hätte.
 * Der neue Kern hält seine Stops selbst: Sie liegen als Bracket-Bein bzw.
 * GTC-Stop BEIM BROKER und schützen die Position auch dann, wenn die App
 * den Schlüssel nicht mehr hat (CLAUDE.md §0.4: Exits werden nie gesperrt).
 * Deshalb wird hier nichts mehr storniert — ein Storno GÄBE Risiko frei,
 * er nähme keins. Wer sein Depot aufräumen will, tut das im
 * Alpaca-Dashboard.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { bindungsMeldung } from '../../../shared/src/index.js';
import { createAlpacaClient } from '../../../src/alpaca/rest.js';
import { CALLABLE_OPTS } from '../core/appcheck.js';
import { accessDeniedReason, accessLevelOfSnap, mayTradeSnap } from '../core/access.js';
import { bindeDepot, loeseDepot } from '../core/brokerBindung.js';
import { schluesselArt, vergissVerbindung, type AlpacaSchluessel } from '../core/brokerZugang.js';
import { FirestoreStateStore } from '../engine/state.js';

/**
 * Engine-State beim Verbinden/Trennen ablösen (Secreview 2, M9): Das Buch gehört zum bisherigen Konto.
 * Träfe es auf ein anderes Konto, buchte der Abgleich dessen Positionen als „fehlt beim Broker" mit
 * geschätztem Kurs aus (Phantom-Trades), und ein Moduswechsel (PK ⇒ AK) ließe jeden Takt am State
 * scheitern. Archiv statt Löschen: `users/{uid}/private/archiv/engineStates/{iso}`.
 */
async function engineStateAbloesen(uid: string, reason: string): Promise<void> {
  try {
    const archived = await new FirestoreStateStore(getFirestore(), uid).archive(Date.now(), reason);
    if (archived) logger.info(`connectBroker ${uid}: Engine-State archiviert (${reason})`);
  } catch (e) {
    // Nicht fatal für das Verbinden: Der Takt erkennt ein fremdes Konto am `accountId` im State und archiviert selbst.
    logger.warn(`connectBroker ${uid}: Engine-State nicht archiviert — der Takt holt es nach`, e);
  }
}
import { vaultBereit, verschluessle } from '../core/keyVault.js';
import { consumeQuota } from '../core/quota.js';

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
  /** Barbestand des verbundenen Kontos. */
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

/**
 * Trägt der Schlüssel ein bekanntes Alpaca-Präfix?
 *
 * `schluesselArt` aus `brokerZugang` kennt nur zwei Antworten (alles außer
 * `AK…` ist Papier) — für die ABLAGE richtig, für die EINGABE zu großzügig:
 * Ein Tippfehler in der Kennung soll hier abgelehnt werden, nicht als
 * Papierschlüssel zum Probe-Call laufen.
 */
export function hatAlpacaPraefix(keyId: string): boolean {
  const k = keyId.trim();
  return k.startsWith('PK') || k.startsWith('AK');
}

export async function verbindeBroker(
  uid: string,
  schluessel: AlpacaSchluessel,
  /** Zeitpunkt der letzten echten Anmeldung (Unix-Sekunden aus `auth_time`). */
  authTimeS?: number,
  jetztS: number = Math.floor(Date.now() / 1000),
): Promise<ConnectResult> {
  const keyId = schluessel.keyId.trim();
  const secret = schluessel.secret.trim();
  if (!hatAlpacaPraefix(keyId)) {
    throw new HttpsError('invalid-argument', 'srv.keinGueltigerSchluessel');
  }
  // Dieselbe Ableitung wie beim späteren Lesen (`brokerZugang.schluesselArt`).
  const art = schluesselArt(keyId);
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
  if (secret.length < 20) {
    throw new HttpsError('invalid-argument', 'srv.geheimerSchluesselZuKurz');
  }

  /* Probe-Call VOR dem Speichern: Ein Schlüsselpaar, das nicht funktioniert,
   * hat in der Datenbank nichts zu suchen — sonst steht dort eine Verbindung,
   * die es nicht gibt, und der Fehler fällt erst beim ersten Takt auf.
   *
   * Der Endpunkt folgt der Schlüsselart, weil ein `AK…` am Papier-Endpunkt
   * ohnehin abgelehnt würde. Das ist ein LESENDER Aufruf (`/v2/account`) und
   * die einzige Stelle hier, die einen Echtgeld-Endpunkt berührt. Über
   * ORDERS entscheidet das nicht — das tut die Guard-Kette in
   * `brokerZugang.ts`. Der Client registriert beide Schlüssel zur
   * Schwärzung, bevor er irgendetwas loggt oder wirft. */
  let konto;
  try {
    konto = await createAlpacaClient({
      mode: art,
      keyId,
      secret,
      feed: 'iex',
      assetClass: 'us_equity',
    }).getAccount();
  } catch (e) {
    // Die Meldung ist bereits von Schlüsseln gesäubert (`redact` im Client).
    throw new HttpsError('failed-precondition', `srv.verbindungFehlgeschlagen|${(e as Error).message}`);
  }
  if (konto.accountBlocked || konto.tradingBlocked) {
    throw new HttpsError('failed-precondition', `srv.kontoGesperrtAlpaca|${konto.status}`);
  }

  /* ── Ein Depot, ein Konto (Owner-Befund 12.08.) ─────────────────────────
   *
   * Zwei autotrd-Konten hatten dasselbe Alpaca-Paper-Depot hinterlegt. Der
   * Broker führt EINE Position je Symbol; zwei Engines auf demselben Depot
   * schließen sich gegenseitig die Positionen — samt Stop. Gebunden wird
   * über die KONTO-ID, nicht über den Schlüssel: Zu einem Alpaca-Konto
   * lassen sich mehrere Schlüsselpaare erzeugen, ein Riegel auf
   * Schlüsselebene wäre mit zwei Klicks zu umgehen. Die Bindung geschieht
   * in einer Transaktion, damit zwei gleichzeitige Verbinden-Aufrufe sich
   * nicht gegenseitig überholen. */
  const bindung = await bindeDepot(konto.id, art, uid);
  if (!bindung.ok) {
    logger.warn(`connectBroker ${uid}: Depot bereits gebunden seit ${bindung.seit}`);
    throw new HttpsError('failed-precondition', bindungsMeldung(bindung.seit));
  }
  await engineStateAbloesen(uid, `Broker verbunden (${art}, Konto ${konto.id})`);

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
        keyId,
        // Verschlüsselt, sobald ein Hauptschlüssel da ist. Papierkonten auf
        // einem Server ohne Vault bleiben im Klartext — festgehalten in
        // `verschluesselt`, damit die Migration weiß, was noch offen ist.
        secretKey: vaultBereit() ? verschluessle(secret) : secret,
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
      `${maskiere(keyId)} verbunden (verschlüsselt: ${String(vaultBereit())})`,
  );
  return {
    ok: true,
    maskiert: maskiere(keyId),
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
          'Live-Reife. Bis dahin siehst du dein echtes Depot nur in der Broker-Karte.'
        : `Papierkonto verbunden (${konto.status}). Die Engine handelt ab dem nächsten ` +
          'Takt auf diesem Konto; Stops und Ziele liegen als Orders beim Broker. ' +
          'Der Bestand beim Broker ist der Bestand — es gibt kein zweites Buch.',
  };
}

/** Antwort des Trennens. Ein Order-Sweep findet nicht mehr statt (Modulkopf). */
export interface TrennErgebnis {
  ok: true;
  geloescht: boolean;
}

/** Verbindung lösen — das Schlüsselpaar wird gelöscht, nicht nur deaktiviert. */
export async function trenneBroker(uid: string): Promise<TrennErgebnis> {
  const db = getFirestore();
  const ref = db.collection('users').doc(uid).collection(BROKER_DOC).doc(BROKER_ID);
  const vorher = await ref.get();
  if (!vorher.exists) return { ok: true, geloescht: false };
  // Löschen statt eines `aktiv: false`-Flags: Ein Schlüssel, der nicht mehr
  // gebraucht wird, soll auch nicht mehr da sein. Das Trennen muss IMMER
  // möglich sein — auch für ein gesperrtes Konto und auch, wenn Alpaca gerade
  // nicht antwortet; deshalb hängt hier kein Außen-Call dran.
  await ref.delete();
  await engineStateAbloesen(uid, 'Broker getrennt');
  /* Depot-Bindung mit lösen — sonst bliebe das Depot für immer belegt und
   * niemand könnte es je wieder verbinden, auch dieser Nutzer nicht.
   *
   * `loeseDepot` löscht nur, wenn die Bindung auch DIESEM Konto gehört:
   * Andernfalls könnte man eine fremde Bindung aufheben und sich danach
   * selbst eintragen — der Riegel wäre in zwei Schritten zu umgehen. */
  await loeseDepot(
    vorher.get('accountId') as string | undefined,
    (vorher.get('mode') as string | undefined) ?? 'paper',
    uid,
  );
  /* Cache dieser Instanz sofort verwerfen.
   *
   * Wirkt NUR lokal: `connectBroker` und der Engine-Takt laufen in getrennten
   * Function-Instanzen mit eigenem Speicher. Der Aufruf ist trotzdem richtig
   * — er nimmt mit, was er mitnehmen kann. Die eigentliche Absicherung ist
   * der kurze TTL in `brokerZugang`: Spätestens nach einer Minute liest jede
   * Instanz neu. */
  vergissVerbindung(uid);
  logger.info(`connectBroker ${uid}: Verbindung getrennt — offene Orders bleiben beim Broker stehen`);
  return { ok: true, geloescht: true };
}

export const connectBroker = onCall(
  CALLABLE_OPTS,
  async (request): Promise<ConnectResult | TrennErgebnis> => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'srv.anmeldungErforderlich');

    const { action, apiKey, secretKey } = (request.data ?? {}) as {
      action?: unknown;
      apiKey?: unknown;
      secretKey?: unknown;
    };

    if (action === 'disconnect') return trenneBroker(uid);

    if (typeof apiKey !== 'string' || typeof secretKey !== 'string') {
      throw new HttpsError('invalid-argument', 'srv.schluesselErforderlich');
    }
    /* Freischaltung VOR dem Außen-Call (Audit 13.08., Härtung): Bis dahin
     * konnte jedes frisch registrierte, nie freigeschaltete Konto Schlüssel
     * hinterlegen und den Probe-Call gegen Alpaca fahren — kostenverursachende
     * Fremd-API-Aufrufe vor jeder menschlichen Prüfung. Das TRENNEN oben
     * bleibt bewusst frei: Ein gesperrtes Konto, das seine Schlüssel
     * entfernen will, soll das immer dürfen. */
    const zugangSnap = await getFirestore().doc(`users/${uid}`).get();
    if (!mayTradeSnap(zugangSnap)) {
      throw new HttpsError('permission-denied', accessDeniedReason(accessLevelOfSnap(zugangSnap)));
    }
    if (!(await consumeQuota(uid, 'connectBroker', DAILY_CONNECT_LIMIT))) {
      throw new HttpsError(
        'resource-exhausted',
        `srv.hoechstensVerbindungen|${DAILY_CONNECT_LIMIT}`,
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
