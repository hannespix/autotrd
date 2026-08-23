/**
 * Eine Entscheidung, ein Eintrag in der Steckbrief-Statistik.
 *
 * Diese Regression habe ich selbst eingebaut, am selben Tag: Seit dem
 * Teilschluss (#436) verkleinert ein Teilfill des Broker-Schutz-Stops die
 * Position, statt sie zu löschen. Damit meldete DIESELBE Entscheidung zweimal
 * an `recordFilterStat` — einmal beim Teilschluss, einmal beim Schluss des
 * Restes. Vorher gab es genau eine Buchung, weil die Position verschwand.
 *
 * Warum das die Statistik verzerrt, und nicht nur ihre Größe:
 *
 *   `n` meinte ab da BUCHUNGEN statt Entscheidungen. `FILTER_MIN_SAMPLES = 30`
 *   ist aber ausdrücklich als „30 realisierte Trades" begründet — ein Filter,
 *   der auf 5 Verlierern basiert, wäre „nur Rauschen mit Meinung".
 *
 *   Und die beiden Hälften sind NICHT unabhängig. Ein Ergebnis P, in P/2 + P/2
 *   zerlegt, lässt `pnlSum` unverändert, halbiert aber `pnlSqSum` (P² → P²/2).
 *   Über `bucketTStat` sinkt damit die geschätzte Streuung, während √n steigt:
 *   Der t-Wert wächst betragsmäßig — in BEIDE Richtungen. Ein Steckbrief
 *   konnte also früher unter `FILTER_T_BLOCK = −1,5` rutschen, als die
 *   Datenlage hergibt, und Einstiege blocken, die nichts getan haben.
 *
 * Die Fehlrichtung ist die konservative (der Code nennt einen falschen Block
 * selbst den billigeren Fehler), und erreichbar ist der Fall nur über einen
 * teilweise gefüllten Broker-Schutz-Stop. Trotzdem: eingebaut, also aufgeräumt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bucketTStat, FILTER_MIN_SAMPLES, FILTER_T_BLOCK } from '@autotrd/shared';

describe('Warum Doppelzählen die Schwelle verschiebt — die Rechnung', () => {
  /** Ein Steckbrief aus n identischen Ergebnissen p. */
  const gleich = (n: number, p: number) => ({
    n,
    wins: p > 0 ? n : 0,
    pnlSum: n * p,
    pnlSqSum: n * p * p,
  });

  it('dieselbe Summe, aber zerlegt: die geschätzte Streuung schrumpft', () => {
    // 20 Entscheidungen à −100 $, jede in zwei Hälften gebucht ⇒ 40 Buchungen
    // à −50 $. Gleiche Gesamtsumme, gleiche Trefferquote.
    const ganz = gleich(20, -100);
    const zerlegt = gleich(40, -50);
    expect(zerlegt.pnlSum).toBe(ganz.pnlSum);
    // Aber die Quadratsumme halbiert sich.
    expect(zerlegt.pnlSqSum).toBeCloseTo(ganz.pnlSqSum / 2, 6);
  });

  it('n zählt Buchungen statt Entscheidungen — die Mindestzahl wird zu früh erreicht', () => {
    // 20 echte Entscheidungen reichen nicht …
    expect(20).toBeLessThan(FILTER_MIN_SAMPLES);
    // … als 40 Buchungen aber schon. Der Filter urteilte dann über eine
    // Stichprobe, die es nicht gibt.
    expect(40).toBeGreaterThanOrEqual(FILTER_MIN_SAMPLES);
  });

  it('und die Blockschwelle ist eine t-Schwelle, also von beidem abhängig', () => {
    // Beide Steckbriefe beschreiben dieselbe Wirklichkeit. Wenn der zerlegte
    // einen betragsmäßig größeren t-Wert liefert, blockt er früher.
    const tGanz = bucketTStat(gleich(20, -100));
    const tZerlegt = bucketTStat(gleich(40, -50));
    // Bei identischen Werten ist die Streuung 0 ⇒ die Funktion verweigert
    // bewusst ein Urteil. Genau das ist die Absicherung, auf die man sich
    // hier NICHT verlassen darf — echte Trades streuen.
    expect(tGanz).toBeNull();
    expect(tZerlegt).toBeNull();
    expect(FILTER_T_BLOCK).toBe(-1.5);
  });

  it('mit echter Streuung wächst der t-Wert durchs Zerlegen', () => {
    // Zwei Entscheidungen: −150 und −50. Zerlegt: viermal −75 bzw. −25.
    const ganz = { n: 2, wins: 0, pnlSum: -200, pnlSqSum: 150 ** 2 + 50 ** 2 };
    const zerlegt = { n: 4, wins: 0, pnlSum: -200, pnlSqSum: 2 * 75 ** 2 + 2 * 25 ** 2 };
    const tG = bucketTStat(ganz);
    const tZ = bucketTStat(zerlegt);
    expect(tG).not.toBeNull();
    expect(tZ).not.toBeNull();
    expect(Math.abs(tZ as number)).toBeGreaterThan(Math.abs(tG as number));
  });
});

/* ── Quelltext-Wächter ─────────────────────────────────────────────────── */
describe('Wächter: Teilschluss sammelt, voller Schluss meldet', () => {
  const broker = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

  it('ein Teilschluss meldet NICHTS an die Lernstatistik', () => {
    expect(broker).toContain(
      "if (result.executed && t?.bucket && typeof t.pnl === 'number' && t.teilSchluss !== true) {",
    );
    // Die alte, bedingungslose Fassung darf nicht zurückkommen.
    expect(broker).not.toMatch(/if \(result\.executed && t\?\.bucket && typeof t\.pnl === 'number'\) \{/);
  });

  it('gemeldet wird die SUMME über alle Tranchen, nicht die letzte', () => {
    expect(broker).toContain('await recordFilterStat(t.bucket, t.filterPnl ?? t.pnl)');
  });

  it('beide Schluss-Zweige sammeln auf teilPnl auf', () => {
    const treffer = broker.match(/tx\.update\(posRef, \{ qty: rest, teilPnl: roundCents\(teilBisher \+ pnl\) \}\)/g) ?? [];
    expect(treffer.length).toBe(2); // sell und cover
  });

  it('filterPnl steht nur am Rückgabewert, nie im Trade-Dokument', () => {
    // Es ist die Summe über alle Tranchen und gehört nicht an einen einzelnen
    // Trade, der nur seine eigene Tranche verantwortet.
    // Ohne abschließendes Komma im Muster: Der sell-Zweig steht einzeilig,
    // der cover-Zweig mehrzeilig — die Zeichensetzung dahinter unterscheidet
    // sich, die Sache nicht.
    const treffer = broker.match(/\.\.\.\(ganz \? \{ filterPnl: roundCents\(teilBisher \+ pnl\) \} : \{\}\)/g) ?? [];
    expect(treffer.length).toBe(2);
    // Kein tx.set schreibt das Feld.
    expect(broker).not.toMatch(/tx\.set\(tradeRef, \{[^}]*filterPnl/s);
  });
});
