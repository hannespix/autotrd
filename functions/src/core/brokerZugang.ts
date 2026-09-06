/**
 * Broker-Zugang je Nutzer — die einzige Stelle, die Alpaca-Schlüssel eines
 * Kontos aus Firestore liest, entschlüsselt und die Echtgeld-Kette prüft.
 *
 * Herausgelöst aus dem alten Order-Routing (M13/M14), damit der neue
 * Engine-Takt dieselbe, bewährte Guard-Kette benutzt:
 *   ALPACA_ALLOW_LIVE=1 (Betreiber) UND Kill-Switch aus UND
 *   settings.strategy.broker.mode='live' (Nutzer) UND Live-Reife.
 * Fehlt eines, liefert `brokerVerbindung()` für ein Live-Konto `null`;
 * `brokerVerbindungLesend()` liefert die Verbindung auch dann — aber nur
 * zum Lesen.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { reifeFuerKonto, resolveBrokerMode, type BrokerMode } from './liveGate.js';
import { entschluessle } from './keyVault.js';

/** Alpaca-Schlüsselpaar eines Kontos (Klartext, nur im Prozess). */
export interface AlpacaSchluessel {
  keyId: string;
  secret: string;
}

/** Paper (PK…) oder Live (AK…) — aus dem Präfix der Key-ID. */
export function schluesselArt(keyId: string): BrokerMode {
  return keyId.startsWith('AK') ? 'live' : 'paper';
}

/** Verbindungsdaten eines Kontos, so wie `connectBroker` sie ablegt. */
export interface BrokerVerbindung {
  mode: BrokerMode;
  schluessel: AlpacaSchluessel;
}

/**
 * Kurzlebiger Prozess-Cache für die Verbindungsdaten.
 *
 * Ohne ihn liest ein Scan mit neun Trades neunmal dasselbe Dokument, dazu
 * einmal für den Abgleich — zehn identische Reads je Konto und Scan, alle
 * fünf Minuten. Das ist kein Detail: Firestore rechnet nach Reads ab, und
 * der Zähler läuft rund um die Uhr weiter, weil Krypto nie schließt.
 *
 * Die 60 Sekunden sind bewusst kurz. Zugangsdaten zu cachen heißt, mit
 * veralteten zu arbeiten: Wer die Verbindung trennt, will nicht, dass die
 * nächste Order trotzdem noch beim Broker landet. Eine Minute deckt genau
 * einen Scan-Durchlauf ab und ist danach vergessen. Der Cache lebt in der
 * Function-Instanz — ein Kaltstart beginnt ohnehin leer.
 */
const VERBINDUNG_TTL_MS = 60_000;
const verbindungCache = new Map<string, { bis: number; wert: BrokerVerbindung | null }>();

/** Cache verwerfen — beim Verbinden/Trennen, damit die Änderung sofort greift. */
export function vergissVerbindung(uid: string): void {
  verbindungCache.delete(uid);
}

/**
 * Darf überhaupt an einen Echtgeld-Endpunkt geordert werden?
 *
 * Nur die Betreiber-Freigabe, bewusst OHNE die anderen beiden Guards
 * (`broker.mode: live` je Konto, Live-Reife) — die prüft `resolveBrokerMode`
 * weiterhin an seiner Stelle. Hier geht es um die grobe Frage: Ist auf
 * diesem Server Echtgeld überhaupt eingeschaltet? Solange nein, sind alle
 * feineren Prüfungen gegenstandslos, und ein hinterlegter Live-Schlüssel
 * darf keinen einzigen Order-Pfad erreichen.
 */
function echtgeldFreigegeben(): boolean {
  return process.env.ALPACA_ALLOW_LIVE === '1';
}

/**
 * Owner-Kill-Switch (M14): `meta/live.killSwitch` friert ALLE
 * Echtgeld-Order-Pfade ein — ein Klick im Admin-Panel, keine neue
 * Live-Order mehr, plattformweit.
 *
 * Warum zusätzlich zu `ALPACA_ALLOW_LIVE`: Die Env-Variable braucht ein
 * Deploy bzw. einen Secret-Rollout, um sich zu ändern — im Ernstfall
 * („die Engine kauft Unsinn, SOFORT stoppen") ist das zu langsam. Das
 * Firestore-Flag greift auf allen Instanzen binnen 60 s (Cache-TTL).
 *
 * Fail-CLOSED, bewusst nur hier: Wer den Schalter nicht LESEN kann, darf
 * nicht behaupten, er sei aus. Ein Firestore-Ausfall stoppt damit
 * Echtgeld-Orders — Paper-Routing und der lesende Abgleich sind nicht
 * betroffen, und das eigene Buch handelt ohnehin weiter. Die umgekehrte
 * Richtung (bei Lesefehler weiterhandeln) wäre die einzige Konstellation,
 * in der der Not-Aus genau dann versagt, wenn es brennt.
 */
const KILL_TTL_MS = 60_000;
let killCache: { bis: number; aktiv: boolean } | null = null;

/** Für Tests und den Admin-Schalter: Cache verwerfen. */
export function vergissKillSwitch(): void {
  killCache = null;
}

export async function killSwitchAktiv(jetztMs: number = Date.now()): Promise<boolean> {
  if (killCache && killCache.bis > jetztMs) return killCache.aktiv;
  try {
    const aktiv = (await getFirestore().doc('meta/live').get()).get('killSwitch') === true;
    killCache = { bis: jetztMs + KILL_TTL_MS, aktiv };
    return aktiv;
  } catch (err) {
    logger.error('killSwitchAktiv: meta/live nicht lesbar — Echtgeld vorsorglich angehalten', err);
    killCache = { bis: jetztMs + KILL_TTL_MS, aktiv: true };
    return true;
  }
}

/**
 * Verbindung eines Kontos laden — oder `null`, wenn keine hinterlegt ist.
 *
 * Die Sammlung `private/**` ist per Rules für JEDEN Client gesperrt; nur das
 * Admin-SDK liest hier. Ein fehlender Eintrag ist der Normalfall, kein
 * Fehler: Die allermeisten Konten handeln im eigenen Buch.
 *
 * ── Echtgeld-Verbindungen liefert diese Funktion NICHT aus ────────────────
 *
 * Seit dem 05.08. dürfen Echtgeld-Schlüssel in der App hinterlegt werden
 * (verschlüsselt, siehe `core/keyVault.ts`). Damit entsteht ein Weg, den es
 * vorher nicht gab: Ein `AK…`-Schlüssel im Dokument würde hier zu
 * `mode: 'live'` — und `routeOrder` schickte die nächste Order an den
 * ECHTGELD-Endpunkt, ohne dass jemand etwas scharf geschaltet hätte.
 *
 * Deshalb gibt diese Funktion, die ausschließlich das ORDER-Routing bedient,
 * bei einer Live-Verbindung `null` zurück, solange M14 verriegelt ist. Der
 * Trade läuft dann im eigenen Buch weiter — genau wie vorher.
 *
 * Für den LESENDEN Abgleich gibt es `brokerVerbindungLesend()`. Die Trennung
 * ist der ganze Punkt: „startklar, aber nicht scharf" heißt, das echte Depot
 * sehen zu können, ohne hineinzuhandeln.
 */
export async function brokerVerbindung(
  uid: string,
  jetztMs: number = Date.now(),
): Promise<BrokerVerbindung | null> {
  let z: BrokerZugang | null;
  try {
    z = await brokerZugang(uid, jetztMs);
  } catch {
    return null; // nicht lesbar ⇒ nicht routen (Vertrag des Order-Pfads: null heißt „keine Order")
  }
  if (!z) return null;
  if (z.sperre !== null) {
    if (z.sperre === SPERRE_FREIGABE) {
      // Bewusst nur `debug`: Bei jedem Takt eines Kontos mit hinterlegtem
      // Live-Schlüssel wäre eine Warnung Lärm, der echte Warnungen zudeckt.
      logger.debug(`brokerVerbindung ${uid}: Echtgeld hinterlegt, Handel verriegelt`);
    } else {
      // `warn`: Kill-Switch, fehlender Nutzer-Schalter oder fehlende Reife gehören ins Log.
      logger.warn(`brokerVerbindung ${uid}: Live-Schlüssel hinterlegt, aber ${z.sperre} — Order-Pfad verriegelt`);
    }
    return null;
  }
  return z.verbindung;
}

export const SPERRE_FREIGABE = 'Echtgeld auf diesem Server nicht freigegeben (ALPACA_ALLOW_LIVE)';
export const SPERRE_KILL_SWITCH = 'Kill-Switch aktiv';
export const SPERRE_SCHALTER = 'Nutzer-Schalter steht nicht auf live';
export const SPERRE_REIFE = 'Live-Reife fehlt';

/**
 * Warum der ORDER-Pfad dieses Kontos verriegelt ist — `null`, wenn er frei
 * ist. Für Papierkonten immer `null`; für Live-Konten die Kette aus
 * `brokerVerbindung` (Freigabe, Kill-Switch, Nutzer-Schalter, Reife), in
 * dieser Reihenfolge, fail-closed.
 *
 * Der Engine-Takt braucht den GRUND, nicht nur das Nein: Ein verriegeltes
 * Live-Konto wird nicht übersprungen, sondern mit Einstiegs-Sperre
 * betrieben — Abgleich, Schutz-Stops, Exits und Glattstellungen laufen
 * weiter (CLAUDE.md §0.4: Exits werden nie gesperrt).
 */
export async function livePfadSperre(uid: string, v: BrokerVerbindung, jetztMs: number = Date.now()): Promise<string | null> {
  if (v.mode !== 'live') return null;
  if (!echtgeldFreigegeben()) return SPERRE_FREIGABE;
  if (await killSwitchAktiv(jetztMs)) return SPERRE_KILL_SWITCH;
  /* Drei-Guard-Kette AUCH am Order-Pfad (Audit 13.08., K-1): Der Modus kommt
   * aus dem SCHLÜSSEL-Präfix (AK… ⇒ live), nicht aus einer Entscheidung des
   * Nutzers. Deshalb müssen der Nutzer-Schalter (`settings.strategy.broker.mode`)
   * und die Live-Reife JA sagen. Der rohe Feldwert genügt — ein unlesbares
   * oder fehlendes Feld ist KEIN 'live', die Kette versagt geschlossen. Die
   * zwei zusätzlichen Reads fallen nur für Konten mit Live-Schlüssel an. */
  const schalter = await getFirestore()
    .doc(`users/${uid}`)
    .get()
    .then((d) => d.get('settings.strategy.broker.mode') as unknown)
    .catch(() => null);
  const modus = schalter === 'live' ? 'live' : 'paper';
  const reife = modus === 'live' ? await reifeFuerKonto(uid) : undefined;
  if (resolveBrokerMode({ broker: { mode: modus } }, reife) !== 'live') {
    return modus !== 'live' ? SPERRE_SCHALTER : SPERRE_REIFE;
  }
  return null;
}

/** Verbindung eines Kontos plus Sperrgrund des Order-Pfads (null = frei). */
export interface BrokerZugang {
  verbindung: BrokerVerbindung;
  sperre: string | null;
}

/**
 * Zugang für den Engine-Takt: Verbindung (auch Live) UND der Sperrgrund des
 * Order-Pfads. `null` heißt: kein Broker hinterlegt oder nicht lesbar.
 * Wer eine Order senden will, prüft `sperre === null` — oder nimmt gleich
 * `brokerVerbindung()`.
 */
export async function brokerZugang(uid: string, jetztMs: number = Date.now()): Promise<BrokerZugang | null> {
  const v = await brokerVerbindungLesend(uid, jetztMs);
  if (!v) {
    // Lesefehler ist KEIN „kein Broker": Der Takt darf den Nutzer dann nicht als broker-los behandeln und seine
    // Kommandos (flatten/halt) verwerfen — er meldet ihn als gescheitert und versucht es im nächsten Takt erneut
    // (Secreview 3, #6).
    if (verbindungUnlesbar(uid)) throw new Error('Broker-Verbindung nicht lesbar (Firestore) — nächster Takt versucht es erneut');
    return null;
  }
  return { verbindung: v, sperre: await livePfadSperre(uid, v, jetztMs) };
}

/**
 * Dieselbe Verbindung — auch für Echtgeld, aber ausdrücklich nur zum LESEN.
 *
 * Aufrufer dieser Funktion dürfen `/v2/account` und `/v2/positions` abrufen.
 * Wer eine ORDER senden will, nimmt `brokerVerbindung()`. Der getrennte Name
 * ist die Absicherung: Ein künftiger Aufrufer muss sich aktiv für die
 * lesende Variante entscheiden, statt sie versehentlich zu erben.
 *
 * Keine Ausnahmen mehr: Der frühere Order-Sweep beim Trennen ist mit dem
 * alten Buch entfallen — Schutz-Stops liegen als Bracket-Beine beim Broker
 * und bleiben beim Trennen bewusst liegen (der Storno eines Schutz-Stops
 * GIBT Risiko, er nimmt keins). Über diese Verbindung erreicht ein Depot
 * kein einziger Schreibpfad.
 */
export async function brokerVerbindungLesend(
  uid: string,
  jetztMs: number = Date.now(),
): Promise<BrokerVerbindung | null> {
  const treffer = verbindungCache.get(uid);
  if (treffer && treffer.bis > jetztMs) return treffer.wert;
  try {
    const doc = await getFirestore().doc(`users/${uid}/private/broker`).get();
    const keyId = doc.get('keyId') as string | undefined;
    const gespeichert = doc.get('secretKey') as string | undefined;
    // Entschlüsseln (05.08.). `entschluessle` gibt Klartext-Altbestand
    // unverändert zurück und `null`, wenn ein Chiffrat nicht aufgeht —
    // falscher Hauptschlüssel oder manipulierte Daten. Beides darf nicht
    // als Zugangsdaten an einen Broker gehen.
    const secret = gespeichert ? entschluessle(gespeichert) : null;
    if (gespeichert && !secret) {
      logger.warn(`brokerVerbindung ${uid}: Geheimnis nicht entschlüsselbar`);
    }
    const wert: BrokerVerbindung | null =
      keyId && secret
        ? { mode: doc.get('mode') === 'live' ? 'live' : 'paper', schluessel: { keyId, secret } }
        : null;
    // Auch das NEGATIVE Ergebnis wird gemerkt: Konten ohne Broker sind der
    // Normalfall, und genau für sie wäre der Read je Trade reine Verschwendung.
    verbindungCache.set(uid, { bis: jetztMs + VERBINDUNG_TTL_MS, wert });
    // Gelesen heißt: kein Lesefehler mehr, egal was drinstand.
    unlesbar.delete(uid);
    return wert;
  } catch (err) {
    // Nicht lesbar heißt: nicht routen. Im eigenen Buch weiterhandeln ist
    // die sichere Richtung — eine Order zu senden, deren Konto man nicht
    // kennt, ist es nicht. Ein Fehler wird NICHT gecacht: Er kann vorübergehend
    // sein, und ein gemerkter Fehlschlag würde eine Minute lang jedes Routing
    // stillschweigend abschalten.
    logger.warn(`brokerVerbindung ${uid} nicht lesbar`, err);
    unlesbar.add(uid);
    return null;
  }

}

const unlesbar = new Set<string>();

/** War die letzte Leseprüfung dieses Kontos ein FEHLER (statt „kein Broker")? */
export function verbindungUnlesbar(uid: string): boolean {
  return unlesbar.has(uid);
}
