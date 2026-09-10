/**
 * Symbolprofil je Nacht — ANZEIGE und ERKLÄRUNG, kein Handel.
 *
 * Owner-Anweisung (09.09.2026, docs/wissen/symbolprofile.md): Taktiken,
 * Käufe, Verkäufe und Haltedauern je Symbol individuell ableiten und
 * bewerten. Die Antwort dieses Repos ist kein Parametersuchlauf je Symbol
 * (das wäre die Lotterie aus These T10), sondern ein PROFIL aus Daten, aus
 * dem die Taktik regelbasiert folgt — und das Profil sagt, was die Engine
 * für dieses Symbol tut und warum.
 *
 * ── Drei Regeln, die dieses Modul einhält ─────────────────────────────────
 *
 *  1. Es entscheidet nichts. Die Taktik je Symbol ist wörtlich die Wahl der
 *     Engine (`choiceFor` — `strategyForFn(app)` im eigenen Prozess bzw.
 *     `buildStrategyFor(...).fn` auf der Plattform, beide über
 *     `core/basisTier.ts`). Hier gibt es keine zweite Reihenfolge
 *     „Champion vor Basis vor nichts" — eine Kopie davon wäre genau der
 *     Messfehler aus CLAUDE.md §0.1, nur in der Anzeige.
 *  2. Es rechnet nichts nach, was es importieren kann. Volatilität, Momentum
 *     und Regime-Mittel kommen aus `regime_allocation.precompute` (dieselbe
 *     `rvol`/`mom`/`sma` wie die Strategie), der Rang aus `korbRaenge()` in
 *     `core/logic.ts` (dieselbe Rangbildung wie `decide()`), die Liquidität
 *     aus `bewerte()` in `universe/select.ts` (dieselbe Kennzahl wie die
 *     nächtliche Wahl), die Stop-Distanz aus den Indikatoren der Strategie.
 *  3. Es ist kausal. Nur Bars, deren SITZUNG bei `now` geschlossen ist —
 *     Schnitt am Sitzungsschluss, nicht am Bucket-Beginn (`Bar.t`); die
 *     Tagesbar, die bei `now` gerade läuft, ist nicht gesehen. Der Aufrufer
 *     (`seriesForTimeframe`) schneidet ohnehin so; der zweite Schnitt hier
 *     macht das Modul auch mit rohen Cache-Serien kausal. Präfix-Konsistenz
 *     ist Testpflicht (`test/profile/symbolprofile.test.ts`): Das Profil aus
 *     `bars.prefix(i+1)` ist das Profil aus `bars` mit `now` = Schluss von
 *     Bar i. Ein Stichtag (`optimize --as-of`) ist derselbe Schnitt und steht
 *     als `asOf` in der Datei.
 *
 *  Was das Profil NICHT ist: die Sicht eines einzelnen Nutzers. Es rechnet
 *  auf dem Korb der PLATTFORM (Config-Universum ∪ Basis-Korb). Ein Nutzer mit
 *  Teilauswahl (`settings.auto.symbols`) hat in seiner Engine einen kleineren
 *  Alpha-Korb und damit andere Ränge — deshalb nennt jeder Rang seine
 *  Korbmitglieder, und das Frontend beschriftet ihn als Plattform-Korb. Der
 *  Basis-Korb kommt für jeden Nutzer als Block (`universeWithBasis`), seine
 *  Ränge gelten für alle. Nutzer-Deckel (`maxPositionPct`), Sperren und
 *  Not-Aus je Konto stehen nicht im Profil.
 *  Auf einem Intraday-Zeitrahmen rechnet das Profil weiter auf Tagesbars: Rang
 *  und ATR-Stop bleiben dann leer, weil die Engine sie auf anderen Bars
 *  rechnet — eine Zahl daraus wäre eine zweite, falsche Zahl.
 *
 * Was NICHT erfunden wird: Die erwartete Haltedauer. Sie ist eine gemessene
 * Größe der Taktik (Median der Haltedauer in der OOS-Kette). Weder der
 * Champion-Eintrag (`ChampionEntry.oos`) noch der Basis-Block (`ChampionBasis`)
 * tragen sie heute — `BasisKennzahlen.avgHoldingDays` steht nur im Lauf und im
 * Bericht. Solange der Champion sie nicht trägt, heißt das Feld „unbekannt".
 *
 * Speicherort: `<home>/profile.json` (eigener Prozess, `autotrd profile` und
 * am Ende von `autotrd optimize`); Plattform `meta/symbolProfile`
 * (`scripts/publish-profile.mjs`). Jedes Feld trägt Einheit und Quelle in
 * seinem JSDoc — Regel 1 der Wissensbibliothek: Jede Zahl verweist auf einen
 * Lauf.
 */
import { basisStatus } from '../core/basisTier.ts';
import type { Config } from '../core/config.ts';
import { korbRaenge, korbSchluessel, type SymbolInput } from '../core/logic.ts';
import { buildSessionInfo } from '../core/session.ts';
import { DAY, dayKey, dayKeyFor, sessionBounds, type Calendar } from '../core/time.ts';
import type { AssetClass, Bar, BarSeriesLike, IndicatorSet, Ms, Params, SizingSpec, Strategy, TimeframeMin } from '../core/types.ts';
import type { ChampionFile } from '../optimize/promote.ts';
import { indAt } from '../strategy/indicators.ts';
import { mergeParams } from '../strategy/params.ts';
import { strategy as regimeAllocation, VOL_LEN } from '../strategy/regimeAllocation.ts';
import { bewerte, universeRegelnFuer } from '../universe/select.ts';

export const PROFILE_VERSION = 1;
/** Dateiname im State-Verzeichnis (`<home>/profile.json`). */
export const PROFILE_FILE = 'profile.json';

/* ───────────────────────── Feste Zuordnungen (keine externen Daten) ───────────────────────── */

/**
 * Anlageklasse der Basis-ETFs — die GTAA-Klassen des vorregistrierten
 * Basis-Korbs (`optimizer.basisUniverse` in config/basis-1440-v3.yaml,
 * docs/wissen/vorregistrierung/2026-09-09-basis-allokation-v2.md).
 */
export const BASIS_KLASSEN: Readonly<Record<string, string>> = Object.freeze({
  SPY: 'Aktien USA (groß)',
  IWM: 'Aktien USA (klein)',
  EFA: 'Aktien Industrieländer ex USA',
  EEM: 'Aktien Schwellenländer',
  IEF: 'US-Staatsanleihen 7–10 J.',
  TLT: 'US-Staatsanleihen 20+ J.',
  LQD: 'Unternehmensanleihen (IG)',
  GLD: 'Gold',
  XLRE: 'Immobilien (REITs)',
});

/** Übrige ETFs des Kandidatenpools (`config/platform.yaml`, Block „Breite Index- und Sektor-ETFs"). */
export const ETF_KLASSEN: Readonly<Record<string, string>> = Object.freeze({
  QQQ: 'Aktien USA (Nasdaq-100)',
  DIA: 'Aktien USA (Dow)',
  XLF: 'Sektor Finanzen',
  XLE: 'Sektor Energie',
  XLK: 'Sektor Technologie',
  XLV: 'Sektor Gesundheit',
  XLI: 'Sektor Industrie',
  XLY: 'Sektor zyklischer Konsum',
  XLP: 'Sektor Basiskonsum',
  XLU: 'Sektor Versorger',
  XLB: 'Sektor Grundstoffe',
  XLC: 'Sektor Kommunikation',
  SMH: 'Halbleiter',
  SOXX: 'Halbleiter',
  SLV: 'Silber',
  HYG: 'Hochzinsanleihen',
});

/**
 * Sektor je Einzelaktie — statisch aus den Blöcken des Kandidatenpools in
 * `config/platform.yaml` (dort stehen sie als Kommentar). Kein Symbol
 * außerhalb des Pools; ein unbekanntes Symbol ist schlicht „Aktie" ohne
 * Sektor. Bewusst keine externe Quelle.
 */
const SEKTOR_BLOECKE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Technologie und Halbleiter', ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'GOOG', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'CRM', 'ORCL', 'ADBE', 'INTC', 'CSCO', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'KLAC', 'ADI', 'MRVL', 'ANET', 'NOW', 'IBM', 'INTU', 'PANW', 'CRWD', 'DDOG', 'SNOW', 'UBER', 'ABNB', 'PYPL', 'SPOT', 'DELL']],
  ['Finanzen', ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'BLK', 'AXP', 'V', 'MA', 'COF', 'USB', 'PNC', 'BRK.B']],
  ['Energie', ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'OXY', 'VLO']],
  ['Gesundheit', ['JNJ', 'PFE', 'UNH', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'BMY', 'AMGN', 'GILD', 'CVS', 'MDT', 'ISRG', 'VRTX', 'REGN']],
  ['Konsum', ['WMT', 'DIS', 'HD', 'MCD', 'NKE', 'SBUX', 'COST', 'TGT', 'LOW', 'PG', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'CL']],
  ['Industrie und Transport', ['BA', 'CAT', 'DE', 'GE', 'HON', 'LMT', 'RTX', 'UPS', 'UNP', 'MMM', 'FDX']],
  ['Kommunikation und Versorger', ['T', 'VZ', 'TMUS', 'CMCSA', 'CHTR', 'NEE', 'DUK', 'SO']],
  ['Fahrzeuge', ['F', 'GM']],
];

export const SEKTOREN: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SEKTOR_BLOECKE.flatMap(([sektor, symbole]) => symbole.map((s) => [s, sektor] as const))),
);

/**
 * Parameter, mit denen das Profil Volatilität, Momentum und Regime rechnet,
 * wenn der Champion keinen Basis-Block mit `regime_allocation` trägt: die
 * Vorregistrierung Basis V3 (Momentum 126/21, Regime-Mittel 150) über den
 * Strategie-Defaults. Trägt der Champion einen Block, gelten DESSEN Parameter
 * — das Profil rechnet dann mit denselben Zahlen wie die Engine.
 */
export const PROFIL_PARAMS_FALLBACK: Readonly<Params> = Object.freeze({ lookback: 126, skip: 21, regimeLen: 150 });

/* ───────────────────────── Typen ───────────────────────── */

/** Was die Engine je Symbol bekommt (`EngineStrategyChoice` in app.ts, `StrategyChoice` in functions/strategyFor.ts) — strukturell. */
export interface ProfilWahl {
  strategy: Strategy;
  params: Params;
  /** `champion` · `basis` · `config`; fehlt sie, gilt „unbekannte Quelle". */
  source?: string | undefined;
  sizing?: SizingSpec | undefined;
  entriesAllowed?: boolean | undefined;
  entryLockReason?: string | undefined;
}

/** Der Lauf, der das Profil geschrieben hat — Rückverfolgbarkeit (Regel 1 der Bibliothek). */
export interface ProfilLauf {
  /** GitHub-Actions-Run-Nummer (`GITHUB_RUN_NUMBER`, die „#41" in docs/wissen/befunde.md); lokal null. */
  nummer: number | null;
  /** `GITHUB_RUN_ID`; lokal null. */
  id: string | null;
  /** Commit der Config, mit der der Lauf rechnete (`GITHUB_SHA`); lokal null. */
  configCommit: string | null;
}

export type TaktikQuelle = 'champion' | 'basis' | 'config' | 'keine';

export interface SymbolProfil {
  symbol: string;
  /** Feste Zuordnung (BASIS_KLASSEN, ETF_KLASSEN, SEKTOREN) — Quelle: dieses Modul, keine externen Daten. */
  klasse: {
    /** Anlageklasse (Basis-ETF: GTAA-Klasse; Pool-ETF: Index/Sektor; sonst „Aktie"). */
    klasse: string;
    cluster: 'basis_etf' | 'etf' | 'aktie';
    /** Sektor der Einzelaktie aus der Pool-Tabelle; null bei ETFs und unbekannten Symbolen. */
    sektor: string | null;
    /** Ist das Symbol die Benchmark der Config (wird geladen, nie gehandelt)? */
    benchmark: boolean;
  };
  /** Letzte geschlossene Bar, die das Profil gesehen hat (Bucket-Beginn, Epoch-ms) — Quelle: `barsFor`. */
  stand: { t: Ms | null; close: number | null; bars: number };
  /** Realisierte Volatilität in % p. a. über VOL_LEN Bars — Quelle: `regime_allocation.precompute().rvol` × 100. null in der Aufwärmphase. */
  volatilitaet: { pct: number | null; fensterBars: number; quelle: string };
  /**
   * Trendzustand: Schluss über (`auf`) oder unter (`ab`) dem gleitenden Mittel
   * über `regimeLen` Bars — Quelle: `regime_allocation.precompute().sma`;
   * `seitBars` = Länge der ununterbrochenen Serie gleichen Vorzeichens bis
   * zum Stand (1 = erst diese Bar).
   */
  trend: { richtung: 'auf' | 'ab' | null; seitBars: number | null; sma: number | null; regimeLen: number; quelle: string };
  /** Momentum in %: Rendite über `lookback` Bars, endend `skip` Bars vor dem Stand — Quelle: `regime_allocation.precompute().mom` × 100. */
  momentum: { pct: number | null; lookback: number; skip: number; quelle: string };
  /**
   * Rang im Korb der Wahl — Quelle: `korbRaenge()` aus core/logic.ts, dieselbe
   * Rangbildung wie `decide()` (Korb = Symbole mit derselben Strategie, denselben
   * Parametern und derselben Sizing-Semantik; 1 = stärkstes). null ohne
   * Querschnitts-Taktik, in der Aufwärmphase, mit veralteter letzter Bar oder
   * auf einem Intraday-Zeitrahmen. `symbole` = die Mitglieder dieses Korbs nach
   * Rang — der Korb der PLATTFORM; ein Nutzer mit Teilauswahl hat in seiner
   * Engine einen anderen Alpha-Korb und damit andere Ränge (Modulkopf).
   */
  rang: { rank: number; of: number; pct: number; korb: TaktikQuelle; symbole: string[] } | null;
  /** Stop-Distanz in % vom Schluss — Quelle: `stopPct` der Parameter (Basis) oder `atrMult` × ATR aus den Indikatoren der Strategie (Alpha, nur auf Tagesbars); sonst null. */
  stop: { pct: number | null; quelle: string };
  /** Liquidität — Quelle: `bewerte()` aus universe/select.ts (Median-Dollarumsatz je Tag über `fensterTage` Bars, dieselben Filter wie nachts). */
  liquiditaet: { dollarVolumenTag: number; tage: number; fensterTage: number; letzterKurs: number; alterTage: number; handelbar: boolean; grund: string | null };
  /** Zugewiesene Taktik — wörtlich die Wahl der Engine (`choiceFor`), Grund wie in core/basisTier.ts bzw. strategyChoice. */
  taktik: {
    quelle: TaktikQuelle;
    strategie: string | null;
    params: Params | null;
    sizing: SizingSpec | null;
    /** `erlaubt` · `gesperrt` (Wahl ohne Einstiegsrecht — Bestand wird geführt) · null ohne Taktik. */
    einstiege: 'erlaubt' | 'gesperrt' | null;
    grund: string;
    /** Steht das Symbol im Universum der Engine (Config ∪ Basis-Korb, wenn geführt)? Sonst führt sie es nicht — auch mit Wahl. */
    imEngineUniversum: boolean;
  };
  /** Erwartete Haltedauer in Handelstagen — NUR aus gemessenen Kennzahlen des Champions; heute trägt er keine ⇒ null, „unbekannt". */
  haltedauer: { medianHandelstage: number | null; quelle: string };
  /**
   * Letzte Bewertung — Messzeitpunkt und Config-Commit aus dem Champion
   * (`decidedAt` bzw. `measuredAt`/`configCommit`). Der Lauf, der das PROFIL
   * schrieb, steht einmal in `SymbolProfileFile.lauf` — bewusst nicht hier,
   * sonst läse man die Lauf-Nummer von heute neben einem Urteil vom Vorjahr.
   */
  bewertung: { configCommit: string | null; measuredAt: Ms | null; quelle: string };
}

export interface SymbolProfileFile {
  version: 1;
  /** Wanduhr beim Schreiben (Epoch-ms). */
  generatedAt: Ms;
  /** Datenschnitt: keine Bar, deren Sitzung nach diesem Zeitpunkt schließt (Epoch-ms). */
  now: Ms;
  /** Stichtag einer Messung (`optimize --as-of`): dann ist `now` dieser Stichtag. null im Betrieb. */
  asOf: Ms | null;
  timeframe: TimeframeMin;
  benchmark: string | null;
  lauf: ProfilLauf;
  /** Parameter der Kennzahlen (Momentum/Regime) und ihre Herkunft. */
  params: { lookback: number; skip: number; regimeLen: number; quelle: string };
  /** Zeitpunkt der Champion-Datei (`updatedAt`); null ohne Champion. */
  championUpdatedAt: Ms | null;
  profile: SymbolProfil[];
}

export interface SymbolProfileArgs {
  config: Config;
  champion: ChampionFile | null;
  /** Die Wahl der Engine je Symbol — `strategyForFn(app)` bzw. `buildStrategyFor(...).fn`. Nie eine eigene Ableitung. */
  choiceFor: (symbol: string) => ProfilWahl | null;
  /** Geschlossene Tagesbars im Strategie-Zeitrahmen, wie Backtest und Optimierer sie sehen (`seriesForTimeframe`). */
  barsFor: (symbol: string) => BarSeriesLike;
  /** Rohe Tagesbars aus dem Cache (mit `vw`) für die Liquidität wie `autotrd universe`; fehlt es, rechnet `bewerte` mit Schluss × Volumen aus `barsFor`. */
  tagesbarsFor?: ((symbol: string) => readonly Bar[]) | undefined;
  /** Universum der ENGINE (`engineConfig(app, held).universe.symbols`); fehlt es, gilt `config.universe.symbols`. */
  engineUniverse?: readonly string[] | undefined;
  calendar?: Calendar | undefined;
  /** Datenschnitt (Epoch-ms). */
  now: Ms;
  /** Stichtag der Messung (`app.asOf`), wenn das Profil aus `optimize --as-of` stammt. */
  asOf?: Ms | undefined;
  lauf: ProfilLauf;
  /** Wanduhr; Standard `Date.now()` — Tests setzen sie, damit Dateien vergleichbar bleiben. */
  generatedAt?: Ms | undefined;
}

/* ───────────────────────── Bausteine ───────────────────────── */

/** Sitzungsschluss der Tagesbar mit Bucket-Beginn `t`; ohne Kalendereintrag (Streuner, Feiertag) ein Tag nach dem Beginn. */
export function sitzungsSchluss(t: Ms, assetClass: AssetClass, calendar?: Calendar): Ms {
  const bounds = sessionBounds(dayKeyFor(t, assetClass), assetClass, calendar);
  return bounds ? bounds.close : t + DAY;
}

/**
 * Alle Bars, deren Sitzung bei `now` GESCHLOSSEN ist — ein Präfix, teilt den
 * Speicher. Schnitt am Sitzungsschluss, nicht am Bucket-Beginn: `Bar.t` ist
 * der Beginn, und die Bar, die bei `now` gerade läuft, ist nicht gesehen.
 * Rückwärts gesucht, weil im Betrieb höchstens die letzte Bar offen ist.
 */
export function geschlossenBis(bars: BarSeriesLike, now: Ms, assetClass: AssetClass, calendar?: Calendar): BarSeriesLike {
  let n = bars.length;
  while (n > 0 && sitzungsSchluss(bars.t[n - 1]!, assetClass, calendar) > now) n--;
  return bars.prefix(n);
}

/** Dasselbe für rohe Cache-Bars (Liquidität): nur Bars mit geschlossener Sitzung, aufsteigend sortiert vorausgesetzt. */
export function geschlosseneBars(bars: readonly Bar[], now: Ms, assetClass: AssetClass, calendar?: Calendar): readonly Bar[] {
  let n = bars.length;
  while (n > 0 && sitzungsSchluss(bars[n - 1]!.t, assetClass, calendar) > now) n--;
  return n === bars.length ? bars : bars.slice(0, n);
}

/** Universum des Profils: Alpha-Korb (Config) ∪ Basis-Korb (Champion-Block) ∪ Benchmark, alphabetisch. */
export function profilUniversum(config: Config, champion: ChampionFile | null): string[] {
  const set = new Set<string>(config.universe.symbols);
  for (const s of champion?.basis?.symbols ?? []) set.add(s);
  if (config.universe.benchmark) set.add(config.universe.benchmark);
  return [...set].sort();
}

/** Parameter der Profil-Kennzahlen: der Basis-Block des Champions (wenn `regime_allocation`), sonst die Vorregistrierung V3. */
export function profilParams(champion: ChampionFile | null): { params: Params; quelle: string } {
  const basis = champion?.basis;
  if (basis && basis.strategy === regimeAllocation.id) {
    return { params: mergeParams(regimeAllocation.defaults, basis.params), quelle: `Basis-Block „${basis.label}" des Champions (regime_allocation)` };
  }
  return { params: mergeParams(regimeAllocation.defaults, PROFIL_PARAMS_FALLBACK), quelle: 'Vorregistrierung Basis V3 (Momentum 126/21, Regime-Mittel 150) — kein Basis-Block im Champion' };
}

export function klasseVon(symbol: string, benchmark: string | undefined): SymbolProfil['klasse'] {
  const bench = symbol === benchmark;
  const basis = BASIS_KLASSEN[symbol];
  if (basis !== undefined) return { klasse: basis, cluster: 'basis_etf', sektor: null, benchmark: bench };
  const etf = ETF_KLASSEN[symbol];
  if (etf !== undefined) return { klasse: etf, cluster: 'etf', sektor: null, benchmark: bench };
  return { klasse: bench ? 'Benchmark' : 'Aktie', cluster: 'aktie', sektor: SEKTOREN[symbol] ?? null, benchmark: bench };
}

/** Länge der ununterbrochenen Serie gleichen Vorzeichens (Schluss gegen Mittel) bis Index i; 0, wenn an i kein Urteil möglich. */
function trendSeit(close: ArrayLike<number>, sma: ArrayLike<number>, i: number): { richtung: 'auf' | 'ab' | null; seitBars: number | null } {
  const zeichen = (k: number): 'auf' | 'ab' | null => {
    const c = close[k];
    const m = sma[k];
    if (c === undefined || m === undefined || !Number.isFinite(c) || !Number.isFinite(m)) return null;
    return c > m ? 'auf' : c < m ? 'ab' : null;
  };
  const richtung = zeichen(i);
  if (richtung === null) return { richtung: null, seitBars: null };
  let seit = 1;
  for (let k = i - 1; k >= 0 && zeichen(k) === richtung; k--) seit++;
  return { richtung, seitBars: seit };
}

function taktikQuelle(choice: ProfilWahl | null): TaktikQuelle {
  if (!choice) return 'keine';
  return choice.source === 'champion' || choice.source === 'basis' || choice.source === 'config' ? choice.source : 'keine';
}

const f2 = (x: number): string => x.toFixed(2);

/**
 * Warum die Engine dieses Symbol (nicht) handelt — die Texte des Kerns
 * (`basisStatus`, `entryLockReason`, `noTrade.reason`), keine eigenen Urteile.
 */
function taktikGrund(a: { symbol: string; choice: ProfilWahl | null; champion: ChampionFile | null; config: Config; imEngineUniversum: boolean }): string {
  const { symbol, choice, champion, config } = a;
  const nachsatz = a.imEngineUniversum ? '' : ' — nicht im Universum der Engine, wird dort nicht geführt';
  if (choice) {
    const q = taktikQuelle(choice);
    if (q === 'champion') {
      const e = champion?.symbols[symbol];
      const detail = e ? ` (Score ${f2(e.score)}, ${e.oos.trades} OOS-Trades, entschieden ${dayKey(e.decidedAt)})` : '';
      return `Alpha-Champion ${choice.strategy.id}${detail}${nachsatz}`;
    }
    if (q === 'basis') {
      if (choice.entriesAllowed === false) return `${choice.entryLockReason ?? 'Basis-Allokation ohne Einstiegsrecht — keine neuen Einstiege'}${nachsatz}`;
      const status = basisStatus({ champion, timeframe: config.timeframe, enabled: config.strategy.basis, pool: config.universe.candidates, maxPositionPct: config.risk.maxPositionPct });
      return `${status.tradable ? status.note : `Basis-Allokation ${choice.strategy.id}`}${nachsatz}`;
    }
    if (q === 'config') return `Config-Strategie ${choice.strategy.id} (strategy.allowWithoutChampion)${nachsatz}`;
    return `Strategie ${choice.strategy.id} (Quelle ${choice.source ?? 'unbekannt'})${nachsatz}`;
  }
  // Der Benchmark wird geladen, nie gehandelt — es sei denn, er steht selbst im
  // Universum (SPY auf der Plattform): dann gilt für ihn, was für jedes Symbol gilt.
  const bench = symbol === config.universe.benchmark;
  if (bench && !config.universe.symbols.includes(symbol)) return 'Benchmark — wird geladen, nie gehandelt';
  const zusatz = bench ? ' (zugleich Benchmark)' : '';
  const nt = champion?.noTrade[symbol];
  if (nt) return `noTrade: ${nt.reason} (entschieden ${dayKey(nt.decidedAt)})${zusatz}`;
  if (!champion) return `kein Champion (champion.json fehlt)${config.strategy.allowWithoutChampion ? '' : ' und strategy.allowWithoutChampion=false'} — wird nicht gehandelt${zusatz}`;
  if (champion.basis?.symbols.includes(symbol)) {
    const status = basisStatus({ champion, timeframe: config.timeframe, enabled: config.strategy.basis, pool: config.universe.candidates, maxPositionPct: config.risk.maxPositionPct });
    if (!status.tradable && status.reason !== null) return status.reason;
    if (status.tradable && status.verworfen.includes(symbol)) return `Basis-Korb-Symbol außerhalb des Kandidatenpools (universe.candidates) — nicht geführt, nicht gehandelt`;
  }
  const entry = champion.symbols[symbol];
  if (entry && entry.timeframe !== config.timeframe) return `Champion-Zeitrahmen ${entry.timeframe} ≠ Config ${config.timeframe} — nicht gehandelt`;
  return `kein Urteil im Champion (Symbol nicht gemessen) — wird nicht gehandelt${zusatz}`;
}

/**
 * Stop-Distanz der Wahl in % vom Schluss — aus den Parametern (stopPct) oder
 * den Indikatoren der Strategie (atrMult × ATR); nie geschätzt. Der ATR-Stop
 * gilt nur auf Tagesbars (`tagesbars`): Auf einem Intraday-Zeitrahmen rechnet
 * die Engine den ATR auf ihren Bars, das Profil auf Tagesbars — die Zahl
 * wäre ein Vielfaches der echten und hieße trotzdem „ATR am Stand".
 */
export function stopDistanz(choice: ProfilWahl | null, ind: IndicatorSet | null, close: number | null, i: number, tagesbars: boolean): SymbolProfil['stop'] {
  if (!choice) return { pct: null, quelle: 'keine Taktik — kein Stop' };
  const p = choice.params;
  const stopPct = p.stopPct;
  if (typeof stopPct === 'number' && Number.isFinite(stopPct)) {
    return { pct: stopPct, quelle: `stopPct der ${choice.strategy.id}-Parameter (Katastrophen-Stop beim Broker, nie nachgezogen)` };
  }
  const atrMult = p.atrMult;
  if (typeof atrMult === 'number' && Number.isFinite(atrMult)) {
    if (!tagesbars) {
      return { pct: null, quelle: `atrMult ${atrMult} × ATR — Intraday-Zeitrahmen: die Engine rechnet den ATR auf ihren Bars, das Profil auf Tagesbars; nicht abbildbar` };
    }
    const atrNow = ind ? indAt(ind, 'atr', i) : Number.NaN;
    if (close !== null && close > 0 && Number.isFinite(atrNow) && atrNow > 0) {
      return { pct: (atrMult * atrNow) / close * 100, quelle: `atrMult ${atrMult} × ATR der ${choice.strategy.id}-Indikatoren am Stand (Erststop; Trailing zieht nur im Plus nach)` };
    }
    return { pct: null, quelle: `atrMult ${atrMult} × ATR — ATR am Stand nicht verfügbar (Aufwärmphase)` };
  }
  return { pct: null, quelle: `${choice.strategy.id}: weder stopPct noch atrMult in den Parametern` };
}

/* ───────────────────────── Profil ───────────────────────── */

export function buildSymbolProfiles(a: SymbolProfileArgs): SymbolProfileFile {
  const { config, champion, now } = a;
  const tf = config.timeframe;
  const assetClass = config.universe.assetClass;
  const benchmark = config.universe.benchmark;
  const symbole = profilUniversum(config, champion);
  const engineUniverse = new Set(a.engineUniverse ?? config.universe.symbols);
  const regeln = universeRegelnFuer(config.universe.maxSymbols);
  const pp = profilParams(champion);
  // Das Profil rechnet auf Tagesbars. Indikatoren der WAHL (Rang, ATR-Stop) gibt
  // es nur, wenn die Engine dieselben Bars sieht — sonst wäre jede Zahl daraus
  // eine zweite, falsche Zahl (Modulkopf).
  const tagesbars = tf === 1440;

  // 1. Je Symbol: Bars mit geschlossener Sitzung bis `now`, Wahl der Engine, Indikatoren der Wahl.
  const stand = new Map<string, { bars: BarSeriesLike; choice: ProfilWahl | null; ind: IndicatorSet | null }>();
  for (const sym of symbole) {
    const bars = geschlossenBis(a.barsFor(sym), now, assetClass, a.calendar);
    const choice = a.choiceFor(sym);
    const ind = tagesbars && choice && bars.length > 0 ? choice.strategy.precompute(bars, choice.params) : null;
    stand.set(sym, { bars, choice, ind });
  }

  // 2. Rang — EINMAL über alle Symbole mit Wahl, mit derselben Funktion wie
  //    `decide()`, auf dem Korb der Plattform (Modulkopf).
  const inputs: SymbolInput[] = [];
  if (tagesbars) {
    for (const sym of symbole) {
      const s = stand.get(sym)!;
      if (!s.choice || !s.ind || s.bars.length === 0) continue;
      const i = s.bars.length - 1;
      inputs.push({
        snap: { symbol: sym, bars: s.bars, i, position: null, session: buildSessionInfo(s.bars, i, tf, assetClass, a.calendar) },
        strategy: s.choice.strategy,
        params: s.choice.params,
        ind: s.ind,
        sizing: s.choice.sizing,
      });
    }
  }
  const raenge = korbRaenge(inputs);
  // Die Mitglieder je Korb nach Rang — derselbe Schlüssel wie in `korbRaenge`
  // (Strategie, Parameter, Sizing-Semantik), damit jeder Rang sagt, gegen wen
  // er gilt.
  const korbMitglieder = new Map<string, string[]>();
  for (const inp of inputs) {
    if (!raenge.has(inp.snap.symbol)) continue;
    const key = korbSchluessel(inp);
    const liste = korbMitglieder.get(key) ?? [];
    liste.push(inp.snap.symbol);
    korbMitglieder.set(key, liste);
  }
  for (const liste of korbMitglieder.values()) liste.sort((x, y) => raenge.get(x)!.rank - raenge.get(y)!.rank);
  const korbVon = new Map<string, string[]>();
  for (const inp of inputs) {
    const liste = korbMitglieder.get(korbSchluessel(inp));
    if (liste && raenge.has(inp.snap.symbol)) korbVon.set(inp.snap.symbol, liste);
  }

  // 3. Profil je Symbol.
  const profile: SymbolProfil[] = symbole.map((sym) => {
    const s = stand.get(sym)!;
    const { bars, choice } = s;
    const n = bars.length;
    const i = n - 1;
    const close = n > 0 ? bars.c[i]! : null;
    const kenn = n > 0 ? regimeAllocation.precompute(bars, pp.params) : null;
    const rvol = kenn ? indAt(kenn, 'rvol', i) : Number.NaN;
    const mom = kenn ? indAt(kenn, 'mom', i) : Number.NaN;
    const sma = kenn ? indAt(kenn, 'sma', i) : Number.NaN;
    const trend = kenn ? trendSeit(bars.c, kenn.sma!, i) : { richtung: null, seitBars: null };
    const rang = raenge.get(sym);
    // Liquidität aus den rohen Cache-Bars (mit `vw`), aber mit demselben Schnitt
    // wie die Kennzahlen: `bewerte` schneidet selbst nur am Bucket-Beginn, und
    // nach einem `fetch` während der Sitzung läge sonst die laufende Tagesbar
    // im Median und im letzten Kurs, während `stand` sie ausschließt.
    const roh = a.tagesbarsFor ? geschlosseneBars(a.tagesbarsFor(sym), now, assetClass, a.calendar) : bars.length > 0 ? Array.from({ length: n }, (_, k) => bars.at(k)) : [];
    const liq = bewerte(sym, roh, regeln, now);
    const quelle = taktikQuelle(choice);
    const imEngineUniversum = engineUniverse.has(sym);
    const entry = champion?.symbols[sym];
    const basis = champion?.basis;
    const nt = champion?.noTrade[sym];
    const bewertung: SymbolProfil['bewertung'] =
      quelle === 'champion' && entry
        ? { configCommit: null, measuredAt: entry.decidedAt, quelle: 'champion.symbols[symbol].decidedAt (Alpha-Einträge tragen keinen Config-Commit)' }
        : quelle === 'basis' && basis
          ? { configCommit: basis.configCommit ?? null, measuredAt: basis.measuredAt || null, quelle: 'champion.basis.measuredAt / configCommit' }
          : nt
            ? { configCommit: null, measuredAt: nt.decidedAt, quelle: 'champion.noTrade[symbol].decidedAt' }
            : { configCommit: null, measuredAt: champion?.updatedAt ?? null, quelle: champion ? 'champion.updatedAt (kein Eintrag für dieses Symbol)' : 'kein Champion' };
    return {
      symbol: sym,
      klasse: klasseVon(sym, benchmark),
      stand: { t: n > 0 ? bars.t[i]! : null, close, bars: n },
      volatilitaet: { pct: Number.isFinite(rvol) ? rvol * 100 : null, fensterBars: VOL_LEN, quelle: 'regime_allocation.precompute().rvol × 100 (annualisierte Standardabweichung der Tagesrenditen)' },
      trend: { richtung: trend.richtung, seitBars: trend.seitBars, sma: Number.isFinite(sma) ? sma : null, regimeLen: pp.params.regimeLen!, quelle: `regime_allocation.precompute().sma über regimeLen Bars — ${pp.quelle}` },
      momentum: { pct: Number.isFinite(mom) ? mom * 100 : null, lookback: pp.params.lookback!, skip: pp.params.skip!, quelle: `regime_allocation.precompute().mom × 100 — ${pp.quelle}` },
      rang: rang ? { rank: rang.rank, of: rang.of, pct: rang.pct, korb: quelle, symbole: [...(korbVon.get(sym) ?? [])] } : null,
      stop: stopDistanz(choice, s.ind, close, i, tagesbars),
      liquiditaet: {
        dollarVolumenTag: liq.dollarVolumen,
        tage: liq.tage,
        fensterTage: regeln.fensterTage,
        letzterKurs: liq.letzterKurs,
        alterTage: Number.isFinite(liq.alterTage) ? liq.alterTage : -1,
        handelbar: liq.ablehnung === null,
        grund: liq.ablehnung,
      },
      taktik: {
        quelle,
        strategie: choice ? choice.strategy.id : null,
        params: choice ? { ...choice.params } : null,
        sizing: choice?.sizing ? { ...choice.sizing } : null,
        einstiege: choice ? (choice.entriesAllowed === false ? 'gesperrt' : 'erlaubt') : null,
        grund: taktikGrund({ symbol: sym, choice, champion, config, imEngineUniversum }),
        imEngineUniversum,
      },
      haltedauer: gemesseneHaltedauer(quelle),
      bewertung,
    };
  });

  return {
    version: 1,
    generatedAt: a.generatedAt ?? Date.now(),
    now,
    asOf: a.asOf ?? null,
    timeframe: tf,
    benchmark: benchmark ?? null,
    lauf: a.lauf,
    params: { lookback: pp.params.lookback!, skip: pp.params.skip!, regimeLen: pp.params.regimeLen!, quelle: pp.quelle },
    championUpdatedAt: champion?.updatedAt ?? null,
    profile,
  };
}

/**
 * Erwartete Haltedauer — nur, was gemessen wurde. Der Champion trägt heute
 * keine Haltedauer: `ChampionEntry.oos` (OosAggregate) hat kein Feld dafür,
 * `ChampionBasis` auch nicht; `BasisKennzahlen.avgHoldingDays` steht nur im
 * Lauf und im Bericht. Also: null, mit Grund. Nichts wird geschätzt.
 */
export function gemesseneHaltedauer(quelle: TaktikQuelle): SymbolProfil['haltedauer'] {
  if (quelle === 'keine') return { medianHandelstage: null, quelle: 'keine Taktik — keine Haltedauer' };
  return {
    medianHandelstage: null,
    quelle:
      quelle === 'basis'
        ? 'unbekannt — der Basis-Block trägt keine gemessene Haltedauer (BasisKennzahlen.avgHoldingDays steht nur im Bericht); nichts wird geschätzt'
        : 'unbekannt — der Champion-Eintrag (oos) trägt keine gemessene Haltedauer; nichts wird geschätzt',
  };
}

/* ───────────────────────── Textform (CLI) ───────────────────────── */

const fmtPct = (x: number | null, digits = 1): string => (x === null ? '—' : `${x.toFixed(digits)} %`);

/** Tabellenzeilen für die CLI — Kopfzeile zuerst. */
export function profilTabelle(file: SymbolProfileFile): string[][] {
  const rows: string[][] = [['Symbol', 'Klasse', 'Taktik', 'Einstiege', 'Trend', 'Rang', 'Vol p.a.', 'Mom.', 'Stop', 'Umsatz/Tag', 'Haltedauer', 'Bewertung']];
  for (const p of file.profile) {
    const trend = p.trend.richtung === null ? '—' : `${p.trend.richtung === 'auf' ? '↑' : '↓'} seit ${p.trend.seitBars} Bars`;
    const rang = p.rang ? `${p.rang.rank}/${p.rang.of}` : '—';
    const liq = p.liquiditaet.tage === 0 ? '—' : `${(p.liquiditaet.dollarVolumenTag / 1e6).toFixed(1)} Mio.${p.liquiditaet.handelbar ? '' : ' ✘'}`;
    const halte = p.haltedauer.medianHandelstage === null ? 'unbekannt' : `${p.haltedauer.medianHandelstage} Tage`;
    const bew = p.bewertung.measuredAt ? dayKey(p.bewertung.measuredAt) : '—';
    rows.push([
      p.symbol,
      p.klasse.klasse + (p.klasse.sektor ? ` (${p.klasse.sektor})` : ''),
      p.taktik.quelle === 'keine' ? 'keine' : `${p.taktik.quelle}: ${p.taktik.strategie}`,
      p.taktik.einstiege ?? '—',
      trend,
      rang,
      fmtPct(p.volatilitaet.pct),
      fmtPct(p.momentum.pct),
      fmtPct(p.stop.pct),
      liq,
      halte,
      bew,
    ]);
  }
  return rows;
}
