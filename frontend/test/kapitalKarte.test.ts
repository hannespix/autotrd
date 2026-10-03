/**
 * Wächter der Kapital-Seite (Owner 22.08.: „mein Depot bitte besser
 * darstellen: cash, cashflow, aktive Positionen (wie viel)").
 *
 * Drei Eigenschaften tragen die Karte, und jede kann still brechen:
 *
 *  1. **Beträge bleiben aus, die Form nicht.** Die Karte verlässt die App.
 *     Der eigene Kontostand geht niemanden etwas an — die AUFTEILUNG schon,
 *     denn eine Quote verrät kein Vermögen. Rutscht ein Betrag durch, ist
 *     der Schalter „Beträge zeigen" wertlos.
 *  2. **Umschlag und Ergebnis haben eigene Skalen.** Realisiertes ist um
 *     Grössenordnungen kleiner als das bewegte Geld. Auf einer Achse wäre
 *     die Ergebnislinie eine Gerade auf der Null und behauptete
 *     „nichts passiert" — die Karte würde lügen, nicht schweigen.
 *  3. **Keine leere Grafik.** Ohne jede Zahl entsteht die Seite nicht.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shareStory } from '../src/shareStory.js';
import { SEITEN } from '../src/seiten.js';
import type { ShareDaten } from '../src/shareCard.js';

const quelle = readFileSync(join(import.meta.dirname, '..', 'src', 'shareStory.ts'), 'utf8');

beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
});

function basis(): ShareDaten {
  return {
    zerlegung: { tage: [], equity: [], basis: 10_000, baender: [] } as unknown as ShareDaten['zerlegung'],
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
    betraege: false,
    tradeBilanz: 0,
  };
}

const mitKapital = (betraege: boolean): ShareDaten => ({
  ...basis(),
  betraege,
  bar: 17_786.05,
  positionsWert: 1135,
  positionen: [
    { symbol: 'QQQ', short: false, einstieg: 690, aktuell: 712, pnlPct: 3.2, pnl: 110, qty: 5 },
  ],
  cashflow: [
    { tag: '2026-08-11', zu: 0, ab: 1200, realisiert: 0 },
    { tag: '2026-08-12', zu: 1400, ab: 0, realisiert: 55 },
    { tag: '2026-08-13', zu: 300, ab: 900, realisiert: -12 },
  ],
});

/* Nur die Kapital-Seite bauen: Die Ergebnis-Karte braucht eine vollständige
 * Zerlegung, die hier nichts zur Sache tut — und die Auswahl ist ohnehin der
 * Weg, auf dem die Seite im Betrieb entsteht. */
const nurKapital = (d: ShareDaten) => shareStory(d, ['kapital']);
const kapital = (d: ShareDaten): string => nurKapital(d).find((k) => k.id === 'kapital')!.svg;

describe('Kapital-Seite — Beträge bleiben aus, die Form nicht', () => {
  it('ohne Schalter steht KEIN Betrag und keine Währung auf der Karte', () => {
    const svg = kapital(mitKapital(false));
    expect(svg).not.toContain('17');
    expect(svg).not.toContain('1135');
    expect(svg).not.toContain('USD');
  });

  it('die Aufteilung steht trotzdem — sie verrät kein Vermögen', () => {
    /* 1135 / (17786,05 + 1135) = 6,0 % — dieselbe Grösse aus denselben
     * Zahlen, nur als Quote. Fehlt sie, ist die Karte ohne Schalter leer. */
    const svg = kapital(mitKapital(false));
    expect(svg).toContain('6 %');
    expect(svg).toContain('94 %');
  });

  it('mit Schalter erscheinen Barbestand und Marktwert', () => {
    const svg = kapital(mitKapital(true));
    expect(svg).toContain('17786,05 USD');
    expect(svg).toContain('1135,00 USD');
  });

  it('die Zahl der offenen Positionen ist keine Betragsangabe', () => {
    // Sie steht in BEIDEN Fällen — „wie viel" war Teil der Frage.
    expect(kapital(mitKapital(false))).toContain('>1<');
    expect(kapital(mitKapital(true))).toContain('>1<');
  });
});

describe('Kapital-Seite — Umschlag und Ergebnis sind zwei Fragen', () => {
  it('die Ergebnislinie hat ihre EIGENE Skala', () => {
    /* Sonst: 55 gegen 1400 auf einer Achse ⇒ die Linie klebt auf der Null
     * und behauptet „nichts verdient", obwohl etwas verdient wurde. */
    expect(quelle).toContain('const maxErg = Math.max(...fluss.map((f) => Math.abs(f.realisiert)), 1e-9);');
  });

  it('Zufluss nach oben, Abfluss nach unten — um dieselbe Nulllinie', () => {
    const svg = kapital(mitKapital(true));
    const rects = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" rx="3"/g)];
    expect(rects.length).toBeGreaterThanOrEqual(4);
    /* Alle Balken teilen sich EINE Kante — welche, muss der Test nicht
     * wissen: Er sucht den Wert, der unter allen Ober- und Unterkanten am
     * häufigsten vorkommt, und verlangt, dass JEDER Balken ihn berührt.
     * (Die Achse aus der Reihenfolge zu raten ging schief: Der erste
     * Balken des Fixtures ist ein Abfluss, hängt also UNTER der Achse.) */
    const kanten = rects.map((m) => [Number(m[1]), Number(m[1]) + Number(m[2])] as const);
    const haeufigkeit = new Map<number, number>();
    for (const paar of kanten) {
      for (const k of paar) haeufigkeit.set(k, (haeufigkeit.get(k) ?? 0) + 1);
    }
    const achse = [...haeufigkeit.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(haeufigkeit.get(achse)).toBe(kanten.length);
    for (const [oben, unten] of kanten) {
      expect(oben === achse || unten === achse, `${oben}/${unten} vs ${achse}`).toBe(true);
    }
  });

  it('ohne Bewegung sagt die Karte das, statt eine leere Fläche zu zeigen', () => {
    const svg = kapital({ ...mitKapital(true), cashflow: [] });
    expect(svg).toContain('Im Zeitraum wurde nichts bewegt.');
  });
});

describe('Kapital-Seite — keine leere Grafik', () => {
  it('ohne jede Zahl entsteht sie gar nicht', () => {
    expect(nurKapital(basis()).map((k) => k.id)).not.toContain('kapital');
  });

  it('ein blosser Barbestand genügt schon', () => {
    // Ein Konto, das noch nie gehandelt hat, hat trotzdem eine Kasse.
    const nurBar = { ...basis(), bar: 10_000, positionsWert: 0 };
    expect(nurKapital(nurBar).map((k) => k.id)).toContain('kapital');
  });

  it('sie ist eine Bild-Seite — im Video gibt es sie nicht', () => {
    /* Das Verzeichnis muss das tragen, sonst hakt jemand sie an und sucht
     * sie danach vergeblich im Video. */
    const eintrag = SEITEN.find((s) => s.id === 'kapital')!;
    expect(eintrag.bild).toBe(true);
    expect(eintrag.video).toBeNull();
  });
});
