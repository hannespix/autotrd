/**
 * `broker.adjustment` — Bereinigung der Tagesbars (Red-Team 09.09.2026, M7).
 *
 * Der Fehler, den diese Tests verhindern: ein STILLER Wechsel der Datenbasis.
 * Der Default muss `raw` bleiben — jede bestehende Config, jeder bestehende
 * Bars-Cache und der Plattform-Takt rechnen sonst plötzlich auf anderen
 * Kursen, ohne dass es jemand gemessen hätte. Und Optimierer und Plattform
 * müssen auf DENSELBEN Bars rechnen (CLAUDE.md §0.1): Was das Doc
 * `meta/engineConfig` nicht trägt, darf die Plattform-Config nicht setzen.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — .mjs ohne Typen
import { engineConfigDocFrom } from '../../scripts/module/engineConfig.mjs';
import { BAR_ADJUSTMENTS } from '../../src/alpaca/types.ts';
import { ConfigError, parseConfig } from '../../src/core/config.ts';

const minimal = { universe: { symbols: ['TLT', 'SPY'] } };
const yamlConfig = (name: string) => parseConfig(parseYaml(readFileSync(new URL(`../../config/${name}`, import.meta.url), 'utf8')));

describe('broker.adjustment', () => {
  it('Default ist raw — ohne broker-Block wie mit broker-Block ohne den Schalter', () => {
    expect(parseConfig(minimal).broker.adjustment).toBe('raw');
    expect(parseConfig({ ...minimal, broker: { feed: 'sip' } }).broker.adjustment).toBe('raw');
    expect(parseConfig({ ...minimal, broker: { mode: 'paper', feed: 'iex' } }).broker).toEqual({ mode: 'paper', feed: 'iex', adjustment: 'raw' });
  });

  it('nimmt genau die Alpaca-Werte an und lehnt alles andere mit Feldpfad ab', () => {
    expect([...BAR_ADJUSTMENTS]).toEqual(['raw', 'split', 'dividend', 'all']);
    for (const adj of BAR_ADJUSTMENTS) expect(parseConfig({ ...minimal, broker: { adjustment: adj } }).broker.adjustment).toBe(adj);
    expect(() => parseConfig({ ...minimal, broker: { adjustment: 'total_return' } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...minimal, broker: { adjustment: true } })).toThrow(/broker\.adjustment/);
  });

  it('die Vorlage config.example.yaml steht auf raw', () => {
    expect(yamlConfig('config.example.yaml').broker.adjustment).toBe('raw');
  });

  it('Plattform-Config und meta/engineConfig tragen dieselbe Bereinigung — sonst misst der Optimierer andere Bars, als die Engine handelt', () => {
    const cfg = yamlConfig('platform.yaml');
    const doc = engineConfigDocFrom(cfg) as { broker: { adjustment?: unknown } };
    // Seit der Basis-Stufe trägt das Doc den Schalter (scripts/module/engineConfig.mjs);
    // ein Doc ohne das Feld hieße raw — der Takt darf nie stumm auf andere Bars wechseln.
    const imDoc = doc.broker.adjustment ?? 'raw';
    expect(doc.broker.adjustment).toBe(cfg.broker.adjustment);
    expect(imDoc, 'platform.yaml setzt eine Bereinigung, die meta/engineConfig nicht überträgt').toBe(cfg.broker.adjustment);
  });
});
