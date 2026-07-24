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

  it('jede Knotenart kommt in mindestens einem Preset vor', () => {
    const seen = new Set<string>();
    for (const p of STRATEGY_PRESETS) {
      collectTypes(p.spec.buy, seen);
      collectTypes(p.spec.sell, seen);
    }
    for (const t of [
      'all', 'any', 'weighted', 'not',
      'compare', 'crossover', 'priceLevel', 'changePct', 'timeWindow',
      'sentiment', 'newsEvent', 'forecast', 'position',
    ]) {
      expect(seen.has(t), `Knotenart '${t}' fehlt in den Presets`).toBe(true);
    }
  });

  it('IDs sind eindeutig und URL-tauglich', () => {
    const ids = STRATEGY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
