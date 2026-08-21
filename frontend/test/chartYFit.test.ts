/**
 * Wächter der Y-Skalierung beim Symbolwechsel (Owner 21.08., Screenshots:
 * DOGE-Kerzen unsichtbar in einer ±15er-Skala, BTC-Kerzen riesig in einer
 * eingefrorenen 1.000er-Spanne).
 *
 * Zwei Wurzeln, zwei Pins:
 * 1. chart.ts: Der Fit-Zweig von setBars muss die Preisskala IMMER frisch
 *    rechnen (autoScale true, Frei-Modus kehrt zu Auto zurück) — vorher
 *    respektierte er den manuellen Zustand und das neue Symbol erbte die
 *    alte Spanne. Der fit-lose Pfad bleibt unangetastet (Zoom-Erhalt beim
 *    Daten-Update ist zugesichertes Verhalten, i18n chart.hinweis2).
 * 2. dashboard.ts: Das Fit-Token darf nicht auf den Bars des VORGÄNGER-
 *    Symbols verbrannt werden — Bars werden beim Wechsel geleert und das
 *    Token erst verbraucht, wenn Kerzen da sind.
 *
 * Der Zeichen-Beweis (wechsel:frei / wechsel:fix, 100er→1000er-Niveau)
 * läuft im Browser-Prüfstand `npm run chart:shot`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const chart = lese('../src/chart.ts');
const dashboard = lese('../src/dashboard.ts');
// lastIndexOf: die ersten Treffer sind die Interface-Deklarationen, die
// Implementierungen im Handle-Objekt kommen zuletzt.
const setBars = chart.slice(chart.lastIndexOf('setBars('), chart.lastIndexOf('setOverlays('));

describe('chart.ts — Fit rechnet die Y-Achse immer frisch', () => {
  it('der Fit-Zweig erzwingt autoScale und holt den Frei-Modus zurück', () => {
    const fitZweig = setBars.slice(setBars.indexOf('if (opts?.fit)'));
    expect(fitZweig).toContain('fixReset();');
    expect(fitZweig).toContain("if (yModus === 'frei')");
    expect(fitZweig).toContain("yModeCb?.('auto');");
    expect(fitZweig).toContain('autoScaleOn = true;');
    expect(fitZweig).toContain('autoScale: true');
  });

  it('der fit-lose Pfad fasst die Preisskala NICHT an — Zoom-Erhalt bleibt', () => {
    const vorFit = setBars.slice(0, setBars.indexOf('if (opts?.fit)'));
    // Echte Aufrufe, nicht Wörter in Kommentaren.
    expect(vorFit).not.toContain('applyOptions({ autoScale');
    expect(vorFit).not.toContain('.fitContent()');
  });
});

describe('dashboard.ts — Fit-Token überlebt bis zu den Bars des neuen Symbols', () => {
  it('Symbolwechsel leert die Bars aller drei Fenster', () => {
    // Haupt-Chart (wireChartCtx), Vergleich (wireChart2Ctx), Raster (mount).
    expect(dashboard).toMatch(/st\.bars = \[\];\n {2}st\.histBars = \[\];/);
    expect(dashboard).toMatch(/p\.bars = \[\];\n {2}p\.intradayBars = \[\];\n {2}st\.chart2Bars = \[\];/);
    expect(dashboard).toMatch(/p\.bars = \[\];\n {2}p\.intradayBars = \[\];\n {2}\/\/ Lazy-Historie/);
  });

  it('renderChart verbraucht das Token nur mit Daten (Gate wie im Panel-Renderer)', () => {
    expect(dashboard).toContain('const fit = st.chartFitPending && hatDaten;');
    expect(dashboard).toMatch(/if \(fit\) st\.chartFitPending = false;/);
  });
});
