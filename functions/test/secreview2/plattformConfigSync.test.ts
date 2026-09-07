/**
 * SECREVIEW2 #8 — `scripts/sync-engine-config.mjs` schreibt `engine: cfg.engine` und `feed: cfg.broker.feed`
 * (Top-Level) nach `meta/engineConfig`. Der Takt liest das Doc über `globalConfigRaw` (config.ts L37):
 *   (a) `engine.barGraceSec` aus config/platform.yaml ist 4 — überschreibt den Functions-Default 20,
 *       den DEFAULT_GLOBAL_CONFIG (config.ts L18-25) ausdrücklich begründet: Mit 4 s gilt ein Bucket im
 *       Takt zur vollen Minute als geschlossen, bevor Alpaca die letzte Minutenbar per REST liefert —
 *       der 5-Minuten-Bucket wird aus vier Minuten aggregiert und (lastBarAt) nie korrigiert.
 *   (b) `feed` steht Top-Level, das Schema kennt nur `broker.feed`: zod verwirft den Schlüssel still.
 *       Steht platform.yaml (Optimierer!) auf `sip`, handelt die Engine weiter auf `iex` — genau der
 *       „Backtest misst etwas anderes als live"-Fehler aus CLAUDE.md §2.
 *
 * Der Test führt das echte Skript mit --dry-run aus und speist sein Ergebnis in den Takt-Leser.
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildUserConfig, DEFAULT_GLOBAL_CONFIG, globalConfigRaw } from '../../src/engine/config.ts';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function syncDoc(configPfad: string): Record<string, unknown> {
  const out = execFileSync(process.execPath, ['scripts/sync-engine-config.mjs', '--config', configPfad, '--dry-run'], { cwd: wurzel, encoding: 'utf8' });
  const json = out.slice(0, out.lastIndexOf('}') + 1);
  return JSON.parse(json) as Record<string, unknown>;
}

describe('secreview2: meta/engineConfig aus config/platform.yaml', () => {
  const doc = syncDoc('config/platform.yaml');

  it('barGraceSec darf nach dem Sync nicht unter den Functions-Default (20 s) fallen', () => {
    const { config } = buildUserConfig(globalConfigRaw(doc), undefined);
    const def = (DEFAULT_GLOBAL_CONFIG.engine as { barGraceSec: number }).barGraceSec;
    expect(def).toBe(20);
    expect(config.engine.barGraceSec, 'platform.yaml engine.barGraceSec (4) überschreibt die Takt-Karenz').toBeGreaterThanOrEqual(def);
  });

  it('der Feed des Optimierers muss beim Takt ankommen (Top-Level `feed` wird verworfen)', () => {
    const sip = { ...doc, feed: 'sip' }; // so sähe das Doc aus, stünde platform.yaml auf sip
    const { config } = buildUserConfig(globalConfigRaw(sip), undefined);
    expect(config.broker.feed, 'Engine handelt auf iex, obwohl der Optimierer sip misst').toBe('sip');
  });
});
