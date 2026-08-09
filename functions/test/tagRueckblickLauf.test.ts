/**
 * Die beiden reinen Teile des Tages-Rückblick-Laufs.
 *
 * Beide sind unscheinbar und beide können still falsch rechnen: Aus einer
 * verrutschten Reihenfolge würde die geprüfte Zeitlogik in shared/ wirkungslos
 * (sie bricht zwar bei falscher Sortierung ab — aber nur, wenn sie sie sieht),
 * und eine schiefe Summe verfälscht genau die Zahl, an der die
 * Exit-Entscheidung hängt.
 */
import { describe, expect, it } from 'vitest';
import { reiheAusJahren, summiere } from '../src/scheduled/tagRueckblick.js';

describe('reiheAusJahren', () => {
  it('fügt Jahres-Chunks zu EINER aufsteigenden Reihe zusammen', () => {
    // Die Chunks kommen aus Firestore in beliebiger Reihenfolge — die
    // Sortierung muss hier passieren, nicht gehofft werden.
    const r = reiheAusJahren([
      { '2026-01-05': { close: 110 }, '2026-01-02': { close: 100 } },
      { '2025-12-30': { close: 90 } },
    ]);
    expect(r.map((t) => t.date)).toEqual(['2025-12-30', '2026-01-02', '2026-01-05']);
    expect(r.map((t) => t.close)).toEqual([90, 100, 110]);
  });

  it('wirft kaputte Kurse raus, statt sie in die Reihe zu tragen', () => {
    const r = reiheAusJahren([{
      '2026-01-02': { close: 100 },
      '2026-01-03': { close: 0 },
      '2026-01-04': {},
      '2026-01-05': { close: Number.NaN },
      '2026-01-06': { close: 105 },
    }]);
    expect(r.map((t) => t.date)).toEqual(['2026-01-02', '2026-01-06']);
  });

  it('entdoppelt überlappende Chunks — der letzte Wert gewinnt', () => {
    // Überlappungen entstehen real: momentumRun und scanMarket schreiben
    // beide `ohlcDaily`, und ein Nachzügler-Chunk kann denselben Tag noch
    // einmal bringen. Zwei Einträge für einen Tag würden die Zeitlogik in
    // shared/ mit „nicht aufsteigend sortiert" abbrechen lassen.
    const r = reiheAusJahren([
      { '2026-01-02': { close: 100 } },
      { '2026-01-02': { close: 101 }, '2026-01-03': { close: 102 } },
    ]);
    expect(r).toEqual([{ date: '2026-01-02', close: 101 }, { date: '2026-01-03', close: 102 }]);
  });

  it('leere Eingabe ergibt eine leere Reihe', () => {
    expect(reiheAusJahren([])).toEqual([]);
    expect(reiheAusJahren([{}])).toEqual([]);
  });
});

describe('summiere', () => {
  it('legt zwei Aggregate feldweise zusammen', () => {
    const a = { n: 10, summePct: 5, treffer: 6, summeRohPct: 12, nRoh: 10 };
    const b = { n: 4, summePct: -1, treffer: 1, summeRohPct: 3, nRoh: 4 };
    expect(summiere(a, b)).toEqual({ n: 14, summePct: 4, treffer: 7, summeRohPct: 15, nRoh: 14 });
  });

  it('startet aus dem Nichts', () => {
    const b = { n: 3, summePct: 1.5, treffer: 2, summeRohPct: 4.5, nRoh: 3 };
    expect(summiere(undefined, b)).toEqual(b);
  });

  it('behandelt einen Altbestand OHNE Rohsumme nicht als Null-Rohsumme im Nenner', () => {
    // Derselbe Fehler, der in classShadow bereits einmal fast passiert wäre:
    // `nRoh` hat einen EIGENEN Zähler, damit ein Aggregat aus der Zeit vor dem
    // Feld die frische Rohsumme nicht gegen null verzerrt.
    const alt = { n: 100, summePct: -5, treffer: 40 }; // kein summeRohPct, kein nRoh
    const neu = { n: 10, summePct: 1, treffer: 6, summeRohPct: 8, nRoh: 10 };
    const s = summiere(alt, neu);
    expect(s.n).toBe(110);
    expect(s.nRoh).toBe(10); // NICHT 110
    expect(s.summeRohPct).toBe(8);
  });

  it('rundet die Summen, damit Gleitkomma-Reste nicht aufwachsen', () => {
    // Über hunderte Symbole hinweg summieren sich sonst 0,1+0,2-Artefakte auf.
    const s = summiere({ n: 1, summePct: 0.1, treffer: 1 }, { n: 1, summePct: 0.2, treffer: 0 });
    expect(s.summePct).toBe(0.3);
  });

  it('ist assoziativ — die Reihenfolge der Symbole darf das Ergebnis nicht ändern', () => {
    // Der Lauf rotiert über den Katalog; welches Symbol wann drankommt, ist
    // Zufall. Wäre die Summe reihenfolgeabhängig, hinge die Kante davon ab.
    const a = { n: 3, summePct: 0.7, treffer: 2, summeRohPct: 1.1, nRoh: 3 };
    const b = { n: 5, summePct: -0.2, treffer: 1, summeRohPct: 0.9, nRoh: 5 };
    const c = { n: 2, summePct: 0.4, treffer: 2, summeRohPct: 0.6, nRoh: 2 };
    expect(summiere(summiere(a, b), c)).toEqual(summiere(summiere(a, c), b));
  });
});
