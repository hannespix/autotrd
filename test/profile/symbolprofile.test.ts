/**
 * Symbolprofil — Anzeige und Erklärung, kein Handel. Die Wächter:
 *
 *  1. PRÄFIX-KONSISTENZ (§0.2): Das Profil aus `bars.prefix(i+1)` ist das
 *     Profil aus `bars` mit `now` nach dem Schluss von Bar i — angehängte
 *     Zukunft ändert nichts. Der Schnitt liegt am SITZUNGSSCHLUSS: Die Bar,
 *     die bei `now` gerade läuft, ist nicht gesehen (Red-Team 10.09., M6).
 *  2. RANG: identisch mit dem Rang, den `decide()` in core/logic.ts an
 *     `snap.rank` reicht — auf demselben Korb, aus derselben Funktion. Und
 *     der Rang nennt seinen Korb: den der PLATTFORM. Ein Nutzer mit
 *     Teilauswahl rangiert in seiner Engine anders (M1) — das Profil kann
 *     das nicht wissen, also sagt es, wogegen es rangiert.
 *  3. TAKTIK: identisch mit `strategyChoice`/`strategyForFn` (app.ts) über
 *     `core/basisTier.ts`. Ein Symbol, das die Engine nicht handelt, trägt
 *     keine Taktik — kein Rang, keine Parameter, keinen Stop.
 *  4. HALTEDAUER: nur gemessen. Der Champion trägt heute keine ⇒ „unbekannt".
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrap, engineConfig, strategyChoice, strategyForFn, type App } from '../../src/app.ts';
import { BarSeries } from '../../src/core/bars.ts';
import { homePaths } from '../../src/core/journal.ts';
import { setLogSink } from '../../src/core/log.ts';
import { decide, korbRaenge, type LogicContext, type SymbolInput } from '../../src/core/logic.ts';
import { buildSessionInfo } from '../../src/core/session.ts';
import { DAY, msFromET } from '../../src/core/time.ts';
import type { Bar, HaltState, KorbRang, Strategy } from '../../src/core/types.ts';
import { saveChampion, type ChampionBasis, type ChampionFile } from '../../src/optimize/promote.ts';
import {
  BASIS_KLASSEN,
  buildSymbolProfiles,
  geschlosseneBars,
  geschlossenBis,
  klasseVon,
  PROFIL_PARAMS_FALLBACK,
  profilParams,
  profilTabelle,
  profilUniversum,
  sitzungsSchluss,
  type ProfilWahl,
  type SymbolProfileFile,
} from '../../src/profile/symbolprofile.ts';
import { atr } from '../../src/strategy/indicators.ts';
import { strategy as regimeAllocation } from '../../src/strategy/regimeAllocation.ts';
import { bewerte, universeRegelnFuer } from '../../src/universe/select.ts';

setLogSink(() => undefined);

const dir = mkdtempSync(join(tmpdir(), 'autotrd-profil-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/* ───────────────────────── Daten ───────────────────────── */

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
const N = 420;
const TAGE = handelstage(N + 40);

/** Serie aus einer Kursfunktion je Index; Zickzack, damit die Volatilität nicht null ist. */
function serie(n: number, kurs: (k: number) => number): BarSeries {
  const bars: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const c = kurs(k) * (1 + (k % 2 === 0 ? 0.004 : -0.004));
    bars.push({ t: TAGE[k]!, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 });
  }
  return BarSeries.from(bars);
}
const rampe = (gesamtPct: number) => (k: number) => 100 * (1 + (gesamtPct * k) / 300);

const BASIS_KORB = ['SPY', 'IWM', 'EFA', 'EEM', 'IEF', 'TLT', 'LQD', 'GLD', 'XLRE'];
const ALPHA = ['AAA', 'BBB', 'CCC'];
/** Verschiedene Steigungen, damit die Ränge eindeutig sind (Gleichstand wäre alphabetisch, aber uninteressant). */
const STEIGUNG: Record<string, number> = { SPY: 0.3, IWM: 0.1, EFA: 0.2, EEM: -0.2, IEF: 0.05, TLT: -0.1, LQD: 0.02, GLD: 0.4, XLRE: 0.15, AAA: 0.5, BBB: 0.25, CCC: -0.3 };
const SERIEN = new Map<string, BarSeries>([...BASIS_KORB, ...ALPHA].map((s) => [s, serie(N, rampe(STEIGUNG[s]!))]));
/**
 * Ein Zeitpunkt, zu dem Bar i sicher geschlossen ist und Bar i+1 sicher nicht:
 * 24 h nach dem Beginn von Bar i. Robust gegen Feiertage in TAGE (Mo–Fr ohne
 * Kalender: dort gilt „Schluss = Beginn + 1 Tag") und gegen DST-Kanten.
 */
const nachSchluss = (i: number): number => TAGE[i]! + DAY;
const LETZTE = TAGE[N - 1]!;
const NACH_LETZTER = nachSchluss(N - 1);

/* ───────────────────────── App-Fake über bootstrap (kein Netz) ───────────────────────── */

let n = 0;
function app(o: { champion: ChampionFile | null; basisSchalter?: boolean; timeframe?: number; symbols?: string[]; candidates?: string[] }): App {
  const home = join(dir, `home-${++n}`);
  const cfgPfad = join(dir, `cfg-${n}.yaml`);
  const symbols = o.symbols ?? ['SPY', ...ALPHA];
  const candidates = o.candidates ?? [...symbols, ...BASIS_KORB];
  writeFileSync(
    cfgPfad,
    `universe:\n  symbols: [${symbols.join(', ')}]\n  benchmark: SPY\n  candidates: [${candidates.join(', ')}]\n` +
      `timeframe: ${o.timeframe ?? 1440}\nstrategy:\n  basis: ${o.basisSchalter ?? true}\n`,
    'utf8',
  );
  if (o.champion) saveChampion(homePaths(home).champion, o.champion);
  return bootstrap({ config: cfgPfad, env: join(dir, 'keine.env'), home });
}

const block = (over: Partial<ChampionBasis> = {}): ChampionBasis => ({
  version: 1,
  strategy: 'regime_allocation',
  params: { lookback: 126, skip: 21, regimeLen: 150, topPct: 0.4, exitPct: 0.6, stopPct: 20 },
  symbols: [...BASIS_KORB],
  label: 'Basis V3',
  timeframe: 1440,
  pass: true,
  gates: [],
  measuredAt: 1_700_000_000_000,
  positionPct: 20,
  configCommit: 'abc1234',
  ...over,
});

const alphaEntry = (over: Partial<ChampionFile['symbols'][string]> = {}): ChampionFile['symbols'][string] => ({
  strategy: 'cross_sectional_momentum',
  params: {},
  timeframe: 1440,
  score: 1.5,
  oos: { objectiveMedian: 1.5, objectiveMean: 1.4, positiveFoldShare: 0.7, trades: 80, netProfit: 500, netReturnPct: 2, maxDrawdownPct: 3, dailyReturns: [], profitFactor: 1.3, feeShare: 0.2 },
  gates: [],
  decidedAt: 1_700_100_000_000,
  trials: 10,
  dataRange: { start: 1, end: 2 },
  ...over,
});

function champion(basis: ChampionBasis | null, o: { alpha?: string[]; noTrade?: string[] } = {}): ChampionFile {
  return {
    version: 1,
    updatedAt: 1_700_200_000_000,
    symbols: Object.fromEntries((o.alpha ?? []).map((s) => [s, alphaEntry()])),
    noTrade: Object.fromEntries((o.noTrade ?? []).map((s) => [s, { reason: 'kein Kandidat besteht die Gates', decidedAt: 1_700_150_000_000, bestScore: null }])),
    ...(basis ? { basis } : {}),
  };
}

const LAUF = { nummer: 42, id: 'run-1', configCommit: 'abc1234' };

function profil(a: App, o: { now?: number; barsFor?: (s: string) => BarSeries; choiceFor?: (s: string) => ProfilWahl | null } = {}): SymbolProfileFile {
  return buildSymbolProfiles({
    config: a.config,
    champion: a.champion,
    choiceFor: o.choiceFor ?? strategyForFn(a),
    barsFor: o.barsFor ?? ((s) => SERIEN.get(s) ?? BarSeries.empty()),
    engineUniverse: engineConfig(a).universe.symbols,
    now: o.now ?? NACH_LETZTER,
    lauf: LAUF,
    generatedAt: 0,
  });
}

const je = (file: SymbolProfileFile, sym: string) => file.profile.find((p) => p.symbol === sym)!;

/* ───────────────────────── Tests ───────────────────────── */

describe('Universum und feste Zuordnungen', () => {
  it('Profil-Universum = Alpha-Korb ∪ Basis-Korb ∪ Benchmark, alphabetisch', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    expect(profilUniversum(a.config, a.champion)).toEqual([...new Set(['SPY', ...ALPHA, ...BASIS_KORB])].sort());
  });

  it('Klasse: Basis-ETFs nach GTAA-Klasse, Benchmark markiert, Aktien mit Sektor aus der Pool-Tabelle, Unbekanntes „Aktie" ohne Sektor', () => {
    expect(klasseVon('GLD', 'SPY')).toEqual({ klasse: BASIS_KLASSEN.GLD, cluster: 'basis_etf', sektor: null, benchmark: false });
    expect(klasseVon('SPY', 'SPY')).toMatchObject({ cluster: 'basis_etf', benchmark: true });
    expect(klasseVon('NVDA', 'SPY')).toEqual({ klasse: 'Aktie', cluster: 'aktie', sektor: 'Technologie und Halbleiter', benchmark: false });
    expect(klasseVon('QQQ', 'SPY')).toMatchObject({ cluster: 'etf' });
    expect(klasseVon('AAA', 'SPY')).toEqual({ klasse: 'Aktie', cluster: 'aktie', sektor: null, benchmark: false });
  });

  it('Kennzahlen-Parameter: der Basis-Block des Champions, sonst die Vorregistrierung V3 (126/21, 150)', () => {
    expect(profilParams(champion(block({ params: { lookback: 63, skip: 0, regimeLen: 50, topPct: 0.2, exitPct: 0.6, stopPct: 10 } }))).params).toMatchObject({ lookback: 63, skip: 0, regimeLen: 50 });
    expect(profilParams(null).params).toMatchObject(PROFIL_PARAMS_FALLBACK);
    expect(profilParams(champion(null)).quelle).toMatch(/Vorregistrierung Basis V3/);
  });
});

describe('WÄCHTER 1 — Präfix-Konsistenz (kein Lookahead)', () => {
  const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });

  it('Profil aus bars.prefix(i+1) == Profil aus bars mit now nach dem Schluss von Bar i — an drei Ständen', () => {
    for (const i of [200, 333, N - 1]) {
      const now = nachSchluss(i);
      const voll = profil(a, { now });
      const praefix = profil(a, { now, barsFor: (s) => (SERIEN.get(s) ?? BarSeries.empty()).prefix(i + 1) });
      expect(praefix).toEqual(voll);
      expect(je(voll, 'GLD').stand.bars).toBe(i + 1);
    }
  });

  it('angehängte Zukunft (Kurse ×10 und ×0,1 danach) ändert an einem Stand nichts', () => {
    const i = 300;
    const now = nachSchluss(i);
    const ohne = profil(a, { now });
    const mitZukunft = (s: string): BarSeries => {
      const alt = SERIEN.get(s)!;
      const bars = alt.toBars();
      for (let k = alt.length; k < alt.length + 30; k++) {
        const c = (k % 2 === 0 ? 1000 : 10) * (STEIGUNG[s]! > 0 ? 0.1 : 10);
        bars.push({ t: TAGE[k]!, o: c, h: c * 1.5, l: c * 0.5, c, v: 5 });
      }
      return BarSeries.from(bars);
    };
    expect(profil(a, { now, barsFor: mitZukunft })).toEqual(ohne);
  });

  it('geschlossenBis schneidet am SITZUNGSSCHLUSS: die Bar, die bei now läuft, ist nicht gesehen (M6)', () => {
    const s = SERIEN.get('AAA')!;
    const t10 = TAGE[10]!; // 16.01.2024, ein Handelstag: Schluss 16:00 ET
    const schluss = sitzungsSchluss(t10, 'us_equity');
    expect(schluss).toBe(t10 + 6.5 * 3_600_000);
    expect(geschlossenBis(s, t10, 'us_equity').length).toBe(10); // öffnet gerade
    expect(geschlossenBis(s, t10 + 3_600_000, 'us_equity').length).toBe(10); // eine Stunde offen
    expect(geschlossenBis(s, schluss - 1, 'us_equity').length).toBe(10);
    expect(geschlossenBis(s, schluss, 'us_equity').length).toBe(11); // Schluss erreicht
    expect(geschlossenBis(s, 0, 'us_equity').length).toBe(0);
    // Dasselbe für rohe Cache-Bars (Liquidität) — sonst zählte nach einem `fetch`
    // während der Sitzung die laufende Tagesbar im Median, während `stand` sie ausschließt.
    expect(geschlosseneBars(s.toBars(), t10 + 3_600_000, 'us_equity').length).toBe(10);
    expect(geschlosseneBars(s.toBars(), schluss, 'us_equity').length).toBe(11);
    expect(geschlosseneBars(s.toBars(), NACH_LETZTER, 'us_equity')).toHaveLength(N);
  });

  it('eine OFFENE letzte Bar fließt in nichts ein — Stand, Kennzahlen, Rang und Liquidität sehen sie nicht', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    const i = N - 1;
    const offen = profil(a, { now: TAGE[i]! + 3_600_000 });
    const geschlossenVorher = profil(a, { now: nachSchluss(i - 1), barsFor: (s) => (SERIEN.get(s) ?? BarSeries.empty()).prefix(i) });
    expect(je(offen, 'GLD').stand.bars).toBe(i);
    // Alles gleich bis auf `now` und das Alter der Daten (das an `now` hängt).
    const ohneAlter = (f: SymbolProfileFile) => ({ ...f, now: 0, profile: f.profile.map((p) => ({ ...p, liquiditaet: { dollarVolumenTag: p.liquiditaet.dollarVolumenTag, tage: p.liquiditaet.tage, letzterKurs: p.liquiditaet.letzterKurs } })) });
    expect(ohneAlter(offen)).toEqual(ohneAlter(geschlossenVorher));
  });

  it('der Stichtag einer Messung steht in der Datei (asOf), im Betrieb null', () => {
    const a = app({ champion: champion(block()) });
    expect(profil(a).asOf).toBeNull();
    const stichtag = nachSchluss(300);
    const mitStichtag = buildSymbolProfiles({ config: a.config, champion: a.champion, choiceFor: strategyForFn(a), barsFor: (s) => SERIEN.get(s) ?? BarSeries.empty(), now: stichtag, asOf: stichtag, lauf: LAUF, generatedAt: 0 });
    expect(mitStichtag.asOf).toBe(stichtag);
    expect(je(mitStichtag, 'GLD').stand.bars).toBe(301);
  });
});

describe('WÄCHTER 2 — Rang identisch mit decide()', () => {
  const noHalt: HaltState = { halted: false, reason: null, since: null, until: null, note: null };

  /** Die Ränge, die `decide()` an `snap.rank` reicht — mit einer aufzeichnenden Hülle um die echte Strategie. */
  function raengeAusDecide(a: App): { gesehen: Map<string, KorbRang | null>; choiceFor: (s: string) => ProfilWahl | null } {
    const gesehen = new Map<string, KorbRang | null>();
    const basisWahl = strategyForFn(a);
    const huellen = new Map<string, Strategy>();
    const choiceFor = (sym: string): ProfilWahl | null => {
      const c = basisWahl(sym);
      if (!c) return null;
      let h = huellen.get(c.strategy.id);
      if (!h) {
        const echt = c.strategy;
        h = { ...echt, decide: (snap, ind, p) => { gesehen.set(snap.symbol, snap.rank ?? null); return echt.decide(snap, ind, p); } };
        huellen.set(echt.id, h);
      }
      return { ...c, strategy: h };
    };
    const inputs: SymbolInput[] = [];
    for (const sym of engineConfig(a).universe.symbols) {
      const c = choiceFor(sym);
      if (!c) continue;
      const bars = SERIEN.get(sym)!;
      const i = bars.length - 1;
      inputs.push({
        snap: { symbol: sym, bars, i, position: null, session: buildSessionInfo(bars, i, 1440, 'us_equity') },
        strategy: c.strategy,
        params: c.params,
        ind: c.strategy.precompute(bars, c.params),
        sizing: c.sizing,
        entriesAllowed: c.entriesAllowed,
      });
    }
    const ctx: LogicContext = {
      now: LETZTE + 86_400_000,
      today: '2025-08-13',
      nextTradingDay: '2025-08-14',
      account: { equity: 1_000_000, cash: 1_000_000, dayStartEquity: 1_000_000, peakEquity: 1_000_000, dayTradeCount: 0, patternDayTrader: false },
      positions: new Map(),
      pendingEntries: new Set(),
      halt: noHalt,
      risk: { ...a.config.risk, maxPositions: 50 },
      session: a.config.session,
      assetClass: 'us_equity',
      timeframe: 1440,
      dataFresh: true,
      localDayTrades: 0,
      assetFacts: () => ({ tradable: true, shortable: false }),
    };
    decide(ctx, inputs);
    return { gesehen, choiceFor };
  }

  it('Basis-Korb (9 ETFs, Allokation) und Alpha-Korb (2 Symbole, Risiko-Budget) rangieren getrennt — je Symbol derselbe Rang wie in decide()', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    const { gesehen, choiceFor } = raengeAusDecide(a);
    const file = profil(a, { choiceFor });
    expect(gesehen.size).toBe(11);
    let mitRang = 0;
    for (const [sym, rang] of gesehen) {
      const p = je(file, sym);
      if (rang === null) expect(p.rang, sym).toBeNull();
      else {
        mitRang++;
        expect(p.rang, sym).toMatchObject({ rank: rang.rank, of: rang.of, pct: rang.pct, korb: p.taktik.quelle });
        expect(p.rang!.symbole, sym).toHaveLength(rang.of);
        expect(p.rang!.symbole[rang.rank - 1], sym).toBe(sym);
      }
    }
    expect(mitRang).toBe(11);
    expect(je(file, 'GLD').rang).toMatchObject({ rank: 1, of: 9, korb: 'basis' });
    expect(je(file, 'EEM').rang).toMatchObject({ rank: 9, of: 9 });
    expect(je(file, 'AAA').rang).toMatchObject({ rank: 1, of: 2, korb: 'champion' });
    expect(je(file, 'CCC').rang).toBeNull();
  });

  it('ein Symbol mit veralteter letzter Bar rangiert nicht — wie in decide()', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    const alt = (s: string): BarSeries => (s === 'IEF' ? SERIEN.get(s)!.prefix(N - 1) : SERIEN.get(s)!);
    const file = profil(a, { barsFor: alt });
    expect(je(file, 'IEF').rang).toBeNull();
    expect(je(file, 'GLD').rang).toMatchObject({ of: 8 });
    expect(je(file, 'GLD').rang!.symbole).not.toContain('IEF');
  });

  it('der Rang nennt seinen Korb — den der PLATTFORM; ein Nutzer mit Teilauswahl rangiert in seiner Engine anders (M1)', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    const file = profil(a);
    expect(je(file, 'AAA').rang).toMatchObject({ rank: 1, of: 2, symbole: ['AAA', 'BBB'] });
    expect(je(file, 'BBB').rang).toMatchObject({ rank: 2, of: 2, symbole: ['AAA', 'BBB'] });
    const gld = je(file, 'GLD').rang!;
    expect(gld.symbole).toHaveLength(9);
    expect(gld.symbole[0]).toBe('GLD');
    expect(gld.symbole[8]).toBe('EEM');
    // Nutzer wählt nur BBB (settings.auto.symbols): seine Engine baut die Inputs aus SEINEM
    // Universum und rangiert BBB allein — Rang 1 von 1, während das Profil 2 von 2 sagt.
    // Das Profil kann je Nutzer nichts wissen; deshalb trägt der Rang seine Mitglieder,
    // und das Frontend beschriftet ihn als Plattform-Korb (profilAnzeige in data.ts).
    const c = strategyChoice(a, 'BBB')!;
    const bars = SERIEN.get('BBB')!;
    const i = bars.length - 1;
    const nutzer = korbRaenge([{ snap: { symbol: 'BBB', bars, i, position: null, session: buildSessionInfo(bars, i, 1440, 'us_equity') }, strategy: c.strategy, params: c.params, ind: c.strategy.precompute(bars, c.params), sizing: c.sizing }]);
    expect(nutzer.get('BBB')).toMatchObject({ rank: 1, of: 1 });
  });

  it('der Rang-Wächter setzt DENSELBEN Datenpfad voraus — mit anderen Bars als die Engine weicht er ab (M7, Negativbeispiel)', () => {
    const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    const { gesehen, choiceFor } = raengeAusDecide(a);
    expect(gesehen.get('GLD')).toMatchObject({ rank: 1, of: 9 });
    const andere = (s: string): BarSeries => (s === 'GLD' ? serie(N, rampe(-0.5)) : SERIEN.get(s) ?? BarSeries.empty());
    const file = profil(a, { choiceFor, barsFor: andere });
    expect(je(file, 'GLD').rang).toMatchObject({ rank: 9, of: 9 });
  });
});

describe('WÄCHTER 3 — Taktik identisch mit strategyChoice / strategyForFn', () => {
  it('je Symbol: Quelle, Strategie, Einstiegsrecht und Sizing sind die der Engine-Wahl; ohne Wahl keine Taktik', () => {
    const a = app({ champion: champion(block({ pass: false }), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
    const file = profil(a);
    for (const p of file.profile) {
      const c = strategyChoice(a, p.symbol);
      expect(p.taktik.quelle, p.symbol).toBe(c?.source ?? 'keine');
      expect(p.taktik.strategie, p.symbol).toBe(c?.strategy.id ?? null);
      expect(p.taktik.params, p.symbol).toEqual(c ? c.params : null);
      expect(p.taktik.sizing, p.symbol).toEqual(c?.sizing ?? null);
      expect(p.taktik.einstiege, p.symbol).toBe(c ? (c.entriesAllowed === false ? 'gesperrt' : 'erlaubt') : null);
    }
    // Ein Symbol, das die Engine nicht handelt: keine Taktik, kein Rang, kein Stop, keine Parameter.
    const ccc = je(file, 'CCC');
    expect(strategyForFn(a)('CCC')).toBeNull();
    expect(ccc.taktik).toMatchObject({ quelle: 'keine', strategie: null, params: null, sizing: null, einstiege: null });
    expect(ccc.taktik.grund).toMatch(/noTrade: kein Kandidat besteht die Gates/);
    expect(ccc.rang).toBeNull();
    expect(ccc.stop.pct).toBeNull();
    // Basis ohne Latte: geführt, aber gesperrt — mit dem Grund des Kerns.
    expect(je(file, 'GLD').taktik).toMatchObject({ quelle: 'basis', einstiege: 'gesperrt', sizing: { mode: 'allocation', positionPct: 20 } });
    expect(je(file, 'GLD').taktik.grund).toMatch(/Latte nicht bestanden — keine neuen Einstiege/);
    // Der Basis-Korb steht dann nicht im Engine-Universum (nichts offen) — das Profil sagt es.
    expect(je(file, 'GLD').taktik.imEngineUniversum).toBe(false);
    expect(je(file, 'AAA').taktik).toMatchObject({ quelle: 'champion', einstiege: 'erlaubt', imEngineUniversum: true });
    expect(je(file, 'AAA').taktik.grund).toMatch(/Alpha-Champion cross_sectional_momentum \(Score 1\.50, 80 OOS-Trades/);
  });

  it('bestandene Basis: Korb im Engine-Universum, Einstiege erlaubt, Grund = Notiz des Kerns; Schalter aus ⇒ gesperrt', () => {
    const an = profil(app({ champion: champion(block()) }));
    expect(je(an, 'TLT').taktik).toMatchObject({ quelle: 'basis', einstiege: 'erlaubt', imEngineUniversum: true });
    expect(je(an, 'TLT').taktik.grund).toMatch(/Basis-Allokation „Basis V3": 9 Symbole/);
    const aus = profil(app({ champion: champion(block()), basisSchalter: false }));
    expect(je(aus, 'TLT').taktik).toMatchObject({ quelle: 'basis', einstiege: 'gesperrt' });
    expect(je(aus, 'TLT').taktik.grund).toMatch(/Schalter aus/);
  });

  it('Korb-Symbol außerhalb des Kandidatenpools (M11) und Benchmark ohne Wahl: keine Taktik, mit Grund', () => {
    const a = app({ champion: champion(block()), candidates: ['SPY', 'AAA', 'BBB', 'CCC', 'IWM', 'EFA', 'EEM', 'IEF', 'TLT', 'LQD', 'GLD'] });
    const file = profil(a);
    expect(strategyChoice(a, 'XLRE')).toBeNull();
    expect(je(file, 'XLRE').taktik).toMatchObject({ quelle: 'keine' });
    expect(je(file, 'XLRE').taktik.grund).toMatch(/außerhalb des Kandidatenpools/);
    const ohne = profil(app({ champion: null, symbols: ['AAA'] }));
    expect(je(ohne, 'SPY').taktik).toMatchObject({ quelle: 'keine' });
    expect(je(ohne, 'SPY').taktik.grund).toMatch(/Benchmark — wird geladen, nie gehandelt/);
    expect(je(ohne, 'AAA').taktik.grund).toMatch(/kein Champion/);
  });
});

describe('WÄCHTER 4 — Haltedauer nur aus gemessenen Kennzahlen', () => {
  it('der Champion trägt keine Haltedauer ⇒ null und „unbekannt" — bei Alpha wie Basis; ohne Taktik „keine"', () => {
    const file = profil(app({ champion: champion(block(), { alpha: ['AAA'], noTrade: ['CCC'] }) }));
    for (const p of file.profile) expect(p.haltedauer.medianHandelstage, p.symbol).toBeNull();
    expect(je(file, 'AAA').haltedauer.quelle).toMatch(/^unbekannt/);
    expect(je(file, 'GLD').haltedauer.quelle).toMatch(/^unbekannt/);
    expect(je(file, 'CCC').haltedauer.quelle).toMatch(/keine Taktik/);
  });
});

describe('Kennzahlen mit Quelle', () => {
  const a = app({ champion: champion(block(), { alpha: ['AAA', 'BBB'], noTrade: ['CCC'] }) });
  const file = profil(a);

  it('Volatilität, Momentum und Regime kommen aus regime_allocation.precompute mit den Parametern des Basis-Blocks', () => {
    const bars = SERIEN.get('GLD')!;
    const ind = regimeAllocation.precompute(bars, { ...regimeAllocation.defaults, ...block().params });
    const i = bars.length - 1;
    const p = je(file, 'GLD');
    expect(p.volatilitaet.pct).toBeCloseTo(ind.rvol![i]! * 100, 9);
    expect(p.momentum).toMatchObject({ pct: ind.mom![i]! * 100, lookback: 126, skip: 21 });
    expect(p.trend).toMatchObject({ richtung: 'auf', regimeLen: 150, sma: ind.sma![i]! });
    expect(p.trend.seitBars).toBeGreaterThan(100);
    expect(je(file, 'EEM').trend.richtung).toBe('ab');
    expect(file.params).toMatchObject({ lookback: 126, skip: 21, regimeLen: 150 });
  });

  it('Stop: Basis aus stopPct, Alpha aus atrMult × ATR der Strategie-Indikatoren, ohne Taktik null', () => {
    expect(je(file, 'GLD').stop).toMatchObject({ pct: 20 });
    expect(je(file, 'GLD').stop.quelle).toMatch(/stopPct/);
    const bars = SERIEN.get('AAA')!;
    const i = bars.length - 1;
    const c = strategyChoice(a, 'AAA')!;
    const erwartet = ((c.params.atrMult! * atr(bars.h, bars.l, bars.c, c.params.atrLen!)[i]!) / bars.c[i]!) * 100;
    expect(je(file, 'AAA').stop.pct).toBeCloseTo(erwartet, 9);
    expect(je(file, 'AAA').stop.quelle).toMatch(/atrMult/);
    expect(je(file, 'CCC').stop).toEqual({ pct: null, quelle: 'keine Taktik — kein Stop' });
  });

  it('Liquidität ist die Kennzahl der nächtlichen Wahl (bewerte aus universe/select.ts)', () => {
    const roh = bewerte('GLD', SERIEN.get('GLD')!.toBars(), universeRegelnFuer(a.config.universe.maxSymbols), NACH_LETZTER);
    expect(je(file, 'GLD').liquiditaet).toMatchObject({ dollarVolumenTag: roh.dollarVolumen, tage: 60, fensterTage: 60, handelbar: true, grund: null });
    expect(roh.dollarVolumen).toBeGreaterThan(2_000_000);
  });

  it('letzte Bewertung: Alpha aus decidedAt, Basis aus measuredAt + configCommit, noTrade aus dessen decidedAt; der Lauf steht EINMAL im Kopf (M2)', () => {
    expect(je(file, 'AAA').bewertung).toEqual({ configCommit: null, measuredAt: 1_700_100_000_000, quelle: expect.stringMatching(/decidedAt/) });
    expect(je(file, 'GLD').bewertung).toEqual({ configCommit: 'abc1234', measuredAt: 1_700_000_000_000, quelle: expect.stringMatching(/measuredAt/) });
    expect(je(file, 'CCC').bewertung).toMatchObject({ measuredAt: 1_700_150_000_000 });
    for (const p of file.profile) expect(Object.keys(p.bewertung).sort()).toEqual(['configCommit', 'measuredAt', 'quelle']);
    expect(file.lauf).toEqual(LAUF);
    expect(file.championUpdatedAt).toBe(1_700_200_000_000);
  });

  it('Datei: Version 1, now = Datenschnitt, Tabelle mit Kopfzeile je Symbol', () => {
    expect(file.version).toBe(1);
    expect(file.now).toBe(NACH_LETZTER);
    expect(file.timeframe).toBe(1440);
    expect(file.benchmark).toBe('SPY');
    const rows = profilTabelle(file);
    expect(rows.length).toBe(file.profile.length + 1);
    expect(rows[0]![0]).toBe('Symbol');
    expect(rows.find((r) => r[0] === 'GLD')![2]).toBe('basis: regime_allocation');
  });

  it('ohne Bars: Kennzahlen null, Liquidität ohne Daten, keine Ausnahme', () => {
    const leer = profil(a, { barsFor: () => BarSeries.empty() });
    const p = je(leer, 'GLD');
    expect(p.stand).toEqual({ t: null, close: null, bars: 0 });
    expect(p.volatilitaet.pct).toBeNull();
    expect(p.trend.richtung).toBeNull();
    expect(p.rang).toBeNull();
    expect(p.liquiditaet.handelbar).toBe(false);
  });

  it('Intraday-Config: Taktik weiter aus der Wahl, aber kein Rang und kein ATR-Stop (Profil rechnet auf Tagesbars, die Engine nicht — M4)', () => {
    const ch = champion(block({ timeframe: 5 }), { alpha: [] });
    ch.symbols.AAA = alphaEntry({ strategy: 'trend_donchian', params: { atrLen: 14, atrMult: 2 }, timeframe: 5 });
    const intraday = app({ champion: ch, timeframe: 5 });
    const f = profil(intraday);
    expect(f.timeframe).toBe(5);
    expect(je(f, 'GLD').rang).toBeNull();
    expect(je(f, 'GLD').stop).toMatchObject({ pct: 20 }); // stopPct ist ein Parameter, kein Indikator — gilt auf jedem Zeitrahmen
    const aaa = je(f, 'AAA');
    expect(aaa.taktik).toMatchObject({ quelle: 'champion', strategie: 'trend_donchian' });
    expect(aaa.rang).toBeNull();
    expect(aaa.stop.pct).toBeNull();
    expect(aaa.stop.quelle).toMatch(/Intraday-Zeitrahmen/);
    // Auf Tagesbars trägt dieselbe Wahl den ATR-Stop — der Unterschied ist der Zeitrahmen, nicht die Strategie.
    const tages = champion(block(), { alpha: [] });
    tages.symbols.AAA = alphaEntry({ strategy: 'trend_donchian', params: { atrLen: 14, atrMult: 2 } });
    expect(je(profil(app({ champion: tages })), 'AAA').stop.pct).toBeGreaterThan(0);
  });
});
