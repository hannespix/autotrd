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

  it('Gesamtlänge bleibt Social-tauglich (~6–17 s), Abspann kurz', () => {
    const plan = regiePlan(VOLL);
    const gesamt = plan.reduce((s, sz) => s + sz.dauerMs, 0);
    expect(gesamt).toBeGreaterThanOrEqual(6_000);
    expect(gesamt).toBeLessThanOrEqual(17_000);
    expect(plan[plan.length - 1]).toEqual({ id: 'cta', dauerMs: 2400 });
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

  it('feste Bühne: die Diagrammfläche blendet weich ein (globalAlpha), Siegel bleibt außerhalb', () => {
    expect(video).toMatch(/globalAlpha = weich\(/);
    // Das Siegel wird NACH dem restore gemalt — nie unter der Blende.
    expect(video.indexOf('globalAlpha = weich(')).toBeLessThan(video.indexOf('maleSiegel(ctx, story.echtgeld)'));
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
