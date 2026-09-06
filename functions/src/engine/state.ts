/**
 * Engine-State je Nutzer in Firestore: `users/{uid}/private/engineState`.
 *
 * `private/**` ist per Rules für jeden Client dicht; nur das Admin-SDK liest
 * und schreibt hier. Der State ist der Snapshot der Engine (Buch, Sperren,
 * offene Einstiege, zurückgestellte Intents) — dieselbe Struktur wie
 * `state.json` im Dauerprozess, nur dass hier Firestore das Blatt ist.
 *
 * Ein unlesbares Dokument (falsche Version, fremder Inhalt) wirft: Die Engine
 * würde sonst mit leerem Buch starten, den Bestand beim Broker als
 * Fremdbestand sehen und die Sperre 'reconcile' ziehen — fail-closed ist
 * richtig, aber ein lauter Fehler je Takt ist dem Owner mehr wert als eine
 * stille Sperre. Keine Secrets im State.
 */
import type { EngineState, StateStoreLike } from '../../../src/core/journal.ts';
import { plain, type DocData, type DocRefLike, type FirestoreLike } from './firestoreLike.js';

export function engineStatePath(uid: string): string {
  return `users/${uid}/private/engineState`;
}

export class FirestoreStateStore implements StateStoreLike {
  private readonly ref: DocRefLike;

  constructor(db: FirestoreLike, uid: string) {
    this.ref = db.doc(engineStatePath(uid));
  }

  async load(): Promise<EngineState | null> {
    const snap = await this.ref.get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (!d || d.version !== 1 || (d.mode !== 'paper' && d.mode !== 'live')) {
      throw new Error(`${this.ref.path}: unlesbarer Engine-State (version ${String(d?.version)}, mode ${String(d?.mode)}) — Dokument prüfen statt überschreiben`);
    }
    return d as unknown as EngineState;
  }

  async save(state: EngineState): Promise<void> {
    state.updatedAt = Date.now();
    await this.ref.set(plain(state) as unknown as DocData);
  }
}
