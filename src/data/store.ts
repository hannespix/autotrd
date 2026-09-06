/**
 * Bars-Cache auf Platte: je Symbol und Basis-Zeitrahmen eine kolumnare
 * JSON-Datei. Backtest, Optimierer und Engine lesen denselben Cache —
 * deshalb liegen die Dateien nach Assetklasse und Feed getrennt
 * (`<home>/bars/<assetClass>/<feed>/`): IEX- und SIP-Bars derselben Minute
 * unterscheiden sich, und wer sie mischt, misst etwas anderes, als er
 * handelt. Der Aufrufer bildet den Wurzelpfad mit `barStoreRoot()`.
 *
 * Der Store hält je Datei einen In-Memory-Stand; Schreiben ist atomar
 * (writeJsonAtomic), damit ein Absturz nie eine halbe Datei hinterlässt.
 * Eine kaputte Datei tötet nichts: Sie wird als leer behandelt (Warnung),
 * der Backfill lädt sie neu.
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../core/journal.ts';
import { errMsg, logger } from '../core/log.ts';
import type { Bar, Ms } from '../core/types.ts';

export type BaseTimeframe = '1Min' | '1Day';

export interface BarFile {
  version: 1;
  symbol: string;
  tf: BaseTimeframe;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/** Wurzel des Caches für (Assetklasse, Feed) unterhalb des bars-Verzeichnisses. */
export function barStoreRoot(barsDir: string, assetClass: string, feed: string): string {
  return join(barsDir, assetClass, feed);
}

/** Dateiname: Symbol mit `/` → `-` (BTC/USD → BTC-USD), Punkt bleibt (BRK.B). */
export function barFileName(symbol: string, tf: BaseTimeframe): string {
  return `${symbol.replace(/[^A-Za-z0-9._-]/g, '-')}_${tf}.json`;
}

/**
 * Zwei Bar-Listen nach Zeit zusammenführen: gleiche `t` ⇒ die neue Version
 * gewinnt; Ergebnis streng steigend sortiert. Der häufige Fall (nur
 * Anhängen) läuft ohne Sortierung.
 */
export function mergeBars(existing: readonly Bar[], incoming: readonly Bar[]): Bar[] {
  if (incoming.length === 0) return [...existing];
  const lastT = existing.length ? existing[existing.length - 1]!.t : Number.NEGATIVE_INFINITY;
  let appendOnly = true;
  let prev = Number.NEGATIVE_INFINITY;
  for (const b of incoming) {
    if (b.t <= lastT || b.t <= prev) {
      appendOnly = false;
      break;
    }
    prev = b.t;
  }
  if (appendOnly) return [...existing, ...incoming];
  const map = new Map<number, Bar>();
  for (const b of existing) map.set(b.t, b);
  for (const b of incoming) map.set(b.t, b);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function toFile(symbol: string, tf: BaseTimeframe, bars: readonly Bar[]): BarFile {
  const n = bars.length;
  const f: BarFile = { version: 1, symbol, tf, t: new Array(n), o: new Array(n), h: new Array(n), l: new Array(n), c: new Array(n), v: new Array(n) };
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    f.t[i] = b.t;
    f.o[i] = b.o;
    f.h[i] = b.h;
    f.l[i] = b.l;
    f.c[i] = b.c;
    f.v[i] = b.v;
  }
  return f;
}

function fromFile(f: BarFile): Bar[] {
  const n = f.t.length;
  const out: Bar[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { t: f.t[i]!, o: f.o[i]!, h: f.h[i]!, l: f.l[i]!, c: f.c[i]!, v: f.v[i]! };
  }
  return out;
}

function isBarFile(x: unknown): x is BarFile {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  if (f.version !== 1) return false;
  const cols = ['t', 'o', 'h', 'l', 'c', 'v'] as const;
  const t = f.t;
  if (!Array.isArray(t)) return false;
  return cols.every((k) => Array.isArray(f[k]) && (f[k] as unknown[]).length === t.length);
}

export class BarStore {
  readonly root: string;
  private readonly cache = new Map<string, Bar[]>();

  constructor(root: string) {
    this.root = root;
  }

  pathFor(symbol: string, tf: BaseTimeframe): string {
    return join(this.root, barFileName(symbol, tf));
  }

  private key(symbol: string, tf: BaseTimeframe): string {
    return `${symbol}|${tf}`;
  }

  /** Stand aus Cache oder Datei (ohne Kopie — nur intern verwenden). */
  private current(symbol: string, tf: BaseTimeframe): Bar[] {
    const k = this.key(symbol, tf);
    const hit = this.cache.get(k);
    if (hit) return hit;
    let bars: Bar[] = [];
    const path = this.pathFor(symbol, tf);
    if (existsSync(path)) {
      try {
        const raw = readJson<unknown>(path);
        if (raw === null) bars = [];
        else if (isBarFile(raw)) bars = fromFile(raw);
        else {
          logger.warn('BarStore: Datei hat unbekanntes Format — wird als leer behandelt', { path });
        }
      } catch (e) {
        logger.warn('BarStore: Datei unlesbar — wird als leer behandelt', { path, error: errMsg(e) });
      }
    }
    this.cache.set(k, bars);
    return bars;
  }

  /** Alle Bars (Kopie, sortiert); leer, wenn die Datei fehlt. */
  load(symbol: string, tf: BaseTimeframe): Bar[] {
    return [...this.current(symbol, tf)];
  }

  /** Gesamtstand ersetzen und atomar schreiben. */
  save(symbol: string, tf: BaseTimeframe, bars: readonly Bar[]): void {
    const normalized = mergeBars([], bars);
    this.cache.set(this.key(symbol, tf), normalized);
    writeJsonAtomic(this.pathFor(symbol, tf), toFile(symbol, tf, normalized));
  }

  /** Neue Bars einarbeiten (gleiches t: die neue gewinnt), speichern, Gesamtstand zurückgeben. */
  upsert(symbol: string, tf: BaseTimeframe, bars: readonly Bar[]): Bar[] {
    const merged = mergeBars(this.current(symbol, tf), bars);
    this.save(symbol, tf, merged);
    return [...merged];
  }

  /** Zeit der letzten Bar; null ohne Bars. */
  lastTime(symbol: string, tf: BaseTimeframe): Ms | null {
    const bars = this.current(symbol, tf);
    return bars.length ? bars[bars.length - 1]!.t : null;
  }

  /** Bars mit t < olderThan entfernen (hält Dateien endlich). */
  prune(symbol: string, tf: BaseTimeframe, olderThan: Ms): void {
    const bars = this.current(symbol, tf);
    const kept = bars.filter((b) => b.t >= olderThan);
    if (kept.length !== bars.length) this.save(symbol, tf, kept);
  }

  /** Verwaiste Temp-Dateien eines abgebrochenen Schreibvorgangs entfernen. */
  cleanupTemp(): number {
    if (!existsSync(this.root)) return 0;
    let n = 0;
    for (const name of readdirSync(this.root)) {
      if (/\.json\.\d+\.tmp$/.test(name)) {
        try {
          unlinkSync(join(this.root, name));
          n++;
        } catch (e) {
          logger.warn('BarStore: Temp-Datei nicht löschbar', { name, error: errMsg(e) });
        }
      }
    }
    return n;
  }
}
