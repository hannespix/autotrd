/**
 * Klassentabellen des Profils ⇄ Kandidatenpool der Plattform (Drift-Wächter,
 * Red-Team 10.09.2026, G6).
 *
 * Die Anlageklasse je Symbol steht als feste Tabelle im Modul — bewusst ohne
 * externe Quelle. Der Preis: Sie kann vom Pool in `config/platform.yaml`
 * abdriften, und ein neuer ETF im Pool erschiene stumm als „Aktie" ohne
 * Sektor. Dieser Test macht die Drift zum roten Lauf, in beide Richtungen.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { BASIS_KLASSEN, ETF_KLASSEN, klasseVon, SEKTOREN } from '../../src/profile/symbolprofile.ts';

const cfg = parseYaml(readFileSync('config/platform.yaml', 'utf8')) as { universe: { candidates: string[]; benchmark?: string } };
const kandidaten = cfg.universe.candidates;

describe('Klassentabellen ⇄ config/platform.yaml', () => {
  it('der Pool ist groß genug, dass der Wächter etwas prüft', () => {
    expect(kandidaten.length).toBeGreaterThan(100);
  });

  it('jeder Kandidat hat eine Klasse — kein ETF fällt stumm auf „Aktie" zurück', () => {
    const ohne = kandidaten.filter((s) => !(s in BASIS_KLASSEN) && !(s in ETF_KLASSEN) && !(s in SEKTOREN));
    expect(ohne).toEqual([]);
    for (const s of kandidaten) {
      const k = klasseVon(s, cfg.universe.benchmark);
      // Eine Aktie heißt „Aktie" — aber nur mit Sektor; ohne Sektor wäre sie ein unbekanntes Symbol.
      if (k.cluster === 'aktie') expect(k.sektor, s).not.toBeNull();
      else expect(k.klasse, s).not.toBe('Aktie');
    }
  });

  it('kein Tabelleneintrag außerhalb des Pools — tote Einträge täuschten Abdeckung vor', () => {
    const pool = new Set(kandidaten);
    const tot = [...Object.keys(BASIS_KLASSEN), ...Object.keys(ETF_KLASSEN), ...Object.keys(SEKTOREN)].filter((s) => !pool.has(s));
    expect(tot).toEqual([]);
  });

  it('kein Symbol steht in zwei Tabellen; die neun Basis-ETFs sind Basis-Klasse', () => {
    const alle = [...Object.keys(BASIS_KLASSEN), ...Object.keys(ETF_KLASSEN), ...Object.keys(SEKTOREN)];
    expect(new Set(alle).size).toBe(alle.length);
    expect(Object.keys(BASIS_KLASSEN).sort()).toEqual(['EEM', 'EFA', 'GLD', 'IEF', 'IWM', 'LQD', 'SPY', 'TLT', 'XLRE']);
    for (const s of Object.keys(BASIS_KLASSEN)) expect(klasseVon(s, 'SPY').cluster, s).toBe('basis_etf');
  });
});
