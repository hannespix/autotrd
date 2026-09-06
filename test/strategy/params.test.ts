import { describe, expect, it } from 'vitest';
import type { ParamSpec } from '../../src/core/types.ts';
import { ParamError, gridOf, mergeParams, paramKey, req, snapToGrid, spec, validateParams } from '../../src/strategy/params.ts';

const space: readonly ParamSpec[] = [
  spec('atrMult', 1.5, 4, 0.5, 'float', 'Stop-Distanz'),
  spec('entryLen', 10, 60, 5, 'int'),
  spec('flag', 0, 1, 1, 'int'),
  spec('fine', 0, 1, 0.1, 'float'),
];

describe('params', () => {
  it('spec setzt doc nur, wenn vorhanden', () => {
    expect('doc' in spec('a', 0, 1, 1)).toBe(false);
    expect(spec('a', 0, 1, 1, 'int', 'x').doc).toBe('x');
  });

  it('mergeParams: Overrides gewinnen, undefined wird übersprungen, Unbekanntes bleibt sichtbar', () => {
    const merged = mergeParams({ a: 1, b: 2 }, { b: 3, c: 4, a: undefined });
    expect(merged).toEqual({ a: 1, b: 3, c: 4 });
    expect(mergeParams({ a: 1 })).toEqual({ a: 1 });
  });

  it('validateParams: gültige Gitterwerte gehen durch (auch Fließkomma-Gitter)', () => {
    expect(() => validateParams(space, { atrMult: 3, entryLen: 35, flag: 1, fine: 0.3 })).not.toThrow();
    expect(() => validateParams(space, { atrMult: 1.5 + 3 * 0.5, entryLen: 10, flag: 0, fine: 0.1 * 3 })).not.toThrow();
    expect(() => validateParams(space, { atrMult: 2.5 + 1e-12, entryLen: 10, flag: 0, fine: 0 })).not.toThrow();
  });

  it('validateParams wirft mit klarer Meldung', () => {
    const ok = { atrMult: 2.5, entryLen: 20, flag: 0, fine: 0.5 };
    expect(() => validateParams(space, { ...ok, atrMult: 2.7 })).toThrow(/atrMult.*Gitter/);
    expect(() => validateParams(space, { ...ok, atrMult: 4.5 })).toThrow(/außerhalb/);
    expect(() => validateParams(space, { ...ok, atrMult: 1 })).toThrow(/außerhalb/);
    expect(() => validateParams(space, { ...ok, entryLen: 12.5 })).toThrow(/ganzzahlig/);
    expect(() => validateParams(space, { ...ok, entryLen: 12 })).toThrow(/Gitter/);
    expect(() => validateParams(space, { ...ok, fine: Number.NaN })).toThrow(/nicht endlich/);
    expect(() => validateParams(space, { ...ok, typo: 1 })).toThrow(/typo.*kein Parameter/);
    const { fine: _f, ...missing } = ok;
    expect(() => validateParams(space, missing)).toThrow(/"fine" fehlt/);
    expect(() => validateParams(space, { ...ok, atrMult: 2.51 })).toThrow(ParamError);
  });

  it('validateParams sammelt alle Verstöße', () => {
    expect(() => validateParams(space, { atrMult: 9, entryLen: 11, flag: 2, fine: 0.55 })).toThrow(/atrMult[\s\S]*entryLen[\s\S]*flag[\s\S]*fine/);
  });

  it('validateParams lehnt kaputte Specs ab', () => {
    expect(() => validateParams([spec('x', 0, 1, 0)], { x: 0 })).toThrow(/step/);
    expect(() => validateParams([spec('x', 2, 1, 1)], { x: 1 })).toThrow(/min/);
  });

  it('snapToGrid zieht auf den nächsten Gitterpunkt und klemmt an den Rändern', () => {
    const snapped = snapToGrid(space, { atrMult: 2.7, entryLen: 12.4, flag: 0.9, fine: 0.30000000000000004, extra: 7 });
    expect(snapped).toEqual({ atrMult: 2.5, entryLen: 10, flag: 1, fine: 0.3, extra: 7 });
    expect(snapToGrid(space, { atrMult: 2.76, entryLen: 99, flag: -3, fine: 1.2 })).toEqual({ atrMult: 3, entryLen: 60, flag: 0, fine: 1 });
    expect(snapToGrid(space, { atrMult: -1 }).atrMult).toBe(1.5);
    // Nicht auf dem Gitter liegendes max: 2, 6, 10 — 11 wird zu 10, nicht zu 11.
    expect(snapToGrid([spec('m', 2, 11, 4, 'int')], { m: 11 }).m).toBe(10);
    // Fehlende Schlüssel bleiben fehlend.
    expect('atrMult' in snapToGrid(space, { entryLen: 20 })).toBe(false);
    // Gesnappte Werte sind gültig.
    expect(() => validateParams(space, snapToGrid(space, { atrMult: 3.3, entryLen: 33, flag: 0.4, fine: 0.44 }))).not.toThrow();
  });

  it('gridOf liefert alle Gitterwerte ohne Fließkomma-Rest', () => {
    expect(gridOf(space[0]!)).toEqual([1.5, 2, 2.5, 3, 3.5, 4]);
    expect(gridOf(space[3]!)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(gridOf(spec('m', 2, 11, 4, 'int'))).toEqual([2, 6, 10]);
    expect(gridOf(spec('fixed', 14, 14, 1, 'int'))).toEqual([14]);
  });

  it('paramKey ist stabil und sortiert', () => {
    expect(paramKey({ b: 2, a: 1.5 })).toBe(paramKey({ a: 1.5, b: 2 }));
    expect(paramKey({ b: 2, a: 1.5 })).toBe('{"a":1.5,"b":2}');
    expect(paramKey({ a: 1 })).not.toBe(paramKey({ a: 2 }));
  });

  it('req wirft bei fehlendem oder nicht endlichem Parameter', () => {
    expect(req({ a: 3 }, 'a')).toBe(3);
    expect(() => req({ a: 3 }, 'b')).toThrow(ParamError);
    expect(() => req({ a: Number.NaN }, 'a')).toThrow(/nicht endlich/);
  });
});
