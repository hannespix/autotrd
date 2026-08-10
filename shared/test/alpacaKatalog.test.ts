/**
 * Der Katalog nach der Alpaca-Ausrichtung (Owner-Direktive 10.08.:
 * „nur Alpaka ist wichtig, das gesamte Tool soll sich danach ausrichten").
 *
 * ── Was hier festgenagelt wird ────────────────────────────────────────────
 *
 * Vor dem Umbau standen 165 Symbole im Katalog, von denen Alpaca 96 gar
 * nicht handeln kann — europäische Aktien, Devisen, Futures, Indizes. Sie
 * wurden trotzdem alle fünf Minuten mitversorgt: reine Kosten ohne die
 * Möglichkeit eines Trades.
 *
 * Die Regel lautet seither: Was im Katalog steht, ist orderbar — mit genau
 * einer bewussten Ausnahme, den beiden Signal-Indizes. Dieser Test hält das
 * fest, damit ein „nur dieses eine Symbol noch" die Regel nicht wieder
 * aufweicht.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, allSymbols, classify, isTradable } from '../src/index.js';

/** Die einzigen erlaubten nicht-handelbaren Einträge — und warum. */
const NUR_SIGNAL = new Set(['^GSPC', '^VIX']);

describe('Katalog = Alpaca-Universum', () => {
  it('jedes Symbol ist handelbar — außer den beiden Signal-Indizes', () => {
    const nichtHandelbar = allSymbols().filter((s) => !isTradable(s));
    expect(new Set(nichtHandelbar)).toEqual(NUR_SIGNAL);
  });

  it('führt keine europäischen oder asiatischen Einzelaktien mehr', () => {
    // Owner: „es geht mir nicht um europäische Märkte". Alpaca erreicht sie
    // ohnehin nicht — sie waren 28 Symbole Scan-Last ohne Gegenwert.
    expect(allSymbols().filter((s) => s.includes('.'))).toEqual([]);
    expect(allSymbols().some((s) => classify(s) === 'stocks_global')).toBe(false);
  });

  it('führt keine Devisen und keine Futures mehr', () => {
    expect(allSymbols().filter((s) => s.endsWith('=X') || s.endsWith('=F'))).toEqual([]);
    expect(CATALOG['forex']).toBeUndefined();
    expect(CATALOG['commodities']).toBeUndefined();
  });

  it('behält genau die zwei Indizes, die etwas STEUERN', () => {
    // ^GSPC ist der Marktfilter des Momentum-Sockels, ^VIX die Regime-Ampel.
    // Für ^VIX gibt es keinen brauchbaren handelbaren Vertreter: VIXY und
    // UVXY sind Futures-ETFs mit Rollverlust.
    const indizes = allSymbols().filter((s) => s.startsWith('^'));
    expect(new Set(indizes)).toEqual(NUR_SIGNAL);
  });

  it('ersetzt die Rohstoff-Futures durch handelbare ETF-Vertreter', () => {
    const symbole = new Set(allSymbols());
    for (const s of ['GLD', 'SLV', 'USO', 'UNG', 'DBA']) expect(symbole.has(s), s).toBe(true);
  });

  it('der handelbare Teil ist deutlich GEWACHSEN, nicht geschrumpft', () => {
    /*
     * Der Kern des Umbaus, in einer Zahl: Vorher 165 Symbole, davon 56 real
     * orderbar (69 laut `isTradable`, minus 13 Krypto, deren Schreibweise
     * Alpaca nicht kannte). Jetzt weniger Symbole insgesamt — aber mehr als
     * doppelt so viele echte Kandidaten. Der Ausbau finanziert sich aus den
     * toten Symbolen.
     */
    const alle = allSymbols();
    expect(alle.length).toBeLessThan(165);
    expect(alle.filter(isTradable).length).toBeGreaterThan(120);
  });

  it('keine doppelten Symbole — auch nicht über Klassen hinweg', () => {
    const alle = allSymbols();
    expect(new Set(alle).size).toBe(alle.length);
  });

  it('US-Aktien sind über Sektoren gestreut, nicht eine Wette in Scheiben', () => {
    // Ohne Streuung wären die Korrelations-Blöcke wirkungslos.
    const gruppen = Object.keys(CATALOG['stocks_us'] ?? {});
    expect(gruppen.length).toBeGreaterThanOrEqual(5);
  });
});
