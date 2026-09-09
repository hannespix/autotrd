/**
 * `--as-of` — ein Stichtag als MESS-Schalter.
 *
 * Wozu (docs/ARCHITEKTUR.md §5a): Alle Messungen vom 08.09.2026 teilten
 * DENSELBEN Holdout, 2026-03-08 … 2026-09-04. Vier Strategien, zwei
 * Zeitrahmen — aber ein Marktzeitraum, viermal betrachtet. Ein einziges
 * Fenster kann nicht zwischen Kante und Regime unterscheiden. Mit mehreren
 * Stichtagen entstehen mehrere vollständig getrennte
 * (Auswahl → Holdout)-Paare, mit derselben Maschinerie und ohne Leckage.
 *
 * Der Fehler, den diese Tests verhindern:
 *  1. Der Stichtag SCHNEIDET NICHT — dann misst man heimlich doch mit
 *     Zukunftsdaten und hält das Ergebnis für einen sauberen Beleg. Das wäre
 *     schlimmer als gar nicht zu messen.
 *  2. Der Schalter erreicht ein Kommando, das HANDELT. Was gehandelt wird,
 *     entscheidet die Config — nie die Kommandozeile.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { asOfFrom } from '../../src/cli.ts';
import { asOfMs, bootstrap, seriesForTimeframe, type App } from '../../src/app.ts';
import { BarStore, barStoreRoot } from '../../src/data/store.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'autotrd-asof-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cli = (cmd: string, wert: string) => ({ cmd, values: { 'as-of': wert } });

function app(asOf?: string, home = join(dir, asOf ?? 'ohne')): App {
  return bootstrap({ config: 'config/equity-1440.yaml', env: join(dir, 'keine.env'), home, ...(asOf ? { asOf } : {}) });
}

/** Tagesbars an fünf aufeinanderfolgenden Handelstagen im Cache ablegen. */
function seed(home: string): void {
  const a = app(undefined, home);
  const store = new BarStore(barStoreRoot(a.paths.bars, 'us_equity', 'iex'));
  const tage: Array<[number, number, number]> = [
    [2026, 9, 1],
    [2026, 9, 2],
    [2026, 9, 3],
    [2026, 9, 4],
    [2026, 9, 8],
  ];
  const bars: Bar[] = tage.map(([y, m, d], k) => ({ t: msFromET(y, m, d, 9, 30), o: 100 + k, h: 101 + k, l: 99 + k, c: 100 + k, v: 1000 }));
  for (const sym of a.config.universe.symbols) store.upsert(sym, '1Day', bars);
}

describe('asOfFrom (Guard)', () => {
  it('gilt für die Mess-Kommandos', () => {
    for (const cmd of ['universe', 'fetch', 'backtest', 'optimize']) expect(asOfFrom(cli(cmd, '2026-03-01')), cmd).toBe('2026-03-01');
  });

  it('LEHNT AB für run — was gehandelt wird, entscheidet nie die Kommandozeile', () => {
    expect(() => asOfFrom(cli('run', '2026-03-01'))).toThrow(/gilt nur für/);
  });

  it('lehnt für jedes andere Kommando ab, statt still zu ignorieren', () => {
    for (const cmd of ['doctor', 'status', 'flatten', 'halt', 'resume', 'readiness']) {
      expect(() => asOfFrom(cli(cmd, '2026-03-01')), cmd).toThrow(/gilt nur für/);
    }
  });

  it('verlangt ein sauberes Datum', () => {
    for (const schrott of ['gestern', '2026-3-1', '01.03.2026', '2026-13-01']) {
      expect(() => asOfFrom(cli('optimize', schrott)), schrott).toThrow(/--as-of/);
    }
  });

  it('ohne Option ändert sich nichts', () => {
    expect(asOfFrom({ cmd: 'optimize', values: {} })).toBeUndefined();
  });
});

describe('Stichtag SCHNEIDET die Daten', () => {
  const home = join(dir, 'schnitt');
  seed(home);
  const sym = 'SPY';

  it('ohne Stichtag sind alle Bars da', () => {
    expect(seriesForTimeframe(app(undefined, home), sym).length).toBe(5);
  });

  it('mit Stichtag endet die Serie dort — auch für den Benchmark und jedes andere Symbol', () => {
    const a = app('2026-09-03', home);
    for (const s of a.config.universe.symbols.slice(0, 5)) {
      const serie = seriesForTimeframe(a, s);
      expect(serie.length, s).toBe(3);
      expect(serie.t[serie.length - 1], `${s}: letzte Bar am Stichtag`).toBe(msFromET(2026, 9, 3, 9, 30));
    }
  });

  it('der Stichtag SCHLIESST seinen eigenen Tag ein', () => {
    // Sonst verschiebt sich jedes Fenster um einen Tag, ohne dass es jemand merkt.
    expect(seriesForTimeframe(app('2026-09-01', home), sym).length).toBe(1);
  });

  it('ein Stichtag vor allen Daten liefert eine leere Serie, keinen Fehler', () => {
    expect(seriesForTimeframe(app('2020-01-02', home), sym).length).toBe(0);
  });

  it('asOfMs ist das ENDE des ET-Tags', () => {
    const ms = asOfMs('2026-09-03');
    expect(ms).toBeGreaterThan(msFromET(2026, 9, 3, 16, 0));
    expect(ms).toBeLessThan(msFromET(2026, 9, 4, 0, 0));
  });
});

describe('probe.yml: der Stichtag erreicht JEDES Kommando des Laufs', () => {
  // Läufe 34329754296, 34330619329, 34330659625 (09.09.): `universe` und
  // `optimize` bekamen den Stichtag, `fetch` nicht. Es lud die korrekt auf
  // den Stichtag datierte Auswahl mit der Wanduhr — 186 Tage alt — und brach
  // ab. Der Code-Fix in bootstrap() war da und half nicht, weil der Workflow
  // ihn nie erreichte: Ein Lauf hat EINE Uhr, und jedes Kommando muss sie
  // bekommen.
  const wf = parseYaml(readFileSync('.github/workflows/probe.yml', 'utf8')) as { jobs: { probe: { steps: { name?: string; run?: string }[] } } };
  const cliSchritte = wf.jobs.probe.steps.filter((st) => (st.run ?? '').includes('src/cli.ts'));
  const kommando = (run: string): string => /src\/cli\.ts (\w+)/.exec(run)![1]!;

  it('die drei Kommandos sind universe, fetch, optimize — in dieser Reihenfolge', () => {
    expect(cliSchritte.map((st) => kommando(st.run!))).toEqual(['universe', 'fetch', 'optimize']);
  });

  it.each(['universe', 'fetch', 'optimize'])('`%s` trägt ${{ steps.asof.outputs.flag }}', (cmd) => {
    const st = cliSchritte.find((x) => kommando(x.run!) === cmd)!;
    expect(st.run).toContain('${{ steps.asof.outputs.flag }}');
  });

  it('kein Kommando gleicht den fehlenden Stichtag mit eigener Tiefe aus', () => {
    for (const st of cliSchritte) {
      expect(st.run, kommando(st.run!)).not.toMatch(/--days/);
      expect(st.run, kommando(st.run!)).not.toMatch(/outputs\.days/);
    }
  });
});

describe('fetch: rechnet mit der Uhr des Laufs', () => {
  const src = readFileSync('src/cli.ts', 'utf8');
  const start = src.indexOf('async function cmdFetch(');
  const body = src.slice(start, src.indexOf('\nasync function ', start + 1));

  it('nimmt app.asOf, wo es gesetzt ist, und sonst die Wanduhr — genau einmal', () => {
    expect(body).toMatch(/const now = app\.asOf \?\? Date\.now\(\);/);
    expect(body.match(/Date\.now\(\)/g)).toHaveLength(1);
  });
});
