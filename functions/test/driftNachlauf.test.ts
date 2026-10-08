/**
 * Drift-Paket 1 (08.10.) — warum Depot und Buch immer wieder auseinanderliefen.
 *
 * Drei Prüfer haben die offenen Wege belegt: (1) Der Minuten-Puls buchte
 * nach einem Broker-Stop über ganze Stücke die GANZE Position aus, das
 * Bruchstück blieb beim Broker. (2) Ein Einstieg, dessen Annahme im
 * Netzfehler unterging, füllte trotzdem — ohne Buch. (3) Ein Exit ohne Fill
 * blieb stehen; der nächste Lauf verkaufte unter neuer Kennung ein zweites
 * Mal (Leerverkauf). Dazu der Duplicate-Pfad, der einen verbuchten Teilfill
 * ein zweites Mal buchte, statt den Rest zu verkaufen.
 *
 * Gepinnt wird: jede offene Order bekommt einen Vermerk, kein Fill wird
 * zweimal gebucht, der Stop-Rest bleibt im Buch, und Exits werden durch
 * keine der neuen Prüfungen verhindert.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ergaenzeVerlauf } from '../src/core/brokerAbgleich.js';
import { eigeneOffeneOrder, routeOrder } from '../src/core/orderRouting.js';
import { schutzAufheben } from '../src/core/schutzStop.js';

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

const SCHLUESSEL = { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' };
const VERBINDUNG = { mode: 'paper' as const, schluessel: SCHLUESSEL };
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

describe('routeOrder: offene Orders bekommen einen Vermerk', () => {
  const einstieg = { uid: 'u1', symbol: 'CCG', side: 'buy' as const, qty: 100, laufId: 'scan-1', stornoBeiKeinFill: true };

  it('Einstiegs-Rest nach Storno nicht im Endzustand → einstieg_rest', async () => {
    const f = folge(
      order('accepted'),
      order('partially_filled', '40', '6.5'),
      order('partially_filled', '40', '6.5'),
      { body: {} }, // DELETE angenommen
      order('pending_cancel', '40', '6.5'),
      order('pending_cancel', '40', '6.5'),
      order('pending_cancel', '40', '6.5'),
    );
    const r = await routeOrder(VERBINDUNG, einstieg, f, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: true, fillMenge: 40, brokerOrderId: 'o1' });
    expect(r.offen).toMatchObject({ art: 'einstieg_rest', orderId: 'o1' });
    expect(r.offen?.clientOrderId).toContain('u1-CCG-buy-100-scan-1');
  });

  it('Endzustand erreicht → KEIN Vermerk (nichts bleibt offen)', async () => {
    const f = folge(
      order('accepted'),
      order('partially_filled', '40', '6.5'),
      order('partially_filled', '40', '6.5'),
      { body: {} },
      order('canceled', '45', '6.51'),
    );
    const r = await routeOrder(VERBINDUNG, einstieg, f, SCHNELL);
    expect(r).toEqual({ ausgefuehrt: true, fillPreis: 6.51, fillMenge: 45, brokerOrderId: 'o1' });
  });

  it('kein Fill und Order nach Storno nicht tot → einstieg_rest ohne Buchung', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'), { body: {} }, order('pending_cancel'));
    const r = await routeOrder(VERBINDUNG, einstieg, f, SCHNELL);
    expect(r.ausgefuehrt).toBe(false);
    expect(r.offen).toMatchObject({ art: 'einstieg_rest', orderId: 'o1' });
  });

  it('Netzfehler beim Platzieren eines EINSTIEGS → einstieg_unbekannt mit Client-Kennung', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const r = await routeOrder(VERBINDUNG, einstieg, f as never, SCHNELL);
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'broker_fehler' });
    expect(r.offen).toMatchObject({ art: 'einstieg_unbekannt' });
    expect(r.offen?.orderId).toBeUndefined();
    expect(r.offen?.clientOrderId).toContain('u1-CCG-buy-100-scan-1');
  });

  it('Netzfehler bei einem EXIT → kein Vermerk (nichts wurde platziert, der Exit wiederholt sich)', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const r = await routeOrder(
      VERBINDUNG,
      { uid: 'u1', symbol: 'CCG', side: 'sell', qty: 10, laufId: 'scan-1', schliessend: true },
      f as never,
      SCHNELL,
    );
    expect(r).toEqual({ ausgefuehrt: false, grund: 'broker_fehler' });
  });

  it('Exit ohne Fill im Fenster bleibt stehen UND wird als exit_offen vermerkt', async () => {
    const f = folge(order('accepted'), order('accepted'), order('accepted'));
    const r = await routeOrder(
      VERBINDUNG,
      { uid: 'u1', symbol: 'CCG', side: 'sell', qty: 10, laufId: 'scan-1', schliessend: true },
      f,
      SCHNELL,
    );
    expect(r).toMatchObject({ ausgefuehrt: false, grund: 'kein_fill' });
    expect(r.offen).toMatchObject({ art: 'exit_offen', orderId: 'o1' });
    expect(methoden(f)).not.toContain('DELETE'); // Exits werden nie storniert
  });
});

describe('schutzAufheben: der Rest der Stop-Order wird verifiziert', () => {
  it('„nicht stornierbar", teilgefüllt (ganze Stücke), Storno des Rests bestätigt → restStorniert:true', async () => {
    const f = folge(
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      order('partially_filled', '1', '98.4'),
      { body: {} }, // DELETE des Rests
      order('canceled', '1', '98.4'),
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 1, fillPreis: 98.4, restStorniert: true });
    expect(methoden(f)).toEqual(['DELETE', 'GET', 'DELETE', 'GET']);
  });

  it('Rest füllt während des Stornos noch nach → die VERIFIZIERTE Menge zählt', async () => {
    const f = folge(
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      order('partially_filled', '1', '98.4'),
      { body: {} },
      order('filled', '2', '98.3'),
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 2, fillPreis: 98.3, restStorniert: true });
  });

  it('Netzfehler bei der Nachfrage ist KEIN Endzustand (Red-Team H2) — keine Zusicherung', async () => {
    let n = 0;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      n += 1;
      if (n === 1) return { ok: false, status: 422, text: async () => JSON.stringify({ message: 'not cancelable' }) } as unknown as Response;
      if (n === 2) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'o1', status: 'partially_filled', filled_qty: '1', filled_avg_price: '98.4' }) } as unknown as Response;
      if (init?.method === 'DELETE') throw new TypeError('fetch failed');
      throw new TypeError('fetch failed'); // Nachfrage wirft — Stand unbekannt
    });
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 1, restStorniert: false });
  });

  it('Rest lebt weiter (kein Endzustand) → KEINE Zusicherung: sicherer voller Schluss', async () => {
    const f = folge(
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      order('partially_filled', '1', '98.4'),
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      order('partially_filled', '1', '98.4'),
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b).toMatchObject({ stand: 'gefuellt', fillQty: 1, restStorniert: false });
  });
});

describe('eigeneOffeneOrder: nur UNSERE laufende Market-Order gleicher Richtung', () => {
  const offen = [
    { id: 'stop', client_order_id: 'u1-AAPL-sell-10-x', symbol: 'AAPL', side: 'sell', type: 'stop', qty: '10' },
    { id: 'fremd', client_order_id: 'hand-123', symbol: 'AAPL', side: 'sell', type: 'market', qty: '5' },
    { id: 'andere', client_order_id: 'u2-AAPL-sell-3-y', symbol: 'AAPL', side: 'sell', type: 'market', qty: '3' },
    { id: 'kauf', client_order_id: 'u1-AAPL-buy-10-z', symbol: 'AAPL', side: 'buy', type: 'market', qty: '10' },
    { id: 'exit', client_order_id: 'u1-AAPL-sell-10-exit-2026', symbol: 'AAPL', side: 'sell', type: 'market', qty: '10' },
  ];
  it('findet den eigenen Exit, nicht den Schutz-Stop, nicht die Hand-Order, nicht fremde Konten', async () => {
    const f = folge({ body: offen });
    const o = await eigeneOffeneOrder(VERBINDUNG, 'u1', 'AAPL', 'sell', f as never);
    expect(o).toEqual({ id: 'exit', clientOrderId: 'u1-AAPL-sell-10-exit-2026', qty: 10 });
  });
  it('nichts da → null; Nachfrage scheitert → null (ein Exit wird nie verhindert)', async () => {
    expect(await eigeneOffeneOrder(VERBINDUNG, 'u1', 'MSFT', 'sell', folge({ body: offen }) as never)).toBeNull();
    const kaputt = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await eigeneOffeneOrder(VERBINDUNG, 'u1', 'AAPL', 'sell', kaputt as never)).toBeNull();
  });
});

describe('ergaenzeVerlauf: auch ein Zahlenwechsel bei gleichem Zustand ist ein Ereignis', () => {
  const eintrag = { at: '2026-10-08T06:05:00Z', nach: 'drift' as const, fehlbestand: 0, fremdbestand: 2 };
  it('drift(1 fremd) → drift(2 fremd) wird protokolliert', () => {
    const v = ergaenzeVerlauf([], 'drift', eintrag, 12, { fehlbestand: 0, fremdbestand: 1 });
    expect(v).toHaveLength(1);
    expect(v![0]).toMatchObject({ von: 'drift', nach: 'drift', fremdbestand: 2 });
  });
  it('gleiche Zahlen → null; ohne Vorher-Zähler → null (bisheriges Verhalten)', () => {
    expect(ergaenzeVerlauf([], 'drift', eintrag, 12, { fehlbestand: 0, fremdbestand: 2 })).toBeNull();
    expect(ergaenzeVerlauf([], 'drift', eintrag)).toBeNull();
    expect(ergaenzeVerlauf([], 'sauber', { ...eintrag, nach: 'sauber' }, 12, { fehlbestand: 0, fremdbestand: 0 })).toBeNull();
  });
});

describe('Quelltext-Wächter: die Verdrahtung', () => {
  const broker = lies('core', 'broker.ts');
  const scan = lies('scheduled', 'scanMarket.ts');
  const dashboard = readFileSync(join(import.meta.dirname, '..', '..', 'frontend', 'src', 'dashboard.ts'), 'utf8');
  const anzahl = (text: string, nadel: string): number => text.split(nadel).length - 1;

  it('executeTrade: jeder Exit trägt die positionsstabile Kennung', () => {
    expect(anzahl(broker, 'const lauf = auftragsLauf(req, position, laufId, schliesst);')).toBe(1);
  });

  it('kein Fill wird zweimal gebucht — Routing-Pfad UND Stop-Pfad fragen das Buch', () => {
    expect(anzahl(broker, "if (aufhebung.stand === 'gefuellt' && await fillSchonGebucht(req.uid, aufhebung.orderId)) {")).toBe(1);
    expect(anzahl(broker, 'if (await fillSchonGebucht(req.uid, routing.brokerOrderId)) {')).toBe(1);
  });

  it('Puls-Pfad: der Stop-Rest bleibt im Buch, wenn er verifiziert tot ist', () => {
    expect(anzahl(broker, 'restStorniert: aufhebung.restStorniert === true,')).toBe(1);
  });

  it('eine laufende schließende Order wird abgewartet, nie verdoppelt — und nie zur Sperre', () => {
    expect(anzahl(broker, 'const laufend = await eigeneOffeneOrder(verbindung, req.uid, req.symbol, req.side);')).toBe(1);
    expect(anzahl(broker, "return { executed: false, reason: 'broker_exit_laeuft' };")).toBe(1);
    // die Nachfrage selbst fängt Fehler und liefert null — der Exit geht dann normal raus
    const routing = lies('core', 'orderRouting.ts');
    expect(routing).toContain('offene Orders nicht lesbar — Exit geht normal raus');
  });

  it('offene Orders werden vermerkt und im Scan VOR den Positionen nachgefragt', () => {
    expect(anzahl(broker, 'if (routing.offen) {')).toBe(1);
    expect(anzahl(broker, 'await merkeOffeneOrder(req.uid, req.symbol, req.side, routing.offen, {')).toBe(1);
    const nachlauf = scan.indexOf('const nachlauf = await bucheOffeneOrders(uid, strategy).catch(');
    const nachbuchung = scan.indexOf('const nachbuchung = await bucheUnverbuchteFills(uid, strategy).catch(');
    const positionen = scan.indexOf("const positionsSnap = await userDoc.ref.collection('positions').get();");
    expect(nachlauf).toBeGreaterThan(0);
    expect(nachlauf).toBeLessThan(nachbuchung);
    expect(nachbuchung).toBeLessThan(positionen);
  });

  it('Nachlauf: Einstiege buchen nur die DIFFERENZ als Aufstockung, Exits nur mit Endzustand-Zusicherung', () => {
    const f = broker.slice(broker.indexOf('export async function bucheOffeneOrders'));
    expect(f).toContain('const neu = stand.filledQty - gebucht;');
    expect(f).toContain("? { aufstockung: true, ...(d.side === 'sell' ? { openShort: true } : {}) }");
    expect(f).toContain("{ restStorniert: endzustand, riskExit: 'exit_nachlauf' }");
    // ein eröffnender Rest wird storniert, bevor gebucht wird
    expect(f).toContain('if (eroeffnend && !ORDER_ENDZUSTAENDE.has(stand.status)) {');
    // ein nicht buchbarer Fill verschwindet nie stumm: der Vermerk bleibt stehen (M1), nach NACHLAUF_MAX_TAGE wird laut aufgegeben
    expect(f).toContain('ohne Endzustand — aufgegeben, Fall für die Übernahme');
  });

  it('Symbol-Sperre: kein Einstieg in ein Symbol, das Buch und Broker verschieden führen', () => {
    expect(anzahl(scan, "if (echtesBuch && abweichSymbole.has(symbol)) { gate.fremdbestand += 1; return 'fremdbestand'; }")).toBe(1);
    expect(anzahl(scan, 'const abweichSymbole = new Set(abgleichBefund.abweichungen.map((a) => a.symbol));')).toBe(1);
    expect(dashboard).toContain("['fremdbestand', t('gate.fremdbestand')],");
  });

  it('H1: Die verbrauchte Stop-Order wird VOR der Buchung von der Position gelöst — und ein schon gebuchter Fill beendet den Exit nicht', () => {
    const et = broker.slice(broker.indexOf('export async function executeTrade'), broker.indexOf('export async function merkeOffeneOrder'));
    const schon = et.indexOf("if (aufhebung.stand === 'gefuellt' && await fillSchonGebucht(req.uid, aufhebung.orderId)) {");
    const buchung = et.indexOf("} else if (aufhebung.stand === 'gefuellt') {");
    const routing = et.indexOf('const routing = await routeOrder(');
    expect(schon).toBeGreaterThan(0);
    expect(schon).toBeLessThan(buchung);
    expect(buchung).toBeLessThan(routing);
    // Gelöst wird NACH gelungener Teilschluss-Buchung (M-B) — und im „schon gebucht"-Zweig
    expect(anzahl(et, 'await schutzVerknuepfungLoesen(req.uid, req.symbol);')).toBe(2);
    expect(et).toContain("} else if (aufhebung.restStorniert === true && aufhebungsBuchung.trade?.teilSchluss === true) {");
    // im „schon gebucht"-Zweig gibt es KEIN return — der Rest geht ins Routing
    const zweig = et.slice(schon, buchung);
    expect(zweig).not.toContain('return ');
    expect(zweig).toContain('Rest wird regulär geschlossen');
  });

  it('H1 im Scan: der pflegeSchutz-Pfad fragt das Buch, bevor er den Stop-Fill bucht', () => {
    expect(anzahl(scan, "const schonGebucht = befund.stand === 'gefuellt' && await fillSchonGebucht(uid, befund.orderId);")).toBe(1);
    expect(anzahl(scan, "if (befund.stand === 'gefuellt' && !schonGebucht) {")).toBe(1);
  });

  it('M1/M3: der Nachlauf summiert das Buch je Order, lässt eine gescheiterte Differenz STEHEN und setzt Vermerke nicht zurück', () => {
    const f = broker.slice(broker.indexOf('export async function bucheOffeneOrders'));
    expect(f).toContain('const gebucht = Math.max(zahl(d.gebuchteMenge), await gebuchteMengeJeOrder(uid, stand.id));');
    expect(f).not.toContain('await merkeUnbookedFill(');
    expect(f).toContain("NICHT gebucht — ${r.reason ?? 'unbekannt'} (Vermerk bleibt)");
    const m = broker.slice(broker.indexOf('export async function merkeOffeneOrder'), broker.indexOf('export async function bucheOffeneOrders'));
    expect(m).toContain('await ref.create({');
    expect(m).not.toContain('versuche: 0,\n      },\n      { merge: true }');
  });

  it('N1: die Doppelbuchungs-Sperre sitzt INNERHALB der Transaktion — nur Differenzen (aufstockung) dürfen dieselbe Order erneut buchen', () => {
    const b = broker.slice(broker.indexOf('export async function executePaperTrade'));
    expect(b).toContain("if (req.brokerOrderId && req.aufstockung !== true) {");
    expect(b).toContain("userRef.collection('trades').where('brokerOrderId', '==', req.brokerOrderId).limit(1),");
    expect(b.indexOf("reason: 'fill_schon_gebucht'")).toBeLessThan(b.indexOf('const echterFill ='));
  });

  it('M-A: auch eine dauerhaft scheiternde Differenz wird nach NACHLAUF_MAX_TAGE laut aufgegeben', () => {
    const f = broker.slice(broker.indexOf('export async function bucheOffeneOrders'));
    expect(f).toContain('Tagen nicht buchbar (${r.reason ?? \'unbekannt\'}) — aufgegeben, Fall für die Übernahme');
  });

  it('N2: die Symbol-Sperre liest die VOLLSTÄNDIGE Symbolliste, nicht die 10 Anzeige-Zeilen', () => {
    const abgleich = lies('core', 'brokerAbgleich.ts');
    expect(abgleich).toContain('abweichungSymbole: abweichungen.map((a) => a.symbol).slice(0, 200),');
    const tore = lies('core', 'kontoTore.ts');
    expect(tore).toContain('if (Array.isArray(v.abweichungSymbole) && v.abweichungSymbole.includes(symbol)) return true;');
  });

  it('M2: ein echter Fill darf einen bestehenden Short vergrößern — sonst bleibt das Verbot', () => {
    const b = broker.slice(broker.indexOf('export async function executePaperTrade'));
    expect(b).toContain("if (!(req.aufstockung === true && echterFill && req.qty !== undefined && req.qty > 0)) {\n        return { executed: false, reason: 'short_nachverkauf_verboten' };");
    expect(b).toContain('stopLoss: risk.stopLossPct > 0 ? nAvg * (1 + risk.stopLossPct / 100) : (pos.stopLoss ?? null),');
  });

  it('M4: Momentum, Sockel und Handeingabe fragen die Symbol-Sperre', () => {
    const momentum = lies('scheduled', 'momentumRun.ts');
    const trade = lies('callable', 'trade.ts');
    expect(anzahl(momentum, "symbolSperreAusVermerk(userDoc.get('risk.abgleich'), o.symbol, now)")).toBe(2);
    expect(trade).toContain("throw new HttpsError('failed-precondition', 'srv.fremdbestand');");
  });

  it('Anzeige: die abweichenden Symbole stehen mit Mengen in der Abgleich-Zeile', () => {
    expect(anzahl(dashboard, '+ abwListe')).toBe(2);
    const data = readFileSync(join(import.meta.dirname, '..', '..', 'frontend', 'src', 'data.ts'), 'utf8');
    expect(data).toContain("abweichungen: Array.isArray(r['abweichungen'])");
  });
});
