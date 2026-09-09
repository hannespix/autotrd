/**
 * Champion/Challenger: Wer darf live handeln? Der Champion je Symbol steht
 * in `champion.json`; ein Kandidat ersetzt ihn nur, wenn er die Gates
 * besteht UND den amtierenden Champion — auf SAUBEREM OOS neu bewertet —
 * um eine Marge schlägt. "Kein Handel" ist ein vollwertiger Zustand
 * (`noTrade`), kein Fehlerfall.
 *
 * Sauber heißt: nur OOS-Folds, die NACH dem Fit-Fenster des Champions
 * beginnen (`fitEnd`). Red-Team-Befund: finalParams entstehen auf dem
 * letzten Suchfenster; beim Folgelauf liegen die meisten OOS-Folds genau
 * dort — ein Re-Score darauf wäre In-Sample.
 */
import type { Journal } from '../core/journal.ts';
import { readJson, writeJsonAtomic } from '../core/journal.ts';
import type { Ms, Params, TimeframeMin } from '../core/types.ts';
import type { GateResult } from './robustness.ts';
import type { OosAggregate, TimeRange } from './walkForward.ts';

export interface ChampionEntry {
  strategy: string;
  params: Params;
  timeframe: TimeframeMin;
  /** OOS-Objective-Median zum Zeitpunkt der Beförderung. */
  score: number;
  oos: OosAggregate;
  gates: GateResult[];
  decidedAt: Ms;
  trials: number;
  dataRange: TimeRange;
  /** Ende des Fensters, aus dem `params` stammen — OOS davor ist für den Re-Score tabu. Fehlt es (alte Datei): decidedAt. */
  fitEnd?: Ms;
  /**
   * Mit welcher Korb-Zugehörigkeit der Score gemessen wurde (§5a.13). Fehlt
   * es (alte Datei): `fixed` — die Auswahl von heute, rückwärts angewandt. Ein
   * Champion aus dem einen Regime ist mit einem Kandidaten aus dem anderen
   * nicht vergleichbar und tritt ab, bis einer neu besteht (Prüfbefund 4.2).
   */
  foldMembership?: 'point_in_time' | 'fixed';
}

/** Fit-Ende eines Champions; alte Dateien ohne Feld: Beförderungszeitpunkt (konservativ). */
export function fitEndOf(entry: ChampionEntry): Ms {
  return entry.fitEnd ?? entry.decidedAt;
}

export interface NoTradeEntry {
  reason: string;
  decidedAt: Ms;
  bestScore: number | null;
}

export interface ChampionFile {
  version: 1;
  updatedAt: Ms;
  symbols: Record<string, ChampionEntry>;
  noTrade: Record<string, NoTradeEntry>;
}

export function emptyChampionFile(now: Ms): ChampionFile {
  return { version: 1, updatedAt: now, symbols: {}, noTrade: {} };
}

export function loadChampion(path: string): ChampionFile | null {
  const raw = readJson<Partial<ChampionFile>>(path);
  if (raw === null) return null;
  if (raw.version !== 1) throw new Error(`${path}: unbekannte Champion-Version ${String(raw.version)} — Datei prüfen statt überschreiben`);
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    symbols: raw.symbols ?? {},
    noTrade: raw.noTrade ?? {},
  };
}

export function saveChampion(path: string, file: ChampionFile): void {
  writeJsonAtomic(path, file);
}

/* ───────────────────────── Entscheidung ───────────────────────── */

export type PromotionAction = 'promote' | 'keep' | 'demote_to_notrade' | 'stay_notrade';

export interface PromotionDecision {
  action: PromotionAction;
  reason: string;
}

export interface PromotionInput {
  incumbent: ChampionEntry | null;
  /**
   * Score des Amtsinhabers JETZT: OOS-Median auf sauberen Folds nach fitEnd;
   * bei zu wenig sauberem OOS der Beförderungs-Score; null = nicht bewertbar
   * (Strategie/Zeitrahmen unbekannt).
   */
  incumbentRescore: number | null;
  /** Gates des Amtsinhabers auf sauberem OOS: true/false; null = nicht geprüft (zu wenig sauberes OOS oder nicht bewertbar). */
  incumbentPass: boolean | null;
  candidate: { entry: ChampionEntry; pass: boolean } | null;
  /** Kandidat muss den Incumbent um diesen Faktor schlagen (0.1 = 10 %). */
  margin: number;
}

const f3 = (x: number | null): string => (x === null ? '–' : x === -Infinity ? '−∞' : x === Infinity ? '∞' : x.toFixed(3));

/**
 * Regeln (eine Änderung je Symbol je Lauf):
 * - Kandidat besteht: ohne Incumbent ⇒ promote; Incumbent reißt die Gates ⇒
 *   promote; sonst nur, wenn score ≥ rescore × (1 + margin) — bei rescore ≤ 0
 *   (oder nicht bewertbar) reicht score > 0; sonst keep.
 * - Kandidat fällt durch (oder fehlt): Incumbent reißt die Gates ⇒
 *   demote_to_notrade; Incumbent mit rescore > 0 ⇒ keep (auch ungeprüft bei zu
 *   wenig sauberem OOS); rescore ≤ 0 oder nicht bewertbar ⇒ demote_to_notrade;
 *   kein Incumbent ⇒ stay_notrade.
 */
export function decidePromotion(a: PromotionInput): PromotionDecision {
  const { incumbent, incumbentRescore, incumbentPass, candidate, margin } = a;
  const cand = candidate && candidate.pass ? candidate.entry : null;

  if (cand) {
    if (!incumbent) {
      return { action: 'promote', reason: `erste Beförderung: ${cand.strategy} besteht alle Gates (Score ${f3(cand.score)})` };
    }
    if (incumbentPass === false) {
      return {
        action: 'promote',
        reason: `Incumbent ${incumbent.strategy} reißt die Gates auf sauberem OOS (Score ${f3(incumbentRescore)}); Kandidat ${cand.strategy} besteht sie (Score ${f3(cand.score)})`,
      };
    }
    const rescore = incumbentRescore;
    if (rescore === null || rescore <= 0) {
      if (cand.score > 0) {
        return {
          action: 'promote',
          reason: `Incumbent ${incumbent.strategy} liefert ${rescore === null ? 'keinen bewertbaren Score' : `Score ${f3(rescore)} ≤ 0`}, Kandidat ${cand.strategy} Score ${f3(cand.score)} > 0`,
        };
      }
      return { action: 'keep', reason: `Kandidat ${cand.strategy} besteht die Gates, aber Score ${f3(cand.score)} ≤ 0 — Incumbent bleibt` };
    }
    const needed = rescore * (1 + margin);
    const basis = incumbentPass === null ? 'Beförderungs-Score, kein sauberes OOS' : 'sauberes OOS';
    if (cand.score >= needed) {
      return {
        action: 'promote',
        reason: `Kandidat ${cand.strategy} Score ${f3(cand.score)} ≥ ${f3(needed)} (Incumbent ${incumbent.strategy} ${f3(rescore)} × ${(1 + margin).toFixed(2)}, ${basis})`,
      };
    }
    return {
      action: 'keep',
      reason: `Kandidat ${cand.strategy} Score ${f3(cand.score)} < ${f3(needed)} (Incumbent ${incumbent.strategy} ${f3(rescore)} × ${(1 + margin).toFixed(2)}, ${basis}) — Marge nicht erreicht`,
    };
  }

  const why = candidate ? `bester Kandidat ${candidate.entry.strategy} (Score ${f3(candidate.entry.score)}) fällt durch die Gates` : 'kein bewertbarer Kandidat';
  if (incumbent) {
    if (incumbentPass === false) {
      return { action: 'demote_to_notrade', reason: `${why}; Incumbent ${incumbent.strategy} reißt die Gates auf sauberem OOS (Score ${f3(incumbentRescore)}) — kein Handel` };
    }
    if (incumbentRescore !== null && incumbentRescore > 0) {
      const how = incumbentPass === true ? 'besteht die Gates auf sauberem OOS' : 'ungeprüft (zu wenig sauberes OOS), Beförderungs-Score gilt weiter';
      return { action: 'keep', reason: `${why}; Incumbent ${incumbent.strategy} hält Score ${f3(incumbentRescore)} > 0 — ${how}` };
    }
    return {
      action: 'demote_to_notrade',
      reason: `${why}; Incumbent ${incumbent.strategy} ${incumbentRescore === null ? 'nicht mehr bewertbar' : `Score ${f3(incumbentRescore)} ≤ 0 auf sauberem OOS`} — kein Handel`,
    };
  }
  return { action: 'stay_notrade', reason: `${why}; kein Champion — kein Handel` };
}

/* ───────────────────────── Anwenden ───────────────────────── */

/** Nicht-endliche Scores (−∞ bei 0 Trades) als null persistieren — JSON kennt kein Infinity. */
export function finiteOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Entscheidung auf die Champion-Datei anwenden (neues Objekt; nur dieses Symbol ändert sich). */
export function applyDecision(a: {
  file: ChampionFile;
  symbol: string;
  decision: PromotionDecision;
  candidate: ChampionEntry | null;
  bestScore: number | null;
  now: Ms;
}): ChampionFile {
  const symbols = { ...a.file.symbols };
  const noTrade = { ...a.file.noTrade };
  const note: NoTradeEntry = { reason: a.decision.reason, decidedAt: a.now, bestScore: finiteOrNull(a.bestScore) };
  switch (a.decision.action) {
    case 'promote':
      if (!a.candidate) throw new Error(`promote ohne Kandidat für ${a.symbol}`);
      symbols[a.symbol] = { ...a.candidate, score: finiteOrNull(a.candidate.score) ?? 0, decidedAt: a.now };
      delete noTrade[a.symbol];
      break;
    case 'keep':
      break;
    case 'demote_to_notrade':
      delete symbols[a.symbol];
      noTrade[a.symbol] = note;
      break;
    case 'stay_notrade':
      // Ein alter Eintrag darf nicht stehen bleiben: „kein Handel" gilt für das
      // Symbol, auch wenn es früher Teil eines geprüften Korbs war. Nach einem
      // Korbwechsel ist das der Normalfall — sonst handelte es weiter mit
      // einem Champion, den kein Lauf mehr nachgerechnet hat (Prüfbefund 4.1).
      delete symbols[a.symbol];
      noTrade[a.symbol] = note;
      break;
  }
  return { version: 1, updatedAt: a.now, symbols, noTrade };
}

/** Journal-Eintrag 'champion' — die Wahrheit darüber, wer wann warum handeln durfte. */
export function journalDecision(
  journal: Journal,
  a: {
    symbol: string;
    decision: PromotionDecision;
    chosen: ChampionEntry | null;
    candidate: ChampionEntry | null;
    candidatePass: boolean;
    incumbentRescore: number | null;
    incumbentPass?: boolean | null | undefined;
    now: Ms;
  },
): void {
  journal.append(
    'champion',
    {
      symbol: a.symbol,
      action: a.decision.action,
      reason: a.decision.reason,
      strategy: a.chosen?.strategy ?? null,
      params: a.chosen?.params ?? null,
      fitEnd: a.chosen ? fitEndOf(a.chosen) : null,
      candidateStrategy: a.candidate?.strategy ?? null,
      candidateScore: finiteOrNull(a.candidate?.score),
      candidatePass: a.candidatePass,
      incumbentRescore: finiteOrNull(a.incumbentRescore),
      incumbentPass: a.incumbentPass ?? null,
    },
    a.now,
  );
}
