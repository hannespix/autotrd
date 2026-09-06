/**
 * Kommandos an die Engine eines Nutzers: halt · resume · flatten.
 *
 * Der Weg: Das Callable `engineCommand` schreibt nach
 * `users/{uid}/private/engineCommands` (Merge); der Takt BEANSPRUCHT das Doc
 * je Nutzer nach `engine.start()` in einer Transaktion (lesen + löschen) und
 * führt die Kommandos danach aus. Beanspruchen-vor-Ausführen heißt: Ein
 * Kommando läuft höchstens einmal — scheitert die Ausführung, steht der
 * Fehler im Journal, und der Nutzer setzt es bewusst erneut ab. Die
 * Gegenrichtung (erst ausführen, dann löschen) könnte ein `flatten` bei
 * einem Absturz zwischen beidem im nächsten Takt wiederholen.
 *
 * Regeln (CLAUDE.md §0.5): Sperren löst man über die Ursache. `resume`
 * hebt einen Tages-Halt NIE auf (er endet am nächsten Handelstag von selbst)
 * und einen Drawdown-Halt nur mit ausdrücklicher Bestätigung (`ackDrawdown`).
 */
import type { JournalLike } from '../../../src/core/journal.ts';
import type { ExitReason, HaltState, Ms } from '../../../src/core/types.ts';
import { isRecord, isoOf, type FirestoreLike } from './firestoreLike.js';

export type CommandAction = 'halt' | 'resume' | 'flatten';
export const COMMAND_ACTIONS: readonly CommandAction[] = ['halt', 'resume', 'flatten'];

export interface CommandRequest {
  action: CommandAction;
  reason?: string;
  ackDrawdown?: boolean;
}

export interface CommandDoc {
  halt?: { at: string; reason?: string | null };
  resume?: { at: string; ack?: boolean; reason?: string | null };
  flatten?: { at: string; reason?: string | null };
}

export function commandsPath(uid: string): string {
  return `users/${uid}/private/engineCommands`;
}

const REASON_MAX = 200;

/** Eingabe des Callables prüfen — wirft bei allem, was kein Kommando ist. */
export function parseCommandRequest(data: unknown): CommandRequest {
  if (!isRecord(data)) throw new Error('Kommando: Objekt erwartet');
  const action = data.action;
  if (typeof action !== 'string' || !COMMAND_ACTIONS.includes(action as CommandAction)) {
    throw new Error(`Kommando: action muss eines von ${COMMAND_ACTIONS.join(', ')} sein`);
  }
  const out: CommandRequest = { action: action as CommandAction };
  if (data.reason !== undefined) {
    if (typeof data.reason !== 'string') throw new Error('Kommando: reason muss ein Text sein');
    out.reason = data.reason.trim().slice(0, REASON_MAX);
  }
  if (data.ackDrawdown !== undefined) {
    if (typeof data.ackDrawdown !== 'boolean') throw new Error('Kommando: ackDrawdown muss boolean sein');
    out.ackDrawdown = data.ackDrawdown;
  }
  return out;
}

/** Merge-Patch fürs Kommando-Doc: `{halt:{at,reason}}` · `{resume:{at,ack}}` · `{flatten:{at}}`. */
export function commandPatch(req: CommandRequest, now: Ms): Record<string, unknown> {
  const at = isoOf(now);
  switch (req.action) {
    case 'halt':
      return { halt: { at, reason: req.reason ?? null } };
    case 'resume':
      return { resume: { at, ack: req.ackDrawdown === true, reason: req.reason ?? null } };
    case 'flatten':
      return { flatten: { at, reason: req.reason ?? null } };
  }
}

/** Doc-Inhalt in ein Kommando-Objekt; leer/unbrauchbar ⇒ null. */
export function commandDocFrom(data: unknown): CommandDoc | null {
  if (!isRecord(data)) return null;
  const out: CommandDoc = {};
  for (const action of COMMAND_ACTIONS) {
    const v = data[action];
    if (!isRecord(v) || typeof v.at !== 'string') continue;
    const reason = typeof v.reason === 'string' ? v.reason : null;
    if (action === 'halt') out.halt = { at: v.at, reason };
    else if (action === 'resume') out.resume = { at: v.at, ack: v.ack === true, reason };
    else out.flatten = { at: v.at, reason };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Kommando-Doc lesen UND löschen (eine Transaktion) — der Aufrufer führt aus. */
export async function claimCommands(db: FirestoreLike, uid: string): Promise<CommandDoc | null> {
  const ref = db.doc(commandsPath(uid));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const cmds = commandDocFrom(snap.data());
    tx.delete(ref);
    return cmds;
  });
}

/** Was ein Kommando von der Engine braucht — `Engine` erfüllt das; Tests reichen ein Fake. */
export interface CommandTarget {
  halt(note: string): Promise<void>;
  resume(note: string): Promise<void>;
  flatten(reason: ExitReason): Promise<void>;
  status(): { halt: HaltState };
}

export interface CommandOutcome {
  action: CommandAction;
  applied: boolean;
  note: string;
}

const withReason = (base: string, reason: string | null | undefined): string => (reason ? `${base}: ${reason}` : base);

/** Kommandos in der Reihenfolge ihres Absetzens ausführen; jedes Ergebnis steht im Journal. */
export async function applyCommands(engine: CommandTarget, cmds: CommandDoc, journal: JournalLike, now: Ms): Promise<CommandOutcome[]> {
  const list: Array<{ action: CommandAction; at: string }> = [];
  if (cmds.halt) list.push({ action: 'halt', at: cmds.halt.at });
  if (cmds.resume) list.push({ action: 'resume', at: cmds.resume.at });
  if (cmds.flatten) list.push({ action: 'flatten', at: cmds.flatten.at });
  list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const out: CommandOutcome[] = [];
  for (const { action, at } of list) {
    let outcome: CommandOutcome;
    try {
      outcome = await applyOne(engine, action, cmds);
    } catch (e) {
      outcome = { action, applied: false, note: `Fehler: ${e instanceof Error ? e.message : String(e)}` };
    }
    journal.append('note', { text: `Kommando ${action}: ${outcome.note}`, command: action, applied: outcome.applied, issuedAt: at }, now);
    out.push(outcome);
  }
  return out;
}

async function applyOne(engine: CommandTarget, action: CommandAction, cmds: CommandDoc): Promise<CommandOutcome> {
  const h = engine.status().halt;
  switch (action) {
    case 'halt': {
      if (h.halted) return { action, applied: false, note: `bereits gesperrt (${h.reason ?? '?'}) — Kommando ohne Wirkung` };
      await engine.halt(withReason('Kommando halt', cmds.halt?.reason));
      return { action, applied: true, note: 'Halt (manual) gesetzt — keine Einstiege, Exits laufen weiter' };
    }
    case 'resume': {
      if (!h.halted) return { action, applied: false, note: 'kein Halt aktiv — nichts aufzuheben' };
      if (h.reason === 'daily_loss') return { action, applied: false, note: 'Tages-Halt endet von selbst am nächsten Handelstag — resume ignoriert' };
      if (h.reason === 'drawdown' && cmds.resume?.ack !== true) {
        return { action, applied: false, note: 'Drawdown-Halt braucht ackDrawdown=true (Peak wird neu gesetzt) — resume ignoriert' };
      }
      await engine.resume(withReason(`Kommando resume (${h.reason ?? '?'})`, cmds.resume?.reason));
      return { action, applied: true, note: `Halt (${h.reason ?? '?'}) aufgehoben, Peak auf aktuelle Equity gesetzt` };
    }
    case 'flatten': {
      await engine.flatten('manual');
      return { action, applied: true, note: 'flatten (manual) — Orders storniert/Positionen geschlossen bzw. bis zur Eröffnung zurückgestellt' };
    }
  }
}
