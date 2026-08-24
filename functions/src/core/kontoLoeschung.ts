/**
 * kontoLoeschung — ein gesperrtes/archiviertes Konto ENDGÜLTIG löschen.
 *
 * ── Wozu (Owner-Frage 24.08.) ──────────────────────────────────────────────
 *
 * „Ich finde es sollte möglich sein als Admin gesperrte Konten zu löschen …
 * sonst kommt es zu einer Vermüllung der Datenbank." Archivieren
 * (`accessLevel: 'archiviert'`, #443) ist eine ABLAGE — jederzeit
 * umkehrbar, nichts verschwindet. Diese Funktion ist das Gegenteil: Sie
 * erfüllt den DSGVO-Löschanspruch (Art. 17) und ist NICHT umkehrbar.
 *
 * ── Die zehn Vorbedingungen — jede frisch gemessen, keine vom Aufrufer
 *    übernommen ─────────────────────────────────────────────────────────
 *
 *  1. Aufrufer ist Admin              — geprüft im Callable (admin.ts).
 *  2. Ziel ist nicht der Aufrufer     — geprüft im Callable (targetRef()).
 *  3. Ziel ist selbst kein Admin      — sonst ließe sich der letzte Admin
 *     über die Hintertür entfernen; Admin-Konten müssen erst per
 *     `setAdmin` entmachtet werden (ein bewusster, sichtbarer Schritt).
 *  4. accessLevel ist blocked/archiviert — nur ABGELEGTE Konten, niemals
 *     ein aktives oder wartendes.
 *  5. Seit mindestens LOESCHUNG_MIN_TAGE in diesem Zustand — eine
 *     Karenzzeit, damit niemand aus Versehen oder im Affekt löscht, und
 *     damit der Kontoinhaber Zeit hat, eine Sperre zu bemerken und zu
 *     widersprechen. Ein fehlender/kaputter Zeitstempel blockiert — nicht
 *     verifizierbares Alter ist NICHT „alt genug".
 *  6. Kein Reset/Adopt/Löschung läuft gerade — derselbe `resetLaeuftSeit`-
 *     Marker wie bei `resetWallet`/`adoptBroker`.
 *  7. Keine offenen Positionen (`users/{uid}/positions`).
 *  8. Keine offenen `unbookedFills` — sonst liegt beim Broker echtes,
 *     noch nicht gebuchtes Geld/eine Position.
 *  9. Keine LIVE-Broker-Verbindung — Echtgeld-Orders werden NIE automatisch
 *     angefasst (dieselbe Regel wie in `orderRaeumung.ts`); eine
 *     Papier-Verbindung wird ÜBER `trenneBroker()` mit aufgeräumt
 *     (Order-Sweep + Depot-Freigabe, bereits gebaut und getestet).
 * 10. Bestätigungswort + eigenes Tageslimit — geprüft im Callable, bevor
 *     diese Funktion überhaupt gerufen wird.
 *
 * ── Reihenfolge der eigentlichen Löschung ──────────────────────────────────
 *
 * Marker ZUERST (wie bei reset.ts) → Broker aufräumen (`trenneBroker`,
 * löst auch `meta/brokerBindungen` — sonst bliebe das Papierdepot für immer
 * für niemanden mehr verbindbar) → Audit-Eintrag AUSSERHALB des Ziel-Baums,
 * VOR dem Löschen (der Baum, den er beschreibt, existiert danach nicht
 * mehr) → `recursiveDelete` auf den gesamten Firestore-Baum → zuletzt das
 * Auth-Konto. Auth zuletzt, nicht zuerst: Ein bereits ausgestelltes,
 * gültiges ID-Token könnte sonst bis zum Ablauf noch Callables erreichen,
 * die auf ein halb gelöschtes Firestore-Dokument schreiben.
 *
 * ── Was NICHT hier passiert ────────────────────────────────────────────────
 *
 * `meta/tradeFilter` und `meta/tuneGlobal` sind additive Zähler ganz ohne
 * Konto-Bezug (`FieldValue.increment` ohne uid im Datensatz) — ein
 * einzelner Beitrag lässt sich nicht zurückrechnen und bleibt anonym
 * bestehen. Das gehört in die Datenschutzerklärung, nicht in diese
 * Funktion: Es gibt nichts, das sie hier tun könnte.
 */
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { accessLevelOf, type AccessLevel } from './access.js';
import { resetLaeuft } from '../../../shared/src/index.js';
import { trenneBroker, type TrennErgebnis } from '../callable/connectBroker.js';
import { vergissVerbindung } from './orderRouting.js';

/** Das Wort, das getippt werden muss — dieselbe Idee wie RESET/ECHTGELD:
 *  ein Klick auf „Ja" wird weggeklickt, ohne gelesen zu werden; Tippen
 *  erzwingt einen bewussten Moment. Serverseitig geprüft. */
export const DELETE_CONFIRM_WORD = 'LOESCHEN';

/** Höchstens drei Löschungen am Tag — strenger als resetWallet (5/Tag):
 *  eine Löschung ist, anders als ein Reset, nicht umkehrbar. */
export const DAILY_DELETE_LIMIT = 3;

/** Karenzzeit: So lange muss ein Konto ununterbrochen blocked/archiviert
 *  sein, bevor es löschbar wird. */
export const LOESCHUNG_MIN_TAGE = 14;

export interface LoeschBefund {
  ok: true;
  uid: string;
  /** War ein Auth-Konto vorhanden und ist es jetzt gelöscht? `false` heißt:
   *  kein Auth-Konto gefunden (bereits weg) — kein Fehlschlag der
   *  Firestore-Löschung, die läuft in jedem Fall durch. */
  authGeloescht: boolean;
  /** Befund des Broker-Aufräumens (`trenneBroker`) — `undefined`, wenn nie
   *  eine Verbindung bestand. */
  broker?: TrennErgebnis;
}

/**
 * Die zehn Vorbedingungen (4–9 oben) gegen frisch gelesene Daten prüfen.
 * Wirft `HttpsError`, sonst gibt sie nichts zurück — derselbe Stil wie
 * `resetUserWallet`. Getrennt von der Firestore-Orchestrierung, damit sie
 * gegen konstruierte Eingaben pur testbar ist, ohne den Emulator zu
 * brauchen.
 */
export function pruefeLoeschVorbedingungen(params: {
  zielAdmin: boolean;
  zielDaten: Record<string, unknown> | undefined;
  jetzt: Date;
  hatPositionen: boolean;
  hatUnbookedFills: boolean;
  liveBrokerVerbunden: boolean;
}): void {
  const { zielAdmin, zielDaten, jetzt, hatPositionen, hatUnbookedFills, liveBrokerVerbunden } = params;

  if (zielAdmin) {
    throw new HttpsError('failed-precondition', 'srv.adminNichtLoeschbar');
  }

  const level: AccessLevel = accessLevelOf(zielDaten);
  if (level !== 'blocked' && level !== 'archiviert') {
    throw new HttpsError('failed-precondition', 'srv.nurGesperrteArchivierteLoeschbar');
  }

  const geaendertRoh = zielDaten?.['accessChangedAt'];
  const geaendertMs = typeof geaendertRoh === 'string' ? Date.parse(geaendertRoh) : NaN;
  // Kein/kaputter Zeitstempel blockiert — „nicht verifizierbar" ist NICHT
  // dasselbe wie „lange genug her".
  if (!Number.isFinite(geaendertMs)) {
    throw new HttpsError('failed-precondition', 'srv.loeschAlterUnbekannt');
  }
  const tageSeitAenderung = (jetzt.getTime() - geaendertMs) / 86_400_000;
  if (tageSeitAenderung < LOESCHUNG_MIN_TAGE) {
    throw new HttpsError('failed-precondition', `srv.loeschWartezeit|${LOESCHUNG_MIN_TAGE}`);
  }

  const risk = zielDaten?.['risk'];
  const marker =
    risk && typeof risk === 'object' ? (risk as Record<string, unknown>)['resetLaeuftSeit'] : undefined;
  if (resetLaeuft(marker, jetzt)) {
    throw new HttpsError('failed-precondition', 'srv.kontoGeradeInBearbeitung');
  }

  if (hatPositionen) {
    throw new HttpsError('failed-precondition', 'srv.nochOffenePositionen');
  }
  if (hatUnbookedFills) {
    throw new HttpsError('failed-precondition', 'srv.nochUngebuchteFills');
  }
  if (liveBrokerVerbunden) {
    throw new HttpsError('failed-precondition', 'srv.liveVerbindungVorLoeschung');
  }
}

/**
 * Die eigentliche Löschung — getrennt vom Callable, damit sie gegen echtes
 * Firestore prüfbar ist (derselbe Grund wie bei `resetUserWallet`).
 */
export async function loescheKonto(target: string, ausgefuehrtVon: string): Promise<LoeschBefund> {
  const db = getFirestore();
  const targetRef = db.doc(`users/${target}`);
  const jetzt = new Date();

  const snap = await targetRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'srv.unbekanntesKonto');
  const daten = snap.data();

  const [posSnap, unbookedSnap] = await Promise.all([
    targetRef.collection('positions').select().get(),
    targetRef.collection('unbookedFills').select().get(),
  ]);
  // Cache verwerfen — die Prüfung unten muss die FRISCHE Verbindung sehen,
  // nicht einen bis zu 60 s alten Eintrag aus einer anderen Instanz.
  vergissVerbindung(target);
  const brokerDoc = await db.doc(`users/${target}/private/broker`).get();
  const liveBrokerVerbunden = brokerDoc.exists && brokerDoc.get('mode') === 'live';

  pruefeLoeschVorbedingungen({
    zielAdmin: daten?.['admin'] === true,
    zielDaten: daten,
    jetzt,
    hatPositionen: !posSnap.empty,
    hatUnbookedFills: !unbookedSnap.empty,
    liveBrokerVerbunden,
  });

  /* Marker ZUERST, bevor irgendetwas verschwindet (dasselbe Muster wie
   * reset.ts) — hält Scan/Snapshot für RESET_SPERRE_MIN (10 min) fern,
   * lange genug für die wenigen Schritte unten. Anders als beim Reset gibt
   * es hier kein „danach wieder freigeben": Das Dokument existiert gleich
   * nicht mehr. */
  await targetRef
    .update(new FieldPath('risk', 'resetLaeuftSeit'), jetzt.toISOString())
    .catch((err: unknown) => {
      // Sollte nie eintreten (Dokument nachweislich vorhanden) — aber ein
      // Fehlschlag HIER darf keine Löschung ohne Marker-Schutz auslösen.
      throw new HttpsError('internal', 'srv.loeschMarkerFehlgeschlagen', String(err));
    });

  /* Broker aufräumen — nur Papier erreicht diesen Punkt (liveBrokerVerbunden
   * wurde oben geprüft): Order-Sweep + `meta/brokerBindungen`-Freigabe.
   * `trenneBroker` ist ein No-Op, wenn nie eine Verbindung bestand. */
  let broker: TrennErgebnis | undefined;
  try {
    const ergebnis = await trenneBroker(target);
    if (ergebnis.geloescht) broker = ergebnis;
  } catch (err) {
    logger.error(`kontoLoeschung ${target}: Broker-Aufräumen fehlgeschlagen — Löschung abgebrochen`, err);
    throw new HttpsError('internal', 'srv.loeschBrokerFehlgeschlagen');
  }

  /* Audit AUSSERHALB des Ziel-Baums, VOR dem Löschen — der Baum, den der
   * Eintrag beschreibt, existiert gleich nicht mehr. Top-Level-Collection
   * nach demselben Muster wie `admin/quotas-{uid}`/`meta/brokerBindungen`:
   * die uid steht als FELD, nicht als Pfad-Präfix. */
  const email = await getAuth()
    .getUser(target)
    .then((u) => u.email ?? null)
    .catch(() => null);
  await db.collection('adminAuditLog').add({
    art: 'kontoLoeschung',
    uid: target,
    email,
    accessLevelVorher: accessLevelOf(daten),
    accessChangedAtVorher: (daten?.['accessChangedAt'] as string | undefined) ?? null,
    geloeschtVon: ausgefuehrtVon,
    geloeschtAm: jetzt.toISOString(),
    brokerAufgeraeumt: broker !== undefined,
  });

  await db.recursiveDelete(targetRef);

  /* `admin/quotas-{uid}` liegt AUSSERHALB von `users/{uid}` (Top-Level-Doc,
   * `core/broker.ts` `consumeQuota`) — `recursiveDelete` oben erfasst es
   * nicht. Ohne diese Zeile bliebe genau das Waisen-Dokument zurück, das
   * diese Funktion verhindern soll (Nahtstellen-Befund 24.08.). `delete()`
   * auf ein nie existierendes Dokument ist ein folgenloses No-Op. */
  await db.doc(`admin/quotas-${target}`).delete();

  let authGeloescht = true;
  try {
    await getAuth().deleteUser(target);
  } catch (err) {
    // Kein Auth-Konto (schon gelöscht, nie eins gehabt) ist kein
    // Fehlschlag der — bereits abgeschlossenen — Firestore-Löschung.
    authGeloescht = false;
    logger.warn(`kontoLoeschung ${target}: Auth-Konto nicht entfernt (evtl. bereits weg)`, err);
  }

  logger.info(`kontoLoeschung ${target}: abgeschlossen (Admin ${ausgefuehrtVon})`);
  return { ok: true, uid: target, authGeloescht, ...(broker ? { broker } : {}) };
}
