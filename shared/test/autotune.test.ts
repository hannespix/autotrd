/**
 * Evidenzschwelle des Auto-Tuners (MT3).
 *
 * Die Numerik wird an ANALYTISCH exakten Fällen verankert, nicht an Werten
 * aus einer anderen Bibliothek: Die t-Verteilung hat für 1 und 2
 * Freiheitsgrade eine geschlossene Form, und der Test nach Fisher ist reine
 * Kombinatorik. Damit hängt die Korrektheit an Mathematik statt an einer
 * zweiten Implementierung, die dieselben Denkfehler enthalten könnte.
 */

import { describe, expect, it } from 'vitest';
import { fisherExact, incompleteBeta, judgeCandidate, welchTTest } from '../src/index.js';

/** Zweiseitige p-Werte der t-Verteilung — geschlossene Form. */
const pT1 = (t: number): number => 1 - (2 / Math.PI) * Math.atan(Math.abs(t)); // df = 1 (Cauchy)
const pT2 = (t: number): number => 1 - Math.abs(t) / Math.sqrt(t * t + 2); // df = 2

/** Was welchTTest intern rechnet: p = I_{df/(df+t²)}(df/2, 1/2). */
const pAusBeta = (t: number, df: number): number =>
  incompleteBeta(df / 2, 0.5, df / (df + t * t));

describe('incompleteBeta — gegen geschlossene Formen der t-Verteilung', () => {
  it('trifft df = 1 (Cauchy) auf 10 Stellen', () => {
    for (const t of [0.1, 0.5, 1, 2, 5, 12.7062]) {
      expect(pAusBeta(t, 1)).toBeCloseTo(pT1(t), 10);
    }
  });

  it('trifft df = 2 auf 10 Stellen', () => {
    for (const t of [0.1, 0.5, 1, 2, 4.3027, 9]) {
      expect(pAusBeta(t, 2)).toBeCloseTo(pT2(t), 10);
    }
  });

  it('respektiert die Ränder und die Symmetrie', () => {
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
    // I_x(a,b) = 1 − I_{1−x}(b,a)
    expect(incompleteBeta(2.5, 4.5, 0.3)).toBeCloseTo(1 - incompleteBeta(4.5, 2.5, 0.7), 12);
  });
});

describe('welchTTest', () => {
  it('sieht bei identischen Stichproben keinen Unterschied', () => {
    const a = [1, 2, 3, 4, 5];
    const r = welchTTest(a, [...a]);
    expect(r.t).toBe(0);
    expect(r.diff).toBe(0);
    expect(r.p).toBeCloseTo(1, 12);
  });

  it('rechnet t und df nachvollziehbar', () => {
    // a: Mittel 2, Varianz 1, n=3 · b: Mittel 5, Varianz 1, n=3
    // se² = 1/3 + 1/3 = 2/3 → t = −3 / √(2/3) = −3,674 ; df = 4
    const r = welchTTest([1, 2, 3], [4, 5, 6]);
    expect(r.diff).toBe(-3);
    expect(r.t).toBeCloseTo(-3 / Math.sqrt(2 / 3), 12);
    expect(r.df).toBeCloseTo(4, 12);
    expect(r.p).toBeCloseTo(pAusBeta(r.t, r.df), 12);
  });

  it('ist symmetrisch im Vorzeichen', () => {
    const ab = welchTTest([1, 2, 3], [4, 5, 6]);
    const ba = welchTTest([4, 5, 6], [1, 2, 3]);
    expect(ba.diff).toBeCloseTo(-ab.diff, 12);
    expect(ba.p).toBeCloseTo(ab.p!, 12);
  });

  it('liefert null statt Scheinsicherheit, wenn nichts streut oder zu wenig da ist', () => {
    expect(welchTTest([2, 2, 2], [2, 2, 2]).p).toBeNull();
    expect(welchTTest([1], [2, 3]).p).toBeNull();
  });
});

describe('fisherExact', () => {
  it('reproduziert den Befund vom 27.07.: 2/17 gegen 6/16 ist kein Beleg', () => {
    // 12 % gegen 39 % Trefferquote — sieht deutlich aus, ist es aber nicht.
    expect(fisherExact(2, 15, 6, 10)).toBeCloseTo(0.12, 2);
  });

  it('trifft das Lehrbuchbeispiel (Teetrinkerin, 3/1 gegen 1/3)', () => {
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 4);
  });

  it('gibt 1 bei völlig gleicher Verteilung', () => {
    expect(fisherExact(5, 5, 5, 5)).toBeCloseTo(1, 12);
  });

  it('erkennt eine klare Trennung', () => {
    expect(fisherExact(20, 0, 0, 20)).toBeLessThan(1e-9);
  });

  it('kommt mit leeren Tabellen zurecht', () => {
    expect(fisherExact(0, 0, 0, 0)).toBe(1);
  });
});

describe('judgeCandidate', () => {
  /** n Trades mit leichtem Zickzack, damit es überhaupt Streuung gibt. */
  const serie = (n: number, mittel: number): number[] =>
    Array.from({ length: n }, (_, i) => mittel + (i % 2 === 0 ? 1 : -1));

  it('befördert NICHT bei zu wenig Trades — egal wie gut es aussieht', () => {
    // Der Kern der Sache: 16 Trades sind keine Evidenz, auch wenn der
    // Unterschied riesig wirkt.
    const v = judgeCandidate(
      { pnls: serie(16, 20), label: 'Neu' },
      { pnls: serie(16, -10), label: 'Alt' },
    );
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/Zu wenig Evidenz/);
    expect(v.reason).toMatch(/16 gegen 16/);
  });

  it('befördert bei klarem, belegtem Vorsprung', () => {
    const v = judgeCandidate(
      { pnls: serie(40, 12), label: 'Ruhig' },
      { pnls: serie(40, 2), label: 'Hektisch' },
    );
    expect(v.promote).toBe(true);
    expect(v.edge).toBeCloseTo(10, 6);
    expect(v.p!).toBeLessThan(0.05);
    expect(v.reason).toMatch(/„Ruhig" schlägt „Hektisch"/);
  });

  it('befördert nicht, wenn die Variante hinten liegt', () => {
    const v = judgeCandidate(
      { pnls: serie(40, 1), label: 'Neu' },
      { pnls: serie(40, 9), label: 'Alt' },
    );
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/liegt nicht vorn/);
  });

  it('befördert nicht bei winzigem Vorsprung — die Umstellung kostet selbst', () => {
    const v = judgeCandidate(
      { pnls: serie(40, 5.2), label: 'Neu' },
      { pnls: serie(40, 5), label: 'Alt' },
      { minEdge: 0.5 },
    );
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/Vorsprung zu klein/);
  });

  it('befördert nicht, wenn der Vorsprung im Rauschen verschwindet', () => {
    // Großer Vorsprung im Mittel, aber gewaltige Streuung → nicht belegt.
    const laut = (n: number, mittel: number): number[] =>
      Array.from({ length: n }, (_, i) => mittel + ((i * 7919) % 401) - 200);
    const v = judgeCandidate(
      { pnls: laut(40, 4), label: 'Neu' },
      { pnls: laut(40, 0), label: 'Alt' },
    );
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/nicht belegt/);
    expect(v.p!).toBeGreaterThan(0.05);
  });

  it('nennt in jeder Begründung nachprüfbare Zahlen (Journal-Tauglichkeit)', () => {
    const v = judgeCandidate(
      { pnls: serie(40, 12), label: 'Ruhig' },
      { pnls: serie(40, 2), label: 'Hektisch' },
    );
    expect(v.reason).toMatch(/p = 0\./);
    expect(v.reason).toMatch(/40 gegen 40 Trades/);
    expect(v.nCandidate).toBe(40);
  });
});
