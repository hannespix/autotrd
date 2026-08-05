/**
 * Tests des Order-Routings (M13) — die Schicht, an der aus einer Entscheidung
 * eine echte Order wird.
 *
 * Der Schwerpunkt liegt auf den Fällen, in denen ein Fehler nicht auffällt:
 *
 *   - Eine Order, die NICHT gefüllt wurde, darf niemals als Trade gebucht
 *     werden. Ein Buch, das Positionen führt, die es nicht gibt, ist
 *     schlimmer als eines mit einer Lücke — die Lücke fällt beim Abgleich
 *     auf, die Erfindung nicht.
 *   - Eine TEILausführung muss mit der ausgeführten Menge gebucht werden,
 *     nicht mit der geplanten.
 *   - Die geplante Menge muss dieselbe Regel benutzen wie die Buchung —
 *     zwei Fassungen derselben Mengenlogik driften garantiert auseinander.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STRATEGY, type Position, type Strategy } from '../../shared/src/index.js';
import { warteAufFill } from '../src/core/alpacaBroker.js';
import { planeMenge, type TradeRequest } from '../src/core/broker.js';
import { routeOrder } from '../src/core/orderRouting.js';

const SCHLUESSEL = { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' };
/** Ohne Pause und mit wenigen Versuchen — der Test misst Logik, nicht Geduld. */
const SCHNELL = { versuche: 2, pauseMs: 0 };

/** Antwort-Attrappe: liefert der Reihe nach die übergebenen Körper. */
const antworten = (...koerper: unknown[]): ReturnType<typeof vi.fn> => {
  let i = 0;
  return vi.fn(async () => {
    const b = koerper[Math.min(i++, koerper.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(b),
    } as unknown as Response;
  });
};

describe('warteAufFill', () => {
  it('nimmt einen vollständigen Fill an', async () => {
    const f = antworten({ id: 'o1', status: 'filled', filled_qty: '10', filled_avg_price: '101.5' });
    const fill = await warteAufFill('paper', 'o1', SCHLUESSEL, { versuche: 2, pauseMs: 0 }, f);
    expect(fill?.ausfuehrungskurs).toBe(101.5);
    expect(fill?.qty).toBe(10);
    expect(fill?.status).toBe('filled');
  });

  it('nimmt eine TEILausführung an — mit der tatsächlichen Menge', async () => {
    const f = antworten({
      id: 'o1',
      status: 'partially_filled',
      filled_qty: '4',
      filled_avg_price: '99.25',
    });
    const fill = await warteAufFill('paper', 'o1', SCHLUESSEL, { versuche: 2, pauseMs: 0 }, f);
    expect(fill?.qty).toBe(4);
    expect(fill?.ausfuehrungskurs).toBe(99.25);
  });

  it('gibt bei abgelehnter Order sofort auf (kein Warten auf ein Wunder)', async () => {
    const f = antworten({ id: 'o1', status: 'rejected' });
    const fill = await warteAufFill('paper', 'o1', SCHLUESSEL, { versuche: 5, pauseMs: 0 }, f);
    expect(fill).toBeNull();
    // Ein einziger Abruf: Der Endzustand ist erreicht, weitere Versuche
    // wären reine Wartezeit im Scan.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gibt nach den Versuchen auf, wenn die Order offen bleibt', async () => {
    const f = antworten({ id: 'o1', status: 'new' });
    const fill = await warteAufFill('paper', 'o1', SCHLUESSEL, { versuche: 3, pauseMs: 0 }, f);
    expect(fill).toBeNull();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('wertet einen Fill ohne Kurs NICHT als Ausführung', async () => {
    // Der gefährliche Fall: status sagt „filled", aber der Kurs fehlt. Mit
    // Kurs 0 gebucht wäre der Einstand null und jeder spätere P&L absurd.
    const f = antworten({ id: 'o1', status: 'filled', filled_qty: '10', filled_avg_price: '0' });
    const fill = await warteAufFill('paper', 'o1', SCHLUESSEL, { versuche: 1, pauseMs: 0 }, f);
    expect(fill).toBeNull();
  });
});

describe('routeOrder', () => {
  const auftrag = { uid: 'u1', symbol: 'AAPL', side: 'buy' as const, qty: 5, laufId: 'scan-1' };

  it('meldet Ausführung mit echtem Kurs und Order-Kennung', async () => {
    const f = antworten(
      { id: 'ord-42', status: 'accepted' },
      { id: 'ord-42', status: 'filled', filled_qty: '5', filled_avg_price: '190.12' },
    );
    const r = await routeOrder({ mode: 'paper', schluessel: SCHLUESSEL }, auftrag, f, SCHNELL);
    expect(r).toEqual({
      ausgefuehrt: true,
      fillPreis: 190.12,
      fillMenge: 5,
      brokerOrderId: 'ord-42',
    });
  });

  it('gibt bei Teilausführung die AUSGEFÜHRTE Menge zurück', async () => {
    const f = antworten(
      { id: 'ord-43', status: 'accepted' },
      { id: 'ord-43', status: 'partially_filled', filled_qty: '2', filled_avg_price: '190' },
    );
    const r = await routeOrder({ mode: 'paper', schluessel: SCHLUESSEL }, auftrag, f, SCHNELL);
    expect(r.fillMenge).toBe(2);
  });

  it('meldet NICHT ausgeführt, wenn kein Fill kommt', async () => {
    const f = antworten({ id: 'ord-44', status: 'accepted' }, { id: 'ord-44', status: 'new' });
    const r = await routeOrder({ mode: 'paper', schluessel: SCHLUESSEL }, auftrag, f, SCHNELL);
    expect(r.ausgefuehrt).toBe(false);
    expect(r.grund).toBe('kein_fill');
    expect(r.fillPreis).toBeUndefined();
  });

  it('meldet NICHT ausgeführt, wenn der Broker einen Fehler liefert', async () => {
    const f = vi.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          text: async () => 'forbidden',
        }) as unknown as Response,
    );
    const r = await routeOrder({ mode: 'paper', schluessel: SCHLUESSEL }, auftrag, f, SCHNELL);
    expect(r.ausgefuehrt).toBe(false);
    expect(r.grund).toBe('broker_fehler');
  });

  it('sendet gar nicht erst bei Menge 0', async () => {
    const f = antworten({});
    const r = await routeOrder(
      { mode: 'paper', schluessel: SCHLUESSEL },
      { ...auftrag, qty: 0 },
      f,
      SCHNELL,
    );
    expect(r).toEqual({ ausgefuehrt: false, grund: 'menge_null' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('planeMenge', () => {
  const strat = (): Strategy => {
    const s = structuredClone(DEFAULT_STRATEGY);
    s.broker.initialCapital = 10_000;
    s.engine.maxPositionPct = 10;
    return s;
  };
  const req = (over: Partial<TradeRequest> = {}): TradeRequest => ({
    uid: 'u1',
    symbol: 'AAPL',
    side: 'buy',
    price: 100,
    source: 'engine',
    ...over,
  });
  const pos = (over: Partial<Position> = {}): Position => ({
    symbol: 'AAPL',
    qty: 7,
    avgEntry: 100,
    stopLoss: null,
    takeProfit: null,
    openedAt: '2026-08-05T10:00:00.000Z',
    ...over,
  });

  it('schließt IMMER die volle Position — nie mehr, nie weniger', () => {
    const m = planeMenge(req({ side: 'sell' }), strat(), {
      balance: 10_000,
      position: pos(),
      effPreis: 100,
      fractional: false,
    });
    expect(m).toBe(7);
  });

  it('deckt einen Short mit der offenen Menge ein', () => {
    const m = planeMenge(req({ side: 'buy' }), strat(), {
      balance: 10_000,
      position: pos({ side: 'short', qty: 3 }),
      effPreis: 100,
      fractional: false,
    });
    expect(m).toBe(3);
  });

  it('nimmt eine ausdrücklich gewünschte Menge unverändert', () => {
    const m = planeMenge(req({ qty: 2 }), strat(), {
      balance: 10_000,
      position: null,
      effPreis: 100,
      fractional: false,
    });
    expect(m).toBe(2);
  });

  it('rechnet die Einstiegsgröße wie sizeOrder — 10 % von 10.000 zu 100', () => {
    const m = planeMenge(req(), strat(), {
      balance: 10_000,
      position: null,
      effPreis: 100,
      fractional: false,
    });
    expect(m).toBe(10);
  });
});
