/**
 * Positionsgrößen-Basis (Owner-Feedback 26.07.: „warum wird nicht mit dem
 * gesamten Wallet gearbeitet?"): sizeOrder() bestimmt die Stückzahl eines
 * Engine-Kaufs. Default ist die CASH-Basis — das Wallet arbeitet weiter,
 * auch wenn schon Positionen offen sind. Die Startkapital-Basis bleibt als
 * bewusste Option ('initial') erhalten.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type Strategy } from '../../shared/src/index.js';
import { sizeOrder } from '../src/core/broker.js';

const strat = (over: {
  sizingBase?: 'initial' | 'balance' | undefined;
  initialCapital?: number;
  maxPositionPct?: number;
}): Strategy => {
  const s = structuredClone(DEFAULT_STRATEGY);
  if (over.sizingBase === undefined) delete s.broker.sizingBase;
  else s.broker.sizingBase = over.sizingBase;
  if (over.initialCapital !== undefined) s.broker.initialCapital = over.initialCapital;
  if (over.maxPositionPct !== undefined) s.engine.maxPositionPct = over.maxPositionPct;
  return s;
};

describe('sizeOrder — Cash-Basis (Default)', () => {
  it('nimmt maxPositionPct vom VERFÜGBAREN Cash, nicht vom Startkapital', () => {
    const s = strat({ sizingBase: 'balance', initialCapital: 25_000, maxPositionPct: 10 });
    // Cash ist auf 4 000 geschrumpft → 10 % davon = 400 → 4 Stück à 100
    expect(sizeOrder(s, 4_000, 100)).toBe(4);
  });

  it('fehlendes Feld (Bestands-Strategien) = Cash-Basis', () => {
    const s = strat({ sizingBase: undefined, initialCapital: 25_000, maxPositionPct: 10 });
    expect(s.broker.sizingBase).toBeUndefined();
    expect(sizeOrder(s, 4_000, 100)).toBe(4);
  });

  it('Cash-Basis kann IMMER kaufen, solange die Tranche ≥ 1 Stück ergibt', () => {
    const s = strat({ sizingBase: 'balance', initialCapital: 25_000, maxPositionPct: 10 });
    // Startkapital-Basis würde hier 2 500 verlangen — Cash deckt nur 1 200,
    // aber 10 % von 1 200 = 120 → 1 Stück geht immer noch.
    expect(sizeOrder(s, 1_200, 100)).toBe(1);
  });

  it('Kosten überschreiten den Cash nie (pct ≤ 100 ⇒ qty·price ≤ balance)', () => {
    const s = strat({ sizingBase: 'balance', maxPositionPct: 100 });
    const qty = sizeOrder(s, 999.99, 100);
    expect(qty * 100).toBeLessThanOrEqual(999.99);
  });

  it('negativer/leerer Cash → 0 Stück (kein Kauf, keine NaN-Falle)', () => {
    const s = strat({ sizingBase: 'balance' });
    expect(sizeOrder(s, 0, 100)).toBe(0);
    expect(sizeOrder(s, -50, 100)).toBe(0);
  });
});

describe('sizeOrder — Bruchstücke für Krypto (MA-Fund 26.07.)', () => {
  it('BTC bei ~64 000 $: ganze Stücke ergeben 0, Bruchteile kaufen ~0.0388', () => {
    const s = strat({ sizingBase: 'balance', maxPositionPct: 10 });
    expect(sizeOrder(s, 25_000, 64_452)).toBe(0); // der alte Zustand: nie kaufbar
    const q = sizeOrder(s, 25_000, 64_452, true);
    expect(q).toBeCloseTo(0.038788, 6); // 2 500 / 64 452, auf µ-Einheiten abgerundet
    expect(q * 64_452).toBeLessThanOrEqual(2_500);
  });

  it('µ-Rundung: nie mehr als 6 Nachkommastellen, nie über der Tranche', () => {
    const s = strat({ sizingBase: 'balance', maxPositionPct: 10 });
    const q = sizeOrder(s, 1_000, 97_531.13, true);
    expect(Math.round(q * 1e6)).toBe(q * 1e6); // exakt µ-Raster
    expect(q * 97_531.13).toBeLessThanOrEqual(100);
  });

  it('unter einer µ-Einheit → 0 (Broker lehnt mit qty_unter_1 ab)', () => {
    const s = strat({ sizingBase: 'balance', maxPositionPct: 10 });
    expect(sizeOrder(s, 0.005, 64_452, true)).toBe(0);
  });
});

describe('sizeOrder — Startkapital-Basis (Option)', () => {
  it("'initial' rechnet fix vom Startkapital, unabhängig vom Cash", () => {
    const s = strat({ sizingBase: 'initial', initialCapital: 25_000, maxPositionPct: 10 });
    expect(sizeOrder(s, 4_000, 100)).toBe(25); // 2 500 / 100 — Cash-Deckung prüft der Broker
  });

  it('rundet immer auf ganze Stück ab', () => {
    const s = strat({ sizingBase: 'initial', initialCapital: 10_000, maxPositionPct: 10 });
    expect(sizeOrder(s, 10_000, 333)).toBe(3); // 1 000 / 333 = 3.003 → 3
  });
});

/* ── Hebel (Owner-Wunsch 28.07.) ────────────────────────────────────────── */

describe('sizeOrder mit Margin-Budget', () => {
  it('ohne Budget bleibt alles wie vorher — bar gedeckt', () => {
    // Regressionsschutz: Der Hebel darf das Standardverhalten nicht anfassen.
    const s = strat({ maxPositionPct: 10 });
    expect(sizeOrder(s, 10_000, 100)).toBe(10);
  });

  it('die Tranche skaliert MIT dem Hebel — sonst bliebe er folgenlos', () => {
    // Der Fund aus dem Emulator-Lauf 28.07.: Rechnete die Tranche vom
    // blanken Eigenkapital, kamen bei 10 % je Position und höchstens 10
    // Positionen exakt 100 % des Eigenkapitals heraus — die Kaufkraft von
    // 300 % wurde nie erreicht, der Hebel tat nichts. Mit ihm skaliert:
    // 10 000 $ × 3 × 10 % = 3 000 $ = 30 Stück.
    const s = strat({ maxPositionPct: 10 });
    expect(sizeOrder(s, 0, 100, false, { equity: 10_000, buyingPower: 30_000, leverage: 3 })).toBe(30);
  });

  it('zehn solcher Tranchen ergeben genau die versprochene Auslastung', () => {
    // 10 × 3 000 $ = 30 000 $ = Eigenkapital × 3. Nicht mehr — die
    // Kaufkraft deckelt die Summe, der Hebel wirkt also nicht doppelt.
    const s = strat({ maxPositionPct: 10 });
    const stueck = sizeOrder(s, 0, 100, false, { equity: 10_000, buyingPower: 30_000, leverage: 3 });
    expect(stueck * 100 * 10).toBe(30_000);
  });

  it('die Kaufkraft deckelt die Tranche, wenn sie kleiner ist', () => {
    // Neunte Position bei fast erschöpfter Kaufkraft: Die Tranche wäre
    // 3 000 $, es sind aber nur noch 1 200 $ frei.
    const s = strat({ maxPositionPct: 10 });
    expect(sizeOrder(s, 0, 100, false, { equity: 10_000, buyingPower: 1_200, leverage: 3 })).toBe(12);
  });

  it('erschöpfte Kaufkraft ergibt 0 Stück — der Broker lehnt dann ab', () => {
    const s = strat({ maxPositionPct: 10 });
    expect(sizeOrder(s, 50_000, 100, false, { equity: 10_000, buyingPower: 0, leverage: 3 })).toBe(0);
  });

  it('Hebel 1 im Budget ⇒ Tranche wie bar gedeckt', () => {
    const s = strat({ maxPositionPct: 10 });
    expect(sizeOrder(s, 0, 100, false, { equity: 10_000, buyingPower: 10_000, leverage: 1 })).toBe(10);
  });

  it('das Budget schlägt die Sizing-Basis „initial"', () => {
    // Sonst käme unter Hebel eine fixe Startkapital-Tranche heraus, die mit
    // dem tatsächlichen Kontostand nichts mehr zu tun hat.
    const s = strat({ sizingBase: 'initial', initialCapital: 100_000, maxPositionPct: 10 });
    expect(sizeOrder(s, 0, 100, false, { equity: 10_000, buyingPower: 30_000, leverage: 3 })).toBe(30);
  });

  it('Krypto handelt auch unter Hebel in Bruchteilen', () => {
    const s = strat({ maxPositionPct: 10 });
    expect(
      sizeOrder(s, 0, 64_000, true, { equity: 10_000, buyingPower: 30_000, leverage: 3 }),
    ).toBeCloseTo(0.046875, 6);
  });
});
