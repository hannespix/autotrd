/**
 * Die Haltedauer-Kurve JE ANLAGEKLASSE — und warum sie zur globalen passen muss.
 *
 * ── Die Frage dahinter ────────────────────────────────────────────────────
 *
 * Der erste Katalog-Lauf (10.08., 132 Symbole, 37.342 Signale) zeigte zwei
 * Dinge, die zusammen nicht auflösbar waren:
 *
 *   global   Kaufsignale +0,65 % (1 Tag) bis +1,19 % (10 Tage) netto
 *            Verkaufssignale +0,05 % (1 Tag) bis −0,78 % (10 Tage)
 *   crypto   −1,06 % netto, −0,56 % ROH — als einzige Klasse negativ
 *
 * Aus der zweiten Zeile folgt NICHT „Krypto abschalten": `klassen` mischt
 * Kauf- und Verkaufssignale. Wenn sich global das Muster wiederholt (Kauf
 * trägt, Verkauf verliert), wäre die richtige Konsequenz, in dieser Klasse
 * nur die verlierende RICHTUNG auszusetzen — und das ist ein erheblicher
 * Unterschied, weil Krypto als einzige Klasse nachts handelt.
 *
 * ── Was dieser Test sichert ───────────────────────────────────────────────
 *
 * Die neue Kreuzung wird aus denselben Symbol-Beiträgen aufaddiert wie die
 * globale Kurve, nur in einen anderen Topf. Geht dabei etwas verloren oder
 * doppelt, fällt das nirgends auf: Beide Zahlen sehen für sich plausibel aus.
 * Deshalb steht hier die Invariante — Summe über alle Klassen = global.
 */
import { describe, expect, it } from 'vitest';
import {
  summiereHorizonte,
  verteileBeitrag,
  type HorizontBestand,
} from '../src/scheduled/tagRueckblick.js';
import { summiere } from '../src/scheduled/tagRueckblick.js';
import type { SchattenKlasse } from '../../shared/src/index.js';

const k = (n: number, summePct: number, treffer: number, roh = summePct): SchattenKlasse => ({
  n,
  summePct,
  treffer,
  summeRohPct: roh,
  nRoh: n,
});

/** Ein Symbol-Ergebnis, wie `werteTagRueckblick` es liefert. */
const ergebnis = (
  proHorizont: Record<number, { buy: SchattenKlasse; sell: SchattenKlasse }>,
): Record<number, { klasse: SchattenKlasse; nachRichtung: { buy: SchattenKlasse; sell: SchattenKlasse } }> => {
  const out: Record<number, { klasse: SchattenKlasse; nachRichtung: { buy: SchattenKlasse; sell: SchattenKlasse } }> = {};
  for (const [tage, r] of Object.entries(proHorizont)) {
    out[Number(tage)] = { klasse: summiere(r.buy, r.sell)!, nachRichtung: r };
  }
  return out;
};

describe('summiereHorizonte', () => {
  it('legt einen ersten Beitrag an', () => {
    const out = summiereHorizonte({}, ergebnis({ 1: { buy: k(10, 5, 6), sell: k(4, -1, 2) } }));
    expect(out['1']?.buy).toMatchObject({ n: 10, summePct: 5 });
    expect(out['1']?.sell).toMatchObject({ n: 4, summePct: -1 });
    expect(out['1']?.klasse).toMatchObject({ n: 14, summePct: 4 });
  });

  it('addiert einen zweiten Beitrag auf denselben Horizont', () => {
    const a = summiereHorizonte({}, ergebnis({ 1: { buy: k(10, 5, 6), sell: k(4, -1, 2) } }));
    const b = summiereHorizonte(a, ergebnis({ 1: { buy: k(6, 3, 4), sell: k(2, -2, 1) } }));
    expect(b['1']?.buy).toMatchObject({ n: 16, summePct: 8 });
    expect(b['1']?.sell).toMatchObject({ n: 6, summePct: -3 });
  });

  it('hält mehrere Horizonte auseinander', () => {
    const out = summiereHorizonte(
      {},
      ergebnis({
        1: { buy: k(10, 5, 6), sell: k(4, -1, 2) },
        5: { buy: k(10, 12, 7), sell: k(4, -3, 2) },
      }),
    );
    expect(out['1']?.buy?.summePct).toBe(5);
    expect(out['5']?.buy?.summePct).toBe(12);
  });

  it('lässt Horizonte unangetastet, die dieses Symbol nicht liefert', () => {
    // Ein Symbol mit kurzer Historie kann den 10-Tage-Horizont nicht füllen.
    // Sein Beitrag darf die schon gesammelten 10-Tage-Zahlen nicht löschen.
    const a = summiereHorizonte({}, ergebnis({ 1: { buy: k(10, 5, 6), sell: k(4, -1, 2) }, 10: { buy: k(8, 9, 5), sell: k(3, -2, 1) } }));
    const b = summiereHorizonte(a, ergebnis({ 1: { buy: k(1, 1, 1), sell: k(1, 0, 0) } }));
    expect(b['10']?.buy).toMatchObject({ n: 8, summePct: 9 });
    expect(b['1']?.buy).toMatchObject({ n: 11, summePct: 6 });
  });

  it('ist reihenfolgeunabhängig — Symbole kommen rotierend dran', () => {
    const x = ergebnis({ 1: { buy: k(10, 5, 6), sell: k(4, -1, 2) } });
    const y = ergebnis({ 1: { buy: k(7, 2, 3), sell: k(9, -4, 4) } });
    expect(summiereHorizonte(summiereHorizonte({}, x), y)).toEqual(
      summiereHorizonte(summiereHorizonte({}, y), x),
    );
  });
});

describe('Invariante: Summe über die Klassen ist der globale Bestand', () => {
  /**
   * Der eigentliche Regressionstest. Er baut nach, was der Lauf tut: Jedes
   * Symbol geht in den globalen Topf UND in den seiner Klasse — durch
   * dieselbe Funktion. Stimmt die Summe nicht, ist eine der beiden Zahlen
   * falsch, und man wüsste nicht welche.
   */
  const symbole: Array<{ klasse: string; e: ReturnType<typeof ergebnis> }> = [
    { klasse: 'stocks_us', e: ergebnis({ 1: { buy: k(120, 60, 70), sell: k(200, 10, 105) }, 5: { buy: k(118, 140, 72), sell: k(198, -55, 99) } }) },
    { klasse: 'stocks_us', e: ergebnis({ 1: { buy: k(90, 40, 50), sell: k(150, -5, 76) }, 5: { buy: k(89, 95, 53), sell: k(149, -40, 74) } }) },
    { klasse: 'crypto', e: ergebnis({ 1: { buy: k(45, -12, 21), sell: k(70, -30, 33) }, 5: { buy: k(44, -20, 20), sell: k(69, -60, 30) } }) },
    { klasse: 'etf_sectors', e: ergebnis({ 1: { buy: k(30, 22, 18), sell: k(48, 3, 25) }, 5: { buy: k(30, 38, 19), sell: k(47, -12, 23) } }) },
  ];

  /* Durch `verteileBeitrag` — NICHT nachgebaut.
   *
   * Der erste Entwurf dieses Tests baute die Verteilung hier selbst nach
   * (`jeKlasse[k] = summiereHorizonte(jeKlasse[k] ?? {}, e)`). Die
   * Sabotage-Probe führte vor, warum das wertlos ist: Ein im PRODUKTIONSCODE
   * vergessener Vorbestand ließ jedes Symbol den Topf seiner Klasse
   * überschreiben — und alle 13 Tests blieben grün, weil sie die eigene,
   * korrekte Nachbildung prüften. */
  let bestand: HorizontBestand = { global: {}, jeKlasse: {} };
  for (const s of symbole) bestand = verteileBeitrag(bestand, s.klasse, s.e);
  const global = bestand.global;
  const jeKlasse = bestand.jeKlasse;

  for (const tage of ['1', '5']) {
    for (const richtung of ['buy', 'sell', 'klasse'] as const) {
      it(`${tage} Tage, ${richtung}: n und Summe stimmen überein`, () => {
        const g = global[tage]?.[richtung];
        const summeN = Object.values(jeKlasse).reduce((a, kh) => a + (kh[tage]?.[richtung]?.n ?? 0), 0);
        const summePct = Object.values(jeKlasse).reduce(
          (a, kh) => a + (kh[tage]?.[richtung]?.summePct ?? 0),
          0,
        );
        expect(summeN).toBe(g?.n);
        expect(summePct).toBeCloseTo(g?.summePct ?? 0, 6);
      });
    }
  }

  it('und jede Klasse trägt nur ihre eigenen Symbole', () => {
    // stocks_us hat zwei Symbole (120 + 90 Kaufsignale), crypto eines.
    expect(jeKlasse['stocks_us']?.['1']?.buy?.n).toBe(210);
    expect(jeKlasse['crypto']?.['1']?.buy?.n).toBe(45);
    expect(Object.keys(jeKlasse).sort()).toEqual(['crypto', 'etf_sectors', 'stocks_us']);
  });

  it('die Kreuzung beantwortet die Krypto-Frage, die `klassen` offenlässt', () => {
    // Genau der Fall aus dem Live-Befund: Die Klasse ist in SUMME negativ,
    // aber die Ursache liegt in einer Richtung. Ohne die Aufteilung wäre die
    // Antwort „Klasse raus", mit ihr „diese Richtung raus".
    const c = jeKlasse['crypto']?.['5'];
    expect(c?.klasse?.summePct).toBeLessThan(0);
    expect(c?.sell?.summePct).toBeLessThan(c?.buy?.summePct ?? 0);
  });
});
