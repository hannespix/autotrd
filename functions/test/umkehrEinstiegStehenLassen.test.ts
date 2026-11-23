/**
 * Umkehr-Einstiege bleiben beim Broker stehen (23.11.).
 *
 * Befund: Der Morgenlauf (09:35 ET) schickt Market-Orders, wartet 12 s und
 * storniert, was bis dahin nicht gefüllt ist (K-2c). Alpaca füllt zur
 * Eröffnung aber oft später — am 23.11. 1 von 2 PFE und 0 von 1 XLF, am
 * 10.11. CVX/PM/XOM, am 13.11. ABT 2 von 3. Die Strategie bekam ihre
 * Signale am Broker-Konto schlicht nicht.
 *
 * Der Storno schützt vor Doppelpositionen bei Wegen, die wiederholt kaufen.
 * Die Umkehr kauft je Plan einmal; dort bleibt die Order bis zu zehn
 * Minuten stehen und der Nachlauf bucht. Gepinnt wird, dass die Ausnahme
 * GENAU diese Orders trifft — und sonst nichts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOrder } from '../src/core/orderRouting.js';
import {
  UMKEHR_EINSTIEG_GEDULD_MS,
  nachlaufLaesstArbeiten,
  umkehrEinstiegBleibtStehen,
} from '../src/core/broker.js';

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
      text: async () => (typeof s.body === 'string' ? s.body : JSON.stringify(s.body ?? {})),
    } as unknown as Response;
  });
};
const methoden = (f: ReturnType<typeof vi.fn>): string[] =>
  f.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? 'GET');
const order = (status: string, filled = '0', preis = '0') => ({
  body: { id: 'o1', status, filled_qty: filled, filled_avg_price: preis },
});
const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const umkehr = {
  uid: 'u1', symbol: 'PFE', side: 'buy' as const, qty: 2, laufId: 'umkehr-morgen-1',
  stornoBeiKeinFill: true, restStehenLassen: true,
};

describe('routeOrder mit restStehenLassen', () => {
  it('kein Fill im Fenster → KEIN Storno, „order_laeuft", Vermerk ohne Buchung', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), order('accepted'));
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'order_laeuft' });
    expect(r.offen).toMatchObject({ art: 'einstieg_rest', orderId: 'o1' });
    expect(r.offen?.clientOrderId).toContain('u1-PFE-buy-2-umkehr-morgen-1');
    expect(methoden(f)).not.toContain('DELETE');
  });

  it('Teilfill im Fenster → gebucht wird die Menge von eben, der Rest bleibt stehen (23.11.: 1 von 2 PFE)', async () => {
    const f = folge(order('accepted'), order('partially_filled', '1', '27.36'), order('partially_filled', '1', '27.36'));
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: true, fillMenge: 1, fillPreis: 27.36, brokerOrderId: 'o1' });
    expect(r.offen).toMatchObject({ art: 'einstieg_rest', orderId: 'o1' });
    expect(methoden(f)).not.toContain('DELETE');
  });

  it('voll gefüllt → wie immer, kein Vermerk', async () => {
    const f = folge(order('accepted'), order('filled', '2', '27.4'));
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: true, fillPreis: 27.4, fillMenge: 2, brokerOrderId: 'o1' });
  });

  it('vom Broker ABGELEHNT → „kein_fill" ohne Vermerk, nicht „läuft noch"', async () => {
    const f = folge(order('accepted'), order('rejected'), order('rejected'));
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: false, grund: 'kein_fill' });
  });

  it('Fill in der letzten Sekunde (nach dem Fenster, vor der Rückkehr) → sofort gebucht, kein Vermerk', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), order('filled', '2', '27.41'));
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: true, fillPreis: 27.41, fillMenge: 2, brokerOrderId: 'o1' });
  });

  it('die Schluss-Nachfrage scheitert → vorsichtige Lesart: Vermerk, der Nachlauf klärt es', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), { ok: false, status: 500, body: 'kaputt' });
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'order_laeuft' });
    expect(r.offen).toMatchObject({ art: 'einstieg_rest', orderId: 'o1' });
  });

  it('OHNE den Schalter storniert jeder Einstieg wie bisher (K-2c unverändert)', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), { body: {} }, order('canceled'));
    const r = await routeOrder(VERBINDUNG, { ...umkehr, restStehenLassen: false }, f, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'kein_fill' });
    expect(methoden(f)).toContain('DELETE');
  });

  it('an einem EXIT ändert der Schalter nichts — der bleibt exit_offen', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'));
    const r = await routeOrder(
      VERBINDUNG,
      { uid: 'u1', symbol: 'PFE', side: 'sell', qty: 2, laufId: 'umkehr-abend-1', schliessend: true, restStehenLassen: true },
      f,
      SCHNELL,
    );
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'kein_fill' });
    expect(r.offen).toMatchObject({ art: 'exit_offen' });
  });
});

describe('wer stehen bleiben darf — und wie lange', () => {
  it('nur eröffnende MARKET-Orders der Umkehr', () => {
    expect(umkehrEinstiegBleibtStehen(true, 'umkehr', false)).toBe(true);
    expect(umkehrEinstiegBleibtStehen(true, 'umkehr', true)).toBe(false); // Krypto-Limit behält seinen Storno
    expect(umkehrEinstiegBleibtStehen(false, 'umkehr', false)).toBe(false); // Exit
    for (const q of ['scan', 'sockel', 'momentum', 'hand', null]) {
      expect(umkehrEinstiegBleibtStehen(true, q, false)).toBe(false);
    }
  });

  it('der Nachlauf lässt nur Umkehr-Vermerke arbeiten, und nur innerhalb der Geduld', () => {
    expect(UMKEHR_EINSTIEG_GEDULD_MS).toBe(600_000);
    expect(nachlaufLaesstArbeiten('umkehr', 0)).toBe(true);
    expect(nachlaufLaesstArbeiten('umkehr', UMKEHR_EINSTIEG_GEDULD_MS - 1)).toBe(true);
    expect(nachlaufLaesstArbeiten('umkehr', UMKEHR_EINSTIEG_GEDULD_MS)).toBe(false);
    // Kaputter oder fehlender Zeitstempel → stornieren (die sichere Seite)
    expect(nachlaufLaesstArbeiten('umkehr', Number.NaN)).toBe(false);
    expect(nachlaufLaesstArbeiten('umkehr', -5)).toBe(false);
    for (const q of ['scan', 'sockel', 'momentum', undefined, null]) {
      expect(nachlaufLaesstArbeiten(q, 1000)).toBe(false);
    }
  });
});

describe('Quelltext-Wächter: die Verdrahtung', () => {
  const broker = lies('core', 'broker.ts');
  const lauf = lies('scheduled', 'umkehrLauf.ts');

  it('executeTrade setzt den Schalter NUR über umkehrEinstiegBleibtStehen', () => {
    expect(broker).toContain(
      "...(umkehrEinstiegBleibtStehen(eroeffnet, einstiegFruh, limitPreis > 0) ? { restStehenLassen: true } : {}),",
    );
    expect(broker.split('restStehenLassen: true').length - 1).toBe(1);
  });

  it('der Nachlauf storniert weiter alles — außer Umkehr-Vermerken in ihrer Geduld, gelesen aus dem Auftrags-Stempel', () => {
    const f = broker.slice(broker.indexOf('export async function bucheOffeneOrders'));
    expect(f).toContain(
      'if (eroeffnend && !ORDER_ENDZUSTAENDE.has(stand.status) && !nachlaufLaesstArbeiten(d.quelle, alter)) {',
    );
    // nicht `quelleNach`: das wäre aus der Lauf-Kennung GERATEN
    expect(f).not.toContain('nachlaufLaesstArbeiten(quelleNach');
  });

  it('der Morgenlauf zählt „läuft noch" getrennt von „abgelehnt"', () => {
    expect(lauf).toContain("} else if (r.reason === 'broker_order_laeuft') {");
    expect(lauf).toContain('ohne.laeuftNoch += 1;');
    expect(lauf).toContain('a.laeuftNoch += b.laeuftNoch;');
  });
});
