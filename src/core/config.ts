/**
 * Konfiguration: YAML-Datei + Umgebung (.env). Validiert mit zod — ein
 * Auto-Trader darf mit einer halb verstandenen Config nicht starten.
 *
 * Echtgeld-Doppel-Guard (nicht verhandelbar):
 *   broker.mode = 'live'  UND  ALPACA_ALLOW_LIVE=1  UND  Live-Key (AK…)
 * Fehlt eines davon ⇒ Paper. Ein Live-Key gegen Paper wird abgelehnt,
 * damit niemand "aus Versehen" mit dem falschen Konto arbeitet.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { TIMEFRAMES, type TimeframeMin } from './types.ts';
import { normalizeUserSymbol } from '../alpaca/symbols.ts';

const pct = (max: number) => z.number().min(0).max(max);

/** Aufgelöstes Universum: kanonische Schreibweise, ohne Duplikate. */
export interface ResolvedUniverse {
  assetClass: 'us_equity' | 'crypto';
  /** Was tatsächlich gehandelt wird. */
  symbols: string[];
  /** Obergrenze der nächtlichen Auswahl. */
  maxSymbols: number;
  benchmark?: string;
  /** Pool der nächtlichen Auswahl; enthält immer mindestens `symbols`. */
  candidates?: string[];
}

export const ConfigSchema = z.object({
  broker: z
    .object({
      mode: z.enum(['paper', 'live']).default('paper'),
      /** Datenfeed für Backtest UND Live — immer derselbe, sonst misst man etwas anderes als man handelt. */
      feed: z.enum(['iex', 'sip']).default('iex'),
    })
    .default({ mode: 'paper', feed: 'iex' }),
  universe: z
    .object({
      assetClass: z.enum(['us_equity', 'crypto']).default('us_equity'),
      symbols: z.array(z.string().min(1)).min(1).max(50),
      /** Benchmark für Marktfilter (z. B. SPY). Wird mitgeladen, nie gehandelt. */
      benchmark: z.string().min(1).optional(),
      /**
       * Pool, aus dem die nächtliche Auswahl (`autotrd universe`) die
       * `maxSymbols` liquidesten wählt. Leer ⇒ `symbols` bleibt fest.
       * Der Pool wird von Hand gepflegt und nur mit Commit geändert — die
       * Auswahl darin läuft automatisch, aber ausschließlich nach Liquidität.
       */
      candidates: z.array(z.string().min(1)).max(300).optional(),
      /** Wie viele Symbole die Auswahl behält (IEX-Basis: höchstens 30 inkl. Benchmark). */
      maxSymbols: z.number().int().min(1).max(30).default(30),
    })
    // Kanonische Alpaca-Schreibweise (BRK-B → BRK.B, btcusd → BTC/USD) und Duplikate raus —
    // sonst bucht ein Fill unter „BTC/USD", während die Entscheidung „BTCUSD" ohne Position sieht.
    .transform((u): ResolvedUniverse => {
      const norm = (s: string) => normalizeUserSymbol(s, u.assetClass);
      const symbols = [...new Set(u.symbols.map(norm))];
      const out: ResolvedUniverse = { assetClass: u.assetClass, symbols, maxSymbols: u.maxSymbols };
      if (u.benchmark !== undefined) out.benchmark = norm(u.benchmark);
      // Der Pool enthält immer mindestens das aktuelle Universum: Sonst könnte eine
      // Auswahl Symbole verlieren, die die Config gerade handelt.
      if (u.candidates !== undefined) out.candidates = [...new Set([...symbols, ...u.candidates.map(norm)])];
      return out;
    }),
  /** Strategie-Zeitrahmen in Minuten (1440 = Tagesbars). */
  timeframe: z
    .number()
    .refine((n): n is TimeframeMin => (TIMEFRAMES as readonly number[]).includes(n), {
      message: `timeframe muss einer von ${TIMEFRAMES.join(', ')} sein`,
    })
    .default(5),
  session: z
    .object({
      /** Keine Einstiege in den ersten X Minuten nach Open (Eröffnungsrauschen). */
      noEntryFirstMin: z.number().int().min(0).max(390).default(5),
      /** Keine Einstiege in den letzten X Minuten vor Close. */
      noEntryLastMin: z.number().int().min(0).max(390).default(30),
      /** Intraday-Strategien: Glattstellen X Minuten vor Close. */
      flattenBeforeCloseMin: z.number().int().min(0).max(120).default(5),
    })
    .default({ noEntryFirstMin: 5, noEntryLastMin: 30, flattenBeforeCloseMin: 5 }),
  risk: z
    .object({
      /** Risiko je Trade in % der Equity (Distanz Einstand ↔ Stop). */
      riskPerTradePct: pct(5).default(0.5),
      /** Maximale Positionsgröße in % der Equity. */
      maxPositionPct: pct(100).default(20),
      maxPositions: z.number().int().min(1).max(50).default(4),
      /** Brutto-Exposure (Summe |Positionen|) in % der Equity. */
      maxGrossExposurePct: pct(400).default(100),
      /** Tages-Notbremse: ab diesem Tagesverlust alles glattstellen und bis zum nächsten Handelstag halten. */
      maxDailyLossPct: pct(50).default(2),
      /** Drawdown-Sperre vom Equity-Hoch: Halt bis manuelles `resume`. */
      maxDrawdownPct: pct(90).default(10),
      allowShort: z.boolean().default(false),
      pdt: z
        .object({
          /** Pattern-Day-Trader-Regel respektieren (unter minEquity max. maxDayTrades in 5 Handelstagen). */
          respect: z.boolean().default(true),
          minEquity: z.number().min(0).default(25_000),
          maxDayTrades: z.number().int().min(0).max(3).default(3),
        })
        .default({ respect: true, minEquity: 25_000, maxDayTrades: 3 }),
    })
    .default({
      riskPerTradePct: 0.5,
      maxPositionPct: 20,
      maxPositions: 4,
      maxGrossExposurePct: 100,
      maxDailyLossPct: 2,
      maxDrawdownPct: 10,
      allowShort: false,
      pdt: { respect: true, minEquity: 25_000, maxDayTrades: 3 },
    }),
  strategy: z
    .object({
      /** Fallback-Strategie, wenn kein Champion (optimize) vorliegt. */
      id: z.string().min(1).default('trend_donchian'),
      params: z.record(z.string(), z.number()).default({}),
      /** Ohne Champion nur handeln, wenn ausdrücklich erlaubt (Paper-Erkundung). */
      allowWithoutChampion: z.boolean().default(false),
    })
    .default({ id: 'trend_donchian', params: {}, allowWithoutChampion: false }),
  optimizer: z
    .object({
      strategies: z.array(z.string().min(1)).min(1).default(['trend_donchian', 'momentum_pullback', 'mean_reversion']),
      /** Historie in Kalendertagen, die geladen/bewertet wird. */
      /**
       * Obergrenze 4000 (≈ 11 Jahre) — die harte Grenze steht darunter in
       * `parseConfig` und hängt am ZEITRAHMEN: Tagesbars sind billig (30
       * Symbole × 11 Jahre ≈ 83 000 Bars), 5-Minuten-Bars nicht (dieselbe
       * Tiefe wären ~9 Mio. Bars). Die alte pauschale 2000 verbot deshalb
       * beides gleichzeitig und stand einer Messung im Weg, die einen
       * Bärenmarkt ins Fenster holen soll.
       */
      lookbackDays: z.number().int().min(30).max(4000).default(400),
      /** In-Sample-Fenster (Kalendertage). */
      isDays: z.number().int().min(20).default(120),
      /** Out-of-Sample-Fenster (Kalendertage). */
      oosDays: z.number().int().min(5).default(30),
      /** Schrittweite (Kalendertage); = oosDays ⇒ lückenlose OOS-Kette. */
      stepDays: z.number().int().min(1).default(30),
      /** Sperrzone zwischen IS und OOS in Bars (0 = automatisch: Warmup + max. Haltedauer). */
      embargoBars: z.number().int().min(0).default(0),
      /** Zufalls-Stichproben je Fold aus dem Parameterraum. */
      samples: z.number().int().min(4).max(5000).default(150),
      seed: z.number().int().default(42),
      minOosTrades: z.number().int().min(1).default(60),
      /** Anteil der Folds, die netto positiv sein müssen. */
      minFoldPositiveShare: z.number().min(0).max(1).default(0.6),
      objective: z.enum(['sortino', 'sharpe', 'return_over_dd']).default('sortino'),
      /** Kosten-Stressfaktor: Kandidat muss auch bei ×Faktor bestehen. */
      stressCostMultiplier: z.number().min(1).default(1.5),
      /** Nie zur Auswahl benutzte Schlusstage (nur Bericht). */
      holdoutDays: z.number().int().min(0).default(60),
      /** Champion nur ersetzen, wenn Kandidat um diesen Faktor besser ist. */
      promotionMargin: z.number().min(0).default(0.1),
      /** PSR der verketteten OOS-Tagesrenditen (gegen SR 0) muss diesen Wert erreichen. */
      minPsrOos: z.number().min(0).max(1).default(0.9),
      /** Deflated Sharpe (In-Sample) zusätzlich als hartes Gate (sonst nur im Bericht). */
      dsrIsGate: z.boolean().default(false),
      /**
       * Höchstanteil des OOS-Nettos, den EIN einzelner Fold tragen darf.
       *
       * Die Lücke, die das schließt: Der TSLA-Champion vom 07.09. bestand
       * alle acht Gates — 103 OOS-Trades, +958 $, 5 von 7 Folds positiv,
       * PSR 0,95. Von den +958 $ stammten aber +919 $ aus EINEM Monat
       * (96 %). Ohne diesen Fold blieben +39 $ über 91 Trades, also nichts.
       * Der unberührte Holdout war entsprechend negativ (−232 $, PF 0,73).
       *
       * Kein Gate schaute darauf. `fold_positive_share` zählt Folds, nicht
       * ihr Gewicht; PSR misst die Renditereihe, nicht ihre Verteilung über
       * die Fenster. Ein Ergebnis, das an einem Monat hängt, ist aber keine
       * Kante, sondern ein Ereignis.
       */
      maxFoldNetShare: z.number().min(0).max(1).default(0.5),
      /**
       * Gepoolt bewerten: EIN Parametersatz je Strategie über das GANZE
       * Universum in einem Simulationslauf (ein Konto, ein Positionslimit),
       * statt je Symbol getrennt.
       *
       * Warum: Je Symbol fragt der Optimierer „hat die Strategie eine Kante
       * auf LTC?" — bei 33 OOS-Trades gegen ein Gate von 60 unbeantwortbar.
       * Gepoolt lautet die Frage „hat sie eine Kante in dieser Assetklasse?"
       * und hat bei 30 Symbolen rund dreißigmal so viele Trades. Zugleich
       * fällt ein ungezählter Freiheitsgrad weg: „bestes Symbol aus dreißig"
       * ist selbst eine Auswahl, die heute niemand deflationiert.
       */
      pooled: z.boolean().default(false),
      /**
       * Korb-Zugehörigkeit je Fold.
       *
       * `point_in_time`: Für jeden Fold wird der Korb zu dessen OOS-Beginn aus
       * `universe.candidates` gewählt — mit Daten bis dahin, Hysterese Fold
       * für Fold, wie nachts Nacht für Nacht (dieselbe `waehleUniverse`).
       * IS-Suche und OOS des Folds laufen auf diesem Korb; das ist genau der
       * Live-Prozess: Der nächtliche Lauf sucht die Parameter des HEUTIGEN
       * Korbs auf dem letzten Jahr. Der Maßstab (Korb liegenlassen) folgt mit.
       *
       * `fixed`: der Korb der Config über das ganze Fenster — die Auswahl von
       * heute, rückwärts angewandt. Am 09.09.2026 kippte genau das ein Urteil:
       * dieselbe Strategie über dieselben Jahre bei 0,71 / −0,18 / 0,04, je
       * nachdem, welcher Endkorb rückwärts galt.
       *
       * Ohne Kandidatenpool oder ungepoolt wirkt der Schalter nicht; der
       * Bericht sagt es dann.
       */
      foldMembership: z.enum(['point_in_time', 'fixed']).default('point_in_time'),
    })
    .default({
      strategies: ['trend_donchian', 'momentum_pullback', 'mean_reversion'],
      lookbackDays: 400,
      isDays: 120,
      oosDays: 30,
      stepDays: 30,
      embargoBars: 0,
      samples: 150,
      seed: 42,
      minOosTrades: 60,
      minFoldPositiveShare: 0.6,
      objective: 'sortino',
      stressCostMultiplier: 1.5,
      holdoutDays: 60,
      promotionMargin: 0.1,
      minPsrOos: 0.9,
      dsrIsGate: false,
      maxFoldNetShare: 0.5,
      pooled: false,
      foldMembership: 'point_in_time',
    }),
  costs: z
    .object({
      /** Slippage je Seite in Basispunkten (Marktorder gegen den Spread). */
      slippageBps: z.number().min(0).default(3),
      /** Halber Spread je Seite in Basispunkten. */
      spreadBps: z.number().min(0).default(2),
      /** SEC-Gebühr auf Verkaufserlöse (Satz, jährlich angepasst). */
      secFeeRate: z.number().min(0).default(0.0000278),
      /** FINRA TAF je verkaufter Aktie, gedeckelt. */
      finraTafPerShare: z.number().min(0).default(0.000166),
      finraTafMax: z.number().min(0).default(8.3),
      /** Krypto-Taker-Gebühr in %. */
      cryptoTakerPct: z.number().min(0).default(0.25),
      /** Leihkosten Short p. a. in %. */
      shortBorrowAnnualPct: z.number().min(0).default(1),
    })
    .default({
      slippageBps: 3,
      spreadBps: 2,
      secFeeRate: 0.0000278,
      finraTafPerShare: 0.000166,
      finraTafMax: 8.3,
      cryptoTakerPct: 0.25,
      shortBorrowAnnualPct: 1,
    }),
  engine: z
    .object({
      /** Abgleich Buch ↔ Broker alle X Sekunden. */
      reconcileEverySec: z.number().int().min(10).default(60),
      /** Karenz nach Bucket-Ende, bis die letzte Minuten-Bar da ist. */
      barGraceSec: z.number().int().min(0).max(60).default(4),
      /** Ohne frische Daten (Sekunden) keine neuen Einstiege. */
      maxDataAgeSec: z.number().int().min(10).default(180),
      /** Nach X Fehlern in Folge Halt (errors). */
      maxConsecutiveErrors: z.number().int().min(1).default(5),
      /** Fremde Positionen beim Broker (nicht im Buch): adopt = übernehmen mit Schutz-Stop, halt = keine Einstiege. */
      onOrphan: z.enum(['adopt', 'halt']).default('halt'),
    })
    .default({ reconcileEverySec: 60, barGraceSec: 4, maxDataAgeSec: 180, maxConsecutiveErrors: 5, onOrphan: 'halt' }),
  notify: z
    .object({
      telegram: z.boolean().default(false),
    })
    .default({ telegram: false }),
  status: z
    .object({
      /** 0 = kein HTTP-Status. */
      httpPort: z.number().int().min(0).max(65535).default(0),
    })
    .default({ httpPort: 0 }),
  paths: z
    .object({
      /** State, Journal, Bars-Cache, Champion, Reports. AUTOTRD_HOME überschreibt. */
      home: z.string().min(1).default('./var'),
    })
    .default({ home: './var' }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RiskConfig = Config['risk'];
export type SessionConfig = Config['session'];
export type CostConfig = Config['costs'];
export type OptimizerConfig = Config['optimizer'];

/* ───────────────────────── Umgebung ───────────────────────── */

export interface Env {
  ALPACA_API_KEY: string;
  ALPACA_SECRET_KEY: string;
  ALPACA_ALLOW_LIVE: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  AUTOTRD_HOME: string;
}

/** Minimaler .env-Parser (KEY=VALUE, #-Kommentare, optionale Anführungszeichen). Überschreibt vorhandene Variablen NICHT. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv(dotenvPath = '.env', base: NodeJS.ProcessEnv = process.env): Env {
  const merged: Record<string, string | undefined> = { ...base };
  if (existsSync(dotenvPath)) {
    const parsed = parseDotenv(readFileSync(dotenvPath, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (merged[k] === undefined || merged[k] === '') merged[k] = v;
    }
  }
  return {
    ALPACA_API_KEY: merged.ALPACA_API_KEY ?? '',
    ALPACA_SECRET_KEY: merged.ALPACA_SECRET_KEY ?? '',
    ALPACA_ALLOW_LIVE: merged.ALPACA_ALLOW_LIVE ?? '0',
    TELEGRAM_BOT_TOKEN: merged.TELEGRAM_BOT_TOKEN ?? '',
    TELEGRAM_CHAT_ID: merged.TELEGRAM_CHAT_ID ?? '',
    AUTOTRD_HOME: merged.AUTOTRD_HOME ?? '',
  };
}

/* ───────────────────────── Laden & Guards ───────────────────────── */

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parseConfig(raw: unknown): Config {
  const res = ConfigSchema.safeParse(raw ?? {});
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('\n  ');
    throw new ConfigError(`Config ungültig:\n  ${msg}`);
  }
  const cfg = res.data;
  if (cfg.optimizer.stepDays !== cfg.optimizer.oosDays) {
    // Größer ⇒ Lücken in der OOS-Kette; kleiner ⇒ dieselben OOS-Tage zählen mehrfach
    // (Red-Team: bei step 10 / oos 30 wären Trades und PSR-n um ×2,75 aufgeblasen).
    throw new ConfigError('optimizer.stepDays muss gleich optimizer.oosDays sein (lückenlose, überlappungsfreie OOS-Kette).');
  }
  // Tiefe Historie nur dort, wo sie billig ist. Intraday bleibt bei 2000 Tagen:
  // 4000 Tage × 78 Bars × 30 Symbole wären rund 9 Mio. Bars je Lauf — der
  // Optimierer liefe ins Speicherlimit, und zwar erst nach dem Datenladen.
  if (cfg.timeframe !== 1440 && cfg.optimizer.lookbackDays > INTRADAY_LOOKBACK_MAX) {
    throw new ConfigError(
      `optimizer.lookbackDays ${cfg.optimizer.lookbackDays} ist für Zeitrahmen ${cfg.timeframe} min zu tief ` +
        `(höchstens ${INTRADAY_LOOKBACK_MAX}). So viel Intraday-Historie sprengt den Speicher; für tiefe Messungen Tagesbars nehmen.`,
    );
  }
  return cfg;
}

/** Tiefste Historie, die ein Intraday-Zeitrahmen laden darf (Kalendertage). */
export const INTRADAY_LOOKBACK_MAX = 2000;

export function loadConfigFile(path: string): Config {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new ConfigError(`Config-Datei nicht gefunden: ${abs}`);
  const text = readFileSync(abs, 'utf8');
  const raw: unknown = parseYaml(text);
  return parseConfig(raw);
}

export type EffectiveMode = 'paper' | 'live';

export interface ModeResolution {
  mode: EffectiveMode;
  /** Warum ggf. auf Paper herabgestuft wurde. */
  reasons: string[];
}

/**
 * Der Doppel-Guard. Gibt NIE 'live' zurück, wenn nicht alle drei Bedingungen
 * erfüllt sind. Wirft, wenn ein Live-Key gegen Paper laufen würde.
 */
export function resolveMode(cfg: Config, env: Env): ModeResolution {
  const reasons: string[] = [];
  const wantsLive = cfg.broker.mode === 'live';
  const allow = env.ALPACA_ALLOW_LIVE === '1';
  const key = env.ALPACA_API_KEY;
  const isLiveKey = key.startsWith('AK');
  const isPaperKey = key.startsWith('PK');

  let mode: EffectiveMode = 'paper';
  if (wantsLive && allow && isLiveKey) {
    mode = 'live';
  } else {
    if (wantsLive && !allow) reasons.push('ALPACA_ALLOW_LIVE ist nicht 1 — Paper.');
    if (wantsLive && allow && !isLiveKey) reasons.push('Kein Live-Key (AK…) — Paper.');
  }
  if (mode === 'paper' && isLiveKey) {
    throw new ConfigError(
      'Live-Key (AK…) konfiguriert, aber Betrieb wäre Paper. Paper-Keys (PK…) eintragen oder alle drei Live-Bedingungen erfüllen.',
    );
  }
  if (mode === 'paper' && key && !isPaperKey) {
    reasons.push('Key-Präfix unbekannt (weder PK noch AK) — wird als Paper behandelt.');
  }
  return { mode, reasons };
}

export function homeDir(cfg: Config, env: Env): string {
  return resolve(env.AUTOTRD_HOME || cfg.paths.home);
}
