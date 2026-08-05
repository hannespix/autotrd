/**
 * Verschlüsselte Ablage der Broker-Zugangsdaten (05.08.).
 *
 * ── Warum das gebraucht wird ──────────────────────────────────────────────
 *
 * Bis heute lagen die Alpaca-Schlüssel im KLARTEXT in Firestore. Die
 * Firestore-Regeln sperren jeden Client von `private/**` aus, und das reicht
 * gegen den offensichtlichen Angriff — aber nicht gegen die drei, auf die es
 * bei echtem Geld ankommt:
 *
 *   · Ein Datenbank-Export (Backup, Migration, Debugging) trägt sie mit.
 *   · Ein kompromittierter Service-Account liest sie in einem Rutsch.
 *   · Jeder mit Konsolen-Zugriff sieht sie im Klartext im Browser.
 *
 * Für Papiergeld ist das vertretbar: Der schlimmste Fall ist ein fremdes
 * simuliertes Depot. Für Echtgeld ist es das nicht, und genau daran hing
 * die Ablehnung von `AK…`-Schlüsseln in der App.
 *
 * ── Was hier passiert ─────────────────────────────────────────────────────
 *
 * AES-256-GCM mit einem Hauptschlüssel aus dem Secret Manager. In Firestore
 * landet nur `v1:<iv>:<tag>:<chiffrat>` — ein Export enthält Base64-Salat.
 * GCM statt CBC, weil es AUTHENTIFIZIERT: Ein manipuliertes Chiffrat wird
 * beim Entschlüsseln erkannt, statt stillschweigend Müll zu liefern, den
 * dann jemand als Schlüssel an einen Broker schickt.
 *
 * ── Was das NICHT ist ─────────────────────────────────────────────────────
 *
 * Kein KMS. Bei Cloud KMS verlässt der Hauptschlüssel nie das HSM; hier
 * liegt er zur Laufzeit im Speicher der Function. Der Unterschied ist real
 * und soll nicht verschwiegen werden: Wer die laufende Function
 * kompromittiert, kommt an beides. Was diese Lösung leistet, ist die
 * Trennung von DATEN und SCHLÜSSEL — ein Firestore-Leak allein ist
 * wertlos, und das ist der Angriff, der tatsächlich passiert.
 *
 * KMS bleibt der nächste Schritt, wenn Echtgeld über einzelne Konten
 * hinausgeht. Bis dahin ist dies der richtige Kompromiss: eine Größenordnung
 * besser als Klartext, ohne IAM-Aufbau, der bei einem Fehler schlechter
 * absichert als das, was er ersetzt.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** Name der Umgebungsvariablen (Secret Manager) mit dem Hauptschlüssel. */
export const VAULT_ENV = 'BROKER_MASTER_KEY';

/** Kennzeichnung des Formats — erlaubt späteren Wechsel ohne Ratespiel. */
const PRAEFIX = 'v1';

/**
 * Hauptschlüssel lesen und prüfen.
 *
 * Gibt `null` zurück, wenn keiner hinterlegt ist — das ist der Zustand vor
 * dem ersten `firebase functions:secrets:set` und KEIN Fehler: Papierkonten
 * funktionieren dann weiter wie bisher, nur Echtgeld bleibt gesperrt.
 *
 * Ein zu kurzer Schlüssel wird abgelehnt statt aufgefüllt. Ein auf 32 Byte
 * gepolstertes Passwort sieht aus wie Verschlüsselung und ist keine.
 */
export function hauptschluessel(): Buffer | null {
  const roh = process.env[VAULT_ENV];
  if (!roh || roh.trim().length === 0) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(roh.trim(), 'base64');
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null;
}

/** Steht die verschlüsselte Ablage bereit? Entscheidet über Echtgeld-Keys. */
export function vaultBereit(): boolean {
  return hauptschluessel() !== null;
}

/**
 * Klartext verschlüsseln.
 *
 * Wirft, wenn kein Hauptschlüssel da ist — bewusst KEIN stiller Rückfall auf
 * Klartext. Ein Aufrufer, der glaubt zu verschlüsseln, aber Klartext
 * speichert, ist schlimmer als einer, der weiß, dass er es nicht kann.
 */
export function verschluessle(klartext: string): string {
  const key = hauptschluessel();
  if (!key) throw new Error(`${VAULT_ENV} fehlt — Verschlüsselung nicht möglich`);
  // 12 Byte IV: die für GCM empfohlene Länge. Bei jedem Aufruf neu — ein
  // wiederverwendeter IV bricht GCM vollständig.
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const chiffrat = Buffer.concat([c.update(klartext, 'utf8'), c.final()]);
  return [
    PRAEFIX,
    iv.toString('base64'),
    c.getAuthTag().toString('base64'),
    chiffrat.toString('base64'),
  ].join(':');
}

/**
 * Gespeicherten Wert lesen — versteht Chiffrat UND Klartext-Altbestand.
 *
 * Der Altbestand ist der Grund für die Formprüfung statt eines Flags am
 * Dokument: Die Papier-Schlüssel, die vor dem 05.08. gespeichert wurden,
 * liegen im Klartext, und sie müssen weiter funktionieren, bis die
 * Migration sie ersetzt hat. Ein Wert ohne `v1:`-Präfix ist Altbestand.
 *
 * `null` bei kaputtem Chiffrat: Ein Entschlüsselungsfehler heißt entweder
 * falscher Hauptschlüssel oder manipulierte Daten. Beides darf NICHT als
 * Zugangsdaten an einen Broker gehen.
 */
export function entschluessle(gespeichert: string): string | null {
  if (!gespeichert.startsWith(`${PRAEFIX}:`)) return gespeichert; // Altbestand
  const key = hauptschluessel();
  if (!key) return null;
  const teile = gespeichert.split(':');
  if (teile.length !== 4) return null;
  try {
    const iv = Buffer.from(teile[1]!, 'base64');
    const tag = Buffer.from(teile[2]!, 'base64');
    const chiffrat = Buffer.from(teile[3]!, 'base64');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(chiffrat), d.final()]).toString('utf8');
  } catch {
    // `final()` wirft, wenn das Authentifizierungs-Tag nicht passt — genau
    // der Schutz, für den GCM da ist.
    return null;
  }
}

/** Liegt der Wert bereits verschlüsselt vor? Steuert die Migration. */
export function istVerschluesselt(gespeichert: string): boolean {
  return gespeichert.startsWith(`${PRAEFIX}:`);
}

/**
 * Zwei Geheimnisse zeitkonstant vergleichen.
 *
 * Wird beim Umschlüsseln gebraucht: Nach dem Verschlüsseln wird einmal
 * zurückgelesen und geprüft, ob dasselbe herauskommt. Ein normaler
 * `===`-Vergleich bricht beim ersten abweichenden Zeichen ab und verrät
 * über die Laufzeit, wie viel schon stimmte.
 */
export function gleich(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
