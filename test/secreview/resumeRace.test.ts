/**
 * SECREVIEW #4b — `autotrd resume --ack-drawdown` erkennt eine laufende Engine
 * nur am Alter von state.json (cli.ts cmdResume: `age < 15_000`). Hängt die
 * Engine 15 s in einem Alpaca-Timeout (Standard 15 s × bis zu 3 Versuche),
 * gilt sie als gestoppt: resume schreibt state.json mit gelöschtem Halt,
 * meldet „Halt aufgehoben" — und der nächste Tick der Engine überschreibt die
 * Datei aus ihrem Speicher: Der Halt steht wieder, der Operator glaubt das
 * Gegenteil. Fail-safe (Halt bleibt), aber die Rückmeldung lügt, und der
 * Journal-Eintrag `resume` ist falsch.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, writeJsonAtomic, type EngineState } from '../../src/core/journal.ts';
import { MIN } from '../../src/core/time.ts';
import { main } from '../../src/cli.ts';
import { OPEN1, TEN_CLOSES, minuteBars, startScenario } from '../fakes/harness.ts';

describe('secreview: resume gegen eine hängende Engine', () => {
  it('resume --ack-drawdown meldet Erfolg, die laufende Engine schreibt den Halt zurück', async () => {
    const sc = await startScenario();
    sc.fake.account.equity = 85_000; // −15 % vom Hoch 100 000
    await sc.engine.reconcileNow(sc.now());
    sc.pushBars('AAPL', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);
    expect(sc.engine.status().halt.reason).toBe('drawdown');

    // Engine hängt 20 s (z. B. Alpaca-Timeout im Abgleich): kein Tick, State altert.
    const stale = readJson<EngineState>(sc.paths.state)!;
    stale.updatedAt = Date.now() - 20_000;
    writeJsonAtomic(sc.paths.state, stale);

    const dir = mkdtempSync(join(tmpdir(), 'secreview-cli-'));
    const cfg = join(dir, 'config.yaml');
    writeFileSync(cfg, 'universe:\n  symbols: [AAPL]\n');
    const code = await main(['resume', '--ack-drawdown', '--config', cfg, '--env', join(dir, '.env'), '--home', sc.home]);
    expect(code).toBe(0);
    // Die CLI schreibt NICHT in den State der (vielleicht laufenden) Engine, sondern setzt
    // einen RESUME-Marker; der Halt steht bis zum nächsten Tick, kein falsches „aufgehoben".
    expect(existsSync(join(sc.home, 'RESUME'))).toBe(true);
    expect(readJson<EngineState>(sc.paths.state)!.halt.halted).toBe(true);
    expect(sc.journal.readAll().filter((e) => e.kind === 'resume')).toHaveLength(0);

    // Engine kommt aus dem Hänger zurück und tickt einmal: Marker verarbeitet, Peak = Equity, Journal 'resume'.
    await sc.engine.tick(OPEN1 + 11 * MIN);
    expect(readJson<EngineState>(sc.paths.state)!.halt.halted, 'RESUME-Marker wurde nicht verarbeitet').toBe(false);
    expect(readJson<EngineState>(sc.paths.state)!.peakEquity).toBe(85_000);
    expect(existsSync(join(sc.home, 'RESUME'))).toBe(false);
    expect(sc.journal.readAll().filter((e) => e.kind === 'resume')).toHaveLength(1);
  });
});
