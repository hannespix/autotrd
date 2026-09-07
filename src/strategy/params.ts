/**
 * Parameter-Hygiene: Zusammenführen, Validieren, aufs Gitter ziehen,
 * stabil serialisieren.
 *
 * Warum so streng (unbekannte Schlüssel, fehlende Schlüssel und Werte
 * neben dem Gitter werfen): Der Optimierer misst Nachbarschafts-Stabilität
 * in ±1 Gitterschritt. Ein Wert neben dem Gitter hat keine Nachbarn — und
 * ein Tippfehler in `strategy.params` der Config würde sonst stumm mit dem
 * Default weiterlaufen. Ein Auto-Trader darf mit halb verstandenen
 * Parametern nicht starten.
 */
import type { ParamSpec, Params } from '../core/types.ts';

export class ParamError extends Error {
  override name = 'ParamError';
}

/** Toleranz für Gitter- und Bereichsprüfung (in Wert-Einheiten). */
export const GRID_TOLERANCE = 1e-9;

/** Kompakter ParamSpec-Bauer; `doc` nur setzen, wenn vorhanden (exactOptionalPropertyTypes). */
export function spec(name: string, min: number, max: number, step: number, kind: 'int' | 'float' = 'float', doc?: string): ParamSpec {
  const s: ParamSpec = { name, min, max, step, kind };
  if (doc !== undefined) s.doc = doc;
  return s;
}

/** Pflicht-Parameter lesen; fehlt er, ist das ein Programmierfehler, kein Default-Fall. */
export function req(p: Params, name: string): number {
  const v = p[name];
  if (v === undefined || !Number.isFinite(v)) throw new ParamError(`Parameter "${name}" fehlt oder ist nicht endlich (${String(v)})`);
  return v;
}

/** Defaults ← Overrides (nur endliche Zahlen zählen; `undefined` überspringt). Unbekannte Schlüssel bleiben erhalten — validateParams meldet sie. */
export function mergeParams(defaults: Params, overrides: Partial<Params> = {}): Params {
  const out: Params = { ...defaults };
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

function checkSpec(s: ParamSpec): void {
  if (!Number.isFinite(s.min) || !Number.isFinite(s.max) || !Number.isFinite(s.step)) {
    throw new ParamError(`ParamSpec "${s.name}": min/max/step müssen endlich sein`);
  }
  if (s.step <= 0) throw new ParamError(`ParamSpec "${s.name}": step muss > 0 sein (ist ${s.step})`);
  if (s.min > s.max) throw new ParamError(`ParamSpec "${s.name}": min ${s.min} > max ${s.max}`);
}

/** Anzahl Gitterschritte von min bis max (inklusive Toleranz). */
function maxStepIndex(s: ParamSpec): number {
  return Math.floor((s.max - s.min) / s.step + GRID_TOLERANCE);
}

/** Nachkommastellen einer Zahl in ihrer kürzesten Darstellung (auch 1e-7 ⇒ 7). */
function decimalsOf(v: number): number {
  const m = /^-?\d+(?:\.(\d+))?(?:e-(\d+))?$/i.exec(String(v));
  if (!m) return 0;
  return (m[1]?.length ?? 0) + (m[2] !== undefined ? Number(m[2]) : 0);
}

/** Gitterwert k·step + min ohne Fließkomma-Rest (0.1·3 = 0.30000000000000004 → 0.3). */
function gridValue(s: ParamSpec, k: number): number {
  const raw = s.min + k * s.step;
  if (s.kind === 'int') return Math.round(raw);
  const decimals = Math.min(15, Math.max(decimalsOf(s.min), decimalsOf(s.step)));
  return Number(raw.toFixed(decimals));
}

/** Alle Gitterwerte einer Achse (für Optimierer und Tests). */
export function gridOf(s: ParamSpec): number[] {
  checkSpec(s);
  const out: number[] = [];
  const kMax = maxStepIndex(s);
  for (let k = 0; k <= kMax; k++) out.push(gridValue(s, k));
  return out;
}

/**
 * Wirft ParamError, wenn ein Wert fehlt, unbekannt, nicht endlich, außerhalb
 * [min, max], neben dem Gitter (Toleranz 1e-9) oder bei kind 'int' nicht
 * ganzzahlig ist. Alle Verstöße werden gesammelt gemeldet.
 */
export function validateParams(space: readonly ParamSpec[], p: Params): void {
  const problems: string[] = [];
  const known = new Set<string>();
  for (const s of space) {
    checkSpec(s);
    known.add(s.name);
    const v = p[s.name];
    if (v === undefined) {
      problems.push(`"${s.name}" fehlt`);
      continue;
    }
    if (!Number.isFinite(v)) {
      problems.push(`"${s.name}" ist nicht endlich (${String(v)})`);
      continue;
    }
    if (v < s.min - GRID_TOLERANCE || v > s.max + GRID_TOLERANCE) {
      problems.push(`"${s.name}" = ${v} außerhalb [${s.min}, ${s.max}]`);
      continue;
    }
    if (s.kind === 'int' && !Number.isInteger(v)) {
      problems.push(`"${s.name}" = ${v} muss ganzzahlig sein`);
      continue;
    }
    const k = Math.round((v - s.min) / s.step);
    if (Math.abs(v - (s.min + k * s.step)) > GRID_TOLERANCE) {
      problems.push(`"${s.name}" = ${v} liegt nicht auf dem Gitter (min ${s.min}, step ${s.step})`);
    }
  }
  for (const k of Object.keys(p)) {
    if (!known.has(k)) problems.push(`"${k}" ist kein Parameter dieser Strategie (bekannt: ${[...known].join(', ')})`);
  }
  if (problems.length) throw new ParamError(`Parameter ungültig:\n  ${problems.join('\n  ')}`);
}

/**
 * Jeden bekannten Parameter auf den nächsten Gitterpunkt innerhalb
 * [min, max] ziehen. Unbekannte oder fehlende Schlüssel bleiben unberührt
 * (das ist Sache von validateParams).
 */
export function snapToGrid(space: readonly ParamSpec[], p: Params): Params {
  const out: Params = { ...p };
  for (const s of space) {
    checkSpec(s);
    const v = p[s.name];
    if (v === undefined || !Number.isFinite(v)) continue;
    const kMax = maxStepIndex(s);
    const k = Math.min(kMax, Math.max(0, Math.round((v - s.min) / s.step)));
    out[s.name] = gridValue(s, k);
  }
  return out;
}

/** Stabile Serialisierung (Schlüssel sortiert) — als Cache-/Champion-Schlüssel. */
export function paramKey(p: Params): string {
  const keys = Object.keys(p).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${String(p[k])}`).join(',')}}`;
}
