/**
 * Wächter für den Rauchtest des Orderpfads (`src/engine/rauchtest.ts`).
 *
 * Die drei Fälle, in denen dieser Test Geld rettet:
 *  1. Jemand lockert die Echtgeld-Sperre — dann muss „mit Live-Konfiguration
 *     platziert der Rauchtest nichts" rot werden, BEVOR eine Order entsteht.
 *  2. Jemand macht aus dem Rauchtest einen Beleg — dann muss auffallen, dass
 *     seine Trades in `readiness` mitzählen.
 *  3. Jemand vereinfacht den Ausstieg — dann muss auffallen, dass ein
 *     Storno-422 in einen Nachverkauf mündet (der Vorgänger verkaufte so
 *     10 Stück UND leerverkaufte 10).
 *
 * Kein Netz, keine echten Keys: alles gegen `FakeAlpaca`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaError, type AlpacaOrder } from '../../src/alpaca/types.ts';
import { Journal } from '../../src/core/journal.ts';
import { DAY, MIN } from '../../src/core/time.ts';
import type { Trade } from '../../src/core/types.ts';
import { parseClientId } from '../../src/engine/ids.ts';
import {
  entmarkiereClientId,
  markiereClientId,
  rauchtest,
  RauchtestClient,
  RauchtestJournal,
  RAUCHTEST_CLIENT_PREFIX,
  RAUCHTEST_STRATEGY,
  type RauchtestArgs,
  type RauchtestErgebnis,
  type SchrittName,
} from '../../src/engine/rauchtest.ts';
import { FakeAlpaca } from '../fakes/fakeAlpaca.ts';
import { CLOSE1, OPEN1, testConfig, tmpHome } from '../fakes/harness.ts';
import { assessReadiness } from '../../src/readiness.ts';

const T = OPEN1 + 10 * MIN;
// Krummer Kurs mit Absicht: Nur so prüft der Beine-Test die RICHTUNG der Rundung (§4).
const KURS = 661.37;

function bau(o: { mode?: 'paper' | 'live'; clientMode?: 'paper' | 'live'; config?: ReturnType<typeof testConfig>; qty?: number } = {}) {
  const now = (): number => T;
  const fake = new FakeAlpaca({ mode: o.clientMode ?? 'paper', equity: 100_000, cash: 100_000, now });
  fake.clock = { timestamp: T, isOpen: true, nextOpen: T + DAY, nextClose: CLOSE1 };
  fake.setPrice('SPY', KURS);
  fake.autoFillMarket = true;
  const args: RauchtestArgs = {
    client: fake,
    config: o.config ?? testConfig({ universe: { symbols: ['SPY'] } }),
    mode: o.mode ?? 'paper',
    symbol: 'SPY',
    qty: o.qty ?? 1,
    timeoutMs: 10,
    pollMs: 1,
    now,
    sleep: async () => undefined,
  };
  return { fake, args, now };
}

const schritt = (e: RauchtestErgebnis, name: SchrittName) => e.schritte.find((s) => s.name === name);
const sendungen = (fake: FakeAlpaca) => fake.callsOf('submitOrder');

/* ───────────────────────── Echtgeld ───────────────────────── */

describe('Rauchtest — Echtgeld ist hart gesperrt', () => {
  it('mit Live-Konfiguration platziert der Rauchtest nichts (aufgelöster Modus live)', async () => {
    const { fake, args } = bau({ mode: 'live' });
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.ok).toBe(false);
    expect(e.grund).toMatch(/live/);
    // Nicht einmal gefragt wurde der Broker — abgebrochen wird VOR jeder Verbindung.
    expect(fake.calls).toHaveLength(0);
    expect(sendungen(fake)).toHaveLength(0);
  });

  it('mit Live-Konfiguration platziert der Rauchtest nichts (broker.mode: live, Doppel-Guard ergäbe Paper)', async () => {
    const { fake, args } = bau({ config: testConfig({ universe: { symbols: ['SPY'] }, broker: { mode: 'live' } }) });
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/broker\.mode/);
    expect(fake.calls).toHaveLength(0);
  });

  it('mit Live-Konfiguration platziert der Rauchtest nichts (Broker-Client steht auf live)', async () => {
    const { fake, args } = bau({ clientMode: 'live' });
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/Broker-Client/);
    expect(fake.calls).toHaveLength(0);
  });

  it('dritte Schicht: RauchtestClient sendet auch direkt keine Order, wenn der Client nicht Paper ist', async () => {
    const live = new FakeAlpaca({ mode: 'live' });
    const client = new RauchtestClient(live);
    await expect(
      client.submitOrder({ symbol: 'SPY', side: 'buy', qty: 1, type: 'market', timeInForce: 'day', clientOrderId: 'atd-paper-SPY-1-e' }),
    ).rejects.toThrow(/nicht auf Paper/);
    expect(sendungen(live)).toHaveLength(0);
  });

  it('kontoweite Befehle bleiben gesperrt — sie würden fremden Bestand anfassen', async () => {
    const { fake } = bau();
    const client = new RauchtestClient(fake);
    await expect(client.cancelAllOrders()).rejects.toThrow(/gesperrt/);
    await expect(client.closeAllPositions(true)).rejects.toThrow(/gesperrt/);
    await expect(client.closePosition('SPY')).rejects.toThrow(/gesperrt/);
  });
});

/* ───────────────────────── Kennungen ───────────────────────── */

describe('Rauchtest — Kennungen', () => {
  it('markieren ist umkehrbar und idempotent', () => {
    const roh = 'atd-paper-SPY-1757000000000-e';
    expect(markiereClientId(roh)).toBe(`${RAUCHTEST_CLIENT_PREFIX}${roh}`);
    expect(markiereClientId(markiereClientId(roh))).toBe(`${RAUCHTEST_CLIENT_PREFIX}${roh}`);
    expect(entmarkiereClientId(markiereClientId(roh))).toBe(roh);
    expect(entmarkiereClientId(roh)).toBe(roh);
  });

  it('die markierte Kennung ist für die Produktions-Engine KEINE eigene Kennung', () => {
    const roh = 'atd-paper-SPY-1757000000000-e';
    expect(parseClientId(roh)).not.toBeNull();
    // Entscheidend: Die Engine darf eine Rauchtest-Order nie als ihre eigene übernehmen.
    expect(parseClientId(markiereClientId(roh))).toBeNull();
  });
});

/* ───────────────────────── Vorbedingungen ───────────────────────── */

describe('Rauchtest — Vorbedingungen brechen ab, bevor etwas gesendet wird', () => {
  it('Markt geschlossen: Abbruch mit Begründung, kein Warten', async () => {
    const { fake, args } = bau();
    fake.clock = { timestamp: T, isOpen: false, nextOpen: T + DAY, nextClose: T + DAY };
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/Markt geschlossen/);
    expect(sendungen(fake)).toHaveLength(0);
  });

  it('kurz vor Sitzungsschluss: Abbruch, damit der eigene Ausstieg noch füllt', async () => {
    const { fake, args } = bau();
    fake.clock = { timestamp: T, isOpen: true, nextOpen: T + DAY, nextClose: T + 5 * MIN };
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/Sitzungsschluss/);
    expect(sendungen(fake)).toHaveLength(0);
  });

  it('Bestand im selben Symbol: Abbruch — fremder Bestand wird nicht angefasst', async () => {
    const { fake, args } = bau();
    fake.setPosition('SPY', 'long', 40, 600);
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/liegt bereits SPY/);
    expect(sendungen(fake)).toHaveLength(0);
    expect(fake.positions.get('SPY')?.qty).toBe(40);
  });

  it('offene Order im selben Symbol: Abbruch — der Ausstieg würde sie stornieren', async () => {
    const { fake, args } = bau();
    await fake.submitOrder({ symbol: 'SPY', side: 'buy', qty: 5, type: 'limit', limitPrice: 100, timeInForce: 'day', clientOrderId: 'fremd-1' });
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/offene Order/);
    expect(fake.find('fremd-1')?.status).toBe('new');
  });

  it('Konto gesperrt: Abbruch', async () => {
    const { fake, args } = bau();
    fake.account = { ...fake.account, tradingBlocked: true };
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/gesperrt/);
    expect(sendungen(fake)).toHaveLength(0);
  });

  it('PDT-Gate: unter 25 000 $ mit verbrauchten Daytrades wird nichts gesendet', async () => {
    const { fake, args } = bau();
    fake.account = { ...fake.account, equity: 10_000, cash: 10_000, daytradeCount: 3 };
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/PDT/);
    expect(sendungen(fake)).toHaveLength(0);
  });

  it('zu wenig Bargeld: Abbruch', async () => {
    const { fake, args } = bau({ qty: 5 });
    fake.account = { ...fake.account, cash: 100 };
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/Bargeld/);
    expect(sendungen(fake)).toHaveLength(0);
  });

  it('Krypto-Config: Abbruch, weil der Bracket-Pfad ein anderer ist', async () => {
    const { fake, args } = bau({ config: testConfig({ universe: { symbols: ['BTC/USD'], assetClass: 'crypto' } }) });
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(true);
    expect(e.grund).toMatch(/Assetklasse/);
    expect(sendungen(fake)).toHaveLength(0);
  });
});

/* ───────────────────────── Die Kette ───────────────────────── */

describe('Rauchtest — die ganze Kette im Papiergeld', () => {
  it('Einstieg, Idempotenz, Fill, Beine, Abgleich, Ausstieg, Aufräumen — und danach ist nichts mehr offen', async () => {
    const { fake, args } = bau();
    const e = await rauchtest(args);
    expect(e.abgebrochen).toBe(false);
    expect(e.schritte.filter((s) => !s.ok).map((s) => `${s.name}: ${s.text}`)).toEqual([]);
    expect(e.ok).toBe(true);

    // Genau EIN Einstieg, genau EIN eigener Verkauf.
    const gesendet = sendungen(fake).map((c) => c.args[0] as { side: string; clientOrderId: string; orderClass?: string });
    expect(gesendet.filter((o) => o.side === 'buy')).toHaveLength(1);
    expect(gesendet.filter((o) => o.side === 'sell')).toHaveLength(1);
    // Die Kennung am Broker weist den Lauf als Rauchtest aus.
    for (const o of gesendet) expect(o.clientOrderId.startsWith(RAUCHTEST_CLIENT_PREFIX)).toBe(true);
    expect(gesendet.find((o) => o.side === 'buy')?.orderClass).toBe('bracket');

    // Aufgeräumt: keine Position, keine offene Order.
    expect(fake.positions.has('SPY')).toBe(false);
    expect(fake.openOrders('SPY')).toHaveLength(0);
  });

  it('Beine liegen beim Broker, mit der Rundung aus §4 (Stop vom Kurs weg, Limit zum Kurs hin)', async () => {
    const { args } = bau();
    const e = await rauchtest(args);
    const beine = schritt(e, 'beine');
    expect(beine?.ok).toBe(true);
    // 661.37 ∓ 5 % = 628.3015 / 694.4385 — beide werden ABWÄRTS gerundet:
    // der Long-Stop vom Kurs weg, das Long-Ziel zum Kurs hin.
    expect(beine?.details['stopBeimBroker']).toBe(628.3);
    expect(beine?.details['zielBeimBroker']).toBe(694.43);
    expect(Number(beine?.details['stopBeimBroker'])).toBeLessThanOrEqual(Number(beine?.details['stopRoh']));
    expect(Number(beine?.details['zielBeimBroker'])).toBeLessThanOrEqual(Number(beine?.details['zielRoh']));
  });

  it('Idempotenz: die zweite Anforderung fragt getOrderByClientId und erzeugt keine zweite Order', async () => {
    const { fake, args } = bau();
    const e = await rauchtest(args);
    const id = schritt(e, 'idempotenz');
    expect(id?.ok).toBe(true);
    expect(id?.details['einstiegsOrdersNachher']).toBe(1);
    expect(id?.details['neueSendungen']).toBe(0);
    expect(Number(id?.details['getOrderByClientIdAbfragen'])).toBeGreaterThan(0);
    // Auch am Broker steht nur eine Einstiegs-Order dieses Laufs.
    const einstiege = [...fake.orders.values()].filter((o) => o.clientOrderId.startsWith(RAUCHTEST_CLIENT_PREFIX) && parseClientId(entmarkiereClientId(o.clientOrderId))?.kind === 'entry');
    expect(einstiege).toHaveLength(1);
  });

  it('Storno vor eigenem Exit: erst werden die Beine storniert, dann verkauft', async () => {
    const { fake, args } = bau();
    await rauchtest(args);
    const reihenfolge = fake.calls.map((c) => c.method);
    const letzterStorno = reihenfolge.lastIndexOf('cancelOrder');
    const verkauf = fake.calls.findIndex((c) => c.method === 'submitOrder' && (c.args[0] as { side: string }).side === 'sell');
    expect(letzterStorno).toBeGreaterThan(-1);
    expect(verkauf).toBeGreaterThan(letzterStorno);
  });

  it('fremder Bestand in ANDEREN Symbolen bleibt unangetastet', async () => {
    const { fake, args } = bau();
    fake.setPosition('AAPL', 'long', 10, 200);
    await fake.submitOrder({ symbol: 'AAPL', side: 'sell', qty: 10, type: 'limit', limitPrice: 250, timeInForce: 'gtc', clientOrderId: 'fremd-aapl' });
    const e = await rauchtest(args);
    expect(e.ok).toBe(true);
    expect(fake.positions.get('AAPL')?.qty).toBe(10);
    expect(fake.find('fremd-aapl')?.status).toBe('new');
  });
});

/* ───────────────────────── 422 ───────────────────────── */

describe('Rauchtest — 422 beim Storno ⇒ nachsehen, nie nachverkaufen', () => {
  it('das Stop-Bein füllt beim Storno: der Fill wird gebucht, es folgt KEIN Verkauf', async () => {
    const { fake, args } = bau();
    // Beim ersten Storno füllt das Stop-Bein — genau die Kollision, die beim
    // Vorgänger 10 Stück verkauft UND 10 leerverkauft hat.
    fake.onCall('cancelOrder', () => {
      const bein = fake.openOrders('SPY').find((o: AlpacaOrder) => o.type === 'stop');
      if (bein) fake.fill(bein.id, 628.3);
    });
    fake.throwOn('cancelOrder', new AlpacaError('order is not cancelable (filled)', 422, 42210000, false), 1);
    const e = await rauchtest(args);

    const aus = schritt(e, 'ausstieg');
    expect(aus?.ok).toBe(true);
    expect(aus?.details['eigeneVerkaufsorders']).toBe(0);
    expect(String(aus?.details['stornoErgab422'])).toMatch(/422/);
    // Nur der Einstieg ging je an den Broker.
    expect(sendungen(fake).filter((c) => (c.args[0] as { side: string }).side === 'sell')).toHaveLength(0);
    expect(fake.positions.has('SPY')).toBe(false);
    expect(e.ok).toBe(true);
  });
});

/* ───────────────────────── Aufräumen ───────────────────────── */

describe('Rauchtest — aufgeräumt wird immer', () => {
  it('scheitert der Ausstieg, räumt der Rauchtest trotzdem auf (Exits werden nie gesperrt)', async () => {
    const { fake, args } = bau();
    // Der erste Storno scheitert hart (kein 422) ⇒ der Exit-Versuch bricht ab.
    fake.throwOn('cancelOrder', new AlpacaError('boom', 500, null, true), 1);
    const e = await rauchtest(args);
    expect(e.ok).toBe(false);
    expect(schritt(e, 'ausstieg')?.ok).toBe(false);
    // Aber das Aufräumen hat die Position geschlossen und die Beine abgeräumt.
    expect(schritt(e, 'aufraeumen')?.ok).toBe(true);
    expect(fake.positions.has('SPY')).toBe(false);
    expect(fake.openOrders('SPY')).toHaveLength(0);
  });

  it('bleibt kein Fill aus, meldet der Fill-Schritt das und die Einstiegs-Order wird storniert', async () => {
    const { fake, args } = bau();
    fake.autoFillMarket = false; // Marktorder bleibt offen
    const e = await rauchtest(args);
    expect(e.ok).toBe(false);
    expect(schritt(e, 'fill')?.ok).toBe(false);
    expect(fake.openOrders('SPY')).toHaveLength(0);
    expect(fake.positions.has('SPY')).toBe(false);
  });
});

/* ───────────────────────── Live-Reife ───────────────────────── */

describe('Rauchtest — seine Trades können die Live-Reife nicht verfälschen', () => {
  it('das Rauchtest-Journal liefert keine Trades — auch nicht, wenn man es ins Produktions-Journal kopiert', async () => {
    const home = tmpHome();
    const produktion = join(home, 'journal.jsonl');
    const echter: Trade = {
      symbol: 'AAPL',
      side: 'long',
      qty: 10,
      entryTime: T - DAY,
      entryPrice: 100,
      exitTime: T - DAY + 3600_000,
      exitPrice: 102,
      grossPnl: 20,
      fees: 1,
      netPnl: 19,
      rMultiple: 1,
      exitReason: 'target',
      strategy: 'trend_donchian',
      barsHeld: 4,
      mae: null,
      mfe: null,
    };
    new Journal(produktion).append('trade_closed', { trade: echter });

    const rtPfad = join(home, 'rauchtest', 'journal.jsonl');
    const { args } = bau();
    const e = await rauchtest({ ...args, journal: new Journal(rtPfad) });
    expect(e.ok).toBe(true);

    // Der Trade steht im Rauchtest-Journal — aber nicht als `trade_closed`.
    const roh = readFileSync(rtPfad, 'utf8');
    expect(roh).toContain('"rauchtestKind":"trade_closed"');
    expect(roh).toContain(`"strategy":"${RAUCHTEST_STRATEGY}"`);
    expect(new Journal(rtPfad).trades()).toHaveLength(0);

    // Und selbst zusammenkopiert zählt die Live-Reife nur den echten Trade.
    appendFileSync(produktion, roh);
    const alle = new Journal(produktion).trades();
    expect(alle).toHaveLength(1);
    expect(alle[0]?.symbol).toBe('AAPL');
    const r = assessReadiness(alle, T);
    expect(r.evaluated).toBe(1);
    expect(r.ready).toBe(false);
  });

  it('RauchtestJournal meldet nie Trades und markiert jedes Ereignis', () => {
    const j = new RauchtestJournal(null);
    j.append('trade_closed', { trade: { symbol: 'SPY' } }, 1);
    j.append('order_submitted', { symbol: 'SPY' }, 2);
    expect(j.trades()).toHaveLength(0);
    expect(j.readAll().map((x) => x.kind)).toEqual(['note', 'order_submitted']);
    for (const ev of j.readAll()) expect(ev['rauchtest']).toBe(true);
    expect(j.readAll()[0]?.['rauchtestKind']).toBe('trade_closed');
  });
});
