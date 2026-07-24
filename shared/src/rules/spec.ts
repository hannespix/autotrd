/**
 * autotrd — Strategie-Spec & -Dokument des Strategie-Studios (M10).
 *
 * Eine Strategie besteht aus ZWEI Regel-Bäumen: `buy` (Entry) und `sell`
 * (Exit) — beide durch dieselben harten Guards begrenzt (validateRuleTree).
 * Gespeichert wird unter users/{uid}/strategies/{id}; Client-Writes sind per
 * Security Rules verboten, es schreiben ausschließlich die Callables
 * saveStrategyDraft / publishStrategyVersion / assignStrategy.
 */

import { validateRuleTree } from './schema.js';
import type { RuleNode } from './schema.js';

export interface StrategySpec {
  buy: RuleNode;
  sell: RuleNode;
}

/** Publizierte, eingefrorene Version — nur diese handelt (append-only Zähler). */
export interface StrategyVersion extends StrategySpec {
  version: number;
  publishedAt: string; // ISO
}

/** Doc-Shape users/{uid}/strategies/{id}. */
export interface StrategyDoc {
  name: string;
  /** Editierbarer Entwurf — Änderungen berühren `compiled` nie. */
  draft: StrategySpec;
  /** Zuletzt publizierte Version; null = noch nie publiziert. */
  compiled: StrategyVersion | null;
  status: 'draft' | 'published' | 'archived';
  /** Paper-Zuordnung; je (User, Symbol) darf nur EINE Strategie zugewiesen sein. */
  symbols: string[];
  createdAt: string;
  updatedAt: string;
}

const SPEC_KEYS = ['buy', 'sell'] as const;

/**
 * Prüft einen unbekannten Wert gegen die Spec-Form (beide Bäume inkl. der
 * harten Guards aus validateRuleTree). Leere Liste ⇒ gültig.
 */
export function validateStrategySpec(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['Strategie-Spec muss ein Objekt mit buy/sell sein'];
  }
  const rec = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(rec)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) {
      problems.push(`Unbekannter Spec-Schlüssel '${key}'`);
    }
  }
  for (const key of SPEC_KEYS) {
    if (!(key in rec)) {
      problems.push(`Spec-Schlüssel '${key}' fehlt`);
      continue;
    }
    for (const p of validateRuleTree(rec[key])) {
      problems.push(`${key}: ${p}`);
    }
  }
  return problems;
}

/** Type-Guard auf Basis von validateStrategySpec. */
export function isStrategySpec(value: unknown): value is StrategySpec {
  return validateStrategySpec(value).length === 0;
}
