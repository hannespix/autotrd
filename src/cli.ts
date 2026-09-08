#!/usr/bin/env node
/**
 * autotrd — Kommandozeile des Auto-Traders.
 *
 *   doctor     Config, Keys, Modus, Konto, Uhr, Assets, Cache, Champion prüfen
 *   universe   Handelsuniversum aus dem Kandidatenpool nach Liquidität wählen
 *   fetch      Kalender + Bars in den Cache laden (inkrementell)
 *   backtest   Champion/Default gegen den Cache simulieren
 *   optimize   Walk-Forward ⇒ champion.json + Report
 *   run        Engine starten (Streams, Timer) — Paper, solange der Guard nicht erfüllt ist
 *   status     Zustand aus state.json/Journal (+ Konto, wenn Keys da sind)
 *   flatten    Not-Aus: alle Orders stornieren, alle Positionen schließen, HALT setzen
 *   halt       HALT-Datei setzen (keine Einstiege, Exits laufen weiter)
 *   resume     HALT-Datei entfernen; Drawdown-Halt nur mit --ack-drawdown
 *   readiness  Live-Reife aus dem Journal
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createDataStream, createTradeStream } from './alpaca/stream.ts';
import { allSymbols, baseTimeframe, benchmarkSeries, bootstrap, requireClient, seriesForTimeframe, strategyChoice, strategyForFn, type App } from './app.ts';
import { simulate } from './backtest/simulator.ts';
import { ConfigError } from './core/config.ts';
import { ensureDir, writeJsonAtomic } from './core/journal.ts';
import { errMsg, logger } from './core/log.ts';
import { DAY, addDays, dayKey, dayKeyFor, msFromET, parseDay, toET } from './core/time.ts';
import type { Bar, Metrics, Params, Trade } from './core/types.ts';
import { backfill } from './data/backfill.ts';
import { ensureCalendar } from './data/calendar.ts';
import { Engine } from './engine/engine.ts';
import { createNotifier } from './notify/index.ts';
import { loadDefaultDeps, runOptimization } from './optimize/run.ts';
import { assessReadiness } from './readiness.ts';
import { startStatusServer } from './status/http.ts';
import { getStrategy, strategyIds } from './strategy/index.ts';
import { mergeParams, validateParams } from './strategy/params.ts';
import { ladeUniverseDatei, schreibeUniverseDatei } from './universe/file.ts';
import { renderUniverseReport } from './universe/report.ts';
import { UNIVERSE_REGELN, waehleUniverse, type UniverseRegeln } from './universe/select.ts';

const USAGE = `autotrd <kommando> [optionen]

Kommandos: doctor | universe | fetch | backtest | optimize | run | status | flatten | halt | resume | readiness

Gemeinsame Optionen:
  --config <pfad>    Config-Datei (Default: config/config.yaml)
  --env <pfad>       .env-Datei (Default: .env)
  --home <pfad>      State-Verzeichnis (Default: AUTOTRD_HOME bzw. paths.home)
  --verbose          Debug-Log
  --json             Maschinenlesbare Ausgabe (status, readiness, backtest, universe)
  --universe <pfad>  Auswahl des Kommandos universe anwenden ('auto' = <home>/universe.json)

backtest:  --strategy <id> --params a=1,b=2 --days <n> --symbols A,B --from YYYY-MM-DD --to YYYY-MM-DD --stress <faktor> --equity <usd>
optimize:  --equity <usd>            (Zeitraum: optimizer.lookbackDays aus der Config)
--allow-short  NUR fuer backtest und optimize: misst mit erlaubten Shorts, egal was
               risk.allowShort sagt. Das Kommando run lehnt die Option ab — was
               gehandelt wird, entscheidet die Config, nie die Kommandozeile.
--as-of <tag>  NUR fuer universe, backtest und optimize: der Lauf tut so, als waere
               YYYY-MM-DD heute; alles danach ist unsichtbar. Fuer mehrere getrennte
               Holdout-Fenster aus verschiedenen Marktphasen.
universe:  --out <pfad>              (Default: <home>/universe.json)
fetch:     --days <n>
halt:      --reason <text>
flatten:   --yes
resume:    --ack-drawdown            (Drawdown-Halt bewusst aufheben; Peak = aktuelle Equity)
`;

interface Cli {
  cmd: string;
  values: Record<string, string | boolean | undefined>;
}

function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      config: { type: 'string' },
      env: { type: 'string' },
      home: { type: 'string' },
      verbose: { type: 'boolean' },
      json: { type: 'boolean' },
      strategy: { type: 'string' },
      params: { type: 'string' },
      days: { type: 'string' },
      symbols: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      stress: { type: 'string' },
      equity: { type: 'string' },
      yes: { type: 'boolean' },
      'ack-drawdown': { type: 'boolean' },
      reason: { type: 'string' },
      universe: { type: 'string' },
      out: { type: 'string' },
      'allow-short': { type: 'boolean' },
      'as-of': { type: 'string' },
    },
  });
  return { cmd: positionals[0] ?? 'help', values: values as Record<string, string | boolean | undefined> };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: string | boolean | undefined, fallback: number): number {
  const s = str(v);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Zahl erwartet, bekommen: ${s}`);
  return n;
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtTs(ms: number | null | undefined): string {
  if (!ms) return '—';
  const p = toET(ms);
  return `${p.day} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')} ET`;
}

function table(rows: string[][]): void {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  for (const r of rows) out('  ' + r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  '));
}

function metricsRows(m: Metrics): string[][] {
  return [
    ['Netto', `${fmt(m.netProfit)} $ (${fmt(m.netReturnPct)} %)`],
    ['CAGR', `${fmt(m.cagrPct)} %`],
    ['Sharpe / Sortino', `${fmt(m.sharpe)} / ${fmt(m.sortino)}`],
    ['Max. Drawdown', `${fmt(m.maxDrawdownPct)} %`],
    ['Profit-Faktor', fmt(m.profitFactor)],
    ['Trefferquote', `${fmt(m.winRatePct, 1)} %`],
    ['Erwartung / Ø R', `${fmt(m.expectancy)} $ / ${fmt(m.avgR)}`],
    ['Trades', String(m.trades)],
    ['Exposure', `${fmt(m.exposurePct, 1)} %`],
    ['Gebührenanteil', fmt(m.feeShare)],
    ['Tage', String(m.days)],
  ];
}

function parseParams(s: string | undefined): Partial<Params> {
  const out: Partial<Params> = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) throw new Error(`Parameter-Format a=1,b=2 erwartet, bekommen: ${part}`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Parameter ${k}: Zahl erwartet`);
    out[k.trim()] = n;
  }
  return out;
}

/**
 * `--allow-short` — ein MESS-Schalter, kein Handels-Schalter.
 *
 * Hintergrund (08.09.2026): `risk.allowShort: false` steht in der
 * Plattform-Config und in jeder Erkundungs-Config, und `core/logic.ts` sperrt
 * damit jeden Short-Einstieg. Der Strategie-Parameter `allowShort` war
 * dadurch in ALLEN bisherigen Messungen wirkungslos — der Optimierer hat eine
 * Dimension durchsucht, die nichts bewirkt. Um zu prüfen, ob Shorts die Kante
 * ändern, muss man sie messen können, ohne die Produktions-Config zu ändern.
 *
 * Warum nur `backtest` und `optimize`: Was tatsächlich gehandelt wird, darf
 * nie von einem Kommandozeilen-Schalter abhängen. `run` lehnt die Option
 * deshalb ab, statt sie zu ignorieren — stillschweigend zu ignorieren wäre
 * schlimmer, weil dann jemand glaubt, sie habe gewirkt.
 */
const SHORT_MESS_KOMMANDOS = new Set(['backtest', 'optimize']);
/** `universe` gehört dazu: Zu einem Stichtag gehört auch das Universum VON DAMALS. */
const ASOF_MESS_KOMMANDOS = new Set(['universe', 'backtest', 'optimize']);

/** Mess-Schalter gelten nur, wo gemessen wird — sonst Abbruch statt stillem Ignorieren. */
function nurMessen(cmd: string, erlaubt: ReadonlySet<string>, option: string): void {
  if (erlaubt.has(cmd)) return;
  throw new Error(
    `${option} gilt nur für ${[...erlaubt].join(', ')}, nicht für \`${cmd}\`. ` +
      'Was gehandelt wird, entscheidet die Config — nicht die Kommandozeile.',
  );
}

export function applyAllowShort(app: App, cli: Cli): App {
  if (cli.values['allow-short'] !== true) return app;
  nurMessen(cli.cmd, SHORT_MESS_KOMMANDOS, '--allow-short');
  if (app.config.risk.allowShort) return app;
  logger.warn('--allow-short: Shorts für diese MESSUNG erlaubt (risk.allowShort in der Config bleibt unberührt).');
  return { ...app, config: { ...app.config, risk: { ...app.config.risk, allowShort: true } } };
}

/** Stichtag prüfen und normalisieren; wirft für Kommandos, die handeln. */
export function asOfFrom(cli: Cli): string | undefined {
  const roh = str(cli.values['as-of']);
  if (roh === undefined) return undefined;
  nurMessen(cli.cmd, ASOF_MESS_KOMMANDOS, '--as-of');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(roh)) throw new Error(`--as-of erwartet YYYY-MM-DD, bekommen: ${roh}`);
  if (Number.isNaN(Date.parse(`${roh}T12:00:00Z`))) throw new Error(`--as-of ist kein gültiges Datum: ${roh}`);
  return roh;
}

function appFrom(cli: Cli): App {
  // `universe` erzeugt die Auswahl gerade erst — es darf sie nicht schon anwenden.
  const auswahl = cli.cmd === 'universe' ? undefined : str(cli.values.universe);
  const asOf = asOfFrom(cli);
  return bootstrap({
    config: str(cli.values.config) ?? 'config/config.yaml',
    env: str(cli.values.env) ?? '.env',
    home: str(cli.values.home),
    verbose: cli.values.verbose === true,
    universeFile: auswahl,
    asOf,
  });
}

/* ───────────────────────── Kommandos ───────────────────────── */

async function cmdDoctor(app: App): Promise<number> {
  let hard = 0;
  out('autotrd doctor');
  out();
  const rows: string[][] = [
    ['Modus', app.mode + (app.modeReasons.length ? ` (${app.modeReasons.join(' ')})` : '')],
    ['Key-Präfix', app.env.ALPACA_API_KEY ? app.env.ALPACA_API_KEY.slice(0, 2) + '…' : 'KEIN KEY'],
    ['Feed', app.config.broker.feed],
    ['Assetklasse / Zeitrahmen', `${app.config.universe.assetClass} / ${app.config.timeframe} min`],
    ['Symbole', app.config.universe.symbols.join(', ')],
    ['Benchmark', app.config.universe.benchmark ?? '—'],
    ['Home', app.home],
    ['Kalender', app.calendar ? `${app.calendar.size} Handelstage gecacht` : 'nicht gecacht (Fallback-Kalender)'],
  ];
  table(rows);
  const streamSymbols = allSymbols(app.config).length;
  if (app.config.broker.feed === 'iex' && streamSymbols > 30) {
    out(`  WARNUNG: ${streamSymbols} Symbole (inkl. Benchmark) — der IEX-Datenstrom des Basis-Plans erlaubt 30. Die Subscription würde mit 405 scheitern.`);
    hard++;
  }
  out();
  out('Champion:');
  if (!app.champion) {
    out(`  kein champion.json — ${app.config.strategy.allowWithoutChampion ? `Config-Strategie ${app.config.strategy.id} wird gehandelt` : 'es wird NICHTS gehandelt (strategy.allowWithoutChampion=false)'}`);
  } else {
    const rowsC: string[][] = [['Symbol', 'Quelle', 'Strategie', 'Score', 'Entschieden']];
    for (const s of app.config.universe.symbols) {
      const c = strategyChoice(app, s);
      const e = app.champion.symbols[s];
      rowsC.push([s, c?.source ?? (app.champion.noTrade[s] ? 'noTrade' : '—'), c?.strategy.id ?? '—', e ? fmt(e.score) : '—', e ? fmtTs(e.decidedAt) : app.champion.noTrade[s] ? fmtTs(app.champion.noTrade[s]!.decidedAt) : '—']);
    }
    table(rowsC);
  }
  out();
  out('Bars-Cache:');
  const rowsB: string[][] = [['Symbol', 'Basis', 'Bars', 'Letzte Bar']];
  for (const s of allSymbols(app.config)) {
    const tf = baseTimeframe(app.config.timeframe);
    const bars = app.store.load(s, tf);
    rowsB.push([s, tf, String(bars.length), fmtTs(bars[bars.length - 1]?.t)]);
  }
  table(rowsB);
  out();
  if (!app.client) {
    out('Broker: keine Keys — Konto/Uhr/Assets nicht prüfbar (Backtest/Optimize gehen trotzdem).');
  } else {
    try {
      const acc = await app.client.getAccount();
      const clock = await app.client.getClock();
      table([
        ['Konto', `${acc.status} · ${acc.currency} · Equity ${fmt(acc.equity)} · Cash ${fmt(acc.cash)} · Kaufkraft ${fmt(acc.buyingPower)}`],
        ['Daytrades (5 Tage)', `${acc.daytradeCount} · PDT-Flag ${acc.patternDayTrader ? 'JA' : 'nein'}`],
        ['Gesperrt', acc.tradingBlocked || acc.accountBlocked ? 'JA — Handel gesperrt' : 'nein'],
        ['Shorting', acc.shortingEnabled ? 'erlaubt' : 'nicht erlaubt'],
        ['Uhr', `${clock.isOpen ? 'OFFEN' : 'geschlossen'} · nächste Öffnung ${fmtTs(clock.nextOpen)} · nächster Schluss ${fmtTs(clock.nextClose)}`],
      ]);
      if (acc.tradingBlocked || acc.accountBlocked) hard++;
      if (acc.equity < app.config.risk.pdt.minEquity && app.config.risk.pdt.respect) {
        out(`  Hinweis: Equity unter ${app.config.risk.pdt.minEquity} $ — PDT-Regel greift (max. ${app.config.risk.pdt.maxDayTrades} Daytrades je 5 Handelstage).`);
      }
      out();
      out('Assets:');
      const rowsA: string[][] = [['Symbol', 'handelbar', 'shortbar', 'fractional', 'Status']];
      for (const s of allSymbols(app.config)) {
        try {
          const a = await app.client.getAsset(s);
          if (!a) {
            rowsA.push([s, 'FEHLT', '—', '—', 'nicht bei Alpaca']);
            hard++;
          } else rowsA.push([s, a.tradable ? 'ja' : 'NEIN', a.shortable ? 'ja' : 'nein', a.fractionable ? 'ja' : 'nein', a.status]);
        } catch (e) {
          rowsA.push([s, '?', '?', '?', errMsg(e)]);
        }
      }
      table(rowsA);
    } catch (e) {
      out(`Broker-Fehler: ${errMsg(e)}`);
      hard++;
    }
  }
  out();
  const trades = app.journal.trades();
  const r = assessReadiness(trades, Date.now());
  out(`Live-Reife: ${r.ready ? 'ERFÜLLT' : 'nicht erfüllt'} — ${r.summary}`);
  return hard > 0 ? 1 : 0;
}

/**
 * Handelsuniversum wählen: Tagesbars für den Kandidatenpool laden, nach
 * Median-Dollarumsatz ranken, die liquidesten `maxSymbols` behalten.
 *
 * Ausdrücklich NICHT nach Ertrag — siehe `src/universe/select.ts`. Das
 * Ergebnis landet in `<home>/universe.json`; `fetch`, `optimize` und
 * `scripts/sync-engine-config.mjs` wenden es mit `--universe` an.
 */
async function cmdUniverse(app: App, cli: Cli): Promise<number> {
  const pool = app.config.universe.candidates;
  if (!pool || pool.length === 0) {
    out('Kein Kandidatenpool (`universe.candidates`) konfiguriert — das Universum aus der Config bleibt, wie es ist.');
    return 0;
  }
  const client = requireClient(app);
  const regeln: UniverseRegeln = { ...UNIVERSE_REGELN, max: app.config.universe.maxSymbols };
  // Bei einer Stichtags-Messung wählt auch das Universum nur mit Daten bis dahin.
  const now = app.asOf ?? Date.now();
  // Tagesbars sind billig (ein Abruf je Block, kein Minutenraster), deshalb darf der
  // Pool viel größer sein als das Universum. Fenster großzügig: 60 Handelstage
  // brauchen rund 84 Kalendertage.
  const from = now - (regeln.fensterTage * 2 + 10) * DAY;
  const geladen = await backfill({ client, store: app.store, symbols: [...pool], tf: '1Day', from, to: now, feed: app.config.broker.feed, log: (m) => logger.debug(m) });
  const kandidaten = new Map<string, Bar[]>();
  for (const sym of pool) kandidaten.set(sym, geladen.get(sym) ?? app.store.load(sym, '1Day'));

  // Bestand = was gerade gehandelt wird: die letzte Auswahl, sonst die Config.
  // Eine unlesbare oder nicht mehr passende Altdatei darf den Lauf nicht töten —
  // sie ist hier nur Hysterese-Gedächtnis, keine Handelsanweisung.
  let vorher: string[] | null = null;
  try {
    vorher = ladeUniverseDatei(app.paths.universe, app.config);
  } catch (e) {
    logger.warn(`Vorige Auswahl unbrauchbar (${errMsg(e)}) — Bestand kommt aus der Config.`);
  }
  const bench = app.config.universe.benchmark;
  const auswahl = waehleUniverse({
    kandidaten,
    pflicht: bench ? [bench] : [],
    bestand: vorher ?? app.config.universe.symbols,
    bestandIstAuswahl: vorher !== null,
    regeln,
    jetzt: now,
  });

  const ziel = str(cli.values.out) ?? app.paths.universe;
  schreibeUniverseDatei(ziel, auswahl, regeln, bench, now);
  // Dauerhafter Beleg, welcher Korb ab wann galt: `universe.json` und
  // `meta/engineConfig` werden überschrieben, das Journal nie.
  app.journal.append('universe', { symbols: auswahl.symbols, zugang: auswahl.zugang, abgang: auswahl.abgang, kandidaten: pool.length, regeln }, now);
  const bericht = renderUniverseReport({ auswahl, regeln, benchmark: bench, kandidaten: pool.length, jetzt: now });
  ensureDir(app.paths.reports);
  const berichtPfad = join(app.paths.reports, `universe-${dayKey(now)}.md`);
  writeFileSync(berichtPfad, bericht, 'utf8');

  if (cli.values.json === true) {
    out(JSON.stringify({ symbols: auswahl.symbols, zugang: auswahl.zugang, abgang: auswahl.abgang, datei: ziel, bericht: berichtPfad }, null, 2));
    return 0;
  }
  const rows: string[][] = [['Rang', 'Symbol', 'Umsatz/Tag', 'Status', 'Grund']];
  for (const b of auswahl.bewertung.slice(0, regeln.max + 10)) {
    rows.push([String(b.rang ?? '—'), b.symbol, `${(b.dollarVolumen / 1e6).toFixed(1)} Mio.`, b.status, b.grund]);
  }
  table(rows);
  out('');
  out(`Gewählt: ${auswahl.symbols.length} von ${pool.length} Kandidaten`);
  out(`Zugang:  ${auswahl.zugang.length ? auswahl.zugang.join(', ') : '—'}`);
  out(`Abgang:  ${auswahl.abgang.length ? auswahl.abgang.join(', ') : '—'}`);
  out(`Datei:   ${ziel}`);
  out(`Bericht: ${berichtPfad}`);
  return 0;
}

async function cmdFetch(app: App, cli: Cli): Promise<number> {
  const client = requireClient(app);
  const days = num(cli.values.days, app.config.optimizer.lookbackDays);
  const now = Date.now();
  const today = dayKeyFor(now, app.config.universe.assetClass);
  const calendar = await ensureCalendar(client, app.paths.calendar, addDays(today, -days - 10), addDays(today, 40), now);
  out(`Kalender: ${calendar.size} Handelstage`);
  const tf = baseTimeframe(app.config.timeframe);
  const symbols = allSymbols(app.config);
  const from = now - days * DAY;
  const result = await backfill({ client, store: app.store, symbols, tf, from, to: now, feed: app.config.broker.feed, log: (m) => logger.info(m) });
  const rows: string[][] = [['Symbol', 'Bars', 'Erste', 'Letzte']];
  for (const s of symbols) {
    const bars = result.get(s) ?? [];
    rows.push([s, String(bars.length), fmtTs(bars[0]?.t), fmtTs(bars[bars.length - 1]?.t)]);
  }
  table(rows);
  return 0;
}

function dayToMs(day: string, endOfDay = false): number {
  const { y, m, d } = parseDay(day);
  return endOfDay ? msFromET(y, m, d, 23, 59, 59) : msFromET(y, m, d);
}

function rangeFromArgs(cli: Cli, lastBarMs: number, defaultDays: number): { start: number; end: number } {
  const from = str(cli.values.from);
  const to = str(cli.values.to);
  const end = to ? dayToMs(to, true) : lastBarMs + 1;
  const days = num(cli.values.days, defaultDays);
  const start = from ? dayToMs(from) : end - days * DAY;
  if (start >= end) throw new Error(`Zeitraum leer: --from ${from ?? '?'} liegt nicht vor --to/Datenende.`);
  return { start, end };
}

async function cmdBacktest(app: App, cli: Cli): Promise<number> {
  const symbols = (str(cli.values.symbols)?.split(',').map((s) => s.trim()).filter(Boolean)) ?? app.config.universe.symbols;
  const strategyId = str(cli.values.strategy);
  const overrides = parseParams(str(cli.values.params));
  const bars = new Map<string, ReturnType<typeof seriesForTimeframe>>();
  let lastBar = 0;
  for (const s of symbols) {
    const series = seriesForTimeframe(app, s);
    if (!series.length) {
      out(`Keine Bars für ${s} im Cache — zuerst \`autotrd fetch\`.`);
      return 1;
    }
    bars.set(s, series);
    lastBar = Math.max(lastBar, series.t[series.length - 1]!);
  }
  const strategyFor = strategyId
    ? (() => {
        const strategy = getStrategy(strategyId);
        const params = mergeParams(strategy.defaults, overrides);
        validateParams(strategy.paramSpace, params);
        return () => ({ strategy, params });
      })()
    : strategyForFn(app);
  const range = rangeFromArgs(cli, lastBar, app.config.optimizer.lookbackDays);
  const initialEquity = num(cli.values.equity, 25_000);
  const result = simulate({
    bars,
    benchmark: benchmarkSeries(app),
    strategyFor,
    config: { risk: app.config.risk, session: app.config.session, costs: app.config.costs, assetClass: app.config.universe.assetClass, timeframe: app.config.timeframe },
    initialEquity,
    range,
    calendar: app.calendar,
    costMultiplier: num(cli.values.stress, 1),
  });
  const traded = symbols.filter((s) => strategyFor(s) !== null);
  if (cli.values.json) {
    out(JSON.stringify({ symbols: traded, range, metrics: result.metrics, trades: result.trades, notes: result.notes }, null, 2));
  } else {
    out(`Backtest ${fmtTs(range.start)} → ${fmtTs(range.end)} · Symbole: ${traded.join(', ') || 'KEINE (kein Champion, allowWithoutChampion=false)'} · Startkapital ${fmt(initialEquity)} $`);
    out();
    table(metricsRows(result.metrics));
    if (result.notes.length) {
      out();
      for (const n of result.notes.slice(0, 20)) out(`  · ${n}`);
    }
    const byReason = new Map<string, { n: number; pnl: number }>();
    for (const t of result.trades) {
      const e = byReason.get(t.exitReason) ?? { n: 0, pnl: 0 };
      e.n++;
      e.pnl += t.netPnl;
      byReason.set(t.exitReason, e);
    }
    if (byReason.size) {
      out();
      out('Exits:');
      table([['Grund', 'Trades', 'Netto'], ...[...byReason.entries()].map(([k, v]) => [k, String(v.n), fmt(v.pnl)])]);
    }
  }
  ensureDir(app.paths.reports);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJsonAtomic(join(app.paths.reports, `backtest-${stamp}.json`), { symbols: traded, range, metrics: result.metrics, trades: result.trades, notes: result.notes });
  return 0;
}

async function cmdOptimize(app: App, cli: Cli): Promise<number> {
  const symbols = app.config.universe.symbols;
  for (const s of allSymbols(app.config)) {
    if (!app.store.load(s, baseTimeframe(app.config.timeframe)).length) {
      out(`Keine Bars für ${s} im Cache — zuerst \`autotrd fetch\`.`);
      return 1;
    }
  }
  let initialEquity = num(cli.values.equity, 25_000);
  if (app.client && str(cli.values.equity) === undefined) {
    try {
      initialEquity = (await app.client.getAccount()).equity;
    } catch (e) {
      logger.warn('Konto nicht lesbar — Optimierung mit Standard-Kapital', { error: errMsg(e) });
    }
  }
  const cache = new Map<string, ReturnType<typeof seriesForTimeframe>>();
  const barsFor = (symbol: string) => {
    let s = cache.get(symbol);
    if (!s) {
      s = seriesForTimeframe(app, symbol);
      cache.set(symbol, s);
    }
    return s;
  };
  const deps = await loadDefaultDeps();
  const res = runOptimization({
    ...deps,
    config: app.config,
    symbols,
    strategies: app.config.optimizer.strategies,
    barsFor,
    benchmark: benchmarkSeries(app),
    calendar: app.calendar,
    home: app.home,
    initialEquity,
    log: (m) => logger.info(m),
    ...(asOfFrom(cli) === undefined ? {} : { asOf: asOfFrom(cli)! }),
  });
  const rows: string[][] = [['Symbol', 'Entscheidung', 'Strategie', 'Score', 'OOS-Trades', 'OOS netto', 'Folds +']];
  for (const r of res.runs) {
    const c = r.chosen;
    rows.push([
      r.symbol,
      `${r.decision.action} — ${r.decision.reason}`,
      c?.strategy ?? '—',
      c ? fmt(c.score) : '—',
      c ? String(c.oos.trades) : '—',
      c ? fmt(c.oos.netProfit) : '—',
      c ? fmt(c.oos.positiveFoldShare * 100, 0) + ' %' : '—',
    ]);
  }
  table(rows);
  out();
  out(`Champion: ${app.paths.champion} · Report: ${res.reportPath}`);
  app.journal.append('champion', { symbols: Object.keys(res.champion.symbols), noTrade: Object.keys(res.champion.noTrade), report: res.reportPath });
  return 0;
}

async function cmdRun(app: App): Promise<number> {
  const client = requireClient(app);
  const strategyFor = strategyForFn(app);
  const traded = app.config.universe.symbols.filter((s) => strategyFor(s) !== null);
  if (!traded.length) {
    out('Kein Symbol handelbar: kein Champion (autotrd optimize) und strategy.allowWithoutChampion=false. Engine startet nicht.');
    return 1;
  }
  const notify = createNotifier({ config: app.config, env: app.env });
  const dataStream = createDataStream({ keyId: app.env.ALPACA_API_KEY, secret: app.env.ALPACA_SECRET_KEY, feed: app.config.broker.feed, assetClass: app.config.universe.assetClass });
  const tradeStream = createTradeStream({ keyId: app.env.ALPACA_API_KEY, secret: app.env.ALPACA_SECRET_KEY, mode: app.mode });
  const engine = new Engine({
    config: app.config,
    mode: app.mode,
    home: app.home,
    client,
    dataStream,
    tradeStream,
    strategyFor,
    benchmarkSymbol: app.config.universe.benchmark,
    calendar: app.calendar,
    notify,
    // Derselbe Bars-Cache wie fetch/backtest/optimize.
    store: app.store,
  });
  out(`autotrd run · ${app.mode.toUpperCase()} · ${traded.join(', ')} · ${app.config.timeframe} min · Home ${app.home}`);
  if (app.mode === 'live') out('ECHTGELD — Doppel-Guard erfüllt (mode=live, ALPACA_ALLOW_LIVE=1, AK-Key).');
  for (const r of app.modeReasons) out(`  ${r}`);
  await engine.start();
  const server = app.config.status.httpPort > 0 ? startStatusServer({ port: app.config.status.httpPort, status: () => engine.status() as unknown as Record<string, unknown> }) : null;
  if (server) out(`Status: http://127.0.0.1:${server.port}/status`);
  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = (sig: string) => {
      if (stopping) return;
      stopping = true;
      out(`${sig} — Engine wird gestoppt (Positionen bleiben, Stops liegen beim Broker).`);
      void engine
        .stop()
        .catch((e) => logger.error('Fehler beim Stoppen', { error: errMsg(e) }))
        .then(() => server?.close())
        .then(() => resolveStop());
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

async function cmdStatus(app: App, cli: Cli): Promise<number> {
  const state = app.state.load();
  const today = dayKey(Date.now());
  const trades = app.journal.trades();
  const todays = trades.filter((t) => dayKey(t.exitTime) === today);
  const net = (list: Trade[]) => list.reduce((s, t) => s + t.netPnl, 0);
  let account: Record<string, unknown> | null = null;
  let brokerPositions: Array<{ symbol: string; side: string; qty: number; avgEntryPrice: number; unrealizedPl: number }> = [];
  if (app.client) {
    try {
      const a = await app.client.getAccount();
      account = { equity: a.equity, cash: a.cash, daytradeCount: a.daytradeCount, patternDayTrader: a.patternDayTrader, blocked: a.tradingBlocked || a.accountBlocked };
      brokerPositions = (await app.client.listPositions()).map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, avgEntryPrice: p.avgEntryPrice, unrealizedPl: p.unrealizedPl }));
    } catch (e) {
      logger.warn('Broker nicht erreichbar', { error: errMsg(e) });
    }
  }
  const haltFile = existsSync(app.paths.haltFlag);
  if (cli.values.json) {
    out(JSON.stringify({ mode: app.mode, haltFile, state, account, brokerPositions, today: { trades: todays.length, net: net(todays) }, total: { trades: trades.length, net: net(trades) } }, null, 2));
    return 0;
  }
  out(`autotrd status · ${app.mode} · Home ${app.home}`);
  out();
  if (!state) out('Kein state.json — Engine lief noch nie.');
  else {
    const age = Math.round((Date.now() - state.updatedAt) / 1000);
    table([
      ['Engine', age < 30 ? `läuft (State vor ${age} s)` : `nicht aktiv (State vor ${age} s)`],
      ['Halt', state.halt.halted ? `JA — ${state.halt.reason}: ${state.halt.note ?? ''}` : 'nein'],
      ['HALT-Datei', haltFile ? 'gesetzt' : 'nicht gesetzt'],
      ['Tag / Tagesstart-Equity / Peak', `${state.day} / ${fmt(state.dayStartEquity)} / ${fmt(state.peakEquity)}`],
      ['Fehler in Folge', String(state.consecutiveErrors)],
    ]);
    out();
    out('Positionen (Buch):');
    const pos = Object.values(state.positions);
    if (!pos.length) out('  keine');
    else table([['Symbol', 'Seite', 'Stück', 'Einstand', 'Stop', 'Ziel', 'Seit', 'Bars'], ...pos.map((p) => [p.symbol, p.side, String(p.qty), fmt(p.entryPrice), fmt(p.stop), fmt(p.target), fmtTs(p.entryTime), String(p.barsHeld)])]);
    const pend = Object.entries(state.pendingEntries);
    if (pend.length) out(`  offene Einstiege: ${pend.map(([s, id]) => `${s} (${id})`).join(', ')}`);
    out();
    out('Letzte Bars:');
    table(Object.entries(state.lastBarAt).map(([s, t]) => [s, fmtTs(t)]));
  }
  if (account) {
    out();
    table([
      ['Konto', `Equity ${fmt(account.equity as number)} · Cash ${fmt(account.cash as number)} · Daytrades ${String(account.daytradeCount)} · PDT ${account.patternDayTrader ? 'JA' : 'nein'} · gesperrt ${account.blocked ? 'JA' : 'nein'}`],
    ]);
    out('Positionen (Broker):');
    if (!brokerPositions.length) out('  keine');
    else table([['Symbol', 'Seite', 'Stück', 'Einstand', 'Unrealisiert'], ...brokerPositions.map((p) => [p.symbol, p.side, String(p.qty), fmt(p.avgEntryPrice), fmt(p.unrealizedPl)])]);
  }
  out();
  out(`Trades heute: ${todays.length} (netto ${fmt(net(todays))} $) · gesamt: ${trades.length} (netto ${fmt(net(trades))} $)`);
  return 0;
}

async function cmdFlatten(app: App, cli: Cli): Promise<number> {
  if (cli.values.yes !== true) {
    out('flatten storniert ALLE Orders und schließt ALLE Positionen des Kontos. Bestätigen mit --yes.');
    return 1;
  }
  const client = requireClient(app);
  writeFileSync(app.paths.haltFlag, `flatten ${new Date().toISOString()}\n`);
  await client.cancelAllOrders();
  await client.closeAllPositions(true);
  app.journal.append('halt', { reason: 'manual', note: 'flatten: alle Orders storniert, alle Positionen geschlossen, HALT gesetzt' });
  out('Alle Orders storniert, alle Positionen zum Schließen aufgegeben. HALT-Datei gesetzt — `autotrd resume` hebt sie auf.');
  return 0;
}

function cmdHalt(app: App, cli: Cli): number {
  const reason = str(cli.values.reason) ?? 'manuell';
  writeFileSync(app.paths.haltFlag, `${reason} ${new Date().toISOString()}\n`);
  app.journal.append('halt', { reason: 'manual', note: reason });
  out(`HALT gesetzt (${app.paths.haltFlag}): keine neuen Einstiege, Exits laufen weiter.`);
  return 0;
}

function cmdResume(app: App, cli: Cli): number {
  if (existsSync(app.paths.haltFlag)) {
    unlinkSync(app.paths.haltFlag);
    app.journal.append('resume', { note: 'HALT-Datei entfernt' });
    out('HALT-Datei entfernt.');
  }
  const state = app.state.load();
  if (state?.halt.halted && state.halt.reason !== 'daily_loss') {
    if (state.halt.reason === 'drawdown' && cli.values['ack-drawdown'] !== true) {
      out(`Drawdown-Halt aktiv (${state.halt.note ?? ''}). Aufheben nur bewusst: autotrd resume --ack-drawdown (setzt den Peak auf die aktuelle Equity).`);
      return 1;
    }
    // Kein Schreiben in den State der (vielleicht laufenden) Engine: Der RESUME-Marker
    // wird vom nächsten Tick bzw. beim nächsten Start verarbeitet — mit der echten
    // Equity als neuem Peak und einem Journal-Eintrag. Damit gibt es kein Race und
    // keine Rückmeldung, die mehr behauptet, als passiert ist.
    const note = `resume (${state.halt.reason}) durch Operator ${new Date().toISOString()}`;
    writeFileSync(join(app.home, 'RESUME'), note + '\n');
    app.journal.append('note', { note: `RESUME-Marker gesetzt: ${note}` });
    out(`RESUME-Marker gesetzt (${join(app.home, 'RESUME')}). Die Engine hebt den Halt beim nächsten Tick bzw. Start auf und setzt den Peak auf die aktuelle Equity.`);
  }
  return 0;
}

function cmdReadiness(app: App, cli: Cli): number {
  const r = assessReadiness(app.journal.trades(), Date.now());
  if (cli.values.json) {
    out(JSON.stringify(r, null, 2));
    return r.ready ? 0 : 1;
  }
  out(`Live-Reife: ${r.ready ? 'ERFÜLLT' : 'nicht erfüllt'}`);
  table([['Prüfung', 'Wert', 'Schwelle', 'OK'], ...r.checks.map((c) => [c.name, fmt(c.value), String(c.threshold), c.pass ? '✔' : '✘'])]);
  out(r.summary);
  return r.ready ? 0 : 1;
}

/* ───────────────────────── main ───────────────────────── */

export async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  if (cli.cmd === 'help' || cli.cmd === '--help' || cli.cmd === '-h') {
    out(USAGE);
    out(`Strategien: ${strategyIds().join(', ')}`);
    return 0;
  }
  const app = applyAllowShort(appFrom(cli), cli);
  switch (cli.cmd) {
    case 'doctor':
      return cmdDoctor(app);
    case 'universe':
      return cmdUniverse(app, cli);
    case 'fetch':
      return cmdFetch(app, cli);
    case 'backtest':
      return cmdBacktest(app, cli);
    case 'optimize':
      return cmdOptimize(app, cli);
    case 'run':
      return cmdRun(app);
    case 'status':
      return cmdStatus(app, cli);
    case 'flatten':
      return cmdFlatten(app, cli);
    case 'halt':
      return cmdHalt(app, cli);
    case 'resume':
      return cmdResume(app, cli);
    case 'readiness':
      return cmdReadiness(app, cli);
    default:
      out(`Unbekanntes Kommando: ${cli.cmd}`);
      out(USAGE);
      return 2;
  }
}

const isDirect = process.argv[1] && (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'));
if (isDirect) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      if (e instanceof ConfigError) out(`Config-Fehler: ${e.message}`);
      else out(`Fehler: ${errMsg(e)}`);
      process.exitCode = 1;
    });
}
