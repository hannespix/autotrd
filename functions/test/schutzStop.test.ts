/**
 * Tests des Schutz-Stops (Bracket Stufe 1) — das Sicherheitsnetz zwischen
 * den Scans.
 *
 * Schwerpunkt sind die Fälle, in denen ein Fehler Geld kostet, ohne
 * aufzufallen: ein Stop, der enger gerundet wird als geplant; ein
 * „nicht stornierbar", das in Wahrheit „schon verkauft" heißt (ein zweiter
 * Verkauf eröffnete einen ungewollten Short); und ein Trailing, das bei
 * jedem Mini-Hoch ersetzt und damit Dauerrauschen erzeugt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position, RiskConfig } from '../../shared/src/index.js';
import {
  pflegeSchutz,
  planeSchutzStop,
  rundeStopPreis,
  schutzAufheben,
  schutzStopPreis,
  sollSchutzErsetzen,
} from '../src/core/schutzStop.js';

/* Firestore-Attrappe (Muster aus orderRouting.test.ts): vor den Importen
 * gehoistet, ein Doc mit get/set reicht für die Positions-Zugriffe. */
const { holt, setzt } = vi.hoisted(() => ({
  holt: vi.fn(),
  setzt: vi.fn(async () => undefined),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ doc: () => ({ get: holt, set: setzt }) }),
}));

const SCHLUESSEL = { keyId: 'PKTEST0000000001', secret: 'GEHEIM0000000001' };
const VERBINDUNG = { mode: 'paper' as const, schluessel: SCHLUESSEL };

const RISK: RiskConfig = { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1 };

const POS: Position = {
  symbol: 'AAPL',
  qty: 10,
  avgEntry: 100,
  stopLoss: null,
  takeProfit: null,
  openedAt: '2026-08-06T14:00:00Z',
  side: 'long',
  highWater: 100,
  broker: true,
  schutz: { orderId: 'alt1', stopPreis: 99, qty: 10 },
};

/** Antwort-Folge: jede Antwort mit eigenem ok/status/Körper. */
const folge = (
  ...antw: Array<{ ok?: boolean; status?: number; body?: unknown }>
): ReturnType<typeof vi.fn> => {
  let i = 0;
  return vi.fn(async () => {
    const a = antw[Math.min(i++, antw.length - 1)]!;
    return {
      ok: a.ok ?? true,
      status: a.status ?? 200,
      text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)),
    } as unknown as Response;
  });
};

const posSnap = (daten: Record<string, unknown> | null) => ({
  exists: daten !== null,
  data: () => daten,
});

beforeEach(() => {
  holt.mockReset();
  setzt.mockReset();
  setzt.mockResolvedValue(undefined);
});

describe('rundeStopPreis (vom Kurs WEG runden)', () => {
  it('Long rundet abwärts, Short aufwärts — 2 Stellen ab 1 $', () => {
    expect(rundeStopPreis(98.789, 'long')).toBe(98.78);
    expect(rundeStopPreis(98.781, 'short')).toBe(98.79);
  });
  it('unter 1 $ mit 4 Stellen', () => {
    expect(rundeStopPreis(0.98765, 'long')).toBe(0.9876);
    expect(rundeStopPreis(0.98761, 'short')).toBe(0.9877);
  });
});

describe('schutzStopPreis (der engere von Einstands- und Trailing-Stop)', () => {
  it('nur Stop-Loss: Einstand minus Prozent', () => {
    const r: RiskConfig = { stopLossPct: 2, takeProfitPct: 4 };
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100 }, r)).toBe(98);
  });
  it('Trailing über gestiegenem Hoch schlägt den Einstands-Stop', () => {
    const preis = schutzStopPreis(
      { side: 'long', qty: 10, avgEntry: 100, highWater: 110 },
      RISK,
    );
    // 110 × 0,99 = 108,9 — deutlich über den 98 des Einstands-Stops.
    expect(preis).toBeCloseTo(108.9, 2);
  });
  it('Short gespiegelt: der TIEFERE Kandidat gewinnt (näher am Kurs)', () => {
    const preis = schutzStopPreis(
      { side: 'short', qty: 10, avgEntry: 100, lowWater: 95 },
      RISK,
    );
    // Einstands-Stop 102, Trailing 95 × 1,01 = 95,95 → 95,95 gilt.
    expect(preis).toBeCloseTo(95.95, 2);
  });
  it('ohne Prozent-Stops gibt es kein Niveau', () => {
    const r: RiskConfig = { stopLossPct: 0, takeProfitPct: 4, trailingStopPct: 0 };
    expect(schutzStopPreis({ side: 'long', qty: 10, avgEntry: 100 }, r)).toBeNull();
  });
});

describe('planeSchutzStop (wann der Broker-Stop überhaupt entsteht)', () => {
  const lage = { side: 'long' as const, qty: 10, avgEntry: 100 };
  it('legt für US-Session-Klassen mit ganzen Stücken an', () => {
    const plan = planeSchutzStop(lage, RISK, 'stocks_us');
    expect(plan.anlegen).toBe(true);
    expect(plan.qty).toBe(10);
    expect(plan.stopPreis).toBeGreaterThan(0);
  });
  it('Krypto bleibt Engine-only', () => {
    expect(planeSchutzStop(lage, RISK, 'crypto').grund).toBe('klasse_ohne_us_session');
    expect(planeSchutzStop(lage, RISK, null).grund).toBe('klasse_ohne_us_session');
  });
  it('Bruchstücke kann Alpaca nicht schützen — 10,4 Stück ⇒ Stop über 10', () => {
    expect(planeSchutzStop({ ...lage, qty: 10.4 }, RISK, 'stocks_us').qty).toBe(10);
    expect(planeSchutzStop({ ...lage, qty: 0.4 }, RISK, 'stocks_us').grund).toBe('bruchstueck');
  });
  it('reine ATR-Konten (kein Prozent-Stop) bekommen keinen Broker-Stop', () => {
    const r: RiskConfig = { stopLossPct: 0, takeProfitPct: 4 };
    expect(planeSchutzStop(lage, r, 'stocks_us').grund).toBe('kein_prozent_stop');
  });
});

describe('sollSchutzErsetzen (0,1-%-Schwelle gegen Dauerrauschen)', () => {
  it('ersetzt erst ab spürbarer Verbesserung', () => {
    expect(sollSchutzErsetzen(100, 100.05, 'long')).toBe(false);
    expect(sollSchutzErsetzen(100, 100.2, 'long')).toBe(true);
  });
  it('Short spiegelt die Richtung: besser heißt TIEFER', () => {
    expect(sollSchutzErsetzen(100, 99.8, 'short')).toBe(true);
    expect(sollSchutzErsetzen(100, 100.2, 'short')).toBe(false);
  });
  it('nie auf kaputte Werte reagieren', () => {
    expect(sollSchutzErsetzen(0, 100, 'long')).toBe(false);
    expect(sollSchutzErsetzen(100, 0, 'long')).toBe(false);
  });
});

describe('schutzAufheben (die Regel, die nie brechen darf)', () => {
  it('Storno frei (204 ohne Körper) → eigener Exit darf raus', async () => {
    const f = folge({ ok: true, status: 200 }); // leerer Körper = 204-Fall
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b.stand).toBe('frei');
  });
  it('Order schon weg (404) ist gleichwertig frei', async () => {
    const f = folge({ ok: false, status: 404, body: { message: 'not found' } });
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b.stand).toBe('frei');
  });
  it('„nicht stornierbar" + Fill ⇒ der Broker war schneller: dessen Fill zählt', async () => {
    const f = folge(
      { ok: false, status: 422, body: { message: 'not cancelable' } },
      { body: { id: 'o1', status: 'filled', filled_qty: '10', filled_avg_price: '98.4' } },
    );
    const b = await schutzAufheben(VERBINDUNG, 'u1', 'AAPL', { orderId: 'o1' }, f as never);
    expect(b).toEqual({ stand: 'gefuellt', fillPreis: 98.4, fillQty: 10, orderId: 'o1' });
  });
});

describe('pflegeSchutz (Scan-Takt: buchen, neu anlegen, nachziehen)', () => {
  it('ausgelöster Stop → gefuellt, Schutz-Feld geräumt', async () => {
    const f = folge({
      body: { id: 'alt1', status: 'filled', filled_qty: '10', filled_avg_price: '98.9' },
    });
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', POS, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b).toEqual({ stand: 'gefuellt', fillPreis: 98.9, fillQty: 10, orderId: 'alt1' });
    expect(setzt).toHaveBeenCalledWith({ schutz: null }, { merge: true });
  });

  it('verschwundene Order (404) → Schutz wird neu angelegt', async () => {
    // Reihenfolge: GET 404 → (Anlegen liest Position) → POST neue Stop-Order.
    holt.mockResolvedValue(posSnap({ ...POS, schutz: null }));
    const f = folge(
      { ok: false, status: 404, body: { message: 'not found' } },
      { body: { id: 'neu2', status: 'accepted', client_order_id: 'x' } },
    );
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', POS, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
    // Der letzte Schreibvorgang trägt die NEUE Order-Kennung.
    const letzter = setzt.mock.calls.at(-1)?.[0] as { schutz?: { orderId: string } };
    expect(letzter?.schutz?.orderId).toBe('neu2');
  });

  it('stehende Order + gestiegenes Hoch → Stop wird ersetzt', async () => {
    const pos: Position = { ...POS, highWater: 110 };
    const f = folge(
      { body: { id: 'alt1', status: 'new', filled_qty: '0', filled_avg_price: null } },
      { body: { id: 'ersetzt1', status: 'accepted' } },
    );
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', pos, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
    const geschrieben = setzt.mock.calls.at(-1)?.[0] as {
      schutz?: { orderId: string; stopPreis: number };
    };
    expect(geschrieben?.schutz?.orderId).toBe('ersetzt1');
    expect(geschrieben?.schutz?.stopPreis).toBeCloseTo(108.9, 2);
  });

  it('stehende Order OHNE besseres Niveau bleibt unangetastet', async () => {
    const f = folge({ body: { id: 'alt1', status: 'new', filled_qty: '0' } });
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', { ...POS, highWater: 100 }, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
    expect(setzt).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1); // nur der Status-GET, kein PATCH
  });

  it('Pflege-Fehler stoppen den Scan nicht', async () => {
    const f = folge({ ok: false, status: 500, body: { message: 'kaputt' } });
    const b = await pflegeSchutz(
      VERBINDUNG, 'u1', 'AAPL', POS, RISK, 'stocks_us', 'scan1', f as never,
    );
    expect(b.stand).toBe('ok');
  });
});
