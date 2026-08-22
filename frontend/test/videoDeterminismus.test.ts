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

  it('Linien geben sich von links frei', () => {
    const halb = mitFortschritt(linie(), 0.5) as { series: { data: number[] }[] };
    expect(halb.series[0]!.data).toEqual([1, 2, 3, 4, 5]);
    const voll = mitFortschritt(linie(), 1) as { series: { data: number[] }[] };
    expect(voll.series[0]!.data).toHaveLength(10);
  });

  it('eine Linie hat NIE weniger als zwei Punkte', () => {
    /* Bei einem Punkt zeichnet ECharts für einen Moment gar nichts — ein
     * Loch im Video, das erst beim Ansehen auffällt. */
    const kaum = mitFortschritt(linie(), 0.001) as { series: { data: number[] }[] };
    expect(kaum.series[0]!.data.length).toBeGreaterThanOrEqual(2);
  });

  it('Balken wachsen aus der Null — mit Vorzeichen', () => {
    const halb = mitFortschritt(balken(), 0.5) as {
      series: { data: { value: number; itemStyle?: unknown }[] }[];
    };
    expect(halb.series[0]!.data[0]!.value).toBe(5);
    // Verlust-Balken schrumpfen zur Null hin, nicht auf die andere Seite.
    expect(halb.series[0]!.data[1]!.value).toBe(-2);
    // Der Stil bleibt erhalten — sonst blinkt die Farbe während des Wachsens.
    expect(halb.series[0]!.data[0]!.itemStyle).toEqual({ color: 'x' });
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
  it('Stunden schrumpfen, dann wachsen die Wochentage', () => {
    /* ECharts' Update-Animation liesse sich nicht ansteuern — sie hätte
     * dasselbe Uhr-Problem. Der Wechsel ist deshalb aus zwei
     * Fortschritten gebaut, nicht aus einem Übergang. */
    expect(quelle).toContain("const RAUS = 0.55;");
    expect(quelle).toContain("const REIN = 0.66;");
    expect(quelle).toContain('f = 1 - (p - RAUS) / (REIN - RAUS);');
  });

  it('der Titel folgt dem Bild, nicht einem vorauseilenden Schalter', () => {
    expect(quelle).toContain('buehne.gewechselt = p >= REIN;');
  });

  it('stillstehende Szenen werden nicht jeden Frame neu gerendert', () => {
    /* „Läuft langsam" war der zweite Teil des Befunds: Ein voller
     * ECharts-Rendervorgang je Frame über die gesamte Haltezeit ist reine
     * Rechenzeit ohne Bildunterschied. */
    expect(quelle).toContain('if (Math.abs(f - buehne.f) > 0.002 || (f === 1 && buehne.f !== 1)) {');
  });
});
