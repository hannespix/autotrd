/**
 * Die Zeichnung des zerlegten Depot-Verlaufs.
 *
 * Der eine Test, der hier zählt, ist der über die Treppe: Die Equity-Linie MUSS
 * auf der Kante des letzten Bandes liegen. Genau das ist die Aussage der
 * Grafik — „diese Flächen ergeben zusammen dein Depot" —, und sie wäre eine
 * Lüge, sobald Linie und Treppe auseinanderlaufen. Rechnerisch ist die
 * Identität in shared geprüft; hier wird geprüft, dass sie die Zeichnung auch
 * erreicht. Beim ersten Entwurf tat sie das nicht.
 */
import { describe, expect, it } from 'vitest';
import { type DepotTag, type HistoryTrade, zerlegeDepot } from '@autotrd/shared';
import { datumsMarken, depotChart, depotTooltip, tagKurz } from '../src/depotChart.js';

const SERIE: DepotTag[] = [
  { date: '2026-08-03', equity: 10_000 },
  { date: '2026-08-04', equity: 10_050 },
  { date: '2026-08-05', equity: 9_980 },
  { date: '2026-08-06', equity: 10_120 },
  { date: '2026-08-07', equity: 10_300 },
];
const trade = (symbol: string, date: string, pnl: number): HistoryTrade => ({
  symbol,
  side: 'sell',
  qty: 1,
  price: 100,
  executedAt: `${date}T20:00:00.000Z`,
  pnl,
});
const TRADES = [
  trade('AAPL', '2026-08-04', 40),
  trade('MSFT', '2026-08-05', -90),
  trade('AAPL', '2026-08-06', 120),
  trade('NVDA', '2026-08-07', 25),
];

const z = zerlegeDepot(SERIE, TRADES);
const { svg, legende } = depotChart(z);

/** Alle `points`-Listen eines Elementtyps als Zahlenpaare. */
function punkte(markup: string, klasse: string): Array<Array<[number, number]>> {
  const treffer = [...markup.matchAll(new RegExp(`class="${klasse}"[^>]*points="([^"]+)"`, 'g'))];
  return treffer.map((m) =>
    m[1]!
      .trim()
      .split(/\s+/)
      .map((p) => {
        const [x, y] = p.split(',').map(Number);
        return [x!, y!] as [number, number];
      }),
  );
}

describe('depotChart — Aufbau', () => {
  it('zeichnet je Band eine Fläche plus den offenen Anteil', () => {
    expect([...svg.matchAll(/class="dc-band"/g)]).toHaveLength(z.baender.length + 1);
  });

  it('hat Bezugslinie, Equity-Linie und ein Fadenkreuz', () => {
    expect(svg).toContain('class="dc-basis"');
    expect(svg).toContain('class="dc-eq"');
    expect(svg).toContain('class="dc-cross"');
  });

  it('legt je Tag eine Treffer-Fläche für den Tooltip an', () => {
    expect([...svg.matchAll(/class="dc-hit"/g)]).toHaveLength(z.tage.length);
  });

  it('nennt in der Legende jedes Band mit Betrag und Trade-Zahl', () => {
    expect(legende).toContain('AAPL');
    expect(legende).toContain('+160,00');
    expect(legende).toContain('2 Trades');
    expect(legende).toContain('Offene Positionen');
  });

  it('zu wenige Tage ⇒ Hinweis statt einer Linie aus zwei Punkten', () => {
    const kurz = depotChart(zerlegeDepot([SERIE[0]!], TRADES));
    expect(kurz.svg).toBe('');
    expect(kurz.legende).toContain('zu wenige');
  });

  it('escaped Symbolnamen — ein Katalog-Eintrag darf das Markup nicht zerlegen', () => {
    const boes = depotChart(
      zerlegeDepot(SERIE, [{ ...trade('A<b>X', '2026-08-04', 10) }], { modus: 'symbol' }),
    );
    expect(boes.legende).not.toContain('<b>X');
    expect(boes.legende).toContain('&lt;b&gt;');
  });
});

describe('depotChart — die Linie liegt auf dem Ende der Treppe', () => {
  it('jeder Equity-Punkt trifft die Kante des LETZTEN Bandes', () => {
    /*
     * Die grafische Fassung der Summen-Identität. Die Equity-Linie wird aus
     * `z.equity` gezeichnet, die Treppe aus den Bändern — zwei Wege durch
     * dieselbe Rechnung. Treffen sie sich nicht, ist entweder die Zerlegung
     * falsch oder die Skala; beides wäre im Bild ein sichtbarer Spalt.
     *
     * Dieser Test hat den ersten Entwurf gekippt: Der stapelte Gewinne nach
     * oben und Verluste nach unten, und die Equity-Linie lag dann WEDER oben
     * NOCH unten. Erst der Wasserfall macht die Aussage nachprüfbar.
     */
    const eq = punkte(svg, 'dc-eq')[0]!;
    const baender = punkte(svg, 'dc-band');
    const letztes = baender[baender.length - 1]!;
    const n = z.tage.length;
    expect(eq).toHaveLength(n);

    for (let i = 0; i < n; i++) {
      const oben = letztes[i]![1];
      const unten = letztes[2 * n - 1 - i]![1];
      const yEq = eq[i]![1];
      const trifft = Math.abs(yEq - oben) < 0.02 || Math.abs(yEq - unten) < 0.02;
      expect(trifft, `Tag ${z.tage[i]}: Linie ${yEq}, letztes Band ${unten}…${oben}`).toBe(true);
    }
  });
});

describe('Achsen', () => {
  it('setzt höchstens vier Marken, aber immer die erste und die letzte', () => {
    const m = datumsMarken(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(m[0]).toBe(0);
    expect(m[m.length - 1]).toBe(9);
    expect(m.length).toBeLessThanOrEqual(4);
  });

  it('kurze Serien bekommen jede Marke', () => {
    expect(datumsMarken(['a', 'b', 'c'])).toEqual([0, 1, 2]);
  });

  it('kürzt das Datum auf Tag und Monat — sonst passt die Achse nicht auf 390 px', () => {
    expect(tagKurz('2026-08-07')).toBe('07.08.');
  });
});

describe('depotTooltip', () => {
  it('nennt Datum, Equity und die Bewegung seit Fensterbeginn', () => {
    const t = depotTooltip(z, 4);
    expect(t).toContain('2026-08-07');
    expect(t).toContain('10300,00');
    expect(t).toContain('+300,00');
  });

  it('lässt Bänder weg, die an diesem Tag noch bei null stehen', () => {
    // Am ersten Tag ist noch nichts passiert — eine Liste aus lauter Nullen
    // wäre auf dem Telefon höher als der Chart.
    expect(depotTooltip(z, 0)).not.toContain('AAPL');
  });

  it('zeigt ab dem Beitragstag das Symbol mit seinem Stand', () => {
    expect(depotTooltip(z, 1)).toContain('AAPL');
    expect(depotTooltip(z, 1)).toContain('+40,00');
  });

  it('ein Index außerhalb der Serie ergibt leeren Text, keinen Absturz', () => {
    expect(depotTooltip(z, 99)).toBe('');
    expect(depotTooltip(z, -1)).toBe('');
  });
});
