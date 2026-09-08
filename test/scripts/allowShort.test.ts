/**
 * `--allow-short` ist ein MESS-Schalter, kein Handels-Schalter.
 *
 * Der Anlass (08.09.2026): `risk.allowShort: false` steht in der
 * Plattform-Config und in jeder Erkundungs-Config, und `core/logic.ts` sperrt
 * damit jeden Short-Einstieg. Der Strategie-Parameter `allowShort` war
 * dadurch in ALLEN bisherigen Messungen wirkungslos — der Optimierer hat eine
 * Dimension durchsucht, die nichts tut, und der Deflated Sharpe rechnete mit
 * einer zu hohen Trial-Zahl. Um zu prüfen, ob Shorts die Kante ändern, muss
 * man sie messen können, ohne die Produktions-Config anzufassen.
 *
 * Der Fehler, den dieser Test verhindert: dass derselbe Schalter jemals
 * beeinflusst, was WIRKLICH gehandelt wird. Was die Engine tut, entscheidet
 * die Config — nie die Kommandozeile.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyAllowShort } from '../../src/cli.ts';
import { bootstrap, type App } from '../../src/app.ts';

const dir = mkdtempSync(join(tmpdir(), 'autotrd-short-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = (): App => bootstrap({ config: 'config/platform.yaml', env: join(dir, 'keine.env'), home: join(dir, 'home') });
const cli = (cmd: string, flag = true) => ({ cmd, values: { 'allow-short': flag } });

describe('--allow-short', () => {
  it('Vorbedingung: die Plattform-Config verbietet Shorts', () => {
    expect(app().config.risk.allowShort).toBe(false);
  });

  it('erlaubt Shorts für die Messung (backtest, optimize)', () => {
    for (const cmd of ['backtest', 'optimize']) {
      expect(applyAllowShort(app(), cli(cmd)).config.risk.allowShort, cmd).toBe(true);
    }
  });

  it('lässt die Ausgangs-Config unangetastet', () => {
    const a = app();
    applyAllowShort(a, cli('optimize'));
    expect(a.config.risk.allowShort, 'die Config des Aufrufers darf sich nicht ändern').toBe(false);
  });

  it('LEHNT AB für run — was gehandelt wird, entscheidet nie die Kommandozeile', () => {
    expect(() => applyAllowShort(app(), cli('run'))).toThrow(/gilt nur für/);
  });

  it('lehnt auch für jedes andere Kommando ab, statt still zu ignorieren', () => {
    // Still ignorieren wäre schlimmer: Dann glaubt jemand, der Schalter habe gewirkt.
    for (const cmd of ['doctor', 'universe', 'fetch', 'status', 'flatten', 'halt', 'resume', 'readiness']) {
      expect(() => applyAllowShort(app(), cli(cmd)), cmd).toThrow(/gilt nur für/);
    }
  });

  it('ohne die Option ändert sich nichts — auch bei run', () => {
    for (const cmd of ['run', 'optimize']) {
      const a = app();
      expect(applyAllowShort(a, { cmd, values: {} }), cmd).toBe(a);
    }
  });
});
