import { describe, expect, it } from 'vitest';
import { STRATEGY_PRESETS, validateStrategySpec, type RuleNode } from '../src/index.js';

function collectTypes(node: RuleNode, into: Set<string>): void {
  into.add(node.type);
  if (node.type === 'all' || node.type === 'any') node.children.forEach((c) => collectTypes(c, into));
  if (node.type === 'not') collectTypes(node.child, into);
  if (node.type === 'weighted') node.children.forEach((c) => collectTypes(c.node, into));
}

describe('STRATEGY_PRESETS (Presets = Doku)', () => {
  it('alle 5 Presets sind gültige Specs (Guards inklusive)', () => {
    expect(STRATEGY_PRESETS).toHaveLength(5);
    for (const p of STRATEGY_PRESETS) {
      expect(validateStrategySpec(p.spec), p.id).toEqual([]);
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.description.length).toBeGreaterThan(10);
    }
  });

  it('jede handelbare Knotenart kommt in mindestens einem Preset vor', () => {
    // `sentiment` und `newsEvent` stehen bewusst NICHT auf der Liste: Seit
    // dem Ausbau der News-Strecke (28.07.) füllt kein Lauf mehr die Felder,
    // auf die sie zugreifen. Sie bleiben im Schema, damit gespeicherte
    // Strategien lesbar bleiben, und liefern in `evaluate` „unbekannt" —
    // die sichere Richtung, denn unbekannt heißt kein Trade. Ein Preset,
    // das sie ANBIETET, wäre dagegen ein Versprechen ohne Deckung.
    const seen = new Set<string>();
    for (const p of STRATEGY_PRESETS) {
      collectTypes(p.spec.buy, seen);
      collectTypes(p.spec.sell, seen);
    }
    for (const t of [
      'all', 'any', 'weighted', 'not',
      'compare', 'crossover', 'priceLevel', 'changePct', 'timeWindow',
      'forecast', 'position',
    ]) {
      expect(seen.has(t), `Knotenart '${t}' fehlt in den Presets`).toBe(true);
    }
    expect(seen.has('sentiment'), 'sentiment gehört in kein Preset mehr').toBe(false);
    expect(seen.has('newsEvent'), 'newsEvent gehört in kein Preset mehr').toBe(false);
  });

  it('IDs sind eindeutig und URL-tauglich', () => {
    const ids = STRATEGY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
