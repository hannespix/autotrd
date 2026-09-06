#!/usr/bin/env node
/**
 * autotrd — Kommandozeile des Auto-Traders.
 *
 *   doctor     Config, Keys, Modus, Konto, Uhr, Assets, Cache, Champion prüfen
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
import type { Metrics, Params, Trade } from './core/types.ts';
import { backfill } from './data/backfill.ts';
import { ensureCalendar } from './data/calendar.ts';
import { Engine } from './engine/engine.ts';
import { createNotifier } from './notify/index.ts';
import { loadDefaultDeps, runOptimization } from './optimize/run.ts';
import { assessReadiness } from './readiness.ts';
import { resumeHalt } from './risk/limits.ts';
import { startStatusServer } from './status/http.ts';
import { getStrategy, strategyIds } from './strategy/index.ts';
import { mergeParams, validateParams } from './strategy/params.ts';

const USAGE = `autotrd <kommando> [optionen]

Kommandos: doctor | fetch | backtest | optimize | run | status | flatten | halt | resume | readiness

Gemeinsame Optionen:
  --config <pfad>    Config-Datei (Default: config/config.yaml)
  --env <pfad>       .env-Datei (Default: .env)
  --home <pfad>      State-Verzeichnis (Default: AUTOTRD_HOME bzw. paths.home)
  --verbose          Debug-Log
  --json             Maschinenlesbare Ausgabe (status, readiness, backtest)

backtest:  --strategy <id> --params a=1,b=2 --days <n> --symbols A,B --from YYYY-MM-DD --to YYYY-MM-DD --stress <faktor> --equity <usd>
optimize:  --equity <usd> --days <n>
fetch:     --days <n>
flatten:   --yes
resume:    --ack-drawdown
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

function appFrom(cli: Cli): App {
  return bootstrap({
    config: str(cli.values.config) ?? 'config/config.yaml',
    env: str(cli.values.env) ?? '.env',
    home: str(cli.values.home),
    verbose: cli.values.verbose === true,
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
    const age = Date.now() - state.updatedAt;
    if (age < 15_000) {
      out('Die Engine schreibt den State gerade (läuft). Erst stoppen, dann resume — sonst überschreibt die Engine die Aufhebung.');
      return 1;
    }
    const account = { equity: state.peakEquity, cash: 0, dayStartEquity: state.dayStartEquity, peakEquity: state.peakEquity, dayTradeCount: 0, patternDayTrader: false };
    const r = resumeHalt(state.halt, account, Date.now(), `resume (${state.halt.reason}) durch Operator`);
    state.halt = r.halt;
    // Peak auf den letzten bekannten Stand setzen; die Engine korrigiert beim Start mit der echten Equity.
    state.peakEquity = state.dayStartEquity;
    app.state.save(state);
    app.journal.append('resume', { note: r.halt.note });
    out(`Halt aufgehoben (${r.halt.note}). Peak wird beim nächsten Engine-Start auf die aktuelle Equity gesetzt.`);
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
  const app = appFrom(cli);
  switch (cli.cmd) {
    case 'doctor':
      return cmdDoctor(app);
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
