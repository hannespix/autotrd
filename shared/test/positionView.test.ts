/**
 * Positions-Ansicht — die Rechnung hinter Positionstabelle UND Chart-Linien
 * (04.08.).
 *
 * Warum eigene Tests: Die Level entscheiden, WO im Chart die Stop- und
 * Ziel-Linie liegt. Eine gespiegelte Short-Rechnung, die falsch herum läuft,
 * sieht im Chart plausibel aus (eine Linie ist ja da) und behauptet trotzdem
 * das Gegenteil dessen, was die Engine tun wird. Und der Einstiegs-Anker
 * entscheidet, ob die Marke am richtigen Bar sitzt — ein Off-by-one behauptet
 * einen Einstiegstag, den es nie gab.
 */

import { describe, expect, it } from 'vitest';
import {
  entryAnchor,
  haltedauerTage,
  levelDistPct,
  positionLevels,
  positionPnl,
} from '../src/positionView.js';
import type { Position, RiskConfig } from '../src/strategy.js';

const RISK: RiskConfig = { stopLossPct: 5, takeProfitPct: 10 };

function pos(over: Partial<Position> = {}): Position {
  return {
    symbol: 'AAPL',
    qty: 10,
    avgEntry: 100,
    stopLoss: null,
    takeProfit: null,
    openedAt: '2026-08-01T14:35:00.000Z',
    ...over,
  };
}

describe('positionLevels', () => {
  it('legt beim LONG den Stop unter und das Ziel über den Einstand', () => {
    const lv = positionLevels(pos(), RISK);
    expect(lv.entry).toBe(100);
    expect(lv.stop).toBeCloseTo(95, 6);
    expect(lv.target).toBeCloseTo(110, 6);
  });

  it('spiegelt beim SHORT: Stop über, Ziel unter dem Einstand', () => {
    const lv = positionLevels(pos({ side: 'short' }), RISK);
    expect(lv.stop).toBeCloseTo(105, 6);
    expect(lv.target).toBeCloseTo(90, 6);
  });

  it('bevorzugt gespeicherte Level gegenüber den Prozenten', () => {
    // Die Engine schreibt beim Öffnen konkrete Level — die gelten, auch wenn
    // die Strategie inzwischen andere Prozente hat.
    const lv = positionLevels(pos({ stopLoss: 91.5, takeProfit: 123 }), RISK);
    expect(lv.stop).toBe(91.5);
    expect(lv.target).toBe(123);
  });

  it('meldet ATR-adaptive Stops als adaptiv statt eine Linie zu erfinden', () => {
    const lv = positionLevels(pos(), { ...RISK, atrStopMult: 2, atrTakeMult: 3 });
    expect(lv.stop).toBeNull();
    expect(lv.stopAtr).toBe(true);
    expect(lv.target).toBeNull();
    expect(lv.targetAtr).toBe(true);
  });

  it('liefert kein Level, wenn Prozente auf 0 stehen', () => {
    const lv = positionLevels(pos(), { stopLossPct: 0, takeProfitPct: 0 });
    expect(lv.stop).toBeNull();
    expect(lv.stopAtr).toBe(false);
    expect(lv.target).toBeNull();
  });

  it('zieht den Trailing-Stop am Höchstkurs nach, sobald er scharf ist', () => {
    const lv = positionLevels(pos({ highWater: 120 }), { ...RISK, trailingStopPct: 4 });
    expect(lv.trail).toBeCloseTo(115.2, 6);
    expect(lv.trailWartet).toBe(false);
  });

  it('hält den Trailing-Stop zurück, solange die Position nie im Gewinn war', () => {
    // Sonst wäre das Trailing ein zweiter Stop am Einstand — den hat niemand
    // konfiguriert.
    const lv = positionLevels(pos({ highWater: 100 }), { ...RISK, trailingStopPct: 4 });
    expect(lv.trail).toBeNull();
    expect(lv.trailWartet).toBe(true);
  });

  it('zieht den Short-Trailing am TIEFSTKURS nach', () => {
    const lv = positionLevels(pos({ side: 'short', lowWater: 80 }), { ...RISK, trailingStopPct: 5 });
    expect(lv.trail).toBeCloseTo(84, 6);
  });

  it('ohne Trailing-Prozent gibt es weder Level noch Wartehinweis', () => {
    const lv = positionLevels(pos({ highWater: 120 }), RISK);
    expect(lv.trail).toBeNull();
    expect(lv.trailWartet).toBe(false);
  });
});

describe('levelDistPct', () => {
  it('misst beim LONG den Stop nach unten und das Ziel nach oben', () => {
    expect(levelDistPct(95, 100, 'stop', false)).toBeCloseTo(5, 6);
    expect(levelDistPct(110, 100, 'target', false)).toBeCloseTo(10, 6);
  });

  it('misst beim SHORT gespiegelt', () => {
    expect(levelDistPct(105, 100, 'stop', true)).toBeCloseTo(5, 6);
    expect(levelDistPct(90, 100, 'target', true)).toBeCloseTo(10, 6);
  });

  it('wird negativ, wenn der Kurs das Level schon gerissen hat', () => {
    // Genau dieser Fall färbt die Anzeige rot: „löst beim nächsten Scan aus".
    expect(levelDistPct(95, 94, 'stop', false)).toBeLessThan(0);
  });
});

describe('positionPnl', () => {
  it('rechnet den LONG-Gewinn am steigenden Kurs', () => {
    const r = positionPnl(pos(), 110);
    expect(r.pnl).toBeCloseTo(100, 6);
    expect(r.pct).toBeCloseTo(10, 6);
  });

  it('rechnet den SHORT-Gewinn am FALLENDEN Kurs', () => {
    const r = positionPnl(pos({ side: 'short' }), 90);
    expect(r.pnl).toBeCloseTo(100, 6);
    expect(r.pct).toBeCloseTo(10, 6);
  });

  it('bleibt bei Einstand 0 stabil statt NaN zu liefern', () => {
    expect(positionPnl(pos({ avgEntry: 0 }), 5).pct).toBe(0);
  });
});

describe('entryAnchor', () => {
  const tage = ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-03', '2026-08-04'];

  it('findet den Einstiegstag in der Tages-Sicht', () => {
    expect(entryAnchor(tage, '2026-07-31T14:35:00.000Z')).toEqual({ index: 2, vorFenster: false });
  });

  it('rückt auf den nächsten Handelstag, wenn der Einstieg aufs Wochenende fällt', () => {
    // 01.08.2026 ist ein Samstag — die Marke gehört an den Montag danach.
    expect(entryAnchor(tage, '2026-08-01T09:00:00.000Z')).toEqual({ index: 3, vorFenster: false });
  });

  it('meldet vorFenster, wenn der Einstieg links außerhalb liegt', () => {
    // Dann darf KEIN Marker gesetzt werden — er würde einen Tag behaupten,
    // an dem gar nichts passiert ist.
    expect(entryAnchor(tage, '2026-03-02T00:00:00.000Z')).toEqual({ index: 0, vorFenster: true });
  });

  it('liefert null, wenn der Einstieg nach dem letzten Bar liegt', () => {
    expect(entryAnchor(tage, '2026-09-01T00:00:00.000Z')).toBeNull();
  });

  it('trifft den Bar auf die Sekunde genau (kein vorFenster)', () => {
    expect(entryAnchor(tage, '2026-07-29T00:00:00.000Z')).toEqual({ index: 0, vorFenster: false });
  });

  it('arbeitet auch in der Intraday-Domäne (UNIX-Sekunden)', () => {
    const t0 = Date.parse('2026-08-04T13:30:00.000Z') / 1000;
    const zeiten = [t0, t0 + 300, t0 + 600, t0 + 900];
    expect(entryAnchor(zeiten, '2026-08-04T13:37:00.000Z')).toEqual({ index: 2, vorFenster: false });
  });

  it('gibt bei leerer Zeitachse null zurück', () => {
    expect(entryAnchor([], '2026-08-04T13:37:00.000Z')).toBeNull();
  });

  it('gibt bei unbrauchbarem Zeitstempel null zurück', () => {
    expect(entryAnchor(tage, 'kaputt')).toBeNull();
    expect(entryAnchor([1, 2, 3], 'kaputt')).toBeNull();
  });
});

describe('haltedauerTage', () => {
  it('zählt volle Tage seit Einstieg', () => {
    const jetzt = Date.parse('2026-08-04T18:00:00.000Z');
    expect(haltedauerTage('2026-08-01T14:35:00.000Z', jetzt)).toBe(3);
  });

  it('meldet am Eröffnungstag 0 statt eines halben Tages', () => {
    const jetzt = Date.parse('2026-08-04T18:00:00.000Z');
    expect(haltedauerTage('2026-08-04T14:35:00.000Z', jetzt)).toBe(0);
  });

  it('bleibt bei kaputtem Zeitstempel bei 0', () => {
    expect(haltedauerTage('', Date.parse('2026-08-04T18:00:00.000Z'))).toBe(0);
  });
});
