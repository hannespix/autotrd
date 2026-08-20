/**
 * Wächter des Analyse-Videos (Owner 20.08.: „Videos, wo die animierten
 * Schaubilder sich verändern — Aspekte umgeschaltet").
 *
 * Die Regie ist pur und wird funktional geprüft; die Ehrlichkeits- und
 * Bundle-Regeln hängen an Quelltext-Pins (die Chart-Szenen brauchen einen
 * echten Browser — deren Frames prüft video-shot.mjs an der ECHTEN
 * Aufnahme über den `beobachter`-Haken).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatRendite, regiePlan, type RegieSzene } from '../src/analyseVideo.js';
import type { AnalyseChartDaten } from '../src/analyseCharts.js';

const VOLL: AnalyseChartDaten = {
  verlauf: [0, 220, 140, -80],
  histo: [{ from: -100, to: 100, n: 4 }],
  exits: [{ label: 'Signal (4)', value: 280 }],
  symbole: [
    { label: 'NVDA', value: 220 },
    { label: 'EWJ', value: -80 },
  ],
  wochentage: [{ label: 'Mo', value: 40 }],
  stunden: [{ label: '15', value: -12 }],
};

const ids = (plan: RegieSzene[]): string[] => plan.map((s) => s.id);

describe('regiePlan — die Szenenfolge', () => {
  it('volle Daten: der Hook (Kurve) zuerst, KEINE stehende Titelkarte, Einladung zuletzt', () => {
    // Owner-Kritik 20.08.: LinkedIn entscheidet in Sekunde 1 — die Kurve
    // zeichnet sich sofort, die Rendite zählt im Kopf hoch.
    expect(ids(regiePlan(VOLL))).toEqual(['kurve', 'symbole', 'zeitmuster', 'cta']);
  });

  it('ohne Kurve bleibt die Ergebnis-Karte der Einstieg', () => {
    const plan = ids(regiePlan({ ...VOLL, verlauf: [100] }));
    expect(plan[0]).toBe('ergebnis');
    expect(plan).not.toContain('kurve');
  });

  it('Aspekte ohne Daten fliegen raus — die Einladung bleibt', () => {
    expect(ids(regiePlan({ ...VOLL, symbole: [] }))).not.toContain('symbole');
    expect(ids(regiePlan({ ...VOLL, stunden: [{ label: '15', value: 0 }] }))).not.toContain('zeitmuster');
    const leer = regiePlan({ ...VOLL, verlauf: [], symbole: [], stunden: [], wochentage: [] });
    expect(ids(leer)).toEqual(['ergebnis', 'cta']);
  });

  it('Gesamtlänge bleibt Social-tauglich (~6–20 s), Abspann kurz', () => {
    const plan = regiePlan(VOLL);
    const gesamt = plan.reduce((s, sz) => s + sz.dauerMs, 0);
    expect(gesamt).toBeGreaterThanOrEqual(6_000);
    expect(gesamt).toBeLessThanOrEqual(20_000);
    // Abspann 4 s: vier Zeilen brauchen Lesezeit (Kritiker-Befund) — und
    // der Payoff (zeitmuster) bekommt mehr Ruhe als die simple Symbol-Szene.
    expect(plan[plan.length - 1]).toEqual({ id: 'cta', dauerMs: 4000 });
    const dauer = new Map(plan.map((s) => [s.id, s.dauerMs]));
    expect(dauer.get('zeitmuster')!).toBeGreaterThan(dauer.get('symbole')!);
  });

  it('jede Chart-Szene hat einen Halte-Moment (Dauer ≫ Eintritts-Animation)', () => {
    // „Zu hektisch" hieß: Szene endet, sobald die Animation fertig ist.
    // Eintritt 1,1 s + Blende 0,6 s ⇒ unter 4 s bliebe keine Lesezeit.
    for (const sz of regiePlan(VOLL)) {
      if (sz.id === 'cta' || sz.id === 'ergebnis') continue;
      expect(sz.dauerMs, sz.id).toBeGreaterThanOrEqual(4_000);
    }
  });
});

describe('formatRendite — deutsches Format mit Vorzeichen', () => {
  it('positiv, negativ (echtes Minus), null', () => {
    expect(formatRendite(5.49)).toBe('+5,49 %');
    expect(formatRendite(-0.4)).toBe('−0,40 %');
    expect(formatRendite(0)).toBe('+0,00 %');
  });
});

describe('Quelltext-Pins — Ehrlichkeit und Bundle', () => {
  const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const video = lese('../src/analyseVideo.ts');
  const dashboard = lese('../src/dashboard.ts');
  const share = lese('../src/shareVideo.ts');

  it('die Chart-Szenen nutzen DIESELBEN Optionen wie das Analyse-Fenster', () => {
    expect(video).toContain('baueOptionen(');
  });

  it('Video-Look skaliert die Schrift (Owner: „Skalen viel zu klein")', () => {
    expect(video).toMatch(/skala:\s*2\.6/);
    // Canvas-Renderer: `inherit` ist als ctx.font ungültig — ohne echte
    // Familie fallen ALLE Chart-Texte still auf 10px sans-serif zurück.
    expect(video).toMatch(/schrift:\s*'ui-sans-serif/);
  });

  it('Hook: Rendite zählt in der Kurven-Szene hoch — Prozent nur mit Zeitraum', () => {
    expect(video).toMatch(/szene\.id === 'kurve' && story\.vonTag && story\.bisTag/);
    expect(video).toContain('formatRendite(wert)');
  });

  it('feste Bühne: die Diagrammfläche blendet weich ein UND aus, Siegel bleibt außerhalb', () => {
    // Ein-Blende 600 ms und Aus-Blende 300 ms — der harte Schnitt war der
    // Hektik-Treiber (Owner-Nachkritik „zu schnell, zu hektisch").
    expect(video).toMatch(/szene === plan\[0\] \? 1 : weich\(tSz \/ 600\)/);
    expect(video).toMatch(/Math\.min\(ein, weich\(\(szene\.dauerMs - tSz\) \/ 300\)\)/);
    // Das Chart-Szenen-Siegel (letztes Vorkommen — das erste ist der
    // Abspann) wird NACH dem restore gemalt — nie unter der Blende.
    expect(video.indexOf('Math.min(ein, weich(')).toBeLessThan(video.lastIndexOf('maleSiegel(ctx, story.echtgeld)'));
  });

  it('ein Blickziel nach dem anderen: Zahl NACH der Kurve, fertig im Scroll-Fenster (~2 s)', () => {
    expect(video).toMatch(/tSz > 1100/);
    expect(video).toMatch(/weich\(\(tSz - 1100\) \/ 900\)/);
  });

  it('Kritiker-No-Go gebannt: feste y-Spanne über beide Zeitmuster-Aspekte', () => {
    // Ohne sie rescaled die Achse mitten im Morph und die Balken
    // durchstoßen die Null-Linie.
    expect(video).toMatch(/festeSpanne/);
    expect(video).toMatch(/mitFesterAchse\(optionen\.stunden\)/);
    expect(video).toMatch(/mitFesterAchse\(optionen\.wochentage\)/);
  });

  it('auch der Abspann trägt das Siegel — und Frame 0 ist kein leeres Poster', () => {
    expect(video).toMatch(/if \(szene\.id === 'cta'\) maleSiegel\(ctx, story\.echtgeld\)/);
    expect(video).toMatch(/macheBuehne\(erste\.id\)/);
  });

  it('das Siegel wird im Frame-Maler gezeichnet (jeder Frame, volle Deckkraft)', () => {
    expect(video).toContain('maleSiegel(ctx, story.echtgeld)');
  });

  it('offscreen mit Canvas-Renderer, Tooltip im Video aus', () => {
    expect(video).toContain('CanvasRenderer');
    expect(video).toContain("renderer: 'canvas'");
    expect(video).toContain('tooltip: { show: false }');
  });

  it('dashboard lädt das Video-Modul NUR dynamisch (ECharts nicht ins Hauptbundle)', () => {
    expect(dashboard).toMatch(/import\('\.\/analyseVideo\.js'\)/);
    expect(dashboard).not.toMatch(/^import .* from '\.\/analyseVideo/m);
  });

  it('Video und UI-Charts teilen die Datenquelle (analyseChartDaten)', () => {
    expect(dashboard).toMatch(/baueAnalyseVideo\(daten, analyseChartDaten\(/);
  });

  it('der Rekorder-Kern behält die MP4-zuerst-Kaskade', () => {
    expect(share).toContain("'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'");
    expect(share).toContain('export async function nimmClipAuf');
  });
});
