/**
 * Tests der puren Studio-Vorschau: Marker entstehen clientseitig aus Bars +
 * Spec — und ändern sich, wenn man die Schwelle ändert (Abnahme-Kern von M10:
 * „Schwelle ändern → Vorschau-Marker ändern sich ohne Server-Call").
 */
import { describe, expect, it } from 'vitest';
import type { StrategySpec } from '@autotrd/shared';
import { previewSignals, type PreviewBar } from '../src/preview.js';

/** Synthetik: 40 Bars seitwärts, dann 8 Bars steiler Absturz, dann Erholung. */
function dipBars(): PreviewBar[] {
  const bars: PreviewBar[] = [];
  let price = 100;
  for (let i = 0; i < 40; i++) {
    price += i % 2 === 0 ? 0.4 : -0.35;
    bars.push({ date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}A${i}`, close: price });
  }
  for (let i = 0; i < 8; i++) {
    price *= 0.97;
    bars.push({ date: `2026-06-0${i + 1}`, close: price });
  }
  for (let i = 0; i < 10; i++) {
    price *= 1.02;
    bars.push({ date: `2026-06-1${i}`, close: price });
  }
  return bars;
}

const rsiSpec = (buyBelow: number): StrategySpec => ({
  buy: { type: 'compare', left: 'rsi', op: 'lt', right: buyBelow },
  sell: { type: 'compare', left: 'rsi', op: 'gt', right: 65 },
});

describe('previewSignals (pure Client-Vorschau)', () => {
  it('erzeugt im Dip Kauf-Marker und beim Rebound Verkaufs-Marker + Halteband', () => {
    const r = previewSignals(rsiSpec(35), dipBars());
    expect(r.evaluatedBars).toBeGreaterThan(20);
    expect(r.markers.some((m) => m.dir === 'buy')).toBe(true);
    expect(r.holds.length).toBeGreaterThan(0);
  });

  it('Schwellen-Änderung ändert die Marker OHNE weitere Daten', () => {
    const strict = previewSignals(rsiSpec(10), dipBars());
    const loose = previewSignals(rsiSpec(45), dipBars());
    // Lockere Schwelle kauft FRÜHER (oder überhaupt, wenn die strenge nie
    // greift) — die Marker unterscheiden sich sichtbar, rein clientseitig.
    expect(JSON.stringify(loose.markers)).not.toBe(JSON.stringify(strict.markers));
    const firstBuy = (r: ReturnType<typeof previewSignals>): number =>
      r.markers.find((m) => m.dir === 'buy')?.index ?? Number.POSITIVE_INFINITY;
    expect(firstBuy(loose)).toBeLessThan(firstBuy(strict));
  });

  it('position-Regeln sehen den simulierten Long/Flat-Zustand', () => {
    const spec: StrategySpec = {
      buy: {
        type: 'all',
        children: [
          { type: 'compare', left: 'rsi', op: 'lt', right: 40 },
          { type: 'position', state: 'none' },
        ],
      },
      sell: { type: 'position', state: 'open', minUnrealizedPct: 4 },
    };
    const r = previewSignals(spec, dipBars());
    // Kein Doppel-Kauf im offenen Zustand; Verkauf erst ab +4 %
    const buys = r.markers.filter((m) => m.dir === 'buy');
    const sells = r.markers.filter((m) => m.dir === 'sell');
    expect(buys.length).toBeGreaterThan(0);
    expect(Math.abs(buys.length - sells.length)).toBeLessThanOrEqual(1);
  });

  it('Events-Map: fehlender Tag = „keine Events" (false), ohne Map = unbekannt', () => {
    const spec: StrategySpec = {
      buy: { type: 'not', child: { type: 'newsEvent', tags: ['halt'] } },
      sell: { type: 'compare', left: 'rsi', op: 'gt', right: 99 },
    };
    const withMap = previewSignals(spec, dipBars(), new Map());
    const withoutMap = previewSignals(spec, dipBars());
    // Mit Map: not(keine Events) = true → Käufe möglich; ohne Map: unbekannt → nie
    expect(withMap.markers.length).toBeGreaterThan(0);
    expect(withoutMap.markers.length).toBe(0);
  });
});
