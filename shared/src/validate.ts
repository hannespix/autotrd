/**
 * Validierung des FLACHEN Strategie-Schemas (CLAUDE.md §2).
 *
 * Wird ab M3/M4 von der `saveStrategy`-Callable und dem Frontend genutzt,
 * damit die bekannte kaputte, verschachtelte Alt-Variante
 * (strategy/indices/risk_management/execution) nie wieder gespeichert
 * werden kann. Pure Funktion, keine Laufzeit-Abhängigkeiten.
 */

import type { Strategy } from './strategy.js';

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
 * Liefert eine Liste von Problemen; leer ⇒ gültig.
 */
export function validateStrategy(value: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return ['Strategie muss ein Objekt sein'];
  }

  for (const key of LEGACY_KEYS) {
    if (key in value) {
      problems.push(
        `Verbotener Alt-Schema-Schlüssel '${key}' — das Schema ist FLACH (broker/watchlist/engine/indicators/signals)`,
      );
    }
  }

  for (const key of REQUIRED_TOP_KEYS) {
    if (!(key in value)) {
      problems.push(`Pflichtschlüssel '${key}' fehlt`);
    }
  }
  if (problems.length > 0) return problems;

  const { broker, watchlist, engine, indicators, signals } = value;

  if (!isRecord(broker)) {
    problems.push('broker muss ein Objekt sein');
  } else {
    if (broker.provider !== 'paper' && broker.provider !== 'alpaca') {
      problems.push("broker.provider muss 'paper' oder 'alpaca' sein");
    }
    if (broker.mode !== 'paper' && broker.mode !== 'live') {
      problems.push("broker.mode muss 'paper' oder 'live' sein");
    }
    if (!isFiniteNumber(broker.initialCapital) || broker.initialCapital <= 0) {
      problems.push('broker.initialCapital muss eine positive Zahl sein');
    }
    if (typeof broker.paperTrading !== 'boolean') {
      problems.push('broker.paperTrading muss boolean sein');
    }
    // Additiv (Bestands-Strategien haben das Feld nicht): fehlend = 'balance'
    if (broker.sizingBase !== undefined && broker.sizingBase !== 'initial' && broker.sizingBase !== 'balance') {
      problems.push("broker.sizingBase muss 'initial' oder 'balance' sein");
    }
  }

  if (!Array.isArray(watchlist) || !watchlist.every((s) => typeof s === 'string' && s.length > 0)) {
    problems.push('watchlist muss ein Array nicht-leerer Symbole sein');
  }

  if (!isRecord(engine)) {
    problems.push('engine muss ein Objekt sein');
  } else {
    for (const k of ['checkIntervalMin', 'maxPositionPct'] as const) {
      if (!isFiniteNumber(engine[k]) || (engine[k] as number) <= 0) {
        problems.push(`engine.${k} muss eine positive Zahl sein`);
      }
    }
    // Stop/Take dürfen 0 sein = „diese Seite ist aus" (Audit 26.07.: die
    // Engine liest 0 seither korrekt als abgeschaltet, nicht als „sofort").
    for (const k of ['stopLossPct', 'takeProfitPct'] as const) {
      if (!isFiniteNumber(engine[k]) || (engine[k] as number) < 0) {
        problems.push(`engine.${k} muss eine Zahl ≥ 0 sein (0 = aus)`);
      }
    }
    // Obergrenze für die Positionsgröße — ohne sie könnte ein Tippfehler
    // ("100") das gesamte Kapital in eine einzige Position werfen.
    if (isFiniteNumber(engine.maxPositionPct) && (engine.maxPositionPct as number) > 100) {
      problems.push('engine.maxPositionPct darf höchstens 100 sein');
    }
    for (const k of ['trailingStopPct', 'atrStopMult', 'atrTakeMult', 'maxHoldDays'] as const) {
      if (engine[k] !== undefined && (!isFiniteNumber(engine[k]) || (engine[k] as number) < 0)) {
        problems.push(`engine.${k} muss eine Zahl ≥ 0 sein (0 = aus)`);
      }
    }
    if (engine.byClass !== undefined) {
      if (!isRecord(engine.byClass)) {
        problems.push('engine.byClass muss ein Objekt sein');
      } else {
        for (const [cls, over] of Object.entries(engine.byClass)) {
          if (!isRecord(over)) {
            problems.push(`engine.byClass.${cls} muss ein Objekt sein`);
            continue;
          }
          for (const [k, v] of Object.entries(over)) {
            if (!isFiniteNumber(v) || v < 0) {
              problems.push(`engine.byClass.${cls}.${k} muss eine Zahl ≥ 0 sein`);
            }
          }
        }
      }
    }
    if (typeof engine.running !== 'boolean') {
      problems.push('engine.running muss boolean sein');
    }
  }

  if (!isRecord(indicators)) {
    problems.push('indicators muss ein Objekt sein');
  } else {
    for (const k of ['rsi', 'macd', 'bollinger'] as const) {
      if (!isRecord(indicators[k])) {
        problems.push(`indicators.${k} muss ein Objekt sein`);
      }
    }
  }

  if (!isRecord(signals)) {
    problems.push('signals muss ein Objekt sein');
  } else {
    if (!isFiniteNumber(signals.minConfluence) || signals.minConfluence < 1) {
      problems.push('signals.minConfluence muss ≥ 1 sein');
    }
    if (typeof signals.period !== 'string' || signals.period.length === 0) {
      problems.push('signals.period muss ein nicht-leerer String sein');
    }
    if (typeof signals.useForecast !== 'boolean') {
      problems.push('signals.useForecast muss boolean sein');
    }
    if (!isFiniteNumber(signals.forecastWeight) || signals.forecastWeight < 0) {
      problems.push('signals.forecastWeight muss ≥ 0 sein');
    }
    if (!isFiniteNumber(signals.forecastThresholdPct) || signals.forecastThresholdPct < 0) {
      problems.push('signals.forecastThresholdPct muss ≥ 0 sein');
    }
    if (signals.exitConfluence !== undefined
      && (!isFiniteNumber(signals.exitConfluence) || signals.exitConfluence < 1)) {
      problems.push('signals.exitConfluence muss ≥ 1 sein');
    }
    if (signals.forecastSolo !== undefined && typeof signals.forecastSolo !== 'boolean') {
      problems.push('signals.forecastSolo muss boolean sein');
    }
  }

  return problems;
}

/** Type-Guard auf Basis von validateStrategy. */
export function isStrategy(value: unknown): value is Strategy {
  return validateStrategy(value).length === 0;
}
