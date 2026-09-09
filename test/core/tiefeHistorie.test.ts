/**
 * Tiefe Historie nur dort, wo sie billig ist.
 *
 * Die alte pauschale Obergrenze (2000 Kalendertage) stand einer Messung im
 * Weg, die einen Bärenmarkt ins Fenster holen soll: Bis November 2022 zurück
 * enthielt das Fenster AUSSCHLIESSLICH einen Bullenmarkt, und einem
 * defensiven System dort vorzuwerfen, dass es den Markt nicht schlägt, misst
 * nichts. Die Grenze hatte aber einen echten Grund — nur den falschen
 * Geltungsbereich: 4000 Tage sind auf Tagesbars rund 83 000 Bars, auf
 * 5-Minuten-Bars rund 9 Millionen.
 *
 * Also hängt sie jetzt am Zeitrahmen. Der teure Fehler wäre, sie ganz
 * fallenzulassen: Der Lauf stürbe erst NACH dem Datenladen am Speicher, also
 * spät, teuer und ohne verwertbare Meldung.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, INTRADAY_LOOKBACK_MAX, parseConfig } from '../../src/core/config.ts';

function cfg(timeframe: number, lookbackDays: number): unknown {
  return {
    universe: { assetClass: 'us_equity', symbols: ['AAA'] },
    timeframe,
    optimizer: { lookbackDays, isDays: 365, oosDays: 90, stepDays: 90, holdoutDays: 180 },
  };
}

describe('lookbackDays — Tiefe nach Zeitrahmen', () => {
  it('Tagesbars dürfen tief zurück (der ganze Zweck der Änderung)', () => {
    expect(parseConfig(cfg(1440, 2900)).optimizer.lookbackDays).toBe(2900);
  });

  it('Intraday bleibt bei der alten Grenze', () => {
    expect(parseConfig(cfg(5, INTRADAY_LOOKBACK_MAX)).optimizer.lookbackDays).toBe(INTRADAY_LOOKBACK_MAX);
    expect(() => parseConfig(cfg(5, INTRADAY_LOOKBACK_MAX + 1))).toThrow(ConfigError);
    expect(() => parseConfig(cfg(60, 2900))).toThrow(ConfigError);
  });

  it('die Meldung nennt Zeitrahmen, Wert und den Ausweg — nicht nur „ungültig"', () => {
    try {
      parseConfig(cfg(5, 2900));
      throw new Error('hätte werfen müssen');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('2900');
      expect(m).toContain('5');
      expect(m).toContain('Tagesbars');
    }
  });

  it('die harte Obergrenze gilt weiterhin für ALLE Zeitrahmen', () => {
    // Ohne sie wäre „viel Historie" nach oben offen; 4000 Tage sind rund 11 Jahre.
    expect(() => parseConfig(cfg(1440, 4001))).toThrow(ConfigError);
    expect(parseConfig(cfg(1440, 4000)).optimizer.lookbackDays).toBe(4000);
  });
});
