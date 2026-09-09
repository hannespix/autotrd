/**
 * „Nicht bewertbar" ist kein Erfolg.
 *
 * Am 09.09.2026 meldeten zwei Läufe „success" — nach 25 bzw. 31 Sekunden.
 * Der Backfill konnte nicht nach hinten wachsen, fand 127 statt 815 bzw.
 * 2900 Tage, und jede Einheit endete mit „nicht bewertbar". Der Champion
 * blieb korrekt unverändert; aber der Workflow war grün, und niemand suchte
 * nach einem Fehler, den es nicht zu geben schien.
 *
 * Der Unterschied, den diese Datei festhält:
 *
 *   gemessen und durchgefallen  ⇒ „kein Handel" — ein Urteil, Erfolg, Code 0
 *                                  (CLAUDE.md §0.9: niemand hilft nach)
 *   gar nicht erst gemessen     ⇒ Fehler, Code 3
 *
 * Wer das verwechselt, macht entweder jede ehrliche Nullrunde zum Alarm oder
 * jede Datenpanne unsichtbar. Beides kostet: das eine Vertrauen, das andere
 * Messungen.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Strategy } from '../../src/core/types.ts';
import { nichtsGemessen, runOptimization, type OptimizeRunInput, type SymbolRun } from '../../src/optimize/run.ts';
import { DEAD_PROFILE, NOISE_PROFILE, REWARD_PROFILE, dailyBars, fakeMetricsFns, fakeStrategy, makeFakeSimulate, testConfig, type FakeSimOptions } from './fakes.ts';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const GENUG = dailyBars(400);
const ZU_WENIG = dailyBars(100);

const strategies: Record<string, Strategy> = { edge: fakeStrategy('edge'), dead: fakeStrategy('dead') };
const profiles: Record<string, FakeSimOptions> = { edge: REWARD_PROFILE, dead: DEAD_PROFILE };
const getStrategy = (id: string): Strategy => {
  const s = strategies[id];
  if (!s) throw new Error(`unbekannte Strategie ${id}`);
  return s;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'autotrd-nichts-'));
  dirs.push(d);
  return d;
};

function input(over: { symbols?: string[]; strategies?: string[]; barsFor?: OptimizeRunInput['barsFor'] } = {}): OptimizeRunInput {
  const home = tmp();
  const symbols = over.symbols ?? ['AAA', 'BBB'];
  return {
    config: testConfig({ symbols, home, optimizer: { seed: 7 } }),
    symbols,
    strategies: over.strategies ?? ['edge'],
    barsFor: over.barsFor ?? (() => GENUG),
    home,
    initialEquity: 10_000,
    simulate: makeFakeSimulate((id) => profiles[id] ?? NOISE_PROFILE),
    metricsFns: fakeMetricsFns,
    getStrategy,
    now: () => NOW,
  };
}

describe('nichtsGemessen: Datenpanne und Nullrunde auseinanderhalten', () => {
  it('zu wenig Historie für JEDE Einheit ⇒ nichts gemessen', () => {
    const out = runOptimization(input({ barsFor: () => ZU_WENIG }));
    expect(out.runs).toHaveLength(2);
    for (const r of out.runs) {
      expect(r.results).toEqual([]);
      expect(r.decision.reason).toMatch(/nicht bewertbar/);
    }
    expect(nichtsGemessen(out.runs)).toBe(true);
  });

  it('gemessen und durch die Gates gefallen ist KEIN „nichts gemessen" — kein Handel bleibt ein Urteil', () => {
    // Die sicher verlierende Strategie läuft vollständig durch alle Folds
    // und fällt durch. Das ist das Ergebnis, das CLAUDE.md §0.9 schützt.
    const out = runOptimization(input({ strategies: ['dead'] }));
    for (const r of out.runs) {
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.decision.action).toBe('stay_notrade');
      expect(r.chosen).toBeNull();
    }
    expect(nichtsGemessen(out.runs)).toBe(false);
  });

  it('eine bewertbare Einheit genügt: teilweise Messung ist Messung, die Fehler stehen im Bericht', () => {
    const out = runOptimization(input({ barsFor: (s) => (s === 'AAA' ? GENUG : ZU_WENIG) }));
    const aaa = out.runs.find((r) => r.symbol === 'AAA')!;
    const bbb = out.runs.find((r) => r.symbol === 'BBB')!;
    expect(aaa.results.length).toBeGreaterThan(0);
    expect(bbb.results).toEqual([]);
    expect(nichtsGemessen(out.runs)).toBe(false);
    // Die Panne bleibt sichtbar — nur eben als Zeile, nicht als Fehlercode.
    expect(readFileSync(out.reportPath, 'utf8')).toMatch(/nicht bewertbar/);
  });

  it('ohne Einheiten gibt es nichts zu beurteilen — das fängt das Config-Schema vorher ab (symbols ≥ 1)', () => {
    expect(nichtsGemessen([])).toBe(false);
  });

  it('prüft results, nicht den Wortlaut der Begründung', () => {
    // Eine Einheit, deren Begründung „nicht bewertbar" enthält, aber die ein
    // Ergebnis hat, ist gemessen. Umgekehrt ist eine ohne Ergebnis ungemessen,
    // wie auch immer die Begründung lautet. Die Wörter sind kein Vertrag.
    const mitErgebnis = { results: [{} as SymbolRun['results'][number]], decision: { action: 'stay_notrade', reason: 'nicht bewertbar (nur im Text)' } } as unknown as SymbolRun;
    const ohneErgebnis = { results: [], decision: { action: 'stay_notrade', reason: 'kein bewertbarer Kandidat' } } as unknown as SymbolRun;
    expect(nichtsGemessen([mitErgebnis])).toBe(false);
    expect(nichtsGemessen([ohneErgebnis])).toBe(true);
  });
});

describe('cmdOptimize: Bericht zuerst, Fehlercode danach', () => {
  const cli = readFileSync('src/cli.ts', 'utf8');
  const body = (() => {
    const i = cli.indexOf('async function cmdOptimize(');
    const j = cli.indexOf('\nasync function ', i + 1);
    return cli.slice(i, j > 0 ? j : cli.length);
  })();

  it('beendet sich mit Code 3, wenn nichts gemessen wurde', () => {
    expect(body).toContain('nichtsGemessen(res.runs)');
    expect(body).toMatch(/nichtsGemessen\(res\.runs\)\)\s*\{[\s\S]*?return 3;/);
  });

  it('schreibt Journal und Bericht VOR dem Fehlercode — wer den Lauf untersucht, braucht genau diesen Bericht', () => {
    const journal = body.indexOf("journal.append('champion'");
    const pruefung = body.indexOf('nichtsGemessen(res.runs)');
    expect(journal).toBeGreaterThan(0);
    expect(pruefung).toBeGreaterThan(journal);
  });

  it('dokumentiert den Code im Kopf der CLI und grenzt ihn von „kein Handel" ab', () => {
    const kopf = cli.slice(0, cli.indexOf('import '));
    expect(kopf).toMatch(/3 = `optimize` hat NICHTS gemessen/);
    expect(kopf).toMatch(/Kein Handel.*Code 0/);
  });
});
