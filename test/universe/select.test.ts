/**
 * Die nächtliche Universums-Auswahl.
 *
 * Der Fehler, gegen den hier geprüft wird, ist der teuerste im ganzen Repo:
 * ein Universum nach vergangenem ERTRAG zusammenzustellen und es anschließend
 * auf denselben Daten zu messen. Das Ergebnis sieht immer gut aus und ist
 * immer wertlos. Deshalb bekommt `waehleUniverse` Bars und sonst nichts — sie
 * KANN nicht nach Ertrag sortieren —, und die Tests halten fest, dass die
 * Rangfolge allein am Umsatz hängt.
 */
import { describe, expect, it } from 'vitest';
import type { Bar } from '../../src/core/types.ts';
import { UNIVERSE_REGELN, waehleUniverse, type UniverseRegeln } from '../../src/universe/select.ts';

const TAG = 86_400_000;
const JETZT = Date.UTC(2026, 8, 8, 12, 0, 0);

const regeln: UniverseRegeln = { ...UNIVERSE_REGELN, max: 3, fensterTage: 10, minTage: 8, minPreis: 5, minDollarVolumen: 1_000_000, maxAlterTage: 5, haltePuffer: 1 };

/** `n` Tagesbars, letzte bei `JETZT - alterTage`, mit Kurs `preis` und Umsatz `preis*vol`. */
function bars(n: number, preis: number, vol: number, alterTage = 1, gewinnProTag = 0): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = preis + gewinnProTag * i;
    out.push({ t: JETZT - (alterTage + (n - 1 - i)) * TAG, o: c, h: c, l: c, c, v: vol });
  }
  return out;
}

function korb(spec: Record<string, Bar[]>): Map<string, Bar[]> {
  return new Map(Object.entries(spec));
}

describe('waehleUniverse', () => {
  it('rankt nach Median-Dollarumsatz, nicht nach Kursgewinn', () => {
    // RAKETE hat den mit Abstand höchsten Ertrag (+400 %), aber den kleinsten Umsatz.
    // Wenn sie ins Universum rutscht, wäre die Auswahl ertragsgetrieben — der Kardinalfehler.
    const a = waehleUniverse({
      kandidaten: korb({
        DICK: bars(10, 100, 1_000_000),
        MITTEL: bars(10, 100, 500_000),
        DUENN: bars(10, 100, 100_000),
        RAKETE: bars(10, 20, 60_000, 1, 20),
      }),
      pflicht: [],
      bestand: [],
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toEqual(['DICK', 'MITTEL', 'DUENN']);
    expect(a.symbols, 'Ertrag darf die Auswahl nicht beeinflussen').not.toContain('RAKETE');
  });

  it('lässt einen einzelnen Umsatzausreißer ein dünnes Symbol nicht hochtragen (Median statt Mittelwert)', () => {
    const spitze = bars(10, 100, 100_000);
    spitze[9] = { ...spitze[9]!, v: 100_000_000 }; // Quartalszahlen
    const a = waehleUniverse({
      kandidaten: korb({ A: bars(10, 100, 600_000), B: bars(10, 100, 500_000), C: bars(10, 100, 400_000), SPITZE: spitze }),
      pflicht: [],
      bestand: [],
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toEqual(['A', 'B', 'C']);
  });

  it('wirft dünne, billige, lückenhafte und tote Symbole raus — mit Begründung', () => {
    const a = waehleUniverse({
      kandidaten: korb({
        GUT: bars(10, 100, 200_000),
        DUENN: bars(10, 100, 1_000),
        BILLIG: bars(10, 2, 5_000_000),
        LUECKE: bars(4, 100, 200_000),
        TOT: bars(10, 100, 200_000, 40),
      }),
      pflicht: [],
      bestand: [],
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toEqual(['GUT']);
    const grund = (s: string) => a.bewertung.find((b) => b.symbol === s)!.grund;
    expect(grund('DUENN')).toContain('Median-Umsatz');
    expect(grund('BILLIG')).toContain('Spread');
    expect(grund('LUECKE')).toContain('Tagesbars im Fenster');
    expect(grund('TOT')).toContain('Delisting');
  });

  it('nimmt den Benchmark immer mit', () => {
    const a = waehleUniverse({
      kandidaten: korb({ A: bars(10, 100, 900_000), B: bars(10, 100, 800_000), C: bars(10, 100, 700_000), SPY: bars(10, 100, 200_000) }),
      pflicht: ['SPY'],
      bestand: [],
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toContain('SPY');
    expect(a.symbols).toHaveLength(3);
    expect(a.bewertung.find((b) => b.symbol === 'SPY')!.status).toBe('pflicht');
  });

  it('bricht ab, wenn der Benchmark die Prüfung nicht besteht — ohne ihn greift kein Marktfilter', () => {
    expect(() =>
      waehleUniverse({ kandidaten: korb({ A: bars(10, 100, 900_000), SPY: bars(3, 100, 900_000) }), pflicht: ['SPY'], bestand: [], regeln, jetzt: JETZT }),
    ).toThrow(/Pflichtsymbol SPY/);
    expect(() => waehleUniverse({ kandidaten: korb({ A: bars(10, 100, 900_000) }), pflicht: ['SPY'], bestand: [], regeln, jetzt: JETZT })).toThrow(
      /nicht im Kandidatenpool/,
    );
  });

  it('Hysterese: Bestand behält den Platz knapp hinter der Grenze, fällt aber weiter hinten raus', () => {
    // Ränge: A 900, B 800, C 700, D 600, E 500. max=3, haltePuffer=1 ⇒ Halten bis Rang 4.
    const kandidaten = korb({
      A: bars(10, 100, 900_000),
      B: bars(10, 100, 800_000),
      C: bars(10, 100, 700_000),
      D: bars(10, 100, 600_000),
      E: bars(10, 100, 500_000),
    });
    const drin = waehleUniverse({ kandidaten, pflicht: [], bestand: ['A', 'B', 'D'], regeln, jetzt: JETZT });
    expect(drin.symbols, 'D auf Rang 4 bleibt, C auf Rang 3 muss warten').toEqual(['A', 'B', 'D']);
    expect(drin.zugang).toEqual([]);
    expect(drin.abgang).toEqual([]);

    const raus = waehleUniverse({ kandidaten, pflicht: [], bestand: ['A', 'B', 'E'], regeln, jetzt: JETZT });
    expect(raus.symbols, 'E auf Rang 5 liegt hinter dem Puffer').toEqual(['A', 'B', 'C']);
    expect(raus.zugang).toEqual(['C']);
    expect(raus.abgang).toEqual(['E']);
  });

  it('ist deterministisch: Gleichstand alphabetisch, Reihenfolge der Eingabe egal', () => {
    const spec = { ZZZ: bars(10, 100, 500_000), AAA: bars(10, 100, 500_000), MMM: bars(10, 100, 500_000), BBB: bars(10, 100, 500_000) };
    const vor = waehleUniverse({ kandidaten: korb(spec), pflicht: [], bestand: [], regeln, jetzt: JETZT });
    const rueck = waehleUniverse({
      kandidaten: new Map([...Object.entries(spec)].reverse()),
      pflicht: [],
      bestand: [],
      regeln,
      jetzt: JETZT,
    });
    expect(vor.symbols).toEqual(['AAA', 'BBB', 'MMM']);
    expect(rueck.symbols).toEqual(vor.symbols);
  });

  it('liefert weniger als max, wenn nicht genug Kandidaten bestehen — lieber klein als schlecht', () => {
    const a = waehleUniverse({ kandidaten: korb({ A: bars(10, 100, 900_000), B: bars(10, 1, 900_000) }), pflicht: [], bestand: [], regeln, jetzt: JETZT });
    expect(a.symbols).toEqual(['A']);
  });

  it('meldet Zugang und Abgang, damit der Bericht die Änderung nennt', () => {
    const a = waehleUniverse({
      kandidaten: korb({ NEU: bars(10, 100, 900_000), ALT: bars(10, 1, 900_000) }),
      pflicht: [],
      bestand: ['ALT'],
      regeln,
      jetzt: JETZT,
    });
    expect(a.zugang).toEqual(['NEU']);
    expect(a.abgang).toEqual(['ALT']);
  });
});
