/**
 * Am Anfang des Kalenders gibt es keinen „vorherigen Handelstag".
 *
 * Lauf 27 (09.09.2026): Der Kalender begann am selben Tag wie die erste Bar;
 * der Rückwärtsgang um vier Handelstage (PDT-Fenster) warf, und alle vier
 * Strategien meldeten „Kein Handelstag in 30 Tagen vor 2020-09-03".
 */
import { describe, expect, it } from 'vitest';
import { prevTradingDay, prevTradingDayOrNull } from '../../src/core/time.ts';

const tag = (d: string) => [d, { date: d, open: '09:30', close: '16:00' }] as const;
const cal = new Map([tag('2026-09-03'), tag('2026-09-04')]);

describe('prevTradingDayOrNull', () => {
  it('liefert null, wo der Kalender beginnt — statt zu werfen', () => {
    expect(prevTradingDayOrNull('2026-09-04', 'us_equity', cal)).toBe('2026-09-03');
    expect(prevTradingDayOrNull('2026-09-03', 'us_equity', cal)).toBeNull();
  });

  it('prevTradingDay wirft weiterhin — für Aufrufer, die einen Tag brauchen', () => {
    expect(() => prevTradingDay('2026-09-03', 'us_equity', cal)).toThrow(/Kein Handelstag in 30 Tagen vor 2026-09-03/);
  });
});
