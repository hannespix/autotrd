/**
 * Tuner-Review-Logik — Port von reference/scripts/ai_tuner.py (pure Anteile).
 *
 * Der EMPIRISCHE Loop (evalForecasts → bestParams) bleibt das verlässliche
 * Self-Tuning. Diese Schicht ist QUALITATIV: einmal täglich reviewt Sonnet
 * die realisierte Trefferstatistik und schlägt Verbesserungen vor.
 *
 * SICHERHEIT (nie aufweichen): Der Review ändert NIEMALS Live-Parameter.
 * Er darf ausschließlich das Shadow-SUCHGITTER innerhalb harter Bounds
 * erweitern — jeder neue Kandidat wird erst per realisierter Trefferquote
 * validiert, bevor bestParams ihn überhaupt wählen kann.
 */

import { extractJson } from './ai.js';

export const HARD_LOOKBACK = { min: 5, max: 60 } as const;
export const HARD_WEIGHT = { min: 0, max: 1.5 } as const;

export interface TunerProposal {
  diagnosis: string;
  suggestions: string[];
  expandLookback: number[];
  expandWeight: number[];
}

/** Modell-Antwort (JSON in Prosa toleriert) in einen Vorschlag parsen. */
export function parseTunerResponse(text: string | null | undefined): TunerProposal | null {
  const data = extractJson(text);
  if (!data || typeof data.diagnosis !== 'string') return null;
  const nums = (v: unknown): number[] =>
    Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
  return {
    diagnosis: data.diagnosis.slice(0, 600),
    suggestions: Array.isArray(data.suggestions)
      ? (data.suggestions as unknown[])
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.slice(0, 200))
          .slice(0, 8)
      : [],
    expandLookback: nums(data.expand_lookback),
    expandWeight: nums(data.expand_weight),
  };
}

export interface GridExpansion {
  /** NEUE Kandidaten (noch nicht im aktuellen Gitter), hart geclampt. */
  extraLookbacks: number[];
  extraWeights: number[];
  /** Menschlich lesbares Protokoll („lookback+=15“). */
  applied: string[];
}

/**
 * Vorschläge in die harten Bounds clampen und gegen das aktuelle Gitter
 * deduplizieren (Port von _safely_expand_grids). Lookbacks werden wie in der
 * Referenz auf Ganzzahlen trunkiert, Gewichte auf 3 Stellen gerundet.
 */
export function clampGridProposals(
  proposal: Pick<TunerProposal, 'expandLookback' | 'expandWeight'>,
  currentLookbacks: readonly number[],
  currentWeights: readonly number[],
): GridExpansion {
  const applied: string[] = [];
  const extraLookbacks: number[] = [];
  for (const v of proposal.expandLookback) {
    const iv = Math.trunc(v);
    if (
      iv >= HARD_LOOKBACK.min &&
      iv <= HARD_LOOKBACK.max &&
      !currentLookbacks.includes(iv) &&
      !extraLookbacks.includes(iv)
    ) {
      extraLookbacks.push(iv);
      applied.push(`lookback+=${iv}`);
    }
  }
  const extraWeights: number[] = [];
  for (const v of proposal.expandWeight) {
    const fv = Math.round(v * 1000) / 1000;
    if (
      fv >= HARD_WEIGHT.min &&
      fv <= HARD_WEIGHT.max &&
      !currentWeights.includes(fv) &&
      !extraWeights.includes(fv)
    ) {
      extraWeights.push(fv);
      applied.push(`w+=${fv}`);
    }
  }
  extraLookbacks.sort((a, b) => a - b);
  extraWeights.sort((a, b) => a - b);
  return { extraLookbacks, extraWeights, applied };
}

/**
 * Basis-Gitter mit persistierten Extra-Kandidaten vereinen. Defensive
 * Doppel-Clampung: selbst ein manipuliertes meta-Doc kann keine Werte
 * außerhalb der harten Bounds ins Shadow-Gitter schieben.
 */
export function mergeGrids(
  baseWeights: readonly number[],
  baseLookbacks: readonly number[],
  tuning: { extraWeights?: unknown; extraLookbacks?: unknown } | undefined,
): { weightGrid: number[]; lookbackGrid: number[] } {
  // Strikt nur echte Zahlen (Number(null) wäre 0 — das darf NICHT durchrutschen)
  const safeNums = (v: unknown): number[] =>
    Array.isArray(v)
      ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      : [];
  const weightGrid = [...baseWeights];
  for (const w of safeNums(tuning?.extraWeights)) {
    const fv = Math.round(w * 1000) / 1000;
    if (fv >= HARD_WEIGHT.min && fv <= HARD_WEIGHT.max && !weightGrid.includes(fv)) {
      weightGrid.push(fv);
    }
  }
  const lookbackGrid = [...baseLookbacks];
  for (const lb of safeNums(tuning?.extraLookbacks)) {
    const iv = Math.trunc(lb);
    if (iv >= HARD_LOOKBACK.min && iv <= HARD_LOOKBACK.max && !lookbackGrid.includes(iv)) {
      lookbackGrid.push(iv);
    }
  }
  weightGrid.sort((a, b) => a - b);
  lookbackGrid.sort((a, b) => a - b);
  return { weightGrid, lookbackGrid };
}

export interface TunerStatsSummary {
  scored: number;
  dirAccuracy: number | null;
  best: { w: number; lookback: number };
  topCombos: Array<{ combo: string; n: number; hitRate: number }>;
}

/** Review-Prompt (Port von ai_tuner._PROMPT). */
export function buildTunerPrompt(
  stats: TunerStatsSummary,
  weightGrid: readonly number[],
  lookbackGrid: readonly number[],
): string {
  return (
    'Du bist ein quantitativer Analyst und verbesserst das Prognosemodell eines ' +
    'Paper-Trading-Bots. Das Modell ist eine lineare Regression über die letzten ' +
    '`lookback` Tages-Schlusskurse plus ein gedeckelter, volatilitäts-skalierter ' +
    'Sentiment-Tilt (Gewicht `w`). Ein empirischer Loop wählt bereits automatisch ' +
    'die (w, lookback)-Kombination mit der besten realisierten Trefferquote.\n\n' +
    `Aktuelle realisierte Statistik:\n${JSON.stringify(stats)}\n\n` +
    `Aktuelle Suchgitter: w ∈ [${weightGrid.join(', ')}], ` +
    `lookback ∈ [${lookbackGrid.join(', ')}].\n\n` +
    'Analysiere kurz und schlage KONKRETE, begründete Verbesserungen vor. ' +
    'Antworte AUSSCHLIESSLICH mit JSON:\n' +
    '{"diagnosis": "<2-3 Sätze: was funktioniert, was nicht, welche Regime-Muster>", ' +
    '"suggestions": ["<konkrete Empfehlung>", ...], ' +
    '"expand_lookback": [<neue lookback-Kandidaten als Zahlen, oder leer>], ' +
    '"expand_weight": [<neue w-Kandidaten als Zahlen, oder leer>]}'
  );
}
