/**
 * Wächter der Teilen-Story (Owner 20.08.).
 *
 * Die Karten verlassen die App — hier stehen die Regeln, die dabei nicht
 * verhandelbar sind: Siegel auf allem, was Zahlen zeigt; keine CSS-Variablen
 * (das Raster kennt kein Dokument); die CTA-Karte behauptet KEINE Zahl.
 * Ob die Karten als BILD taugen, prüft frontend/e2e/share-shot.mjs.
 */
import { zerlegeDepot } from '@autotrd/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { shareStory, storyDateiname } from '../src/shareStory.js';
import type { ShareDaten } from '../src/shareCard.js';

beforeEach(() => {
  // t() liest die Sprachwahl aus localStorage — in Node wird sie gestellt.
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
});

function fixture(): ShareDaten {
  const tage = [
    { date: '2026-08-14', equity: 10_000 },
    { date: '2026-08-17', equity: 10_120 },
    { date: '2026-08-18', equity: 9_950 },
    { date: '2026-08-19', equity: 10_240 },
  ];
  const trades = [
    { symbol: 'NVDA', side: 'sell', qty: 1, price: 100, pnl: 180, executedAt: '2026-08-16T19:00:00.000Z' },
    { symbol: 'EWJ', side: 'sell', qty: 1, price: 100, pnl: -60, executedAt: '2026-08-17T19:00:00.000Z' },
    { symbol: 'GLD', side: 'sell', qty: 1, price: 100, pnl: 95, executedAt: '2026-08-18T19:00:00.000Z' },
  ];
  const zerlegung = zerlegeDepot(tage, trades);
  return {
    zerlegung,
    renditePct: 2.4,
    ergebnis: 240,
    waehrung: 'USD',
    trefferquotePct: 66.7,
    profitFaktor: 4.58,
    trades: 3,
    maxDrawdownPct: -1.7,
    bestes: { label: 'NVDA', pct: 1.8 },
    schlechtestes: { label: 'EWJ', pct: -0.6 },
    echtgeld: false,
    betraege: false,
    tradeBilanz: 215,
    vonTag: '2026-08-16',
    bisTag: '2026-08-18',
  };
}

/** Alle sichtbaren Textinhalte eines SVG-Strings. */
function texte(svg: string): string[] {
  return [...svg.matchAll(/>([^<]+)<\/(?:text|tspan)>/g)].map((m) => m[1]!);
}

describe('shareStory — Aufbau', () => {
  it('volle Daten ⇒ vier Karten in Lese-Reihenfolge', () => {
    expect(shareStory(fixture()).map((k) => k.id)).toEqual(['ergebnis', 'verlauf', 'womit', 'cta']);
  });

  it('ohne Kurve entfallen Verlauf und Womit ersatzlos — keine leeren Grafiken', () => {
    const d = { ...fixture(), zerlegung: zerlegeDepot([], []) };
    expect(shareStory(d).map((k) => k.id)).toEqual(['ergebnis', 'cta']);
  });

  it('jede Karte ist ein eigenständiges SVG ohne CSS-Variablen', () => {
    for (const k of shareStory(fixture())) {
      expect(k.svg.startsWith('<svg xmlns=')).toBe(true);
      // Beim Rastern gibt es kein Dokument mehr — var(--x) würde schwarz.
      expect(k.svg, k.id).not.toContain('var(');
    }
  });

  it('Dateinamen tragen Karten-Art und Endtag — ein Karussell-Ordner sortiert sich', () => {
    const d = fixture();
    expect(storyDateiname('verlauf', d)).toBe('autotrd-verlauf-2026-08-19.png');
  });
});

describe('shareStory — Ehrlichkeitsregeln je Karte', () => {
  it('jede Zahlen-Karte trägt das Siegel (Papier bleibt Papier)', () => {
    for (const k of shareStory(fixture())) {
      if (k.id === 'cta') continue;
      expect(k.svg, k.id).toContain('data-rolle="siegel"');
      expect(k.svg, k.id).toContain('PAPIERKONTO');
    }
  });

  it('die CTA-Karte enthält KEINE Ziffer — eine Werbekarte mit Beispiel-Rendite wäre ein erfundener Track-Record', () => {
    const cta = shareStory(fixture()).find((k) => k.id === 'cta')!;
    for (const text of texte(cta.svg)) {
      expect(text, `CTA-Text „${text}"`).not.toMatch(/\d/);
    }
    expect(cta.svg).toContain('autotrd.net');
  });

  it('der Verlauf zeichnet Bänder UND die Depot-Linie — die Grafik, um die es geht', () => {
    const verlauf = shareStory(fixture()).find((k) => k.id === 'verlauf')!;
    expect((verlauf.svg.match(/<polygon /g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(verlauf.svg).toContain('<polyline ');
    // Sonderbänder sprechen die UI-Sprache, nicht das deutsche shared-Label.
    expect(verlauf.svg).toContain('Offene Positionen');
  });

  it('Legenden-Chip trägt die FARBE seiner Fläche (Owner-Befund 20.08.: sechs gleiche Chips)', () => {
    /* Vorher färbten die Chips nur nach Vorzeichen, die Flächen aber gestuft
     * — bei sechs Gewinnern sechs identische grüne Chips neben sechs
     * verschiedenen Flächen: keine Zuordnung möglich. Jetzt kommt beides aus
     * EINER Zuweisung; der Chip einer Fläche MUSS deren Füllfarbe tragen. */
    const verlauf = shareStory(fixture()).find((k) => k.id === 'verlauf')!;
    const flaechenFarben = [...verlauf.svg.matchAll(/<polygon [^>]*fill="([^"]+)" opacity="0.55"/g)].map((m) => m[1]!);
    const chipFarben = [...verlauf.svg.matchAll(/<rect [^>]*width="22" height="22" rx="5" fill="([^"]+)"/g)].map((m) => m[1]!);
    expect(chipFarben.length).toBe(flaechenFarben.length);
    for (const f of chipFarben) expect(flaechenFarben, f).toContain(f);
  });

  it('sechs Gewinner bekommen sechs VERSCHIEDENE Töne — nie auf einem Ton zusammengeklemmt', () => {
    /* Der Owner-Fall vom 20.08. wörtlich: SOXX/SMH/SLV/TAN/LIT/INTC alle
     * positiv — vorher klemmte Math.min alles jenseits der 4. Stufe auf
     * demselben Hellgrün fest. */
    const tage = [
      { date: '2026-08-14', equity: 10_000 },
      { date: '2026-08-19', equity: 10_600 },
    ];
    const trades = ['SOXX', 'SMH', 'SLV', 'TAN', 'LIT', 'INTC'].map((symbol, i) => ({
      symbol, side: 'sell', qty: 1, price: 100, pnl: 100 - i,
      executedAt: '2026-08-16T19:00:00.000Z',
    }));
    const d = { ...fixture(), zerlegung: zerlegeDepot(tage, trades) };
    const verlauf = shareStory(d).find((k) => k.id === 'verlauf')!;
    const chips = [...verlauf.svg.matchAll(/<rect [^>]*width="22" height="22" rx="5" fill="([^"]+)"/g)].map((m) => m[1]!);
    const gewinnerChips = chips.filter((c) => c !== '#25d0ee');
    expect(gewinnerChips.length).toBe(6);
    expect(new Set(gewinnerChips).size).toBe(6);
  });

  it('dicke Flächen tragen ihren Namen direkt im Bild', () => {
    // NVDA (+180 auf ~300er-Spanne) ist im Fixture die dickste Fläche —
    // sie muss ihr Etikett in der Fläche haben, nicht nur in der Legende.
    const verlauf = shareStory(fixture()).find((k) => k.id === 'verlauf')!;
    expect(verlauf.svg).toMatch(/text-anchor="middle">[^<]*(NVDA|Offene Positionen)/);
  });

  it('Womit zeigt je Symbol einen Balken mit Anteil an der Basis', () => {
    const womit = shareStory(fixture()).find((k) => k.id === 'womit')!;
    for (const sym of ['NVDA', 'EWJ', 'GLD']) expect(womit.svg).toContain(sym);
    expect((womit.svg.match(/<rect [^>]*rx="17"/g) ?? []).length).toBe(3);
    expect(womit.svg).toContain(' %');
  });
});
