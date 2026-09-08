import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/core/config.ts';
import { buildUserConfig, DEFAULT_UNIVERSE, globalConfigRaw, userRiskFrom } from '../../src/engine/config.ts';

describe('Config je Nutzer', () => {
  it('ohne meta/engineConfig und ohne Settings: eingebaute Defaults, Schema-Defaults im Risiko', () => {
    const { config, source } = buildUserConfig(globalConfigRaw(undefined), undefined);
    expect(source).toBe('default');
    expect(config.universe).toEqual({ assetClass: 'us_equity', symbols: [...DEFAULT_UNIVERSE], benchmark: 'SPY', maxSymbols: 30 });
    expect(config.timeframe).toBe(5);
    expect(config.broker.feed).toBe('iex');
    expect(config.engine.barGraceSec).toBe(20);
    expect(config.risk).toMatchObject({ riskPerTradePct: 0.5, maxPositionPct: 20, maxPositions: 4, maxDailyLossPct: 2, maxDrawdownPct: 10, allowShort: false });
    expect(config.strategy.allowWithoutChampion).toBe(false);
  });

  it('meta/engineConfig überschreibt Felder, risk/notify/paths werden verworfen, Fehlendes bleibt Default', () => {
    const global = globalConfigRaw({ timeframe: 15, risk: { maxPositions: 99 }, notify: { telegram: true }, paths: { home: '/x' }, strategy: { allowWithoutChampion: true } });
    expect(global.risk).toBeUndefined();
    expect(global.notify).toBeUndefined();
    expect(global.paths).toBeUndefined();
    const { config } = buildUserConfig(global, undefined);
    expect(config.timeframe).toBe(15);
    expect(config.universe.symbols).toEqual([...DEFAULT_UNIVERSE]);
    expect(config.risk.maxPositions).toBe(4);
    expect(config.strategy.allowWithoutChampion).toBe(true);
    expect(config.notify.telegram).toBe(false);
  });

  it('settings.auto: Risiko 1:1, Symbole als normalisierte Teilmenge des Universums', () => {
    const settings = { auto: { riskPerTradePct: 1, maxPositionPct: 25, maxPositions: 3, maxDailyLossPct: 3, maxDrawdownPct: 15, allowShort: true, symbols: ['aapl', ' msft ', 'XYZ', 'AAPL'] } };
    const { config, source } = buildUserConfig(globalConfigRaw(undefined), settings);
    expect(source).toBe('auto');
    expect(config.risk).toMatchObject({ riskPerTradePct: 1, maxPositionPct: 25, maxPositions: 3, maxDailyLossPct: 3, maxDrawdownPct: 15, allowShort: true });
    expect(config.universe.symbols).toEqual(['AAPL', 'MSFT']);
    expect(config.universe.benchmark).toBe('SPY');
  });

  it('settings.auto ohne Symbole ⇒ ganzes Universum; nur fremde Symbole ⇒ Einstiegssperre statt Abbruch', () => {
    expect(buildUserConfig(globalConfigRaw(undefined), { auto: {} }).config.universe.symbols).toEqual([...DEFAULT_UNIVERSE]);
    const fremd = buildUserConfig(globalConfigRaw(undefined), { auto: { symbols: ['XYZ'] } });
    expect(fremd.auswahlVeraltet).toBeTruthy();
    expect(fremd.config.universe.symbols).toEqual([...DEFAULT_UNIVERSE]);
  });

  it('settings.auto ungültig (maxPositions 0, riskPerTradePct 7) ⇒ ConfigError mit Feldpfad', () => {
    expect(() => buildUserConfig(globalConfigRaw(undefined), { auto: { maxPositions: 0 } })).toThrow(/risk\.maxPositions/);
    expect(() => buildUserConfig(globalConfigRaw(undefined), { auto: { riskPerTradePct: 7 } })).toThrow(ConfigError);
  });

  it('Alt-Felder aus settings.strategy werden abgeleitet (Drawdown-Default 10)', () => {
    const settings = { strategy: { engine: { riskPerTradePct: 1, maxPositionPct: 10, maxOpenPositions: 8, dailyLossLimitPct: 3, running: true }, signals: { allowShort: true } } };
    const { config, source } = buildUserConfig(globalConfigRaw(undefined), settings);
    expect(source).toBe('legacy');
    expect(config.risk).toMatchObject({ riskPerTradePct: 1, maxPositionPct: 10, maxPositions: 8, maxDailyLossPct: 3, maxDrawdownPct: 10, allowShort: true });
  });

  it('Alt-Felder werden in die Hülle geklemmt: riskPerTradePct 0 ⇒ Schema-Default, 100 Positionen ⇒ 50, 80 % Tagesverlust ⇒ 50', () => {
    const part = userRiskFrom({ strategy: { engine: { riskPerTradePct: 0, maxPositionPct: 0, maxOpenPositions: 100, dailyLossLimitPct: 80 }, signals: {} } });
    // Seit der Ableitung über `autoSettingsFromLegacy` (shared) kommt der Risiko-Teil
    // vollständig — die Voreinstellungen sind dieselben wie im Schema des Kerns.
    expect(part.risk).toEqual({ riskPerTradePct: 0.5, maxPositionPct: 20, maxPositions: 50, maxDailyLossPct: 50, maxDrawdownPct: 10, allowShort: false });
    const { config } = buildUserConfig(globalConfigRaw(undefined), { strategy: { engine: {}, signals: {} } });
    expect(config.risk.riskPerTradePct).toBe(0.5);
    expect(config.risk.allowShort).toBe(false);
  });

  it('Krypto-Universum: Nutzer-Symbole werden auf die kanonische Schreibweise gebracht', () => {
    const global = globalConfigRaw({ universe: { assetClass: 'crypto', symbols: ['BTC/USD', 'ETH/USD'] } });
    const { config } = buildUserConfig(global, { auto: { symbols: ['btcusd'] } });
    expect(config.universe.symbols).toEqual(['BTC/USD']);
    expect(config.universe.benchmark).toBeUndefined();
  });
});

/**
 * Seit das Universum nächtlich nach Liquidität gewählt wird, kann die
 * gespeicherte Symbolauswahl eines Nutzers veralten. Vorher warf
 * `buildUserConfig` dann einen `ConfigError` — und `tick.ts` schob den Nutzer
 * nach `failed`, also lief der Takt für ihn GAR NICHT: keine Exits, kein
 * Abgleich, keine Schutz-Stop-Prüfung. Wer nur TSLA gewählt hatte und TSLA
 * fiel heraus, hielt seine Position ohne jede Bewirtschaftung.
 */
describe('veraltete Symbolauswahl', () => {
  const global = globalConfigRaw({ universe: { assetClass: 'us_equity', symbols: ['SPY', 'AAPL'], benchmark: 'SPY' } });

  it('schneidet die Auswahl auf das Universum, solange etwas übrig bleibt', () => {
    const { config, auswahlVeraltet } = buildUserConfig(global, { auto: { symbols: ['AAPL', 'TSLA'] } });
    expect(config.universe.symbols).toEqual(['AAPL']);
    expect(auswahlVeraltet).toBeUndefined();
  });

  it('wirft NICHT, wenn gar nichts übrig bleibt — sonst stirbt der ganze Takt des Nutzers', () => {
    const { config, auswahlVeraltet } = buildUserConfig(global, { auto: { symbols: ['TSLA', 'NVDA'] } });
    expect(auswahlVeraltet, 'wird zur Einstiegssperre, nicht zum Abbruch').toContain('nicht mehr im Handelsuniversum');
    expect(config.universe.symbols, 'Daten, Abgleich und Exits brauchen ein Universum').toEqual(['SPY', 'AAPL']);
  });
});
