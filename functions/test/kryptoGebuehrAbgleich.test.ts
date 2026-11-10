/**
 * Krypto über ein Broker-Konto: zwei Fehler, die zusammen 3 von 4
 * Broker-Konten lahmlegten (Logs 10.11.).
 *
 *  1. AUSSTIEGE scheiterten immer: Market-Orders gingen mit `day` hinaus,
 *     Alpaca kennt für Krypto nur gtc/ioc (HTTP 422 „invalid crypto
 *     time_in_force"). Die Umkehr-Positionen vom 30.10. kamen elf Tage
 *     nicht heraus — und der Lauf meldete „0 Verkäufe", ohne zu sagen, dass
 *     sechs abgelehnt wurden.
 *  2. Die ABGLEICH-SPERRE griff nach jedem Kauf: Alpaca behält die Gebühr
 *     in Stücken ein (0,15 % Maker / 0,25 % Taker); das Buch führte die
 *     gemeldete Menge, der Abgleich sah einen Fehlbestand.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { alpacaOrder, marketGueltigkeit, type Abweichung } from '../src/core/alpacaBroker.js';
import {
  KRYPTO_GEBUEHR_BAND,
  gleicheKryptoGebuehrAn,
  kryptoGebuehrAbzug,
} from '../src/core/brokerAbgleich.js';
import { verkaufStand } from '../src/scheduled/umkehrLauf.js';

/* ── Firestore-Attrappe: ein Konto, eine Position, eine Transaktion ────── */
const zustand: {
  user: Record<string, unknown> | null;
  pos: Record<string, unknown> | null;
  updates: Array<{ wo: 'user' | 'pos'; daten: Record<string, unknown> }>;
} = { user: null, pos: null, updates: [] };

const pfad = (obj: Record<string, unknown> | null, p: string): unknown =>
  p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

vi.mock('firebase-admin/firestore', () => {
  const posRef = { wo: 'pos' as const };
  const userRef = { wo: 'user' as const, collection: () => ({ doc: () => posRef }) };
  return {
    FieldPath: class {},
    getFirestore: () => ({
      doc: () => userRef,
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          get: async (ref: { wo: 'user' | 'pos' }) => {
            const d = ref.wo === 'user' ? zustand.user : zustand.pos;
            return { exists: d !== null, data: () => d, get: (p: string) => pfad(d, p) };
          },
          update: (ref: { wo: 'user' | 'pos' }, daten: Record<string, unknown>) => {
            zustand.updates.push({ wo: ref.wo, daten });
          },
        }),
    }),
  };
});

const JETZT = new Date('2026-11-10T21:00:00Z');
const abw = (symbol: string, eigeneMenge: number, brokerMenge: number): Abweichung => ({
  symbol,
  eigeneMenge,
  brokerMenge,
  differenz: Math.round((eigeneMenge - brokerMenge) * 1e6) / 1e6,
});
/** Die drei Fälle aus den Logs vom 10.11. */
const LINK = abw('LINK-USD', 17.02373, 16.998194405);
const SOL = abw('SOL-USD', 1.918022, 1.915144967);
const AVAX = abw('AVAX-USD', 9.481237, 9.457533907);

describe('kryptoGebuehrAbzug (pur)', () => {
  it('erkennt die drei Live-Fälle: 0,15 % Maker und 0,25 % Taker', () => {
    expect(kryptoGebuehrAbzug(LINK)).toBeCloseTo(0.025535595, 9);
    expect(kryptoGebuehrAbzug(SOL)).toBeCloseTo(0.002877033, 9);
    expect(kryptoGebuehrAbzug(AVAX)).toBeCloseTo(0.023703093, 9);
  });

  it('innerhalb des Bands ja, darüber nein — das bleibt ein Fehlbestand', () => {
    expect(KRYPTO_GEBUEHR_BAND).toBe(0.003);
    expect(kryptoGebuehrAbzug(abw('BTC-USD', 1, 0.9971))).not.toBeNull();
    expect(kryptoGebuehrAbzug(abw('BTC-USD', 1, 0.9969))).toBeNull();
    expect(kryptoGebuehrAbzug(abw('BTC-USD', 1, 0.5))).toBeNull();
  });

  it('nie für Aktien/ETFs — dort gibt es keinen Stückabzug', () => {
    expect(kryptoGebuehrAbzug(abw('AAPL', 100, 99.85))).toBeNull();
    expect(kryptoGebuehrAbzug(abw('SPY', 10, 9.99))).toBeNull();
  });

  it('nie, wenn der Broker die Position gar nicht hält, bei Shorts oder Fremdbestand', () => {
    expect(kryptoGebuehrAbzug(abw('BTC-USD', 1, 0))).toBeNull();
    expect(kryptoGebuehrAbzug(abw('BTC-USD', -1, -0.9985))).toBeNull();
    expect(kryptoGebuehrAbzug(abw('BTC-USD', 0.9985, 1))).toBeNull();
    expect(kryptoGebuehrAbzug(abw('BTC-USD', 1, 1))).toBeNull();
  });
});

describe('gleicheKryptoGebuehrAn (Transaktion)', () => {
  beforeEach(() => {
    zustand.user = { wallet: { paperBalance: 1000 } };
    zustand.pos = { symbol: 'LINK-USD', qty: 17.02373, avgEntry: 20, broker: true };
    zustand.updates = [];
  });

  it('setzt die Menge auf den Broker-Bestand und bucht den Einstand der fehlenden Stücke zurück', async () => {
    expect(await gleicheKryptoGebuehrAn('u1', LINK, JETZT)).toBe(true);
    const pos = zustand.updates.find((u) => u.wo === 'pos')!.daten;
    const user = zustand.updates.find((u) => u.wo === 'user')!.daten;
    expect(pos['qty']).toBe(16.998194405);
    expect(pos['gebuehrMenge']).toBeCloseTo(0.025535595, 9);
    expect(pos['gebuehrAngeglichenAm']).toBe(JETZT.toISOString());
    // 0,025535595 Stück × 20 $ Einstand = 0,51 $ zurück ins Bargeld.
    expect(user['wallet.paperBalance']).toBe(1000.51);
    // Equity-neutral zum Einstand: Bargeld + Menge × Einstand bleibt gleich.
    const vorher = 1000 + 17.02373 * 20;
    const nachher = (user['wallet.paperBalance'] as number) + (pos['qty'] as number) * 20;
    expect(Math.abs(nachher - vorher)).toBeLessThan(0.01);
  });

  it('sammelt den Abzug über mehrere Käufe', async () => {
    zustand.pos = { ...zustand.pos, gebuehrMenge: 0.01 };
    await gleicheKryptoGebuehrAn('u1', LINK, JETZT);
    expect(zustand.updates.find((u) => u.wo === 'pos')!.daten['gebuehrMenge']).toBeCloseTo(0.035535595, 9);
  });

  it.each([
    ['Menge hat sich seit dem Vergleich bewegt', { qty: 10 }, {}],
    ['Position liegt nicht beim Broker', { broker: false }, {}],
    ['Short', { side: 'short' }, {}],
    ['kaputter Einstand', { avgEntry: 0 }, {}],
    ['Reset läuft', {}, { risk: { resetLaeuftSeit: '2026-11-10T20:59:00Z' } }],
    ['Bargeld nicht lesbar', {}, { wallet: {} }],
  ])('rührt nichts an: %s', async (_name, posPatch, userPatch) => {
    zustand.pos = { ...zustand.pos, ...posPatch };
    zustand.user = { ...zustand.user, ...userPatch };
    expect(await gleicheKryptoGebuehrAn('u1', LINK, JETZT)).toBe(false);
    expect(zustand.updates).toHaveLength(0);
  });

  it('rührt nichts an, wenn Position oder Konto fehlen oder die Abweichung kein Gebührenabzug ist', async () => {
    zustand.pos = null;
    expect(await gleicheKryptoGebuehrAn('u1', LINK, JETZT)).toBe(false);
    zustand.pos = { symbol: 'LINK-USD', qty: 17.02373, avgEntry: 20, broker: true };
    zustand.user = null;
    expect(await gleicheKryptoGebuehrAn('u1', LINK, JETZT)).toBe(false);
    zustand.user = { wallet: { paperBalance: 1000 } };
    expect(await gleicheKryptoGebuehrAn('u1', abw('LINK-USD', 17.02373, 10), JETZT)).toBe(false);
    expect(zustand.updates).toHaveLength(0);
  });
});

describe('Market-Order: Gültigkeit je Klasse', () => {
  it('Krypto in allen drei Schreibweisen ⇒ gtc; alles andere bleibt day', () => {
    expect(marketGueltigkeit('LINK-USD')).toBe('gtc');
    expect(marketGueltigkeit('BTC/USD')).toBe('gtc');
    expect(marketGueltigkeit('BTCUSD')).toBe('gtc');
    expect(marketGueltigkeit('AAPL')).toBe('day');
    expect(marketGueltigkeit('BRK-B')).toBe('day');
    expect(marketGueltigkeit('SPY')).toBe('day');
  });

  it('ein Krypto-AUSSTIEG geht als market + gtc hinaus (vorher day ⇒ HTTP 422)', async () => {
    const aufrufe: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      aufrufe.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'o1', status: 'accepted' }) } as unknown as Response;
    });
    await alpacaOrder(
      'paper',
      { symbol: 'LINK-USD', side: 'sell', qty: 16.998194405, clientOrderId: 'c1' },
      { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' },
      f as unknown as typeof fetch,
    );
    const order = aufrufe.find((a) => a.url.endsWith('/v2/orders'))!.body;
    expect(order['symbol']).toBe('LINK/USD');
    expect(order['type']).toBe('market');
    expect(order['time_in_force']).toBe('gtc');
  });
});

describe('Anschluss im Lauf (Quelltext-Wächter)', () => {
  const lies = (...teile: string[]) => readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');
  const abgleich = lies('core', 'brokerAbgleich.ts');
  const scan = lies('scheduled', 'scanMarket.ts');
  const umkehr = lies('scheduled', 'umkehrLauf.ts');

  it('der Abgleich gleicht Gebührenabzüge an, BEVOR er Fehlbestand beurteilt', () => {
    const an = abgleich.indexOf('const ok = await gleicheKryptoGebuehrAn(uid, a, jetzt)');
    const urteil = abgleich.indexOf('const fehlbestand = abweichungen.filter(istGefaehrlicheAbweichung);');
    expect(an).toBeGreaterThan(0);
    expect(urteil).toBeGreaterThan(an);
    // Nur was NICHT angeglichen wurde, bleibt Abweichung.
    expect(abgleich).toMatch(/if \(ok\) \{[\s\S]{0,400}?continue;\s+\}\s+\}\s+abweichungen\.push\(a\);/);
  });

  it('der Scan zieht seine vorher gelesenen Positionen nach', () => {
    expect(scan).toContain('for (const g of abgleichBefund.angeglichen ?? []) {');
    expect(scan).toContain('if (p) positions.set(g.symbol, { ...p, qty: g.menge });');
  });

  it('gescheiterte Umkehr-Ausstiege werden gezählt, gemeldet und im Kryptolauf nachgeholt', () => {
    expect(umkehr).toContain("zaehleGrund(verkaufFehl, r.reason ?? 'unbekannt', 1);");
    expect(umkehr.match(/verkaufAbgelehnt: verkaufStand\(verkaufFehl\),/g)).toHaveLength(2);
    expect(umkehr).toContain('if (schonHeute) {');
    // Nachholen verkauft nur: leere Kaufliste.
    expect(umkehr).toContain('fuehreAus(k, tore.clamped, tore.einstieg, offen, [], `umk-${tag}`, now)');
    expect(verkaufStand({ broker_abgelehnt: 2, kein_fill: 1 })).toEqual({
      n: 3,
      gruende: { broker_abgelehnt: 2, kein_fill: 1 },
    });
  });
});
