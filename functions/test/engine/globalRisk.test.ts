/**
 * Die vier gemessenen Risiko-Blöcke sind GLOBAL, nicht Nutzersache
 * (`GLOBAL_RISK_FELDER` in functions/src/engine/config.ts).
 *
 * Warum das ein eigener Wächter ist: Auf der Plattform kommt `risk`
 * ausschließlich aus `settings.auto` des Nutzers — der ganze `risk`-Block des
 * globalen Docs wird verworfen. Für `volTarget`, `tiers`, `wiederaufbau` und
 * `cashParking` wäre das fatal still: Der Schalter stünde in
 * `config/platform.yaml`, käme über `sync-engine-config` nach
 * `meta/engineConfig` und hätte im Takt KEINE Wirkung — dieselbe Fehlerklasse
 * wie die tote Tagesbremse und die tote Short-Achse (docs/ARCHITEKTUR.md
 * §5a.15/16). Sie sind gemessene Systemgrößen wie der Champion und müssen zu
 * dem Lauf passen, der sie gemessen hat; ein Nutzer stellt sie nicht ein.
 *
 * `cashParking` kam am 13.09.2026 dazu: Das Parksymbol ist Infrastruktur der
 * PLATTFORM — der Takt lädt seine Bars einmal für alle Nutzer
 * (engine/sharedData.ts). Ein Parksymbol je Nutzer wäre ein Symbol, dessen
 * Bars niemand geladen hat.
 */
import { describe, expect, it } from 'vitest';
import { buildUserConfig, GLOBAL_RISK_FELDER, globalConfigRaw } from '../../src/engine/config.ts';

const doc = {
  risk: {
    // Nutzersache — muss verworfen werden:
    maxPositions: 99,
    riskPerTradePct: 3,
    // Gemessene Systemgrößen — müssen ankommen:
    volTarget: { enabled: true, zielVolPct: 12, halbwertszeitTage: 30, minFaktor: 0.5, maxFaktor: 1.5, minBeobachtungen: 90 },
    tiers: { basis: { maxDailyLossPct: 8 } },
    wiederaufbau: { enabled: true, maxAlterTage: 3 },
    cashParking: { enabled: true, symbol: 'BIL', bandPct: 5, bufferPct: 2 },
  },
};

describe('globale Risiko-Blöcke im Takt', () => {
  it('die vier Blöcke sind genau die genannten — wächst die Liste, ist das eine bewusste Entscheidung', () => {
    expect([...GLOBAL_RISK_FELDER]).toEqual(['volTarget', 'tiers', 'wiederaufbau', 'cashParking']);
  });

  it('kommen aus meta/engineConfig durch, der Rest von `risk` nicht', () => {
    const global = globalConfigRaw(doc);
    expect(global.risk).toEqual({
      volTarget: doc.risk.volTarget,
      tiers: doc.risk.tiers,
      wiederaufbau: doc.risk.wiederaufbau,
      cashParking: doc.risk.cashParking,
    });
    const { config } = buildUserConfig(global, { auto: { riskPerTradePct: 1, maxPositions: 2 } });
    // Nutzer gewinnt bei seinen Feldern …
    expect(config.risk.riskPerTradePct).toBe(1);
    expect(config.risk.maxPositions).toBe(2);
    // … und die globalen Blöcke stehen unverändert daneben.
    expect(config.risk.volTarget).toEqual(doc.risk.volTarget);
    expect(config.risk.tiers.basis.maxDailyLossPct).toBe(8);
    expect(config.risk.tiers.alpha.maxDailyLossPct).toBe(null); // null ⇒ der globale Wert gilt
    expect(config.risk.wiederaufbau).toEqual({ enabled: true, maxAlterTage: 3 });
    // Der Schalter des Geldmarkt-Parkens kommt aus platform.yaml an — ohne
    // diese Zeile wäre er im Takt tot (risk/parken.ts).
    expect(config.risk.cashParking).toEqual({ enabled: true, symbol: 'BIL', bandPct: 5, bufferPct: 2 });
  });

  it('WÄCHTER: dieselben Blöcke kommen auch aus `riskDefaults` durch — so schreibt der Sync sie', () => {
    // scripts/module/engineConfig.mjs schreibt `riskDefaults: cfg.risk`. Läse der Takt
    // nur `risk`, stünde der Schalter in config/platform.yaml und täte nichts.
    const global = globalConfigRaw({ riskDefaults: { ...doc.risk } });
    const { config } = buildUserConfig(global, undefined);
    expect(config.risk.volTarget).toEqual(doc.risk.volTarget);
    expect(config.risk.tiers.basis.maxDailyLossPct).toBe(8);
    expect(config.risk.wiederaufbau.enabled).toBe(true);
    expect(config.risk.cashParking.symbol).toBe('BIL');
    // Der Rest von `riskDefaults` bleibt draußen (Nutzersache).
    expect(config.risk.maxPositions).toBe(4);
    expect(config.risk.riskPerTradePct).toBe(0.5);
  });

  it('ohne globalen `risk`-Block bleibt alles bei den Schema-Vorgaben (aus)', () => {
    const { config } = buildUserConfig(globalConfigRaw({ timeframe: 1440, risk: { maxPositions: 9 } }), undefined);
    expect(config.risk.volTarget.enabled).toBe(false);
    expect(config.risk.wiederaufbau.enabled).toBe(false);
    expect(config.risk.cashParking).toEqual({ enabled: false, symbol: null, bandPct: 5, bufferPct: 2 });
    expect(config.risk.tiers).toEqual({
      alpha: { maxDailyLossPct: null, maxDrawdownPct: null },
      basis: { maxDailyLossPct: null, maxDrawdownPct: null },
    });
  });

  it('ein Nutzer kann die Blöcke nicht setzen — `settings.auto` reicht nur bekannte Felder weiter', () => {
    const { config } = buildUserConfig(globalConfigRaw(undefined), {
      auto: { volTarget: { enabled: true, zielVolPct: 90 }, tiers: { basis: { maxDailyLossPct: 40 } }, wiederaufbau: { enabled: true }, cashParking: { enabled: true, symbol: 'SHV' } },
    });
    expect(config.risk.volTarget.enabled).toBe(false);
    expect(config.risk.tiers.basis.maxDailyLossPct).toBe(null);
    expect(config.risk.wiederaufbau.enabled).toBe(false);
    // Ein eigenes Parksymbol je Nutzer wäre ein Symbol, dessen Bars der Takt nie lädt.
    expect(config.risk.cashParking).toEqual({ enabled: false, symbol: null, bandPct: 5, bufferPct: 2 });
  });
});
