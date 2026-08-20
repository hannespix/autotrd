/**
 * Wächter des animierten Analyse-Dashboards (Owner 20.08., pixpower-Machart).
 *
 * Zwei Sorten Proben:
 *  1. Die puren Options-Builder — Farb- und Ehrlichkeitsregeln der alten
 *     SVG-Charts müssen den Umzug überleben (Vorzeichen-Farben, Beträge im
 *     Kuchen, echter Wert im Tooltip).
 *  2. Quelltext-Pins gegen die Fallen, die man beim Refactoring am
 *     leichtesten wieder einreißt: voller echarts-Import (Bundle!),
 *     statischer Import in dashboard.ts (Chunk!), reduced-motion-Guard,
 *     Gerüst-Neuaufbau je Render (Morph!).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baueOptionen, mitAlpha, type AnalyseChartDaten, type ChartLook } from '../src/analyseCharts.js';

const LOOK: ChartLook = {
  text: '#9fadc4',
  leise: '#7e8ca6',
  hair: 'rgba(255,255,255,.06)',
  bd: 'rgba(255,255,255,.18)',
  gn: '#26cf9d',
  rd: '#f2586b',
  kat: ['#25d0ee', '#8b7cff', '#26cf9d', '#f2586b', '#5ce4fb', '#40e0b4', '#ff8290', '#9fadc4'],
  dunkel: true,
  animation: true,
};

const DATEN: AnalyseChartDaten = {
  verlauf: [10_000, 10_260, 10_120, 9_800],
  histo: [
    { from: -300, to: -100, n: 2 },
    { from: -100, to: 100, n: 1 },
    { from: 100, to: 300, n: 3 },
  ],
  exits: [
    { label: 'Signal (3)', value: 220 },
    { label: 'Stop-Loss (2)', value: -180 },
    { label: 'Nie (0)', value: 0 },
  ],
  symbole: [
    { label: 'NVDA', value: 220 },
    { label: 'EWJ', value: -80 },
  ],
  wochentage: [{ label: 'Mo', value: 40 }],
  stunden: [{ label: '15', value: -12 }],
};

type Serie = { data: Array<{ value: number; itemStyle: { color: string } }> };
const serie = (o: unknown): Serie => (o as { series: Serie[] }).series[0]!;

describe('baueOptionen — die alten Regeln überleben den Umzug', () => {
  const optionen = baueOptionen(DATEN, LOOK);

  it('Kontoverlauf: Farbe trägt das Gesamtergebnis (Ende unter Start ⇒ rot)', () => {
    const s = (optionen.verlauf as { series: Array<{ lineStyle: { color: string } }> }).series[0]!;
    expect(s.lineStyle.color).toBe(LOOK.rd);
    const hoch = baueOptionen({ ...DATEN, verlauf: [100, 130] }, LOOK);
    const s2 = (hoch.verlauf as { series: Array<{ lineStyle: { color: string } }> }).series[0]!;
    expect(s2.lineStyle.color).toBe(LOOK.gn);
  });

  it('Verteilung: Höhe = Häufigkeit, FARBE = Vorzeichen der Fach-Mitte', () => {
    const d = serie(optionen.verteilung).data;
    expect(d.map((x) => x.value)).toEqual([2, 1, 3]);
    expect(d[0]!.itemStyle.color).toBe(LOOK.rd);
    expect(d[1]!.itemStyle.color).toBe(LOOK.leise); // Mitte exakt 0 ⇒ neutral
    expect(d[2]!.itemStyle.color).toBe(LOOK.gn);
  });

  it('Ausstiegsgründe: Kuchen aus BETRÄGEN, Null-Scheiben raus, Kategorie-Farben', () => {
    const d = serie(optionen.exits).data as unknown as Array<{ name: string; value: number; itemStyle: { color: string } }>;
    expect(d.map((x) => x.name)).toEqual(['Signal (3)', 'Stop-Loss (2)']);
    expect(d.map((x) => x.value)).toEqual([220, 180]); // |−180|, nie negativ
    expect(d[0]!.itemStyle.color).toBe(LOOK.kat[0]);
    expect(d[1]!.itemStyle.color).toBe(LOOK.kat[1]);
  });

  it('Ausstiegsgründe: der Tooltip nennt den ECHTEN vorzeichenbehafteten Wert', () => {
    const f = (optionen.exits as { tooltip: { formatter: (p: { name: string; percent: number }) => string } })
      .tooltip.formatter;
    expect(f({ name: 'Stop-Loss (2)', percent: 45 })).toContain('-180');
  });

  it('Je Symbol / Wochentag / Stunde: Vorzeichen-Farben wie überall', () => {
    expect(serie(optionen.symbole).data[1]!.itemStyle.color).toBe(LOOK.rd);
    expect(serie(optionen.wochentage).data[0]!.itemStyle.color).toBe(LOOK.gn);
    expect(serie(optionen.stunden).data[0]!.itemStyle.color).toBe(LOOK.rd);
  });

  it('Animation folgt dem Look-Schalter (reduced motion ⇒ alles aus)', () => {
    expect((optionen.verlauf as { animation: boolean }).animation).toBe(true);
    const still = baueOptionen(DATEN, { ...LOOK, animation: false });
    for (const o of Object.values(still)) expect((o as { animation: boolean }).animation).toBe(false);
  });

  it('mitAlpha: Hex-Token wird rgba, rgba-Token bleibt unangetastet', () => {
    expect(mitAlpha('#26cf9d', 0.26)).toBe('rgba(38, 207, 157, 0.26)');
    expect(mitAlpha('rgba(1,2,3,.5)', 0.26)).toBe('rgba(1,2,3,.5)');
  });
});

describe('Quelltext-Pins — die Refactoring-Fallen', () => {
  const modul = readFileSync(fileURLToPath(new URL('../src/analyseCharts.ts', import.meta.url)), 'utf8');
  const dashboard = readFileSync(fileURLToPath(new URL('../src/dashboard.ts', import.meta.url)), 'utf8');

  it('tree-shaken: nur echarts/core & Co., NIE das volle echarts-Paket', () => {
    expect(modul).toContain("from 'echarts/core'");
    expect(modul).not.toMatch(/from 'echarts';/);
  });

  it('prefers-reduced-motion wird respektiert', () => {
    expect(modul).toContain('prefers-reduced-motion');
  });

  it('Theme-Wechsel wird beobachtet (data-theme + Systemeinstellung)', () => {
    expect(modul).toContain("attributeFilter: ['data-theme']");
    expect(modul).toContain('prefers-color-scheme');
  });

  it('Host-Tausch wird erkannt (getDom-Vergleich) — sonst malt ECharts ins Leere', () => {
    expect(modul).toMatch(/getDom\(\)\s*!==\s*host/);
  });

  it('dashboard lädt das Modul NUR dynamisch (eigener Chunk fürs Bundle)', () => {
    expect(dashboard).toMatch(/import\('\.\/analyseCharts\.js'\)/);
    expect(dashboard).not.toMatch(/^import .* from '\.\/analyseCharts/m);
  });

  it('das Chart-Gerüst überlebt den Re-Render (Morph statt Austausch)', () => {
    // Der Neuaufbau ist an "Gerüst fehlt" gebunden — dieser Guard war der
    // ganze Zweck des Umbaus, ohne ihn gibt es keine weichen Übergänge.
    expect(dashboard).toMatch(/if \(!box\.querySelector\('\.an-grid'\)\)/);
  });
});
