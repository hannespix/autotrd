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

const regeln: UniverseRegeln = {
  ...UNIVERSE_REGELN,
  max: 3,
  fensterTage: 10,
  minTage: 8,
  minPreis: 5,
  minDollarVolumen: 1_000_000,
  maxAlterTage: 5,
  haltePuffer: 1,
  // Die Notbremsen haben eigene Tests weiter unten; sonst störten sie hier jeden Aufbau.
  minAnteil: 0,
  maxAbgang: 99,
};

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
  it('rankt nach Dollarumsatz — kein PnL, keine Trades, kein Champion im Eingang', () => {
    const a = waehleUniverse({
      kandidaten: korb({
        DICK: bars(10, 100, 1_000_000),
        MITTEL: bars(10, 100, 500_000),
        DUENN: bars(10, 100, 100_000),
        RAKETE: bars(10, 20, 60_000, 1, 20),
      }),
      pflicht: [],
      bestand: [],
      bestandIstAuswahl: false,
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toEqual(['DICK', 'MITTEL', 'DUENN']);
  });

  /**
   * Ehrliche Grenze der Kennzahl, vom Red-Team belegt: Dollarumsatz ist
   * Stückzahl × KURS, und der Kurs ist das Ergebnis vergangener Rendite. Bei
   * gleicher Stückzahl gewinnt also der Wert, der gestiegen ist.
   *
   * Das bleibt so — Dollarumsatz ist das richtige Handelbarkeitsmaß, denn was
   * zählt, sind bewegbare Dollar, nicht Stückzahlen. Der Test hält den Effekt
   * fest, damit niemand später behauptet, die Auswahl sei renditeblind. Sie ist
   * frei vom STRATEGIE-Ergebnis (kein PnL, keine Trades, kein Champion) — nicht
   * frei vom Kursniveau.
   */
  it('ist NICHT renditeneutral: bei gleicher Stückzahl gewinnt der gestiegene Wert', () => {
    // 600 000 Stück: flach bei 20 $ sind das 12 Mio. $/Tag (fällt durch), steigend
    // von 20 auf 200 $ ist der Median-Kurs 110 $ und damit 66 Mio. $/Tag (kommt rein).
    const stueck = 600_000;
    const rest = { A: bars(10, 100, 600_000), B: bars(10, 100, 500_000), C: bars(10, 100, 400_000) };
    // Startet bei 20 $, steigt auf 200 $ — Stückzahl konstant.
    const gestiegen = waehleUniverse({
      kandidaten: korb({ ...rest, STEIGER: bars(10, 20, stueck, 1, 20) }),
      pflicht: [],
      bestand: [],
      bestandIstAuswahl: false,
      regeln,
      jetzt: JETZT,
    });
    const flach = waehleUniverse({ kandidaten: korb({ ...rest, STEIGER: bars(10, 20, stueck) }), pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT });
    expect(gestiegen.symbols, 'so sieht der Effekt aus — dokumentiert, nicht wegbehauptet').toContain('STEIGER');
    expect(flach.symbols, 'derselbe Wert ohne Kursgewinn fällt durch').not.toContain('STEIGER');
  });

  it('sieht kein Strategie-Ergebnis: der Eingang hat gar kein Feld dafür', () => {
    const kandidaten = korb({ A: bars(10, 100, 600_000), B: bars(10, 100, 500_000), C: bars(10, 100, 400_000), D: bars(10, 100, 300_000) });
    const args = { kandidaten, pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT };
    expect(Object.keys(args).sort(), 'kein PnL, keine Trades, kein Champion').toEqual(
      ['bestand', 'bestandIstAuswahl', 'jetzt', 'kandidaten', 'pflicht', 'regeln'],
    );
    expect(waehleUniverse(args).symbols).toEqual(waehleUniverse(args).symbols);
  });

  it('lässt einen einzelnen Umsatzausreißer ein dünnes Symbol nicht hochtragen (Median statt Mittelwert)', () => {
    const spitze = bars(10, 100, 100_000);
    spitze[9] = { ...spitze[9]!, v: 100_000_000 }; // Quartalszahlen
    const a = waehleUniverse({
      kandidaten: korb({ A: bars(10, 100, 600_000), B: bars(10, 100, 500_000), C: bars(10, 100, 400_000), SPITZE: spitze }),
      pflicht: [],
      bestand: [],
      bestandIstAuswahl: false,
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
      bestandIstAuswahl: false,
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
      bestandIstAuswahl: false,
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toContain('SPY');
    expect(a.symbols).toHaveLength(3);
    expect(a.bewertung.find((b) => b.symbol === 'SPY')!.status).toBe('pflicht');
  });

  it('bricht ab, wenn der Benchmark die Prüfung nicht besteht — ohne ihn greift kein Marktfilter', () => {
    expect(() =>
      waehleUniverse({ kandidaten: korb({ A: bars(10, 100, 900_000), SPY: bars(3, 100, 900_000) }), pflicht: ['SPY'], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT }),
    ).toThrow(/Pflichtsymbol SPY/);
    expect(() => waehleUniverse({ kandidaten: korb({ A: bars(10, 100, 900_000) }), pflicht: ['SPY'], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT })).toThrow(
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
    const drin = waehleUniverse({ kandidaten, pflicht: [], bestand: ['A', 'B', 'D'], bestandIstAuswahl: true, regeln, jetzt: JETZT });
    expect(drin.symbols, 'D auf Rang 4 bleibt, C auf Rang 3 muss warten').toEqual(['A', 'B', 'D']);
    expect(drin.zugang).toEqual([]);
    expect(drin.abgang).toEqual([]);

    const raus = waehleUniverse({ kandidaten, pflicht: [], bestand: ['A', 'B', 'E'], bestandIstAuswahl: true, regeln, jetzt: JETZT });
    expect(raus.symbols, 'E auf Rang 5 liegt hinter dem Puffer').toEqual(['A', 'B', 'C']);
    expect(raus.zugang).toEqual(['C']);
    expect(raus.abgang).toEqual(['E']);
  });

  it('ist deterministisch: Gleichstand alphabetisch, Reihenfolge der Eingabe egal', () => {
    const spec = { ZZZ: bars(10, 100, 500_000), AAA: bars(10, 100, 500_000), MMM: bars(10, 100, 500_000), BBB: bars(10, 100, 500_000) };
    const vor = waehleUniverse({ kandidaten: korb(spec), pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT });
    const rueck = waehleUniverse({
      kandidaten: new Map([...Object.entries(spec)].reverse()),
      pflicht: [],
      bestand: [],
      bestandIstAuswahl: false,
      regeln,
      jetzt: JETZT,
    });
    expect(vor.symbols).toEqual(['AAA', 'BBB', 'MMM']);
    expect(rueck.symbols).toEqual(vor.symbols);
  });

  it('liefert weniger als max, wenn nicht genug Kandidaten bestehen — lieber klein als schlecht', () => {
    const a = waehleUniverse({ kandidaten: korb({ A: bars(10, 100, 900_000), B: bars(10, 1, 900_000) }), pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT });
    expect(a.symbols).toEqual(['A']);
  });

  it('meldet Zugang und Abgang, damit der Bericht die Änderung nennt', () => {
    const a = waehleUniverse({
      kandidaten: korb({ NEU: bars(10, 100, 900_000), ALT: bars(10, 1, 900_000) }),
      pflicht: [],
      bestand: ['ALT'],
      bestandIstAuswahl: true,
      regeln,
      jetzt: JETZT,
    });
    expect(a.zugang).toEqual(['NEU']);
    expect(a.abgang).toEqual(['ALT']);
  });
});

/**
 * Notbremsen gegen Datenausfall.
 *
 * `backfill` überspringt fehlgeschlagene Blöcke und macht weiter — ohne diese
 * Prüfungen hätte ein Ausfall für 29 von 30 Werten anstandslos ein Universum
 * `["SPY"]` veröffentlicht, und alle offenen Positionen hätten damit ihre
 * führende Strategie verloren. Scheitert die Wahl, bleibt alles stehen.
 */
describe('waehleUniverse — Notbremsen', () => {
  const scharf: UniverseRegeln = { ...regeln, minAnteil: 0.8, maxAbgang: 2 };
  const zehn = () => korb(Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((s, i) => [s, bars(10, 100, (10 - i) * 100_000)])));

  it('bricht ab, wenn zu wenige Kandidaten Daten geliefert haben', () => {
    const kaputt = korb({ A: bars(10, 100, 900_000), B: [], C: [], D: [] });
    expect(() => waehleUniverse({ kandidaten: kaputt, pflicht: [], bestand: [], bestandIstAuswahl: false, regeln: scharf, jetzt: JETZT })).toThrow(
      /Datenausfall, kein Liquiditätsurteil/,
    );
  });

  it('nennt „keine Daten" als Grund, nicht „zu illiquide"', () => {
    const a = waehleUniverse({
      kandidaten: korb({ A: bars(10, 100, 900_000), B: bars(10, 100, 800_000), C: bars(10, 100, 700_000), TOT: [] }),
      pflicht: [],
      bestand: [],
      bestandIstAuswahl: false,
      regeln,
      jetzt: JETZT,
    });
    expect(a.bewertung.find((b) => b.symbol === 'TOT')!.grund).toContain('Datenausfall');
  });

  it('bricht ab, wenn eine Nacht zu viele Symbole austauschen würde', () => {
    expect(() =>
      waehleUniverse({ kandidaten: zehn(), pflicht: [], bestand: ['H', 'I', 'J'], bestandIstAuswahl: true, regeln: scharf, jetzt: JETZT }),
    ).toThrow(/3 Symbole auf einmal austauschen/);
  });

  it('lässt den ERSTEN Lauf gegen echte Daten die Config-Liste neu bestimmen', () => {
    const a = waehleUniverse({ kandidaten: zehn(), pflicht: [], bestand: ['H', 'I', 'J'], bestandIstAuswahl: false, regeln: scharf, jetzt: JETZT });
    expect(a.symbols).toEqual(['A', 'B', 'C']);
    expect(a.abgang).toEqual(['H', 'I', 'J']);
  });
});

describe('waehleUniverse ist kausal — sie schneidet bei jetzt, statt es vorauszusetzen', () => {
  // Drei Stichtags-Proben am 09.09.2026 (Läufe #24, #25, #26) wählten „per
  // September 2025" denselben Korb wie heute, SPY zu 766 $: Der Cache reichte
  // Bars bis heute herein, `slice(-fensterTage)` nahm die letzten davon, und
  // eine Bar aus der Zukunft war laut `Math.max(0, …)` null Tage alt.
  const zukunft = (preis: number, vol: number) => bars(10, preis, vol, -30); // 10 Bars, die 30 Tage NACH jetzt enden

  it('Bars nach jetzt zählen weder für Umsatz noch für Kurs noch für das Alter', () => {
    // A: bis jetzt billig und dünn, danach teuer und liquide. B: bis jetzt solide.
    const kandidaten = korb({
      A: [...bars(10, 10, 150_000), ...zukunft(1000, 500_000)],
      B: bars(10, 100, 50_000),
    });
    const a = waehleUniverse({ kandidaten, pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT });
    const bewA = a.bewertung.find((b) => b.symbol === 'A')!;
    const bewB = a.bewertung.find((b) => b.symbol === 'B')!;
    expect(bewA.dollarVolumen).toBe(1_500_000); // 10 × 150 000, nicht 1000 × 500 000
    expect(bewB.dollarVolumen).toBe(5_000_000);
    expect(a.symbols).toEqual(['B', 'A']); // B liegt vorn — mit den Zukunfts-Bars läge A vorn
  });

  it('ein Symbol, das nur Bars nach jetzt hat, hat KEINE Daten — es ist nicht null Tage alt', () => {
    const a = waehleUniverse({
      kandidaten: korb({ Z: zukunft(100, 100_000), B: bars(10, 100, 50_000) }),
      pflicht: [],
      bestand: [],
      bestandIstAuswahl: false,
      regeln,
      jetzt: JETZT,
    });
    expect(a.symbols).toEqual(['B']);
    expect(a.bewertung.find((b) => b.symbol === 'Z')!.grund).toMatch(/keine Tagesbars/);
  });

  it('die Bar des Stichtags selbst gehört dazu (Bucket-Beginn ≤ Ende des Tages)', () => {
    // Letzte Bar beginnt genau bei JETZT: dazu. Eine, die eine Stunde später beginnt: nicht.
    const genau = bars(10, 100, 50_000, 0);
    const spaeter = genau.map((b) => ({ ...b, t: b.t + 3_600_000 }));
    const mit = waehleUniverse({ kandidaten: korb({ A: genau }), pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT });
    const ohne = waehleUniverse({ kandidaten: korb({ A: spaeter }), pflicht: [], bestand: [], bestandIstAuswahl: false, regeln, jetzt: JETZT });
    expect(mit.bewertung.find((b) => b.symbol === 'A')!.tage).toBe(10);
    expect(ohne.bewertung.find((b) => b.symbol === 'A')!.tage).toBe(9);
  });
});
