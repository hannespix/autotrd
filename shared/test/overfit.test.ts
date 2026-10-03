import { describe, expect, it } from 'vitest';
import {
  beurteileBefoerderung,
  deflatedSharpe,
  DSR_SCHWELLE,
  erwartetesMaxSharpe,
  MIN_TEST_RENDITEN,
  momente,
  normalCdf,
  normalQuantil,
  probabilisticSharpe,
  sharpeAusRenditen,
  teileWalkForward,
  WALK_FORWARD_WARMUP,
} from '../src/index.js';

/** Deterministische „Rendite"-Serie mit wählbarer Drift — kein Math.random. */
function serie(n: number, drift: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < n; i++) {
    // Pseudo-Rauschen aus einer festen Sinus-Mischung: reproduzierbar,
    // mittelwertarm, mit realistischer Streuung.
    const rauschen = 0.01 * Math.sin(i * 12.9898) + 0.007 * Math.sin(i * 78.233 + 1.3);
    r.push(drift + rauschen);
  }
  return r;
}

describe('Normalverteilung (Näherungen)', () => {
  it('Φ trifft die Standardwerte', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });
  it('Φ⁻¹ ist die Umkehrung', () => {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.975, 0.999]) {
      expect(normalCdf(normalQuantil(p))).toBeCloseTo(p, 5);
    }
    expect(normalQuantil(0.975)).toBeCloseTo(1.9600, 3);
  });
  it('außerhalb (0,1) gibt es kein Quantil', () => {
    expect(Number.isNaN(normalQuantil(0))).toBe(true);
    expect(Number.isNaN(normalQuantil(1))).toBe(true);
  });
});

describe('momente / sharpeAusRenditen', () => {
  it('bekannte kleine Serie', () => {
    const m = momente([0.01, -0.01, 0.02, 0, -0.02])!;
    expect(m.n).toBe(5);
    expect(m.mittel).toBeCloseTo(0, 10);
    expect(m.sd).toBeCloseTo(0.0158, 3);
    // Symmetrische Serie: Schiefe ~0.
    expect(Math.abs(m.schiefe)).toBeLessThan(0.3);
  });
  it('zu kurz oder ohne Streuung → null', () => {
    expect(momente([0.01, 0.02])).toBeNull();
    expect(momente([0.01, 0.01, 0.01])).toBeNull();
    expect(sharpeAusRenditen([1, 1, 1])).toBeNull();
  });
  it('positive Drift ⇒ positiver Sharpe', () => {
    expect(sharpeAusRenditen(serie(100, 0.005))!).toBeGreaterThan(0);
    expect(sharpeAusRenditen(serie(100, -0.005))!).toBeLessThan(0);
  });
});

describe('probabilisticSharpe', () => {
  it('SR gleich der Latte → 50 %', () => {
    expect(probabilisticSharpe(0.1, 0.1, 100, 0, 3)).toBeCloseTo(0.5, 6);
  });
  it('mehr Daten ⇒ mehr Gewissheit bei gleichem Abstand', () => {
    const wenig = probabilisticSharpe(0.2, 0, 30, 0, 3);
    const viel = probabilisticSharpe(0.2, 0, 300, 0, 3);
    expect(viel).toBeGreaterThan(wenig);
  });
  it('schwere Ränder (hohe Kurtosis) drücken die Gewissheit', () => {
    const normal = probabilisticSharpe(0.2, 0, 100, 0, 3);
    const fett = probabilisticSharpe(0.2, 0, 100, 0, 9);
    expect(fett).toBeLessThan(normal);
  });
});

describe('erwartetesMaxSharpe (die Zufalls-Latte)', () => {
  it('ein einziger Versuch hat keine Selektions-Latte', () => {
    expect(erwartetesMaxSharpe(1, 0.01)).toBe(0);
  });
  it('wächst monoton mit der Anzahl der Versuche', () => {
    const e10 = erwartetesMaxSharpe(10, 0.01);
    const e100 = erwartetesMaxSharpe(100, 0.01);
    const e1000 = erwartetesMaxSharpe(1000, 0.01);
    expect(e10).toBeGreaterThan(0);
    expect(e100).toBeGreaterThan(e10);
    expect(e1000).toBeGreaterThan(e100);
  });
});

describe('deflatedSharpe — die Kern-Eigenschaft der Bremse', () => {
  it('derselbe Sharpe überzeugt bei 1 Versuch, aber nicht mehr bei 500', () => {
    const r = serie(150, 0.002);
    const ehrlich = deflatedSharpe(r, 1)!;
    const gesucht = deflatedSharpe(r, 500)!;
    expect(ehrlich.sr).toBeCloseTo(gesucht.sr, 12); // gleiche Daten, gleicher SR
    expect(gesucht.sr0).toBeGreaterThan(ehrlich.sr0); // aber höhere Latte
    expect(gesucht.dsr).toBeLessThan(ehrlich.dsr); // und weniger Gewissheit
  });
  it('unbrauchbare Eingaben → null', () => {
    expect(deflatedSharpe([0.01], 10)).toBeNull();
    expect(deflatedSharpe(serie(50, 0.001), 0)).toBeNull();
  });
});

describe('teileWalkForward', () => {
  const bars = Array.from({ length: 400 }, (_, i) => ({ i }));
  it('Test liegt strikt nach der Suche; Warmup-Vorlauf überlappt bewusst', () => {
    const s = teileWalkForward(bars)!;
    expect(s.such.length + s.test.length - WALK_FORWARD_WARMUP).toBe(bars.length);
    // Der erste ECHTE Test-Bar ist der Bar direkt NACH dem Suchfenster.
    expect(s.test[s.testBeginn]).toBe(bars[s.such.length]);
    // Der Vorlauf davor stammt aus dem Suchfenster (Indikator-Futter, kein Handel).
    expect(s.test[0]).toBe(bars[s.such.length - WALK_FORWARD_WARMUP]);
  });
  it('zu kurze Serien beurteilen nichts', () => {
    expect(teileWalkForward(bars.slice(0, 100))).toBeNull();
  });
  it('Mindest-Testlänge wird respektiert', () => {
    const s = teileWalkForward(bars, { minTest: 150 })!;
    expect(s.test.length - WALK_FORWARD_WARMUP).toBeGreaterThanOrEqual(150);
  });
});

describe('beurteileBefoerderung (der Abnahme-Fall des Milestones)', () => {
  it('gewinnt in der Suche, verliert im Test → NICHT befördert, Grund nennt Walk-Forward', () => {
    const u = beurteileBefoerderung({
      suchRenditen: serie(200, 0.004),
      testRenditen: serie(80, -0.004),
      nVersuche: 5,
    });
    expect(u.befoerdern).toBe(false);
    expect(u.gruende.join(' ')).toMatch(/Walk-Forward/);
  });
  it('trägt in Suche UND Test mit wenigen Versuchen → befördert', () => {
    const u = beurteileBefoerderung({
      suchRenditen: serie(200, 0.004),
      testRenditen: serie(80, 0.004),
      nVersuche: 3,
    });
    expect(u.befoerdern).toBe(true);
    expect(u.gruende).toEqual([]);
    expect(u.suche!.dsr).toBeGreaterThanOrEqual(DSR_SCHWELLE);
    expect(u.testSharpe!).toBeGreaterThan(0);
  });
  it('derselbe Sieg fällt durch, wenn er aus TAUSENDEN Versuchen stammt', () => {
    const u = beurteileBefoerderung({
      suchRenditen: serie(200, 0.0015),
      testRenditen: serie(80, 0.004),
      nVersuche: 100_000,
    });
    expect(u.befoerdern).toBe(false);
    expect(u.gruende.join(' ')).toMatch(/Würfeln/);
  });
  it('zu dünnes Testfenster trägt kein Urteil', () => {
    const u = beurteileBefoerderung({
      suchRenditen: serie(200, 0.004),
      testRenditen: serie(MIN_TEST_RENDITEN - 1, 0.004),
      nVersuche: 3,
    });
    expect(u.befoerdern).toBe(false);
    expect(u.gruende.join(' ')).toMatch(/Testfenster zu dünn/);
  });
});
