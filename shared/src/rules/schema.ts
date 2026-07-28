/**
 * autotrd — Regel-Baum des Strategie-Studios (M10).
 *
 * Strategie-Logik als DATEN: ein getypter Bedingungsbaum, den Builder-Vorschau,
 * Scan-Engine und (später M11) Backtest identisch interpretieren. Dieses Modul
 * ist die einzige Wahrheit über die FORM des Baums (Zod-Schemata + harte
 * Guards); die SEMANTIK lebt ausschließlich in `evaluate.ts`.
 *
 * Harte Guards (validateRuleTree — niemals aufweichen):
 *   - Tiefe ≤ MAX_DEPTH (5)
 *   - Knotenzahl ≤ MAX_NODES (25)
 *   - jeder `weighted`-Threshold muss mit der Gewichtssumme erreichbar sein
 */

import { z } from 'zod';

export const MAX_DEPTH = 5;
export const MAX_NODES = 25;

// ── Typen (manuell, weil der Baum rekursiv ist) ──────────────────────────────

export type CompareOp = 'lt' | 'lte' | 'gt' | 'gte';

/** Vergleich eines Kontextwerts gegen Zahl oder zweiten Kontextwert. */
export interface CompareNode {
  type: 'compare';
  /** Wert-Schlüssel im RuleContext (z. B. 'rsi', 'price', 'macdLine'). */
  left: string;
  op: CompareOp;
  right: number | { key: string };
}

/** fast kreuzt slow zwischen Vor-Bar und aktuellem Bar. */
export interface CrossoverNode {
  type: 'crossover';
  fast: string;
  slow: string;
  direction: 'above' | 'below';
}

/** Aktueller Preis über/unter fester Marke. */
export interface PriceLevelNode {
  type: 'priceLevel';
  level: number;
  side: 'above' | 'below';
}

/** Prozentuale Close-Änderung über die letzten N Bars. */
export interface ChangePctNode {
  type: 'changePct';
  lookbackBars: number;
  op: 'gte' | 'lte';
  pct: number;
}

/**
 * Uhrzeit-Fenster [start, end) in Minuten der MARKT-Zeitzone; Wrap über
 * Mitternacht erlaubt ('22:00'–'02:00'). DST rechnet der Kontext-Lieferant
 * (ctx.minuteOfDay), nie der Baum.
 */
export interface TimeWindowNode {
  type: 'timeWindow';
  start: string; // 'HH:MM'
  end: string;   // 'HH:MM'
}

/** Forecast-Richtungsstimme: predictedPct ≥ minAbsPct (up) bzw. ≤ −minAbsPct. */
export interface ForecastNode {
  type: 'forecast';
  direction: 'up' | 'down';
  minAbsPct: number;
}

/** Positions-Zustand — Basis für Exit-Regeln. Bounds nur bei state 'open'. */
export interface PositionNode {
  type: 'position';
  state: 'open' | 'none';
  // `| undefined` wegen exactOptionalPropertyTypes (zod .optional() liefert das)
  minUnrealizedPct?: number | undefined;
  maxUnrealizedPct?: number | undefined;
}

export interface AllNode {
  type: 'all';
  children: RuleNode[];
}

export interface AnyNode {
  type: 'any';
  children: RuleNode[];
}

export interface NotNode {
  type: 'not';
  child: RuleNode;
}

export interface WeightedChild {
  weight: number;
  node: RuleNode;
}

/** Gewichtete Abstimmung: Summe der Gewichte wahrer Kinder ≥ threshold. */
export interface WeightedNode {
  type: 'weighted';
  threshold: number;
  children: WeightedChild[];
}

export type RuleLeaf =
  | CompareNode
  | CrossoverNode
  | PriceLevelNode
  | ChangePctNode
  | TimeWindowNode
  | ForecastNode
  | PositionNode;

export type RuleNode = RuleLeaf | AllNode | AnyNode | NotNode | WeightedNode;

/**
 * Wert-Schlüssel, die Scan-Engine und Vorschau garantiert befüllen —
 * Grundlage für die Auswahl im Karten-Builder. `compare`/`crossover` erlauben
 * bewusst freie Schlüssel (exotische Indikator-Varianten, M10 Scan-Teil).
 */
export const KNOWN_VALUE_KEYS = [
  'price',
  'rsi',
  'macdLine',
  'macdSignal',
  'macdHistogram',
  'bbUpper',
  'bbMiddle',
  'bbLower',
  'pctB',
] as const;

// ── Zod-Schemata ─────────────────────────────────────────────────────────────

const valueKey = z.string().min(1).max(64);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit muss 'HH:MM' sein");

const CompareSchema = z.strictObject({
  type: z.literal('compare'),
  left: valueKey,
  op: z.enum(['lt', 'lte', 'gt', 'gte']),
  right: z.union([z.number(), z.strictObject({ key: valueKey })]),
});

const CrossoverSchema = z.strictObject({
  type: z.literal('crossover'),
  fast: valueKey,
  slow: valueKey,
  direction: z.enum(['above', 'below']),
});

const PriceLevelSchema = z.strictObject({
  type: z.literal('priceLevel'),
  level: z.number().positive(),
  side: z.enum(['above', 'below']),
});

const ChangePctSchema = z.strictObject({
  type: z.literal('changePct'),
  lookbackBars: z.number().int().min(1).max(250),
  op: z.enum(['gte', 'lte']),
  pct: z.number(),
});

const TimeWindowSchema = z
  .strictObject({
    type: z.literal('timeWindow'),
    start: hhmm,
    end: hhmm,
  })
  .refine((v) => v.start !== v.end, {
    message: 'timeWindow: start und end dürfen nicht identisch sein (leeres Fenster)',
  });

const ForecastSchema = z.strictObject({
  type: z.literal('forecast'),
  direction: z.enum(['up', 'down']),
  minAbsPct: z.number().min(0).max(50),
});

const PositionSchema = z
  .strictObject({
    type: z.literal('position'),
    state: z.enum(['open', 'none']),
    minUnrealizedPct: z.number().optional(),
    maxUnrealizedPct: z.number().optional(),
  })
  .refine(
    (v) => v.state === 'open' || (v.minUnrealizedPct === undefined && v.maxUnrealizedPct === undefined),
    { message: "position: Unrealized-Bounds sind nur bei state 'open' sinnvoll" },
  )
  .refine(
    (v) =>
      v.minUnrealizedPct === undefined ||
      v.maxUnrealizedPct === undefined ||
      v.minUnrealizedPct <= v.maxUnrealizedPct,
    { message: 'position: minUnrealizedPct muss ≤ maxUnrealizedPct sein' },
  );

// Rekursion: Kinder verweisen lazy auf die Union (kein TDZ beim Modul-Load).
// Die explizite Annotation bricht den Inferenz-Zyklus (TS7022).
const lazyNode: z.ZodType<RuleNode> = z.lazy(() => RuleNodeSchemaInternal);

const AllSchema = z.strictObject({
  type: z.literal('all'),
  children: z.array(lazyNode).min(1),
});

const AnySchema = z.strictObject({
  type: z.literal('any'),
  children: z.array(lazyNode).min(1),
});

const NotSchema = z.strictObject({
  type: z.literal('not'),
  child: lazyNode,
});

const WeightedSchema = z.strictObject({
  type: z.literal('weighted'),
  threshold: z.number().positive().max(1000),
  children: z
    .array(
      z.strictObject({
        weight: z.number().positive().max(100),
        node: lazyNode,
      }),
    )
    .min(1),
});

const RuleNodeSchemaInternal = z.lazy(() =>
  z.union([
    AllSchema,
    AnySchema,
    NotSchema,
    WeightedSchema,
    CompareSchema,
    CrossoverSchema,
    PriceLevelSchema,
    ChangePctSchema,
    TimeWindowSchema,
    ForecastSchema,
    PositionSchema,
  ]),
);

export const RuleNodeSchema: z.ZodType<RuleNode> = RuleNodeSchemaInternal as unknown as z.ZodType<RuleNode>;

// ── Struktur-Helper & harte Guards ───────────────────────────────────────────

function childNodes(node: RuleNode): RuleNode[] {
  switch (node.type) {
    case 'all':
    case 'any':
      return node.children;
    case 'not':
      return [node.child];
    case 'weighted':
      return node.children.map((c) => c.node);
    default:
      return [];
  }
}

/** Anzahl aller RuleNodes im Baum (weighted-Wrapper zählen nicht). */
export function countRuleNodes(node: RuleNode): number {
  return 1 + childNodes(node).reduce((sum, c) => sum + countRuleNodes(c), 0);
}

/** Tiefe des Baums; ein einzelnes Blatt hat Tiefe 1. */
export function ruleTreeDepth(node: RuleNode): number {
  const children = childNodes(node);
  return 1 + (children.length === 0 ? 0 : Math.max(...children.map(ruleTreeDepth)));
}

function collectGuardProblems(node: RuleNode, path: string, problems: string[]): void {
  if (node.type === 'weighted') {
    const sum = node.children.reduce((s, c) => s + c.weight, 0);
    if (node.threshold > sum) {
      problems.push(
        `${path}: weighted-Threshold ${node.threshold} ist unerreichbar (Gewichtssumme ${sum})`,
      );
    }
  }
  childNodes(node).forEach((c, i) => collectGuardProblems(c, `${path}.children[${i}]`, problems));
}

/**
 * Prüft einen unbekannten Wert gegen Schema + harte Guards.
 * Liefert eine Liste von Problemen (deutsch); leer ⇒ gültig.
 */
export function validateRuleTree(value: unknown): string[] {
  const parsed = RuleNodeSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map((iss) => {
      const p = iss.path.length > 0 ? iss.path.join('.') : 'root';
      return `${p}: ${iss.message}`;
    });
  }

  const problems: string[] = [];
  const tree = parsed.data;

  const nodes = countRuleNodes(tree);
  if (nodes > MAX_NODES) {
    problems.push(`Baum hat ${nodes} Knoten — Maximum ist ${MAX_NODES}`);
  }
  const depth = ruleTreeDepth(tree);
  if (depth > MAX_DEPTH) {
    problems.push(`Baum hat Tiefe ${depth} — Maximum ist ${MAX_DEPTH}`);
  }
  collectGuardProblems(tree, 'root', problems);

  return problems;
}

/** Type-Guard auf Basis von validateRuleTree. */
export function isRuleNode(value: unknown): value is RuleNode {
  return validateRuleTree(value).length === 0;
}
