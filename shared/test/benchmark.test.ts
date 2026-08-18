/**
 * Die Vergleichslinie — und die drei Arten, wie sie lügen könnte.
 *
 * Owner 18.08.: „gestern waren wir noch knapp 4000 im plus", am nächsten Tag
 * stand die Bilanz bei 1 140 $. Ohne Maßstab lässt sich nicht sagen, ob das
 * der Markt war oder das System. Mit Maßstab schon — vorausgesetzt, der
 * Maßstab selbst stimmt.
 *
 * Die drei Fehler, gegen die hier geprüft wird, sind alle unsichtbar: eine
 * Linie über einen Depot-Schnitt hinweg, eine gerade Linie durch eine
 * Datenlücke, und ein Vorsprung, der aus einem einzigen Punkt gerechnet wird.
 * Jeder davon sähe im Bild völlig plausibel aus.
 */
import { describe, expect, it } from 'vitest';
import { benchmarkKurve, benchmarkSatz } from '../src/benchmark.js';

const p = (date: string, equity: number, benchClose?: number | null) => ({
  date,
  equity,
  ...(benchClose === undefined ? {} : { benchClose }),
});

describe('benchmarkKurve — die Rechnung', () => {
  it('startet mit demselben Kapital und folgt dann dem Index', () => {
    const a = benchmarkKurve([
      p('2026-08-01', 100_000, 5_000),
      p('2026-08-02', 101_000, 5_050), // Index +1 %
      p('2026-08-03', 99_000, 5_100), // Index +2 %
    ]);
    expect(a.kurve.map((x) => x.bench)).toEqual([100_000, 101_000, 102_000]);
    expect(a.depotPct).toBe(-1);
    expect(a.indexPct).toBe(2);
    expect(a.vorsprungPct).toBe(-3);
  });

  it('nennt einen Rückstand als Rückstand', () => {
    // Der Punkt der ganzen Übung: Eine Vergleichslinie, die nur die guten
    // Phasen benennt, ist dasselbe wie keine.
    const a = benchmarkKurve([p('2026-08-01', 100_000, 100), p('2026-08-02', 98_000, 110)]);
    expect(a.vorsprungPct).toBe(-12);
    expect(benchmarkSatz(a)).toContain('HINTER');
    expect(benchmarkSatz(a)).toContain('Einfaches Halten wäre besser gewesen');
  });

  it('nennt einen Vorsprung als Vorsprung', () => {
    const a = benchmarkKurve([p('2026-08-01', 100_000, 100), p('2026-08-02', 112_000, 110)]);
    expect(a.vorsprungPct).toBe(2);
    expect(benchmarkSatz(a)).toContain('VOR');
  });
});

describe('die drei unsichtbaren Fehler', () => {
  it('rechnet NICHT über einen Depot-Schnitt hinweg', () => {
    /* Der Schnitt (`uebernahmeSchnitt.ts`) löscht die Equity-Dokumente vor
     * heute. Die Basis muss deshalb IMMER der erste noch vorhandene Punkt
     * sein — läge sie fest, vergliche die Linie nach jeder Depot-Übernahme
     * zwei verschiedene Zeiträume, und zwar unsichtbar. */
    const vorSchnitt = [p('2026-08-01', 100_000, 100), p('2026-08-02', 110_000, 101)];
    const nachSchnitt = vorSchnitt.slice(1); // genau das tut der Schnitt
    const a = benchmarkKurve(nachSchnitt);
    expect(a.kurve[0]!.bench).toBe(110_000); // neue Basis = neuer Stand
    expect(a.vorsprungPct).toBeNull(); // ein Punkt ist kein Zeitraum
  });

  it('überbrückt eine Datenlücke NICHT', () => {
    // Eine gerade Linie durch einen fehlenden Tag sähe aus wie eine Messung
    // und wäre eine Erfindung.
    const a = benchmarkKurve([
      p('2026-08-01', 100_000, 100),
      p('2026-08-02', 100_500, null),
      p('2026-08-03', 101_000, 102),
    ]);
    expect(a.kurve.map((x) => x.bench)).toEqual([100_000, null, 102_000]);
    expect(a.abdeckung).toBe(2);
  });

  it('gibt aus EINEM Punkt keinen Vorsprung aus', () => {
    const a = benchmarkKurve([p('2026-08-01', 100_000, 100)]);
    expect(a.vorsprungPct).toBeNull();
    expect(benchmarkSatz(a)).toContain('Noch kein Vergleich möglich');
  });
});

describe('kaputte Eingaben ergeben keinen Vergleich, keine Ausrede', () => {
  it('ohne jeden Indexkurs bleibt alles null — aber die Kurve steht', () => {
    const a = benchmarkKurve([p('2026-08-01', 100_000), p('2026-08-02', 101_000)]);
    expect(a.kurve).toHaveLength(2);
    expect(a.kurve.every((x) => x.bench === null)).toBe(true);
    expect(a.vorsprungPct).toBeNull();
    expect(a.abdeckung).toBe(0);
  });

  it('unsinnige Kurse (0, negativ, NaN) zählen als fehlend', () => {
    const a = benchmarkKurve([
      p('2026-08-01', 100_000, 0),
      p('2026-08-02', 100_000, -5),
      p('2026-08-03', 100_000, Number.NaN),
      p('2026-08-04', 100_000, 100),
      p('2026-08-05', 105_000, 105),
    ]);
    expect(a.abdeckung).toBe(2);
    // Basis ist der erste BRAUCHBARE Punkt, nicht der erste überhaupt.
    expect(a.kurve[3]!.bench).toBe(100_000);
    expect(a.vorsprungPct).toBe(0); // Depot +5 %, Index +5 %
  });

  it('eine Equity von 0 taugt nicht als Basis', () => {
    // Sonst käme eine Division durch null und damit eine Unendlich-Rendite.
    const a = benchmarkKurve([p('2026-08-01', 0, 100), p('2026-08-02', 50_000, 110)]);
    expect(a.kurve[0]!.bench).toBeNull();
    expect(a.vorsprungPct).toBeNull();
  });

  it('leere Serie bleibt leer', () => {
    const a = benchmarkKurve([]);
    expect(a.kurve).toEqual([]);
    expect(a.vorsprungPct).toBeNull();
  });
});
