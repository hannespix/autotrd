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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STRATEGY, type Position, type Strategy } from '../../shared/src/index.js';
import {
  abgleich,
  alpacaAsset,
  alpacaOrdersGeschlossen,
  warteAufFill,
} from '../src/core/alpacaBroker.js';
import { planeMenge, type TradeRequest } from '../src/core/broker.js';
import {
  assetAuskunft,
  brokerVerbindung,
  brokerVerbindungLesend,
  routeOrder,
  vergissAssets,
  vergissKillSwitch,
  vergissVerbindung,
} from '../src/core/orderRouting.js';

/* Firestore-Attrappe für den Verbindungs-Cache. Sie muss vor den Importen
 * greifen — deshalb `vi.hoisted`, sonst liefe `holt` erst nach dem Mock. */
const { holt, setzt } = vi.hoisted(() => ({
  holt: vi.fn(),
  setzt: vi.fn(async () => undefined),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ doc: () => ({ get: holt, set: setzt }) }),
  FieldPath: class {},
  FieldValue: { increment: () => 0, delete: () => 0 },
  Timestamp: { now: () => 0 },
}));
/** Doc-Attrappe: `get(feldname)` wie bei Firestore, nicht als Objekt. */
const feld = (daten: Record<string, unknown>) => ({
  exists: Object.keys(daten).length > 0,
  get: (k: string) => daten[k],
});

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

/* ── Verbindungs-Cache (M13) ───────────────────────────────────────────────
 *
 * Der Cache spart je Konto und Scan bis zu zehn identische Firestore-Reads.
 * Geprüft wird nicht das Sparen, sondern die zwei Richtungen, in denen er
 * Schaden anrichten könnte.
 */
describe('brokerVerbindung — Cache', () => {
  afterEach(() => {
    holt.mockClear();
    for (const uid of ['u-mit', 'u-ohne', 'u-fehler']) vergissVerbindung(uid);
  });

  it('liest innerhalb der Minute nur EINMAL — der Kern der Ersparnis', async () => {
    holt.mockResolvedValue(feld({ keyId: 'PK1', secretKey: 'S1', mode: 'paper' }));
    const a = await brokerVerbindung('u-mit', 1_000);
    const b = await brokerVerbindung('u-mit', 40_000);
    expect(a).toEqual({ mode: 'paper', schluessel: { keyId: 'PK1', secret: 'S1' } });
    expect(b).toEqual(a);
    expect(holt).toHaveBeenCalledTimes(1);
  });

  it('liest nach Ablauf des TTL wieder', async () => {
    holt.mockResolvedValue(feld({ keyId: 'PK1', secretKey: 'S1', mode: 'paper' }));
    await brokerVerbindung('u-mit', 1_000);
    await brokerVerbindung('u-mit', 62_000);
    expect(holt).toHaveBeenCalledTimes(2);
  });

  it('merkt sich auch „kein Broker" — der Normalfall darf nicht der teuerste sein', async () => {
    holt.mockResolvedValue(feld({}));
    expect(await brokerVerbindung('u-ohne', 1_000)).toBeNull();
    expect(await brokerVerbindung('u-ohne', 2_000)).toBeNull();
    expect(holt).toHaveBeenCalledTimes(1);
  });

  it('cacht einen FEHLER nicht — sonst wäre das Routing eine Minute lang still', async () => {
    holt.mockRejectedValue(new Error('Firestore weg'));
    expect(await brokerVerbindung('u-fehler', 1_000)).toBeNull();
    expect(await brokerVerbindung('u-fehler', 1_500)).toBeNull();
    expect(holt).toHaveBeenCalledTimes(2);
  });

  it('vergisst auf Zuruf — ein Trennen darf den Cache nicht überdauern', async () => {
    holt.mockResolvedValue(feld({ keyId: 'PK1', secretKey: 'S1', mode: 'paper' }));
    await brokerVerbindung('u-mit', 1_000);
    vergissVerbindung('u-mit');
    await brokerVerbindung('u-mit', 1_100);
    expect(holt).toHaveBeenCalledTimes(2);
  });
});

/* ── Echtgeld-Verriegelung (05.08.) ────────────────────────────────────────
 *
 * Seit Echtgeld-Schlüssel in der App hinterlegt werden dürfen, gibt es einen
 * Weg, den es vorher nicht gab: Ein `AK…` im Dokument ergibt `mode: 'live'`,
 * und ohne Sperre schickte `routeOrder` die nächste Order an den
 * Echtgeld-Endpunkt — ohne dass jemand etwas scharf geschaltet hätte.
 *
 * Das ist der teuerste denkbare Fehler dieser Codebasis. Entsprechend wird
 * er von beiden Seiten geprüft: Das Order-Routing muss schweigen, der
 * lesende Abgleich muss trotzdem funktionieren.
 */
describe('Echtgeld-Schlüssel und Order-Routing', () => {
  afterEach(() => {
    holt.mockClear();
    delete process.env.ALPACA_ALLOW_LIVE;
    // Der Kill-Switch-Cache ist modul-global — liegen lassen hieße, dass
    // ein späterer Test den Zustand DIESES Tests erbt.
    vergissKillSwitch();
    for (const uid of ['u-live', 'u-paper']) vergissVerbindung(uid);
  });

  it('gibt für ORDERS nichts zurück, solange Echtgeld nicht freigegeben ist', async () => {
    holt.mockResolvedValue(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }));
    expect(await brokerVerbindung('u-live', 1_000)).toBeNull();
  });

  it('gibt dieselbe Verbindung zum LESEN heraus — dafür ist sie hinterlegt', async () => {
    holt.mockResolvedValue(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }));
    const v = await brokerVerbindungLesend('u-live', 1_000);
    expect(v).toEqual({ mode: 'live', schluessel: { keyId: 'AK1', secret: 'S1' } });
  });

  it('routet erst mit ausdrücklicher Betreiber-Freigabe', async () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    holt.mockResolvedValue(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }));
    const v = await brokerVerbindung('u-live', 1_000);
    expect(v?.mode).toBe('live');
  });

  it('lässt Papierkonten davon unberührt', async () => {
    holt.mockResolvedValue(feld({ keyId: 'PK1', secretKey: 'S1', mode: 'paper' }));
    expect((await brokerVerbindung('u-paper', 1_000))?.mode).toBe('paper');
  });

  it('liefert nichts, wenn das Geheimnis nicht entschlüsselbar ist', async () => {
    // Kaputtes Chiffrat heißt: falscher Hauptschlüssel oder manipulierte
    // Daten. Beides darf NICHT als Zugangsdaten an einen Broker gehen —
    // lieber keine Verbindung als eine mit geratenem Inhalt.
    holt.mockResolvedValue(feld({ keyId: 'PK1', secretKey: 'v1:a:b:c', mode: 'paper' }));
    expect(await brokerVerbindungLesend('u-paper', 1_000)).toBeNull();
  });
});

/* ── Richtung der Drift entscheidet über die Sperre (Live-Fund 05.08.) ──────
 *
 * Der erste Betriebstag hat gezeigt, dass „jede Abweichung sperrt" zu grob
 * ist: Ein Konto mit leerem Buch und Beständen beim Broker wurde dauerhaft
 * gesperrt, obwohl die Engine mit diesen Beständen nichts zu tun hat.
 *
 * Diese Tests halten die Asymmetrie fest. Sie ist die gleiche Regel wie
 * überall in der Risiko-Hülle: die gefährliche Richtung hart, die harmlose
 * sichtbar.
 */
describe('abgleich — Vorzeichen der Differenz', () => {
  it('meldet Fehlbestand positiv: Buch hat mehr als der Broker', () => {
    const d = abgleich([{ symbol: 'AAPL', qty: 10 }], []);
    expect(d).toHaveLength(1);
    expect(d[0]!.differenz).toBeGreaterThan(0);
  });

  it('meldet Fremdbestand negativ: nur beim Broker vorhanden', () => {
    const d = abgleich([], [{ symbol: 'AAPL', qty: 10, seite: 'long', einstand: 100 }]);
    expect(d).toHaveLength(1);
    expect(d[0]!.differenz).toBeLessThan(0);
  });

  it('unterscheidet Long und Short bei gleicher Menge', () => {
    // Ein Long von 10 und ein Short von 10 sind nicht dasselbe. Ohne
    // Vorzeichen sähe das wie Übereinstimmung aus — und die Engine hielte
    // ein Depot für abgeglichen, das in die Gegenrichtung zeigt.
    const d = abgleich(
      [{ symbol: 'AAPL', qty: 10, side: 'short' }],
      [{ symbol: 'AAPL', qty: 10, seite: 'long', einstand: 100 }],
    );
    expect(d).toHaveLength(1);
    expect(d[0]!.differenz).toBe(-20);
  });

  it('meldet nichts, wenn beide Seiten übereinstimmen', () => {
    expect(
      abgleich(
        [{ symbol: 'AAPL', qty: 10 }],
        [{ symbol: 'AAPL', qty: 10, seite: 'long', einstand: 100 }],
      ),
    ).toHaveLength(0);
  });
});

/* ── Order-Historie für die Depot-Übernahme (Vorfall 05.08.) ────────────────
 *
 * Am 05.08. hat die Engine real beim Broker gekauft, und das Buch wurde per
 * Reset geleert. Die geschlossenen Orders sind die einzige Quelle, aus der
 * sich die Historie zurückgewinnen lässt — entsprechend darf das Parsing
 * weder stornierte Orders als Trades erfinden noch echte Fills verlieren.
 */
describe('alpacaOrdersGeschlossen', () => {
  it('liefert nur Orders MIT Ausführung', async () => {
    const f = antworten([
      { id: 'a', client_order_id: 'u1-AAPL-buy-5-scan-1', symbol: 'AAPL', side: 'buy',
        filled_qty: '5', filled_avg_price: '190.5', filled_at: '2026-08-05T13:30:22Z' },
      // Storniert ohne Fill: für Buch und Steuer ein Nicht-Ereignis.
      { id: 'b', client_order_id: 'u1-TAN-buy-9-scan-1', symbol: 'TAN', side: 'buy',
        filled_qty: '0', filled_avg_price: null, filled_at: null, status: 'canceled' },
    ]);
    const r = await alpacaOrdersGeschlossen('paper', SCHLUESSEL, '2026-08-05T00:00:00Z', f);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      id: 'a', clientOrderId: 'u1-AAPL-buy-5-scan-1', symbol: 'AAPL', side: 'buy',
      qty: 5, kurs: 190.5, filledAt: '2026-08-05T13:30:22Z',
    });
  });

  it('erkennt Verkäufe als Verkäufe — sonst würde die Übernahme Bestände erfinden', async () => {
    const f = antworten([
      { id: 'c', client_order_id: 'u1-SMH-sell-3-scan-2', symbol: 'SMH', side: 'sell',
        filled_qty: '3', filled_avg_price: '576.9', filled_at: '2026-08-05T14:00:00Z' },
    ]);
    const r = await alpacaOrdersGeschlossen('paper', SCHLUESSEL, '2026-08-05T00:00:00Z', f);
    expect(r[0]?.side).toBe('sell');
  });

  it('gibt bei kaputter Antwort eine leere Liste zurück, keinen Absturz', async () => {
    const f = antworten({ nicht: 'eine liste' });
    expect(await alpacaOrdersGeschlossen('paper', SCHLUESSEL, '2026-08-05T00:00:00Z', f)).toEqual([]);
  });
});

describe('alpacaAsset — Eigenschaften vom Broker statt geraten', () => {
  it('liest fractionable/shortable/tradable aus der Antwort', async () => {
    const f = antworten({
      symbol: 'AAPL',
      tradable: true,
      fractionable: true,
      shortable: true,
      easy_to_borrow: true,
      marginable: true,
    });
    const a = await alpacaAsset('paper', 'AAPL', SCHLUESSEL, f);
    expect(a).toEqual({
      symbol: 'AAPL',
      tradable: true,
      fractionable: true,
      shortable: true,
      easyToBorrow: true,
      marginable: true,
    });
  });

  it('404 heißt „kennt Alpaca nicht" — null, kein Fehler', async () => {
    // Der halbe Katalog (Indizes, Forex, Futures) existiert bei Alpaca nicht.
    const f = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{"message":"asset not found"}',
    })) as unknown as typeof fetch;
    expect(await alpacaAsset('paper', '^GSPC', SCHLUESSEL, f)).toBeNull();
  });

  it('andere Fehler werfen weiter — Netzprobleme sind kein „gibt es nicht"', async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'kaputt',
    })) as unknown as typeof fetch;
    await expect(alpacaAsset('paper', 'AAPL', SCHLUESSEL, f)).rejects.toThrow('HTTP 500');
  });

  it('fehlende Felder werden konservativ als false gelesen', async () => {
    const a = await alpacaAsset('paper', 'X', SCHLUESSEL, antworten({ symbol: 'X' }));
    expect(a?.fractionable).toBe(false);
    expect(a?.shortable).toBe(false);
    expect(a?.tradable).toBe(false);
  });
});

describe('assetAuskunft — Zwei-Stufen-Cache', () => {
  const VERB = { mode: 'paper' as const, schluessel: SCHLUESSEL };

  afterEach(() => {
    vergissAssets();
    holt.mockReset();
    setzt.mockClear();
  });

  it('holt live, merkt sich das Ergebnis und persistiert es', async () => {
    holt.mockResolvedValue(feld({})); // Firestore-Cache leer
    const f = antworten({ symbol: 'NVDA', tradable: true, fractionable: true, shortable: true });
    const t0 = 1_000_000;

    const a1 = await assetAuskunft(VERB, 'NVDA', f as unknown as typeof fetch, t0);
    expect(a1?.fractionable).toBe(true);
    // Zweiter Aufruf: Prozess-Cache, kein weiterer HTTP-Aufruf.
    const a2 = await assetAuskunft(VERB, 'NVDA', f as unknown as typeof fetch, t0 + 1000);
    expect(a2?.shortable).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    // Persistiert mit bekannt: true.
    expect(setzt).toHaveBeenCalledWith(
      expect.objectContaining({ NVDA: expect.objectContaining({ bekannt: true, fractionable: true }) }),
      { merge: true },
    );
  });

  it('bedient sich aus dem Firestore-Cache, ohne den Broker zu fragen', async () => {
    const t0 = Date.parse('2026-08-05T12:00:00Z');
    holt.mockResolvedValue(
      feld({
        MSFT: {
          bekannt: true,
          tradable: true,
          fractionable: true,
          shortable: false,
          at: new Date(t0 - 3_600_000).toISOString(), // 1 h alt — frisch genug
        },
      }),
    );
    const f = vi.fn();
    const a = await assetAuskunft(VERB, 'MSFT', f as unknown as typeof fetch, t0);
    expect(a?.fractionable).toBe(true);
    expect(a?.shortable).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('auch „kennt Alpaca nicht" wird gemerkt — sonst fragt jeder Tag neu', async () => {
    const t0 = Date.parse('2026-08-05T12:00:00Z');
    holt.mockResolvedValue(
      feld({ '^GSPC': { bekannt: false, at: new Date(t0 - 60_000).toISOString() } }),
    );
    const f = vi.fn();
    expect(await assetAuskunft(VERB, '^GSPC', f as unknown as typeof fetch, t0)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('ein abgelaufener Eintrag wird live erneuert', async () => {
    const t0 = Date.parse('2026-08-05T12:00:00Z');
    holt.mockResolvedValue(
      feld({
        AMD: { bekannt: true, tradable: true, at: new Date(t0 - 25 * 3_600_000).toISOString() },
      }),
    );
    const f = antworten({ symbol: 'AMD', tradable: true, shortable: true });
    const a = await assetAuskunft(VERB, 'AMD', f as unknown as typeof fetch, t0);
    expect(a?.shortable).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('Fehler liefert null und wird NICHT persistiert', async () => {
    holt.mockResolvedValue(feld({}));
    const f = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'kaputt',
    }));
    expect(await assetAuskunft(VERB, 'TSLA', f as unknown as typeof fetch, 1_000)).toBeNull();
    expect(setzt).not.toHaveBeenCalled();
  });
});

/* ── Owner-Kill-Switch (M14) ────────────────────────────────────────────────
 *
 * Der Not-Aus muss zwei Dinge gleichzeitig können: Echtgeld SOFORT stoppen
 * und alles andere in Ruhe lassen. Ein Not-Aus, der auch Paper-Konten
 * anhält, würde im Ernstfall zögern lassen — und einer, der bei einem
 * Firestore-Schluckauf still offen bleibt, wäre keiner.
 */
describe('Kill-Switch — Not-Aus für Echtgeld-Order-Pfade', () => {
  beforeEach(() => {
    // Reihenfolge-unabhängig: Cache-Reste anderer Describe-Blöcke verwerfen.
    vergissKillSwitch();
    for (const uid of ['u-live', 'u-paper']) vergissVerbindung(uid);
  });
  afterEach(() => {
    holt.mockReset();
    delete process.env.ALPACA_ALLOW_LIVE;
    vergissKillSwitch();
    for (const uid of ['u-live', 'u-paper']) vergissVerbindung(uid);
  });

  it('ausgelöst → keine Live-Verbindung fürs Order-Routing', async () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    // Erster Read: private/broker. Zweiter Read: meta/live.
    holt
      .mockResolvedValueOnce(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }))
      .mockResolvedValueOnce(feld({ killSwitch: true }));
    expect(await brokerVerbindung('u-live', 1_000)).toBeNull();
  });

  it('nicht ausgelöst → Live-Routing läuft (mit Betreiber-Freigabe)', async () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    holt
      .mockResolvedValueOnce(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }))
      .mockResolvedValueOnce(feld({ killSwitch: false }));
    expect((await brokerVerbindung('u-live', 1_000))?.mode).toBe('live');
  });

  it('lässt Paper-Routing unberührt — der Not-Aus gilt NUR für Echtgeld', async () => {
    holt.mockResolvedValue(feld({ keyId: 'PK1', secretKey: 'S1', mode: 'paper' }));
    // Kein zweiter Read: Für Paper wird meta/live gar nicht erst gelesen.
    expect((await brokerVerbindung('u-paper', 1_000))?.mode).toBe('paper');
    expect(holt).toHaveBeenCalledTimes(1);
  });

  it('Schalter nicht lesbar → Echtgeld angehalten (fail-closed)', async () => {
    process.env.ALPACA_ALLOW_LIVE = '1';
    holt
      .mockResolvedValueOnce(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }))
      .mockRejectedValueOnce(new Error('firestore down'));
    // Wer den Not-Aus nicht lesen kann, darf nicht behaupten, er sei aus.
    expect(await brokerVerbindung('u-live', 1_000)).toBeNull();
  });

  it('der LESENDE Abgleich bleibt auch bei ausgelöstem Schalter möglich', async () => {
    // Depot-Überwachung ist gerade im Ernstfall wichtig — der Not-Aus stoppt
    // Orders, nicht die Sicht auf das Depot.
    holt.mockResolvedValue(feld({ keyId: 'AK1', secretKey: 'S1', mode: 'live' }));
    const v = await brokerVerbindungLesend('u-live', 1_000);
    expect(v?.mode).toBe('live');
  });
});
