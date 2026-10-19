import { describe, expect, it } from 'vitest';
import { atrStufe, exitAtrProfil, exitAtrProfilSumme, type ExitAtrTrade } from '../src/exitAtrProfil.js';

const SEIT = '2026-10-12T21:15:00.000Z';

describe('atrStufe', () => {
  it('Grenzen gehören zur oberen Stufe; fehlend/kaputt ⇒ ohne', () => {
    expect(atrStufe(0.99)).toBe('unter1');
    expect(atrStufe(1)).toBe('1bis2');
    expect(atrStufe(2)).toBe('2bis3');
    expect(atrStufe(3)).toBe('3bis5');
    expect(atrStufe(5)).toBe('ab5');
    expect(atrStufe(undefined)).toBe('ohne');
    expect(atrStufe(null)).toBe('ohne');
    expect(atrStufe(0)).toBe('ohne');
    expect(atrStufe(Number.NaN)).toBe('ohne');
  });
});

describe('exitAtrProfil', () => {
  const t = (o: Partial<ExitAtrTrade>): ExitAtrTrade => ({ pnl: -10, at: '2026-10-15T15:00:00Z', assetClass: 'stocks_us', quelle: 'konfluenz', ...o });

  it('zählt je Klasse × Quelle × Grund × Stufe, Gewinne getrennt', () => {
    const p = exitAtrProfil([
      t({ riskExit: 'stop_loss', einstiegAtrPct: 4.2 }),
      t({ riskExit: 'stop_loss', einstiegAtrPct: 0.8 }),
      t({ riskExit: 'take_profit', pnl: 20, einstiegAtrPct: 2.5 }),
      t({ pnl: 5 }), // Signal-Schluss, Altbestand ohne ATR
    ], SEIT);
    expect(p['stocks_us']?.['konfluenz']?.['stop_loss']).toEqual({ n: 2, wins: 0, stufen: { '3bis5': 1, unter1: 1 } });
    expect(p['stocks_us']?.['konfluenz']?.['take_profit']).toEqual({ n: 1, wins: 1, stufen: { '2bis3': 1 } });
    expect(p['stocks_us']?.['konfluenz']?.['signal']).toEqual({ n: 1, wins: 1, stufen: { ohne: 1 } });
  });

  it('pnl genau 0 ist kein Gewinn', () => {
    const p = exitAtrProfil([t({ pnl: 0 }), t({ pnl: 0.01 })], SEIT);
    expect(p['stocks_us']?.['konfluenz']?.['signal']).toMatchObject({ n: 2, wins: 1 });
  });

  it('Fenster: vor der Grenze oder ohne Zeitstempel zählt nicht', () => {
    const p = exitAtrProfil([t({ at: '2026-10-12T21:14:59Z' }), t({ at: null }), t({ at: SEIT })], SEIT);
    expect(p['stocks_us']?.['konfluenz']?.['signal']?.n).toBe(1);
  });

  it('fehlende Klasse/Quelle ⇒ unbekannt, nicht verworfen', () => {
    const p = exitAtrProfil([t({ assetClass: null, quelle: undefined })], SEIT);
    expect(p['unbekannt']?.['unbekannt']?.['signal']?.n).toBe(1);
  });

  it('keine Beträge im Ergebnis (öffentlich unter jeder Konten-Schwelle)', () => {
    const p = exitAtrProfil([t({ riskExit: 'stop_loss', pnl: -1234.56, einstiegAtrPct: 3 })], SEIT);
    expect(JSON.stringify(p)).not.toContain('1234');
  });
});

describe('exitAtrProfilSumme', () => {
  it('addiert Konten ohne Doppelzählung und verändert die Teile nicht', () => {
    const a = exitAtrProfil([{ pnl: -1, at: SEIT, assetClass: 'stocks_us', quelle: 'konfluenz', riskExit: 'stop_loss', einstiegAtrPct: 4 }], SEIT);
    const b = exitAtrProfil([
      { pnl: 2, at: SEIT, assetClass: 'stocks_us', quelle: 'konfluenz', riskExit: 'stop_loss', einstiegAtrPct: 3.5 },
      { pnl: 2, at: SEIT, assetClass: 'crypto', quelle: 'konfluenz', riskExit: 'trailing_stop' },
    ], SEIT);
    const vorher = JSON.stringify(a);
    const s = exitAtrProfilSumme([a, b]);
    expect(s['stocks_us']?.['konfluenz']?.['stop_loss']).toEqual({ n: 2, wins: 1, stufen: { '3bis5': 2 } });
    expect(s['crypto']?.['konfluenz']?.['trailing_stop']).toEqual({ n: 1, wins: 1, stufen: { ohne: 1 } });
    expect(JSON.stringify(a)).toBe(vorher);
    expect(exitAtrProfilSumme([])).toEqual({});
  });
});
