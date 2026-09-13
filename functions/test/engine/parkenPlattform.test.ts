/**
 * Das Geldmarkt-Parken auf der PLATTFORM — die drei Stellen, ohne die der
 * Schalter in `config/platform.yaml` entweder tot oder gefährlich wäre.
 *
 *  1. **Der Schalter kommt an.** `risk.cashParking` ist eine gemessene
 *     Systemgröße, kein Nutzerfeld — er reist im globalen Teil
 *     (`GLOBAL_RISK_FELDER`, functions/src/engine/config.ts). Ohne diese
 *     Zeile stünde er im YAML, käme nach `meta/engineConfig` und hätte im
 *     Takt keine Wirkung; dieselbe Fehlerklasse wie die tote Tagesbremse
 *     (docs/ARCHITEKTUR.md §5a.16). Der Wächter dafür steht in
 *     `globalRisk.test.ts`; hier zählt die Folge daraus.
 *  2. **Die Bars werden geladen.** Der Takt holt sie EINMAL für alle Nutzer
 *     (`infrastrukturSymbole`, engine/sharedData.ts). Ohne Kurs schichtet
 *     `decide()` nicht um UND kann eine offene Parkposition nicht bewerten —
 *     sie ließe sich dann nie abbauen.
 *  3. **Keine Strategie erreicht das Parksymbol.** Das ist die
 *     sicherheitsrelevante Zeile: Führte eine Strategie dasselbe Symbol,
 *     lägen zwei Positionen mit zwei Herkünften darin — zwei Besitzer einer
 *     Menge, zwei Exit-Regeln, und §0.6 hätte keine logische Einheit mehr.
 *     `parseConfig` weist den Regelfall ab; hier wird der Weg geschlossen,
 *     auf dem das Universum NACH der Prüfung wächst (`universeWithBasis`
 *     hängt den Korb der Basis-Stufe aus `meta/champion` an — ein zweites
 *     Dokument, das über Nacht auseinanderlaufen kann).
 */
import { describe, expect, it } from 'vitest';
import { universeWithBasis } from '../../../src/core/basisTier.ts';
import { parseConfig } from '../../../src/core/config.ts';
import { setLogSink } from '../../../src/core/log.ts';
import type { ChampionFile } from '../../../src/optimize/promote.ts';
import { buildUserConfig, globalConfigRaw } from '../../src/engine/config.ts';
import { infrastrukturSymbole } from '../../src/engine/sharedData.ts';
import { buildStrategyFor, championFromDoc } from '../../src/engine/strategyFor.ts';

setLogSink(() => undefined);

const PARK = 'BIL';

const basisBlock = (symbols: string[]) => ({
  version: 1,
  strategy: 'regime_allocation',
  params: {},
  symbols,
  label: 'Basis',
  timeframe: 1440,
  pass: true,
  gates: [],
  measuredAt: 1,
  positionPct: 20,
});

describe('Geldmarkt-Parken auf der Plattform', () => {
  it('der Takt lädt das Parksymbol als Infrastruktur — auch bei enabled: false (Rückzug braucht den Kurs)', () => {
    const an = parseConfig({ universe: { symbols: ['SPY', 'IEF'] }, timeframe: 1440, risk: { cashParking: { enabled: true, symbol: PARK } } });
    expect(infrastrukturSymbole(an)).toEqual([PARK]);
    const aus = parseConfig({ universe: { symbols: ['SPY'] }, timeframe: 1440, risk: { cashParking: { enabled: false, symbol: PARK } } });
    expect(infrastrukturSymbole(aus)).toEqual([PARK]);
    // Ohne Parksymbol ändert sich bitgleich nichts.
    expect(infrastrukturSymbole(parseConfig({ universe: { symbols: ['SPY'] } }))).toEqual([]);
  });

  it('der globale Schalter erreicht die Nutzer-Config — sonst wäre `platform.yaml` an dieser Stelle tot', () => {
    const global = globalConfigRaw({
      universe: { symbols: ['SPY', 'IEF'] },
      timeframe: 1440,
      risk: { cashParking: { enabled: true, symbol: PARK, bandPct: 5, bufferPct: 2 }, maxPositions: 99 },
    });
    const { config } = buildUserConfig(global, { auto: { maxPositions: 3 } });
    expect(config.risk.cashParking).toEqual({ enabled: true, symbol: PARK, bandPct: 5, bufferPct: 2 });
    expect(config.risk.maxPositions).toBe(3);
    expect(infrastrukturSymbole(config)).toEqual([PARK]);
  });

  it('WÄCHTER: `strategyFor` gibt für das Parksymbol null — auch wenn der Basis-Korb es ins Universum trägt', () => {
    // Ohne Kandidatenpool prüft `basisStatus` den Korb nicht (core/basisTier.ts):
    // genau der Weg, auf dem ein Symbol ins Universum kommt, ohne je durch
    // `parseConfig` gegangen zu sein.
    const config = parseConfig({ universe: { symbols: ['SPY'] }, timeframe: 1440, risk: { cashParking: { enabled: true, symbol: PARK } } });
    const champion: ChampionFile = championFromDoc({ version: 1, updatedAt: 1, symbols: {}, noTrade: {}, basis: basisBlock(['SPY', PARK]) })!;
    const mitBasis = universeWithBasis(config, champion);
    expect(mitBasis.universe.symbols).toContain(PARK);

    const m = buildStrategyFor({ champion, config: mitBasis });
    expect(m.fn(PARK)).toBeNull();
    expect(m.tradable).not.toContain(PARK);
    expect(m.basisSymbols).not.toContain(PARK);
    expect(m.notes.join('\n')).toMatch(/BIL: Parksymbol der Treasury/);
    // Der Rest des Korbs handelt weiter — die Sicherung nimmt nur EIN Symbol heraus.
    expect(m.fn('SPY')?.source).toBe('basis');
  });

  it('ohne Parken bleibt `strategyFor` bitgleich wie vorher', () => {
    const config = parseConfig({ universe: { symbols: ['SPY', 'IEF'] }, timeframe: 1440 });
    const champion = championFromDoc({ version: 1, updatedAt: 1, symbols: {}, noTrade: {}, basis: basisBlock(['SPY', 'IEF']) })!;
    const m = buildStrategyFor({ champion, config });
    expect(m.tradable).toEqual(['SPY', 'IEF']);
    expect(m.notes.join('\n')).not.toMatch(/Parksymbol/);
  });
});
