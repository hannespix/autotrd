import { describe, expect, it } from 'vitest';
import type { ParamSpec, Params } from '../../src/core/types.ts';
import { axisValues, gridSize, mulberry32, neighbors, paramKey, sampleParams, snapToGrid, wirksamerSuchraum } from '../../src/optimize/search.ts';
import { SPACE_AB } from './fakes.ts';

const onGrid = (p: Params, space: readonly ParamSpec[]): boolean =>
  space.every((s) => {
    const v = p[s.name];
    if (v === undefined || v < s.min - 1e-9 || v > s.max + 1e-9) return false;
    const k = (v - s.min) / s.step;
    return Math.abs(k - Math.round(k)) < 1e-6;
  });

describe('mulberry32', () => {
  it('ist deterministisch und liefert [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 50 }, () => a());
    const ys = Array.from({ length: 50 }, () => b());
    expect(xs).toEqual(ys);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(new Set(xs).size).toBeGreaterThan(45);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });
});

describe('Gitter', () => {
  it('gridSize ist das Produkt der Achsen', () => {
    expect(gridSize(SPACE_AB)).toBe(55);
    expect(gridSize([])).toBe(1);
  });

  it('Float-Achsen liegen exakt auf dem Gitter (keine 0.30000000000000004)', () => {
    const spec: ParamSpec = { name: 'x', min: 0.1, max: 0.3, step: 0.1 };
    expect(axisValues(spec)).toEqual([0.1, 0.2, 0.3]);
    expect(gridSize([spec])).toBe(3);
    const s2: ParamSpec = { name: 'y', min: 0, max: 1, step: 0.05 };
    expect(axisValues(s2).length).toBe(21);
    expect(axisValues(s2)[3]).toBe(0.15);
  });

  it('paramKey ist unabhängig von der Schlüsselreihenfolge', () => {
    expect(paramKey({ b: 2, a: 1 })).toBe(paramKey({ a: 1, b: 2 }));
    expect(paramKey({ a: 1, b: 2 })).not.toBe(paramKey({ a: 1, b: 3 }));
  });

  it('snapToGrid klemmt, rundet und behält fremde Schlüssel', () => {
    expect(snapToGrid({ a: 3.4, b: 9, c: 7 }, SPACE_AB)).toEqual({ a: 3, b: 4, c: 7 });
    expect(snapToGrid({ a: -2 }, SPACE_AB, { b: 1 })).toEqual({ a: 0, b: 1 });
    expect(snapToGrid({}, SPACE_AB)).toEqual({ a: 0, b: 0 });
  });
});

describe('sampleParams', () => {
  it('liefert n eindeutige Gitterpunkte mit include vorneweg', () => {
    const rng = mulberry32(1);
    const inc = [{ a: 10, b: 4 }, { a: 0, b: 0 }];
    const out = sampleParams(SPACE_AB, 20, rng, inc);
    expect(out.length).toBe(20);
    expect(out[0]).toEqual({ a: 10, b: 4 });
    expect(out[1]).toEqual({ a: 0, b: 0 });
    expect(new Set(out.map(paramKey)).size).toBe(20);
    for (const p of out) expect(onGrid(p, SPACE_AB)).toBe(true);
  });

  it('include wird aufs Gitter gezogen und nicht doppelt gezählt', () => {
    const out = sampleParams(SPACE_AB, 5, mulberry32(2), [{ a: 3.4, b: 1.6 }, { a: 3, b: 2 }]);
    expect(out[0]).toEqual({ a: 3, b: 2 });
    expect(out.filter((p) => p.a === 3 && p.b === 2).length).toBe(1);
    expect(out.length).toBe(5);
  });

  it('Gitter ≤ n ⇒ vollständiges Gitter, unabhängig vom Zufall', () => {
    const a = sampleParams(SPACE_AB, 60, mulberry32(1));
    const b = sampleParams(SPACE_AB, 55, mulberry32(999));
    expect(a.length).toBe(55);
    expect(new Set(a.map(paramKey))).toEqual(new Set(b.map(paramKey)));
    for (let x = 0; x <= 10; x++) for (let y = 0; y <= 4; y++) expect(a.some((p) => p.a === x && p.b === y)).toBe(true);
  });

  it('bei knapp größerem Gitter werden trotzdem n eindeutige Punkte gefunden', () => {
    const out = sampleParams(SPACE_AB, 54, mulberry32(3));
    expect(out.length).toBe(54);
    expect(new Set(out.map(paramKey)).size).toBe(54);
  });

  it('ist bei gleichem Seed identisch', () => {
    const a = sampleParams(SPACE_AB, 20, mulberry32(11));
    const b = sampleParams(SPACE_AB, 20, mulberry32(11));
    expect(a).toEqual(b);
  });
});

describe('neighbors', () => {
  it('genau eine Achse um ±1 Schritt, Grenzen respektiert', () => {
    const nb = neighbors({ a: 5, b: 0 }, SPACE_AB);
    expect(nb).toEqual([
      { a: 4, b: 0 },
      { a: 6, b: 0 },
      { a: 5, b: 1 },
    ]);
    for (const n of nb) {
      const diffs = SPACE_AB.filter((s) => n[s.name] !== ({ a: 5, b: 0 } as Params)[s.name]);
      expect(diffs.length).toBe(1);
      expect(onGrid(n, SPACE_AB)).toBe(true);
    }
    expect(neighbors({ a: 0, b: 0 }, SPACE_AB).length).toBe(2);
    expect(neighbors({ a: 10, b: 4 }, SPACE_AB).length).toBe(2);
    expect(neighbors({ a: 5, b: 2 }, SPACE_AB).length).toBe(4);
  });

  it('Float-Nachbarn sind exakte Gitterwerte; fremde Schlüssel bleiben', () => {
    const spec: ParamSpec = { name: 'x', min: 0.1, max: 0.3, step: 0.1 };
    expect(neighbors({ x: 0.2, k: 9 }, [spec])).toEqual([
      { x: 0.1, k: 9 },
      { x: 0.3, k: 9 },
    ]);
    expect(neighbors({ x: 0.1 }, [spec])).toEqual([{ x: 0.2 }]);
  });

  it('Einpunkt-Achsen und fehlende Achsen haben keine Nachbarn', () => {
    expect(neighbors({ x: 1 }, [{ name: 'x', min: 1, max: 1, step: 1 }])).toEqual([]);
    expect(neighbors({}, SPACE_AB)).toEqual([]);
  });
});

describe('wirksamerSuchraum — allowShort ist bei gesperrtem Short eine tote Achse', () => {
  const mitShort: ParamSpec[] = [...SPACE_AB, { name: 'allowShort', min: 0, max: 1, step: 1, kind: 'int' }];

  it('nimmt die Achse heraus und nagelt den Wert auf 0', () => {
    const r = wirksamerSuchraum(mitShort, false);
    expect(r.space.map((s) => s.name)).toEqual(['a', 'b']);
    expect(r.pinned).toEqual({ allowShort: 0 });
  });

  it('lässt den Raum unberührt, wenn Shorts erlaubt sind', () => {
    const r = wirksamerSuchraum(mitShort, true);
    expect(r.space).toBe(mitShort);
    expect(r.pinned).toEqual({});
  });

  it('ohne die Achse ändert sich nichts — auch nicht bei gesperrtem Short', () => {
    const r = wirksamerSuchraum(SPACE_AB, false);
    expect(r.space).toBe(SPACE_AB);
    expect(r.pinned).toEqual({});
  });
});
