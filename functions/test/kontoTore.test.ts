/**
 * Konto-Tore für Order-Pfade außerhalb des Scans (Audit 13.08., H2/H3).
 *
 * Der Befund: Der Scan prüfte Notbremse und Abgleich-Sperre vor jedem
 * Einstieg — momentumRun (Momentum-Depot + Kern-Sockel) kannte beides
 * nicht, die Handeingabe kannte die Bremse, aber weder Abgleich-Sperre
 * noch Positionslimit, und reichte obendrein die UNGEKLAMMERTE Strategie
 * an den Broker.
 *
 * Teil 1 testet die pure Tor-Entscheidung, Teil 2 hält die Verdrahtung in
 * momentumRun und trade fest — gegen die Fehlerklasse „Tor existiert, nur
 * ein Pfad läuft dran vorbei", die dieser Befund exakt war.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('Konto-Tore — die Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const momentum = readFileSync(join(hier, '../src/scheduled/momentumRun.ts'), 'utf8');
  const trade = readFileSync(join(hier, '../src/callable/trade.ts'), 'utf8');

  it('momentumRun: BEIDE Rebalancing-Pfade (Wallet + Sockel) fragen die Tore', () => {
    expect(momentum.match(/kontoTore\(userDoc, clamped, now\)/g)?.length).toBe(2);
    // Käufe stehen unter Tor und Positionslimit — zweimal (Wallet + Sockel).
    expect(momentum.match(/if \(tore\.einstieg\) continue;/g)?.length).toBe(2);
    expect(momentum.match(/if \(offenZahl >= posLimit\) continue;/g)?.length).toBe(2);
    // Ein Tor VERSCHIEBT das Rebalancing, es streicht es nicht: Der
    // lastRebalance-Stempel bleibt bei gesperrten Käufen stehen.
    expect(momentum.match(/einstiegGesperrt: tore\.einstieg/g)?.length).toBe(2);
  });

  it('trade: Handeingabe läuft geklemmt und durch dieselben Tore', () => {
    expect(trade).toContain('clampStrategyRisk(strategy)');
    // Der Broker bekommt die GEKLEMMTE Strategie — nicht mehr das rohe Profil.
    expect(trade).toContain('\n    clamped,');
    expect(trade).not.toContain('\n    strategy,');
    expect(trade).toContain('kontoTore(userSnap, clamped');
    expect(trade).toContain('maxOpenPositions(clamped)');
    expect(trade).toContain('offenAktiv >= limit');
  });
});
