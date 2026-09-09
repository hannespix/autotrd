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
import { MIN, msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { stopClientId } from '../../src/engine/ids.ts';
import { DAY1, minuteBars, OPEN1, scriptedStrategy, TEN_CLOSES } from '../../test/fakes/harness.ts';
import { resolveBrokerMode } from '../src/core/liveGate.ts';
import { engineStatePath } from '../src/engine/state.ts';
import { brokerMitPosition, position, stateMitPosition, T1, USER_SETTINGS, welt, type Welt } from './secreview2/_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

/** Champion ohne Alpha-Einträge, mit Basis-Block für MSFT (Skript-Strategie, 5-Minuten-Bars wie die Welt). */
function basisChampion(o: { pass?: boolean; positionPct?: number | null; timeframe?: number; symbols?: string[] } = {}): Record<string, unknown> {
  return {
    version: 1,
    updatedAt: 1,
    symbols: {},
    noTrade: {},
    basis: {
      version: 1,
      strategy: 'test_enter',
      params: {},
      symbols: o.symbols ?? ['MSFT'],
      label: 'Basis T',
      timeframe: o.timeframe ?? 5,
      pass: o.pass ?? true,
      gates: [],
      measuredAt: 1,
      ...(o.positionPct === null ? {} : { positionPct: o.positionPct ?? 10 }),
    },
  };
}

function basisWelt(o: { champion?: Record<string, unknown>; settings?: Record<string, unknown>; verriegelt?: boolean; engineConfig?: Record<string, unknown> } = {}): Welt {
  const w = welt({ champion: false, ...(o.verriegelt ? { verriegelt: ['u1'] } : {}) });
  welten.push(w);
  w.db.seed('meta/champion', o.champion ?? basisChampion());
  if (o.engineConfig) w.db.seed('meta/engineConfig', { ...(w.db.get('meta/engineConfig') ?? {}), ...o.engineConfig });
  w.data.bars.set('MSFT', minuteBars(OPEN1, TEN_CLOSES));
  if (o.settings) w.db.seed('users/u1', { settings: o.settings, wallet: { paperBalance: 0, currency: 'USD', updatedAt: 'x' } });
  return w;
}

const AUTO = { riskPerTradePct: 0.5, maxPositionPct: 20, maxPositions: 4, maxDailyLossPct: 2, maxDrawdownPct: 10, allowShort: false };

/** Offene Basis-Position MSFT (Strategie des Blocks) im State-Doc und beim Fake-Broker samt GTC-Stop. */
async function mitBasisPosition(w: Welt): Promise<void> {
  const pos = position({ symbol: 'MSFT', qty: 99, entryPrice: 100.4, stop: 80.32, target: null, initialStop: 80.32, stufe: 'basis' });
  w.db.seed(
    engineStatePath('u1'),
    stateMitPosition({ positions: { MSFT: pos }, protectiveOrders: { MSFT: stopClientId('paper', 'MSFT', pos.entryTime, 0) }, lastBarAt: { MSFT: OPEN1 + 5 * MIN } }) as never,
  );
  await brokerMitPosition(w.trading, pos);
}

const exitOrders = (w: Welt, symbol: string) => w.trading.ordersFor(symbol).filter((o) => o.side === 'sell' && o.type === 'market');
const intents = (w: Welt) => w.db.list('users/u1/journal').map((d) => d.data).filter((d) => d.kind === 'intent').map((d) => d.intent as { kind: string; symbol: string; reason?: string });

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
    expect(engine.notes.some((n) => n.includes('Schalter aus (strategy.basis) — keine neuen Einstiege'))).toBe(true);
  });

  it('WÄCHTER: pass false ⇒ die Basis eröffnet nichts, auch mit Schalter an; ohne Bestand ist der Korb nicht im Universum', async () => {
    const w = basisWelt({ champion: basisChampion({ pass: false }) });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(w.data.callsOf('getBars').some((c) => (c.args[0] as { symbols: string[] }).symbols.includes('MSFT'))).toBe(false);
    const engine = w.db.get('users/u1')?.engine as { champion: { symbols: string[]; basis: string[] }; notes: string[] };
    expect(engine.champion.basis).toEqual([]);
    expect(engine.notes.some((n) => n.includes('Latte nicht bestanden — keine neuen Einstiege'))).toBe(true);
  });

  /**
   * Prüfbefund M6/M8: `pass` kippt, Block ohne Freigabe, Schalter aus ⇒ vorher Zwangs-Liquidation aller
   * Basis-Positionen auf allen Konten am nächsten Open (Marktorder). Jetzt: keine neuen Einstiege, der
   * Bestand läuft nach der eigenen Regel der Basis-Strategie aus, der Broker-Stop bleibt liegen.
   */
  it('WÄCHTER (M6): pass true → false mit offener Basis-Position ⇒ kein Exit-Intent, kein neuer Einstieg, Korb bleibt geführt, Stop bleibt', async () => {
    const w = basisWelt({ champion: basisChampion({ pass: false, symbols: ['MSFT', 'AAPL'] }) });
    await mitBasisPosition(w);
    const r = await w.run(T1);
    expect(r.ok, JSON.stringify(r.failed)).toBe(1);
    // Kein Verkauf, kein Kauf: MSFT (Bestand) bleibt, AAPL (Einstiegssignal) wird gesperrt.
    expect(exitOrders(w, 'MSFT')).toHaveLength(0);
    expect(w.trading.ordersFor('AAPL')).toHaveLength(0);
    expect(intents(w).some((i) => i.kind === 'exit')).toBe(false);
    expect(intents(w).some((i) => i.kind === 'enter')).toBe(false);
    expect(w.trading.find(stopClientId('paper', 'MSFT', position().entryTime, 0))?.status).toBe('new');
    expect(w.db.get('users/u1/positions/MSFT')).toMatchObject({ symbol: 'MSFT', qty: 99, stufe: 'basis', stopLoss: 80.32 });
    // Der Korb ist im Universum (Bars geladen, Rang möglich), die Basis führt ihn — ohne Einstiegsrecht.
    expect(w.data.callsOf('getBars').some((c) => (c.args[0] as { symbols: string[] }).symbols.includes('MSFT'))).toBe(true);
    const engine = w.db.get('users/u1')?.engine as { champion: { source: string; symbols: string[]; basis: string[] }; notes: string[] };
    expect(engine.champion.basis.sort()).toEqual(['AAPL', 'MSFT']);
    expect(engine.notes.some((n) => /Latte nicht bestanden — keine neuen Einstiege; offene Basis-Positionen führt die Basis-Strategie zu Ende.*MSFT/.test(n))).toBe(true);
    const journal = w.db.list('users/u1/journal').map((d) => d.data);
    expect(journal.some((d) => d.kind === 'decision' && d.note === 'blocked' && d.symbol === 'AAPL' && String(d.text).includes('Einstiege gesperrt'))).toBe(true);
    expect(journal.some((d) => d.kind === 'note' && String(d.text).includes('ohne führende Strategie'))).toBe(false);
  });

  it('WÄCHTER (M8): globaler Schalter aus (meta/engineConfig strategy.basis=false) ⇒ dasselbe — auch wenn der Nutzer an hat', async () => {
    const w = basisWelt({ champion: basisChampion({ symbols: ['MSFT', 'AAPL'] }), engineConfig: { strategy: { basis: false } }, settings: { ...USER_SETTINGS, auto: { ...AUTO, basis: true } } });
    await mitBasisPosition(w);
    const vorher = w.trading.callsOf('submitOrder').length; // der GTC-Stop des Bestands
    const r = await w.run(T1);
    expect(r.ok, JSON.stringify(r.failed)).toBe(1);
    expect(w.trading.callsOf('submitOrder').slice(vorher)).toHaveLength(0);
    expect(intents(w)).toEqual([]);
    expect(w.db.get('users/u1/positions/MSFT')).toMatchObject({ symbol: 'MSFT', qty: 99 });
    const engine = w.db.get('users/u1')?.engine as { champion: { basis: string[] }; notes: string[] };
    expect(engine.champion.basis.sort()).toEqual(['AAPL', 'MSFT']);
    expect(engine.notes.some((n) => n.includes('plattformweit abgeschaltet'))).toBe(true);
    expect(engine.notes.some((n) => n.includes('Schalter aus (strategy.basis) — keine neuen Einstiege'))).toBe(true);
    // Ohne Bestand: globaler Schalter aus ⇒ kein Korb im Universum, keine Order.
    const leer = basisWelt({ engineConfig: { strategy: { basis: false } } });
    await leer.run(T1);
    expect(leer.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(leer.data.callsOf('getBars').some((c) => (c.args[0] as { symbols: string[] }).symbols.includes('MSFT'))).toBe(false);
  });

  it('beide Schalter an + pass true ⇒ Einstiege erlaubt (Bracket-Order für MSFT)', async () => {
    const w = basisWelt({ engineConfig: { strategy: { basis: true } }, settings: { ...USER_SETTINGS, auto: { ...AUTO, basis: true } } });
    const r = await w.run(T1);
    expect(r.ok).toBe(1);
    expect(w.trading.ordersFor('MSFT').some((o) => o.orderClass === 'bracket' && o.qty === 99)).toBe(true);
  });

  it('WÄCHTER (M9): unlesbarer Basis-Block (fremde Version) ⇒ Basis aus mit Notiz, der Alpha-Champion handelt weiter', async () => {
    const w = welt();
    welten.push(w);
    w.db.seed('meta/champion', { ...(w.db.get('meta/champion') ?? {}), basis: { version: 2, strategy: 'test_enter', symbols: ['MSFT'] } });
    const r = await w.run(T1);
    expect(r.ok, JSON.stringify(r.failed)).toBe(1);
    expect(w.trading.ordersFor('AAPL').some((o) => o.orderClass === 'bracket'), 'der Alpha-Champion handelt AAPL').toBe(true);
    expect(w.trading.ordersFor('MSFT')).toHaveLength(0);
    const engine = w.db.get('users/u1')?.engine as { champion: { source: string; symbols: string[]; basis: string[] }; notes: string[] };
    expect(engine.champion).toEqual({ source: 'champion', symbols: ['AAPL'], basis: [] });
    expect(engine.notes.some((n) => /Basis-Block unlesbar \(unbekannte Basis-Version 2\)/.test(n))).toBe(true);
    expect(w.db.get('meta/health')?.engine).toMatchObject({ champion: 1 });
  });

  it('G14: Zwangs-Liquidation (Block geräumt ⇒ keine Strategie mehr) — Positions- und Trade-Docs tragen weiterhin stufe „basis"', async () => {
    const w = basisWelt();
    await w.run(T1);
    const parent = w.trading.ordersFor('MSFT').find((o) => o.orderClass === 'bracket')!;
    w.trading.fill(parent.id, 100.4);
    await w.run(T1 + 60_000);
    const state = w.db.get(engineStatePath('u1')) as { positions: Record<string, { stufe?: string }> };
    expect(state.positions.MSFT?.stufe, 'die Stufe ist beim Fill in der Position festgehalten').toBe('basis');
    expect(w.db.get('users/u1/positions/MSFT')).toMatchObject({ stufe: 'basis' });
    // Der Block verschwindet (Config ohne Basis-Kandidat, Optimierer räumt): MSFT hat keine Strategie mehr ⇒ unmanaged.
    w.db.seed('meta/champion', { version: 1, updatedAt: 2, symbols: {}, noTrade: {} });
    await w.run(T1 + 120_000);
    expect(intents(w).some((i) => i.kind === 'exit' && i.symbol === 'MSFT' && i.reason === 'unmanaged')).toBe(true);
    const exit = exitOrders(w, 'MSFT')[0]!;
    w.trading.fill(exit.id, 101);
    await w.run(T1 + 180_000);
    const trades = w.db.list('users/u1/trades').map((d) => d.data);
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.stufe === 'basis' && t.strategy === 'test_enter')).toBe(true);
    expect(trades.some((t) => t.exitReason === 'unmanaged')).toBe(true);
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

/**
 * Prüfbefund K1 (check2 des Prüfers, nachgestellt): Plattform-Takt auf Tagesbars, Tag 1 Position, über
 * Nacht −5 %; Tag 2, erster Takt am Morgen. Vorher: `dayStartEquity` = Equity NACH dem Gap ⇒ 0 % ⇒ kein
 * Halt. Jetzt: Marke = `last_equity` (Vortagesschluss) ⇒ −5 % ⇒ Halt daily_loss und Glattstellung.
 */
describe('Tages-Notbremse im Takt (Tagesbars)', () => {
  const tagesbar = (day: string, c: number): Bar => {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return { t: msFromET(y, m, d), o: c - 0.5, h: c + 1, l: c - 1, c, v: 1_000_000 };
  };
  const T2 = msFromET(2026, 9, 2, 9, 31, 25);

  function tagesWelt(lastEquity: number): Welt {
    const w = welt();
    welten.push(w);
    w.db.seed('meta/engineConfig', { universe: { symbols: ['AAPL'], benchmark: 'SPY' }, timeframe: 1440, engine: { barGraceSec: 20, maxConsecutiveErrors: 3 } });
    w.db.seed('users/u1', { settings: { ...USER_SETTINGS, auto: { ...AUTO, maxDailyLossPct: 5, maxDrawdownPct: 50 } }, wallet: { paperBalance: 0, currency: 'USD', updatedAt: 'x' } });
    w.db.seed('meta/champion', {
      version: 1,
      updatedAt: 1,
      symbols: { AAPL: { strategy: 'test_enter', params: {}, timeframe: 1440, score: 1, oos: {}, gates: [], decidedAt: 1, trials: 1, dataRange: {} } },
      noTrade: {},
    });
    w.deps.getStrategy = () => scriptedStrategy({ enterAt: 1, holdsOvernight: true, targetPct: null, stopPct: 0.2 });
    const tage = ['2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01'];
    w.data.bars.set('AAPL', tage.map((d, i) => tagesbar(d, 100 + i)));
    w.data.bars.set('SPY', tage.map((d, i) => tagesbar(d, 500 + i)));
    w.data.clock = { timestamp: T2, isOpen: true, nextOpen: T2 + 24 * 60 * MIN, nextClose: msFromET(2026, 9, 2, 16, 0) };
    return w;
  }

  async function tag1Position(w: Welt): Promise<void> {
    const pos = position({ entryTime: msFromET(2026, 9, 1, 9, 31), stop: 80.32, target: null, initialStop: 80.32, entryDay: DAY1 });
    w.db.seed(engineStatePath('u1'), stateMitPosition({ positions: { AAPL: pos }, lastBarAt: { AAPL: msFromET(2026, 8, 31, 9, 30) } }) as never);
    await brokerMitPosition(w.trading, pos);
    w.trading.account.equity = 95_000;
    w.trading.account.cash = 75_000;
    w.trading.setPrice('AAPL', 75);
  }

  it('WÄCHTER (K1): Gap −5 % über Nacht bei maxDailyLossPct 5 ⇒ Halt daily_loss im ersten Takt des Folgetags, Glattstellung läuft', async () => {
    const w = tagesWelt(100_000);
    await tag1Position(w);
    w.trading.account.lastEquity = 100_000;
    const r = await w.run(T2);
    expect(r.ok, JSON.stringify(r.failed)).toBe(1);
    const state = w.db.get(engineStatePath('u1')) as { day: string; dayStartEquity: number; halt: { halted: boolean; reason: string | null; until: string | null } };
    expect(state.day).toBe('2026-09-02');
    expect(state.dayStartEquity).toBe(100_000);
    expect(state.halt).toMatchObject({ halted: true, reason: 'daily_loss', until: '2026-09-03' });
    expect(intents(w).some((i) => i.kind === 'exit' && i.symbol === 'AAPL' && i.reason === 'kill_switch')).toBe(true);
    // Markt offen ⇒ Stop storniert, Marktorder gesendet (§0.7: Storno vor eigenem Exit).
    expect(exitOrders(w, 'AAPL')).toHaveLength(1);
    expect(w.trading.find(stopClientId('paper', 'AAPL', msFromET(2026, 9, 1, 9, 31), 0))?.status).toBe('canceled');
  });

  it('mit der alten Rechnung (Equity nach dem Gap, hier: last_equity fehlt ⇒ Rückfall) fiele der Halt nicht', async () => {
    const w = tagesWelt(0);
    await tag1Position(w);
    w.trading.account.lastEquity = 0;
    const r = await w.run(T2);
    expect(r.ok, JSON.stringify(r.failed)).toBe(1);
    const state = w.db.get(engineStatePath('u1')) as { dayStartEquity: number; halt: { halted: boolean } };
    expect(state.dayStartEquity).toBe(95_000);
    expect(state.halt.halted).toBe(false);
    expect(exitOrders(w, 'AAPL')).toHaveLength(0);
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
