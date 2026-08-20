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
import { regiePlan, type RegieSzene } from '../src/analyseVideo.js';
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
  it('volle Daten: Ergebnis zuerst, Einladung zuletzt, alle Aspekte dazwischen', () => {
    expect(ids(regiePlan(VOLL))).toEqual(['ergebnis', 'kurve', 'symbole', 'zeitmuster', 'cta']);
  });

  it('Aspekte ohne Daten fliegen raus — die Einladung bleibt', () => {
    expect(ids(regiePlan({ ...VOLL, verlauf: [100] }))).not.toContain('kurve');
    expect(ids(regiePlan({ ...VOLL, symbole: [] }))).not.toContain('symbole');
    expect(ids(regiePlan({ ...VOLL, stunden: [{ label: '15', value: 0 }] }))).not.toContain('zeitmuster');
    const leer = regiePlan({ ...VOLL, verlauf: [], symbole: [], stunden: [], wochentage: [] });
    expect(ids(leer)).toEqual(['ergebnis', 'cta']);
  });

  it('Gesamtlänge bleibt Social-tauglich (~6–17 s)', () => {
    const gesamt = regiePlan(VOLL).reduce((s, sz) => s + sz.dauerMs, 0);
    expect(gesamt).toBeGreaterThanOrEqual(6_000);
    expect(gesamt).toBeLessThanOrEqual(17_000);
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
