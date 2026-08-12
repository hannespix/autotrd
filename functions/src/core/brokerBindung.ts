/**
 * Depot-Bindung in Firestore — welches autotrd-Konto belegt welches Depot.
 *
 * Die Regel selbst steht in `shared/src/brokerBindung.ts` (pur und getestet);
 * hier liegt nur der Speicher dazu. Aufgeteilt wie überall im Projekt: Die
 * Entscheidung soll ohne Emulator prüfbar sein, die Persistenz an einer
 * Stelle stehen.
 *
 * ── Ablage ───────────────────────────────────────────────────────────────
 *
 *   meta/brokerBindungen  { <fingerabdruck>: { uid, at, mode } }
 *
 * EIN Dokument mit einer Map statt einer Sammlung: Der laufende Scan liest
 * es einmal je Lauf und nicht einmal je Konto. Bei sechs Konten sind das
 * fünf Reads weniger — dieselbe Rechnung wie bei `meta/classShadow`.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { pruefeBindung, type Bindung, type BindungsBefund } from '../../../shared/src/index.js';

/**
 * Fingerabdruck einer Broker-Konto-ID.
 *
 * SHA-256, gekürzt auf 32 Hex-Zeichen. Die volle Länge bringt hier nichts:
 * Verglichen werden Handvoll Werte auf Gleichheit, nicht Milliarden auf
 * Kollisionsfreiheit. Gekürzt bleibt das Dokument lesbar.
 *
 * Warum überhaupt hashen: Die Alpaca-Konto-ID ist kein Geheimnis wie ein
 * Schlüssel, aber sie identifiziert ein fremdes Konto. Für die Frage „ist
 * das dasselbe Depot?" genügt Gleichheit — und was nicht gespeichert wird,
 * kann nicht auslaufen.
 *
 * Der Modus geht MIT in den Hash: Papier- und Echtgeld-Depot desselben
 * Anbieters sind verschiedene Depots und dürfen sich nicht gegenseitig
 * sperren.
 */
export function fingerabdruck(kontoId: string | null | undefined, mode: string): string {
  const id = (kontoId ?? '').trim();
  if (!id) return '';
  return createHash('sha256').update(`${mode}:${id}`).digest('hex').slice(0, 32);
}

const REF = 'meta/brokerBindungen';

/** Alle Bindungen — ein Read. */
export async function leseBindungen(): Promise<Record<string, Bindung>> {
  try {
    const snap = await getFirestore().doc(REF).get();
    return (snap.get('depots') as Record<string, Bindung> | undefined) ?? {};
  } catch (err) {
    // Nie den Aufrufer scheitern lassen: Ein Lesefehler darf nicht dazu
    // führen, dass niemand mehr sein Konto verbinden kann. Der Riegel fällt
    // dann aus — sichtbar im Log, nicht still.
    logger.warn('Depot-Bindungen nicht lesbar', err);
    return {};
  }
}

/**
 * Darf `uid` dieses Depot benutzen? Reine Abfrage, schreibt nichts.
 */
export async function pruefeDepot(
  kontoId: string | null | undefined,
  mode: string,
  uid: string,
): Promise<BindungsBefund & { fingerabdruck: string }> {
  const fp = fingerabdruck(kontoId, mode);
  if (!fp) return { ok: true, zustand: 'frei', fingerabdruck: '' };
  const alle = await leseBindungen();
  return { ...pruefeBindung(fp, uid, alle[fp]), fingerabdruck: fp };
}

/**
 * Depot auf `uid` eintragen.
 *
 * In einer Transaktion, und die Prüfung wiederholt sich DARIN: Zwischen
 * `pruefeDepot` und dem Schreiben liegen Netzwerk-Millisekunden, in denen
 * ein zweiter Verbinden-Aufruf dasselbe Depot belegen kann. Genau dieses
 * Rennen soll der Riegel verhindern — es außerhalb der Transaktion zu
 * prüfen hieße, ihn an der einzigen Stelle offen zu lassen, an der er
 * gebraucht wird.
 */
export async function bindeDepot(
  kontoId: string | null | undefined,
  mode: string,
  uid: string,
  jetzt: Date = new Date(),
): Promise<BindungsBefund> {
  const fp = fingerabdruck(kontoId, mode);
  if (!fp) return { ok: true, zustand: 'frei' };
  const db = getFirestore();
  const ref = db.doc(REF);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const alle = (snap.get('depots') as Record<string, Bindung> | undefined) ?? {};
    const befund = pruefeBindung(fp, uid, alle[fp]);
    if (!befund.ok) return befund;
    tx.set(
      ref,
      { depots: { [fp]: { uid, at: jetzt.toISOString(), mode } }, updatedAt: jetzt.toISOString() },
      { merge: true },
    );
    return befund;
  });
}

/**
 * Bindung eines Kontos lösen — beim Trennen der Broker-Verbindung.
 *
 * Löscht NUR, wenn das Depot auch diesem Konto gehört. Sonst könnte ein
 * Nutzer die Bindung eines fremden Kontos aufheben und sich danach selbst
 * eintragen — der Riegel wäre in zwei Schritten zu umgehen.
 */
export async function loeseDepot(
  kontoId: string | null | undefined,
  mode: string,
  uid: string,
): Promise<void> {
  const fp = fingerabdruck(kontoId, mode);
  if (!fp) return;
  const db = getFirestore();
  const ref = db.doc(REF);
  await db
    .runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const alle = (snap.get('depots') as Record<string, Bindung> | undefined) ?? {};
      if (alle[fp]?.uid !== uid) return;
      const rest = { ...alle };
      delete rest[fp];
      tx.set(ref, { depots: rest, updatedAt: new Date().toISOString() });
    })
    .catch((err: unknown) => logger.warn(`Depot-Bindung ${uid} nicht gelöst`, err));
}
