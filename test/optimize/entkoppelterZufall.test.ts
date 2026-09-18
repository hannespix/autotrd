import { describe, expect, it } from 'vitest';
import type { ParamSpec, Params, Strategy } from '../../src/core/types.ts';
import { walkForward } from '../../src/optimize/walkForward.ts';
import { NOISE_PROFILE, SPACE_AB, dailyBars, fakeStrategy, makeFakeSimulate, simConfigOf, testConfig, type SimCall } from './fakes.ts';

/**
 * Prüfbefund K2 (18.09.2026, `pruefungen/2026-09-18-red-team-erster-champion.md`):
 * Ein Generator für den ganzen Lauf, und `sampleParams` zieht, bis die
 * Stichprobe voll ist — die Seeds zählen mit. Wie viele Zufallszüge eine
 * Strategie verbraucht (Fold-Bester = Defaults oder nicht, Kollisionen),
 * bestimmte deshalb die Kandidaten der NÄCHSTEN Strategie: In Lauf #18 waren
 * alle 2 850 csm-Kandidaten andere Gitterpunkte als in #17, weil
 * `mean_reversion` in einem Fold zufällig seine Defaults gewählt hatte.
 *
 * Verlangt: Welche Gitterpunkte eine Strategie sieht, hängt nur von Seed,
 * Strategie und Fenster ab — nie davon, was davor lief. Vor dem Fix (ein
 * Generator je Lauf als `rng`-Argument von walkForward) waren alle drei
 * Fälle rot.
 */

const bars = dailyBars(400);
const cfg = testConfig();
// Gitter 11·5·10 = 550 > samples (60) ⇒ echte Stichprobe, kein erschöpfendes Gitter
const RAUM: ParamSpec[] = [...SPACE_AB, { name: 'c', min: 0, max: 9, step: 1, kind: 'int', doc: 'Füllachse' }];
const DEFAULTS: Params = { a: 5, b: 2, c: 0 };

function strategie(id: string): Strategy {
  return fakeStrategy(id, { space: RAUM, defaults: DEFAULTS });
}

/** Alle Kandidaten der Strategie `id` in Aufrufreihenfolge, je Fenster gruppiert. */
function kandidaten(calls: SimCall[], id: string): string[] {
  return calls.filter((c) => c.strategyId === id).map((c) => `${c.range?.start ?? 'x'}|${c.params.a}/${c.params.b}/${c.params.c}`);
}

function lauf(reihenfolge: Strategy[], include: Record<string, Params[]> = {}) {
  const simulate = makeFakeSimulate(NOISE_PROFILE);
  for (const strategy of reihenfolge) {
    walkForward({ symbol: 'AAA', strategy, bars, config: simConfigOf(cfg), optimizer: cfg.optimizer, initialEquity: 10_000, simulate, include: include[strategy.id] ?? [] });
  }
  return simulate.calls;
}

describe('Entkoppelter Zufall: die Kandidaten einer Strategie hängen nicht davon ab, was vorher lief', () => {
  const ziel = strategie('ziel');
  const andere = strategie('andere');

  it('dieselbe Strategie sieht allein und nach einer anderen Strategie dieselben Gitterpunkte', () => {
    const allein = kandidaten(lauf([ziel]), 'ziel');
    const danach = kandidaten(lauf([andere, ziel]), 'ziel');
    expect(allein.length).toBeGreaterThan(0);
    expect(danach).toEqual(allein);
  });

  it('ein zusätzlicher Seed in der anderen Strategie (weniger Zufallszüge dort) verschiebt die eigenen Kandidaten nicht', () => {
    const ohne = kandidaten(lauf([andere, ziel]), 'ziel');
    // `include` geht nur in die finale Suche der anderen Strategie — ein Seed mehr, ein Zufallszug weniger.
    const mit = kandidaten(lauf([andere, ziel], { andere: [{ a: 7, b: 1, c: 3 }] }), 'ziel');
    expect(mit).toEqual(ohne);
  });

  it('die Reihenfolge der Strategien im Lauf ändert die Fold-Parameter keiner Strategie', () => {
    const vorwaerts = lauf([ziel, andere]);
    const rueckwaerts = lauf([andere, ziel]);
    for (const id of ['ziel', 'andere']) expect(kandidaten(rueckwaerts, id), id).toEqual(kandidaten(vorwaerts, id));
  });
});
