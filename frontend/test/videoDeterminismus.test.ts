/**
 * Wächter der Bild-für-Bild-Determiniertheit im Analyse-Video
 * (Owner 22.08.: „das andere Video … läuft langsam und ruckelig").
 *
 * ── Die Wurzel ──────────────────────────────────────────────────────────
 *
 * ECharts treibt seine Animation mit der WANDUHR. Die Offline-Aufnahme malt
 * aber nicht in Echtzeit: Sie rendert Frame für Frame, so schnell der
 * Encoder mitkommt. Zwischen zwei ausgegebenen Frames sprang die
 * Chart-Animation deshalb mal weit, mal kaum — je nachdem, wie lange das
 * Encodieren des letzten Frames gedauert hatte. Genau das sah man als
 * Ruckeln, und es wurde schlimmer, je langsamer das Gerät war.
 *
 * Das Story-Video malte immer schon alles aus `tMs` und war deshalb
 * flüssig — dieselbe Aufnahme, derselbe Encoder, anderes Ergebnis. Das war
 * der Hinweis: Es lag nicht am Rekorder.
 *
 * ── Was hier festgenagelt wird ──────────────────────────────────────────
 *
 * Die Bewegung muss AUSSCHLIESSLICH an `f` hängen — dann ist jeder Frame
 * reproduzierbar, bei 30 fps wie bei 60, auf jedem Gerät.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mitFortschritt } from '../src/analyseVideo.js';

const quelle = readFileSync(
  join(import.meta.dirname, '..', 'src', 'analyseVideo.ts'),
  'utf8',
);

const linie = (): object => ({
  series: [{ type: 'line', data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
});
const balken = (): object => ({
  series: [{ type: 'bar', data: [{ value: 10, itemStyle: { color: 'x' } }, { value: -4 }] }],
});

describe('Die Chart-Bewegung hängt allein am Fortschritt', () => {
  it('ECharts animiert im Video NICHT selbst', () => {
    /* Der eine Schalter, an dem alles hängt. Steht er wieder auf `true`,
     * ist das Ruckeln zurück — und zwar nur auf langsamen Geräten, also
     * genau dort, wo es niemand testet. */
    expect(quelle).toContain('animation: false,');
    expect(quelle).not.toContain('animationDuration: 1100');
    expect(quelle).not.toContain('animationDurationUpdate: 900');
  });

  it('derselbe Fortschritt ergibt dasselbe Bild — immer', () => {
    // Reproduzierbarkeit ist die Eigenschaft, die vorher fehlte.
    expect(mitFortschritt(linie(), 0.37)).toEqual(mitFortschritt(linie(), 0.37));
    expect(mitFortschritt(balken(), 0.37)).toEqual(mitFortschritt(balken(), 0.37));
  });

  it('Linien werden NICHT über die Daten aufgedeckt', () => {
    /* Regie-Befund 22.08.: Punktweises Freigeben liess die Spitze in
     * Sprüngen wandern (bei 40 Punkten in 1,1 s alle ~28 ms um ~25 px),
     * und ECharts rechnete die Wertachse aus den SICHTBAREN Daten neu — die
     * ganze Kurve atmete dabei. Die Linie bleibt deshalb vollständig; das
     * Aufdecken macht ein Clip beim Zeichnen. */
    for (const f of [0, 0.001, 0.5, 0.99]) {
      const o = mitFortschritt(linie(), f) as { series: { data: number[] }[] };
      expect(o.series[0]!.data, `f=${f}`).toHaveLength(10);
    }
  });

  it('…sondern von einem wachsenden Rechteck', () => {
    // Stufenlos, und die Achsenbeschriftung links bleibt stehen.
    expect(quelle).toContain('const kurvenF = szene.id === \'kurve\' ? weich((p * szene.dauerMs) / 1100) : 1;');
    expect(quelle).toContain('ctx.clip();');
    expect(quelle).toContain('const links = CHART_X + plotLinks(buehne.chart);');
  });

  it('die Kurven-Szene wird nur EINMAL gesetzt', () => {
    /* Sie steht sofort fertig da. Ein Neu-Setzen je Frame wäre reine
     * Rechenzeit — und genau das Verfahren, das die Achse atmen liess. */
    expect(quelle).toContain("if (szene.id === 'kurve') {");
    expect(quelle).toContain('if (buehne.f !== 1) {');
  });

  it('Balken wachsen weich aus der Null — mit Vorzeichen', () => {
    const bei = (f: number): { value: number; itemStyle?: unknown }[] =>
      (mitFortschritt(balken(), f) as { series: { data: { value: number; itemStyle?: unknown }[] }[] })
        .series[0]!.data;
    // Anfang und Ende stehen fest.
    expect(bei(0)[0]!.value).toBe(0);
    expect(bei(1)[0]!.value).toBe(10);
    expect(bei(1)[1]!.value).toBe(-4);
    // Dazwischen echt dazwischen — und monoton.
    const mitte = bei(0.5)[0]!.value;
    expect(mitte).toBeGreaterThan(0);
    expect(mitte).toBeLessThan(10);
    expect(bei(0.7)[0]!.value).toBeGreaterThan(mitte);
    // Verlust-Balken schrumpfen zur Null hin, nicht auf die andere Seite.
    expect(bei(0.5)[1]!.value).toBeLessThanOrEqual(0);
    expect(bei(0.5)[1]!.value).toBeGreaterThan(-4);
    // Der Stil bleibt erhalten — sonst blinkt die Farbe während des Wachsens.
    expect(bei(0.5)[0]!.itemStyle).toEqual({ color: 'x' });
  });

  it('Balken starten gestaffelt, nicht im Gleichschritt', () => {
    /* Alle gleichzeitig aus der Null wirkt wie ein Diagramm, an dem jemand
     * am Regler dreht. Der Versatz gibt der Reihe eine Richtung. */
    const viele = {
      series: [{ type: 'bar', data: Array.from({ length: 8 }, () => ({ value: 10 })) }],
    };
    const fruh = (mitFortschritt(viele, 0.25) as {
      series: { data: { value: number }[] }[];
    }).series[0]!.data.map((d) => d.value);
    expect(fruh[0]).toBeGreaterThan(fruh[7]!);
    // …aber am Ende sind alle gleich weit, sonst bliebe die Reihe schief.
    const spaet = (mitFortschritt(viele, 1) as {
      series: { data: { value: number }[] }[];
    }).series[0]!.data.map((d) => d.value);
    expect(new Set(spaet).size).toBe(1);
  });

  it('die Wertachse steht still, während die Balken wachsen', () => {
    /* Sonst rechnet ECharts die Skala aus den sichtbaren Werten neu: Die
     * fertigen Balken würden beim Wachsen der übrigen wieder kürzer.
     * Die Symbol-Szene hat LIEGENDE Balken — dort ist es die x-Achse. */
    expect(quelle).toContain('const symboleFest: object = {');
    expect(quelle).toContain('xAxis: {');
    expect(quelle).toContain('const symbolWerte = chart.symbole.map((b) => b.value);');
  });

  it('bei f = 1 kommt die Option unverändert zurück', () => {
    // Kein Kopieren ohne Grund: Der Endzustand ist der Normalfall.
    const o = linie();
    expect(mitFortschritt(o, 1)).toBe(o);
  });

  it('fremde Serientypen bleiben unangetastet', () => {
    const o = { series: [{ type: 'pie', data: [1, 2] }] };
    expect(mitFortschritt(o, 0.5)).toEqual(o);
  });

  it('kaputte Optionen werfen nicht', () => {
    /* Ein Wurf mitten in der Frame-Schleife würde die ganze Aufnahme
     * abbrechen — nach einer Minute Rechenzeit und ohne Datei. */
    expect(() => mitFortschritt({}, 0.5)).not.toThrow();
    expect(() => mitFortschritt({ series: 'kaputt' } as unknown as object, 0.5)).not.toThrow();
  });
});

describe('Der Aspekt-Wechsel bleibt ein Wechsel', () => {
  it('er ist aus zwei Fortschritten gebaut, nicht aus einem Übergang', () => {
    /* ECharts' Update-Animation liesse sich nicht ansteuern — sie hätte
     * dasselbe Uhr-Problem. WIE der Wechsel aussieht (blenden statt
     * schrumpfen), prüft frontend/test/videoRegie.test.ts. */
    expect(quelle).toContain('const ZM_RAUS = 0.55;');
    expect(quelle).toContain('const ZM_REIN = 0.66;');
  });

  it('der Titel folgt dem Bild, nicht einem vorauseilenden Schalter', () => {
    expect(quelle).toContain('buehne.gewechselt = p >= ZM_REIN;');
  });

  it('stillstehende Szenen werden nicht jeden Frame neu gerendert', () => {
    /* „Läuft langsam" war der zweite Teil des Befunds: Ein voller
     * ECharts-Rendervorgang je Frame über die gesamte Haltezeit ist reine
     * Rechenzeit ohne Bildunterschied. */
    expect(quelle).toContain('if (Math.abs(f - buehne.f) > 0.002 || (f === 1 && buehne.f !== 1)) {');
  });
});
