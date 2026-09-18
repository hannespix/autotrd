/**
 * Das Champion-Dokument für Firestore (scripts/module/championDoc.mjs).
 *
 * ── Warum diese Wächter existieren ────────────────────────────────────────
 *
 * Lauf #18 (18.09.2026) brachte die ERSTE Beförderung seit dem Neubau — und
 * die Veröffentlichung starb: `INDEX_ENTRIES_COUNT_LIMIT_EXCEEDED` auf
 * `meta/champion`. Dreißig Einträge mit je ~1 100 `dailyReturns` und
 * ~1 100 `dayKeys` sind rund 66 000 indizierte Array-Elemente gegen ein
 * Limit von 40 000. Solange `symbols` leer war, konnte es niemand merken.
 *
 * Der wichtigste Test hier ist deshalb der erste: Das Dokument eines
 * REALISTISCHEN Champions (30 Symbole, 18 Folds à 90 Tage) muss roh über
 * dem Limit liegen und verschlankt weit darunter — sonst prüft das Modul
 * nicht den Fall, an dem es gescheitert ist.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs ohne Typen (wie test/scripts/warum.test.ts)
import { INDEX_WERTE_MAX, KETTEN_FELDER, ausFirestoreDoc, fuerFirestore, indexWerte, pruefeDokument } from '../../scripts/module/championDoc.mjs';

/** Ein Champion-Eintrag, wie `toEntry` in run.ts ihn schreibt — mit der vollen OOS-Kette. */
function eintrag(tage: number) {
  return {
    strategy: 'cross_sectional_momentum',
    params: { lookback: 60, skip: 1, topPct: 0.2, exitPct: 0.6, volAdjust: 1, atrLen: 14, atrMult: 2.5, trailMult: 0 },
    timeframe: 1440,
    score: 3.357,
    oos: {
      objectiveMedian: 3.357,
      objectiveMean: 3.1,
      positiveFoldShare: 0.83,
      trades: 424,
      netProfit: 7476.09,
      netReturnPct: 29.9,
      maxDrawdownPct: 8.79,
      dailyReturns: Array.from({ length: tage }, (_, i) => Math.sin(i) / 100),
      dayKeys: Array.from({ length: tage }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')}`),
      profitFactor: 1.6,
      feeShare: 0.31,
    },
    gates: Array.from({ length: 10 }, (_, i) => ({ name: `gate_${i}`, pass: true, value: i, threshold: i, note: 'Zins: Überschuss über BIL' })),
    decidedAt: 1789693728309,
    trials: 2850,
    dataRange: { start: 1, end: 2 },
    fitEnd: 1789000000000,
    foldMembership: 'point_in_time',
  };
}
const SYMBOLE = ['SPY', 'NVDA', 'MU', 'AAPL', 'MSFT', 'QQQ', 'AMZN', 'META', 'IWM', 'AMD', 'LQD', 'INTC', 'GOOGL', 'TSLA', 'AVGO', 'SMH', 'GOOG', 'SOXX', 'HYG', 'AMAT', 'NFLX', 'ORCL', 'XLE', 'BAC', 'MRVL', 'XLF', 'LRCX', 'LLY', 'XLV', 'WMT'];
/** 18 Folds à 90 Kalendertage ≈ 1 120 Handelstage in der OOS-Kette. */
const KETTE = 1120;
function champion() {
  return {
    version: 1,
    updatedAt: 1789693728309,
    symbols: Object.fromEntries(SYMBOLE.map((s) => [s, eintrag(KETTE)])),
    noTrade: {},
    basis: null,
  };
}

describe('Champion-Dokument für Firestore', () => {
  it('WÄCHTER: der Champion aus Lauf #18 liegt ROH über dem Firestore-Limit und verschlankt weit darunter', () => {
    const roh = champion();
    expect(indexWerte(roh), '30 Einträge × 2 Ketten × 1 120 — genau das ist am 18.09. gescheitert').toBeGreaterThan(40_000);
    const doc = fuerFirestore(roh);
    const p = pruefeDokument(doc);
    expect(p.ok, 'verschlankt muss es durch die Prüfung').toBe(true);
    expect(p.werte).toBeLessThan(3_000);
    expect(indexWerte(doc)).toBeLessThan(INDEX_WERTE_MAX);
  });

  it('entfernt GENAU die Ketten — und lässt alles, was Engine und Frontend lesen', () => {
    const doc = fuerFirestore(champion());
    const e = doc.symbols.SPY;
    for (const f of KETTEN_FELDER) expect(e.oos[f], `${f} darf nicht nach Firestore`).toBeUndefined();
    // Engine (strategyFor.ts): strategy, params, timeframe.
    expect(e.strategy).toBe('cross_sectional_momentum');
    expect(e.params).toEqual(eintrag(1).params);
    expect(e.timeframe).toBe(1440);
    // Frontend (data.ts, ChampionEntryDoc): die Skalare aus oos, gates, score, decidedAt, trials.
    expect(e.oos).toMatchObject({ trades: 424, netProfit: 7476.09, netReturnPct: 29.9, positiveFoldShare: 0.83, profitFactor: 1.6, maxDrawdownPct: 8.79, feeShare: 0.31 });
    expect(e.gates).toHaveLength(10);
    expect(e.score).toBe(3.357);
    // Optimierer (promote.ts, Re-Score des Amtsinhabers): fitEnd, foldMembership, decidedAt.
    expect(e.fitEnd).toBe(1789000000000);
    expect(e.foldMembership).toBe('point_in_time');
    expect(e.decidedAt).toBe(1789693728309);
  });

  it('lässt die Eingabe unverändert — die lokale Datei bleibt vollständig', () => {
    const roh = champion();
    fuerFirestore(roh);
    expect(roh.symbols.SPY!.oos.dailyReturns).toHaveLength(KETTE);
    expect(roh.symbols.SPY!.oos.dayKeys).toHaveLength(KETTE);
  });

  it('WÄCHTER: ein Dokument über der Obergrenze wird ABGELEHNT, bevor Firestore es tut', () => {
    const doc = fuerFirestore(champion());
    // Ein künftiger Block, der wieder eine Zeitreihe mitbringt:
    (doc as Record<string, unknown>).basis = { equityKurve: Array.from({ length: INDEX_WERTE_MAX + 1 }, () => 1) };
    const p = pruefeDokument(doc);
    expect(p.ok).toBe(false);
    expect(p.ok ? '' : p.grund).toMatch(/indizierbare Werte/);
  });

  it('noTrade, erprobung und basis gehen unverändert mit', () => {
    const roh = { ...champion(), symbols: {}, noTrade: { AAA: { reason: 'r', decidedAt: 1, bestScore: 0.1 } }, erprobung: { AAA: { version: 1, strategy: 's', params: { a: 1 }, timeframe: 1440, score: 1, failed: ['x'], decidedAt: 1, tradesPerMonth: 6.6, auswahl: 'w' } }, basis: { strategy: 'b', label: 'L', pass: false, symbols: ['A'], gates: [] } };
    const doc = fuerFirestore(roh);
    expect(doc.noTrade).toEqual(roh.noTrade);
    expect(doc.erprobung).toEqual(roh.erprobung);
    expect(doc.basis).toEqual(roh.basis);
  });

  it('indexWerte zählt Skalare, Array-Elemente und Map-Werte — nie weniger als Firestore', () => {
    expect(indexWerte(1)).toBe(1);
    expect(indexWerte([1, 2, 3])).toBe(3);
    expect(indexWerte({ a: 1, b: [1, 2], c: { d: 'x' } })).toBe(4);
    expect(indexWerte([[1, 2], [3]])).toBe(3);
    expect(indexWerte([])).toBe(0);
  });
});

describe('Rückweg: meta/champion ⇒ var/champion.json (fetch-champion.mjs)', () => {
  it('liefert die Datei-Form ohne publishedAt; fehlendes Dokument ⇒ null', () => {
    const doc = { ...fuerFirestore(champion()), publishedAt: { seconds: 1, nanoseconds: 0 } };
    const datei = ausFirestoreDoc(doc);
    expect(datei).not.toBeNull();
    expect('publishedAt' in datei!).toBe(false);
    expect(Object.keys(datei!.symbols)).toHaveLength(30);
    expect(datei!.version).toBe(1);
    expect(ausFirestoreDoc(undefined)).toBeNull();
  });

  it('nimmt basis und erprobung nur mit, wenn vorhanden — leere Erprobung fällt weg', () => {
    const d = ausFirestoreDoc({ version: 1, updatedAt: 5, symbols: {}, noTrade: {}, basis: null, erprobung: {} });
    expect(d).toEqual({ version: 1, updatedAt: 5, symbols: {}, noTrade: {} });
  });

  it('WÄCHTER: fremde Version wirft — nie raten (wie loadChampion)', () => {
    expect(() => ausFirestoreDoc({ version: 2, symbols: {} })).toThrow(/Champion-Version/);
  });
});

describe('Naht: publish-champion.mjs benutzt das Modul', () => {
  it('verschlankt und prüft VOR dem Batch — sonst ist der 18.09. jederzeit wieder da', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../scripts/publish-champion.mjs', import.meta.url), 'utf8');
    expect(text).toMatch(/import \{[^}]*fuerFirestore[^}]*\} from '\.\/module\/championDoc\.mjs'/);
    const iPruef = text.indexOf('pruefeDokument(');
    const iBatch = text.indexOf('batch.commit()');
    expect(iPruef).toBeGreaterThan(0);
    expect(iPruef, 'die Prüfung muss VOR dem Commit stehen').toBeLessThan(iBatch);
    expect(text).toMatch(/batch\.set\(db\.doc\(CHAMPION_PFAD\), \{ \.\.\.doc,/);
  });

  it('der nächtliche Workflow holt den Amtsinhaber VOR der Optimierung', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync(new URL('../../.github/workflows/optimize.yml', import.meta.url), 'utf8');
    const iFetch = yml.indexOf('scripts/fetch-champion.mjs');
    const iOpt = yml.indexOf('src/cli.ts optimize');
    const iSa = yml.indexOf('firebase-sa.json');
    expect(iFetch, 'ohne diesen Schritt entscheidet jede Nacht von vorn').toBeGreaterThan(0);
    expect(iFetch).toBeLessThan(iOpt);
    expect(iSa, 'der Service-Account muss vor dem Holen liegen').toBeLessThan(iFetch);
  });
});
