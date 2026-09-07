/**
 * Client-Order-Kennungen — die Idempotenz-Anker der Engine.
 *
 * Die Kennung hängt an der LOGISCHEN Einheit, nie an der Uhr: Ein Einstieg
 * ist durch (Modus, Symbol, Bucket-Beginn der Entscheidungs-Bar) bestimmt,
 * ein Exit oder Schutz-Stop durch (Modus, Symbol, Einstiegszeit der
 * Position). Wer dieselbe Einheit zweimal sendet, sendet dieselbe Kennung —
 * und Alpaca lehnt die zweite ab bzw. `getOrderByClientId` findet die erste.
 * Doppelte Exits haben beim Vorgänger 10 Stück verkauft UND 10 leerverkauft.
 *
 * Format: `atd-<mode>-<symbolSafe>-<ms>-<e|x|s>[seq]`, nur `[A-Za-z0-9-]`,
 * ≤ 48 Zeichen. Der Sequenz-Zusatz (`x2`, `s3`) existiert, weil Alpaca eine
 * Kennung auch nach Storno/Ablehnung nie wieder annimmt — ein zweiter
 * Versuch für dieselbe Position braucht eine neue Kennung, bleibt aber
 * über das Präfix derselben Einheit zugeordnet.
 */
import type { AssetClass, Ms, TimeframeMin } from '../core/types.ts';
import { bucketStart, dayKeyFor, msFromET, parseDay, sessionBounds, MIN, type Calendar } from '../core/time.ts';

export type ClientIdKind = 'entry' | 'exit' | 'stop';
export type ClientIdMode = 'paper' | 'live';

export const CLIENT_ID_PREFIX = 'atd';
export const CLIENT_ID_MAX_LEN = 48;

const KIND_CODE: Record<ClientIdKind, string> = { entry: 'e', exit: 'x', stop: 's' };
const CODE_KIND: Record<string, ClientIdKind> = { e: 'entry', x: 'exit', s: 'stop' };

/** Symbol in Kennungs-Schreibweise: alles außer Buchstaben/Ziffern wird `-` (BTC/USD → BTC-USD, BRK.B → BRK-B). */
export function symbolSafe(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]/g, '-');
}

function build(mode: ClientIdMode, symbol: string, ms: Ms, kind: ClientIdKind, seq: number): string {
  if (!Number.isFinite(ms)) throw new Error(`clientId: Zeitstempel ungültig (${ms})`);
  const tail = `-${Math.trunc(ms)}-${KIND_CODE[kind]}${seq > 0 ? String(seq) : ''}`;
  const head = `${CLIENT_ID_PREFIX}-${mode}-`;
  // Bei Überlänge wird nur das Symbol gekappt — der Zeit-/Art-Schwanz trägt die Idempotenz.
  const room = CLIENT_ID_MAX_LEN - head.length - tail.length;
  const sym = symbolSafe(symbol).slice(0, Math.max(1, room));
  return `${head}${sym}${tail}`;
}

/** Einstieg: eine Kennung je (Modus, Symbol, Bucket-Beginn der Entscheidungs-Bar). */
export function entryClientId(mode: ClientIdMode, symbol: string, barStart: Ms): string {
  return build(mode, symbol, barStart, 'entry', 0);
}

/** Exit: positionsstabil über die Einstiegszeit; `seq` nur für Wiederholungen nach toter Order. */
export function exitClientId(mode: ClientIdMode, symbol: string, entryTime: Ms, seq = 0): string {
  return build(mode, symbol, entryTime, 'exit', seq);
}

/** Eigener Schutz-Stop (Krypto, Nachsetzen, Ersatz nach gescheitertem Replace). */
export function stopClientId(mode: ClientIdMode, symbol: string, entryTime: Ms, seq = 0): string {
  return build(mode, symbol, entryTime, 'stop', seq);
}

export interface ParsedClientId {
  mode: ClientIdMode;
  /** Symbol in Kennungs-Schreibweise (verlustbehaftet: `/` und `.` sind `-`). */
  symbolSafe: string;
  ms: Ms;
  kind: ClientIdKind;
  seq: number;
}

/** Kennung zerlegen; null, wenn sie nicht von uns stammt (Alpaca-eigene UUIDs, Bracket-Beine, fremde Orders). */
export function parseClientId(id: string): ParsedClientId | null {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) return null;
  const parts = id.split('-');
  // Mindestens: atd, mode, symbol, ms, kind — das Symbol selbst darf weitere `-` enthalten.
  if (parts.length < 5 || parts[0] !== CLIENT_ID_PREFIX) return null;
  const mode = parts[1];
  if (mode !== 'paper' && mode !== 'live') return null;
  const kindPart = parts[parts.length - 1]!;
  const m = /^([exs])(\d*)$/.exec(kindPart);
  if (!m) return null;
  const kind = CODE_KIND[m[1]!];
  if (!kind) return null;
  const ms = Number(parts[parts.length - 2]);
  if (!Number.isInteger(ms) || ms <= 0) return null;
  const sym = parts.slice(2, parts.length - 2).join('-');
  if (!sym) return null;
  return { mode, symbolSafe: sym, ms, kind, seq: m[2] ? Number(m[2]) : 0 };
}

/** Gehört die Kennung zu dieser Engine (Präfix + Modus)? Sichert Storno-/Übernahmepfade gegen fremde Orders. */
export function isOwnClientId(id: string, mode: ClientIdMode): boolean {
  const p = parseClientId(id);
  return p !== null && p.mode === mode;
}

/** Stimmt die Kennung mit dem Symbol überein (über die verlustbehaftete Schreibweise)? */
export function clientIdMatchesSymbol(id: string, symbol: string): boolean {
  const p = parseClientId(id);
  return p !== null && p.symbolSafe === symbolSafe(symbol);
}

/**
 * Bucket-Anker einer Entscheidung: Beginn des Zeitrahmen-Buckets, in dem
 * `decidedAt` liegt (sitzungsausgerichtet wie in core/time). Zwei Ticks im
 * selben Bucket — etwa nach einem Neustart — ergeben denselben Anker und
 * damit dieselbe Einstiegs-Kennung. Außerhalb der Sitzung (Entscheidung
 * auf der letzten Tagesbar nach Schluss) gilt ein festes Raster, damit der
 * Anker nie null ist.
 */
export function decisionBucketStart(decidedAt: Ms, tf: TimeframeMin, assetClass: AssetClass, calendar?: Calendar): Ms {
  const day = dayKeyFor(decidedAt, assetClass);
  const bounds = sessionBounds(day, assetClass, calendar);
  const aligned = bucketStart(decidedAt, tf, bounds);
  if (aligned !== null) return aligned;
  if (tf === 1440) {
    const { y, m, d } = parseDay(day);
    return assetClass === 'crypto' ? Date.UTC(y, m - 1, d) : msFromET(y, m, d);
  }
  const size = tf * MIN;
  return Math.floor(decidedAt / size) * size;
}
