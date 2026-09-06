/**
 * Konto-Tore für Order-Pfade außerhalb des Scans (Audit 13.08., H2/H3).
 *
 * Der Befund: Der Scan prüfte Notbremse und Abgleich-Sperre vor jedem
 * Einstieg — momentumRun (Momentum-Depot + Kern-Sockel) kannte beides
 * nicht, die Handeingabe kannte die Bremse, aber weder Abgleich-Sperre
 * noch Positionslimit, und reichte obendrein die UNGEKLAMMERTE Strategie
 * an den Broker.
 *
 * Getestet wird die pure Tor-Entscheidung. Die Verdrahtung (welcher
 * Order-Pfad die Tore fragt) gehört seit dem Rückbau der Handelsplattform
 * dem Engine-Takt — die alten Pfade (Handeingabe, Momentum-Lauf) gibt es
 * nicht mehr.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type Strategy } from '../../shared/src/index.js';
import { abgleichSperreAusVermerk, kontoTore } from '../src/core/kontoTore.js';

const jetzt = new Date('2026-08-13T14:00:00.000Z');
const stub = (m: Record<string, unknown>): { get(f: string): unknown } => ({
  get: (f: string) => m[f],
});
const strat = (): Strategy => {
  const s = structuredClone(DEFAULT_STRATEGY);
  s.engine.dailyLossLimitPct = 5;
  return s;
};

describe('kontoTore — die pure Entscheidung', () => {
  it('lässt ein sauberes Konto durch', () => {
    const t = kontoTore(stub({ 'risk.vortagEquity': 10_000 }), strat(), jetzt);
    expect(t.handel).toBeNull();
    expect(t.einstieg).toBeNull();
  });

  it('sperrt JEDEN Handel während eines Resets', () => {
    const t = kontoTore(
      stub({ 'risk.resetLaeuftSeit': '2026-08-13T13:58:00.000Z' }),
      strat(),
      jetzt,
    );
    expect(t.handel).toBe('reset_laeuft');
  });

  it('sperrt Einstiege, wenn die Notbremse heute ausgelöst ist', () => {
    const t = kontoTore(
      stub({
        'risk.vortagEquity': 10_000,
        'risk.breakerAusgeloestAm': jetzt.toISOString(),
      }),
      strat(),
      jetzt,
    );
    expect(t.einstieg).toBe('breaker_aktiv');
    expect(t.handel).toBeNull(); // Verkäufe bleiben möglich
  });

  it('sperrt Einstiege bei frischem Fehlbestand oder grober Cash-Abweichung', () => {
    const frisch = { at: '2026-08-13T13:55:00.000Z' };
    expect(
      kontoTore(stub({ 'risk.abgleich': { ...frisch, fehlbestand: 2 } }), strat(), jetzt).einstieg,
    ).toBe('abgleich_drift');
    expect(
      kontoTore(
        stub({ 'risk.abgleich': { ...frisch, fehlbestand: 0, konto: { zustand: 'grob' } } }),
        strat(),
        jetzt,
      ).einstieg,
    ).toBe('abgleich_drift');
  });
});

describe('abgleichSperreAusVermerk — Spiegel der Live-Entscheidung', () => {
  const at = '2026-08-13T13:55:00.000Z';

  it('Fremdbestand und kleine Drift sperren NICHT', () => {
    expect(abgleichSperreAusVermerk({ at, fehlbestand: 0, fremdbestand: 3 }, jetzt)).toBe(false);
    expect(
      abgleichSperreAusVermerk({ at, fehlbestand: 0, konto: { zustand: 'drift' } }, jetzt),
    ).toBe(false);
  });

  it('ein alter Vermerk sperrt nicht — der Live-Abgleich meldete kein_broker', () => {
    expect(
      abgleichSperreAusVermerk({ at: '2026-08-01T00:00:00.000Z', fehlbestand: 5 }, jetzt),
    ).toBe(false);
  });

  it('ohne Vermerk oder mit Unlesbarem: keine Sperre', () => {
    expect(abgleichSperreAusVermerk(undefined, jetzt)).toBe(false);
    expect(abgleichSperreAusVermerk({ fehlbestand: 5 }, jetzt)).toBe(false);
  });
});
