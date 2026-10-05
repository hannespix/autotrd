/**
 * Qualitätsfilter im Momentum-Lauf (Befund 05.10.): Der Sockel kaufte
 * Kleinwerte und gehebelte ETFs aus dem Alpaca-Universum. Gepinnt wird das
 * Verhalten von `qualitaetsUrteile` gegen gemockte Datenquellen — vor allem,
 * dass verworfene Kandidaten ERSETZT werden (das Ziel bleibt voll) und dass
 * ungeprüfte Universums-Symbole nie durch die Hintertür ins Ziel rutschen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const namen = new Map<string, string>();
const umsaetze = new Map<string, number | 'fehler'>();

vi.mock('../src/core/universumLeser.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/universumLeser.js')>()),
  ladeUniversumNamen: vi.fn(async () => namen),
}));
vi.mock('../src/core/marketData.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/marketData.js')>()),
  getMarketSnapshot: vi.fn(async (sym: string) => {
    const u = umsaetze.get(sym);
    if (u === undefined || u === 'fehler') throw new Error('yahoo down');
    // 20 Tage: Kurs 10 × Volumen so, dass Kurs×Volumen = u
    return { symbol: sym, price: 10, changePct: 0, source: 'yahoo', bars: Array.from({ length: 20 }, () => ({ date: '2026-10-01', open: 10, high: 10, low: 10, close: 10, volume: u / 10 })) };
  }),
}));

const { qualitaetsUrteile } = await import('../src/scheduled/momentumRun.js');
const { filtereRangliste, targetPortfolio } = await import('../../shared/src/index.js');

const closes = (preis: number): number[] => Array.from({ length: 250 }, () => preis);

describe('qualitaetsUrteile', () => {
  beforeEach(() => {
    namen.clear();
    umsaetze.clear();
  });

  it('verwirft Hebel, Penny, dünnen Umsatz, Abruf-Fehler und fehlenden Namen — lässt Liquides durch', async () => {
    namen.set('MUU', 'Direxion Daily MU Bull 2X Shares');
    namen.set('PENNY', 'Penny Corp');
    namen.set('CCG', 'Thin Corp');
    namen.set('KAPUTT', 'Kaputt Inc');
    namen.set('GUT', 'Gut Inc');
    umsaetze.set('CCG', 1_000_000);
    umsaetze.set('KAPUTT', 'fehler');
    umsaetze.set('GUT', 50_000_000);
    const ranked = ['MUU', 'PENNY', 'CCG', 'KAPUTT', 'OHNENAME', 'GUT'].map((symbol, i) => ({ symbol, score: 1 - i * 0.1 }));
    const cm = new Map(ranked.map((r) => [r.symbol, closes(r.symbol === 'PENNY' ? 2 : 20)]));
    const { mangel } = await qualitaetsUrteile(ranked, new Set(), cm);
    expect(['MUU', 'PENNY', 'CCG', 'KAPUTT', 'OHNENAME', 'GUT'].map(mangel)).toEqual([
      'hebel', 'preis', 'umsatz', 'keine_daten', 'keine_daten', null,
    ]);
  });

  it('Katalog-Symbole gelten ungeprüft als zugelassen — ohne einen Abruf', async () => {
    const { mangel, geprueft } = await qualitaetsUrteile([{ symbol: 'AAPL', score: 1 }], new Set(['AAPL']), new Map());
    expect(mangel('AAPL')).toBeNull();
    expect(geprueft.size).toBe(0);
  });

  it('ein ungeprüftes Universums-Symbol (hinter dem Fenster) gilt als keine_daten', async () => {
    const { mangel } = await qualitaetsUrteile([], new Set(), new Map());
    expect(mangel('IRGENDWAS')).toBe('keine_daten');
  });

  it('das Ziel bleibt VOLL: verworfene Spitzen werden durch den Nächstbesten ersetzt', async () => {
    // 4 Exoten an der Spitze, dahinter 10 Katalog-Werte.
    const exoten = ['MUU', 'MULL', 'DUKR', 'BVC'];
    exoten.forEach((s) => namen.set(s, `${s} Daily Target 2X ETF`));
    const katalog = Array.from({ length: 10 }, (_, i) => `K${i}`);
    const ranked = [...exoten, ...katalog].map((symbol, i) => ({ symbol, score: 2 - i * 0.1 }));
    const { mangel } = await qualitaetsUrteile(ranked, new Set(katalog), new Map());
    const zugelassen = filtereRangliste(ranked, mangel).zugelassen;
    const ziel = targetPortfolio(zugelassen, true, 8);
    expect(ziel).toHaveLength(8);
    expect(ziel.map((z) => z.symbol)).toEqual(katalog.slice(0, 8));
  });
});

describe('Quelltext-Wächter', () => {
  const lauf = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'momentumRun.ts'), 'utf8');
  it('Ziel und veröffentlichte Spitze kommen aus der GEFILTERTEN Rangliste', () => {
    expect(lauf).toContain('const ziel = targetPortfolio(rankedQ, marktOffen, MOMENTUM_TOP_N);');
    expect(lauf).toContain('top: rankedQ.slice(0, MOMENTUM_TOP_N)');
    expect(lauf).not.toContain('targetPortfolio(ranked, marktOffen');
  });
});

describe('qualitaetsUrteile — Datenausfall wird als unsicher gemeldet', () => {
  it('keine Namen bei vorhandenen Kandidaten → unsicher', async () => {
    namen.clear();
    const { unsicher } = await qualitaetsUrteile([{ symbol: 'X', score: 1 }], new Set(), new Map());
    expect(unsicher).toBe(true);
  });
  it('jeder Umsatz-Abruf gescheitert → unsicher; einer gelungen → nicht', async () => {
    namen.clear();
    umsaetze.clear();
    namen.set('A', 'A Inc');
    namen.set('B', 'B Inc');
    umsaetze.set('A', 'fehler');
    umsaetze.set('B', 'fehler');
    const cm = new Map([['A', closes(20)], ['B', closes(20)]]);
    const ranked = [{ symbol: 'A', score: 1 }, { symbol: 'B', score: 0.9 }];
    expect((await qualitaetsUrteile(ranked, new Set(), cm)).unsicher).toBe(true);
    umsaetze.set('B', 50_000_000);
    expect((await qualitaetsUrteile(ranked, new Set(), cm)).unsicher).toBe(false);
  });
});
