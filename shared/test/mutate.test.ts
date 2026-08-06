import { describe, expect, it } from 'vitest';
import {
  BLATT_KATALOG,
  DEFAULT_STRATEGY,
  MAX_NODES,
  MUTATIONS_OPS,
  STRATEGY_PRESETS,
  countRuleNodes,
  mutiereSpec,
  mutiereSpecMitOp,
  ruleTreeDepth,
  startPopulation,
  validateStrategySpec,
  type RuleNode,
  type StrategySpec,
} from '../src/index.js';

/** Voller buy-Baum: any-Wurzel mit MAX_NODES−1 Blättern ⇒ exakt MAX_NODES. */
function vollerBaum(): RuleNode {
  return {
    type: 'any',
    children: Array.from({ length: MAX_NODES - 1 }, (_, i) => ({
      type: 'compare',
      left: 'rsi',
      op: 'lt',
      right: 10 + i,
    })),
  };
}

const einfach: StrategySpec = STRATEGY_PRESETS[0]!.spec;

describe('mutiereSpec — Grundeigenschaften', () => {
  it('ist deterministisch: gleicher Seed ⇒ identisches Ergebnis', () => {
    const a = mutiereSpec(einfach, 42);
    const b = mutiereSpec(einfach, 42);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it('verschiedene Seeds erzeugen verschiedene Mutationen', () => {
    const texte = new Set(
      Array.from({ length: 12 }, (_, i) => mutiereSpec(einfach, i + 1)?.beschreibung ?? 'null'),
    );
    expect(texte.size).toBeGreaterThan(3);
  });

  it('lässt die Eingabe-Spec unangetastet (pure)', () => {
    const vorher = JSON.stringify(einfach);
    for (let s = 1; s <= 20; s++) mutiereSpec(einfach, s);
    expect(JSON.stringify(einfach)).toBe(vorher);
  });

  it('jede angenommene Mutation besteht Schema + Guards (200 Seeds × 6 Start-Specs)', () => {
    const population = startPopulation(DEFAULT_STRATEGY);
    let angenommen = 0;
    for (const spec of population) {
      for (let seed = 1; seed <= 200; seed++) {
        const m = mutiereSpec(spec, seed);
        if (m === null) continue;
        angenommen++;
        expect(validateStrategySpec(m.spec)).toEqual([]);
        expect(countRuleNodes(m.spec.buy)).toBeLessThanOrEqual(MAX_NODES);
        expect(countRuleNodes(m.spec.sell)).toBeLessThanOrEqual(MAX_NODES);
        expect(ruleTreeDepth(m.spec.buy)).toBeLessThanOrEqual(5);
        expect(m.beschreibung).toMatch(/^(buy|sell): .+/);
      }
    }
    // Die Suche darf nicht praktisch leerlaufen.
    expect(angenommen).toBeGreaterThan(500);
  });

  it('jede angenommene Mutation verändert die Spec tatsächlich (kein No-op)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const m = mutiereSpec(einfach, seed);
      if (m === null) continue;
      expect(JSON.stringify(m.spec)).not.toBe(JSON.stringify(einfach));
    }
  });
});

describe('Knoten-Deckel (MILESTONES-MO-Abnahme)', () => {
  it('eine Mutation, die den Deckel reißen würde, wird VERWORFEN', () => {
    const voll: StrategySpec = { buy: vollerBaum(), sell: vollerBaum() };
    expect(validateStrategySpec(voll)).toEqual([]); // exakt am Deckel = gültig
    for (let seed = 1; seed <= 40; seed++) {
      expect(mutiereSpecMitOp(voll, 'ergaenzen', seed)).toBeNull();
    }
  });

  it('am vollen Baum bleiben andere Operatoren möglich (streichen/kippen)', () => {
    const voll: StrategySpec = { buy: vollerBaum(), sell: vollerBaum() };
    const ops = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const m = mutiereSpec(voll, seed);
      if (m !== null) {
        ops.add(m.op);
        expect(validateStrategySpec(m.spec)).toEqual([]);
      }
    }
    expect(ops.has('streichen') || ops.has('kippen') || ops.has('parameter')).toBe(true);
    expect(ops.has('ergaenzen')).toBe(false);
  });
});

describe('Operatoren im Einzelnen', () => {
  it('streichen respektiert das Schema-Minimum (1 Kind bleibt)', () => {
    const mini: StrategySpec = {
      buy: { type: 'all', children: [{ type: 'compare', left: 'rsi', op: 'lt', right: 30 }] },
      sell: { type: 'all', children: [{ type: 'compare', left: 'rsi', op: 'gt', right: 70 }] },
    };
    for (let seed = 1; seed <= 30; seed++) {
      const m = mutiereSpecMitOp(mini, 'streichen', seed);
      // Bei nur einem Kind gibt es nichts zu streichen — jede Annahme wäre ein Schema-Bruch.
      expect(m).toBeNull();
    }
  });

  it('streichen entfernt not-Wrapper unterhalb der Wurzel', () => {
    const spec: StrategySpec = {
      buy: {
        type: 'all',
        children: [
          { type: 'not', child: { type: 'compare', left: 'rsi', op: 'gt', right: 70 } },
          { type: 'compare', left: 'pctB', op: 'lt', right: 5 },
        ],
      },
      sell: { type: 'compare', left: 'rsi', op: 'gt', right: 70 },
    };
    let notEntfernt = false;
    for (let seed = 1; seed <= 40 && !notEntfernt; seed++) {
      const m = mutiereSpecMitOp(spec, 'streichen', seed);
      if (m?.beschreibung.includes('not-Wrapper')) {
        notEntfernt = true;
        expect(JSON.stringify(m.spec)).not.toContain('"not"');
      }
    }
    expect(notEntfernt).toBe(true);
  });

  it('tausch ersetzt nie durch dasselbe Blatt', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const m = mutiereSpecMitOp(einfach, 'tausch', seed);
      if (m === null) continue;
      expect(m.beschreibung).toMatch(/Blatt getauscht — (.+) → (.+)/);
      const [, alt, neu] = m.beschreibung.match(/Blatt getauscht — (.+) → (.+)/)!;
      expect(alt).not.toBe(neu);
    }
  });

  it('kippen dreht all↔any nachweislich', () => {
    const spec: StrategySpec = {
      buy: {
        type: 'all',
        children: [
          { type: 'compare', left: 'rsi', op: 'lt', right: 30 },
          { type: 'compare', left: 'pctB', op: 'lt', right: 5 },
        ],
      },
      sell: { type: 'compare', left: 'rsi', op: 'gt', right: 70 },
    };
    let gekippt = false;
    for (let seed = 1; seed <= 40 && !gekippt; seed++) {
      const m = mutiereSpecMitOp(spec, 'kippen', seed);
      if (m?.beschreibung.includes('Verknüpfung gekippt') && m.beschreibung.startsWith('buy')) {
        gekippt = true;
        expect(m.spec.buy.type).toBe('any');
      }
    }
    expect(gekippt).toBe(true);
  });

  it('parameter verändert genau eine Zahl und bleibt gültig', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const m = mutiereSpecMitOp(einfach, 'parameter', seed);
      if (m === null) continue;
      expect(validateStrategySpec(m.spec)).toEqual([]);
      expect(m.beschreibung).toMatch(/→/);
    }
  });
});

describe('startPopulation & Katalog', () => {
  it('liefert Klassik-Baum + 5 Presets, alle gültig', () => {
    const pop = startPopulation(DEFAULT_STRATEGY);
    expect(pop).toHaveLength(1 + STRATEGY_PRESETS.length);
    for (const spec of pop) expect(validateStrategySpec(spec)).toEqual([]);
  });

  it('BLATT_KATALOG enthält nur gültige Blätter', () => {
    for (const blatt of BLATT_KATALOG) {
      expect(validateStrategySpec({ buy: blatt, sell: blatt })).toEqual([]);
    }
  });

  it('alle Operator-Namen sind über MUTATIONS_OPS erreichbar', () => {
    const gesehen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const m = mutiereSpec(einfach, seed);
      if (m) gesehen.add(m.op);
    }
    // 'streichen' braucht ≥2 Kinder — die weighted-Presets haben sie.
    for (const op of MUTATIONS_OPS) {
      if (op === 'ergaenzen' || op === 'streichen' || op === 'parameter' || op === 'tausch' || op === 'kippen') {
        expect(gesehen.has(op), `Operator ${op} nie angenommen`).toBe(true);
      }
    }
  });
});
