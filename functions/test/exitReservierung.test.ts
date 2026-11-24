/**
 * Exits scheitern nicht mehr an der Reservierung des eigenen Schutz-Stops
 * (24.11.).
 *
 * Befund: Im Umkehr-Morgenlauf vom 24.11. wies Alpaca 11 von 14 Verkäufen
 * mit 403 „insufficient qty available … held_for_orders" ab. Dasselbe am
 * 19.11. (XLY ×3 — dieselben Positionen gingen erst am 24.11. raus), am
 * 12.11. (XOM ×2) und am 05.11. bei einem Notbremsen-Exit im Minuten-Puls.
 * Ursache: `schutzAufheben` meldete „frei", sobald Alpaca den Storno der
 * Stop-Order ANGENOMMEN hatte. Vollzogen ist er erst im Endzustand; bis
 * dahin sind die Stücke reserviert. Der Stop war danach weg, der Verkauf
 * kam nicht — die Position lag ungeschützt, bis das Signal wiederkam.
 *
 * Gepinnt wird: Der Storno wird abgewartet, ein Fill während des Stornos
 * wird als Fill erkannt, ein abgewiesener Exit wird wiederholt — und nichts
 * davon kann einen Ausstieg verhindern oder einen Einstieg wiederholen.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AlpacaFehler } from '../src/core/alpacaBroker.js';
import {
  RESERVIERUNG_WIEDERHOLUNGEN,
  routeOrder,
  stueckeReserviert,
} from '../src/core/orderRouting.js';
import { STORNO_WARTE_PAUSE_MS, STORNO_WARTE_VERSUCHE, schutzAufheben } from '../src/core/schutzStop.js';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: () => ({ get: async () => ({ exists: false, get: () => undefined }), set: async () => undefined }),
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, get: () => undefined, data: () => ({}) }),
        set: async () => undefined,
        collection: () => ({ doc: () => ({ get: async () => ({ exists: false, get: () => undefined }) }) }),
      }),
    }),
  }),
  FieldPath: class {},
  FieldValue: { increment: () => 0, delete: () => 0 },
  Timestamp: { now: () => 0 },
}));

const VERBINDUNG = { mode: 'paper' as const, schluessel: { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' } };
const SCHNELL = { versuche: 2, pauseMs: 0 };

const folge = (
  ...schritte: Array<{ ok?: boolean; status?: number; body?: unknown }>
): ReturnType<typeof vi.fn> => {
  let i = 0;
  return vi.fn(async () => {
    const s = schritte[Math.min(i++, schritte.length - 1)]!;
    return {
      ok: s.ok ?? true,
      status: s.status ?? 200,
      text: async () => (s.body === undefined ? '' : JSON.stringify(s.body)),
    } as unknown as Response;
  });
};
const methoden = (f: ReturnType<typeof vi.fn>): string[] =>
  f.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? 'GET');
const order = (status: string, filled = '0', preis: string | null = null) => ({
  body: { id: 'o1', status, filled_qty: filled, filled_avg_price: preis },
});
const STORNO_OK = { ok: true, status: 200 }; // 204 ohne Körper
// Wortlaut der Alpaca-Antwort vom 24.11.
const RESERVIERT = {
  ok: false,
  status: 403,
  body: {
    available: '0', code: 40310000, existing_qty: '7', held_for_orders: '7',
    message: 'insufficient qty available for order (requested: 7, available: 0)',
    related_orders: ['e5bf3b5e-0000-0000-0000-000000000000'], symbol: 'XLB',
  },
};
const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

describe('schutzAufheben: „Storno angenommen" ist nicht „Stücke frei"', () => {
  it('pending_cancel → canceled: erst dann frei', async () => {
    const f = folge(STORNO_OK, order('pending_cancel'), order('pending_cancel'), order('canceled'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
    expect(methoden(f)).toEqual(['DELETE', 'GET', 'GET', 'GET']);
  });

  it('der Stop füllt WÄHREND des Stornos → sein Fill zählt, kein zweiter Verkauf', async () => {
    const f = folge(STORNO_OK, order('pending_cancel'), order('filled', '7', '48.2'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 7, fillPreis: 48.2, orderId: 'o1', restStorniert: true });
  });

  it('teilgefüllt und dann storniert → der Teilfill zählt, der Rest ist verifiziert tot', async () => {
    const f = folge(STORNO_OK, order('canceled', '3', '48.2'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 3, restStorniert: true });
  });

  it('Order nach dem Storno unbekannt (404) → frei', async () => {
    const f = folge(STORNO_OK, { ok: false, status: 404, body: { message: 'not found' } });
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
  });

  it('Storno wird im Fenster NICHT bestätigt → der Exit geht trotzdem raus (nie verhindern)', async () => {
    const f = folge(STORNO_OK, order('pending_cancel'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 3, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
    expect(methoden(f)).toEqual(['DELETE', 'GET', 'GET', 'GET']);
  });

  it('Netzfehler bei der Nachfrage ist kein Endzustand — weiterfragen, am Ende trotzdem frei', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n === 1) return { ok: true, status: 200, text: async () => '' } as unknown as Response;
      if (n === 2) throw new TypeError('fetch failed');
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'o1', status: 'canceled', filled_qty: '0' }) } as unknown as Response;
    });
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('das Fenster bleibt kurz: höchstens ~3 s je Exit (der Minuten-Puls hat 55 s)', () => {
    expect(STORNO_WARTE_VERSUCHE * STORNO_WARTE_PAUSE_MS).toBeLessThanOrEqual(3000);
    expect(STORNO_WARTE_VERSUCHE).toBeGreaterThanOrEqual(5);
  });
});

describe('routeOrder: ein Exit, dessen Stücke noch reserviert sind, wird wiederholt', () => {
  const exit = { uid: 'u1', symbol: 'XLB', side: 'sell' as const, qty: 7, laufId: 'umkehr-morgen-1', schliessend: true };

  it('403 „insufficient qty available", dann angenommen und gefüllt → ausgeführt', async () => {
    const f = folge(RESERVIERT, order('accepted'), order('filled', '7', '48.5'));
    const r = await routeOrder(VERBINDUNG, exit, f, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: true, fillMenge: 7, fillPreis: 48.5 });
    expect(methoden(f).filter((m) => m === 'POST')).toHaveLength(2);
  });

  it('bleibt die Reservierung, endet es wie bisher als broker_fehler — nach genau 1 + 2 Versuchen', async () => {
    const f = folge(RESERVIERT);
    const r = await routeOrder(VERBINDUNG, exit, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: false, grund: 'broker_fehler' });
    expect(RESERVIERUNG_WIEDERHOLUNGEN).toBe(2);
    expect(f).toHaveBeenCalledTimes(1 + RESERVIERUNG_WIEDERHOLUNGEN);
  });

  it('ein EINSTIEG wird nie wiederholt — auch nicht bei demselben Code', async () => {
    const f = folge(RESERVIERT);
    const r = await routeOrder(
      VERBINDUNG,
      { uid: 'u1', symbol: 'XLB', side: 'buy', qty: 7, laufId: 'umkehr-morgen-1', stornoBeiKeinFill: true },
      f,
      SCHNELL,
    );
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'broker_fehler' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('andere 403er (Wash-Trade, Kaufkraft) werden nicht wiederholt — Warten löst sie nicht', async () => {
    const wash = { ok: false, status: 403, body: { code: 40310100, message: 'potential wash trade detected' } };
    const f = folge(wash);
    const r = await routeOrder(VERBINDUNG, exit, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: false, grund: 'broker_fehler' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('stueckeReserviert erkennt genau diesen Fall', () => {
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"code":40310000,"message":"insufficient qty available for order"}', 403))).toBe(true);
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"available":"0","held_for_orders":"7"}', 403))).toBe(true);
    // derselbe Code, anderer Grund: Kaufkraft löst Warten nicht
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"code":40310000,"message":"insufficient buying power"}', 403))).toBe(false);
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"code":40310100,"message":"potential wash trade detected"}', 403))).toBe(false);
    expect(stueckeReserviert(new AlpacaFehler('HTTP 422: {"code":40310000}', 422))).toBe(false);
    expect(stueckeReserviert(new Error('insufficient qty available'))).toBe(false);
    expect(stueckeReserviert(null)).toBe(false);
  });
});

describe('Quelltext-Wächter', () => {
  it('die Wiederholung hängt an `schliessend` und an der Obergrenze', () => {
    const routing = lies('core', 'orderRouting.ts');
    expect(routing).toContain(
      "if (auftrag.schliessend !== true || !stueckeReserviert(err) || versuch >= RESERVIERUNG_WIEDERHOLUNGEN) throw err;",
    );
  });

  it('executeTrade räumt den Schutz-Stop weiter VOR dem Routing aus dem Weg', () => {
    const broker = lies('core', 'broker.ts');
    const f = broker.slice(broker.indexOf('export async function executeTrade'));
    const aufheben = f.indexOf('await schutzAufheben(verbindung, req.uid, req.symbol, schutz)');
    expect(aufheben).toBeGreaterThan(0);
    expect(aufheben).toBeLessThan(f.indexOf('const routing = await routeOrder(verbindung, {'));
  });

  it('auch schutzAnlegen wartet den Storno der alten Order ab, bevor die neue rausgeht', () => {
    const schutz = lies('core', 'schutzStop.ts');
    const f = schutz.slice(schutz.indexOf('export async function schutzAnlegen'), schutz.indexOf('export type SchutzAufhebung'));
    const warten = f.indexOf('await warteAufStornoEnde(verbindung, pos.schutz.orderId, fetchImpl, {})');
    expect(warten).toBeGreaterThan(0);
    expect(warten).toBeLessThan(f.indexOf('await alpacaStopOrder('));
  });
});
