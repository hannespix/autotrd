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
 * Gepinnt wird: Der Storno wird abgewartet; ein Fill während des Stornos
 * wird als Fill erkannt; lebt der Stop nach dem Fenster noch, wird der Exit
 * VERTAGT statt blind gesendet.
 *
 * Red-Team 24.11. (vor dem Merge), H1: Die erste Fassung wiederholte einen
 * abgewiesenen Verkauf in `routeOrder`. Verschwindet die Reservierung aber,
 * weil der Stop GEFÜLLT hat, trifft die Wiederholung auf Bestand 0 — ein
 * ungewollter Leerverkauf. Wiederholt wird deshalb nur über `executeTrade`,
 * das den Verbleib des Stops jedes Mal prüft; `routeOrder` meldet nur den
 * ehrlichen Grund.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AlpacaFehler } from '../src/core/alpacaBroker.js';
import { routeOrder, stueckeReserviert } from '../src/core/orderRouting.js';
import {
  STORNO_WARTE_FRIST_MS,
  STORNO_WARTE_PAUSE_MS,
  STORNO_WARTE_VERSUCHE,
  schutzAufheben,
  warteAufStornoEnde,
} from '../src/core/schutzStop.js';
import { UMKEHR_VERKAUF_NACHHOL_MS, verkaufNachholbar } from '../src/scheduled/umkehrLauf.js';

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

  it('Storno wird im Fenster NICHT bestätigt → der Exit wird VERTAGT, nicht blind gesendet', async () => {
    const f = folge(STORNO_OK, order('pending_cancel'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 3, pauseMs: 0 });
    expect(b).toEqual({ stand: 'offen' });
    expect(methoden(f)).toEqual(['DELETE', 'GET', 'GET', 'GET']);
  });

  it('lebt noch UND hat teilgefüllt → der Teilfill zählt (alter Zweig: Rest stornieren, einmal nachfragen)', async () => {
    const f = folge(
      STORNO_OK,
      order('partially_filled', '3', '48.2'), // einzige Nachfrage im Fenster
      { body: {} }, // DELETE des Rests
      order('canceled', '3', '48.2'),
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 1, pauseMs: 0 });
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 3, restStorniert: true });
  });

  it('Netzfehler bei der Nachfrage ist kein Endzustand — weiterfragen', async () => {
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

  it('JEDE Nachfrage scheitert → Verbleib unbekannt → vertagt', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n === 1) return { ok: true, status: 200, text: async () => '' } as unknown as Response;
      throw new TypeError('fetch failed');
    });
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 3, pauseMs: 0 });
    expect(b).toEqual({ stand: 'offen' });
  });

  it('„nicht stornierbar" und schon tot ohne Fill (toter Link vom Vortag) → frei, ohne Warten', async () => {
    const f = folge({ ok: false, status: 422, body: { message: 'not cancelable' } }, order('canceled'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLY', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
    expect(methoden(f)).toEqual(['DELETE', 'GET']);
  });

  it('„nicht stornierbar", lebt aber noch ohne Fill (pending_cancel) → abwarten statt sofort verkaufen', async () => {
    const f = folge(
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      order('pending_cancel'),
      order('pending_cancel'),
      order('canceled'),
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
    const haengt = folge({ ok: false, status: 422, body: { message: 'not cancelable' } }, order('pending_cancel'));
    expect(await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, haengt as never, { versuche: 2, pauseMs: 0 }))
      .toEqual({ stand: 'offen' });
  });
});

describe('schutzAufheben: ein Zustand, der nie endet, vertagt den Exit nicht auf Dauer', () => {
  it('Verknüpfung zeigt auf eine ERSETZTE Order (`replaced` nach Trailing) → frei wie bisher, ohne Warten', async () => {
    const f = folge({ ok: false, status: 422, body: { message: 'not cancelable' } }, order('replaced'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
    expect(b).toEqual({ stand: 'frei' });
    expect(methoden(f)).toEqual(['DELETE', 'GET']);
  });

  it('ebenso jeder andere nicht stornierbare Zustand ohne Fill', async () => {
    for (const status of ['stopped', 'suspended', 'calculated', 'accepted', '']) {
      const f = folge({ ok: false, status: 422, body: { message: 'not cancelable' } }, order(status));
      const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 5, pauseMs: 0 });
      expect(b, status).toEqual({ stand: 'frei' });
      expect(f, status).toHaveBeenCalledTimes(2);
    }
  });
});

describe('schutzAufheben: scheitert die Prüfung selbst, wird nicht blind verkauft (Runde 2, H-A)', () => {
  const kaputt = { ok: false, status: 500, body: 'kaputt' };

  it('Storno wirft (5xx), Order lebt ungefüllt → vertagt: der Stop hält die Stücke', async () => {
    const f = folge(kaputt, order('new'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 2, pauseMs: 0 });
    expect(b).toEqual({ stand: 'offen' });
  });

  it('Storno wirft, Order ist GEFÜLLT → ihr Fill zählt, kein eigener Verkauf', async () => {
    const f = folge(kaputt, order('filled', '7', '48.1'));
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never, { versuche: 2, pauseMs: 0 });
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 7, fillPreis: 48.1, restStorniert: true });
  });

  it('Storno wirft, Order ist tot ohne Fill (oder unbekannt) → frei', async () => {
    const tot = folge(kaputt, order('canceled'));
    expect(await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, tot as never)).toEqual({ stand: 'frei' });
    const weg = folge(kaputt, { ok: false, status: 404, body: { message: 'not found' } });
    expect(await schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, weg as never)).toEqual({ stand: 'frei' });
  });

  it('Storno wirft UND die Nachfrage wirft → Verbleib unklar → vertagt, kein Wurf nach außen', async () => {
    const f = folge(kaputt);
    await expect(schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never)).resolves.toEqual({ stand: 'offen' });
  });

  it('422 („sehr wahrscheinlich gefüllt") und die Nachfrage wirft → vertagt statt „frei"', async () => {
    const f = folge({ ok: false, status: 422, body: { message: 'not cancelable' } }, kaputt);
    await expect(schutzAufheben(VERBINDUNG, 'u1', 'XLB', { orderId: 'o1' }, f as never)).resolves.toEqual({ stand: 'offen' });
  });
});

describe('warteAufStornoEnde: eine Frist auf der Wanduhr', () => {
  it('die Vorgaben bleiben kurz (der Minuten-Puls hat 55 s)', () => {
    expect(STORNO_WARTE_FRIST_MS).toBeLessThanOrEqual(5000);
    expect(STORNO_WARTE_VERSUCHE * STORNO_WARTE_PAUSE_MS).toBeGreaterThanOrEqual(3000);
  });

  it('eine HÄNGENDE Nachfrage hält den Exit nicht über die Frist hinaus auf', async () => {
    const haengt = vi.fn(() => new Promise<Response>(() => undefined)); // antwortet nie
    const start = Date.now();
    const r = await warteAufStornoEnde(VERBINDUNG, 'u1', 'XLB', 'o1', haengt as never, { fristMs: 60, pauseMs: 0 });
    expect(r).toEqual({ art: 'offen', stand: null });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('ist die Frist um, wird nicht weitergefragt — auch wenn Versuche übrig wären', async () => {
    const f = folge(order('pending_cancel'));
    const r = await warteAufStornoEnde(VERBINDUNG, 'u1', 'XLB', 'o1', f as never, { fristMs: 40, pauseMs: 25, versuche: 100 });
    expect(r.art).toBe('offen');
    expect(f.mock.calls.length).toBeLessThan(10);
  });
});

describe('routeOrder: reservierte Stücke sind ein eigener, ehrlicher Grund — ohne blinde Wiederholung', () => {
  const exit = { uid: 'u1', symbol: 'XLB', side: 'sell' as const, qty: 7, laufId: 'umkehr-morgen-1', schliessend: true };

  it('H1: nach dem 403 geht KEIN zweiter Verkauf raus — auch wenn der nächste angenommen würde', async () => {
    // Der zweite Schritt stünde für „Stop hat inzwischen gefüllt, Bestand 0, Alpaca nimmt den Leerverkauf an".
    const f = folge(RESERVIERT, order('accepted'), order('filled', '7', '48.5'));
    const r = await routeOrder(VERBINDUNG, exit, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: false, grund: 'stuecke_reserviert' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('ein EINSTIEG bekommt den Grund nicht (dort gibt es nichts nachzuholen)', async () => {
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

  it('andere 403er (Wash-Trade, Kaufkraft) bleiben broker_fehler', async () => {
    const wash = { ok: false, status: 403, body: { code: 40310100, message: 'potential wash trade detected' } };
    const f = folge(wash);
    const r = await routeOrder(VERBINDUNG, exit, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: false, grund: 'broker_fehler' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('stueckeReserviert erkennt genau diesen Fall', () => {
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"code":40310000,"message":"insufficient qty available for order"}', 403))).toBe(true);
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"available":"0","held_for_orders":"7"}', 403))).toBe(true);
    // derselbe Code, anderer Grund: Kaufkraft
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"code":40310000,"message":"insufficient buying power"}', 403))).toBe(false);
    expect(stueckeReserviert(new AlpacaFehler('HTTP 403: {"code":40310100,"message":"potential wash trade detected"}', 403))).toBe(false);
    expect(stueckeReserviert(new AlpacaFehler('HTTP 422: {"code":40310000}', 422))).toBe(false);
    expect(stueckeReserviert(new Error('insufficient qty available'))).toBe(false);
    expect(stueckeReserviert(null)).toBe(false);
  });
});

describe('Umkehr-Lauf: Nachholrunde für vertagte Verkäufe', () => {
  it('nachgeholt wird nur, was am eigenen Schutz-Stop hing', () => {
    expect(verkaufNachholbar('broker_schutz_storno_offen')).toBe(true);
    // unbekannter Halter, unklarer Verbleib oder echter Fehler: kein zweiter Versuch im selben Lauf
    for (const g of ['broker_stuecke_reserviert', 'broker_broker_fehler', 'broker_kein_fill', 'broker_exit_laeuft', 'fill_schon_gebucht', 'kein_kurs', 'unbekannt', '']) {
      expect(verkaufNachholbar(g)).toBe(false);
    }
    expect(UMKEHR_VERKAUF_NACHHOL_MS).toBeGreaterThanOrEqual(10_000);
    expect(UMKEHR_VERKAUF_NACHHOL_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('Quelltext-Wächter', () => {
  const broker = lies('core', 'broker.ts');
  const routing = lies('core', 'orderRouting.ts');
  const lauf = lies('scheduled', 'umkehrLauf.ts');

  it('routeOrder sendet eine Order genau EINMAL — keine Schleife um den Versand', () => {
    expect(routing.split('await sende()').length - 1).toBe(1);
    expect(routing).toContain("if (auftrag.schliessend === true && stueckeReserviert(err)) {\n      return { ausgefuehrt: false, grund: 'stuecke_reserviert' };");
  });

  it('executeTrade räumt den Schutz-Stop VOR dem Routing aus dem Weg — und vertagt den Exit, solange der Stop lebt', () => {
    const f = broker.slice(broker.indexOf('export async function executeTrade'));
    const aufheben = f.indexOf('await schutzAufheben(verbindung, req.uid, req.symbol, schutz)');
    const vertagt = f.indexOf("if (aufhebung.stand === 'offen') {");
    const senden = f.indexOf('const routing = await routeOrder(verbindung, {');
    expect(aufheben).toBeGreaterThan(0);
    expect(vertagt).toBeGreaterThan(aufheben);
    expect(vertagt).toBeLessThan(senden);
    expect(f.slice(vertagt, vertagt + 400)).toContain("return { executed: false, reason: 'broker_schutz_storno_offen' };");
    // Wirft schutzAufheben, bleibt es beim bisherigen „frei" — eine Prüfung, die selbst ausfällt, hält keinen Exit auf.
    expect(f.slice(aufheben, aufheben + 300)).toContain("return { stand: 'frei' } as const;");
  });

  it('die Nachholrunde läuft NACH den Verkäufen, VOR den Käufen, und geht wieder durch executeTrade', () => {
    const runde = lauf.indexOf('if (nachholen.length > 0) {');
    expect(runde).toBeGreaterThan(lauf.indexOf('// 1) Verkäufe'));
    expect(runde).toBeLessThan(lauf.indexOf('// 2) Käufe'));
    expect(lauf.slice(runde, runde + 700)).toContain('const grund = await verkaufe(v, px);');
    expect(lauf.slice(runde, runde + 400)).toContain('UMKEHR_VERKAUF_NACHHOL_MS - (Date.now() - ersterAufschub)');
    // genau ein zweiter Versuch je Verkauf: die Runde füllt `nachholen` nicht wieder auf
    expect(lauf.split('nachholen.push(').length - 1).toBe(1);
  });

  it('auch schutzAnlegen wartet den Storno der alten Order ab — und legt nur an, wenn sie weg oder tot ohne Fill ist', () => {
    const schutz = lies('core', 'schutzStop.ts');
    const f = schutz.slice(schutz.indexOf('export async function schutzAnlegen'), schutz.indexOf('export type SchutzAufhebung'));
    const warten = f.indexOf('await warteAufStornoEnde(verbindung, uid, symbol, pos.schutz.orderId, fetchImpl, {})');
    expect(warten).toBeGreaterThan(0);
    expect(warten).toBeLessThan(f.indexOf('await alpacaStopOrder('));
    expect(f).toContain("const frei = ende.art === 'weg' || (ende.art === 'ende' && !(ende.stand.filledQty > 0));");
  });
});
