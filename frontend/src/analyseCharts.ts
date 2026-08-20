/**
 * Analyse-Diagramme animiert (Owner 20.08., pixpower-Machart).
 *
 * ── Warum jetzt doch eine Bibliothek (svgcharts.ts sagt „keine") ───────────
 *
 * Der Einwand in svgcharts.ts galt einem ZWEITEN CDN-Skript, dessen Ausfall
 * das ganze JS mitreißen kann. ECharts kommt hier als npm-Paket INS Bundle —
 * es gibt keinen zweiten Ladepfad. Tree-shaken (core + 3 Charttypen + SVG-
 * Renderer) und per dynamic import erst beim ersten Öffnen des Analyse-
 * Fensters geladen: eigener Chunk, das Hauptbundle wächst nicht.
 *
 * ── Die pixpower-Art ───────────────────────────────────────────────────────
 *
 * Nicht die Animationen von dort, die Machart: Instanzen werden BEHALTEN und
 * bekommen bei jedem Werte-Wechsel nur `setOption` (Merge) — der Zeitraum-
 * Umschalter morpht dadurch Balken und Linien weich in die neuen Werte,
 * statt das Bild auszutauschen. Deshalb darf `renderAnalytics` das Gerüst
 * nicht bei jedem Aufruf neu bauen (siehe dort) und deshalb prüft
 * `aktualisiereAnalyseCharts` per `getDom()`, ob der Host noch derselbe ist.
 *
 * `prefers-reduced-motion` schaltet alle Animationen ab — wer das
 * eingestellt hat, meint es.
 *
 * Farben kommen aus den Frosted-Aurora-Tokens (getComputedStyle), nicht als
 * `var(...)`-Strings: ECharts rechnet mit echten Farbwerten (Verläufe,
 * Tooltips). Theme-Wechsel (data-theme bzw. Systemeinstellung) zeichnet mit
 * frisch gelesenen Tokens neu.
 */

import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { kurz } from './svgcharts.js';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
]);

export interface Balken {
  label: string;
  value: number;
}

export interface AnalyseChartDaten {
  /** Realisierte Kurve; erster Wert ist der Bezugspunkt (Startkapital). */
  verlauf: number[];
  histo: Array<{ from: number; to: number; n: number }>;
  exits: Balken[];
  symbole: Balken[];
  wochentage: Balken[];
  stunden: Balken[];
}

export const ASPEKTE = ['verlauf', 'verteilung', 'exits', 'symbole', 'wochentage', 'stunden'] as const;
export type Aspekt = (typeof ASPEKTE)[number];

/** Farb- und Verhaltens-Tokens — als echte Werte, nicht als var()-Strings. */
export interface ChartLook {
  text: string;
  leise: string;
  hair: string;
  bd: string;
  gn: string;
  rd: string;
  /** Kategorien-Palette (Ausstiegsgründe) — Reihenfolge wie KAT_FARBEN. */
  kat: string[];
  dunkel: boolean;
  animation: boolean;
}

const lies = (s: CSSStyleDeclaration, name: string, fallback: string): string =>
  s.getPropertyValue(name).trim() || fallback;

function liesLook(): ChartLook {
  const s = getComputedStyle(document.documentElement);
  const attr = document.documentElement.dataset['theme'];
  const dunkel = attr ? attr === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    text: lies(s, '--t2', '#9fadc4'),
    leise: lies(s, '--t3', '#7e8ca6'),
    hair: lies(s, '--hair', 'rgba(255,255,255,.06)'),
    bd: lies(s, '--bd2', 'rgba(255,255,255,.18)'),
    gn: lies(s, '--gn', '#26cf9d'),
    rd: lies(s, '--rd', '#f2586b'),
    kat: ['--ac', '--vi', '--gn', '--rd', '--ac2', '--gn2', '--rd2', '--t2'].map((n, i) =>
      lies(s, n, ['#25d0ee', '#8b7cff', '#26cf9d', '#f2586b', '#5ce4fb', '#40e0b4', '#ff8290', '#9fadc4'][i]!),
    ),
    dunkel,
    animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

/** #rrggbb → rgba(…, a); alles andere (rgba-Tokens) unverändert durchreichen. */
export function mitAlpha(farbe: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(farbe.trim());
  if (!m) return farbe;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const vorzeichenFarbe = (v: number, look: ChartLook): string =>
  v > 0 ? look.gn : v < 0 ? look.rd : look.leise;

/** Gemeinsame Grundeinstellungen — Hairline-Raster, leise Achsen, Mono-Zahlen. */
function basis(look: ChartLook): EChartsCoreOption {
  return {
    animation: look.animation,
    animationDuration: 550,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 550,
    animationEasingUpdate: 'cubicInOut',
    textStyle: { fontFamily: 'inherit' },
    tooltip: {
      backgroundColor: look.dunkel ? 'rgba(16, 22, 36, .94)' : 'rgba(252, 253, 255, .96)',
      borderColor: look.bd,
      borderWidth: 1,
      textStyle: { color: look.text, fontSize: 12 },
      extraCssText: 'border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,.18);',
    },
    grid: { left: 6, right: 10, top: 12, bottom: 4, containLabel: true },
  };
}

const wertAchse = (look: ChartLook): Record<string, unknown> => ({
  type: 'value',
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: look.leise, fontSize: 10, formatter: (v: number) => kurz(v) },
  splitLine: { lineStyle: { color: look.hair } },
});

const katAchse = (look: ChartLook, labels: string[], jede = 0): Record<string, unknown> => ({
  type: 'category',
  data: labels,
  axisLine: { lineStyle: { color: look.bd } },
  axisTick: { show: false },
  axisLabel: { color: look.leise, fontSize: 10, interval: jede },
});

const vorzeichenBalken = (
  punkte: Balken[],
  look: ChartLook,
  radius: number[],
): Record<string, unknown> => ({
  type: 'bar',
  data: punkte.map((p) => ({
    value: p.value,
    itemStyle: { color: vorzeichenFarbe(p.value, look), opacity: 0.88, borderRadius: radius },
  })),
});

/**
 * Alle sechs Optionen aus EINEM Datenstand — pur (kein DOM), damit Tests die
 * Farb- und Ehrlichkeitsregeln prüfen können, ohne einen Browser zu starten.
 */
export function baueOptionen(d: AnalyseChartDaten, look: ChartLook): Record<Aspekt, EChartsCoreOption> {
  // Kontoverlauf: Farbe trägt das Gesamtergebnis, die gestrichelte Linie den
  // Bezugspunkt — dieselbe Aussage wie die alte areaLine, nur lebendig.
  const start = d.verlauf[0] ?? 0;
  const ende = d.verlauf.length > 0 ? d.verlauf[d.verlauf.length - 1]! : start;
  const vFarbe = vorzeichenFarbe(ende - start, look);
  const verlauf: EChartsCoreOption = {
    ...basis(look),
    tooltip: { ...(basis(look).tooltip as object), trigger: 'axis', valueFormatter: (v: unknown) => kurz(Number(v)) },
    xAxis: { type: 'category', show: false, data: d.verlauf.map((_, i) => String(i)) },
    yAxis: { ...wertAchse(look), scale: true },
    series: [
      {
        name: 'Depot',
        type: 'line',
        data: d.verlauf,
        showSymbol: false,
        lineStyle: { width: 1.8, color: vFarbe },
        itemStyle: { color: vFarbe },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: mitAlpha(vFarbe, 0.26) },
              { offset: 1, color: mitAlpha(vFarbe, 0) },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: look.bd, type: 'dashed' },
          data: [{ yAxis: start }],
        },
      },
    ],
  };

  // Verteilung: Höhe = Häufigkeit (immer positiv), FARBE = Vorzeichen der
  // Fach-Mitte — dieselbe Regel wie im alten Histogramm.
  const verteilung: EChartsCoreOption = {
    ...basis(look),
    xAxis: katAchse(look, d.histo.map((b) => kurz((b.from + b.to) / 2)), Math.max(0, Math.ceil(d.histo.length / 6) - 1)),
    // Häufigkeiten sind ganze Zahlen — „1,00 Trades" gibt es nicht.
    yAxis: {
      ...wertAchse(look),
      minInterval: 1,
      axisLabel: { color: look.leise, fontSize: 10, formatter: (v: number) => String(Math.round(v)) },
    },
    series: [
      {
        type: 'bar',
        barCategoryGap: '18%',
        data: d.histo.map((b) => ({
          value: b.n,
          itemStyle: {
            color: vorzeichenFarbe((b.from + b.to) / 2, look),
            opacity: 0.88,
            borderRadius: [3, 3, 0, 0],
          },
        })),
      },
    ],
  };

  // Ausstiegsgründe: Kuchen aus BETRÄGEN (negative Winkel gibt es nicht),
  // Farbe trägt die Kategorie, der echte vorzeichenbehaftete Wert steht im
  // Tooltip — dieselben Regeln wie beim alten Donut.
  const exitsGefiltert = d.exits.filter((s) => Math.abs(s.value) > 0);
  const echteWerte = new Map(exitsGefiltert.map((s) => [s.label, s.value]));
  const exits: EChartsCoreOption = {
    ...basis(look),
    tooltip: {
      ...(basis(look).tooltip as object),
      formatter: (p: { name: string; percent: number }) =>
        `${p.name}: ${kurz(echteWerte.get(p.name) ?? 0)} (${Math.round(p.percent)}%)`,
    },
    legend: {
      bottom: 0,
      icon: 'roundRect',
      itemWidth: 9,
      itemHeight: 9,
      textStyle: { color: look.text, fontSize: 11 },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '78%'],
        center: ['50%', '42%'],
        avoidLabelOverlap: true,
        label: { show: false },
        emphasis: { scaleSize: 4 },
        data: exitsGefiltert.map((s, i) => ({
          name: s.label,
          value: Math.abs(s.value),
          itemStyle: { color: look.kat[i % look.kat.length] },
        })),
      },
    ],
  };

  // Je Symbol: liegende Balken, bester oben (inverse), Farbe = Vorzeichen.
  const symbole: EChartsCoreOption = {
    ...basis(look),
    tooltip: { ...(basis(look).tooltip as object), valueFormatter: (v: unknown) => kurz(Number(v)) },
    xAxis: wertAchse(look),
    yAxis: { ...katAchse(look, d.symbole.map((p) => p.label)), inverse: true },
    series: [vorzeichenBalken(d.symbole, look, [0, 3, 3, 0])],
  };

  const wochentage: EChartsCoreOption = {
    ...basis(look),
    tooltip: { ...(basis(look).tooltip as object), valueFormatter: (v: unknown) => kurz(Number(v)) },
    xAxis: katAchse(look, d.wochentage.map((p) => p.label)),
    yAxis: wertAchse(look),
    series: [vorzeichenBalken(d.wochentage, look, [3, 3, 0, 0])],
  };

  const stunden: EChartsCoreOption = {
    ...basis(look),
    tooltip: { ...(basis(look).tooltip as object), valueFormatter: (v: unknown) => kurz(Number(v)) },
    xAxis: katAchse(look, d.stunden.map((p) => p.label), 2),
    yAxis: wertAchse(look),
    series: [vorzeichenBalken(d.stunden, look, [3, 3, 0, 0])],
  };

  return { verlauf, verteilung, exits, symbole, wochentage, stunden };
}

/* ── Laufzeit: Instanzen führen, morphen, auf Theme reagieren ────────────── */

const instanzen = new Map<Aspekt, { chart: echarts.ECharts; ro: ResizeObserver }>();
let letzteDaten: AnalyseChartDaten | null = null;
let beobachtet = false;

/**
 * Zeichnet bzw. morpht alle sechs Diagramme in ihre Hosts (`#anEc-<aspekt>`).
 * Hosts, die es gerade nicht gibt (leerer Zeitraum), werden übersprungen;
 * Instanzen auf ausgetauschten Hosts (innerHTML-Neuaufbau) werden erkannt
 * und neu aufgesetzt.
 */
export function aktualisiereAnalyseCharts(d: AnalyseChartDaten): void {
  letzteDaten = d;
  const optionen = baueOptionen(d, liesLook());
  for (const k of ASPEKTE) {
    const host = document.getElementById(`anEc-${k}`);
    if (!host) continue;
    let eintrag = instanzen.get(k);
    if (eintrag && eintrag.chart.getDom() !== host) {
      eintrag.ro.disconnect();
      eintrag.chart.dispose();
      eintrag = undefined;
    }
    if (!eintrag) {
      const chart = echarts.init(host, undefined, { renderer: 'svg' });
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(host);
      eintrag = { chart, ro };
      instanzen.set(k, eintrag);
    }
    // Merge, NICHT notMerge: genau dadurch morphen die Werte beim
    // Zeitraum-Umschalten, statt dass das Bild ausgetauscht wird.
    eintrag.chart.setOption(optionen[k]);
  }
  beobachteThema();
}

/** Instanzen aufgeben (leerer Zeitraum / Abmeldung) — kein Malen ins Leere. */
export function entsorgeAnalyseCharts(): void {
  for (const { chart, ro } of instanzen.values()) {
    ro.disconnect();
    chart.dispose();
  }
  instanzen.clear();
  letzteDaten = null;
}

/** Theme-Wechsel (data-theme oder Systemeinstellung) ⇒ Tokens frisch lesen. */
function beobachteThema(): void {
  if (beobachtet) return;
  beobachtet = true;
  const neu = (): void => {
    if (letzteDaten) aktualisiereAnalyseCharts(letzteDaten);
  };
  new MutationObserver(neu).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', neu);
}
