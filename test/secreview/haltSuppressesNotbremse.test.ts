/**
 * SECREVIEW #2 — `checkHalt` kehrt bei JEDEM aktiven Halt sofort zurück
 * (risk/limits.ts L391). Ein manueller HALT (Datei), ein reconcile- oder
 * errors-Halt schaltet damit die Tages-Notbremse UND die Drawdown-Sperre ab:
 * Die Positionen laufen weiter, obwohl der Tag −5 % oder das Konto −15 % vom
 * Hoch steht. Regel laut ARCHITEKTUR §5.3/5.4: Halt blockiert nur Einstiege;
 * „Tages-Notbremse: ab diesem Tagesverlust alles glattstellen".
 *
 * Diese Tests SCHLAGEN FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.ts';
import { checkHalt } from '../../src/risk/limits.ts';
import type { AccountView, HaltState } from '../../src/core/types.ts';

const risk = parseConfig({ universe: { symbols: ['AAPL'] } }).risk; // maxDailyLossPct 2, maxDrawdownPct 10

function account(equity: number, dayStart: number, peak: number): AccountView {
  return { equity, cash: equity, dayStartEquity: dayStart, peakEquity: peak, dayTradeCount: 0, patternDayTrader: false };
}

describe('secreview: aktiver Halt schaltet Notbremse/Drawdown ab', () => {
  for (const reason of ['manual', 'reconcile', 'errors'] as const) {
    it(`Halt '${reason}' aktiv + Tagesverlust −5 % ⇒ Notbremse (Exit aller Positionen) muss trotzdem auslösen`, () => {
      const halt: HaltState = { halted: true, reason, since: 1, until: null, note: 'HALT-Datei gesetzt' };
      const r = checkHalt({ account: account(95_000, 100_000, 100_000), halt, risk, now: 2, today: '2026-09-01', nextDay: '2026-09-02' });
      expect(r.triggered, `daily_loss wird bei Halt '${reason}' nicht mehr gemessen`).toBe(true);
      expect(r.halt.reason).toBe('daily_loss');
    });

    it(`Halt '${reason}' aktiv + Drawdown −15 % vom Hoch ⇒ Drawdown-Sperre muss trotzdem auslösen`, () => {
      const halt: HaltState = { halted: true, reason, since: 1, until: null, note: 'x' };
      const r = checkHalt({ account: account(85_000, 85_000, 100_000), halt, risk, now: 2, today: '2026-09-01', nextDay: '2026-09-02' });
      expect(r.triggered, `drawdown wird bei Halt '${reason}' nicht mehr gemessen`).toBe(true);
    });
  }
});
