/**
 * Minimaler Firestore-Vertrag des Engine-Takts.
 *
 * Der Takt programmiert gegen DIESE Schnittstelle, nicht gegen das Admin-SDK:
 * So laufen die Tests mit einem In-Memory-Fake (`functions/test/fakes/
 * firestore.ts`) ohne Emulator und ohne Netz, und der Produktionspfad reicht
 * `getFirestore()` unverändert durch — das echte SDK erfüllt den Vertrag
 * strukturell (die Signaturen sind bewusst weiter gefasst als die des SDK).
 *
 * Bewusst NICHT enthalten: FieldValue-Sentinels, Feldmasken, Streaming.
 * Was der Takt schreibt, schreibt er als ganzes Dokument oder per Merge.
 */
import { redact } from '../../../src/core/log.ts';

export type DocData = Record<string, unknown>;

export interface DocSnapLike {
  readonly exists: boolean;
  readonly id: string;
  readonly ref: DocRefLike;
  data(): DocData | undefined;
  /** Feld per Punktpfad (`settings.strategy.engine.running`). */
  get(field: string): unknown;
}

export interface QuerySnapLike {
  readonly docs: DocSnapLike[];
  readonly size: number;
  readonly empty: boolean;
}

export interface QueryLike {
  where(field: string, op: string, value: unknown): QueryLike;
  get(): Promise<QuerySnapLike>;
}

export interface CollRefLike extends QueryLike {
  readonly id: string;
  readonly path: string;
  /** Ohne `id`: neue Auto-ID. */
  doc(id?: string): DocRefLike;
}

export interface DocRefLike {
  readonly id: string;
  readonly path: string;
  get(): Promise<DocSnapLike>;
  set(data: DocData, options?: { merge?: boolean }): Promise<unknown>;
  update(data: DocData): Promise<unknown>;
  delete(): Promise<unknown>;
  collection(path: string): CollRefLike;
}

/**
 * Schreibsperre eines Nutzer-Laufs: Nach dem Zeitbudget (oder wenn der Takt den Lauf aufgegeben hat) darf
 * kein Firestore-Schreibvorgang mehr beginnen — sonst überschriebe der aufgegebene Lauf, sobald er wieder
 * CPU bekommt, den jüngeren Stand des nächsten Takts (Secreview 3, #2).
 */
export interface WriteGuard {
  allowed(): boolean;
  /** Wirft, wenn nicht mehr geschrieben werden darf. */
  assert(what: string): void;
}

export interface WriteBatchLike {
  set(ref: DocRefLike, data: DocData, options?: { merge?: boolean }): unknown;
  update(ref: DocRefLike, data: DocData): unknown;
  delete(ref: DocRefLike): unknown;
  commit(): Promise<unknown>;
}

export interface TransactionLike {
  get(ref: DocRefLike): Promise<DocSnapLike>;
  set(ref: DocRefLike, data: DocData, options?: { merge?: boolean }): unknown;
  update(ref: DocRefLike, data: DocData): unknown;
  delete(ref: DocRefLike): unknown;
}

export interface FirestoreLike {
  doc(path: string): DocRefLike;
  collection(path: string): CollRefLike;
  batch(): WriteBatchLike;
  runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T>;
}

/** Firestore-Batches fassen 500 Schreibvorgänge; Reserve für Nachzügler. */
export const BATCH_MAX = 450;

/**
 * Firestore will „plain" Werte: kein `undefined`, keine Klasseninstanzen,
 * kein Infinity — eine JSON-Rundreise erledigt das, und die Schwärzung
 * (`redact`) läuft gleich mit: Ein Fehlertext mit zurückgespiegeltem
 * Alpaca-Header darf auch in Firestore nicht landen.
 */
export function plain<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Dokument-ID zu einem Symbol: `/` ist in Firestore-IDs verboten (BTC/USD → BTC-USD). */
export function docIdFor(symbol: string): string {
  return symbol.replace(/\//g, '-');
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
