/**
 * Marktbreite — die Zahl, die ein einzelner Index nicht zeigen kann.
 *
 * Owner 18.08. Der Prüfgegenstand ist zweiteilig: die Rechnung selbst (die
 * ist einfach) und die Grenze, die diese Messung NICHT überschreiten darf.
 * Sie ist bewusst kein Tor: An `regime.state` hängen fünf Mechanismen,
 * darunter seit dem 17.08. die Trendstimme. Ein neuer Eingang in den
 * Zustand würde alle fünf gleichzeitig verstellen — und am wahrscheinlichsten
 * die Trendstimme wieder verstummen lassen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BREITE_MIN_N, breiteSatz, messeBreite } from '../src/marktbreite.js';

/** n Scores, davon `pos` positiv — der Rest negativ. */
const scores = (n: number, pos: number): number[] =>
  Array.from({ length: n }, (_, i) => (i < pos ? 5 : -5));

describe('messeBreite', () => {
  it('zählt den Anteil positiver Momentum-Scores', () => {
    const b = messeBreite(scores(100, 62));
    expect(b.n).toBe(100);
    expect(b.positiv).toBe(62);
    expect(b.anteil).toBe(0.62);
  });

  it('liefert den Median dazu — Anzahl und Deutlichkeit sind zwei Dinge', () => {
    // Beide haben 60 % positiv, aber völlig verschiedene Verteilungen.
    const knapp = messeBreite([...Array(60).fill(0.1), ...Array(40).fill(-0.1)]);
    const klar = messeBreite([...Array(60).fill(40), ...Array(40).fill(-40)]);
    expect(knapp.anteil).toBe(klar.anteil);
    expect(knapp.medianScore).toBeLessThan(klar.medianScore!);
  });

  it('schweigt bei zu dünner Datenlage statt zu raten', () => {
    // Unter der Schwelle misst der Anteil die Datenabdeckung, nicht den Markt.
    const b = messeBreite(scores(BREITE_MIN_N - 1, 20));
    expect(b.anteil).toBeNull();
    expect(b.medianScore).toBeNull();
    expect(b.n).toBe(BREITE_MIN_N - 1);
    expect(messeBreite(scores(BREITE_MIN_N, 20)).anteil).not.toBeNull();
  });

  it('wirft kaputte Scores raus, statt sie als 0 zu zählen', () => {
    // Ein NaN als „nicht positiv" zu zählen würde die Breite systematisch
    // nach unten ziehen, und zwar genau bei schlechter Datenlage.
    const b = messeBreite([...scores(40, 30), Number.NaN, Number.POSITIVE_INFINITY]);
    expect(b.n).toBe(40);
    expect(b.anteil).toBe(0.75);
  });

  it('leere Eingabe ergibt keine Aussage', () => {
    expect(messeBreite([]).anteil).toBeNull();
  });
});

describe('breiteSatz — der Spätzyklus-Fall wird benannt', () => {
  it('Index oben, Breite unten ⇒ die Bewegung trägt nur wenige', () => {
    const s = breiteSatz(messeBreite(scores(100, 30)), true);
    expect(s).toContain('30 %');
    expect(s).toContain('von wenigen getragen');
  });

  it('Index unten, Breite oben ⇒ die Schwäche steckt in Schwergewichten', () => {
    expect(breiteSatz(messeBreite(scores(100, 70)), false)).toContain('Schwergewichten');
  });

  it('gleichlaufend ⇒ nur der nüchterne Befund, keine Deutung', () => {
    const s = breiteSatz(messeBreite(scores(100, 65)), true);
    expect(s).toContain('65 %');
    expect(s).not.toContain('von wenigen getragen');
  });
});

describe('die Grenze: Messung, kein Tor', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const lies = (rel: string): string => readFileSync(join(hier, rel), 'utf8');

  it('die Breite fasst den Ampel-Zustand nicht an', () => {
    /* Der eigentliche Riegel dieses PRs. Würde `messeBreite` irgendwo in
     * `marketRegime` oder in eine Einstiegssperre einfließen, verstellte sie
     * fünf Mechanismen auf einmal — und die wahrscheinlichste Folge wäre,
     * dass „Trend" seltener wird und `trendSolo` wieder verstummt. */
    expect(lies('../src/regime.ts')).not.toContain('messeBreite');
    expect(lies('../src/regime.ts')).not.toContain('Breite');
    expect(lies('../src/marktbreite.ts')).not.toContain('regimeEntryBlocked');
  });

  it('sie wird im Momentum-Lauf nur GESCHRIEBEN, nicht abgefragt', () => {
    const lauf = lies('../../functions/src/scheduled/momentumRun.ts');
    expect(lauf).toContain('const breite = messeBreite(');
    // Kein `if (breite…)` — sonst hinge eine Entscheidung daran.
    expect(lauf).not.toMatch(/if\s*\([^)]*breite\./);
  });
});
