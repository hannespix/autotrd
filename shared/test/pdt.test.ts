/**
 * PDT-Bremse (05.10.): Unter 25.000 $ Equity markiert der vierte Daytrade in
 * fünf Handelstagen das Konto — 90 Tage ohne Daytrades. Gepinnt wird, wann
 * Einstiege pausieren und dass ein fehlender oder alter Stand NIE bremst.
 */
import { describe, expect, it } from 'vitest';
import { PDT_EQUITY_GRENZE, pdtEinstiegGesperrt } from '../src/index.js';

const jetzt = new Date('2026-10-05T15:00:00.000Z');
const stand = (over: Record<string, unknown> = {}) => ({
  daytrades: 0,
  equity: 2_000,
  markiert: false,
  at: '2026-10-05T14:55:00.000Z',
  ...over,
});

describe('pdtEinstiegGesperrt', () => {
  it('kleines Konto, bis zwei Daytrades → frei (ein weiterer Rundlauf bleibt erlaubt)', () => {
    expect(pdtEinstiegGesperrt(stand({ daytrades: 2 }), jetzt)).toBe(false);
  });
  it('kleines Konto, drei Daytrades → Einstiege pausieren', () => {
    expect(pdtEinstiegGesperrt(stand({ daytrades: 3 }), jetzt)).toBe(true);
  });
  it('bereits markiert → Einstiege pausieren', () => {
    expect(pdtEinstiegGesperrt(stand({ markiert: true }), jetzt)).toBe(true);
  });
  it('ab 25.000 $ gilt die Regel nicht', () => {
    expect(pdtEinstiegGesperrt(stand({ daytrades: 9, equity: PDT_EQUITY_GRENZE }), jetzt)).toBe(false);
  });
  it('heute eröffnete Broker-Positionen zählen mit — jeder Ausstieg heute wäre ein Daytrade', () => {
    expect(pdtEinstiegGesperrt(stand({ daytrades: 2 }), jetzt, 0)).toBe(false);
    expect(pdtEinstiegGesperrt(stand({ daytrades: 2 }), jetzt, 1)).toBe(true);
    expect(pdtEinstiegGesperrt(stand({ daytrades: 0 }), jetzt, 3)).toBe(true);
  });
  it('fehlender, kaputter oder alter Stand bremst NIE', () => {
    expect(pdtEinstiegGesperrt(undefined, jetzt)).toBe(false);
    expect(pdtEinstiegGesperrt({ daytrades: 5 }, jetzt)).toBe(false);
    expect(pdtEinstiegGesperrt(stand({ daytrades: 5, equity: 0 }), jetzt)).toBe(false);
    expect(pdtEinstiegGesperrt(stand({ daytrades: 5, at: '2026-10-03T14:00:00.000Z' }), jetzt)).toBe(false);
  });
});
