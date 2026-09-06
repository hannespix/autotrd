/**
 * Suchraum-Werkzeuge: deterministischer Zufall, Gitterpunkte, Stichproben,
 * ±1-Nachbarschaft. Alles arbeitet auf dem Gitter aus `ParamSpec.step`,
 * weil die Plateau-Prüfung (robustness.ts) genau einen Gitterschritt
 * als Nachbarschaft definiert — Stichprobe und Nachbarschaft müssen
 * dasselbe Gitter meinen, sonst misst der Plateau-Test etwas anderes als
 * die Suche gefunden hat.
 */
import type { Params, ParamSpec } from '../core/types.ts';

/** Ein Generator im Repo: der seedbare mulberry32 des Backtesters. */
export { mulberry32 } from '../backtest/synthetic.ts';

/* ───────────────────────── Gitter ───────────────────────── */

/** Nachkommastellen einer Zahl (auch in Exponentialschreibweise). */
function decimalsOf(x: number): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return 0;
  const s = String(x);
  const e = s.indexOf('e');
  if (e >= 0) {
    const mant = s.slice(0, e);
    const exp = Number(s.slice(e + 1));
    const md = mant.includes('.') ? mant.split('.')[1]!.length : 0;
    return Math.max(0, md - exp);
  }
  return s.split('.')[1]?.length ?? 0;
}

function decimalsFor(spec: ParamSpec): number {
  if (spec.kind === 'int') return 0;
  return Math.min(12, Math.max(decimalsOf(spec.step), decimalsOf(spec.min)));
}

/** Anzahl Gitterpunkte einer Achse (mindestens 1). */
export function axisCount(spec: ParamSpec): number {
  if (!(spec.step > 0) || spec.max < spec.min) return 1;
  // 1e-9-Toleranz gegen Fließkommareste wie (0.3-0.1)/0.1 = 1.9999…
  return Math.floor((spec.max - spec.min) / spec.step + 1e-9) + 1;
}

/** Wert des k-ten Gitterpunkts einer Achse, auf die Schrittgenauigkeit gerundet. */
export function axisValue(spec: ParamSpec, k: number): number {
  const raw = spec.min + k * spec.step;
  if (spec.kind === 'int') return Math.round(raw);
  return Number(raw.toFixed(decimalsFor(spec)));
}

/** Gitterindex des nächstgelegenen Gitterpunkts zu `v` (in die Grenzen geklemmt). */
export function axisIndex(spec: ParamSpec, v: number): number {
  const n = axisCount(spec);
  if (!(spec.step > 0)) return 0;
  const k = Math.round((v - spec.min) / spec.step);
  return Math.max(0, Math.min(n - 1, k));
}

/** Größe des vollständigen Gitters (Produkt der Achsen). */
export function gridSize(space: readonly ParamSpec[]): number {
  let n = 1;
  for (const s of space) n *= axisCount(s);
  return n;
}

/** Alle Gitterwerte einer Achse. */
export function axisValues(spec: ParamSpec): number[] {
  const n = axisCount(spec);
  const out: number[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = axisValue(spec, k);
  return out;
}

/**
 * Eindeutiger Schlüssel eines Parametersatzes (Schlüssel sortiert), damit
 * `{a:1,b:2}` und `{b:2,a:1}` als derselbe Punkt gelten.
 */
export function paramKey(p: Params): string {
  return Object.keys(p)
    .sort()
    .map((k) => `${k}=${p[k]}`)
    .join(',');
}

/** Schlüssel nur über die Achsen des Suchraums — Konstanten außerhalb des Raums zählen nicht. */
function spaceKey(p: Params, space: readonly ParamSpec[]): string {
  return space.map((s) => `${s.name}=${p[s.name]}`).join(',');
}

/**
 * Parametersatz auf das Gitter ziehen: jede Achse geklemmt und auf den
 * nächsten Schritt gerundet; fehlende Achsen bekommen `fallback` (sonst das
 * Achsenminimum); Schlüssel außerhalb des Raums bleiben unverändert erhalten
 * (feste Strategie-Konstanten).
 */
export function snapToGrid(p: Params, space: readonly ParamSpec[], fallback: Params = {}): Params {
  const out: Params = { ...p };
  for (const s of space) {
    const v = p[s.name] ?? fallback[s.name] ?? s.min;
    out[s.name] = axisValue(s, axisIndex(s, v));
  }
  return out;
}

/* ───────────────────────── Stichprobe ───────────────────────── */

function gridPoint(space: readonly ParamSpec[], index: number): Params {
  const out: Params = {};
  let rest = index;
  for (const s of space) {
    const n = axisCount(s);
    out[s.name] = axisValue(s, rest % n);
    rest = Math.floor(rest / n);
  }
  return out;
}

/**
 * Bis zu `n` eindeutige Gitterpunkte. `include` (Defaults, Champion, …) steht
 * immer vorne — auf das Gitter gezogen, damit die Nachbarschaft später
 * dieselben Schritte meint. Ist das Gitter nicht größer als `n`, kommt es
 * vollständig (dann ist die Suche erschöpfend und kein Zufall im Spiel).
 */
export function sampleParams(space: readonly ParamSpec[], n: number, rng: () => number, include: readonly Params[] = []): Params[] {
  const seen = new Set<string>();
  const out: Params[] = [];
  const push = (p: Params): boolean => {
    const k = spaceKey(p, space);
    if (seen.has(k)) return false;
    seen.add(k);
    out.push(p);
    return true;
  };

  for (const p of include) push(snapToGrid(p, space));

  const total = gridSize(space);
  if (total <= n) {
    for (let i = 0; i < total; i++) push(gridPoint(space, i));
    return out;
  }

  // Zufällige Punkte; Kollisionen sind bei total > n selten, aber ein
  // harter Deckel verhindert Endlosschleifen bei sehr dichter Auslastung.
  let attempts = 0;
  const maxAttempts = 50 * Math.max(n, 1);
  while (out.length < n && attempts < maxAttempts) {
    attempts++;
    const p: Params = {};
    for (const s of space) p[s.name] = axisValue(s, Math.floor(rng() * axisCount(s)));
    push(p);
  }
  if (out.length < n) {
    // Rest deterministisch auffüllen: Gitter ab zufälligem Start abschreiten.
    const start = Math.floor(rng() * total);
    for (let i = 0; i < total && out.length < n; i++) push(gridPoint(space, (start + i) % total));
  }
  return out;
}

/**
 * Alle Nachbarn mit genau EINER Achse um ±1 Gitterschritt verschoben
 * (innerhalb der Grenzen). Achsen, die `p` nicht enthält, werden übersprungen.
 */
export function neighbors(p: Params, space: readonly ParamSpec[]): Params[] {
  const out: Params[] = [];
  for (const s of space) {
    const v = p[s.name];
    if (v === undefined) continue;
    const n = axisCount(s);
    if (n <= 1) continue;
    const k = axisIndex(s, v);
    if (k - 1 >= 0) out.push({ ...p, [s.name]: axisValue(s, k - 1) });
    if (k + 1 < n) out.push({ ...p, [s.name]: axisValue(s, k + 1) });
  }
  return out;
}
