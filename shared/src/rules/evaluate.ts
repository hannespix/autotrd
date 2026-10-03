/**
 * autotrd — pure Auswertung des Regel-Baums (M10).
 *
 * DREIWERTIGE Logik: `true` / `false` / `null` (= unbekannt, Daten fehlen).
 * Sicherheitsprinzip: Auf fehlenden Daten wird NIE gehandelt — ein Blatt ohne
 * Daten ist `null`, `not` lässt `null` unangetastet (sonst würde fehlendes RSI
 * über `not(rsi>70)` zum Kauf-Argument), und `evaluate()` wertet nur ein
 * hartes `true` als bestanden. Die Vorschau im Builder kann über
 * `evaluateTri()` zusätzlich „unbekannt“ anzeigen.
 *
 * Alles hier ist pur und deterministisch — Zeit/Zeitzone/DST liefert der
 * Aufrufer über `ctx.minuteOfDay` (Minuten seit Mitternacht in der
 * MARKT-Zeitzone), nie der Baum selbst.
 */

import type { RuleNode } from './schema.js';

export type TriState = boolean | null;

export interface PositionContext {
  open: boolean;
  /** Unrealisierter P&L in % — null, wenn (noch) nicht berechenbar. */
  unrealizedPct?: number | null;
}

/** Alle Daten, die ein Baum sehen darf — je Symbol, je Auswertungszeitpunkt. */
export interface RuleContext {
  /** Werte des aktuellen Bars (KNOWN_VALUE_KEYS + exotische Varianten). */
  values: Record<string, number | null | undefined>;
  /** Werte des VORHERIGEN Bars — Basis für crossover. */
  prevValues?: Record<string, number | null | undefined>;
  /** Closes aufsteigend (ältester zuerst, letzter = aktueller Close). */
  closes?: number[];
  /** Minuten seit Mitternacht in der Markt-Zeitzone (0–1439). */
  minuteOfDay?: number | null;
  /** Forecast predictedPct zum Horizont-Ende. */
  forecastPct?: number | null;
  /** Positions-Zustand; undefined = unbekannt (≠ „keine Position“). */
  position?: PositionContext | null;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hmToMinutes(hm: string): number {
  const h = Number(hm.slice(0, 2));
  const m = Number(hm.slice(3, 5));
  return h * 60 + m;
}

function compareOp(a: number, op: 'lt' | 'lte' | 'gt' | 'gte', b: number): boolean {
  switch (op) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
  }
}

/** Dreiwertige Auswertung — `null` heißt „mit den vorhandenen Daten unentscheidbar“. */
export function evaluateTri(node: RuleNode, ctx: RuleContext): TriState {
  switch (node.type) {
    // ── Kombinatoren ─────────────────────────────────────────────────────────
    case 'all': {
      let unknown = false;
      for (const child of node.children) {
        const v = evaluateTri(child, ctx);
        if (v === false) return false;
        if (v === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case 'any': {
      let unknown = false;
      for (const child of node.children) {
        const v = evaluateTri(child, ctx);
        if (v === true) return true;
        if (v === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case 'not': {
      const v = evaluateTri(node.child, ctx);
      return v === null ? null : !v;
    }
    case 'weighted': {
      let sumTrue = 0;
      let sumUnknown = 0;
      for (const { weight, node: child } of node.children) {
        const v = evaluateTri(child, ctx);
        if (v === true) sumTrue += weight;
        else if (v === null) sumUnknown += weight;
      }
      if (sumTrue >= node.threshold) return true;
      if (sumTrue + sumUnknown >= node.threshold) return null;
      return false;
    }

    // ── Blätter ──────────────────────────────────────────────────────────────
    case 'compare': {
      const left = num(ctx.values[node.left]);
      const right = typeof node.right === 'number' ? node.right : num(ctx.values[node.right.key]);
      if (left === null || right === null) return null;
      return compareOp(left, node.op, right);
    }
    case 'crossover': {
      const fast = num(ctx.values[node.fast]);
      const slow = num(ctx.values[node.slow]);
      const prevFast = num(ctx.prevValues?.[node.fast]);
      const prevSlow = num(ctx.prevValues?.[node.slow]);
      if (fast === null || slow === null || prevFast === null || prevSlow === null) return null;
      return node.direction === 'above'
        ? prevFast <= prevSlow && fast > slow
        : prevFast >= prevSlow && fast < slow;
    }
    case 'priceLevel': {
      const price = num(ctx.values['price']);
      if (price === null) return null;
      return node.side === 'above' ? price > node.level : price < node.level;
    }
    case 'changePct': {
      const closes = ctx.closes;
      if (!closes || closes.length < node.lookbackBars + 1) return null;
      const cur = num(closes[closes.length - 1]);
      const base = num(closes[closes.length - 1 - node.lookbackBars]);
      if (cur === null || base === null || base === 0) return null;
      const change = ((cur - base) / Math.abs(base)) * 100;
      return node.op === 'gte' ? change >= node.pct : change <= node.pct;
    }
    case 'timeWindow': {
      const minute = num(ctx.minuteOfDay);
      if (minute === null) return null;
      const start = hmToMinutes(node.start);
      const end = hmToMinutes(node.end);
      // [start, end); bei start > end wickelt das Fenster über Mitternacht.
      return start < end ? minute >= start && minute < end : minute >= start || minute < end;
    }
    case 'forecast': {
      const fc = num(ctx.forecastPct);
      if (fc === null) return null;
      return node.direction === 'up' ? fc >= node.minAbsPct : fc <= -node.minAbsPct;
    }
    case 'position': {
      const pos = ctx.position;
      if (pos === undefined || pos === null) return null;
      if (node.state === 'none') return !pos.open;
      if (!pos.open) return false;
      if (node.minUnrealizedPct === undefined && node.maxUnrealizedPct === undefined) return true;
      const upl = num(pos.unrealizedPct);
      if (upl === null) return null;
      if (node.minUnrealizedPct !== undefined && upl < node.minUnrealizedPct) return false;
      if (node.maxUnrealizedPct !== undefined && upl > node.maxUnrealizedPct) return false;
      return true;
    }
  }
}

/**
 * Strikte Auswertung für die Engine: NUR ein hartes `true` besteht —
 * `unbekannt` (fehlende Daten) löst niemals einen Trade aus.
 */
export function evaluate(node: RuleNode, ctx: RuleContext): boolean {
  return evaluateTri(node, ctx) === true;
}
