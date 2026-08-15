/**
 * Krypto-Einstiege als Limit-Order (Hebel 1b, Owner 15.08. „rund um die Uhr").
 *
 * Alpaca nimmt für Krypto 0,25 % Taker-, aber nur 0,15 % Maker-Gebühr — und
 * die Klassen-Attribution zeigt, dass genau diese Reibung den Krypto-Gewinn
 * auffrisst (1.316 $ Gebühren gegen +691 $ brutto). Ein EINSTIEG darf deshalb
 * als Limit zum Entscheidungskurs ins Buch gehen statt den Spread zu
 * überqueren; füllt er nicht, räumt der K-2c-Storno auf.
 *
 * Die Tests sichern beide Richtungen:
 *  - die neue: Limit-Order mit gerundetem Preis, gtc, längeres Wartefenster;
 *  - die heilige: EXITS bleiben Market — das Routing selbst erzwingt das,
 *    ein Limit auf einer schließenden Order wird verworfen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { alpacaOrder, rundeLimitPreis } from '../src/core/alpacaBroker.js';
import {
  LIMIT_WARTE_PAUSE_MS,
  LIMIT_WARTE_VERSUCHE,
  routeOrder,
} from '../src/core/orderRouting.js';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    doc: () => ({ get: async () => ({ get: () => undefined, data: () => ({}) }) }),
  }),
}));

const hier = dirname(fileURLToPath(import.meta.url));
const brokerSrc = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');
const routingSrc = readFileSync(join(hier, '../src/core/orderRouting.ts'), 'utf8');
const alpacaSrc = readFileSync(join(hier, '../src/core/alpacaBroker.ts'), 'utf8');

const SCHLUESSEL = { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' };
const SCHNELL = { versuche: 2, pauseMs: 0 };

/** Antwort-Attrappe wie in orderRouting.test.ts — merkt sich die Requests. */
const antworten = (...koerper: unknown[]) => {
  let i = 0;
  const aufrufe: { url: string; init: RequestInit | undefined }[] = [];
  const f = vi.fn(async (url: unknown, init?: unknown) => {
    aufrufe.push({ url: String(url), init: init as RequestInit | undefined });
    const b = koerper[Math.min(i++, koerper.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(b) } as unknown as Response;
  });
  return { f, aufrufe };
};

/** Der Body des ersten POST /v2/orders — die Order, wie Alpaca sie sähe. */
const ersteOrder = (aufrufe: { url: string; init: RequestInit | undefined }[]) => {
  const post = aufrufe.find((a) => a.init?.method === 'POST' && a.url.endsWith('/v2/orders'));
  expect(post, 'kein POST /v2/orders abgesetzt').toBeDefined();
  return JSON.parse(String(post!.init!.body)) as Record<string, unknown>;
};

describe('rundeLimitPreis', () => {
  it('rundet kaufmännisch sicher: Kauf ab-, Verkauf aufwärts', () => {
    expect(rundeLimitPreis(190.129, 'buy')).toBe(190.12);
    expect(rundeLimitPreis(190.121, 'sell')).toBe(190.13);
  });

  it('übersteht Gleitkomma-Kanten (4.07 × 100 = 406.9999…)', () => {
    expect(rundeLimitPreis(4.07, 'buy')).toBe(4.07);
    expect(rundeLimitPreis(0.1, 'sell')).toBe(0.1);
  });

  it('feineres Raster für kleine Kurse', () => {
    expect(rundeLimitPreis(0.54321, 'buy')).toBe(0.5432);
    // Sub-Millicent-Coins (SHIB-Größenordnung): sechs Stellen statt null.
    expect(rundeLimitPreis(0.0000123, 'buy')).toBe(0.000012);
    expect(rundeLimitPreis(0.0000123, 'sell')).toBe(0.000013);
  });

  it('ungültige Kurse ergeben 0 — der Aufrufer fällt dann auf Market zurück', () => {
    expect(rundeLimitPreis(0, 'buy')).toBe(0);
    expect(rundeLimitPreis(-5, 'buy')).toBe(0);
    expect(rundeLimitPreis(Number.NaN, 'buy')).toBe(0);
  });
});

describe('alpacaOrder mit Limit', () => {
  it('sendet type=limit mit Preis und gtc', async () => {
    const { f, aufrufe } = antworten({ id: 'o1', status: 'accepted' });
    await alpacaOrder(
      'paper',
      { symbol: 'BTCUSD', side: 'buy', qty: 0.1, clientOrderId: 'c1', limitPreis: 60000.5 },
      SCHLUESSEL,
      f,
    );
    const body = ersteOrder(aufrufe);
    expect(body['type']).toBe('limit');
    expect(body['limit_price']).toBe('60000.5');
    expect(body['time_in_force']).toBe('gtc');
  });

  it('bleibt ohne limitPreis exakt die alte Market-Order', async () => {
    const { f, aufrufe } = antworten({ id: 'o1', status: 'accepted' });
    await alpacaOrder(
      'paper',
      { symbol: 'AAPL', side: 'buy', qty: 5, clientOrderId: 'c2' },
      SCHLUESSEL,
      f,
    );
    const body = ersteOrder(aufrufe);
    expect(body['type']).toBe('market');
    expect(body['time_in_force']).toBe('day');
    expect(body['limit_price']).toBeUndefined();
  });
});

describe('routeOrder mit Limit', () => {
  const einstieg = {
    uid: 'u1',
    symbol: 'BTCUSD',
    side: 'buy' as const,
    qty: 0.1,
    laufId: 'scan-1',
    stornoBeiKeinFill: true,
    limitPreis: 60000,
  };

  it('Einstieg geht als Limit raus und bucht den echten Fill', async () => {
    const { f, aufrufe } = antworten(
      { id: 'o1', status: 'accepted' },
      { id: 'o1', status: 'filled', filled_qty: '0.1', filled_avg_price: '59990' },
    );
    const r = await routeOrder({ mode: 'paper', schluessel: SCHLUESSEL }, einstieg, f, SCHNELL);
    expect(ersteOrder(aufrufe)['type']).toBe('limit');
    expect(r.ausgefuehrt).toBe(true);
    expect(r.fillPreis).toBe(59990);
  });

  it('OHNE stornoBeiKeinFill wird das Limit VERWORFEN — Exits bleiben Market', async () => {
    // Die heilige Regel, im Routing erzwungen statt nur beim Aufrufer:
    // Selbst wenn eine schließende Order versehentlich einen limitPreis
    // trägt, geht sie als Market raus. Ein Limit könnte einen Exit
    // verhindern — und Exits dürfen niemals erschwert werden.
    const { f, aufrufe } = antworten(
      { id: 'o2', status: 'accepted' },
      { id: 'o2', status: 'filled', filled_qty: '0.1', filled_avg_price: '60010' },
    );
    const r = await routeOrder(
      { mode: 'paper', schluessel: SCHLUESSEL },
      { ...einstieg, stornoBeiKeinFill: false },
      f,
      SCHNELL,
    );
    const body = ersteOrder(aufrufe);
    expect(body['type']).toBe('market');
    expect(body['limit_price']).toBeUndefined();
    expect(r.ausgefuehrt).toBe(true);
  });

  it('ungefülltes Limit wird storniert und endet als kein_fill', async () => {
    // K-2c unverändert: Der Limit-Einstieg darf nicht beim Broker liegen
    // bleiben und Minuten später füllen, während der nächste Scan erneut
    // kauft. Nach dem Wartefenster: Storno, kein Trade, kein Buch-Eintrag.
    const { f, aufrufe } = antworten(
      { id: 'o3', status: 'accepted' },
      { id: 'o3', status: 'new' },
      { id: 'o3', status: 'new' },
      { id: 'o3', status: 'canceled' },
    );
    const r = await routeOrder({ mode: 'paper', schluessel: SCHLUESSEL }, einstieg, f, SCHNELL);
    expect(r.ausgefuehrt).toBe(false);
    expect(r.grund).toBe('kein_fill');
    const storno = aufrufe.find((a) => a.init?.method === 'DELETE');
    expect(storno, 'Storno der ungefüllten Limit-Order fehlt').toBeDefined();
  });
});

describe('Anschluss-Wächter (der Serienfehler: Funktion korrekt, nicht angeschlossen)', () => {
  it('broker.ts berechnet das Limit NUR für Krypto-EINSTIEGE und übergibt es', () => {
    expect(brokerSrc).toContain(
      "eroeffnet && klasse === 'crypto' ? rundeLimitPreis(req.price, req.side) : 0",
    );
    expect(brokerSrc).toContain('...(limitPreis > 0 ? { limitPreis } : {})');
  });

  it('das Routing erzwingt selbst, dass nur Einstiege ein Limit tragen', () => {
    const stelle = routingSrc.indexOf('auftrag.stornoBeiKeinFill === true');
    expect(stelle, 'Einstiegs-Guard im Routing fehlt').toBeGreaterThan(0);
    expect(routingSrc.slice(stelle, stelle + 200)).toContain('auftrag.limitPreis > 0');
  });

  it('Limit-Einstiege bekommen das längere Wartefenster', () => {
    expect(LIMIT_WARTE_VERSUCHE * LIMIT_WARTE_PAUSE_MS).toBeGreaterThanOrEqual(10_000);
    expect(routingSrc).toContain(
      '{ versuche: LIMIT_WARTE_VERSUCHE, pauseMs: LIMIT_WARTE_PAUSE_MS }',
    );
  });

  it('der Market-Pfad ist unangetastet: type market + day existieren weiter', () => {
    expect(alpacaSrc).toContain("{ type: 'market', time_in_force: 'day' }");
    // und der Limit-Zweig hängt an gtc — Alpaca kennt für Krypto kein day.
    expect(alpacaSrc).toContain(
      "{ type: 'limit', limit_price: String(order.limitPreis), time_in_force: 'gtc' }",
    );
  });
});
