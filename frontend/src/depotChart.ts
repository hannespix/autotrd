/**
 * Depot-Verlauf als gestapelte Zerlegung — die Gesamtlinie und ihre Ursachen.
 *
 * ── Was hier gezeichnet wird ──────────────────────────────────────────────
 *
 * Eine waagerechte Bezugslinie (Equity am ersten Tag des Fensters) und
 * darauf eine Wasserfall-Treppe: jede Fläche ein Symbol oder ein einzelner
 * Trade, ihre Höhe der seit Fensterbeginn kumulierte Beitrag. Gewinner
 * bauen den Berg auf, Verlierer tragen ihn wieder ab, zuletzt korrigiert der
 * Buchwert der offenen Positionen auf den tatsächlichen Stand.
 *
 * Weil jedes Band dort ansetzt, wo das vorige aufhört, endet die Treppe genau
 * auf der Equity-Änderung — die Depot-Linie läuft sichtbar auf der Oberkante
 * des LETZTEN Bandes. Tut sie das nicht, ist die Rechnung kaputt: die beste
 * eingebaute Kontrolle, die diese Grafik haben kann.
 *
 * ── Warum handgemaltes SVG und keine Chart-Bibliothek ─────────────────────
 *
 * Lightweight Charts (das im Kurs-Chart läuft) kennt keine gestapelten
 * Flächen mit NEGATIVEN Beiträgen: Jede Area-Serie füllt gegen eine feste
 * Grundlinie. Ein Verlust-Band müsste man ihr als Trick unterschieben und
 * hätte am Ende beides — eine Bibliothek und die ganze Stapel-Rechnung von
 * Hand. Hier sind es ≤120 Tagespunkte; das SVG ist kleiner als der Trick.
 */
import {
  type BandFlaeche,
  type DepotZerlegung,
  stapelBaender,
} from '@autotrd/shared';
import { esc } from './html.js';
import { t } from './i18n.js';
import { kurz } from './svgcharts.js';

/** Zeichenfläche in Nutzerkoordinaten; die Karte skaliert per CSS. */
const B = 100;
const H = 46;
const RAND = { oben: 3, unten: 8, links: 0, rechts: 11 };

/**
 * Farbe eines Bandes.
 *
 * Das Vorzeichen trägt die Farbe, nicht die Kategorie — genau umgekehrt zum
 * Donut der Ausstiegsgründe, und aus demselben Grund: Dort ist die Frage
 * „welcher Anteil", hier ist sie „womit verdient, womit verloren". Die
 * Abstufung innerhalb einer Farbe trennt die Bänder voneinander, ohne die
 * Grundaussage zu verwischen.
 */
export function bandFarbe(f: BandFlaeche, rang: number): string {
  // Der offene Anteil ist bewusst blass: Er ist oft der größte Block, hat
  // aber noch nichts entschieden. In voller Deckkraft erschlägt er die
  // realisierten Bänder — genau die, um die es geht.
  if (f.key === '__offen__') return 'color-mix(in srgb, var(--ac) 24%, transparent)';
  const deck = Math.max(0.28, 0.72 - rang * 0.11);
  return f.summe >= 0
    ? `color-mix(in srgb, var(--gn) ${Math.round(deck * 100)}%, transparent)`
    : `color-mix(in srgb, var(--rd) ${Math.round(deck * 100)}%, transparent)`;
}

/** Achsenbeschriftung: höchstens `n` Datums-Marken, immer erste und letzte. */
export function datumsMarken(tage: string[], n = 4): number[] {
  if (tage.length <= n) return tage.map((_, i) => i);
  const schritt = (tage.length - 1) / (n - 1);
  const idx = new Set<number>();
  for (let k = 0; k < n; k++) idx.add(Math.round(k * schritt));
  return [...idx].sort((a, b) => a - b);
}

/** `2026-08-07` → `07.08.` — kurz genug für eine Achse auf 390 px. */
export function tagKurz(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

export interface DepotChartTeile {
  svg: string;
  /** Legende als HTML — sie steht außerhalb des SVG, damit sie umbrechen darf. */
  legende: string;
}

/**
 * Baut SVG und Legende.
 *
 * Reine Funktion mit String-Ausgabe: Sie ist damit ohne Browser prüfbar, und
 * der Bild-Prüfstand kann exakt dasselbe zeichnen, was die App zeigt.
 */
export function depotChart(z: DepotZerlegung): DepotChartTeile {
  if (z.tage.length < 2) {
    return {
      svg: '',
      legende: `<div class="hint">${t('dc.zuWenigTage')}</div>`,
    };
  }
  const flaechen = stapelBaender(z);
  const n = z.tage.length;

  // ── Skala ────────────────────────────────────────────────────────────────
  // Sie muss die Equity-Linie UND den Stapel fassen. Beide sind per Identität
  // deckungsgleich; ein Auseinanderlaufen wäre ein Rechenfehler und soll
  // sichtbar bleiben statt aus dem Bild zu wandern.
  let min = Math.min(...z.equity);
  let max = Math.max(...z.equity);
  for (const f of flaechen) {
    for (const [u, o] of f.kanten) {
      min = Math.min(min, z.basis + u);
      max = Math.max(max, z.basis + o);
    }
  }
  min = Math.min(min, z.basis);
  max = Math.max(max, z.basis);
  const spanne = max - min || 1;
  const luft = spanne * 0.06;
  const y0 = min - luft;
  const y1 = max + luft;

  const breite = B - RAND.links - RAND.rechts;
  const hoehe = H - RAND.oben - RAND.unten;
  const px = (i: number): number => RAND.links + (i / (n - 1)) * breite;
  const py = (v: number): number => RAND.oben + (1 - (v - y0) / (y1 - y0)) * hoehe;

  const p2 = (v: number): string => v.toFixed(2);
  const basisY = py(z.basis);

  // ── Flächen ──────────────────────────────────────────────────────────────
  const pfade = flaechen
    .map((f, rang) => {
      if (f.kanten.every(([u, o]) => Math.abs(o - u) < 1e-9)) return '';
      const oben = f.kanten.map(([, o], i) => `${p2(px(i))},${p2(py(z.basis + o))}`);
      const unten = f.kanten
        .map(([u], i) => `${p2(px(i))},${p2(py(z.basis + u))}`)
        .reverse();
      return (
        `<polygon class="dc-band" data-key="${esc(f.key)}" points="${oben.join(' ')} ${unten.join(' ')}"`
        + ` fill="${bandFarbe(f, rang)}"></polygon>`
      );
    })
    .join('');

  // ── Bezugslinie, Equity-Linie, Achsen ────────────────────────────────────
  const eqPunkte = z.equity.map((v, i) => `${p2(px(i))},${p2(py(v))}`).join(' ');
  const marken = datumsMarken(z.tage);
  const xAchse = marken
    .map((i) => {
      // Erste Marke linksbündig, letzte rechtsbündig — sonst ragen sie raus.
      const anker = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return `<text class="dc-ax" x="${p2(px(i))}" y="${H - 2}" text-anchor="${anker}">${esc(tagKurz(z.tage[i]!))}</text>`;
    })
    .join('');
  const yAchse = [y1 - luft, z.basis, y0 + luft]
    .map(
      (v) =>
        `<text class="dc-ax" x="${B - RAND.rechts + 1}" y="${p2(py(v) + 1.2)}" text-anchor="start">${esc(kurz(v))}</text>`,
    )
    .join('');

  // Unsichtbare Spalten als Treffer-Flächen für den Tooltip: ein Rechteck je
  // Tag ist robuster als Mausposition-Rechnen und funktioniert per Touch.
  const treffer = z.tage
    .map((t, i) => {
      const halb = breite / (n - 1) / 2;
      const x = Math.max(RAND.links, px(i) - halb);
      const w = Math.min(halb * 2, B - RAND.rechts - x);
      return `<rect class="dc-hit" data-i="${i}" data-tag="${esc(t)}" x="${p2(x)}" y="0" width="${p2(w)}" height="${H - RAND.unten}"></rect>`;
    })
    .join('');

  const svg =
    `<svg class="dc-svg" viewBox="0 0 ${B} ${H}" preserveAspectRatio="none" role="img"`
    + ` aria-label="Depot-Verlauf, zerlegt nach Trades">`
    + pfade
    + `<line class="dc-basis" x1="${RAND.links}" y1="${p2(basisY)}" x2="${B - RAND.rechts}" y2="${p2(basisY)}"></line>`
    + `<polyline class="dc-eq-halo" points="${eqPunkte}"></polyline>`
    + `<polyline class="dc-eq" points="${eqPunkte}"></polyline>`
    + `<line class="dc-cross" x1="0" y1="0" x2="0" y2="${H - RAND.unten}" style="display:none"></line>`
    + xAchse
    + yAchse
    + treffer
    + '</svg>';

  // ── Legende ──────────────────────────────────────────────────────────────
  const geld = (v: number): string =>
    `${v > 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}`;
  /* Die Sonderbaender tragen deutsche Anzeige-Labels aus shared
   * (depotAufteilung) — im EN-Modus blieben sie deutsch stehen
   * (Owner-Screenshot 20.08.). Der KEY ist die Wahrheit; die Sprache
   * entscheidet das Woerterbuch. Symbol-/Trade-Baender bleiben, was sie
   * sind: Ticker sind keine Uebersetzungssache. */
  const bandName = (f: BandFlaeche): string =>
    f.key === '__offen__'
      ? t('dc.offenePositionen')
      : f.key === '__rest__'
        ? `${t('dc.uebrige')} (${f.trades})`
        : f.label;
  const legende = flaechen
    .filter((f) => f.summe !== 0 || f.key === '__offen__')
    .map((f, rang) => {
      const zusatz = f.trades > 0 ? ` · ${f.trades} ${f.trades === 1 ? 'Trade' : 'Trades'}` : '';
      return (
        `<span class="dc-leg" data-key="${esc(f.key)}">`
        + `<i style="background:${bandFarbe(f, rang)}"></i>`
        + `<b>${esc(bandName(f))}</b>`
        + `<span class="mono ${f.summe >= 0 ? 'c-gn' : 'c-rd'}">${esc(geld(f.summe))}</span>`
        + `<span class="dc-leg-n">${esc(zusatz)}</span></span>`
      );
    })
    .join('');

  return { svg, legende };
}

/**
 * Der Tooltip-Text für einen Tag.
 *
 * Er nennt die Equity und darunter die Beiträge — aber nur die, die an diesem
 * Tag von null verschieden sind. Eine Liste mit acht Nullzeilen wäre auf dem
 * Telefon höher als der Chart.
 */
export function depotTooltip(z: DepotZerlegung, i: number): string {
  if (i < 0 || i >= z.tage.length) return '';
  const geld = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}`;
  const zeilen = z.baender
    .filter((b) => b.werte[i] !== 0)
    .map((b) => `<div><span>${esc(b.label)}</span><b class="${b.werte[i]! >= 0 ? 'c-gn' : 'c-rd'}">${esc(geld(b.werte[i]!))}</b></div>`);
  const offen = z.offen[i]!;
  if (offen !== 0) {
    zeilen.push(
      `<div><span>${t('dc.offenePositionen')}</span><b class="${offen >= 0 ? 'c-gn' : 'c-rd'}">${esc(geld(offen))}</b></div>`,
    );
  }
  const delta = z.equity[i]! - z.basis;
  return (
    `<div class="dc-tt-h"><b>${esc(z.tage[i]!)}</b>`
    + `<span class="mono">${esc(z.equity[i]!.toFixed(2).replace('.', ','))}</span></div>`
    + `<div class="dc-tt-d"><span>${t('dc.seit')} ${esc(z.tage[0]!)}</span>`
    + `<b class="${delta >= 0 ? 'c-gn' : 'c-rd'}">${esc(geld(delta))}</b></div>`
    + (zeilen.length > 0 ? `<div class="dc-tt-l">${zeilen.join('')}</div>` : '')
  );
}
