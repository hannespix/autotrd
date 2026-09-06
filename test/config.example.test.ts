import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, parseConfig } from '../src/core/config.ts';

const PATH = fileURLToPath(new URL('../config/config.example.yaml', import.meta.url));
const text = readFileSync(PATH, 'utf8');
const raw: unknown = parseYaml(text);

/** zod-v4-Def (öffentlich über `.def`): Wrapper werden ausgepackt, Objekte rekursiv besucht. */
interface Def {
  type: string;
  innerType?: unknown;
  shape?: Record<string, unknown>;
}
const defOf = (schema: unknown): Def => (schema as { def: Def }).def;

function leafPaths(schema: unknown, prefix: string[] = []): string[] {
  let d = defOf(schema);
  while ((d.type === 'default' || d.type === 'optional' || d.type === 'nullable') && d.innerType !== undefined) {
    d = defOf(d.innerType);
  }
  if (d.type === 'object' && d.shape) {
    return Object.entries(d.shape).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
  }
  return [prefix.join('.')];
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

describe('config/config.example.yaml', () => {
  it('lädt fehlerfrei mit parseConfig und trägt die vorgesehenen Startwerte', () => {
    const cfg = parseConfig(raw);
    expect(cfg.broker).toEqual({ mode: 'paper', feed: 'iex' });
    expect(cfg.universe.assetClass).toBe('us_equity');
    expect(cfg.universe.symbols).toEqual(['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AMD', 'TSLA']);
    expect(cfg.universe.benchmark).toBe('SPY');
    expect(cfg.timeframe).toBe(5);
    expect(cfg.strategy.id).toBe('trend_donchian');
    expect(cfg.strategy.allowWithoutChampion).toBe(false);
    expect(cfg.notify.telegram).toBe(false);
    expect(cfg.status.httpPort).toBe(8787);
    expect(cfg.paths.home).toBe('./var');
  });

  it('entspricht in risk/optimizer/costs/engine den Schema-Defaults (Startwerte = Defaults)', () => {
    const cfg = parseConfig(raw);
    const defaults = parseConfig({ universe: { symbols: ['SPY'] } });
    expect(cfg.risk).toEqual(defaults.risk);
    expect(cfg.session).toEqual(defaults.session);
    expect(cfg.optimizer).toEqual(defaults.optimizer);
    expect(cfg.costs).toEqual(defaults.costs);
    expect(cfg.engine).toEqual(defaults.engine);
  });

  it('nennt JEDE Option des Schemas ausdrücklich (nichts fällt still auf einen Default zurück)', () => {
    const paths = leafPaths(ConfigSchema);
    expect(paths.length).toBeGreaterThan(40);
    const missing = paths.filter((p) => getPath(raw, p) === undefined);
    expect(missing).toEqual([]);
  });

  it('jede gesetzte Option trägt einen Kommentar (davor oder in der Zeile)', () => {
    const lines = text.split('\n');
    const uncommented: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = /^\s*([A-Za-z_]+):(.*)$/.exec(line);
      if (!m) continue;
      if (m[2]!.trim() === '') continue; // Container-Schlüssel: Kommentar steht bei den Kindern
      if (line.includes(' #')) continue;
      let j = i - 1;
      while (j >= 0 && lines[j]!.trim() === '') j--;
      const prev = j >= 0 ? lines[j]!.trim() : '';
      if (!prev.startsWith('#')) uncommented.push(`${i + 1}: ${line.trim()}`);
    }
    expect(uncommented).toEqual([]);
  });
});
