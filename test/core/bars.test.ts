import { describe, expect, it } from 'vitest';
import { BarSeries, aggregate, anfangsStreuner, filterRegularSession, normalizeBars } from '../../src/core/bars.ts';
import { DAY, HOUR, msFromET, sessionBounds } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';

const et = (hh: number, mm: number, d = 4) => msFromET(2026, 9, d, hh, mm);
const mk = (t: number, p: number, v = 100, extra: Partial<Bar> = {}): Bar => ({ t, o: p, h: p + 1, l: p - 1, c: p + 0.5, v, ...extra });

describe('BarSeries', () => {
  it('verlangt streng steigende Zeiten', () => {
    expect(() => BarSeries.from([mk(1, 10), mk(1, 11)])).toThrow(/steigend/);
  });

  it('prefix teilt den Speicher, slice kopiert', () => {
    const s = BarSeries.from([mk(1, 10), mk(2, 11), mk(3, 12)]);
    const p = s.prefix(2);
    expect(p.length).toBe(2);
    expect(p.c.buffer).toBe(s.c.buffer);
    const c = s.slice(1);
    expect(c.length).toBe(2);
    expect(c.t[0]).toBe(2);
    expect(c.c.buffer).not.toBe(s.c.buffer);
  });

  it('indexAtOrBefore und append', () => {
    const s = BarSeries.from([mk(10, 1), mk(20, 2), mk(30, 3)]);
    expect(s.indexAtOrBefore(5)).toBe(-1);
    expect(s.indexAtOrBefore(20)).toBe(1);
    expect(s.indexAtOrBefore(25)).toBe(1);
    expect(s.indexAtOrBefore(99)).toBe(2);
    const s2 = s.append(mk(40, 4));
    expect(s2.length).toBe(4);
    expect(s.length).toBe(3);
    expect(() => s.append(mk(30, 9))).toThrow();
  });
});

describe('aggregate (Aktien, 5 Minuten)', () => {
  const minutes: Bar[] = [
    mk(et(9, 25), 99), // Pre-Market — fällt weg
    { t: et(9, 30), o: 100, h: 101, l: 99, c: 100.5, v: 100, vw: 10, n: 5 },
    { t: et(9, 31), o: 100.5, h: 103, l: 100, c: 102, v: 300, vw: 20, n: 7 },
    mk(et(9, 34), 101),
    mk(et(9, 35), 105),
    mk(et(9, 39), 106),
    mk(et(16, 0), 200), // nach Schluss — fällt weg
  ];

  it('bildet Buckets an der Eröffnung mit korrektem OHLCV', () => {
    const out = aggregate(minutes, { tf: 5, assetClass: 'us_equity' });
    expect(out).toHaveLength(2);
    const b0 = out[0]!;
    expect(b0.t).toBe(et(9, 30));
    expect(b0.o).toBe(100);
    expect(b0.h).toBe(103);
    expect(b0.l).toBe(99);
    expect(b0.c).toBe(101.5);
    expect(b0.v).toBe(500);
    // vw ist volumengewichtet: (10·100 + 20·300)/400 = 17.5 vor der dritten Bar (ohne vw → unverändert)
    expect(b0.vw).toBeCloseTo(17.5, 6);
    expect(b0.n).toBe(12);
    expect(out[1]!.t).toBe(et(9, 35));
    expect(out[1]!.c).toBe(106.5);
  });

  it('closedBefore schließt den laufenden Bucket aus', () => {
    const out = aggregate(minutes, { tf: 5, assetClass: 'us_equity', closedBefore: et(9, 35) });
    expect(out).toHaveLength(1);
    const out2 = aggregate(minutes, { tf: 5, assetClass: 'us_equity', closedBefore: et(9, 40) });
    expect(out2).toHaveLength(2);
  });

  it('Tagesbars entstehen aus Minuten über mehrere Tage', () => {
    const twoDays = [mk(et(9, 30), 100), mk(et(15, 59), 110), mk(et(9, 30, 8), 120), mk(et(12, 0, 8), 130)];
    const out = aggregate(twoDays, { tf: 1440, assetClass: 'us_equity' });
    expect(out).toHaveLength(2);
    expect(out[0]!.t).toBe(sessionBounds('2026-09-04', 'us_equity')!.open);
    expect(out[0]!.o).toBe(100);
    expect(out[0]!.c).toBe(110.5);
    expect(out[1]!.t).toBe(sessionBounds('2026-09-08', 'us_equity')!.open);
  });

  it('der letzte Bucket des Tages endet am Schluss (60 min ab 15:30)', () => {
    const late = [mk(et(15, 30), 100), mk(et(15, 59), 101)];
    const out = aggregate(late, { tf: 60, assetClass: 'us_equity', closedBefore: et(16, 0) });
    expect(out).toHaveLength(1);
    expect(out[0]!.t).toBe(et(15, 30));
  });

  it('Feiertage liefern keine Buckets', () => {
    const out = aggregate([mk(msFromET(2026, 9, 7, 10, 0), 100)], { tf: 5, assetClass: 'us_equity' });
    expect(out).toHaveLength(0);
  });
});

describe('aggregate (Krypto, UTC-ausgerichtet)', () => {
  it('bildet 5-Minuten-Buckets ab UTC-Mitternacht', () => {
    const base = Date.UTC(2026, 8, 6);
    const out = aggregate([mk(base, 1), mk(base + 3 * 60_000, 2), mk(base + 5 * 60_000, 3)], { tf: 5, assetClass: 'crypto' });
    expect(out).toHaveLength(2);
    expect(out[0]!.t).toBe(base);
    expect(out[1]!.t).toBe(base + 5 * 60_000);
  });
});

describe('Hilfen', () => {
  it('filterRegularSession entfernt Pre-/After-Market', () => {
    const out = filterRegularSession([mk(et(9, 0), 1), mk(et(9, 30), 2), mk(et(15, 59), 3), mk(et(16, 0), 4)], 'us_equity');
    expect(out.map((b) => b.o)).toEqual([2, 3]);
  });

  it('normalizeBars sortiert und dedupliziert (letzte Version gewinnt)', () => {
    const out = normalizeBars([mk(3, 1), mk(1, 2), mk(3, 9), mk(2, 3)]);
    expect(out.map((b) => b.t)).toEqual([1, 2, 3]);
    expect(out[2]!.o).toBe(9);
  });
});

describe('anfangsStreuner — verirrte Einzelbars vor dem Datenbeginn', () => {
  /** Tagesbars ab dem 27.07.2020 (IEX-Datenbeginn), Handelstage vereinfacht als Kalendertage. */
  const beginn = msFromET(2020, 7, 27, 9, 30);
  const dicht = (n: number) => Array.from({ length: n }, (_, i) => beginn + i * DAY);

  it('eine Einzelbar 259 Tage vor dem dichten Anfang ist ein Streuner (SO 2019-11-11)', () => {
    expect(anfangsStreuner([beginn - 259 * DAY, ...dicht(300)])).toBe(1);
  });

  it('mehrere einzelne Streuner nacheinander (SPY 2018-11-01 und Freunde)', () => {
    expect(anfangsStreuner([beginn - 634 * DAY, beginn - 510 * DAY, beginn - 259 * DAY, ...dicht(300)])).toBe(3);
  });

  it('eine dichte Reihe bleibt unberührt — auch über das lange Wochenende und die Woche nach 9/11', () => {
    const t = [beginn, beginn + 4 * DAY, beginn + 5 * DAY, beginn + 12 * DAY - 5 * DAY, beginn + 13 * DAY, beginn + 20 * DAY];
    expect(anfangsStreuner(t)).toBe(0);
    expect(anfangsStreuner(dicht(3))).toBe(0);
    expect(anfangsStreuner(dicht(1))).toBe(0);
    expect(anfangsStreuner([])).toBe(0);
  });

  it('ein kurzer Vorlauf (drei dichte Bars) vor einer langen Lücke ist ebenfalls Streuner', () => {
    const vorlauf = [beginn - 300 * DAY, beginn - 299 * DAY, beginn - 298 * DAY];
    expect(anfangsStreuner([...vorlauf, ...dicht(300)])).toBe(3);
  });

  it('GRENZE: ein längerer dichter Block vor einer Lücke ist Datenlage, kein Streuner', () => {
    const block = Array.from({ length: 6 }, (_, i) => beginn - 300 * DAY + i * DAY);
    expect(anfangsStreuner([...block, ...dicht(300)])).toBe(0);
  });

  it('von lauter Einzelbars bleibt die letzte', () => {
    expect(anfangsStreuner([beginn - 400 * DAY, beginn - 200 * DAY, beginn])).toBe(2);
  });

  it('Minutenbars über Nacht und über das Wochenende sind dicht', () => {
    const fr = msFromET(2026, 9, 4, 15, 59);
    const t = [fr - 1 * 60_000, fr, fr + 65 * HOUR + 31 * 60_000, fr + 65 * HOUR + 32 * 60_000];
    expect(anfangsStreuner(t)).toBe(0);
  });

  it('die Schwelle ist die Lücke, nicht die Zahl der Bars: elf Tage sind zu viel, zehn nicht', () => {
    expect(anfangsStreuner([beginn - 11 * DAY, ...dicht(20)])).toBe(1);
    expect(anfangsStreuner([beginn - 10 * DAY, ...dicht(20)])).toBe(0);
  });
});
