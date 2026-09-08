/**
 * Journal (append-only JSONL) und State (atomar geschriebenes JSON).
 *
 * Das Journal ist die Wahrheit über das, was die Engine getan hat:
 * Entscheidungen, Orders, Fills, Halts, Fehler. Es wird nie umgeschrieben.
 * Der State ist ein Snapshot für Neustarts und für `autotrd status`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExitReason, HaltState, Ms, PositionState, Trade } from './types.ts';
import { redact } from './log.ts';

export type JournalEventKind =
  | 'start'
  | 'stop'
  | 'decision'
  | 'intent'
  | 'order_submitted'
  | 'order_update'
  | 'fill'
  | 'trade_closed'
  | 'halt'
  | 'resume'
  | 'reconcile'
  | 'error'
  | 'notify'
  | 'champion'
  | 'note';

export interface JournalEvent {
  ts: Ms;
  kind: JournalEventKind;
  [key: string]: unknown;
}

/**
 * Minimalvertrag des State-Speichers: Datei (`StateStore`) oder Firestore
 * (Functions-Takt). `load`/`save` dürfen asynchron sein — die Engine wartet
 * an jeder Stelle darauf.
 */
export interface StateStoreLike {
  load(): Promise<EngineState | null> | EngineState | null;
  save(state: EngineState): Promise<void> | void;
}

/** Minimalvertrag des Journals: Datei (`Journal`) oder gepufferter Firestore-Schreiber. */
export interface JournalLike {
  append(kind: JournalEventKind, data?: Record<string, unknown>, ts?: Ms): void;
  readAll(): JournalEvent[];
  trades(): Trade[];
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Atomar schreiben: temporäre Datei + rename, damit nie ein halber State liegt. `compact` für große Datendateien (Bars-Cache). */
export function writeJsonAtomic(path: string, value: unknown, opts: { compact?: boolean } = {}): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, opts.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return null;
  return JSON.parse(text) as T;
}

export class Journal implements JournalLike {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    ensureDir(dirname(path));
  }

  append(kind: JournalEventKind, data: Record<string, unknown> = {}, ts: Ms = Date.now()): void {
    // `ts`/`kind` gewinnen: Ein Datenfeld namens `kind` darf den Ereignistyp nicht überschreiben.
    const ev: JournalEvent = { ...data, ts, kind };
    appendFileSync(this.path, redact(JSON.stringify(ev)) + '\n');
  }

  /** Alle Ereignisse lesen (für Auswertung/Live-Reife). Kaputte Zeilen werden übersprungen. */
  readAll(): JournalEvent[] {
    if (!existsSync(this.path)) return [];
    const out: JournalEvent[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalEvent);
      } catch {
        // kaputte Zeile (z. B. Absturz mitten im Schreiben) — bewusst überspringen
        continue;
      }
    }
    return out;
  }

  /** Abgeschlossene Trades aus dem Journal. */
  trades(): Trade[] {
    return this.readAll()
      .filter((e) => e.kind === 'trade_closed')
      .map((e) => e.trade as Trade);
  }
}

/**
 * Laufender eigener Exit — persistiert, damit der Wiederholversuch einen
 * Neustart bzw. den nächsten Functions-Takt überlebt (Secreview 2, K2: Ein
 * im Auslöse-Takt gescheiterter Notbremsen-Exit wurde sonst nie wiederholt).
 */
export interface PendingExitState {
  clientId: string | null;
  orderId: string | null;
  reason: ExitReason;
  since: Ms;
  attempts: number;
  lastAttemptAt: Ms;
  lastError: string | null;
  intent: { kind: 'exit'; symbol: string; reason: ExitReason; decidedAt: Ms } | null;
}

/** Persistenter Engine-Zustand (Snapshot). */
export interface EngineState {
  version: 1;
  mode: 'paper' | 'live';
  updatedAt: Ms;
  /** ET-Tag, für den dayStartEquity gilt. */
  day: string;
  dayStartEquity: number;
  peakEquity: number;
  halt: HaltState;
  positions: Record<string, PositionState>;
  /** Symbol → client_order_id der offenen Einstiegs-Order (Idempotenz über Neustarts). */
  pendingEntries: Record<string, string>;
  /** Symbol → client_order_id des Schutz-Stops beim Broker. */
  protectiveOrders: Record<string, string>;
  /** Symbol → laufender eigener Exit (Wiederholversuch). Additiv seit Secreview 2; fehlt in älteren States. */
  pendingExits?: Record<string, PendingExitState>;
  /**
   * Symbol → (Broker-Order-ID → bereits gebuchte Exit-Menge). Macht Fill-Buchungen über Neustart und Takt
   * hinweg idempotent — ein Teilfill wurde sonst nach jedem Start erneut gebucht (Secreview 3, #3). Additiv.
   */
  bookedExitQty?: Record<string, Record<string, number>>;
  /** Alpaca-Konto-ID, zu der dieser State gehört (additiv; fehlt in älteren States). Fremdes Konto ⇒ fail-closed. */
  accountId?: string;
  consecutiveErrors: number;
  /** Lokal gezählte Daytrades (ET-Tag → Anzahl), Ergänzung zur Broker-Zahl. */
  dayTrades: Record<string, number>;
  lastBarAt: Record<string, Ms>;
}

export function emptyState(mode: 'paper' | 'live', day: string, equity: number): EngineState {
  return {
    version: 1,
    mode,
    updatedAt: Date.now(),
    day,
    dayStartEquity: equity,
    peakEquity: equity,
    halt: { halted: false, reason: null, since: null, until: null, note: null },
    positions: {},
    pendingEntries: {},
    protectiveOrders: {},
    pendingExits: {},
    bookedExitQty: {},
    consecutiveErrors: 0,
    dayTrades: {},
    lastBarAt: {},
  };
}

export class StateStore implements StateStoreLike {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  load(): EngineState | null {
    return readJson<EngineState>(this.path);
  }

  save(state: EngineState): void {
    state.updatedAt = Date.now();
    writeJsonAtomic(this.path, state);
  }
}

export interface HomePaths {
  home: string;
  state: string;
  journal: string;
  champion: string;
  bars: string;
  calendar: string;
  reports: string;
  haltFlag: string;
  /** Ergebnis der nächtlichen Universums-Auswahl (siehe src/universe/). */
  universe: string;
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    state: join(home, 'state.json'),
    journal: join(home, 'journal.jsonl'),
    champion: join(home, 'champion.json'),
    bars: join(home, 'bars'),
    calendar: join(home, 'calendar.json'),
    reports: join(home, 'reports'),
    haltFlag: join(home, 'HALT'),
    universe: join(home, 'universe.json'),
  };
}
