/**
 * Die Kurve über die Haltedauer, lesbar gemacht.
 *
 * Diese Funktionen treffen eine Aussage — „so lange halten ist das Beste" —
 * und aus dieser Aussage kann eine echte Einstellungs-Änderung folgen.
 * Deshalb stehen sie im geprüften Kern und nicht in einer Render-Funktion.
 *
 * Der teuerste Fehler wäre nicht eine falsche Zahl, sondern eine Zahl, die
 * gar keine sein dürfte: ein Spitzenreiter aus drei Beobachtungen, der wie
 * eine Empfehlung aussieht.
 */
import { describe, expect, it } from 'vitest';
import {
  SCHATTEN_MIN_N,
  besteHaltedauer,
  haltedauerZeilen,
  type HorizontStand,
} from '../src/index.js';

/** Ein Horizont-Eintrag, wie ihn der Lauf ablegt. */
function stand(
  n: number,
  summePct: number,
  opts: { treffer?: number; buy?: [number, number]; sell?: [number, number] } = {},
): HorizontStand {
  const k = { n, summePct, treffer: opts.treffer ?? Math.round(n / 2), summeRohPct: summePct + n * 0.1, nRoh: n };
  const s: HorizontStand = { klasse: k };
  if (opts.buy) s.buy = { n: opts.buy[0], summePct: opts.buy[1], treffer: 0 };
  if (opts.sell) s.sell = { n: opts.sell[0], summePct: opts.sell[1], treffer: 0 };
  return s;
}

describe('haltedauerZeilen', () => {
  it('sortiert nach Haltedauer, nicht nach Schlüssel-Text', () => {
    // Firestore-Maps haben String-Schlüssel. Alphabetisch käme 10 vor 2.
    const z = haltedauerZeilen({ '10': stand(300, 3), '2': stand(300, 2), '1': stand(300, 1) });
    expect(z.map((x) => x.tage)).toEqual([1, 2, 10]);
  });

  it('rechnet die Kante je Signal, nicht die Summe', () => {
    const z = haltedauerZeilen({ '5': stand(400, 120) });
    expect(z[0]!.nettoPct).toBeCloseTo(0.3, 6);
    expect(z[0]!.n).toBe(400);
  });

  it('trennt die Richtungen — die Zahl, die Drift von Kante scheidet', () => {
    const z = haltedauerZeilen({ '5': stand(400, 120, { buy: [300, 150], sell: [100, -30] }) });
    expect(z[0]!.buyN).toBe(300);
    expect(z[0]!.buyPct).toBeCloseTo(0.5, 6);
    expect(z[0]!.sellPct).toBeCloseTo(-0.3, 6);
  });

  it('überspringt Schlüssel, die keine Haltedauer sind, statt NaN-Zeilen zu bauen', () => {
    const z = haltedauerZeilen({ '3': stand(300, 1), '1a': stand(300, 1), '0': stand(300, 1), '-2': stand(300, 1) });
    expect(z.map((x) => x.tage)).toEqual([3]);
  });

  it('kein Horizont-Feld ⇒ leere Liste, kein Absturz', () => {
    expect(haltedauerZeilen(undefined)).toEqual([]);
    expect(haltedauerZeilen({})).toEqual([]);
  });

  it('ohne Beobachtungen ist die Kante null, nicht 0', () => {
    // „nicht gemessen" und „Bewegung null" sind verschiedene Aussagen; die
    // zweite würde eine Haltedauer zu Unrecht erledigen.
    const z = haltedauerZeilen({ '1': { klasse: { n: 0, summePct: 0, treffer: 0 } } });
    expect(z[0]!.nettoPct).toBeNull();
    expect(z[0]!.trefferquote).toBeNull();
    expect(z[0]!.belastbar).toBe(false);
  });

  it('belastbar erst AB der Schwelle — die Grenze selbst zählt mit', () => {
    const knapp = haltedauerZeilen({ '1': stand(SCHATTEN_MIN_N - 1, 5) });
    const genau = haltedauerZeilen({ '1': stand(SCHATTEN_MIN_N, 5) });
    expect(knapp[0]!.belastbar).toBe(false);
    expect(genau[0]!.belastbar).toBe(true);
  });
});

describe('besteHaltedauer', () => {
  it('liefert null, solange keine Zeile belastbar ist', () => {
    // Der wichtigere Teil: Ein zufälliger Spitzenreiter aus dünnen Daten darf
    // nicht als Empfehlung durchs Dashboard laufen.
    const z = haltedauerZeilen({ '1': stand(3, 9), '5': stand(4, 12) });
    expect(besteHaltedauer(z)).toBeNull();
  });

  it('nimmt das Maximum der Netto-Kante unter den belastbaren Zeilen', () => {
    const z = haltedauerZeilen({
      '1': stand(400, 40), //  +0,10 %
      '5': stand(400, 120), // +0,30 %  ← belastbar und am höchsten
      '10': stand(3, 90), //   +30 %    aber n=3
    });
    expect(besteHaltedauer(z)!.tage).toBe(5);
  });

  it('bei Gleichstand gewinnt die KÜRZERE Haltedauer', () => {
    // Gleiche gemessene Kante, weniger gebundenes Kapital und weniger
    // Übernacht-Risiko — das ist die sparsamere Wahl, nicht die zufällig
    // erste in der Aufzählung.
    const z = haltedauerZeilen({ '2': stand(400, 80), '10': stand(400, 80) });
    expect(besteHaltedauer(z)!.tage).toBe(2);
  });

  it('eine negative Kante ist ein Ergebnis, keine Ausnahme', () => {
    // Wenn ALLE Haltedauern verlieren, muss die am wenigsten schlechte
    // sichtbar bleiben — sonst sähe die Karte aus wie „noch keine Daten",
    // obwohl die Messung eindeutig ist.
    const z = haltedauerZeilen({ '1': stand(400, -80), '5': stand(400, -20) });
    expect(besteHaltedauer(z)!.tage).toBe(5);
    expect(besteHaltedauer(z)!.nettoPct).toBeCloseTo(-0.05, 6);
  });

  it('leere Liste ⇒ null', () => {
    expect(besteHaltedauer([])).toBeNull();
  });
});
