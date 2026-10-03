/**
 * autotrd — Strategie-Spec & -Dokument (Regel-Baum als gespeicherte Form).
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

/** Virtuelles Shadow-Konto (M11) — lebt im Strategie-Doc, nie im echten Wallet. */
export interface ShadowAccount {
  balance: number;
  positions: Record<string, { qty: number; avgEntry: number }>;
  /** Balance + Positionswert zum letzten Scan. */
  equity: number;
  startedAt: string;
  updatedAt: string;
}

/** Doc-Shape users/{uid}/strategies/{id}. */
export interface StrategyDoc {
  name: string;
  /** Editierbarer Entwurf — Änderungen berühren `compiled` nie. */
  draft: StrategySpec;
  /** Zuletzt publizierte Version; null = noch nie publiziert. */
  compiled: StrategyVersion | null;
  status: 'draft' | 'published' | 'archived';
  /** Zuordnung; je (User, Symbol) darf nur EINE paper-Strategie zugewiesen sein. */
  symbols: string[];
  /** paper = echtes Wallet · shadow = virtuelles Konto (M11); Default paper. */
  mode?: 'paper' | 'shadow';
  shadow?: ShadowAccount | null;
  /** Letzte Richtung je Symbol — shadowSignals nur bei Entscheidungs-Wechsel. */
  lastDirs?: Record<string, 'buy' | 'sell' | 'hold'>;
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
