/**
 * Echte Gebühren in den Statistiken (Audit 13.08., Hochbefund 4).
 *
 * Der Befund: Attribution, Kostenprofil und Best-Practice-Bilanz schätzten
 * die Gebühren als `notional × feeRate × 2`, obwohl der Broker seit dem
 * 04.08. die ECHT verbuchte Gebühr an jeden Trade schreibt. Auf den
 * geschätzten Zahlen stand die Live-Reife (Profit-Faktor NACH Kosten).
 *
 * `roundtripGebuehr` ist jetzt die EINE Quelle: echt, wo das fee-Feld
 * steht; die Schätzung trägt nur noch den Altbestand.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { costProfile, engineBilanz, roundtripGebuehr } from '../src/index.js';

describe('roundtripGebuehr — die Kaskade, ehrlichste zuerst', () => {
  it('Stufe 1: echte Exit-Gebühr + Einstiegs-Seite auf echter Basis', () => {
    // Exit real 1,50 $; Einstieg: 900 $ Einstand × 0,001 je Seite = 0,90 $.
    expect(
      roundtripGebuehr({ fee: 1.5, entryNotional: 900, feeRate: 0.001, notional: 1_200 }),
    ).toBeCloseTo(2.4, 10);
  });

  it('Stufe 2: ohne Einstands-Basis wird die echte Exit-Gebühr gespiegelt', () => {
    expect(roundtripGebuehr({ fee: 1.5, notional: 1_200, feeRate: 0.001 })).toBe(3);
  });

  it('Stufe 3: Altbestand ohne fee rechnet wie bisher', () => {
    expect(roundtripGebuehr({ notional: 1_000, feeRate: 0.0015 })).toBe(3);
  });

  it('Stufe 4: ohne Belastbares null — lieber raus als geraten', () => {
    expect(roundtripGebuehr({})).toBeNull();
    expect(roundtripGebuehr({ notional: 1_000 })).toBeNull();
    expect(roundtripGebuehr({ fee: Number.NaN, notional: 1_000 })).toBeNull();
  });
});

describe('die Statistiken rechnen mit der echten Gebühr', () => {
  it('costProfile: fees und roundTripPct kommen aus dem fee-Feld', () => {
    // Echter Fill: Rate je Seite real nur Kommission (fee 0,25 $ auf 1 000 $
    // Volumen) — die alte Schätzung hätte mit dem Modell-Satz 3 $ verbucht.
    const p = costProfile([
      { symbol: 'AAPL', pnl: 10, notional: 1_000, feeRate: 0.0015, fee: 0.25, entryNotional: 1_000 },
    ]);
    expect(p.fees).toBeCloseTo(1.75, 2); // 0,25 + 1 000 × 0,0015
    expect(p.roundTripPct).toBeCloseTo(0.175, 3); // realisiert, nicht nominell
    expect(p.grossPnl).toBeCloseTo(11.75, 2);
  });

  it('engineBilanz: dieselbe Quelle wie das Kostenprofil', () => {
    const b = engineBilanz([
      { pnl: 10, at: '2026-08-13T10:00:00Z', notional: 1_000, feeRate: 0.0015, fee: 0.25, entryNotional: 1_000 },
    ]);
    expect(b.fees).toBeCloseTo(1.75, 2);
  });
});

describe('echte Gebühren — die Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const q = (rel: string): string => readFileSync(join(hier, rel), 'utf8');

  it('die Schätzformel lebt NUR noch in roundtripGebuehr', () => {
    const portfolio = q('../src/portfolio.ts');
    // Genau ein Vorkommen: der Altbestands-Zweig in roundtripGebuehr selbst.
    expect(portfolio.match(/feeRate \* 2/g)?.length).toBe(1);
    expect(q('../src/bestPractice.ts')).not.toMatch(/feeRate \* 2/);
  });

  it('snapshotEquity reicht fee und entryNotional an die Statistiken durch', () => {
    const snap = q('../../functions/src/scheduled/snapshotEquity.ts');
    expect(snap).toContain("t.get('fee')");
    expect(snap).toContain('entryNotional: qty * entryPrice');
  });
});
