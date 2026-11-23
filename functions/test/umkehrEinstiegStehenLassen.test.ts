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
 * Die Umkehr kauft je Plan einmal; dort bleibt eine UNGEFÜLLTE Order bis zu
 * zehn Minuten stehen und der Nachlauf bucht. Gepinnt wird, dass die
 * Ausnahme GENAU diese Orders trifft — und sonst nichts.
 *
 * Red-Team 23.11. (vor dem Merge): Eine Buch-Position neben einer
 * arbeitenden Kauf-Order desselben Symbols ist verboten — Alpaca weist dann
 * Schutz-Stop und Exit als Wash-Trade ab. Deshalb: ab dem ersten gefüllten
 * Stück wird der Rest storniert; die Geduld hängt an einem eigenen Merkmal
 * des Vermerks, nicht an der Quelle; die nachgebuchte Position bekommt
 * ihren Stop; der Sockel kauft nicht in eine laufende Order.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOrder } from '../src/core/orderRouting.js';
import {
  UMKEHR_EINSTIEG_GEDULD_MS,
  nachlaufLaesstArbeiten,
  nachlaufSchutzFaellig,
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
    expect(r.offen).toEqual({
      art: 'einstieg_rest', orderId: 'o1', clientOrderId: r.offen?.clientOrderId, stehenGelassen: true,
    });
    expect(r.offen?.clientOrderId).toContain('u1-PFE-buy-2-umkehr-morgen-1');
    expect(methoden(f)).not.toContain('DELETE');
  });

  it('Teilfill im Fenster → der Rest wird STORNIERT wie immer (keine Position neben arbeitender Kauf-Order)', async () => {
    const f = folge(
      order('accepted'),
      order('partially_filled', '1', '27.36'),
      order('partially_filled', '1', '27.36'),
      { body: {} }, // DELETE angenommen
      order('canceled', '1', '27.36'),
    );
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: true, fillPreis: 27.36, fillMenge: 1, brokerOrderId: 'o1' });
    expect(methoden(f)).toContain('DELETE');
  });

  it('Teilfill erst NACH dem Fenster (Schluss-Nachfrage) → ebenfalls Storno, kein „läuft noch"', async () => {
    const f = folge(
      order('accepted'), order('accepted'), order('accepted'),
      order('partially_filled', '1', '27.36'), // Schluss-Nachfrage
      { body: {} }, // DELETE angenommen
      order('canceled', '1', '27.36'),
    );
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: true, fillPreis: 27.36, fillMenge: 1, brokerOrderId: 'o1' });
    expect(methoden(f)).toContain('DELETE');
  });

  it('nach dem Fenster vom Broker storniert, aber TEILgefüllt → die Endmenge wird gebucht, kein Vermerk', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), order('canceled', '1', '27.36'));
    const r = await routeOrder(VERBINDUNG, umkehr, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: true, fillPreis: 27.36, fillMenge: 1, brokerOrderId: 'o1' });
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
    expect(r.offen).toMatchObject({ art: 'einstieg_rest', orderId: 'o1', stehenGelassen: true });
  });

  it('ein Storno, der NICHT zum Endzustand kommt, trägt das Merkmal nicht (M3)', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), { body: {} }, order('pending_cancel'));
    const r = await routeOrder(VERBINDUNG, { ...umkehr, restStehenLassen: false }, f, SCHNELL);
    expect(r.offen).toMatchObject({ art: 'einstieg_rest' });
    expect(r.offen?.stehenGelassen).toBeUndefined();
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

  it('der Nachlauf lässt nur MARKIERTE, UNGEFÜLLTE Vermerke arbeiten, und nur innerhalb der Geduld', () => {
    expect(UMKEHR_EINSTIEG_GEDULD_MS).toBe(600_000);
    expect(nachlaufLaesstArbeiten(true, 0, 0)).toBe(true);
    expect(nachlaufLaesstArbeiten(true, UMKEHR_EINSTIEG_GEDULD_MS - 1, 0)).toBe(true);
    expect(nachlaufLaesstArbeiten(true, UMKEHR_EINSTIEG_GEDULD_MS, 0)).toBe(false);
    // Ab dem ersten gefüllten Stück: stornieren (H1/H2)
    expect(nachlaufLaesstArbeiten(true, 1000, 1)).toBe(false);
    expect(nachlaufLaesstArbeiten(true, 1000, 0.000001)).toBe(false);
    // Kaputter oder fehlender Zeitstempel → stornieren (die sichere Seite)
    expect(nachlaufLaesstArbeiten(true, Number.NaN, 0)).toBe(false);
    expect(nachlaufLaesstArbeiten(true, -5, 0)).toBe(false);
    // Das Merkmal zählt, nicht die Quelle (M3) — und nur das echte `true`
    for (const m of ['umkehr', 'true', 1, undefined, null, false]) {
      expect(nachlaufLaesstArbeiten(m, 1000, 0)).toBe(false);
    }
  });

  it('Schutz-Stop nach dem Nachlauf: nur eröffnend, nur im Endzustand, nur mit Fill', () => {
    expect(nachlaufSchutzFaellig(true, true, 2)).toBe(true);
    expect(nachlaufSchutzFaellig(true, false, 2)).toBe(false); // Kauf-Order lebt noch → Wash-Trade
    expect(nachlaufSchutzFaellig(true, true, 0)).toBe(false); // nichts gefüllt, nichts zu schützen
    expect(nachlaufSchutzFaellig(false, true, 2)).toBe(false); // Exit
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
      'if (eroeffnend && !ORDER_ENDZUSTAENDE.has(stand.status) && !nachlaufLaesstArbeiten(d.stehenGelassen, alter, stand.filledQty)) {',
    );
    // weder die Quelle des Auftrags noch die aus der Kennung geratene (M3)
    expect(f).not.toContain('nachlaufLaesstArbeiten(d.quelle');
    expect(f).not.toContain('nachlaufLaesstArbeiten(quelleNach');
  });

  it('das Merkmal schreibt NUR der Vermerk aus dem Routing — kein anderer Weg kann es setzen', () => {
    expect(broker).toContain("...(offen.stehenGelassen === true ? { stehenGelassen: true } : {}),");
    expect(broker.split('stehenGelassen: true').length - 1).toBe(1);
    const routing = lies('core', 'orderRouting.ts');
    expect(routing.split('stehenGelassen: true').length - 1).toBe(1);
    expect(lies('scheduled', 'fillSync.ts')).not.toContain('stehenGelassen');
  });

  it('H1: der Nachlauf legt im Endzustand den Schutz-Stop an — VOR dem Löschen des Vermerks', () => {
    const f = broker.slice(broker.indexOf('export async function bucheOffeneOrders'));
    const schutz = f.indexOf('if (nachlaufSchutzFaellig(eroeffnend, endzustand, stand.filledQty)) {');
    expect(schutz).toBeGreaterThan(0);
    expect(f.slice(schutz, schutz + 600)).toContain("risikoFuer(strategy.engine, klasse, quelleNach === 'sockel', quelleNach),");
    expect(f.indexOf('await doc.ref.delete().catch(() => undefined);', schutz)).toBeGreaterThan(schutz);
    // und zwar nach der Buchung: eine gescheiterte Buchung springt vorher ab
    expect(f.indexOf('NICHT gebucht')).toBeLessThan(schutz);
  });

  it('M4/N1: der Vermerk trägt Entscheidungskurs, Statistik-Kennung und Signal-Kontext; die Nachbuchung reicht sie durch', () => {
    expect(broker).toContain('kurs: req.price,');
    const f = broker.slice(broker.indexOf('export async function bucheOffeneOrders'));
    expect(f).toContain('price: eroeffnend && zahl(d.kurs) > 0 ? zahl(d.kurs) : stand.filledAvgPreis,');
    expect(f).toContain('fillPreis: stand.filledAvgPreis,');
    expect(f).toContain('...(eroeffnend && d.bucket ? { bucket: d.bucket } : {}),');
    expect(f).toContain('...(eroeffnend && d.signalContext ? { signalContext: d.signalContext } : {}),');
  });

  it('M1: der Sockel-Lauf kauft kein Symbol, zu dem noch eine Einstiegs-Order arbeitet', () => {
    const mom = lies('scheduled', 'momentumRun.ts');
    expect(mom).toContain('const arbeitend = await offeneEinstiegsSymbole(userDoc.id);');
    expect(mom).toContain('if (arbeitend.has(o.symbol)) continue;');
    expect(broker).toContain("if (art !== 'exit_offen' && typeof symbol === 'string' && symbol) symbole.add(symbol);");
  });

  it('der Morgenlauf zählt „läuft noch" getrennt von „abgelehnt"', () => {
    expect(lauf).toContain("} else if (r.reason === 'broker_order_laeuft') {");
    expect(lauf).toContain('ohne.laeuftNoch += 1;');
    expect(lauf).toContain('a.laeuftNoch += b.laeuftNoch;');
  });
});
