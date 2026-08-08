/**
 * Journal-These: Der Satz ist eine ZWEITE DARSTELLUNG der eingefrorenen
 * Fakten — er darf nichts hinzuerfinden und bei dünnem Altbestand (Einträge
 * vor M12-Vollausbau) nicht lügen, sondern nur kürzer werden.
 */
import { describe, expect, it } from 'vitest';
import { journalThese } from '../src/journalText.js';

describe('journalThese', () => {
  it('Konfluenz-Einstieg mit Stimmen, Prognose und Regime', () => {
    const s = journalThese({
      art: 'entry',
      side: 'buy',
      source: 'engine',
      signalContext: {
        typ: 'konfluenz',
        votes: { rsi: 'hold', macd: 'buy', bollinger: 'hold' },
        konfluenz: 2,
        minKonfluenz: 2,
        forecast: { dir: 'up', weight: 0.6 },
        regime: 'trend',
      },
    });
    expect(s).toBe(
      'Einstieg long, weil die Konfluenz 2/2 erreicht war (MACD kauft) und die Prognose aufwärts zeigte (Gewicht 0,60) — Regime trend.',
    );
  });

  it('Regelbaum-Short-Einstieg', () => {
    expect(
      journalThese({
        art: 'entry',
        side: 'sell',
        source: 'engine',
        signalContext: { typ: 'regelbaum', regime: 'stress' },
      }),
    ).toBe('Einstieg short, weil der Regelbaum ein Signal gab — Regime stress.');
  });

  it('Exit über den Stop-Loss mit negativem Ergebnis (deutsches Format)', () => {
    const s = journalThese({ art: 'exit', side: 'sell', riskExit: 'stop_loss', pnl: -12.3 });
    expect(s).toBe('Position geschlossen über den Stop-Loss — Ergebnis −12,30 $.');
  });

  it('Short-Eindeckung am Signal', () => {
    const s = journalThese({
      art: 'exit',
      side: 'buy',
      source: 'engine',
      pnl: 4.2,
      signalContext: { typ: 'konfluenz', konfluenz: 2, regime: 'trend' },
    });
    expect(s).toBe('Short eingedeckt am Signal (Konfluenz 2) — Ergebnis +4,20 $ (Regime trend).');
  });

  it('manueller Trade bleibt als solcher erkennbar', () => {
    expect(journalThese({ art: 'entry', side: 'buy', source: 'manual' })).toBe(
      'Einstieg long — von Hand ausgelöst.',
    );
    expect(journalThese({ art: 'exit', side: 'sell', source: 'manual', pnl: 1 })).toBe(
      'Position geschlossen von Hand — Ergebnis +1,00 $.',
    );
  });

  it('Nachkauf wird benannt', () => {
    const s = journalThese({
      art: 'entry',
      side: 'buy',
      source: 'engine',
      nachkauf: true,
      signalContext: { typ: 'konfluenz', konfluenz: 3, votes: { rsi: 'buy', macd: 'buy' } },
    });
    expect(s).toContain('Nachkauf long');
    expect(s).toContain('RSI kauft, MACD kauft');
  });

  it('alle Stimmen neutral wird ehrlich gesagt', () => {
    const s = journalThese({
      art: 'entry',
      side: 'buy',
      source: 'engine',
      signalContext: { typ: 'konfluenz', konfluenz: 1, votes: { rsi: 'hold', macd: 'hold' } },
    });
    expect(s).toContain('alle Indikatoren neutral');
  });

  it('leerer Altbestand ergibt einen kurzen, wahren Satz', () => {
    expect(journalThese({ art: 'entry', side: 'buy' })).toBe('Einstieg long.');
    expect(journalThese({ art: 'exit', side: 'sell' })).toBe('Position geschlossen am Signal.');
  });
});
