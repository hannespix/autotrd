/**
 * `autotrd profile` und der Haken am Ende von `optimize`.
 *
 * Der Fehler, den diese Tests verhindern: Das Profil entsteht in der Nacht
 * hinter dem Champion — ohne den Haken hätte die Plattform ein Profil vom
 * Vortag neben dem Champion von heute, und `publish-profile.mjs` fände
 * lokal keine Datei. Kein Netz: Bars kommen aus einem gesäten 1Day-Cache,
 * die Wahl der Engine aus champion.json.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { asOfMs, bootstrap } from '../../src/app.ts';
import { laufAusUmgebung, main, profilFuerApp } from '../../src/cli.ts';
import { homePaths } from '../../src/core/journal.ts';
import { setLogSink } from '../../src/core/log.ts';
import { dayKey, isTradingDay, msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { BarStore, barStoreRoot } from '../../src/data/store.ts';
import { saveChampion, type ChampionFile } from '../../src/optimize/promote.ts';
import { PROFILE_FILE, type SymbolProfileFile } from '../../src/profile/symbolprofile.ts';

setLogSink(() => undefined);

const dir = mkdtempSync(join(tmpdir(), 'autotrd-profil-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = join(dir, 'keine.env');

/** Ein Kommando ohne Tabelle auf dem Prüfstand-stdout laufen lassen; gibt den Rückgabecode zurück. */
async function stillAusfuehren(fn: () => Promise<number>): Promise<number> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}
const cfg = join(dir, 'cfg.yaml');
writeFileSync(cfg, 'universe:\n  symbols: [AAA, BBB]\n  benchmark: SPY\n  candidates: [AAA, BBB, SPY, GLD, TLT]\ntimeframe: 1440\n', 'utf8');

/** Handelstage (Mo–Fr) ab dem 2. Januar 2024, Bar-Beginn 09:30 ET. */
function handelstage(n: number): number[] {
  const out: number[] = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(msFromET(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const TAGE = handelstage(260);
/** Bars, die `seriesForTimeframe` bis `now` sieht: nur echte Handelstage (NYSE-Feiertage fallen raus), Sitzung geschlossen. */
const erwarteteBars = (now: number): number => TAGE.filter((t) => t + 6.5 * 3_600_000 <= now && isTradingDay(dayKey(t), 'us_equity')).length;

function seed(home: string, symbols: string[]): void {
  const a = bootstrap({ config: cfg, env, home });
  const store = new BarStore(barStoreRoot(a.paths.bars, 'us_equity', 'iex'));
  for (const [k, sym] of symbols.entries()) {
    const bars: Bar[] = TAGE.map((t, i) => {
      const c = (100 + 10 * k) * (1 + i / 400) * (1 + (i % 2 === 0 ? 0.003 : -0.003));
      return { t, o: c, h: c * 1.01, l: c * 0.99, c, v: 500_000, vw: c };
    });
    store.upsert(sym, '1Day', bars);
  }
}

const champion: ChampionFile = {
  version: 1,
  updatedAt: 1_700_000_000_000,
  symbols: {},
  noTrade: { AAA: { reason: 'x', decidedAt: 1, bestScore: null }, BBB: { reason: 'y', decidedAt: 1, bestScore: null } },
  basis: {
    version: 1,
    strategy: 'regime_allocation',
    params: { lookback: 126, skip: 21, regimeLen: 150, topPct: 0.4, exitPct: 0.6, stopPct: 20 },
    symbols: ['SPY', 'GLD', 'TLT'],
    label: 'Basis V3',
    timeframe: 1440,
    pass: true,
    gates: [],
    measuredAt: 1_700_000_000_000,
    positionPct: 20,
  },
};

describe('autotrd profile', () => {
  const home = join(dir, 'home');

  it('schreibt <home>/profile.json mit Version 1, generatedAt, lauf und einem Profil je Symbol des Universums', async () => {
    seed(home, ['AAA', 'BBB', 'SPY', 'GLD', 'TLT']);
    saveChampion(homePaths(home).champion, champion);
    const code = await stillAusfuehren(() => main(['profile', '--config', cfg, '--env', env, '--home', home]));
    expect(code).toBe(0);
    const pfad = join(home, PROFILE_FILE);
    expect(existsSync(pfad)).toBe(true);
    const file = JSON.parse(readFileSync(pfad, 'utf8')) as SymbolProfileFile;
    expect(file.version).toBe(1);
    expect(typeof file.generatedAt).toBe('number');
    expect(file.lauf).toEqual({ nummer: null, id: null, configCommit: null });
    expect(file.profile.map((p) => p.symbol)).toEqual(['AAA', 'BBB', 'GLD', 'SPY', 'TLT']);
    // Die Wahl der Engine: Basis-Korb führt, noTrade nicht.
    expect(file.profile.find((p) => p.symbol === 'GLD')!.taktik).toMatchObject({ quelle: 'basis', einstiege: 'erlaubt', imEngineUniversum: true });
    expect(file.profile.find((p) => p.symbol === 'AAA')!.taktik.quelle).toBe('keine');
    // Bars kamen aus dem Cache: nur Handelstage (Feiertage fallen raus). Die Uhr ist die Wanduhr —
    // gegen sie ist die letzte Bar von 2024 Jahre alt, und die Liquiditätsprüfung sagt das, statt zu schweigen.
    const gld = file.profile.find((p) => p.symbol === 'GLD')!;
    expect(gld.stand.bars).toBe(erwarteteBars(file.now));
    expect(gld.stand.bars).toBeGreaterThan(240);
    expect(gld.liquiditaet.handelbar).toBe(false);
    expect(gld.liquiditaet.grund).toMatch(/Tage alt/);
  });

  it('--json druckt die Datei; die Uhr ist der Datenschnitt (now), nicht der Cache', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(['profile', '--config', cfg, '--env', env, '--home', home, '--json'])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const file = JSON.parse(chunks.join('')) as SymbolProfileFile;
    expect(file.version).toBe(1);
    expect(file.now).toBeGreaterThan(TAGE[259]!);
  });

  it('profilFuerApp sieht keine Bar nach now — eine Bar von „heute" bleibt draußen; nahe am Stand ist die Liquidität handelbar', () => {
    const a = bootstrap({ config: cfg, env, home });
    // Tagesbar 100 beginnt 09:30 ET, schließt 16:00 ET: eine Stunde nach Beginn ist sie noch offen.
    const offen = TAGE[100]! + 3_600_000;
    const vor = profilFuerApp(a, offen);
    expect(vor.profile.find((p) => p.symbol === 'GLD')!.stand.bars).toBe(erwarteteBars(offen));
    const zu = TAGE[100]! + 8 * 3_600_000;
    const nach = profilFuerApp(a, zu);
    expect(nach.profile.find((p) => p.symbol === 'GLD')!.stand.bars).toBe(erwarteteBars(zu));
    expect(erwarteteBars(zu)).toBe(erwarteteBars(offen) + 1);
    expect(nach.profile.find((p) => p.symbol === 'GLD')!.liquiditaet).toMatchObject({ handelbar: true, grund: null });
  });

  it('der Lauf kommt aus der Actions-Umgebung, lokal null', () => {
    expect(laufAusUmgebung({})).toEqual({ nummer: null, id: null, configCommit: null });
    expect(laufAusUmgebung({ GITHUB_RUN_NUMBER: '41', GITHUB_RUN_ID: '123', GITHUB_SHA: 'deadbeef' })).toEqual({ nummer: 41, id: '123', configCommit: 'deadbeef' });
    expect(laufAusUmgebung({ GITHUB_RUN_NUMBER: 'x' }).nummer).toBeNull();
  });

  it('--as-of ist für profile kein Mess-Schalter (Abbruch statt stillem Ignorieren) — der Stichtag erreicht das Profil nur über optimize', async () => {
    await expect(main(['profile', '--config', cfg, '--env', env, '--home', home, '--as-of', '2024-06-01'])).rejects.toThrow(/gilt nur für/);
  });
});

describe('optimize schreibt das Profil am Ende — mit dem Champion DIESES Laufs und dem Stichtag des Laufs (M3)', () => {
  const home = join(dir, 'home-optimize');
  const cfgOpt = join(dir, 'cfg-optimize.yaml');
  // Kleiner Lauf: eine Strategie, vier Stichproben, kurze Folds — er misst nichts
  // Belastbares (Rückgabecode 3) und schreibt trotzdem Champion UND Profil.
  writeFileSync(
    cfgOpt,
    'universe:\n  symbols: [AAA, BBB]\n  benchmark: SPY\n  candidates: [AAA, BBB, SPY, GLD, TLT]\ntimeframe: 1440\n' +
      'optimizer:\n  strategies: [mean_reversion]\n  samples: 4\n  lookbackDays: 300\n  isDays: 60\n  oosDays: 30\n',
    'utf8',
  );

  it('nach `optimize --as-of`: Profil = Champion dieses Laufs, Datenschnitt = Stichtag, keine Bar danach', async () => {
    seed(home, ['AAA', 'BBB', 'SPY', 'GLD', 'TLT']);
    saveChampion(homePaths(home).champion, champion); // der ALTE Champion (updatedAt 1_700_000_000_000)
    const code = await stillAusfuehren(() => main(['optimize', '--config', cfgOpt, '--env', env, '--home', home, '--as-of', '2024-09-03']));
    expect(code).toBe(3);
    const profil = JSON.parse(readFileSync(join(home, PROFILE_FILE), 'utf8')) as SymbolProfileFile;
    const neu = JSON.parse(readFileSync(homePaths(home).champion, 'utf8')) as ChampionFile;
    expect(neu.updatedAt).not.toBe(champion.updatedAt);
    expect(profil.championUpdatedAt).toBe(neu.updatedAt);
    // Der Stichtag ist der Datenschnitt — nicht die Wanduhr (Cache reicht bis Ende 2024).
    const stichtag = asOfMs('2024-09-03');
    expect(profil.asOf).toBe(stichtag);
    expect(profil.now).toBe(stichtag);
    for (const p of profil.profile) {
      expect(p.stand.t, p.symbol).not.toBeNull();
      expect(p.stand.t!, p.symbol).toBeLessThanOrEqual(stichtag);
      expect(p.stand.bars, p.symbol).toBe(erwarteteBars(stichtag));
    }
    expect(erwarteteBars(stichtag)).toBeLessThan(200);
  });
});
