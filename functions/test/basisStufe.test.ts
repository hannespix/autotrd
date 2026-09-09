/**
 * Die Basis-Stufe im Takt — Ende zu Ende gegen Fake-Firestore und Fake-Broker:
 *
 *  1. Der Korb des Champion-Blocks `basis` kommt ins Universum der Engine
 *     (MSFT steht nicht im Plattform-Universum) und handelt mit ALLOKATIONS-
 *     Sizing: 10 % der Equity ⇒ 99 Stück, nicht die 199 des Risiko-Budgets.
 *     Positions- und Trade-Docs tragen die Stufe „basis"; der Spiegel nennt
 *     die Basis-Symbole.
 *  2. Schalter aus (`settings.auto.basis: false`) ⇒ kein Basis-Symbol im
 *     Universum, keine Order.
 *  3. `pass: false` ⇒ dasselbe.
 *  4. Verriegelter Order-Pfad (Echtgeld-Kette offen) ⇒ die Basis bekommt
 *     keinen Einstieg — dieselbe Sperre wie der Champion (§0.3, §0.4).
 *  5. `resolveBrokerMode` kennt die Basis nicht: Der Doppel-Guard ist mit und
 *     ohne Basis-Schalter derselbe — die Basis öffnet keinen Live-Pfad.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import { minuteBars, OPEN1, TEN_CLOSES } from '../../test/fakes/harness.ts';
import { resolveBrokerMode } from '../src/core/liveGate.ts';
import { engineStatePath } from '../src/engine/state.ts';
import { T1, USER_SETTINGS, welt, type Welt } from './secreview2/_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

/** Champion ohne Alpha-Einträge, mit Basis-Block für MSFT (Skript-Strategie, 5-Minuten-Bars wie die Welt). */
function basisChampion(o: { pass?: boolean; positionPct?: number | null; timeframe?: number } = {}): Record<string, unknown> {
  return {
    version: 1,
    updatedAt: 1,
    symbols: {},
    noTrade: {},
    basis: {
      version: 1,
      strategy: 'test_enter',
      params: {},
      symbols: ['MSFT'],
      label: 'Basis T',
      timeframe: o.timeframe ?? 5,
      pass: o.pass ?? true,
      gates: [],
      measuredAt: 1,
      ...(o.positionPct === null ? {} : { positionPct: o.positionPct ?? 10 }),
    },
  };
}

function basisWelt(o: { champion?: Record<string, unknown>; settings?: Record<string, unknown>; verriegelt?: boolean } = {}): Welt {
  const w = welt({ champion: false, ...(o.verriegelt ? { verriegelt: ['u1'] } : {}) });
  welten.push(w);
  w.db.seed('meta/champion', o.champion ?? basisChampion());
  w.data.bars.set('MSFT', minuteBars(OPEN1, TEN_CLOSES));
  if (o.settings) w.db.seed('users/u1', { settings: o.settings, wallet: { paperBalance: 0, currency: 'USD', updatedAt: 'x' } });
  return w;
}

describe('Basis-Stufe im Takt', () => {
  it('handelt den Korb des Blocks mit Allokations-Sizing (10 % ⇒ 99 Stück); Stufe „basis" in Spiegel, Position und Trade-Docs', async () => {
    const w = basisWelt();
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    // MSFT stand nicht im Plattform-Universum — der Basis-Korb kam als Block dazu; Bars wurden dafür geladen.
    expect(w.data.callsOf('getBars').some((c) => (c.args[0] as { symbols: string[] }).symbols.includes('MSFT'))).toBe(true);
    const orders = w.trading.ordersFor('MSFT');
    const parent = orders.find((o) => o.orderClass === 'bracket')!;
    expect(parent, 'die Basis handelt MSFT').toBeDefined();
    // 100 000 × 10 % / 100,37 = 99,6 ⇒ 99 Stück. Das Risiko-Budget des Nutzers (0,5 % / 2 % Stop) ergäbe 249 ⇒ Deckel 20 % ⇒ 199.
    expect(parent.qty).toBe(99);
    expect(parent.legs.map((l) => l.type).sort()).toEqual(['limit', 'stop']);
    expect(w.trading.ordersFor('AAPL'), 'AAPL hat keinen Champion und keine Basis').toHaveLength(0);
    const engine = w.db.get('users/u1')?.engine as { champion: { source: string; symbols: string[]; basis: string[] }; notes: string[] };
    expect(engine.champion).toEqual({ source: 'basis', symbols: ['MSFT'], basis: ['MSFT'] });
    expect(engine.notes.some((n) => n.includes('Basis-Allokation „Basis T": 1 Symbole (MSFT)'))).toBe(true);
    expect(engine.notes.some((n) => n.includes('Position 10 % der Equity je Symbol'))).toBe(true);

    // Fill ⇒ Positions-Doc mit Stufe; Stop-Fill ⇒ Trade-Docs mit Stufe.
    w.trading.fill(parent.id, 100.4);
    await w.run(T1 + 60_000);
    expect(w.db.get('users/u1/positions/MSFT')).toMatchObject({ symbol: 'MSFT', qty: 99, stufe: 'basis', strategy: 'test_enter', quelle: 'engine' });
    w.trading.fill(`${parent.id}-sl`, 98.3);
    await w.run(T1 + 120_000);
    const trades = w.db.list('users/u1/trades').map((d) => d.data);
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.stufe === 'basis' && t.strategy === 'test_enter')).toBe(true);
    expect(w.db.get(engineStatePath('u1'))).toBeDefined();
  });

  it('Schalter aus (settings.auto.basis false) ⇒ MSFT nicht im Universum, keine Order, Spiegel ohne Basis', async () => {
    const auto = { riskPerTradePct: 0.5, maxPositionPct: 20, maxPositions: 4, maxDailyLossPct: 2, maxDrawdownPct: 10, allowShort: false, basis: false };
    const w = basisWelt({ settings: { ...USER_SETTINGS, auto } });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(w.data.callsOf('getBars').some((c) => (c.args[0] as { symbols: string[] }).symbols.includes('MSFT'))).toBe(false);
    const engine = w.db.get('users/u1')?.engine as { champion: { source: string; symbols: string[]; basis: string[] }; notes: string[] };
    expect(engine.champion).toEqual({ source: 'none', symbols: [], basis: [] });
    expect(engine.notes.some((n) => n.includes('vom Nutzer abgeschaltet'))).toBe(true);
  });

  it('WÄCHTER: pass false ⇒ die Basis handelt nichts, auch mit Schalter an', async () => {
    const w = basisWelt({ champion: basisChampion({ pass: false }) });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    const engine = w.db.get('users/u1')?.engine as { champion: { symbols: string[]; basis: string[] }; notes: string[] };
    expect(engine.champion.basis).toEqual([]);
    expect(engine.notes.some((n) => n.includes('Latte nicht bestanden'))).toBe(true);
  });

  it('Block ohne positionPct (Lauf vor der Basis-Stufe) ⇒ nicht gehandelt — die Sizing-Semantik ist unbekannt', async () => {
    const w = basisWelt({ champion: basisChampion({ positionPct: null }) });
    await w.run(T1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    const engine = w.db.get('users/u1')?.engine as { notes: string[] };
    expect(engine.notes.some((n) => n.includes('ohne positionPct'))).toBe(true);
  });

  it('WÄCHTER: verriegelter Order-Pfad (Echtgeld-Kette offen) sperrt die Einstiege der Basis wie die des Champions', async () => {
    const w = basisWelt({ verriegelt: true });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    const engine = w.db.get('users/u1')?.engine as { entryLock?: unknown; champion: { basis: string[] }; notes: string[] };
    expect(engine.entryLock).toBe('Kill-Switch aktiv');
    expect(engine.champion.basis, 'die Basis ist gewählt — aber gesperrt wie alles andere').toEqual(['MSFT']);
    expect(engine.notes.some((n) => n.includes('Einstiege gesperrt'))).toBe(true);
  });
});

describe('Live-Guard kennt die Basis nicht', () => {
  const original = process.env.ALPACA_ALLOW_LIVE;
  afterEach(() => {
    if (original === undefined) delete process.env.ALPACA_ALLOW_LIVE;
    else process.env.ALPACA_ALLOW_LIVE = original;
  });

  it('resolveBrokerMode liefert mit und ohne Basis-Schalter dasselbe — Paper ohne Freigabe, Paper ohne Reife, live nur mit allem', () => {
    const faelle = [{ basis: true }, { basis: false }, {}];
    for (const auto of faelle) {
      const strategy = { broker: { mode: 'live' as const }, auto };
      delete process.env.ALPACA_ALLOW_LIVE;
      expect(resolveBrokerMode(strategy)).toBe('paper');
      process.env.ALPACA_ALLOW_LIVE = '1';
      expect(resolveBrokerMode(strategy, { bereit: false, kriterien: [] } as never)).toBe('paper');
      expect(resolveBrokerMode(strategy, { bereit: true, kriterien: [] } as never)).toBe('live');
      expect(resolveBrokerMode({ broker: { mode: 'paper' }, auto })).toBe('paper');
    }
  });
});
