/**
 * Wächter der Karten-Animation (Owner 22.08.: „in der in-tool Anzeige bitte
 * die dynamische Animation verwenden").
 *
 * Die tragende Eigenschaft ist die TRENNUNG: Dieselben SVGs gehen auf den
 * Bildschirm UND in eine PNG-Datei. Steckte die Bewegung im SVG selbst,
 * könnte die Rasterung einen Zwischenstand einfangen — halb gezeichnete
 * Kurve, Balken auf halber Höhe, Zahl bei 40 % Deckkraft. Das Bild sähe
 * nicht animiert aus, sondern kaputt, und zwar nur manchmal.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { animiereSvg } from '../src/kartenAnimation.js';
import { shareStory } from '../src/shareStory.js';
import type { ShareDaten } from '../src/shareCard.js';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
});

const kapitalDaten = (): ShareDaten =>
  ({
    zerlegung: { tage: [], equity: [], basis: 10_000, baender: [] },
    renditePct: 0,
    ergebnis: 0,
    waehrung: 'USD',
    trefferquotePct: null,
    profitFaktor: null,
    trades: 0,
    maxDrawdownPct: null,
    bestes: null,
    schlechtestes: null,
    echtgeld: false,
    betraege: true,
    tradeBilanz: 0,
    bar: 10_000,
    positionsWert: 2_000,
    cashflow: [
      { tag: '2026-08-11', zu: 0, ab: 1200, realisiert: 0 },
      { tag: '2026-08-12', zu: 1400, ab: 0, realisiert: 55 },
    ],
  }) as unknown as ShareDaten;

describe('Die Bewegung entsteht erst beim Anzeigen', () => {
  it('das gebaute SVG trägt KEINE Animation', () => {
    /* Marker ja (sie sind nur Attribute), Stil-Block nein — der ist es,
     * der etwas bewegt. */
    const svg = shareStory(kapitalDaten(), ['kapital'])[0]!.svg;
    expect(svg).not.toContain('<style>');
    expect(svg).not.toContain('@keyframes');
    expect(svg).toContain('data-anim=');
  });

  it('erst `animiereSvg` legt den Stil darüber', () => {
    const svg = shareStory(kapitalDaten(), ['kapital'])[0]!.svg;
    const bewegt = animiereSvg(svg);
    expect(bewegt).toContain('@keyframes anWachsen');
    // …und zwar INNERHALB des SVG, sonst greift nichts.
    expect(bewegt.indexOf('<style>')).toBeGreaterThan(bewegt.indexOf('<svg'));
  });

  it('nur die Vorschau ruft sie auf — der Export nie', () => {
    const dash = lies('dashboard.ts');
    expect(dash).toContain('box.innerHTML = animiereSvg(storyKarten[storyIdx]!.svg);');
    /* Die beiden Export-Wege bauen ihre Karten frisch und reichen den
     * String unverändert weiter. Käme `animiereSvg` dort vor, landete die
     * Bewegung in der Datei. */
    const exportBlock = dash.slice(dash.indexOf('for (const karte of shareStory(daten'));
    expect(exportBlock.slice(0, 600)).not.toContain('animiereSvg');
  });
});

describe('Was sich bewegt, bewegt sich richtig', () => {
  it('Balken unter der Achse wachsen nach UNTEN', () => {
    /* Ein gemeinsamer Ursprung liesse die Verlust-Balken aus der falschen
     * Richtung einfliegen — sie hängen unter der Nulllinie, wachsen also
     * von oben. */
    const stil = lies('kartenAnimation.ts');
    expect(stil).toContain('[data-anim="balken"] { transform-origin: bottom; }');
    expect(stil).toContain('[data-anim="balken-ab"] { transform-origin: top; }');
    const svg = shareStory(kapitalDaten(), ['kapital'])[0]!.svg;
    expect(svg).toContain('data-anim="balken"');
    expect(svg).toContain('data-anim="balken-ab"');
  });

  it('Kurven tragen pathLength="1" — sonst wäre die Länge unbekannt', () => {
    /* `stroke-dasharray: 1` funktioniert nur mit normalisierter Länge; die
     * echte Geometrie steht im String nicht und liesse sich hier nicht
     * messen. */
    const karte = lies('shareCard.ts');
    expect(karte).toContain('pathLength="1" ${ANIM_LINIE}');
  });

  it('die Balken staffeln sich, aber gedeckelt', () => {
    /* Ohne Deckel startete die letzte Zeile einer langen Karte fast eine
     * Sekunde nach der ersten — aus „baut sich auf" würde „hängt". */
    const bewegt = animiereSvg(shareStory(kapitalDaten(), ['kapital'])[0]!.svg);
    const delays = [...bewegt.matchAll(/animation-delay:(\d+)ms/g)].map((m) => Number(m[1]));
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[0]).toBe(0);
    for (const d of delays) expect(d).toBeLessThanOrEqual(560);
  });

  it('die Bewegung läuft EINMAL und endet im statischen Bild', () => {
    // Eine Dauerschleife wäre nach dem zweiten Ansehen nur noch Unruhe.
    const stil = lies('kartenAnimation.ts');
    expect(stil).not.toContain('infinite');
    expect(stil.match(/forwards/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Wer Bewegung abbestellt hat, bekommt keine', () => {
  it('prefers-reduced-motion schaltet sie ab — und stellt die Endzustände her', () => {
    /* Nur `animation: none` würde die Karte UNSICHTBAR lassen: Die
     * Startwerte stehen auf scaleY(0) und opacity 0. Ohne die Rückstellung
     * hätte der Schalter die Karte gelöscht statt beruhigt. */
    const stil = lies('kartenAnimation.ts');
    const block = stil.slice(stil.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('[data-anim] { animation: none !important; }');
    expect(block).toContain('stroke-dashoffset: 0;');
    expect(block).toContain('transform: none;');
    expect(block).toContain('opacity: 1;');
  });

  it('ohne Marker bleibt das SVG unangetastet', () => {
    // Ein Stil-Block ohne Wirkung wäre nur Gewicht.
    const ohne = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(animiereSvg(ohne)).toBe(ohne);
  });
});
