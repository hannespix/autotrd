/**
 * In-Memory-Firestore für die Takt-Tests: Dokumente als Map Pfad → Daten,
 * `doc().get/set/update/delete`, `collection().where().get()`, Batch,
 * Transaktion (Lesen live, Schreiben gebündelt am Ende) und ein kleiner
 * `Timestamp`. Kein Emulator, kein Netz. Semantik der echten API, soweit
 * der Takt sie benutzt: `set` ersetzt (bzw. merged tief), `update` verlangt
 * ein vorhandenes Doc und versteht Punktpfade, Snapshots sind Kopien.
 */
import type {
  CollRefLike,
  DocData,
  DocRefLike,
  DocSnapLike,
  FirestoreLike,
  QueryLike,
  QuerySnapLike,
  TransactionLike,
  WriteBatchLike,
} from '../../src/engine/firestoreLike.ts';

export class FakeTimestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static now(): FakeTimestamp {
    const ms = Date.now();
    return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }
  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000);
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const clone = <T>(v: T): T => structuredClone(v);
const segs = (path: string): string[] => path.split('/').filter(Boolean);
const isDocPath = (path: string): boolean => segs(path).length > 0 && segs(path).length % 2 === 0;

function getField(data: DocData | undefined, field: string): unknown {
  let cur: unknown = data;
  for (const k of field.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setField(obj: DocData, field: string, value: unknown): void {
  const parts = field.split('.');
  let cur: DocData = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (!isRecord(cur[k])) cur[k] = {};
    cur = cur[k] as DocData;
  }
  cur[parts[parts.length - 1]!] = value;
}

function deepMerge(target: DocData, src: DocData): void {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (isRecord(v) && isRecord(t)) deepMerge(t, v);
    else target[k] = clone(v);
  }
}

function matches(data: DocData, f: { field: string; op: string; value: unknown }): boolean {
  const v = getField(data, f.field);
  const eq = JSON.stringify(v) === JSON.stringify(f.value);
  switch (f.op) {
    case '==':
      return eq;
    case '!=':
      return !eq;
    case '<':
      return typeof v === typeof f.value && (v as number) < (f.value as number);
    case '<=':
      return typeof v === typeof f.value && (v as number) <= (f.value as number);
    case '>':
      return typeof v === typeof f.value && (v as number) > (f.value as number);
    case '>=':
      return typeof v === typeof f.value && (v as number) >= (f.value as number);
    case 'in':
      return Array.isArray(f.value) && f.value.some((x) => JSON.stringify(x) === JSON.stringify(v));
    case 'array-contains':
      return Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(f.value));
    default:
      throw new Error(`FakeFirestore: Operator ${f.op} nicht unterstützt`);
  }
}

class FakeSnap implements DocSnapLike {
  readonly ref: DocRefLike;
  readonly id: string;
  readonly exists: boolean;
  private readonly d: DocData | undefined;
  constructor(ref: DocRefLike, data: DocData | undefined) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this.d = data;
  }
  data(): DocData | undefined {
    return this.d === undefined ? undefined : clone(this.d);
  }
  get(field: string): unknown {
    return clone(getField(this.d, field));
  }
}

class FakeDocRef implements DocRefLike {
  readonly id: string;
  readonly path: string;
  private readonly db: FakeFirestore;
  constructor(db: FakeFirestore, path: string) {
    this.db = db;
    this.path = path;
    this.id = segs(path)[segs(path).length - 1]!;
  }
  async get(): Promise<DocSnapLike> {
    return new FakeSnap(this, this.db.docs.get(this.path));
  }
  async set(data: DocData, options?: { merge?: boolean }): Promise<void> {
    this.db.applySet(this.path, data, options?.merge === true);
  }
  async update(data: DocData): Promise<void> {
    this.db.applyUpdate(this.path, data);
  }
  async delete(): Promise<void> {
    this.db.applyDelete(this.path);
  }
  collection(path: string): CollRefLike {
    return new FakeCollRef(this.db, `${this.path}/${path}`);
  }
}

class FakeQuery implements QueryLike {
  protected readonly db: FakeFirestore;
  readonly path: string;
  private readonly filters: Array<{ field: string; op: string; value: unknown }>;
  constructor(db: FakeFirestore, path: string, filters: Array<{ field: string; op: string; value: unknown }> = []) {
    this.db = db;
    this.path = path;
    this.filters = filters;
  }
  where(field: string, op: string, value: unknown): QueryLike {
    return new FakeQuery(this.db, this.path, [...this.filters, { field, op, value }]);
  }
  async get(): Promise<QuerySnapLike> {
    const docs: DocSnapLike[] = [];
    for (const { id, data } of this.db.list(this.path)) {
      if (this.filters.every((f) => matches(data, f))) docs.push(new FakeSnap(new FakeDocRef(this.db, `${this.path}/${id}`), data));
    }
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeCollRef extends FakeQuery implements CollRefLike {
  readonly id: string;
  constructor(db: FakeFirestore, path: string) {
    super(db, path);
    if (isDocPath(path)) throw new Error(`FakeFirestore: ${path} ist ein Dokument-Pfad`);
    this.id = segs(path)[segs(path).length - 1]!;
  }
  doc(id?: string): DocRefLike {
    return new FakeDocRef(this.db, `${this.path}/${id ?? this.db.autoId()}`);
  }
}

class FakeBatch implements WriteBatchLike {
  private readonly ops: Array<() => void> = [];
  private readonly db: FakeFirestore;
  constructor(db: FakeFirestore) {
    this.db = db;
  }
  set(ref: DocRefLike, data: DocData, options?: { merge?: boolean }): this {
    const copy = clone(data);
    this.ops.push(() => this.db.applySet(ref.path, copy, options?.merge === true));
    return this;
  }
  update(ref: DocRefLike, data: DocData): this {
    const copy = clone(data);
    this.ops.push(() => this.db.applyUpdate(ref.path, copy));
    return this;
  }
  delete(ref: DocRefLike): this {
    this.ops.push(() => this.db.applyDelete(ref.path));
    return this;
  }
  async commit(): Promise<void> {
    if (this.ops.length > 500) throw new Error(`FakeFirestore: Batch mit ${this.ops.length} > 500 Schreibvorgängen`);
    for (const op of this.ops) op();
    this.db.commits++;
  }
}

class FakeTx extends FakeBatch implements TransactionLike {
  private readonly txDb: FakeFirestore;
  constructor(db: FakeFirestore) {
    super(db);
    this.txDb = db;
  }
  async get(ref: DocRefLike): Promise<DocSnapLike> {
    return new FakeSnap(ref, this.txDb.docs.get(ref.path));
  }
}

export class FakeFirestore implements FirestoreLike {
  /** Pfad → Daten (Original; Snapshots liefern Kopien). */
  readonly docs = new Map<string, DocData>();
  /** Schreibprotokoll (`set users/u1`, …) für Reihenfolge-Prüfungen. */
  readonly log: string[] = [];
  commits = 0;
  private seq = 0;

  doc(path: string): DocRefLike {
    if (!isDocPath(path)) throw new Error(`FakeFirestore: ${path} ist kein Dokument-Pfad`);
    return new FakeDocRef(this, path);
  }

  collection(path: string): CollRefLike {
    return new FakeCollRef(this, path);
  }

  batch(): WriteBatchLike {
    return new FakeBatch(this);
  }

  async runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T> {
    const tx = new FakeTx(this);
    const result = await fn(tx);
    await tx.commit();
    return result;
  }

  /* ── Test-Hilfen ── */

  autoId(): string {
    return `auto-${++this.seq}`;
  }

  /** Doc lesen (Kopie) oder undefined. */
  get(path: string): DocData | undefined {
    const d = this.docs.get(path);
    return d === undefined ? undefined : clone(d);
  }

  /** Doc setzen (Vorbelegung im Test). */
  seed(path: string, data: DocData): void {
    this.docs.set(path, clone(data));
  }

  /** Direkte Kinder einer Sammlung. */
  list(collectionPath: string): Array<{ id: string; data: DocData }> {
    const prefix = `${collectionPath}/`;
    const out: Array<{ id: string; data: DocData }> = [];
    for (const [k, v] of this.docs) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({ id: rest, data: clone(v) });
    }
    return out;
  }

  /* ── intern ── */

  applySet(path: string, data: DocData, merge: boolean): void {
    this.log.push(`set ${path}`);
    const existing = this.docs.get(path);
    if (merge && existing) deepMerge(existing, data);
    else this.docs.set(path, clone(data));
  }

  applyUpdate(path: string, data: DocData): void {
    this.log.push(`update ${path}`);
    const existing = this.docs.get(path);
    if (!existing) throw new Error(`FakeFirestore: update auf fehlendes Doc ${path}`);
    for (const [k, v] of Object.entries(data)) setField(existing, k, clone(v));
  }

  applyDelete(path: string): void {
    this.log.push(`delete ${path}`);
    this.docs.delete(path);
  }
}
