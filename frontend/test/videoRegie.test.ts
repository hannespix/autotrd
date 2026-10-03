/**
 * Wächter der Regie im Analyse-Video (Owner 22.08.: „die Animationen sind
 * teilweise sehr komisch und nicht sauber. gehe wieder als Regisseur
 * rein!").
 *
 * Nachdem die Bewegung deterministisch war, war sie noch nicht GUT. Vier
 * Befunde kamen aus dem angesehenen Einzelbild, keiner aus einem Test:
 *
 *  1. Die Wertachse wanderte mit, weil ECharts sie aus den sichtbaren
 *     Daten rechnet — fertige Balken wurden beim Wachsen der übrigen
 *     wieder kürzer.
 *  2. Die feste Achse hatte krumme Enden, und ECharts setzte dort ein
 *     ZUSÄTZLICHES Label: „−253−200" stand ineinander.
 *  3. Zu grob gerundet stand die Achse auf ±200 für Werte bis 120 — das
 *     halbe Diagramm blieb leer.
 *  4. Der Aspekt-Wechsel schrumpfte die Balken auf Null. Weil die
 *     Staffelung auch rückwärts wirkt, stand ein halb aufgegessenes
 *     Diagramm im Bild: hinten schon weg, vorne noch halbhoch.
 *
 * Alle vier sind hier festgenagelt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nettGrenzen, wechselAlpha } from '../src/analyseVideo.js';

const quelle = readFileSync(
  join(import.meta.dirname, '..', 'src', 'analyseVideo.ts'),
  'utf8',
);

describe('Die Wertachse steht still und liest sich sauber', () => {
  it('die Enden liegen auf glatten Schritten', () => {
    /* Krumme Enden erzeugen ein Extra-Label direkt neben dem regulären
     * Tick — genau die Kollision „−253−200". */
    const g = nettGrenzen([320, 180, 60, -90, -210]);
    const schritt = (g.max - g.min) / 4;
    expect(Number.isInteger(g.min / schritt) || g.min === 0).toBe(true);
    expect(Number.isInteger(g.max / schritt) || g.max === 0).toBe(true);
  });

  it('die Null liegt immer drin — Balken wachsen aus ihr heraus', () => {
    for (const werte of [[10, 20, 30], [-5, -9], [3, -4]]) {
      const g = nettGrenzen(werte);
      expect(g.min, String(werte)).toBeLessThanOrEqual(0);
      expect(g.max, String(werte)).toBeGreaterThanOrEqual(0);
    }
  });

  it('sie wird nicht zu weit — die Daten füllen die Fläche', () => {
    /* Bild-Befund: Bei Werten bis 120 stand die Achse auf ±200, und das
     * Diagramm sah leer aus. Eine feste Achse soll die Skala ruhig halten,
     * nicht die Daten kleinrechnen. */
    for (const werte of [[120, -120], [90, -90], [320, -210], [7, -3]]) {
      const g = nettGrenzen(werte);
      const genutzt = Math.max(...werte.map(Math.abs)) / Math.max(g.max, -g.min);
      /* 0,7 und nicht 0,55: Die Sabotage-Probe (gröbere Rundung) landete
       * bei 0,60 und wäre unter der lascheren Schwelle durchgerutscht —
       * ein Wächter, der den echten Fehler durchlässt, bewacht nichts. */
      expect(genutzt, String(werte)).toBeGreaterThan(0.7);
    }
  });

  it('flache Daten ergeben trotzdem eine brauchbare Achse', () => {
    // Sonst teilte die Skalenrechnung durch Null.
    expect(nettGrenzen([0, 0])).toEqual({ min: -1, max: 1 });
    expect(nettGrenzen([])).toEqual({ min: -1, max: 1 });
  });

  it('beide Szenen-Arten klemmen ihre EIGENE Wertachse', () => {
    // Liegende Balken (Symbole) haben die Werte auf x, stehende auf y.
    expect(quelle).toContain('const festeSpanne = nettGrenzen(zeitWerte);');
    expect(quelle).toContain('...nettGrenzen(symbolWerte),');
  });
});

describe('Der Aspekt-Wechsel blendet, er schrumpft nicht', () => {
  it('vor dem Wechsel volle Deckkraft', () => {
    expect(wechselAlpha(0)).toBe(1);
    expect(wechselAlpha(0.4)).toBe(1);
  });

  it('sie fällt auf Null und kommt zurück', () => {
    expect(wechselAlpha(0.55)).toBeCloseTo(1, 5);
    expect(wechselAlpha(0.66)).toBeCloseTo(0, 5);
    expect(wechselAlpha(0.72)).toBe(1);
    // Dazwischen monoton fallend — kein Flackern.
    expect(wechselAlpha(0.60)).toBeLessThan(wechselAlpha(0.57));
  });

  it('nie negativ und nie über eins', () => {
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const a = wechselAlpha(p);
      expect(a, `p=${p.toFixed(2)}`).toBeGreaterThanOrEqual(0);
      expect(a, `p=${p.toFixed(2)}`).toBeLessThanOrEqual(1);
    }
  });

  it('die Balken bleiben beim Abgang VOLLSTÄNDIG', () => {
    /* Der Kern des Befunds: Die Staffelung wirkt auch rückwärts. Fährt man
     * die Werte auf Null, sind die hinteren Balken weg, während die
     * vorderen noch halbhoch stehen — das liest sich als kaputte Daten,
     * nicht als Übergang. Ein Abgang hat keine Richtung. */
    expect(quelle).toContain('f = 1; // vollständig — das Ausblenden macht die Deckkraft');
    expect(quelle).not.toContain('f = 1 - (p - ZM_RAUS) / (ZM_REIN - ZM_RAUS);');
  });

  it('und die Deckkraft wird auch wirklich angewendet', () => {
    expect(quelle).toContain("const wechsel = szene.id === 'zeitmuster' ? wechselAlpha(p) : 1;");
    expect(quelle).toContain('* wechsel;');
  });
});
