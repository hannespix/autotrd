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

/* ── Depot-Karte (Owner 21.08., 21:14: „aktives Depot zum Teilen") ─────── */

function mitPositionen(betraege = false): ShareDaten {
  return {
    ...fixture(),
    betraege,
    investiertPct: 62.5,
    positionen: [
      { symbol: 'QQQ', short: false, einstieg: 690, aktuell: 712.88, pnlPct: 3.32, pnl: 114.4, qty: 5 },
      { symbol: 'SPY', short: true, einstieg: 630, aktuell: 640.96, pnlPct: -1.74, pnl: -32.88, qty: 3 },
      { symbol: 'TSLA', short: false, einstieg: 350, aktuell: null, pnlPct: null, pnl: null, qty: 2 },
    ],
  };
}

describe('Depot-Karte — was halte ich GERADE', () => {
  it('offene Positionen ⇒ die Karte steht direkt hinter dem Ergebnis', () => {
    expect(shareStory(mitPositionen()).map((k) => k.id)).toEqual([
      'ergebnis', 'depot', 'verlauf', 'womit', 'cta',
    ]);
  });

  it('ohne offene Position entfällt sie ersatzlos — keine leere Grafik', () => {
    expect(shareStory({ ...fixture(), positionen: [] }).map((k) => k.id)).not.toContain('depot');
    expect(shareStory(fixture()).map((k) => k.id)).not.toContain('depot');
  });

  it('Richtung steht dran: Wort UND Pfeil, Short zusätzlich gestrichelt', () => {
    const svg = shareStory(mitPositionen()).find((k) => k.id === 'depot')!.svg;
    expect(texte(svg)).toContain('▲ Long');
    expect(texte(svg)).toContain('▼ Short');
    // Nicht nur Farbe (Barrierefreiheit): der Short-Rahmen ist gestrichelt.
    expect(svg).toContain('stroke-dasharray="5 4"');
  });

  it('ohne Kurs ein neutrales „—" — nie eine grüne Null', () => {
    const svg = shareStory(mitPositionen()).find((k) => k.id === 'depot')!.svg;
    expect(texte(svg)).toContain('—');
    expect(svg).not.toContain('+0,0 %');
    // Die kurslose Zeile steht hinten: sie behauptet nichts.
    const symbole = texte(svg).filter((x) => ['QQQ', 'SPY', 'TSLA'].includes(x));
    expect(symbole).toEqual(['QQQ', 'SPY', 'TSLA']);
  });

  it('Stückzahlen und Beträge sind BETRÄGE — nur mit Schalter', () => {
    const ohne = shareStory(mitPositionen(false)).find((k) => k.id === 'depot')!.svg;
    expect(ohne).toContain('690.00 → 712.88');
    expect(ohne).not.toContain('5 × 690.00');
    expect(texte(ohne).join(' ')).not.toContain('114.40');

    const mit = shareStory(mitPositionen(true)).find((k) => k.id === 'depot')!.svg;
    expect(mit).toContain('5 × 690.00 → 712.88');
    expect(texte(mit).join(' ')).toContain('USD');
  });

  it('Kopfzeile nennt Anzahl und Investitionsquote (die Frage „arbeitet das Geld?")', () => {
    const svg = shareStory(mitPositionen()).find((k) => k.id === 'depot')!.svg;
    expect(texte(svg).join(' ')).toContain('3 offene Positionen · 63 % investiert');
  });

  it('viele Positionen: höchstens sieben Zeilen, der Rest wird BENANNT statt still gekappt', () => {
    const viele = Array.from({ length: 10 }, (_, i) => ({
      symbol: `SYM${i}`, short: false, einstieg: 100, aktuell: 101 + i,
      pnlPct: 1 + i, pnl: 10, qty: 1,
    }));
    const svg = shareStory({ ...fixture(), positionen: viele }).find((k) => k.id === 'depot')!.svg;
    const gezeigt = texte(svg).filter((x) => x.startsWith('SYM'));
    expect(gezeigt.length).toBe(7);
    expect(texte(svg).join(' ')).toContain('+3 weitere');
    // Größter Gewinner zuerst — die Karte hat eine Ordnung.
    expect(gezeigt[0]).toBe('SYM9');
  });
});

describe('Depot-Karte — Geometrie, die kein Text-Prüfstand sieht', () => {
  it('Richtungs-Marke steht in fester Spalte — nie mitten im Symbolnamen', () => {
    /* Bild-Befund 21.08.: Aus der Zeichenzahl geschätzte Textbreiten lagen
     * bei „BTC-USD"/„MSFT" daneben, das Tag lief durch den Namen. Der
     * Bild-Prüfstand misst nur Text gegen Text — diese Klasse Fehler muss
     * die Geometrie selbst ausschließen. */
    const svg = shareStory(mitPositionen()).find((k) => k.id === 'depot')!.svg;
    const tagX = [...svg.matchAll(/<rect x="(\d+)" y="\d+" width="\d+" height="40" rx="20"/g)]
      .map((m) => Number(m[1]));
    expect(tagX.length).toBeGreaterThanOrEqual(3);
    for (const x of tagX) expect(x).toBe(340);
  });

  it('kein Balken läuft in die Prozent-Spalte — auch nicht bei −100 %', () => {
    const extrem = {
      ...fixture(),
      positionen: [
        { symbol: 'PLTR', short: false, einstieg: 100, aktuell: 0.01, pnlPct: -99.99, pnl: -999, qty: 1 },
        { symbol: 'GME', short: false, einstieg: 10, aktuell: 30, pnlPct: 200, pnl: 2000, qty: 1 },
      ],
    };
    const svg = shareStory(extrem).find((k) => k.id === 'depot')!.svg;
    // Rechtes Balkenende = x + width; die Prozentzahl beginnt frühestens 935.
    const enden = [...svg.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)" height="32"/g)]
      .map((m) => Number(m[1]) + Number(m[2]));
    expect(enden.length).toBe(2);
    for (const e of enden) expect(e).toBeLessThan(935);
  });
});
