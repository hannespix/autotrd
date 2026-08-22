/**
 * Die Diagramm-Bausteine.
 *
 * Ein falsch gezeichnetes Diagramm wirft keinen Fehler — es zeigt eine
 * plausible, falsche Aussage. Die Tests halten deshalb genau die Stellen
 * fest, an denen ein Diagramm lügen könnte: eine Nulllinie am unteren Rand
 * statt in der Mitte, ein Vollkreis-Donut, der unsichtbar wird, oder ein
 * ungeschützter Symbolname, der das Markup zerlegt.
 */

import { describe, expect, it } from 'vitest';
import {
  areaLine,
  barChart,
  donut,
  hBarChart,
  histogram,
  kurz,
  leerBild,
  pnlColor,
} from '../src/svgcharts.js';

describe('pnlColor', () => {
  it('trennt Gewinn, Verlust und exakte Null', () => {
    expect(pnlColor(1)).toBe('var(--gn)');
    expect(pnlColor(-1)).toBe('var(--rd)');
    // Ein Nullergebnis grün zu färben wäre eine Schönfärbung: Nach Gebühren
    // ist „plus/minus null" kein Gewinn.
    expect(pnlColor(0)).toBe('var(--t3)');
  });
});

describe('kurz', () => {
  it('kürzt große Zahlen mit deutschem Dezimalkomma', () => {
    expect(kurz(1500)).toBe('1,5k');
    expect(kurz(2_400_000)).toBe('2,4M');
  });

  it('behält bei kleinen Beträgen zwei Nachkommastellen', () => {
    expect(kurz(3.5)).toBe('3,50');
    /* Die Null bleibt eine Null — auf einer Achse mit „200" und „400"
     * daneben sah „0,00" aus wie ein anderer Zahlentyp (Regie 22.08.). */
    expect(kurz(0)).toBe('0');
    expect(kurz(-0)).toBe('0');
    // Kleine Beträge behalten ihre Nachkommastellen, sie unterscheiden dort.
    expect(kurz(0.25)).toBe('0,25');
  });

  it('kürzt negative Werte mit Vorzeichen', () => {
    expect(kurz(-1500)).toBe('-1,5k');
  });
});

describe('donut', () => {
  it('zeichnet je Scheibe einen Pfad und eine Legendenzeile', () => {
    const svg = donut([
      { label: 'Stop-Loss', value: -50 },
      { label: 'Take-Profit', value: 30 },
    ]);
    expect(svg.match(/<path /g)?.length).toBe(2);
    expect(svg).toContain('Stop-Loss');
    expect(svg).toContain('Take-Profit');
  });

  it('überlebt einen einzigen Wert (Vollkreis)', () => {
    // Ein Bogen von 0 bis 2π hat identischen Start- und Endpunkt — ohne
    // Sonderfall zeichnet der Browser NICHTS und der Donut bleibt leer.
    const svg = donut([{ label: 'Signal', value: 100 }]);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('svgc-empty');
  });

  it('mischt Vorzeichen ohne negative Winkel', () => {
    // Geplottet wird der BETRAG — ein Kuchen aus gemischten Vorzeichen
    // hätte sonst negative Winkel.
    const svg = donut([{ label: 'A', value: -10 }, { label: 'B', value: 20 }]);
    expect(svg).not.toMatch(/A -?\d+ -?\d+ 0 -1/); // kein negatives Flag
  });

  it('färbt Scheiben nach KATEGORIE, nicht nach Vorzeichen', () => {
    // Der Befund aus dem Sichttest: Sind alle Ausstiegsgründe im Minus,
    // wäre der Donut ein einfarbig roter Ring — man sähe nicht mehr, WELCHER
    // Grund überwiegt, und das ist die einzige Frage, für die man ihn hat.
    const svg = donut([
      { label: 'Signal', value: -400 },
      { label: 'Stop', value: -270 },
      { label: 'Trailing', value: -250 },
    ]);
    const farben = new Set([...svg.matchAll(/<path d="[^"]*" fill="(var\(--[\w-]+\))"/g)].map((m) => m[1]));
    expect(farben.size, 'drei Kategorien brauchen drei Farben').toBe(3);
  });

  it('das Vorzeichen steht trotzdem in der Legende', () => {
    const svg = donut([{ label: 'Stop', value: -270 }, { label: 'Take', value: 90 }]);
    expect(svg).toContain('c-rd');
    expect(svg).toContain('c-gn');
  });

  it('kategorisch:false schaltet auf Gewinn/Verlust-Farben zurück', () => {
    const svg = donut([{ label: 'A', value: -10 }], { kategorisch: false });
    expect(svg).toContain('var(--rd)');
  });

  it('leere oder reine Null-Daten ⇒ Platzhalter statt leerem Kasten', () => {
    expect(donut([])).toContain('svgc-empty');
    expect(donut([{ label: 'x', value: 0 }])).toContain('svgc-empty');
  });

  it('escapet Symbolnamen', () => {
    const svg = donut([{ label: '<script>x</script>', value: 5 }]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('barChart', () => {
  it('legt die Nulllinie in die MITTE, nicht an den unteren Rand', () => {
    // Der klassischste Diagrammfehler: Mit Basis am Minimum sieht ein
    // Verlust wie ein kleiner Gewinn aus.
    const svg = barChart([{ label: 'Mo', value: -10 }, { label: 'Di', value: 10 }], {
      height: 120,
    });
    // nutz = 120 − padB 20 − padT 4 = 96 ⇒ Nulllinie bei 4 + 48.
    expect(svg).toMatch(/<line x1="0" y1="52"/);
  });

  it('gibt auch einem Winzwert eine sichtbare Höhe', () => {
    // Ein Balken mit Höhe 0 verschwindet — dann sähe „ein Trade mit +0,01"
    // aus wie „gar kein Trade".
    const svg = barChart([{ label: 'A', value: 100 }, { label: 'B', value: 0.001 }]);
    expect(svg).not.toContain('height="0"');
  });

  it('dünnt die Beschriftung aus, statt sie zu überlappen', () => {
    const punkte = Array.from({ length: 24 }, (_, i) => ({ label: String(i), value: i }));
    const svg = barChart(punkte, { labelJede: 3 });
    expect(svg.match(/<text /g)?.length).toBe(8);
  });

  it('leere Eingabe ⇒ Platzhalter', () => {
    expect(barChart([])).toContain('svgc-empty');
  });
});

describe('hBarChart', () => {
  it('zeichnet je Zeile Beschriftung, Balken und Wert', () => {
    const svg = hBarChart([{ label: 'AAPL', value: 42 }]);
    expect(svg).toContain('AAPL');
    expect(svg).toContain('<rect');
    expect(svg).toContain('42');
  });

  it('zieht negative Balken nach links — aber NIE aus dem Bild heraus', () => {
    // Der Bug, den dieser Test gefunden hat: Die erste Fassung maß die
    // Balkenlänge am Platz RECHTS der Nulllinie, ließ negative Balken aber
    // nach links laufen. Der größte Verlust bekam ein x im Minus und wurde
    // abgeschnitten — ausgerechnet die Zeile, auf die es ankommt.
    const svg = hBarChart([{ label: 'TSLA', value: -80 }, { label: 'AAPL', value: 5 }], {
      width: 300,
    });
    const xs = [...svg.matchAll(/<rect x="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(2);
    for (const x of xs) expect(x, 'kein Balken darf links aus dem viewBox laufen').toBeGreaterThanOrEqual(0);
  });

  it('skaliert den größten Balken auf die halbe Feldbreite', () => {
    const svg = hBarChart([{ label: 'A', value: -100 }], { width: 300 });
    const breite = Number(/<rect [^>]*width="([\d.]+)"/.exec(svg)![1]);
    // Feld = 300 − 84 (Label) − 56 (Wert) = 160 ⇒ halbe Breite 80
    expect(breite).toBeCloseTo(80, 0);
  });
});

describe('areaLine', () => {
  it('braucht mindestens zwei Punkte und sagt das auch', () => {
    expect(areaLine([100])).toContain('Mindestens zwei');
  });

  it('färbt nach dem Ergebnis gegenüber dem START, nicht dem Vorpunkt', () => {
    // Eine Kurve, die zwischendurch abtaucht und über Start endet, ist ein
    // Gewinn — die Farbe muss das zeigen.
    expect(areaLine([100, 50, 120])).toContain('var(--gn)');
    expect(areaLine([100, 150, 80])).toContain('var(--rd)');
  });

  it('legt die gestrichelte Linie auf den Startwert', () => {
    const svg = areaLine([100, 120, 140]);
    expect(svg).toContain('stroke-dasharray="3 3"');
  });
});

describe('histogram', () => {
  it('färbt Fächer nach ihrer Mitte — links rot, rechts grün', () => {
    const svg = histogram([
      { from: -10, to: -5, n: 3 },
      { from: -5, to: 0, n: 1 },
      { from: 0, to: 5, n: 4 },
    ]);
    expect(svg).toContain('var(--rd)');
    expect(svg).toContain('var(--gn)');
  });

  it('beschriftet beide Seiten, damit die Richtung eindeutig ist', () => {
    const svg = histogram([{ from: -1, to: 0, n: 1 }, { from: 0, to: 1, n: 1 }]);
    expect(svg).toContain('Verlust');
    expect(svg).toContain('Gewinn');
  });

  it('leere Fächer ⇒ Platzhalter', () => {
    expect(histogram([])).toContain('svgc-empty');
  });
});

describe('leerBild', () => {
  it('escapet auch den Platzhaltertext', () => {
    expect(leerBild('<b>x</b>')).not.toContain('<b>');
  });
});
