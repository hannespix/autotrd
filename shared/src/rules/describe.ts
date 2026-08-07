/**
 * autotrd — Klartext für Regel-Blätter (Bedingungs-Statistik, M11-Rest).
 *
 * Die Statistik „MACD-Cross feuerte 41×, 12× am Signal-Tag" braucht für
 * jedes Blatt eine stabile, menschenlesbare Zeile. Die Beschreibung ist
 * bewusst DETERMINISTISCH aus dem Knoten abgeleitet (kein freier Text):
 * Zwei Läufe über denselben Baum erzeugen identische Labels, und die
 * Aggregation über mehrere Symbole kann schlicht über das Label summieren.
 */

import type { RuleNode } from './schema.js';

const OP_TXT: Record<string, string> = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=' };

/** Ein Blatt (= Knoten ohne Kinder) als kompakte Klartext-Zeile. */
export function beschreibeBlatt(node: RuleNode): string {
  switch (node.type) {
    case 'compare': {
      const rechts = typeof node.right === 'number' ? String(node.right) : node.right.key;
      return `${node.left} ${OP_TXT[node.op] ?? node.op} ${rechts}`;
    }
    case 'crossover':
      return `${node.fast} kreuzt ${node.direction === 'above' ? 'über' : 'unter'} ${node.slow}`;
    case 'priceLevel':
      return `Kurs ${node.side === 'above' ? '>' : '<'} ${node.level}`;
    case 'changePct':
      return `Δ${node.lookbackBars} Bar${node.lookbackBars === 1 ? '' : 's'} ${
        node.op === 'gte' ? '≥' : '≤'
      } ${node.pct} %`;
    case 'timeWindow':
      return `Zeit ${node.start}–${node.end}`;
    case 'forecast':
      return `Prognose ${node.direction === 'up' ? '≥ +' : '≤ −'}${node.minAbsPct} %`;
    case 'position': {
      const teile = [`Position ${node.state === 'none' ? 'flach' : 'offen'}`];
      if (node.minUnrealizedPct !== undefined) teile.push(`P&L ≥ ${node.minUnrealizedPct} %`);
      if (node.maxUnrealizedPct !== undefined) teile.push(`P&L ≤ ${node.maxUnrealizedPct} %`);
      return teile.join(', ');
    }
    // Kombinatoren haben keine eigene Zeile — sie werden über ihre Blätter
    // sichtbar. Der Fall existiert nur für die Vollständigkeit des Switch.
    case 'all':
    case 'any':
    case 'not':
    case 'weighted':
      return node.type;
  }
}

/**
 * Alle Blätter eines Baums, in Auswertungsreihenfolge. Jedes Blatt ist
 * selbst ein gültiger (Teil-)Baum — `evaluate(blatt, ctx)` liefert also
 * genau die Einzelstimme, die es im Gesamtbaum abgibt.
 */
export function sammleBlaetter(node: RuleNode): RuleNode[] {
  switch (node.type) {
    case 'all':
    case 'any':
      return node.children.flatMap(sammleBlaetter);
    case 'weighted':
      return node.children.flatMap((c) => sammleBlaetter(c.node));
    case 'not':
      return sammleBlaetter(node.child);
    default:
      return [node];
  }
}
