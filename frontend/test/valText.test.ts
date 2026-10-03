/**
 * Wächter der Validierungs-Codes (Sprachumschalter Phase 3).
 *
 * `validateStrategy` (shared) liefert seit Phase 3 Codes statt deutscher
 * Prosa — `valText` macht daraus den Klartext der gewählten Sprache. Die
 * Vollständigkeits-Probe unten ist der eigentliche Vertrag: JEDER Code, den
 * die Validierung erzeugen kann, muss sich auflösen. Ein Code ohne
 * Wörterbuch-Eintrag stünde sonst roh im UI — genau der Zustand, den die
 * Phase beenden soll.
 */
import { validateStrategy, DEFAULT_STRATEGY } from '@autotrd/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { serverText, valText } from '../src/i18n.js';

let sprache: string | null = null;
beforeEach(() => {
  sprache = null;
  globalThis.localStorage = {
    getItem: (k: string) => (k === 'autotrd-lang' ? sprache : null),
    setItem: () => undefined,
  } as unknown as Storage;
});

describe('valText — Codes werden Klartext', () => {
  it('setzt Feld und Grenzen ein (Deutsch)', () => {
    expect(valText('val.entweder|broker.mode|paper|live')).toBe(
      "broker.mode muss 'paper' oder 'live' sein",
    );
    expect(valText('val.bereich|engine.maxOpenPositions|1|8')).toBe(
      'engine.maxOpenPositions muss zwischen 1 und 8 liegen',
    );
  });

  it('übersetzt nach Englisch, wenn EN gewählt ist', () => {
    sprache = 'en';
    expect(valText('val.pflichtFehlt|watchlist')).toBe("Required key 'watchlist' is missing");
  });

  it('reicht Unbekanntes unverändert durch — nie ein roher Schlüssel im UI', () => {
    expect(valText('irgendein alter Text')).toBe('irgendein alter Text');
    expect(valText('val.gibtEsNicht|x')).toBe('val.gibtEsNicht|x');
  });

  it('serverText löst die von saveStrategy gejointen Codes auf', () => {
    const e = new Error('val.pflichtFehlt|watchlist · val.watchlist');
    expect(serverText(e)).toBe(
      "Pflichtschlüssel 'watchlist' fehlt · watchlist muss ein Array nicht-leerer Symbole sein",
    );
  });
});

describe('Vollständigkeit — jeder erzeugbare Code hat einen Wörterbuch-Eintrag', () => {
  /** Eine Strategie, die möglichst viele Prüfzweige gleichzeitig reißt. */
  function kaputt(): unknown {
    const s = structuredClone(DEFAULT_STRATEGY) as Record<string, Record<string, unknown>>;
    s.broker = { provider: 'x', mode: 'x', initialCapital: -1, paperTrading: 'x', sizingBase: 'x', leverage: 999 };
    s.engine = {
      checkIntervalMin: -1, maxPositionPct: 200, stopLossPct: -1, takeProfitPct: -1,
      trailingStopPct: -1, atrStopMult: -1, maxHoldDays: -1, cooldownMin: -1,
      maxOpenPositions: 0, riskPerTradePct: 999, corePct: 999, mode: 'x',
      byClass: { aktien: 'x', krypto: { w: -1 } }, running: 'x',
    };
    s.indicators = { rsi: 1, macd: 1, bollinger: 1 } as unknown as Record<string, unknown>;
    s.signals = {
      minConfluence: 0, period: '', useForecast: 'x', forecastWeight: -1,
      forecastThresholdPct: -1, exitConfluence: 0, forecastSolo: 'x', trendSolo: 'x',
      timeframe: 'x', allowShort: 'x', minEdgeMultiple: 99, newsVeto: 'x', captureGate: 'x',
    };
    (s as Record<string, unknown>).watchlist = [''];
    return s;
  }

  it('kein Code bleibt unaufgelöst, kein Platzhalter bleibt stehen', () => {
    const probleme = validateStrategy(kaputt());
    // Der Fixture-Wert reißt bewusst VIELE Zweige — wächst die Validierung,
    // ohne dass ein neuer Code hier durchläuft, ist das ein Testloch, kein
    // Fehler. Die Zahl pinnt den Anspruch.
    expect(probleme.length).toBeGreaterThanOrEqual(25);
    for (const p of probleme) {
      const text = valText(p);
      expect(text, p).not.toMatch(/^val\./);
      expect(text, p).not.toContain('{');
    }
  });

  it('auch die Grunddiagnosen lösen sich auf', () => {
    for (const wert of [null, 'yaml', [], { strategy: {} }, {}]) {
      for (const p of validateStrategy(wert)) {
        expect(valText(p), p).not.toMatch(/^val\./);
      }
    }
  });
});
