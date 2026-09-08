/**
 * Die Verdrahtung der Auswahl — der Teil, den drei Mutationen des Red-Teams
 * unbemerkt überlebt haben.
 *
 * Ohne diese Tests hätte man `cfg = mitUniverse(roh, gewaehlt)` in
 * `sync-engine-config.mjs` durch `cfg = roh` ersetzen können, ohne dass ein
 * einziger von 1965 Tests rot wird — die Plattform hätte die committeten 30
 * gehandelt, während der Optimierer die gewählten 30 gemessen hat. Genau die
 * Sorte Abweichung, gegen die der ganze Neubau gebaut ist.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/app.ts';
import { UNIVERSE_FILE_VERSION } from '../../src/universe/file.ts';

const dir = mkdtempSync(join(tmpdir(), 'autotrd-verdrahtung-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Eine Auswahl, die echte Symbole des Plattform-Pools nennt, aber NICHT das Config-Universum ist. */
const AUSWAHL = ['SPY', 'LLY', 'COST', 'GS', 'HON'];

function auswahlDatei(name: string, symbols: string[] = AUSWAHL): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ version: UNIVERSE_FILE_VERSION, updatedAt: Date.now(), symbols, benchmark: 'SPY', zugang: [], abgang: [], bewertung: [] }), 'utf8');
  return p;
}

describe('sync-engine-config.mjs --universe', () => {
  const lauf = (args: string[]): Record<string, unknown> => {
    const out = execFileSync('node', ['scripts/sync-engine-config.mjs', '--config', 'config/platform.yaml', ...args, '--dry-run'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)) as Record<string, unknown>;
  };
  const symbole = (doc: Record<string, unknown>): string[] => (doc.universe as { symbols: string[] }).symbols;

  it('schreibt die AUSWAHL nach meta/engineConfig, nicht die Config-Liste', () => {
    const doc = lauf(['--universe', auswahlDatei('gut.json')]);
    expect(symbole(doc)).toEqual(AUSWAHL);
  });

  it('ohne --universe bleibt es beim committeten Universum', () => {
    const doc = lauf([]);
    expect(symbole(doc)).toContain('TSLA');
    expect(symbole(doc).length).toBe(30);
  });

  it('fehlende Auswahl ⇒ Rückfall auf die Config, kein Abbruch', () => {
    const doc = lauf(['--universe', join(dir, 'gibtsnicht.json')]);
    expect(symbole(doc).length).toBe(30);
  });

  it('Auswahl mit einem Symbol außerhalb des Pools ⇒ Abbruch, Firestore bleibt unverändert', () => {
    expect(() => lauf(['--universe', auswahlDatei('boese.json', ['SPY', 'GME'])])).toThrow();
  });
});

describe('bootstrap({ universeFile })', () => {
  const opts = { config: 'config/platform.yaml', env: join(dir, 'keine.env'), home: join(dir, 'home') };

  it('ersetzt das Universum durch die Auswahl', () => {
    const app = bootstrap({ ...opts, universeFile: auswahlDatei('boot.json') });
    expect(app.config.universe.symbols).toEqual(AUSWAHL);
  });

  it('ohne Option bleibt das Config-Universum stehen', () => {
    const app = bootstrap(opts);
    expect(app.config.universe.symbols.length).toBe(30);
    expect(app.config.universe.symbols).toContain('TSLA');
  });

  it('fehlende Datei ⇒ Config gilt weiter (erster Lauf)', () => {
    const app = bootstrap({ ...opts, universeFile: join(dir, 'gibtsnicht.json') });
    expect(app.config.universe.symbols.length).toBe(30);
  });

  it("'auto' nimmt <home>/universe.json", () => {
    const home = join(dir, 'home-auto');
    const app0 = bootstrap({ ...opts, home });
    writeFileSync(app0.paths.universe, JSON.stringify({ version: UNIVERSE_FILE_VERSION, updatedAt: Date.now(), symbols: AUSWAHL, benchmark: 'SPY' }), 'utf8');
    const app = bootstrap({ ...opts, home, universeFile: 'auto' });
    expect(app.config.universe.symbols).toEqual(AUSWAHL);
  });
});
