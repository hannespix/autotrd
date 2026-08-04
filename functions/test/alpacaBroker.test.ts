/**
 * Tests der Alpaca-Anbindung.
 *
 * Der Schwerpunkt liegt auf den Stellen, an denen ein Fehler ECHTES GELD
 * kostet — nicht auf dem Happy Path:
 *
 *   - Endpunkt-Trennung Paper/Live (falsche URL = falsches Depot)
 *   - Idempotenz (ein Retry darf keine zweite Order senden)
 *   - Vorflugkontrolle (gesperrtes Konto, Tippfehler-Order, fehlende Deckung)
 *   - Schlüssel dürfen NIE in einer Fehlermeldung stehen
 *   - Abgleich in BEIDE Richtungen, mit Vorzeichen
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlpacaFehler,
  MAX_ORDER_ANTEIL,
  abgleich,
  alpacaBasis,
  alpacaKonfiguriert,
  alpacaKonto,
  alpacaOrder,
  alpacaPositionen,
  clientOrderId,
  keineSchluesselImText,
  vorflugkontrolle,
  type AlpacaKonto,
} from '../src/core/alpacaBroker.js';

const KEY = 'PKTESTKEY1234567';
const SECRET = 'SECRETTESTVALUE9876';

beforeEach(() => {
  process.env.ALPACA_API_KEY = KEY;
  process.env.ALPACA_SECRET_KEY = SECRET;
});

afterEach(() => {
  delete process.env.ALPACA_API_KEY;
  delete process.env.ALPACA_SECRET_KEY;
  vi.restoreAllMocks();
});

/** Antwort-Attrappe mit der Schnittstelle, die der Adapter benutzt. */
const antwort = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

const KONTO_ROH = {
  id: 'acct-1',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '10000',
  equity: '12000',
  buying_power: '24000',
  trading_blocked: false,
  account_blocked: false,
  pattern_day_trader: false,
};

const konto = (over: Partial<AlpacaKonto> = {}): AlpacaKonto => ({
  id: 'acct-1',
  status: 'ACTIVE',
  currency: 'USD',
  cash: 10_000,
  equity: 12_000,
  buyingPower: 24_000,
  tradingBlocked: false,
  accountBlocked: false,
  patternDayTrader: false,
  ...over,
});

describe('Endpunkt-Trennung', () => {
  it('trifft für Paper und Live verschiedene Hosts', () => {
    expect(alpacaBasis('paper')).toBe('https://paper-api.alpaca.markets');
    expect(alpacaBasis('live')).toBe('https://api.alpaca.markets');
    expect(alpacaBasis('paper')).not.toBe(alpacaBasis('live'));
  });

  it('ruft für „live" tatsächlich den Echtgeld-Host — nicht den Paper-Host', async () => {
    // Der teuerste denkbare Fehler wäre der umgekehrte: eine Live-Order, die
    // still im Papierdepot landet, oder eine Papier-Order gegen echtes Geld.
    const f = vi.fn().mockResolvedValue(antwort(KONTO_ROH));
    await alpacaKonto('live', f);
    expect(f.mock.calls[0]![0]).toBe('https://api.alpaca.markets/v2/account');
    await alpacaKonto('paper', f);
    expect(f.mock.calls[1]![0]).toBe('https://paper-api.alpaca.markets/v2/account');
  });

  it('sendet die Schlüssel als Header', async () => {
    const f = vi.fn().mockResolvedValue(antwort(KONTO_ROH));
    await alpacaKonto('paper', f);
    const headers = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe(KEY);
    expect(headers['APCA-API-SECRET-KEY']).toBe(SECRET);
  });
});

describe('Schlüssel-Hygiene', () => {
  it('entfernt Schlüssel aus beliebigem Text', () => {
    const t = keineSchluesselImText(`Fehler mit ${KEY} und ${SECRET}`);
    expect(t).not.toContain(KEY);
    expect(t).not.toContain(SECRET);
    expect(t).toContain('«entfernt»');
  });

  it('lässt keinen Schlüssel in einer Fehlermeldung des Anbieters stehen', async () => {
    // Alpaca spiegelt gesendete Header in manchen Fehlern zurück. Fehler
    // landen im Log, in Firestore und im Browser — ein Schlüssel, der dort
    // einmal steht, ist verbrannt.
    const f = vi.fn().mockResolvedValue(antwort(`forbidden for key ${KEY}`, false, 403));
    await expect(alpacaKonto('live', f)).rejects.toThrow(AlpacaFehler);
    await expect(alpacaKonto('live', f)).rejects.not.toThrow(new RegExp(KEY));
  });

  it('meldet fehlende Schlüssel, statt einen leeren Header zu senden', async () => {
    delete process.env.ALPACA_API_KEY;
    expect(alpacaKonfiguriert()).toBe(false);
    const f = vi.fn();
    await expect(alpacaKonto('paper', f)).rejects.toThrow(/Keine Alpaca-Schlüssel/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('clientOrderId — Idempotenz', () => {
  const LAUF = '2026-08-04T16:30Z';

  it('ist für denselben Lauf stabil — unabhängig davon, wann er wiederholt wird', () => {
    // Das ist der Schutz gegen die doppelte Position: Ein Function-Retry
    // erzeugt dieselbe Kennung, und Alpaca lehnt sie ab.
    expect(clientOrderId('u1', 'AAPL', 'buy', 10, LAUF)).toBe(
      clientOrderId('u1', 'AAPL', 'buy', 10, LAUF),
    );
  });

  it('hängt NICHT an der Uhr — ein Zeitfenster hätte an seiner Grenze versagt', () => {
    // Der erste Entwurf leitete die Kennung aus floor(jetzt/60s) ab. Zwei
    // Aufrufe 30 s auseinander fielen dann in verschiedene Fenster, sobald
    // eine Grenze dazwischenlag — und ein Retry hätte eine zweite Order
    // gesendet. Mit der Lauf-Kennung gibt es keine Grenze mehr.
    const ids = new Set([
      clientOrderId('u1', 'AAPL', 'buy', 10, LAUF),
      clientOrderId('u1', 'AAPL', 'buy', 10, LAUF),
      clientOrderId('u1', 'AAPL', 'buy', 10, LAUF),
    ]);
    expect(ids.size).toBe(1);
  });

  it('unterscheidet den nächsten Lauf — ein gewollter Folge-Trade geht durch', () => {
    expect(clientOrderId('u1', 'AAPL', 'buy', 10, LAUF)).not.toBe(
      clientOrderId('u1', 'AAPL', 'buy', 10, '2026-08-04T16:35Z'),
    );
  });

  it('unterscheidet nach Nutzer, Symbol, Seite und Menge', () => {
    const basis = clientOrderId('u1', 'AAPL', 'buy', 10, LAUF);
    expect(clientOrderId('u2', 'AAPL', 'buy', 10, LAUF)).not.toBe(basis);
    expect(clientOrderId('u1', 'MSFT', 'buy', 10, LAUF)).not.toBe(basis);
    expect(clientOrderId('u1', 'AAPL', 'sell', 10, LAUF)).not.toBe(basis);
    expect(clientOrderId('u1', 'AAPL', 'buy', 11, LAUF)).not.toBe(basis);
  });

  it('bleibt innerhalb der Alpaca-Grenzen (≤128 Zeichen, keine Sonderzeichen)', () => {
    const id = clientOrderId('u'.repeat(200), 'BTC-USD', 'buy', 0.5, LAUF);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('behält bei Überlänge den LAUF und kappt den Nutzer-Teil', () => {
    // Andersherum wäre die Kennung wertlos: Zwei Läufe desselben Nutzers
    // sähen identisch aus, und der zweite gewollte Trade würde abgelehnt.
    const a = clientOrderId('u'.repeat(200), 'AAPL', 'buy', 10, LAUF);
    const b = clientOrderId('u'.repeat(200), 'AAPL', 'buy', 10, '2026-08-04T16:35Z');
    expect(a).not.toBe(b);
    expect(a).toContain('16_30Z');
  });

  it('geht mit der Order auf die Leitung', async () => {
    const f = vi.fn().mockResolvedValue(antwort({ id: 'o1', client_order_id: 'cid-1' }));
    await alpacaOrder('paper', { symbol: 'AAPL', side: 'buy', qty: 5, clientOrderId: 'cid-1' }, f);
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['client_order_id']).toBe('cid-1');
    expect(body['type']).toBe('market');
    expect(body['side']).toBe('buy');
  });
});

describe('vorflugkontrolle', () => {
  const order = { symbol: 'AAPL', side: 'buy' as const, qty: 10, preis: 100 };

  it('lässt eine unauffällige Order durch', () => {
    expect(vorflugkontrolle(konto(), order).ok).toBe(true);
  });

  it('hält ein gesperrtes Konto an', () => {
    expect(vorflugkontrolle(konto({ accountBlocked: true }), order).gruende[0]).toMatch(/gesperrt/);
    expect(vorflugkontrolle(konto({ tradingBlocked: true }), order).ok).toBe(false);
  });

  it('verlangt Kontostatus ACTIVE', () => {
    const b = vorflugkontrolle(konto({ status: 'ONBOARDING' }), order);
    expect(b.ok).toBe(false);
    expect(b.gruende.join()).toMatch(/ONBOARDING/);
  });

  it('stoppt die Tippfehler-Order über dem Kontoanteil', () => {
    // 12.000 Equity, Grenze 50 % ⇒ 6.000. Diese Order liegt bei 7.000.
    const b = vorflugkontrolle(konto(), { ...order, qty: 70 });
    expect(b.ok).toBe(false);
    expect(b.gruende.join()).toMatch(/Tippfehler/);
    expect(MAX_ORDER_ANTEIL).toBeLessThanOrEqual(0.5);
  });

  it('stoppt einen Kauf ohne Deckung', () => {
    const b = vorflugkontrolle(konto({ buyingPower: 500 }), order);
    expect(b.ok).toBe(false);
    expect(b.gruende.join()).toMatch(/Kaufkraft/);
  });

  it('prüft die Deckung NICHT beim Verkauf — der löst Kapital', () => {
    const b = vorflugkontrolle(konto({ buyingPower: 0 }), { ...order, side: 'sell' });
    expect(b.gruende.join()).not.toMatch(/Kaufkraft/);
  });

  it('sammelt ALLE Gründe statt beim ersten abzubrechen', () => {
    const b = vorflugkontrolle(konto({ tradingBlocked: true, status: 'X', buyingPower: 1 }), order);
    expect(b.gruende.length).toBeGreaterThanOrEqual(3);
  });

  it('weist Menge oder Kurs von null ab', () => {
    expect(vorflugkontrolle(konto(), { ...order, qty: 0 }).ok).toBe(false);
    expect(vorflugkontrolle(konto(), { ...order, preis: 0 }).ok).toBe(false);
  });
});

describe('alpacaPositionen', () => {
  it('normalisiert Short-Mengen auf positiv plus Seite', async () => {
    // Alpaca liefert Shorts als negative Menge. Bliebe das Vorzeichen in der
    // Menge, würde jede Summenbildung stillschweigend saldieren.
    const f = vi.fn().mockResolvedValue(
      antwort([
        { symbol: 'AAPL', qty: '10', side: 'long', avg_entry_price: '150' },
        { symbol: 'TSLA', qty: '-5', side: 'short', avg_entry_price: '200' },
      ]),
    );
    const p = await alpacaPositionen('paper', f);
    expect(p[0]).toEqual({ symbol: 'AAPL', qty: 10, seite: 'long', einstand: 150 });
    expect(p[1]).toEqual({ symbol: 'TSLA', qty: 5, seite: 'short', einstand: 200 });
  });

  it('verträgt eine leere Antwort', async () => {
    const f = vi.fn().mockResolvedValue(antwort([]));
    expect(await alpacaPositionen('paper', f)).toEqual([]);
  });
});

describe('abgleich — beide Richtungen', () => {
  it('meldet nichts, wenn beide Seiten übereinstimmen', () => {
    expect(
      abgleich(
        [{ symbol: 'AAPL', qty: 10, side: 'long' }],
        [{ symbol: 'AAPL', qty: 10, seite: 'long', einstand: 150 }],
      ),
    ).toEqual([]);
  });

  it('findet eine Position, die NUR im eigenen Buch steht', () => {
    // Gefährlich, weil die Engine mit einer Deckung rechnet, die es nicht gibt.
    const a = abgleich([{ symbol: 'AAPL', qty: 10, side: 'long' }], []);
    expect(a).toHaveLength(1);
    expect(a[0]!.differenz).toBe(10);
  });

  it('findet eine Position, die NUR beim Broker liegt', () => {
    // Genauso gefährlich: ein Risiko, von dem die Engine nichts weiß.
    const a = abgleich([], [{ symbol: 'TSLA', qty: 3, seite: 'long', einstand: 200 }]);
    expect(a).toHaveLength(1);
    expect(a[0]!.differenz).toBe(-3);
  });

  it('unterscheidet Long von Short bei gleicher Menge', () => {
    // 10 long gegen 10 short ist die maximale Abweichung, nicht null.
    const a = abgleich(
      [{ symbol: 'AAPL', qty: 10, side: 'long' }],
      [{ symbol: 'AAPL', qty: 10, seite: 'short', einstand: 150 }],
    );
    expect(a).toHaveLength(1);
    expect(a[0]!.differenz).toBe(20);
  });

  it('schluckt Rundungsrauschen bei Bruchstücken', () => {
    expect(
      abgleich(
        [{ symbol: 'BTC-USD', qty: 0.1 + 0.2, side: 'long' }],
        [{ symbol: 'BTC-USD', qty: 0.3, seite: 'long', einstand: 50_000 }],
      ),
    ).toEqual([]);
  });
});
