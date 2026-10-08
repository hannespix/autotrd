/**
 * Drift-Paket 2 (08.10.) — der Ereigniskanal für Ausführungen.
 *
 * Bis hierher erfuhr das Buch von einem Fill nur, wenn es im Moment der
 * Order nachfragte. `fillSync` liest die Konto-Aktivität des Brokers und
 * bucht, was im Buch fehlt. Gepinnt wird: nur eigene Orders, nur die
 * Differenz, Karenz für den Scan-Pfad, Cursor rückt bei Fehlschlag nicht
 * vor, nichts verschwindet still.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holeFillAktivitaeten, type AlpacaFill } from '../src/core/alpacaBroker.js';
import { buendleFills, cursorVor, darfShortEroeffnen, eigeneOrder } from '../src/scheduled/fillSync.js';

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
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_o: unknown, fn: unknown) => fn }));
vi.mock('firebase-functions/v2/https', () => ({ onRequest: (_o: unknown, fn: unknown) => fn, HttpsError: class extends Error {} }));

const SCHLUESSEL = { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' };
const fill = (teil: Partial<AlpacaFill> & { id: string }): AlpacaFill => ({
  orderId: 'o1', symbol: 'ACME', side: 'buy', qty: 1, price: 10, cumQty: 1, leavesQty: 0,
  transactionTime: '2026-10-08T14:00:00.000Z', typ: 'fill', ...teil,
});

describe('buendleFills — je Order die Summe, mengengewichtet, mit Karenz', () => {
  it('bündelt Teilausführungen einer Order und rechnet den gewichteten Preis', () => {
    const o = buendleFills([
      fill({ id: 'a', qty: 2, price: 10, transactionTime: '2026-10-08T14:00:00.000Z', typ: 'partial_fill' }),
      fill({ id: 'b', qty: 1, price: 13, transactionTime: '2026-10-08T14:01:00.000Z' }),
      fill({ id: 'c', orderId: 'o2', symbol: 'BETA', side: 'sell', qty: 5, price: 50, transactionTime: '2026-10-08T13:59:00.000Z' }),
    ], '2026-10-08T14:10:00.000Z');
    expect(o).toHaveLength(2);
    expect(o[0]).toMatchObject({ orderId: 'o2', symbol: 'BETA', side: 'sell', menge: 5, preis: 50 });
    expect(o[1]).toMatchObject({ orderId: 'o1', menge: 3, preis: 11, zuerst: '2026-10-08T14:00:00.000Z', zuletzt: '2026-10-08T14:01:00.000Z' });
  });

  it('Karenz: Ausführungen ab der Grenze bleiben liegen — der Scan-Pfad hat Vorrang', () => {
    const o = buendleFills([
      fill({ id: 'a', transactionTime: '2026-10-08T14:00:00.000Z' }),
      fill({ id: 'b', orderId: 'o9', transactionTime: '2026-10-08T14:09:00.000Z' }),
    ], '2026-10-08T14:07:00.000Z');
    expect(o.map((x) => x.orderId)).toEqual(['o1']);
  });

  it('kaputte Zeilen (ohne Order, Menge, Preis, Zeit) werden übersprungen', () => {
    expect(buendleFills([
      fill({ id: 'a', orderId: '' }),
      fill({ id: 'b', qty: 0 }),
      fill({ id: 'c', price: 0 }),
      fill({ id: 'd', transactionTime: '' }),
    ], '2026-10-09T00:00:00.000Z')).toEqual([]);
  });
});

describe('cursorVor — bei Fehlschlag fällt der Cursor VOR die erste Ausführung der Order (H1)', () => {
  const fills = [
    fill({ id: 'a1', orderId: 'A', transactionTime: '2026-10-08T10:00:00.000Z' }),
    fill({ id: 'b1', orderId: 'B', transactionTime: '2026-10-08T10:02:00.000Z' }),
    fill({ id: 'a2', orderId: 'A', transactionTime: '2026-10-08T10:05:00.000Z' }),
  ];
  it('Order A gebucht (Cursor 10:05), B scheitert (zuerst 10:02) → Cursor 10:00, B wird erneut gelesen', () => {
    expect(cursorVor(fills, '2026-10-08T10:02:00.000Z', '2026-10-08T09:00:00.000Z')).toBe('2026-10-08T10:00:00.000Z');
  });
  it('scheitert die allererste Order, bleibt der alte Cursor', () => {
    expect(cursorVor(fills, '2026-10-08T10:00:00.000Z', '2026-10-08T09:00:00.000Z')).toBe('2026-10-08T09:00:00.000Z');
  });
});

describe('darfShortEroeffnen — kein Phantom-Short aus Stop oder Exit (H3)', () => {
  it('nur eine eigene Market-Order mit Lauf-Kennung eröffnet einen Buch-Short', () => {
    expect(darfShortEroeffnen({ typ: 'market', clientOrderId: 'u1-ACME-sell-10-2026-10-08T14_00Z' })).toBe(true);
    expect(darfShortEroeffnen({ typ: 'stop', clientOrderId: 'u1-ACME-sell-10-2026-10-08T14_00Z' })).toBe(false);
    expect(darfShortEroeffnen({ typ: 'stop_limit', clientOrderId: 'u1-ACME-sell-10-x' })).toBe(false);
    expect(darfShortEroeffnen({ typ: 'market', clientOrderId: 'u1-ACME-sell-10-exit-2026-10-07T14_00_00_000Z-q10' })).toBe(false);
    expect(darfShortEroeffnen({ typ: undefined, clientOrderId: 'u1-ACME-sell-10-x' })).toBe(false);
  });
});

describe('eigeneOrder — dieselbe Regel wie bei der Depot-Übernahme', () => {
  it('erkennt das Nutzer-Präfix, nicht fremde oder leere Kennungen', () => {
    expect(eigeneOrder('u1', 'u1-ACME-buy-10-scan')).toBe(true);
    expect(eigeneOrder('u1', 'u12-ACME-buy-10-scan')).toBe(false);
    expect(eigeneOrder('u1', 'hand-123')).toBe(false);
    expect(eigeneOrder('u1', undefined)).toBe(false);
    expect(eigeneOrder('a b', 'a_b-X-buy-1-s')).toBe(true);
  });
});

describe('holeFillAktivitaeten — Seiten über die letzte Kennung', () => {
  const zeile = (id: string, extra: Record<string, unknown> = {}) => ({
    id, order_id: 'o1', symbol: 'ACME', side: 'buy', qty: '1', price: '10', cum_qty: '1', leaves_qty: '0',
    transaction_time: '2026-10-08T14:00:00.000Z', type: 'fill', ...extra,
  });
  it('liest Seiten, bis weniger als 100 kommen, und gibt die Zeilen typisiert zurück', async () => {
    const seite1 = Array.from({ length: 100 }, (_, i) => zeile(`a${i}`));
    const seite2 = [zeile('b0', { type: 'partial_fill', symbol: 'BTCUSD', qty: '0.5' })];
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      const body = urls.length === 1 ? seite1 : seite2;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
    });
    const r = await holeFillAktivitaeten('paper', SCHLUESSEL, '2026-10-08T13:00:00.000Z', f as never);
    expect(r.fills).toHaveLength(101);
    expect(r.abgeschnitten).toBe(false);
    expect(r.fills[100]).toMatchObject({ id: 'b0', typ: 'partial_fill', qty: 0.5, symbol: 'BTC-USD' });
    expect(urls[0]).toContain('/v2/account/activities/FILL?after=2026-10-08T13%3A00%3A00.000Z&direction=asc&page_size=100');
    expect(urls[1]).toContain('page_token=a99');
  });
  it('meldet den Seitendeckel, statt still abzuschneiden', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(Array.from({ length: 100 }, (_, i) => zeile(`x${i}`))) }) as unknown as Response);
    const r = await holeFillAktivitaeten('paper', SCHLUESSEL, '2026-10-08T13:00:00.000Z', f as never, 2);
    expect(r.fills).toHaveLength(200);
    expect(r.abgeschnitten).toBe(true);
  });
});

describe('Quelltext-Wächter: die Verdrahtung', () => {
  const lies = (...teile: string[]): string => readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');
  const sync = lies('scheduled', 'fillSync.ts');
  const anzahl = (text: string, nadel: string): number => text.split(nadel).length - 1;

  it('nur eigene Orders werden gebucht; fremde nur gezählt', () => {
    expect(sync).toContain('if (!order || !eigeneOrder(uid, order.clientOrderId)) {');
    expect(sync).toContain('fremd += 1;');
  });
  it('die Differenz zum Buch wird gebucht — nie die ganze Summe', () => {
    expect(sync).toContain('const schon = await gebuchteMengeJeOrder(uid, o.orderId);');
    // KUMULIERT laut Order (H2), nicht die Fenster-Summe
    expect(sync).toContain('const gesamt = order.filledQty > 0 ? order.filledQty : o.menge;');
    expect(sync).toContain('const fehlt = Math.round((gesamt - schon) * 1e6) / 1e6;');
    // eine noch arbeitende eröffnende Order bekommt den Nachlauf-Vermerk
    expect(sync).toContain("if (!schliesst && !endzustand && order.clientOrderId) {");
    expect(sync).toContain('qty: fehlt,');
  });
  it('Orders mit Nachlauf-Vermerk gehören Paket 1', () => {
    expect(sync).toContain("const vermerk = vermerkId ? await db.doc(`users/${uid}/offeneOrders/${vermerkId}`).get().catch(() => null) : null;");
    expect(sync).toContain('if (vermerk?.exists) {');
  });
  it('H3: ein Verkauf ohne Buch-Position wird nicht zum Phantom-Short', () => {
    expect(sync).toContain("if (o.side === 'sell' && !posSnap.exists && !darfShortEroeffnen(order)) {");
    expect(sync).toContain('ohnePosition += 1;');
  });
  it('M1/M2: das Buch zählt auch das Archiv; ein echter Short-Fill wird nie an der Deckung abgewiesen', () => {
    const broker = lies('core', 'broker.ts');
    expect(broker).toContain("userRef.collection('tradesArchive').where('brokerOrderId', '==', brokerOrderId).get().catch(() => null),");
    expect(broker).toContain('      if (!echterFill) {\n        if (req.margin) {');
  });
  it('bei Fehlschlag fällt der Cursor zurück; nach FILL_FEHLER_MAX wird laut aufgegeben', () => {
    expect(sync).toContain('cursorNeu = cursorVor(fills, o.zuerst, cursorAlt);\n    wartet = true;\n    break;');
    expect(sync).toContain('if (fehlerFolge >= FILL_FEHLER_MAX) {');
    expect(sync).toContain("await merkeUnbookedFill(uid, o.symbol, o.side, fehlt, o.preis, o.orderId, 'fill-sync'");
    // der Cursor rückt in JEDEM Erfolgs- und Überspringpfad vor
    expect(anzahl(sync, 'cursorNeu = o.zuletzt > cursorNeu ? o.zuletzt : cursorNeu;')).toBeGreaterThanOrEqual(5);
  });
  it('schließende Fills sichern den Rest nur bei Endzustand zu; eröffnende buchen als Aufstockung', () => {
    expect(sync).toContain("? { restStorniert: endzustand, riskExit: 'fill_sync' }");
    expect(sync).toContain(": { aufstockung: true, ...(o.side === 'sell' ? { openShort: true } : {}) }),");
    expect(sync).toContain('ausgefuehrtAt: o.zuletzt,');
  });
  it('Zeitplan, Export und Etiketten sind verdrahtet', () => {
    expect(lies('index.ts')).toContain("export { fillSync, fillSyncNow } from './scheduled/fillSync.js';");
    const ci = readFileSync(join(import.meta.dirname, '..', '..', 'scripts-ci', 'check-scheduler.mjs'), 'utf8');
    expect(ci).toContain("{ fn: 'fillSync', service: 'fillsync', cron: '2-59/5 * * * *'");
    expect(sync).toContain("schedule: '2-59/5 * * * *',");
    const dash = readFileSync(join(import.meta.dirname, '..', '..', 'frontend', 'src', 'dashboard.ts'), 'utf8');
    expect(anzahl(dash, "fill_sync: t('an.fillSync'),")).toBe(2);
  });
  it('das Buch übernimmt die Ausführungszeit des Brokers', () => {
    const broker = lies('core', 'broker.ts');
    expect(broker).toContain("const now = typeof req.ausgefuehrtAt === 'string' && Number.isFinite(Date.parse(req.ausgefuehrtAt))");
  });
});
