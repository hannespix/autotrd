/**
 * Engine-State je Nutzer in Firestore: `users/{uid}/private/engineState`.
 *
 * `private/**` ist per Rules für jeden Client dicht; nur das Admin-SDK liest
 * und schreibt hier. Der State ist der Snapshot der Engine (Buch, Sperren,
 * offene Einstiege, laufende Exits, zurückgestellte Intents) — dieselbe
 * Struktur wie `state.json` im Dauerprozess, nur dass hier Firestore das
 * Blatt ist.
 *
 * Journal-Puffer im State (Secreview 2, M5): Jeder `save()` schreibt die noch
 * ungeschriebenen Journal-Ereignisse des Takts als `journalBuffer` mit ins
 * State-Doc. Scheitert der Journal-Batch danach oder stirbt die Function,
 * liest der nächste Takt den Puffer beim `load()` zurück und schreibt ihn
 * nach — `fill`/`trade_closed` (Trade-Docs für Steuer und Live-Reife) gehen
 * so nicht mit dem Prozess verloren. Geleert wird der Puffer im SELBEN Batch
 * wie die Journal-Docs (`bufferClearOp`), nie davor.
 *
 * Ein unlesbares Dokument (falsche Version, fremder Inhalt) wirft: Die Engine
 * würde sonst mit leerem Buch starten, den Bestand beim Broker als
 * Fremdbestand sehen und die Sperre 'reconcile' ziehen — fail-closed ist
 * richtig, aber ein lauter Fehler je Takt ist dem Owner mehr wert als eine
 * stille Sperre. Die Fehlertexte nennen den Pfad NICHT (die uid stünde
 * sonst im öffentlichen `meta/health`, Secreview 2 M1). Keine Secrets im State.
 */
import type { EngineState, JournalEvent, StateStoreLike } from '../../../src/core/journal.ts';
import type { Ms } from '../../../src/core/types.ts';
import { isoOf, plain, type DocData, type DocRefLike, type FirestoreLike, type WriteBatchLike, type WriteGuard } from './firestoreLike.js';

export function engineStatePath(uid: string): string {
  return `users/${uid}/private/engineState`;
}

/** Archiv abgelöster States (Konto-/Moduswechsel): `users/{uid}/private/archiv/engineStates/{iso}`. */
export function engineStateArchivePath(uid: string, now: Ms): string {
  return `users/${uid}/private/archiv/engineStates/${isoOf(now).replace(/[:.]/g, '-')}`;
}

/** Obergrenze des Puffers im State-Doc (1 MiB Doc-Limit); darüber fallen die ältesten Ereignisse weg. */
export const JOURNAL_BUFFER_MAX = 2000;

/** Was der State-Speicher vom Journal braucht: die ungeschriebenen Ereignisse lesen und nach einem Absturz zurückspielen. */
export interface JournalBufferLike {
  pendingEvents(): JournalEvent[];
  restore(events: JournalEvent[]): void;
}

export class FirestoreStateStore implements StateStoreLike {
  private readonly db: FirestoreLike;
  private readonly uid: string;
  private readonly ref: DocRefLike;
  private readonly journal: JournalBufferLike | null;
  private readonly guard: WriteGuard | null;
  /** true, solange auf dem Doc ein (geladener oder geschriebener) Journal-Puffer liegt. */
  private bufferOnDoc = false;

  constructor(db: FirestoreLike, uid: string, o: { journal?: JournalBufferLike | undefined; guard?: WriteGuard | undefined } = {}) {
    this.db = db;
    this.uid = uid;
    this.ref = db.doc(engineStatePath(uid));
    this.journal = o.journal ?? null;
    this.guard = o.guard ?? null;
  }

  async load(): Promise<EngineState | null> {
    const snap = await this.ref.get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (!d || d.version !== 1 || (d.mode !== 'paper' && d.mode !== 'live')) {
      throw new Error(`Engine-State unlesbar (version ${String(d?.version)}, mode ${String(d?.mode)}) — Dokument prüfen statt überschreiben`);
    }
    const { journalBuffer, ...state } = d;
    if (Array.isArray(journalBuffer) && journalBuffer.length > 0) {
      this.bufferOnDoc = true;
      if (this.journal) this.journal.restore(journalBuffer.filter(isJournalEvent));
    }
    return state as unknown as EngineState;
  }

  async save(state: EngineState): Promise<void> {
    this.guard?.assert('State');
    state.updatedAt = Date.now();
    const pending = this.journal?.pendingEvents() ?? [];
    const journalBuffer = pending.length > JOURNAL_BUFFER_MAX ? pending.slice(pending.length - JOURNAL_BUFFER_MAX) : pending;
    await this.ref.set(plain({ ...state, journalBuffer }) as unknown as DocData);
    this.bufferOnDoc = journalBuffer.length > 0;
  }

  /**
   * Batch-Operation, die den Journal-Puffer auf dem State-Doc leert — gehört in DENSELBEN Batch wie die
   * Journal-Docs (Atomarität: entweder beides oder nichts). null, wenn nichts zu leeren ist.
   */
  bufferClearOp(): ((b: WriteBatchLike) => void) | null {
    if (!this.bufferOnDoc) return null;
    return (b) => {
      this.guard?.assert('Journal-Puffer');
      b.update(this.ref, { journalBuffer: [] });
    };
  }

  /** Nach einem erfolgreichen Batch mit `bufferClearOp`. */
  markBufferCleared(): void {
    this.bufferOnDoc = false;
  }

  /**
   * State ablösen (Konto-/Moduswechsel): Kopie ins Archiv, Original löschen. Positionen des alten Kontos
   * bleiben beim alten Broker samt Schutz-Stops — sie gehören nicht mehr zu diesem Buch.
   */
  async archive(now: Ms, reason: string): Promise<string | null> {
    this.guard?.assert('State-Archiv');
    const snap = await this.ref.get();
    if (!snap.exists) return null;
    const path = engineStateArchivePath(this.uid, now);
    const batch = this.db.batch();
    batch.set(this.db.doc(path), plain({ ...(snap.data() ?? {}), archivedAt: isoOf(now), archiveReason: reason }) as unknown as DocData);
    batch.delete(this.ref);
    await batch.commit();
    this.bufferOnDoc = false;
    return path;
  }
}

function isJournalEvent(x: unknown): x is JournalEvent {
  return typeof x === 'object' && x !== null && typeof (x as { kind?: unknown }).kind === 'string' && typeof (x as { ts?: unknown }).ts === 'number';
}
