/**
 * Symbolprofil auf der Plattform: das Dokument `meta/symbolProfile` mit dem
 * Firestore-Fake, und der Abgleich mit der Wahl des Takts
 * (`buildStrategyFor`, functions/src/engine/strategyFor.ts).
 *
 * Wächter: Das Profil, das nachts aus `strategyForFn(app)` entsteht, sagt je
 * Symbol dasselbe wie die Wahl, mit der der Takt handelt — beide laufen über
 * `core/basisTier.ts`. Ein Symbol ohne Wahl im Takt trägt im Profil keine
 * Taktik.
 */
import { describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { setLogSink } from '../../src/core/log.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import type { ChampionFile } from '../../src/optimize/promote.ts';
import { buildSymbolProfiles } from '../../src/profile/symbolprofile.ts';
import { buildStrategyFor, championFromDoc } from '../src/engine/strategyFor.ts';
import { FakeFirestore, FakeTimestamp } from './fakes/firestore.ts';
// @ts-expect-error — .mjs ohne Typen
import { SYMBOL_PROFILE_PFAD, veroeffentlicheProfil } from '../../scripts/module/symbolProfile.mjs';

setLogSink(() => undefined);

function handelstage(n: number): number[] {
  const out: number[] = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(msFromET(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const TAGE = handelstage(300);
const serie = (k: number): BarSeries =>
  BarSeries.from(
    TAGE.map((t, i): Bar => {
      const c = (80 + k) * (1 + i / 500) * (1 + (i % 2 === 0 ? 0.004 : -0.004));
      return { t, o: c, h: c * 1.01, l: c * 0.99, c, v: 700_000 };
    }),
  );

const KORB = ['SPY', 'IWM', 'EFA', 'EEM', 'IEF', 'TLT', 'LQD', 'GLD', 'XLRE'];
const config = parseConfig({ universe: { symbols: ['SPY', 'AAPL', 'MSFT'], benchmark: 'SPY', candidates: ['AAPL', 'MSFT', ...KORB] }, timeframe: 1440, strategy: { basis: true } });
const doc = {
  version: 1,
  updatedAt: 5,
  symbols: { AAPL: { strategy: 'trend_donchian', params: { entryLen: 30 }, timeframe: 1440, score: 1, oos: { trades: 70, netProfit: 1 }, gates: [], decidedAt: 2, trials: 3, dataRange: {} } },
  noTrade: { MSFT: { reason: 'nichts besteht', decidedAt: 3, bestScore: null } },
  basis: { version: 1, strategy: 'regime_allocation', params: { lookback: 126, skip: 21, regimeLen: 150, topPct: 0.4, exitPct: 0.6, stopPct: 20 }, symbols: KORB, label: 'Basis V3', timeframe: 1440, pass: false, gates: [], measuredAt: 4, positionPct: 20 },
};
const champion = championFromDoc(doc as Record<string, unknown>) as ChampionFile;
const serien = new Map([...config.universe.symbols, ...KORB].map((s, k) => [s, serie(k)] as const));

function profil() {
  const map = buildStrategyFor({ champion, config });
  return buildSymbolProfiles({
    config,
    champion,
    choiceFor: map.fn,
    barsFor: (s) => serien.get(s)!,
    now: TAGE[299]! + 8 * 3_600_000, // nach dem Schluss der letzten Bar
    lauf: { nummer: 7, id: 'x', configCommit: null },
    generatedAt: 1,
  });
}

describe('Symbolprofil ⇄ Wahl des Takts', () => {
  it('je Symbol dieselbe Quelle, Strategie und Einstiegssperre wie buildStrategyFor; ohne Wahl keine Taktik', () => {
    const map = buildStrategyFor({ champion, config });
    const file = profil();
    for (const p of file.profile) {
      const c = map.fn(p.symbol);
      expect(p.taktik.quelle, p.symbol).toBe(c?.source ?? 'keine');
      expect(p.taktik.strategie, p.symbol).toBe(c?.strategy.id ?? null);
      expect(p.taktik.einstiege, p.symbol).toBe(c ? (c.entriesAllowed === false ? 'gesperrt' : 'erlaubt') : null);
    }
    expect(file.profile.find((p) => p.symbol === 'AAPL')!.taktik.quelle).toBe('champion');
    expect(file.profile.find((p) => p.symbol === 'MSFT')!.taktik).toMatchObject({ quelle: 'keine', strategie: null });
    // Der Takt kennt nur sein Universum: Basis-Symbole außerhalb (GLD) haben im Takt keine Wahl — und im Profil keine Taktik.
    expect(map.fn('GLD')).toBeNull();
    expect(file.profile.find((p) => p.symbol === 'GLD')!.taktik).toMatchObject({ quelle: 'keine', imEngineUniversum: false });
    // SPY steht im Universum UND im Basis-Korb: Basis ohne Latte ⇒ geführt, gesperrt.
    expect(file.profile.find((p) => p.symbol === 'SPY')!.taktik).toMatchObject({ quelle: 'basis', einstiege: 'gesperrt' });
  });
});

describe('meta/symbolProfile mit dem Firestore-Fake', () => {
  it('schreibt EIN Dokument mit dem Profil unverändert plus publishedAt — lesbar wie geschrieben', async () => {
    const db = new FakeFirestore();
    const file = profil();
    const r = await veroeffentlicheProfil(db, file, FakeTimestamp.now());
    expect(r.pfad).toBe(SYMBOL_PROFILE_PFAD);
    expect(db.log).toEqual(['set meta/symbolProfile']);
    const gelesen = db.get('meta/symbolProfile')!;
    expect(gelesen.version).toBe(1);
    // Der Fake klont (structuredClone) — aus dem Timestamp wird ein Objekt mit denselben Feldern.
    expect(gelesen.publishedAt).toMatchObject({ seconds: expect.any(Number), nanoseconds: expect.any(Number) });
    const { publishedAt: _ts, ...rest } = gelesen;
    expect(rest).toEqual(JSON.parse(JSON.stringify(file)));
  });

  it('ein kaputtes Profil erreicht Firestore nie', async () => {
    const db = new FakeFirestore();
    await expect(veroeffentlicheProfil(db, { version: 3, profile: [] }, FakeTimestamp.now())).rejects.toThrow(/Version 3/);
    expect(db.log).toEqual([]);
  });
});
