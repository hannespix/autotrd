/**
 * Validierung des FLACHEN Strategie-Schemas (CLAUDE.md §2).
 *
 * Wird ab M3/M4 von der `saveStrategy`-Callable und dem Frontend genutzt,
 * damit die bekannte kaputte, verschachtelte Alt-Variante
 * (strategy/indices/risk_management/execution) nie wieder gespeichert
 * werden kann. Pure Funktion, keine Laufzeit-Abhängigkeiten.
 *
 * ── Meldungen sind CODES, keine Prosa (Sprachumschalter Phase 3) ──────────
 *
 * Jedes Problem hat die Form `val.<muster>|<feld>|<p1>|<p2>` — Parameter
 * enthalten nie ein `|`. Der Klartext (Deutsch ODER Englisch) entsteht erst
 * im Frontend (`valText` in i18n.ts); dieselben Codes wirft die Callable als
 * HttpsError, `serverText` löst sie dort auf. Vorher stand hier deutsche
 * Prosa — im EN-Modus bekam der Nutzer deutsche Ablehnungen. Das Feld steht
 * IMMER als erster Parameter im Code, damit Logs und Tests greifbar bleiben
 * (`…|engine.maxOpenPositions|1|8` sagt auch roh, worum es geht).
 */

import type { Strategy } from './strategy.js';
import { CORE_PCT_CAP, MAX_OPEN_POSITIONS_CAP } from './strategy.js';
import { MAX_LEVERAGE } from './margin.js';
import { MAX_RISK_PER_TRADE_PCT } from './riskSizing.js';

/** Bekannte Schlüssel der kaputten Alt-Struktur — hart verboten. */
const LEGACY_KEYS = ['strategy', 'indices', 'risk_management', 'execution'] as const;

const REQUIRED_TOP_KEYS = ['broker', 'watchlist', 'engine', 'indicators', 'signals'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Prüft einen unbekannten Wert gegen das flache Strategie-Schema.
 * Liefert eine Liste von Problem-CODES (Kopf dieser Datei); leer ⇒ gültig.
 */
export function validateStrategy(value: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return ['val.keinObjekt'];
  }

  for (const key of LEGACY_KEYS) {
    if (key in value) {
      problems.push(`val.altSchema|${key}`);
    }
  }

  for (const key of REQUIRED_TOP_KEYS) {
    if (!(key in value)) {
      problems.push(`val.pflichtFehlt|${key}`);
    }
  }
  if (problems.length > 0) return problems;

  const { broker, watchlist, engine, indicators, signals } = value;

  if (!isRecord(broker)) {
    problems.push('val.objekt|broker');
  } else {
    if (broker.provider !== 'paper' && broker.provider !== 'alpaca') {
      problems.push('val.entweder|broker.provider|paper|alpaca');
    }
    if (broker.mode !== 'paper' && broker.mode !== 'live') {
      problems.push('val.entweder|broker.mode|paper|live');
    }
    if (!isFiniteNumber(broker.initialCapital) || broker.initialCapital <= 0) {
      problems.push('val.zahlPositiv|broker.initialCapital');
    }
    if (typeof broker.paperTrading !== 'boolean') {
      problems.push('val.boolean|broker.paperTrading');
    }
    // Additiv (Bestands-Strategien haben das Feld nicht): fehlend = 'balance'
    if (broker.sizingBase !== undefined && broker.sizingBase !== 'initial' && broker.sizingBase !== 'balance') {
      problems.push('val.entweder|broker.sizingBase|initial|balance');
    }
    // Hebel: additiv, fehlend = 1 (aus). Die Obergrenze steht auch hier und
    // nicht nur in der serverseitigen Hülle — ein Wert, den der Server ohnehin
    // klemmt, soll gar nicht erst speicherbar sein, sonst zeigt die UI eine
    // Zahl an, nach der nie gehandelt wird.
    if (broker.leverage !== undefined
      && (!isFiniteNumber(broker.leverage) || broker.leverage < 1 || broker.leverage > MAX_LEVERAGE)) {
      problems.push(`val.bereichHebel|broker.leverage|1|${MAX_LEVERAGE}`);
    }
  }

  if (!Array.isArray(watchlist) || !watchlist.every((s) => typeof s === 'string' && s.length > 0)) {
    problems.push('val.watchlist');
  }

  if (!isRecord(engine)) {
    problems.push('val.objekt|engine');
  } else {
    for (const k of ['checkIntervalMin', 'maxPositionPct'] as const) {
      if (!isFiniteNumber(engine[k]) || (engine[k] as number) <= 0) {
        problems.push(`val.zahlPositiv|engine.${k}`);
      }
    }
    // Stop/Take dürfen 0 sein = „diese Seite ist aus" (Audit 26.07.: die
    // Engine liest 0 seither korrekt als abgeschaltet, nicht als „sofort").
    for (const k of ['stopLossPct', 'takeProfitPct'] as const) {
      if (!isFiniteNumber(engine[k]) || (engine[k] as number) < 0) {
        problems.push(`val.zahlNullAus|engine.${k}`);
      }
    }
    // Obergrenze für die Positionsgröße — ohne sie könnte ein Tippfehler
    // ("100") das gesamte Kapital in eine einzige Position werfen.
    if (isFiniteNumber(engine.maxPositionPct) && (engine.maxPositionPct as number) > 100) {
      problems.push('val.hoechstens|engine.maxPositionPct|100');
    }
    for (const k of ['trailingStopPct', 'atrStopMult', 'atrTakeMult', 'maxHoldDays'] as const) {
      if (engine[k] !== undefined && (!isFiniteNumber(engine[k]) || (engine[k] as number) < 0)) {
        problems.push(`val.zahlNullAus|engine.${k}`);
      }
    }
    if (engine.cooldownMin !== undefined && (!isFiniteNumber(engine.cooldownMin) || engine.cooldownMin < 0)) {
      problems.push('val.zahlNull|engine.cooldownMin');
    }
    if (engine.maxOpenPositions !== undefined
      && (!isFiniteNumber(engine.maxOpenPositions)
        || engine.maxOpenPositions < 1
        || engine.maxOpenPositions > MAX_OPEN_POSITIONS_CAP)) {
      problems.push(`val.bereich|engine.maxOpenPositions|1|${MAX_OPEN_POSITIONS_CAP}`);
    }
    if (engine.riskPerTradePct !== undefined
      && (!isFiniteNumber(engine.riskPerTradePct)
        || engine.riskPerTradePct < 0
        || engine.riskPerTradePct > MAX_RISK_PER_TRADE_PCT)) {
      problems.push(`val.bereichAus|engine.riskPerTradePct|0|${MAX_RISK_PER_TRADE_PCT}`);
    }
    if (engine.corePct !== undefined
      && (!isFiniteNumber(engine.corePct) || engine.corePct < 0 || engine.corePct > CORE_PCT_CAP)) {
      problems.push(`val.bereichSockel|engine.corePct|0|${CORE_PCT_CAP}`);
    }
    if (engine.mode !== undefined && engine.mode !== 'confluence' && engine.mode !== 'momentum') {
      problems.push('val.entweder|engine.mode|confluence|momentum');
    }
    if (engine.byClass !== undefined) {
      if (!isRecord(engine.byClass)) {
        problems.push('val.objekt|engine.byClass');
      } else {
        for (const [cls, over] of Object.entries(engine.byClass)) {
          if (!isRecord(over)) {
            problems.push(`val.objekt|engine.byClass.${cls}`);
            continue;
          }
          for (const [k, v] of Object.entries(over)) {
            if (!isFiniteNumber(v) || v < 0) {
              problems.push(`val.zahlNull|engine.byClass.${cls}.${k}`);
            }
          }
        }
      }
    }
    if (typeof engine.running !== 'boolean') {
      problems.push('val.boolean|engine.running');
    }
  }

  if (!isRecord(indicators)) {
    problems.push('val.objekt|indicators');
  } else {
    for (const k of ['rsi', 'macd', 'bollinger'] as const) {
      if (!isRecord(indicators[k])) {
        problems.push(`val.objekt|indicators.${k}`);
      }
    }
  }

  if (!isRecord(signals)) {
    problems.push('val.objekt|signals');
  } else {
    if (!isFiniteNumber(signals.minConfluence) || signals.minConfluence < 1) {
      problems.push('val.mindestens|signals.minConfluence|1');
    }
    if (typeof signals.period !== 'string' || signals.period.length === 0) {
      problems.push('val.stringNichtLeer|signals.period');
    }
    if (typeof signals.useForecast !== 'boolean') {
      problems.push('val.boolean|signals.useForecast');
    }
    if (!isFiniteNumber(signals.forecastWeight) || signals.forecastWeight < 0) {
      problems.push('val.zahlNull|signals.forecastWeight');
    }
    if (!isFiniteNumber(signals.forecastThresholdPct) || signals.forecastThresholdPct < 0) {
      problems.push('val.zahlNull|signals.forecastThresholdPct');
    }
    if (signals.exitConfluence !== undefined
      && (!isFiniteNumber(signals.exitConfluence) || signals.exitConfluence < 1)) {
      problems.push('val.mindestens|signals.exitConfluence|1');
    }
    if (signals.forecastSolo !== undefined && typeof signals.forecastSolo !== 'boolean') {
      problems.push('val.boolean|signals.forecastSolo');
    }
    if (signals.trendSolo !== undefined && typeof signals.trendSolo !== 'boolean') {
      problems.push('val.boolean|signals.trendSolo');
    }
    if (signals.timeframe !== undefined && signals.timeframe !== 'daily' && signals.timeframe !== 'intraday') {
      problems.push('val.entweder|signals.timeframe|daily|intraday');
    }
    if (signals.allowShort !== undefined && typeof signals.allowShort !== 'boolean') {
      problems.push('val.boolean|signals.allowShort');
    }
    // 0 = Kostenschwelle aus. Nach oben gedeckelt, weil ein Tippfehler ("30")
    // sonst jeden Einstieg blockierte und die Engine still stillstünde.
    if (signals.minEdgeMultiple !== undefined
      && (!isFiniteNumber(signals.minEdgeMultiple)
        || signals.minEdgeMultiple < 0
        || signals.minEdgeMultiple > 10)) {
      problems.push('val.bereichAus|signals.minEdgeMultiple|0|10');
    }
    if (signals.newsVeto !== undefined && typeof signals.newsVeto !== 'boolean') {
      problems.push('val.boolean|signals.newsVeto');
    }
    if (signals.captureGate !== undefined && typeof signals.captureGate !== 'boolean') {
      problems.push('val.boolean|signals.captureGate');
    }
  }

  return problems;
}

/** Type-Guard auf Basis von validateStrategy. */
export function isStrategy(value: unknown): value is Strategy {
  return validateStrategy(value).length === 0;
}
