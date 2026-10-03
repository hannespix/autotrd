/**
 * Quelltext-Wächter: Short-Leihe in der Einstiegs-Hürde (Hebel 3, 15.08.).
 *
 * Ein Short leiht die Papiere und zahlt Zins über die Haltedauer — gemessen
 * ~37 $ je Nacht auf dem realen Short-Buch. Vor diesem Umbau sah das
 * Kosten-Tor diese Kosten nicht: Ein Übernacht-Short musste weniger Bewegung
 * nachweisen, als er tatsächlich kostet.
 *
 * Der Wächter pinnt den ANSCHLUSS, nicht nur die Funktion — der Serienfehler
 * dieser Woche war dreimal „Funktion korrekt, nur nicht angeschlossen". Und
 * er pinnt die Richtung: Die Leihe darf die Hürde nur ERHÖHEN und nur für
 * EINSTIEGE gelten. Exits durchlaufen entrySperre nie; ein Zuschlag dort
 * würde offene Positionen einsperren.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

describe('Short-Zins in der Einstiegs-Hürde', () => {
  it('die Leihe wird mit der echten Marge-Rate und der Klassen-Session gerechnet', () => {
    // Seit Hebel 1c mit der WIRKSAMEN Mindesthalte (minHalte = User-Wert,
    // auf den Klassen-Boden angehoben) — ein Krypto-Short zahlt seine
    // Leihe über die Haltedauer, die die Engine tatsächlich erzwingt.
    expect(scan).toMatch(
      /shortFinanzierungPct\(\s*minHalte,\s*sessionMinutesForClass\(klasse\),\s*DEFAULT_MARGIN_RATE,\s*\)/,
    );
  });

  it('kostenShort trägt die Leihe als Zusatzkosten — und nur bei Zins > 0', () => {
    const stelle = scan.indexOf('const kostenShort =');
    expect(stelle, 'kostenShort-Rechnung fehlt').toBeGreaterThan(0);
    const block = scan.slice(stelle, stelle + 600);
    expect(block).toContain('shortZins > 0');
    expect(block).toContain('extraCostPct: shortZins');
    // Intraday-Short (Zins 0): exakt dasselbe Objekt wie `kosten` —
    // die Hürde wird durch diesen Umbau nirgends GESENKT.
    expect(block).toContain(': kosten;');
    // Die Kanten-Logik (captureGate) gilt in der Short-Fassung identisch.
    expect(block).toContain('captureGate !== false');
  });

  it('die Entscheidung ist seitenscharf ANGESCHLOSSEN, nicht nur gerechnet', () => {
    const treffer =
      scan.match(
        /return \(side === 'short' \? kostenShort : kosten\)\.ok \? null : 'unter_kosten';/g,
      ) ?? [];
    expect(treffer, 'seitenscharfe Rückgabezeile fehlt oder ist dupliziert').toHaveLength(1);
    // Die alte seitenblinde Fassung ist restlos verschwunden.
    expect(scan).not.toContain("return kosten.ok ? null : 'unter_kosten';");
  });

  it('Zusatz-Blocks der Leihe werden getrennt gezählt (Messbarkeit)', () => {
    // Ohne eigenen Zähler wäre die Wirkung der Leihe von der Basis-Hürde
    // ununterscheidbar — und ein Hebel, dessen Wirkung man nicht messen
    // kann, lässt sich weder verteidigen noch zurückbauen.
    expect(scan).toContain(
      "if (side === 'short' && kosten.ok && !kostenShort.ok) gate.short_zins_blockt += 1;",
    );
    expect(scan).toContain('short_zins_blockt: number;');
    const inits = scan.match(/short_zins_blockt: 0,/g) ?? [];
    expect(inits.length, 'beide Initialisierer brauchen das Feld').toBeGreaterThanOrEqual(2);
  });

  it('die Leihe wirkt NUR im Einstieg — kostenShort existiert nur innerhalb von entrySperre', () => {
    const start = scan.indexOf('const entrySperre = (');
    const ende = scan.indexOf('const kostenVielfaches');
    expect(start).toBeGreaterThan(0);
    expect(ende).toBeGreaterThan(start);
    const stellen = [...scan.matchAll(/kostenShort/g)].map((m) => m.index);
    expect(stellen.length).toBeGreaterThanOrEqual(3);
    for (const i of stellen) {
      expect(i, 'kostenShort außerhalb von entrySperre — Exit-Pfad in Gefahr').toBeGreaterThan(
        start,
      );
      expect(i, 'kostenShort außerhalb von entrySperre — Exit-Pfad in Gefahr').toBeLessThan(ende);
    }
  });
});
