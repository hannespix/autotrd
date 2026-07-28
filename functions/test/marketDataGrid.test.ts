/**
 * Der Raster-Filter und die Spark-Zerlegung — die zwei Stellen, an denen
 * Yahoos „Jetzt"-Pseudo-Bar in die Verarbeitung eindringt.
 *
 * Warum das einen eigenen Test verdient: Der Fehler, den er verhindert, ist
 * vollständig LAUTLOS. Ein off-grid Zeitstempel wirft keine Exception, macht
 * keinen roten Lauf, keine Fehlerzeile — er verschiebt nur die Prognose-
 * Zeitachse um ein paar Sekunden neben das Kursraster. Danach ist jede
 * einzelne Intraday-Prognose für immer unbewertbar, und die Selbst-
 * optimierung lernt nie etwas. Genau so lag es am 28.07. live: 150 fällige
 * Prognosen, 0 bewertet.
 *
 * Die Zahlen unten sind echte Messwerte von diesem Tag, kein erfundenes
 * Beispiel.
 */

import { describe, expect, it } from 'vitest';
import {
  INTRADAY_GRID_SEC,
  isGridBar,
  parseSparkEntry,
  sparkCloses,
} from '../src/core/marketData.js';

describe('isGridBar', () => {
  it('erkennt die live gemessenen „Jetzt"-Pseudo-Bars als off-grid', () => {
    // Offene Märkte am 28.07., 07:44 UTC — Yahoo hängt den aktuellen Kurs als
    // Bar mit der aktuellen UHRZEIT an, nicht mit einem Bar-Start.
    expect(isGridBar(1_785_224_649), 'BTC-USD').toBe(false); // %300 = 249
    expect(isGridBar(1_785_224_600), 'EURUSD=X').toBe(false); // %300 = 200
    expect(isGridBar(1_785_224_045), 'GC=F').toBe(false); // %300 = 245
  });

  it('lässt echte Bar-Starts durch', () => {
    // Geschlossene Märkte am selben Abruf: JEDER Bar lag auf dem Raster.
    expect(isGridBar(1_785_182_400), 'AAPL/^GSPC Schluss-Bar').toBe(true);
    expect(isGridBar(1_785_224_400), 'BTC-USD 07:40').toBe(true);
  });

  it('das Raster ist 300 s — dieselbe Konstante wie die Prognose-Schrittweite', () => {
    // Die Invariante hinter dem ganzen Fix: Bar-Raster und Prognose-Raster
    // MÜSSEN dieselbe Zahl sein, sonst matcht nichts.
    expect(INTRADAY_GRID_SEC).toBe(300);
  });
});

describe('parseSparkEntry', () => {
  const eintrag = {
    symbol: 'BTC-USD',
    timestamp: [1_785_224_100, 1_785_224_400, 1_785_224_649],
    close: [63_474.26, 63_423.53, 63_420],
    previousClose: 63_706.66,
    chartPreviousClose: 63_706.66,
  };

  it('nimmt den off-grid Punkt als PREIS — dort ist er richtig', () => {
    // Als Kurs ist der „Jetzt"-Punkt genau das, was man will: der aktuellste
    // Stand. Nur als Bar-Zeitstempel wäre er falsch.
    const q = parseSparkEntry('BTC-USD', eintrag)!;
    expect(q.price).toBe(63_420);
  });

  it('meldet den letzten RASTER-Punkt separat', () => {
    expect(parseSparkEntry('BTC-USD', eintrag)!.lastGridT).toBe(1_785_224_400);
  });

  it('rechnet die Tagesänderung gegen previousClose', () => {
    const q = parseSparkEntry('BTC-USD', eintrag)!;
    expect(q.changePct).toBeCloseTo((63_420 / 63_706.66 - 1) * 100, 6);
  });

  it('überspringt nachlaufende Lücken statt sie als Kurs zu nehmen', () => {
    // Yahoo füllt Handelspausen mit null. Ein null am Ende darf nicht als
    // „kein Kurs" durchgehen, solange davor ein gültiger steht.
    const q = parseSparkEntry('X', { ...eintrag, close: [63_474.26, 63_423.53, null] })!;
    expect(q.price).toBe(63_423.53);
  });

  it('liefert null statt eines 0-Kurses, wenn gar nichts Gültiges dabei ist', () => {
    // Ein 0-Kurs würde als „Symbol auf null gefallen" durchs Dashboard laufen.
    expect(parseSparkEntry('X', { ...eintrag, close: [null, null, null] })).toBeNull();
    expect(parseSparkEntry('X', undefined)).toBeNull();
  });

  it('ohne previousClose ist die Änderung 0, nicht Unendlich', () => {
    const q = parseSparkEntry('X', {
      timestamp: [1_785_224_400],
      close: [100],
    })!;
    expect(q.changePct).toBe(0);
  });

  it('ohne einen einzigen Rasterpunkt bleibt lastGridT 0', () => {
    const q = parseSparkEntry('X', { timestamp: [1_785_224_649], close: [100] })!;
    expect(q.lastGridT).toBe(0);
  });
});

describe('sparkCloses (Tages-Historie fürs Momentum-Ranking)', () => {
  it('wirft Lücken raus, statt sie als Kurs 0 zu zählen', () => {
    // Der scharfe Fall: Eine 0 im Kursverlauf ist kein fehlender Wert,
    // sondern ein Kurssturz auf null. Sie würde die 12-1-Rendite des
    // Symbols zerstören und es im Ranking auf den letzten Platz setzen —
    // ein Symbol also aussortieren, weil an einem Feiertag nicht gehandelt
    // wurde.
    expect(sparkCloses({ close: [100, null, 102, null, 104] })).toEqual([100, 102, 104]);
  });

  it('filtert auch echte Nullen und Negativwerte', () => {
    expect(sparkCloses({ close: [100, 0, -5, 102] })).toEqual([100, 102]);
  });

  it('leerer oder fehlender Eintrag ⇒ leere Reihe, kein Absturz', () => {
    expect(sparkCloses(undefined)).toEqual([]);
    expect(sparkCloses({})).toEqual([]);
    expect(sparkCloses({ close: [] })).toEqual([]);
  });

  it('behält die Reihenfolge — sie IST die Zeitachse', () => {
    // rankMomentum rechnet über Indizes (t−252 bis t−21). Würde hier
    // umsortiert, wäre die Rendite über einen falschen Zeitraum gerechnet,
    // ohne dass irgendetwas auffiele.
    const reihe = [10, 11, 9, 12, 15];
    expect(sparkCloses({ close: reihe })).toEqual(reihe);
  });
});
