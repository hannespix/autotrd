import { describe, expect, it } from 'vitest';
import {
  countRuleNodes,
  evaluate,
  evaluateTri,
  isRuleNode,
  isStrategySpec,
  MAX_DEPTH,
  MAX_NODES,
  ruleTreeDepth,
  validateRuleTree,
  validateStrategySpec,
  type RuleContext,
  type RuleNode,
} from '../src/index.js';

// ── Bausteine ────────────────────────────────────────────────────────────────

const rsiUnder30: RuleNode = { type: 'compare', left: 'rsi', op: 'lt', right: 30 };
const macdCrossUp: RuleNode = {
  type: 'crossover',
  fast: 'macdLine',
  slow: 'macdSignal',
  direction: 'above',
};

const ctxBase: RuleContext = {
  values: { rsi: 25, price: 100, macdLine: 1.2, macdSignal: 1.0, pctB: 0.5 },
  prevValues: { macdLine: 0.8, macdSignal: 1.0 },
  closes: [90, 92, 95, 100],
  minuteOfDay: 600, // 10:00
  sentiment: 0.4,
  newsEvents: ['earnings'],
  forecastPct: 1.2,
  position: { open: false },
};

// ── Schema + Guards ──────────────────────────────────────────────────────────

describe('validateRuleTree (Schema + harte Guards)', () => {
  it('akzeptiert einen realistischen Konfluenz-Baum', () => {
    const tree: RuleNode = {
      type: 'weighted',
      threshold: 2,
      children: [
        { weight: 1, node: rsiUnder30 },
        { weight: 1, node: macdCrossUp },
        { weight: 2, node: { type: 'forecast', direction: 'up', minAbsPct: 0.5 } },
      ],
    };
    expect(validateRuleTree(tree)).toEqual([]);
    expect(isRuleNode(tree)).toBe(true);
  });

  it('lehnt unbekannte Knotentypen und Fremd-Schlüssel ab', () => {
    expect(validateRuleTree({ type: 'magie' })).not.toEqual([]);
    expect(
      validateRuleTree({ type: 'compare', left: 'rsi', op: 'lt', right: 30, extra: 1 }),
    ).not.toEqual([]);
    expect(validateRuleTree(null)).not.toEqual([]);
    expect(validateRuleTree('baum')).not.toEqual([]);
  });

  it('lehnt leere Kombinatoren und kaputte Blätter ab', () => {
    expect(validateRuleTree({ type: 'all', children: [] })).not.toEqual([]);
    expect(validateRuleTree({ type: 'weighted', threshold: 0, children: [] })).not.toEqual([]);
    expect(
      validateRuleTree({ type: 'compare', left: '', op: 'lt', right: 30 }),
    ).not.toEqual([]);
    expect(
      validateRuleTree({ type: 'timeWindow', start: '9:30', end: '16:00' }),
    ).not.toEqual([]); // '9:30' ≠ 'HH:MM'
    expect(
      validateRuleTree({ type: 'timeWindow', start: '09:30', end: '09:30' }),
    ).not.toEqual([]); // leeres Fenster
    expect(
      validateRuleTree({ type: 'sentiment', op: 'gte', value: 2 }),
    ).not.toEqual([]); // außerhalb −1…+1
    expect(validateRuleTree({ type: 'newsEvent', tags: [] })).not.toEqual([]);
  });

  it("lehnt position-Bounds bei state 'none' und min>max ab", () => {
    expect(
      validateRuleTree({ type: 'position', state: 'none', minUnrealizedPct: 1 }),
    ).not.toEqual([]);
    expect(
      validateRuleTree({
        type: 'position',
        state: 'open',
        minUnrealizedPct: 5,
        maxUnrealizedPct: 1,
      }),
    ).not.toEqual([]);
    expect(
      validateRuleTree({ type: 'position', state: 'open', minUnrealizedPct: 1, maxUnrealizedPct: 5 }),
    ).toEqual([]);
  });

  it(`erlaubt Tiefe ${MAX_DEPTH}, lehnt Tiefe ${MAX_DEPTH + 1} ab`, () => {
    // Kette aus not-Knoten: Tiefe = Kettenlänge + 1 (Blatt)
    const chain = (depth: number): RuleNode => {
      let node: RuleNode = rsiUnder30;
      for (let i = 1; i < depth; i++) node = { type: 'not', child: node };
      return node;
    };
    expect(ruleTreeDepth(chain(MAX_DEPTH))).toBe(MAX_DEPTH);
    expect(validateRuleTree(chain(MAX_DEPTH))).toEqual([]);
    const tooDeep = validateRuleTree(chain(MAX_DEPTH + 1));
    expect(tooDeep.join('\n')).toMatch(/Tiefe/);
  });

  it(`erlaubt ${MAX_NODES} Knoten, lehnt ${MAX_NODES + 1} ab`, () => {
    const leaves = (n: number): RuleNode => ({
      type: 'any',
      children: Array.from({ length: n }, () => rsiUnder30),
    });
    expect(countRuleNodes(leaves(MAX_NODES - 1))).toBe(MAX_NODES);
    expect(validateRuleTree(leaves(MAX_NODES - 1))).toEqual([]);
    const tooMany = validateRuleTree(leaves(MAX_NODES));
    expect(tooMany.join('\n')).toMatch(/Knoten/);
  });

  it('lehnt unerreichbare weighted-Thresholds ab (auch verschachtelt)', () => {
    const tree = {
      type: 'all',
      children: [
        {
          type: 'weighted',
          threshold: 5,
          children: [
            { weight: 1, node: rsiUnder30 },
            { weight: 2, node: macdCrossUp },
          ],
        },
      ],
    };
    const problems = validateRuleTree(tree);
    expect(problems.join('\n')).toMatch(/unerreichbar/);
    expect(problems.join('\n')).toMatch(/Gewichtssumme 3/);
  });
});

// ── Blatt-Semantik ───────────────────────────────────────────────────────────

describe('evaluateTri — Blätter', () => {
  it('compare: Zahl und Wert-gegen-Wert; fehlende Daten ⇒ unbekannt', () => {
    expect(evaluateTri(rsiUnder30, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'compare', left: 'rsi', op: 'gte', right: 30 }, ctxBase)).toBe(false);
    expect(
      evaluateTri({ type: 'compare', left: 'price', op: 'gt', right: { key: 'bbUpper' } }, ctxBase),
    ).toBe(null); // bbUpper fehlt im Kontext
    expect(
      evaluateTri(
        { type: 'compare', left: 'macdLine', op: 'gt', right: { key: 'macdSignal' } },
        ctxBase,
      ),
    ).toBe(true);
    expect(evaluateTri(rsiUnder30, { values: { rsi: NaN } })).toBe(null);
  });

  it('crossover: above/below inkl. Vor-Bar-Bedingung', () => {
    expect(evaluateTri(macdCrossUp, ctxBase)).toBe(true); // 0.8≤1.0 → 1.2>1.0
    // gleicher Bar, aber Vor-Bar war schon drüber ⇒ kein frisches Kreuz
    expect(
      evaluateTri(macdCrossUp, { ...ctxBase, prevValues: { macdLine: 1.1, macdSignal: 1.0 } }),
    ).toBe(false);
    expect(
      evaluateTri(
        { type: 'crossover', fast: 'macdLine', slow: 'macdSignal', direction: 'below' },
        {
          values: { macdLine: 0.9, macdSignal: 1.0 },
          prevValues: { macdLine: 1.1, macdSignal: 1.0 },
        },
      ),
    ).toBe(true);
    expect(evaluateTri(macdCrossUp, { values: ctxBase.values })).toBe(null); // kein Vor-Bar
  });

  it('priceLevel und changePct', () => {
    expect(evaluateTri({ type: 'priceLevel', level: 99, side: 'above' }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'priceLevel', level: 99, side: 'below' }, ctxBase)).toBe(false);
    expect(evaluateTri({ type: 'priceLevel', level: 99, side: 'above' }, { values: {} })).toBe(null);
    // closes [90,92,95,100]: 3 Bars zurück = 90 → +11.1 %
    expect(
      evaluateTri({ type: 'changePct', lookbackBars: 3, op: 'gte', pct: 10 }, ctxBase),
    ).toBe(true);
    expect(
      evaluateTri({ type: 'changePct', lookbackBars: 1, op: 'lte', pct: -2 }, ctxBase),
    ).toBe(false);
    expect(
      evaluateTri({ type: 'changePct', lookbackBars: 10, op: 'gte', pct: 1 }, ctxBase),
    ).toBe(null); // zu wenig Historie
  });

  it('timeWindow inkl. Wrap über Mitternacht', () => {
    const win: RuleNode = { type: 'timeWindow', start: '09:30', end: '16:00' };
    expect(evaluateTri(win, { ...ctxBase, minuteOfDay: 600 })).toBe(true);
    expect(evaluateTri(win, { ...ctxBase, minuteOfDay: 500 })).toBe(false); // 08:20
    expect(evaluateTri(win, { ...ctxBase, minuteOfDay: 960 })).toBe(false); // 16:00 exklusiv
    const wrap: RuleNode = { type: 'timeWindow', start: '22:00', end: '02:00' };
    expect(evaluateTri(wrap, { ...ctxBase, minuteOfDay: 1380 })).toBe(true); // 23:00
    expect(evaluateTri(wrap, { ...ctxBase, minuteOfDay: 60 })).toBe(true); // 01:00
    expect(evaluateTri(wrap, { ...ctxBase, minuteOfDay: 720 })).toBe(false); // 12:00
    expect(evaluateTri(win, { values: {} })).toBe(null);
  });

  it('sentiment, newsEvent, forecast', () => {
    expect(evaluateTri({ type: 'sentiment', op: 'gte', value: 0.3 }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'sentiment', op: 'lte', value: -0.3 }, ctxBase)).toBe(false);
    expect(evaluateTri({ type: 'sentiment', op: 'gte', value: 0 }, { values: {} })).toBe(null);

    expect(evaluateTri({ type: 'newsEvent', tags: ['earnings', 'fda'] }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'newsEvent', tags: ['merger'] }, ctxBase)).toBe(false);
    // [] = „keine Events“ (false) vs. undefined = unbekannt (null)
    expect(evaluateTri({ type: 'newsEvent', tags: ['x'] }, { ...ctxBase, newsEvents: [] })).toBe(false);
    expect(evaluateTri({ type: 'newsEvent', tags: ['x'] }, { values: {} })).toBe(null);

    expect(evaluateTri({ type: 'forecast', direction: 'up', minAbsPct: 1 }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'forecast', direction: 'down', minAbsPct: 1 }, ctxBase)).toBe(false);
    expect(
      evaluateTri({ type: 'forecast', direction: 'down', minAbsPct: 1 }, { ...ctxBase, forecastPct: -1.5 }),
    ).toBe(true);
    expect(evaluateTri({ type: 'forecast', direction: 'up', minAbsPct: 1 }, { values: {} })).toBe(null);
  });

  it('position: none/open, Bounds, unbekannter Zustand', () => {
    expect(evaluateTri({ type: 'position', state: 'none' }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'position', state: 'open' }, ctxBase)).toBe(false);
    const openCtx: RuleContext = { values: {}, position: { open: true, unrealizedPct: 3 } };
    expect(evaluateTri({ type: 'position', state: 'open' }, openCtx)).toBe(true);
    expect(
      evaluateTri({ type: 'position', state: 'open', minUnrealizedPct: 2 }, openCtx),
    ).toBe(true);
    expect(
      evaluateTri({ type: 'position', state: 'open', minUnrealizedPct: 5 }, openCtx),
    ).toBe(false);
    expect(
      evaluateTri({ type: 'position', state: 'open', maxUnrealizedPct: 2 }, openCtx),
    ).toBe(false);
    // Bounds gefordert, aber unrealizedPct unbekannt ⇒ unbekannt
    expect(
      evaluateTri(
        { type: 'position', state: 'open', minUnrealizedPct: 1 },
        { values: {}, position: { open: true } },
      ),
    ).toBe(null);
    expect(evaluateTri({ type: 'position', state: 'none' }, { values: {} })).toBe(null);
  });
});

// ── Kombinator-Logik (dreiwertig) ────────────────────────────────────────────

describe('evaluateTri — Kombinatoren', () => {
  const T: RuleNode = rsiUnder30; // true unter ctxBase
  const F: RuleNode = { type: 'compare', left: 'rsi', op: 'gt', right: 90 };
  const U: RuleNode = { type: 'compare', left: 'gibtEsNicht', op: 'gt', right: 0 };

  it('all: false dominiert, sonst unbekannt, sonst true', () => {
    expect(evaluateTri({ type: 'all', children: [T, T] }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'all', children: [T, F, U] }, ctxBase)).toBe(false);
    expect(evaluateTri({ type: 'all', children: [T, U] }, ctxBase)).toBe(null);
  });

  it('any: true dominiert, sonst unbekannt, sonst false', () => {
    expect(evaluateTri({ type: 'any', children: [F, T, U] }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'any', children: [F, F] }, ctxBase)).toBe(false);
    expect(evaluateTri({ type: 'any', children: [F, U] }, ctxBase)).toBe(null);
  });

  it('not: unbekannt bleibt unbekannt (kein Kauf-Argument aus fehlenden Daten)', () => {
    expect(evaluateTri({ type: 'not', child: F }, ctxBase)).toBe(true);
    expect(evaluateTri({ type: 'not', child: T }, ctxBase)).toBe(false);
    expect(evaluateTri({ type: 'not', child: U }, ctxBase)).toBe(null);
  });

  it('weighted: erreicht / mit Unbekannten noch erreichbar / verfehlt', () => {
    const w = (threshold: number, kids: Array<[number, RuleNode]>): RuleNode => ({
      type: 'weighted',
      threshold,
      children: kids.map(([weight, node]) => ({ weight, node })),
    });
    expect(evaluateTri(w(2, [[1, T], [1, T], [1, F]]), ctxBase)).toBe(true);
    expect(evaluateTri(w(2, [[1, T], [1, U], [1, F]]), ctxBase)).toBe(null); // 1+1 könnte reichen
    expect(evaluateTri(w(3, [[1, T], [1, U], [1, F]]), ctxBase)).toBe(false); // selbst mit U zu wenig
    expect(evaluateTri(w(2, [[2, T], [1, U]]), ctxBase)).toBe(true); // U irrelevant
  });

  it('verschachtelter Baum wertet konsistent aus', () => {
    const tree: RuleNode = {
      type: 'all',
      children: [
        { type: 'timeWindow', start: '09:30', end: '16:00' },
        {
          type: 'weighted',
          threshold: 2,
          children: [
            { weight: 1, node: rsiUnder30 },
            { weight: 1, node: macdCrossUp },
            { weight: 2, node: { type: 'forecast', direction: 'up', minAbsPct: 5 } },
          ],
        },
        { type: 'not', child: { type: 'newsEvent', tags: ['halt'] } },
      ],
    };
    expect(validateRuleTree(tree)).toEqual([]);
    expect(evaluateTri(tree, ctxBase)).toBe(true);
    // außerhalb des Zeitfensters kippt der ganze Baum
    expect(evaluateTri(tree, { ...ctxBase, minuteOfDay: 300 })).toBe(false);
  });
});

// ── Strategie-Spec (buy/sell-Bäume) ──────────────────────────────────────────

describe('validateStrategySpec', () => {
  const sellTree: RuleNode = {
    type: 'any',
    children: [
      { type: 'compare', left: 'rsi', op: 'gt', right: 70 },
      { type: 'position', state: 'open', minUnrealizedPct: 4 },
    ],
  };

  it('akzeptiert eine vollständige Spec', () => {
    const spec = { buy: rsiUnder30, sell: sellTree };
    expect(validateStrategySpec(spec)).toEqual([]);
    expect(isStrategySpec(spec)).toBe(true);
  });

  it('meldet fehlende Bäume, Fremd-Schlüssel und Nicht-Objekte', () => {
    expect(validateStrategySpec({ buy: rsiUnder30 }).join('\n')).toMatch(/'sell' fehlt/);
    expect(validateStrategySpec({ buy: rsiUnder30, sell: sellTree, extra: 1 }).join('\n')).toMatch(
      /Unbekannter Spec-Schlüssel 'extra'/,
    );
    expect(validateStrategySpec(null)).toHaveLength(1);
    expect(validateStrategySpec([rsiUnder30])).toHaveLength(1);
  });

  it('präfixt Baum-Probleme mit buy/sell', () => {
    const broken = { buy: { type: 'magie' }, sell: sellTree };
    const problems = validateStrategySpec(broken);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.startsWith('buy: '))).toBe(true);
  });
});

// ── Strikte Engine-Sicht ─────────────────────────────────────────────────────

describe('evaluate (strikt: unbekannt ⇒ false)', () => {
  it('mappt null auf false, true bleibt true', () => {
    const U: RuleNode = { type: 'compare', left: 'fehlt', op: 'gt', right: 0 };
    expect(evaluate(U, ctxBase)).toBe(false);
    expect(evaluate({ type: 'not', child: U }, ctxBase)).toBe(false); // not(unbekannt) ⇒ kein Trade
    expect(evaluate(rsiUnder30, ctxBase)).toBe(true);
    expect(evaluate({ type: 'position', state: 'none' }, { values: {} })).toBe(false);
  });
});
