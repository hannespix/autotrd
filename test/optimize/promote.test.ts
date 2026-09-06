import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from '../../src/core/journal.ts';
import {
  applyDecision,
  decidePromotion,
  emptyChampionFile,
  finiteOrNull,
  fitEndOf,
  journalDecision,
  loadChampion,
  saveChampion,
  type ChampionEntry,
  type PromotionInput,
} from '../../src/optimize/promote.ts';

function entry(strategy: string, score: number, extra: Partial<ChampionEntry> = {}): ChampionEntry {
  return {
    strategy,
    params: { a: 1 },
    timeframe: 1440,
    score,
    oos: {
      objectiveMedian: score,
      objectiveMean: score,
      positiveFoldShare: 1,
      trades: 100,
      netProfit: 10,
      netReturnPct: 1,
      maxDrawdownPct: 1,
      dailyReturns: [],
      profitFactor: null,
      feeShare: null,
    },
    gates: [],
    decidedAt: 1,
    trials: 10,
    dataRange: { start: 0, end: 1 },
    ...extra,
  };
}

describe('decidePromotion', () => {
  const inc = entry('old', 1);
  const decide = (over: Partial<PromotionInput>) =>
    decidePromotion({ incumbent: inc, incumbentRescore: 1, incumbentPass: true, candidate: { entry: entry('new', 2), pass: true }, margin: 0.1, ...over });

  it('erste Beförderung ohne Incumbent', () => {
    const d = decide({ incumbent: null, incumbentRescore: null, incumbentPass: null, candidate: { entry: entry('new', 0.5), pass: true } });
    expect(d.action).toBe('promote');
    expect(d.reason).toMatch(/erste Beförderung/);
  });

  it('Marge: Kandidat muss rescore × (1 + margin) erreichen', () => {
    const at = (score: number) => decide({ candidate: { entry: entry('new', score), pass: true } }).action;
    expect(at(1.05)).toBe('keep');
    expect(at(1.0999)).toBe('keep');
    expect(at(1.1)).toBe('promote');
    expect(at(2)).toBe('promote');
    expect(decide({ candidate: { entry: entry('new', 1.05), pass: true }, margin: 0 }).action).toBe('promote');
    expect(decide({ candidate: { entry: entry('new', 1.05), pass: true } }).reason).toMatch(/Marge nicht erreicht/);
  });

  it('der Vergleich läuft gegen den RE-SCORE auf sauberem OOS, nicht gegen den alten Champion-Score', () => {
    // alter Score 1, heute nur noch 0.5 ⇒ Kandidat 0.6 reicht
    expect(decide({ incumbentRescore: 0.5, candidate: { entry: entry('new', 0.6), pass: true } }).action).toBe('promote');
  });

  it('ungeprüfter Incumbent (zu wenig sauberes OOS): Beförderungs-Score als Maßstab, Marge gilt', () => {
    const d = decide({ incumbentRescore: 1, incumbentPass: null, candidate: { entry: entry('new', 1.05), pass: true } });
    expect(d.action).toBe('keep');
    expect(d.reason).toMatch(/Beförderungs-Score, kein sauberes OOS/);
    expect(decide({ incumbentRescore: 1, incumbentPass: null, candidate: { entry: entry('new', 1.2), pass: true } }).action).toBe('promote');
  });

  it('Incumbent reißt die Gates: bestandener Kandidat übernimmt ohne Marge', () => {
    const d = decide({ incumbentRescore: 5, incumbentPass: false, candidate: { entry: entry('new', 0.2), pass: true } });
    expect(d.action).toBe('promote');
    expect(d.reason).toMatch(/reißt die Gates/);
  });

  it('Incumbent ohne Kante (rescore ≤ 0 oder null): Kandidat mit Score > 0 übernimmt', () => {
    expect(decide({ incumbentRescore: -0.2, candidate: { entry: entry('new', 0.3), pass: true } }).action).toBe('promote');
    expect(decide({ incumbentRescore: 0, candidate: { entry: entry('new', 0.3), pass: true } }).action).toBe('promote');
    expect(decide({ incumbentRescore: null, incumbentPass: null, candidate: { entry: entry('new', 0.3), pass: true } }).action).toBe('promote');
    expect(decide({ incumbentRescore: -0.2, candidate: { entry: entry('new', -0.1), pass: true } }).action).toBe('keep');
  });

  it('Kandidat fällt durch: Incumbent mit Kante bleibt, ohne Kante oder mit gerissenen Gates ⇒ kein Handel', () => {
    const fail = { entry: entry('new', 2), pass: false };
    const keep = decide({ incumbentRescore: 0.5, candidate: fail });
    expect(keep.action).toBe('keep');
    expect(keep.reason).toMatch(/fällt durch/);
    expect(keep.reason).toMatch(/besteht die Gates/);
    const unchecked = decide({ incumbentRescore: 0.5, incumbentPass: null, candidate: fail });
    expect(unchecked.action).toBe('keep');
    expect(unchecked.reason).toMatch(/ungeprüft/);
    expect(decide({ incumbentRescore: 0, candidate: fail }).action).toBe('demote_to_notrade');
    expect(decide({ incumbentRescore: -1, candidate: fail }).action).toBe('demote_to_notrade');
    expect(decide({ incumbentRescore: null, incumbentPass: null, candidate: fail }).action).toBe('demote_to_notrade');
    const torn = decide({ incumbentRescore: 3, incumbentPass: false, candidate: fail });
    expect(torn.action).toBe('demote_to_notrade');
    expect(torn.reason).toMatch(/reißt die Gates/);
    expect(decide({ incumbentRescore: 3, incumbentPass: false, candidate: null }).action).toBe('demote_to_notrade');
  });

  it('kein Incumbent und kein bestandener Kandidat ⇒ stay_notrade', () => {
    expect(decide({ incumbent: null, incumbentRescore: null, incumbentPass: null, candidate: { entry: entry('new', 2), pass: false } }).action).toBe('stay_notrade');
    const d = decide({ incumbent: null, incumbentRescore: null, incumbentPass: null, candidate: null });
    expect(d.action).toBe('stay_notrade');
    expect(d.reason).toMatch(/kein bewertbarer Kandidat/);
  });

  it('ein durchgefallener Kandidat wird nie befördert — auch mit hohem Score', () => {
    const d = decide({ incumbent: null, incumbentRescore: null, incumbentPass: null, candidate: { entry: entry('new', 99), pass: false }, margin: 0 });
    expect(d.action).not.toBe('promote');
  });
});

describe('fitEndOf', () => {
  it('nimmt fitEnd, sonst konservativ decidedAt (alte Dateien)', () => {
    expect(fitEndOf(entry('s', 1, { decidedAt: 500, fitEnd: 400 }))).toBe(400);
    expect(fitEndOf(entry('s', 1, { decidedAt: 500 }))).toBe(500);
  });
});

describe('applyDecision & Champion-Datei', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'autotrd-promote-'));
    dirs.push(d);
    return d;
  };

  it('promote setzt den Champion (inkl. fitEnd) und löscht noTrade; keep ändert nichts', () => {
    const file = { ...emptyChampionFile(0), noTrade: { AAA: { reason: 'x', decidedAt: 0, bestScore: null } } };
    const cand = entry('new', 1.5, { fitEnd: 77 });
    const out = applyDecision({ file, symbol: 'AAA', decision: { action: 'promote', reason: 'r' }, candidate: cand, bestScore: 1.5, now: 42 });
    expect(out.symbols.AAA).toEqual({ ...cand, decidedAt: 42 });
    expect(out.symbols.AAA!.fitEnd).toBe(77);
    expect(out.noTrade.AAA).toBeUndefined();
    expect(out.updatedAt).toBe(42);
    // Eingabe unverändert (neues Objekt)
    expect(file.symbols.AAA).toBeUndefined();
    const kept = applyDecision({ file: out, symbol: 'AAA', decision: { action: 'keep', reason: 'r' }, candidate: null, bestScore: 0.1, now: 43 });
    expect(kept.symbols.AAA).toEqual(out.symbols.AAA);
    expect(kept.noTrade.AAA).toBeUndefined();
  });

  it('demote_to_notrade entfernt den Champion und notiert den besten Score; stay_notrade frischt auf', () => {
    const file = { ...emptyChampionFile(0), symbols: { AAA: entry('old', 1) } };
    const out = applyDecision({ file, symbol: 'AAA', decision: { action: 'demote_to_notrade', reason: 'tot' }, candidate: null, bestScore: -0.3, now: 7 });
    expect(out.symbols.AAA).toBeUndefined();
    expect(out.noTrade.AAA).toEqual({ reason: 'tot', decidedAt: 7, bestScore: -0.3 });
    const stay = applyDecision({ file: out, symbol: 'AAA', decision: { action: 'stay_notrade', reason: 'immer noch' }, candidate: null, bestScore: -Infinity, now: 8 });
    expect(stay.noTrade.AAA).toEqual({ reason: 'immer noch', decidedAt: 8, bestScore: null });
  });

  it('andere Symbole bleiben unberührt', () => {
    const file = { ...emptyChampionFile(0), symbols: { BBB: entry('b', 1) }, noTrade: { CCC: { reason: 'c', decidedAt: 1, bestScore: 0 } } };
    const out = applyDecision({ file, symbol: 'AAA', decision: { action: 'promote', reason: 'r' }, candidate: entry('a', 1), bestScore: 1, now: 1 });
    expect(out.symbols.BBB).toEqual(file.symbols.BBB);
    expect(out.noTrade.CCC).toEqual(file.noTrade.CCC);
  });

  it('promote ohne Kandidat ist ein Programmierfehler', () => {
    expect(() => applyDecision({ file: emptyChampionFile(0), symbol: 'AAA', decision: { action: 'promote', reason: 'r' }, candidate: null, bestScore: 1, now: 1 })).toThrow(/ohne Kandidat/);
  });

  it('save/load Roundtrip; fehlende Datei ⇒ null; fremde Version ⇒ Fehler', () => {
    const dir = tmp();
    const path = join(dir, 'champion.json');
    expect(loadChampion(path)).toBeNull();
    const file = { ...emptyChampionFile(5), symbols: { AAA: entry('s', 1.25, { fitEnd: 9 }) } };
    saveChampion(path, file);
    expect(loadChampion(path)).toEqual(file);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => loadChampion(path)).toThrow(/Version/);
  });

  it('finiteOrNull macht ±∞ und undefined zu null', () => {
    expect(finiteOrNull(1.5)).toBe(1.5);
    expect(finiteOrNull(-Infinity)).toBeNull();
    expect(finiteOrNull(undefined)).toBeNull();
    expect(finiteOrNull(null)).toBeNull();
  });

  it('journalDecision schreibt einen champion-Eintrag mit fitEnd und Gate-Status', () => {
    const dir = tmp();
    const journal = new Journal(join(dir, 'journal.jsonl'));
    journalDecision(journal, {
      symbol: 'AAA',
      decision: { action: 'promote', reason: 'weil' },
      chosen: entry('s', 1, { fitEnd: 123 }),
      candidate: entry('s', 1),
      candidatePass: true,
      incumbentRescore: -Infinity,
      incumbentPass: false,
      now: 99,
    });
    const events = journal.readAll();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ ts: 99, kind: 'champion', symbol: 'AAA', action: 'promote', strategy: 's', fitEnd: 123, candidatePass: true, incumbentRescore: null, incumbentPass: false });
  });
});
