/**
 * MA1 (Engine-Audit 26.07.): Adversariale Tests des Risiko-Exits.
 *
 * Der Exit ist der einzige Pfad, der eine Position OHNE Gegensignal wieder
 * schließt — er entscheidet über realisierte Verluste. Diese Tests halten
 * die Grenzfälle fest, die im Audit auffielen:
 *  - takeProfitPct = 0 bedeutet „kein Take-Profit", NICHT „bei jedem
 *    Nicht-Verlust verkaufen" (change >= 0 feuerte sonst sofort).
 *  - Die beim Kauf gespeicherten LEVEL der Position gelten — nicht die
 *    heutigen Prozente. Sonst verschiebt eine Settings-Änderung rückwirkend
 *    die Stops aller offenen Positionen, während die UI die alten zeigt.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type Position, type Strategy } from '../../shared/src/index.js';
import { riskExitReason } from '../src/core/broker.js';

const strat = (stopLossPct: number, takeProfitPct: number): Strategy => {
  const s = structuredClone(DEFAULT_STRATEGY);
  s.engine.stopLossPct = stopLossPct;
  s.engine.takeProfitPct = takeProfitPct;
  return s;
};

const pos = (over: Partial<Position> = {}): Position => ({
  symbol: 'QQQ',
  qty: 10,
  avgEntry: 100,
  stopLoss: null,
  takeProfit: null,
  openedAt: '2026-07-20T14:00:00.000Z',
  ...over,
});

describe('riskExitReason — Prozent-Fallback', () => {
  it('feuert Stop-Loss ab der Schwelle, nicht davor', () => {
    const s = strat(2, 4);
    expect(riskExitReason(pos(), 98.5, s)).toBeNull();
    expect(riskExitReason(pos(), 98, s)).toBe('stop_loss');
    expect(riskExitReason(pos(), 90, s)).toBe('stop_loss');
  });

  it('feuert Take-Profit ab der Schwelle, nicht davor', () => {
    const s = strat(2, 4);
    expect(riskExitReason(pos(), 103.9, s)).toBeNull();
    expect(riskExitReason(pos(), 104, s)).toBe('take_profit');
  });

  it('takeProfitPct = 0 heißt KEIN Take-Profit (nicht „bei jedem Plus raus")', () => {
    const s = strat(2, 0);
    expect(riskExitReason(pos(), 100, s)).toBeNull();
    expect(riskExitReason(pos(), 140, s)).toBeNull();
    // Der Stop bleibt aktiv
    expect(riskExitReason(pos(), 97, s)).toBe('stop_loss');
  });

  it('stopLossPct = 0 heißt KEIN Stop (nicht „bei jedem Minus raus")', () => {
    const s = strat(0, 4);
    expect(riskExitReason(pos(), 99.9, s)).toBeNull();
    expect(riskExitReason(pos(), 50, s)).toBeNull();
    expect(riskExitReason(pos(), 104, s)).toBe('take_profit');
  });

  it('bleibt still bei kaputten Eingaben (kein Einstand, kein Preis, NaN)', () => {
    const s = strat(2, 4);
    expect(riskExitReason(pos({ avgEntry: 0 }), 100, s)).toBeNull();
    expect(riskExitReason(pos(), 0, s)).toBeNull();
    expect(riskExitReason(pos(), Number.NaN, s)).toBeNull();
    expect(riskExitReason(pos({ avgEntry: Number.NaN }), 100, s)).toBeNull();
  });
});

describe('riskExitReason — gespeicherte Level der Position haben Vorrang', () => {
  it('nutzt pos.stopLoss/pos.takeProfit statt der heutigen Prozente', () => {
    // Position wurde mit 5 %/10 % eröffnet; der User stellt danach auf 2 %/4 %
    const opened = pos({ stopLoss: 95, takeProfit: 110 });
    const nowStrategy = strat(2, 4);
    // 97 wäre nach HEUTIGEN Prozenten ein Stop (−3 %), nach dem gespeicherten
    // Level aber nicht — die Position behält ihre Einstiegs-Vereinbarung.
    expect(riskExitReason(opened, 97, nowStrategy)).toBeNull();
    expect(riskExitReason(opened, 95, nowStrategy)).toBe('stop_loss');
    // 105 wäre nach heutigen Prozenten Take-Profit, das Level sagt 110
    expect(riskExitReason(opened, 105, nowStrategy)).toBeNull();
    expect(riskExitReason(opened, 110, nowStrategy)).toBe('take_profit');
  });

  it('mischt sauber: gespeicherter Stop + Prozent-Take, wenn nur eins gesetzt ist', () => {
    const s = strat(2, 4);
    const onlyStop = pos({ stopLoss: 90, takeProfit: null });
    expect(riskExitReason(onlyStop, 97, s)).toBeNull(); // Level 90 schlägt −2 %
    expect(riskExitReason(onlyStop, 90, s)).toBe('stop_loss');
    expect(riskExitReason(onlyStop, 104, s)).toBe('take_profit'); // Prozent-Take greift
  });

  it('ignoriert unbrauchbare Level (0/negativ/NaN) und fällt auf Prozente zurück', () => {
    const s = strat(2, 4);
    expect(riskExitReason(pos({ stopLoss: 0 }), 98, s)).toBe('stop_loss');
    expect(riskExitReason(pos({ stopLoss: -5 }), 98, s)).toBe('stop_loss');
    expect(riskExitReason(pos({ takeProfit: Number.NaN }), 104, s)).toBe('take_profit');
  });
});
