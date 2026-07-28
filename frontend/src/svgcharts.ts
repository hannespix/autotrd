/**
 * Analyse-Diagramme als reines SVG (Owner-Wunsch 28.07.: „coole visuelle
 * Charts, Pies und sinnvolle Analyse-Diagramme").
 *
 * ── Warum von Hand statt Chart-Bibliothek ──────────────────────────────────
 *
 * Lightweight Charts kann Kurse, aber keine Donuts und keine Histogramme; und
 * eine zweite Bibliothek dafür wäre ein zweites CDN-Skript, das nach
 * CLAUDE.md §6 das ganze JS mitreißen kann, wenn es nicht lädt. Ein Donut ist
 * ein `<path>` mit zwei Bögen, ein Balken ein `<rect>` — der Aufwand steht in
 * keinem Verhältnis zu einem weiteren Ladepfad, der ausfallen kann.
 *
 * ── Regeln, die hier alle Funktionen einhalten ─────────────────────────────
 *
 *  1. **Reine Funktionen**: Daten rein, SVG-String raus. Kein DOM-Zugriff,
 *     kein Zustand — deshalb testbar ohne Browser.
 *  2. **Farben nur über CSS-Variablen** (`var(--gn)`, `var(--rd)` …), damit
 *     Hell- und Dunkelmodus ohne Neuzeichnen funktionieren.
 *  3. **`viewBox` + `preserveAspectRatio`**, keine festen Pixelmaße — die
 *     Karten sind bis 360 px breit responsiv.
 *  4. **Text wird escaped.** Symbolnamen kommen aus dem Katalog, aber ein
 *     ungeprüftes `<` in einem SVG-Text zerlegt das Markup — dieselbe Regel
 *     wie überall im Frontend.
 */

import { esc } from './html.js';

/** Gewinn grün, Verlust rot, exakt 0 neutral — überall gleich. */
export function pnlColor(v: number): string {
  return v > 0 ? 'var(--gn)' : v < 0 ? 'var(--rd)' : 'var(--t3)';
}

/**
 * Palette für KATEGORIEN (Ausstiegsgründe, Asset-Klassen …).
 *
 * Nötig geworden durch den Sichttest: Sind alle Ausstiegsgründe im Minus —
 * der Normalfall einer Strategie, die gerade verliert —, färbt `pnlColor`
 * jede Scheibe rot. Der Donut ist dann ein roter Ring ohne Aussage: Man
 * sieht nicht mehr, WELCHER Grund den größten Anteil hat, und genau das ist
 * die einzige Frage, für die man ihn anschaut.
 *
 * Bei Kategorien trägt die Farbe also die KATEGORIE, das Vorzeichen steht
 * als Zahl in der Legende.
 */
export const KAT_FARBEN = [
  'var(--ac)',
  'var(--vi)',
  'var(--gn)',
  'var(--rd)',
  'var(--ac2)',
  'var(--gn2)',
  'var(--rd2)',
  'var(--t2)',
] as const;

export function katColor(i: number): string {
  return KAT_FARBEN[i % KAT_FARBEN.length]!;
}

/** Zahl kompakt: 1.234 → „1,2k". Achsen werden sonst unlesbar. */
export function kurz(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1).replace('.', ',')}k`;
  if (a >= 10) return v.toFixed(0);
  return v.toFixed(2).replace('.', ',');
}

const svgWrap = (w: number, h: number, inner: string, cls = ''): string =>
  `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" class="svgc ${cls}" role="img">${inner}</svg>`;

/** Platzhalter statt eines leeren Kastens — „keine Daten" ist eine Aussage. */
export function leerBild(text = 'Noch keine Daten'): string {
  return `<div class="svgc-empty hint">${esc(text)}</div>`;
}

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
}

/**
 * Donut mit Legende.
 *
 * Nimmt BETRÄGE: Ein Kuchen aus gemischten Vorzeichen ist mathematisch
 * unsinnig (negative Winkel), deshalb wird der Betrag geplottet und das
 * Vorzeichen über die Farbe getragen. Die Legende zeigt den echten Wert.
 */
export function donut(
  slices: DonutSlice[],
  opts: { size?: number; loch?: number; kategorisch?: boolean } = {},
): string {
  const gefiltert = slices.filter((s) => Math.abs(s.value) > 0);
  if (gefiltert.length === 0) return leerBild();

  const kat = opts.kategorisch ?? true; // Donuts zeigen fast immer Kategorien
  const farbe = (s: DonutSlice, i: number): string =>
    s.color ?? (kat ? katColor(i) : pnlColor(s.value));
  const size = opts.size ?? 150;
  const r = size / 2 - 4;
  const ri = opts.loch ?? r * 0.58;
  const cx = size / 2;
  const cy = size / 2;
  const summe = gefiltert.reduce((a, s) => a + Math.abs(s.value), 0);

  let winkel = -Math.PI / 2; // 12 Uhr
  const pfade = gefiltert
    .map((s, i) => {
      const anteil = Math.abs(s.value) / summe;
      const ende = winkel + anteil * Math.PI * 2;
      const f = farbe(s, i);
      // Ein einzelner Wert ergäbe einen Vollkreis — den kann ein Bogen mit
      // identischem Start- und Endpunkt nicht zeichnen (er verschwindet).
      const d =
        anteil >= 0.9999
          ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} L ${cx - 0.01} ${cy - ri} A ${ri} ${ri} 0 1 0 ${cx} ${cy - ri} Z`
          : bogenPfad(cx, cy, r, ri, winkel, ende);
      winkel = ende;
      return `<path d="${d}" fill="${f}" opacity=".88"><title>${esc(s.label)}: ${kurz(s.value)}</title></path>`;
    })
    .join('');

  const legende = gefiltert
    .map(
      (s, i) =>
        `<li><i style="background:${farbe(s, i)}"></i><span class="svgc-lbl">${esc(s.label)}</span>` +
        `<b class="mono ${s.value > 0 ? 'c-gn' : s.value < 0 ? 'c-rd' : ''}">${kurz(s.value)}</b></li>`,
    )
    .join('');

  return `<div class="svgc-donut">${svgWrap(size, size, pfade)}<ul class="svgc-leg">${legende}</ul></div>`;
}

function bogenPfad(
  cx: number,
  cy: number,
  r: number,
  ri: number,
  von: number,
  bis: number,
): string {
  const gross = bis - von > Math.PI ? 1 : 0;
  const x1 = cx + r * Math.cos(von);
  const y1 = cy + r * Math.sin(von);
  const x2 = cx + r * Math.cos(bis);
  const y2 = cy + r * Math.sin(bis);
  const x3 = cx + ri * Math.cos(bis);
  const y3 = cy + ri * Math.sin(bis);
  const x4 = cx + ri * Math.cos(von);
  const y4 = cy + ri * Math.sin(von);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${gross} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${ri} ${ri} 0 ${gross} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
}

export interface BarPoint {
  label: string;
  value: number;
  color?: string;
}

/**
 * Senkrechte Balken mit Nulllinie in der Mitte.
 *
 * Die Nulllinie sitzt dort, wo sie hingehört — nicht am unteren Rand. Ein
 * Balkendiagramm mit Basis am Minimum lässt einen Verlust wie einen kleinen
 * Gewinn aussehen; das ist der klassischste aller Diagrammfehler und in
 * einer Handelsauswertung schlicht irreführend.
 */
export function barChart(
  points: BarPoint[],
  opts: { width?: number; height?: number; labelJede?: number } = {},
): string {
  if (points.length === 0) return leerBild();
  const w = opts.width ?? 640;
  const h = opts.height ?? 190;
  const padB = 20; // Platz für die Beschriftung
  const padT = 4;
  const nutz = h - padB - padT;
  const max = Math.max(...points.map((p) => Math.abs(p.value)), 1e-9);
  const bw = w / points.length;
  const nullY = padT + nutz / 2;
  const jede = opts.labelJede ?? Math.ceil(points.length / 12);

  const balken = points
    .map((p, i) => {
      const hoehe = (Math.abs(p.value) / max) * (nutz / 2);
      const x = i * bw + bw * 0.15;
      const y = p.value >= 0 ? nullY - hoehe : nullY;
      const bb = Math.max(bw * 0.7, 1);
      const beschriftung =
        i % jede === 0
          ? `<text x="${(x + bb / 2).toFixed(1)}" y="${h - 4}" class="svgc-ax" text-anchor="middle">${esc(p.label)}</text>`
          : '';
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bb.toFixed(1)}" height="${Math.max(hoehe, 0.6).toFixed(1)}" ` +
        `fill="${p.color ?? pnlColor(p.value)}" opacity=".85" rx="1.5">` +
        `<title>${esc(p.label)}: ${kurz(p.value)}</title></rect>${beschriftung}`
      );
    })
    .join('');

  const achse = `<line x1="0" y1="${nullY}" x2="${w}" y2="${nullY}" stroke="var(--bd2)" stroke-width="1"/>`;
  return svgWrap(w, h, achse + balken);
}

/**
 * Waagerechte Balken — für Symbol-Ranglisten mit langen Namen.
 *
 * Die Zeile hat drei feste Spalten: Beschriftung links, Balkenfeld in der
 * Mitte, Zahl rechts. Die Nulllinie sitzt in der MITTE des Balkenfelds, und
 * die Balkenlänge wird gegen dessen halbe Breite skaliert — nicht gegen den
 * Platz rechts davon.
 *
 * Genau daran scheiterte die erste Fassung: Sie maß die Länge am rechten
 * Rest, ließ negative Balken aber nach links laufen. Ein großer Verlust
 * bekam damit ein `x` im Minus, lief unter die Beschriftung und aus dem
 * viewBox heraus — sichtbar abgeschnitten, ausgerechnet beim schlechtesten
 * Symbol.
 */
export function hBarChart(points: BarPoint[], opts: { width?: number } = {}): string {
  if (points.length === 0) return leerBild();
  const w = opts.width ?? 640;
  const zh = 26;
  const h = points.length * zh;
  const max = Math.max(...points.map((p) => Math.abs(p.value)), 1e-9);

  const labelBreite = w * 0.28;
  const wertBreite = 56;
  const feld = Math.max(w - labelBreite - wertBreite, 20);
  const mitte = labelBreite + feld / 2;
  const maxLaenge = feld / 2;

  const zeilen = points
    .map((p, i) => {
      const laenge = Math.max((Math.abs(p.value) / max) * maxLaenge, 1);
      const y = i * zh + 3;
      const x = p.value >= 0 ? mitte : mitte - laenge;
      return (
        `<text x="${(labelBreite - 6).toFixed(1)}" y="${y + 11}" class="svgc-ax" text-anchor="end">${esc(p.label)}</text>` +
        `<rect x="${x.toFixed(1)}" y="${y}" width="${laenge.toFixed(1)}" height="${zh - 7}" ` +
        `fill="${p.color ?? pnlColor(p.value)}" opacity=".85" rx="2"><title>${esc(p.label)}: ${kurz(p.value)}</title></rect>` +
        `<text x="${w - 2}" y="${y + 11}" class="svgc-ax mono" text-anchor="end">${kurz(p.value)}</text>`
      );
    })
    .join('');

  return svgWrap(
    w,
    h,
    `<line x1="${mitte.toFixed(1)}" y1="0" x2="${mitte.toFixed(1)}" y2="${h}" stroke="var(--bd2)"/>${zeilen}`,
  );
}

/**
 * Flächen-Linie für den Kontoverlauf.
 *
 * Die Fläche wird ab dem STARTWERT gefüllt, nicht ab dem unteren Rand: So
 * zeigt Grün „über Start" und Rot „unter Start" — die Frage, die man an eine
 * Kontokurve wirklich stellt.
 */
export function areaLine(
  values: number[],
  opts: { width?: number; height?: number; start?: number } = {},
): string {
  if (values.length < 2) return leerBild('Mindestens zwei Trades nötig');
  const w = opts.width ?? 640;
  const h = opts.height ?? 200;
  const pad = 4;
  const start = opts.start ?? values[0]!;
  const alle = [...values, start];
  const min = Math.min(...alle);
  const max = Math.max(...alle);
  const spanne = max - min || 1;
  const x = (i: number): number => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (v: number): number => pad + (1 - (v - min) / spanne) * (h - pad * 2);

  const linie = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const nullY = y(start);
  const flaeche = `${linie} L ${x(values.length - 1).toFixed(1)} ${nullY.toFixed(1)} L ${x(0).toFixed(1)} ${nullY.toFixed(1)} Z`;
  const endwert = values[values.length - 1]!;
  const farbe = pnlColor(endwert - start);

  return svgWrap(
    w,
    h,
    `<defs><linearGradient id="agr" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0%" stop-color="${farbe}" stop-opacity=".28"/>
       <stop offset="100%" stop-color="${farbe}" stop-opacity="0"/>
     </linearGradient></defs>` +
      `<path d="${flaeche}" fill="url(#agr)"/>` +
      `<line x1="${pad}" y1="${nullY.toFixed(1)}" x2="${w - pad}" y2="${nullY.toFixed(1)}" stroke="var(--bd2)" stroke-dasharray="3 3"/>` +
      `<path d="${linie}" fill="none" stroke="${farbe}" stroke-width="1.8" stroke-linejoin="round"/>`,
  );
}

/** Histogramm — dieselbe Mechanik wie barChart, aber ohne Vorzeichen-Höhe:
 *  die Häufigkeit ist immer positiv, die FARBE trägt Gewinn/Verlust. */
export function histogram(
  bins: Array<{ from: number; to: number; n: number }>,
  opts: { width?: number; height?: number } = {},
): string {
  if (bins.length === 0) return leerBild();
  const w = opts.width ?? 640;
  const h = opts.height ?? 190;
  const padB = 20;
  const max = Math.max(...bins.map((b) => b.n), 1);
  const bw = w / bins.length;

  const balken = bins
    .map((b, i) => {
      const hoehe = (b.n / max) * (h - padB - 4);
      const mitte = (b.from + b.to) / 2;
      return (
        `<rect x="${(i * bw + bw * 0.12).toFixed(1)}" y="${(h - padB - hoehe).toFixed(1)}" ` +
        `width="${(bw * 0.76).toFixed(1)}" height="${Math.max(hoehe, 0.6).toFixed(1)}" ` +
        `fill="${pnlColor(mitte)}" opacity=".85" rx="1.5">` +
        `<title>${kurz(b.from)} bis ${kurz(b.to)}: ${b.n} Trade(s)</title></rect>`
      );
    })
    .join('');

  const nullX = (bins.findIndex((b) => b.to > 0) / bins.length) * w;
  return svgWrap(
    w,
    h,
    `<line x1="${nullX.toFixed(1)}" y1="0" x2="${nullX.toFixed(1)}" y2="${h - padB}" stroke="var(--bd2)" stroke-dasharray="2 3"/>` +
      balken +
      `<text x="2" y="${h - 3}" class="svgc-ax">Verlust</text>` +
      `<text x="${w - 2}" y="${h - 3}" class="svgc-ax" text-anchor="end">Gewinn</text>`,
  );
}
