/**
 * Tests der regime-gerechten Lesart.
 *
 * Der teuerste Fehler wäre ein gedrehtes Vorzeichen beim Bollinger: Genau
 * dort unterscheidet sich diese Variante von der Live-Logik, und genau dort
 * würde ein Fehler die Messung zugunsten der neuen Lesart verfälschen —
 * also zugunsten der Änderung, über die sie entscheiden soll.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY } from '../src/strategy.js';
import { RSI_MITTE, RSI_TOTZONE, regimeRichtung, regimeStimmen } from '../src/regimeSignal.js';
import type { IndicatorSnapshot } from '../src/strategy.js';

const CFG = DEFAULT_STRATEGY.indicators;

function snap(o: {
  rsi?: number | null;
  macd?: { line: number; signal: number; histogram: number } | null;
  pctB?: number | null;
}): IndicatorSnapshot {
  return {
    rsi: o.rsi ?? null,
    macd: o.macd ?? null,
    bollinger:
      o.pctB === null || o.pctB === undefined
        ? null
        : { upper: 110, middle: 100, lower: 90, pctB: o.pctB },
  };
}

describe('Bollinger — hier dreht sich das Vorzeichen', () => {
  it('liest den Ausbruch nach oben im TREND als Stärke (buy)', () => {
    const s = regimeStimmen(snap({ pctB: 98 }), 'trend', CFG);
    expect(s.votes.bollinger).toBe('buy');
    expect(s.buyVotes).toBe(1);
  });

  it('liest denselben Ausbruch SEITWÄRTS als Übertreibung (sell)', () => {
    const s = regimeStimmen(snap({ pctB: 98 }), 'seitwaerts', CFG);
    expect(s.votes.bollinger).toBe('sell');
    expect(s.sellVotes).toBe(1);
  });

  it('spiegelt das auch am unteren Band', () => {
    expect(regimeStimmen(snap({ pctB: 2 }), 'trend', CFG).votes.bollinger).toBe('sell');
    expect(regimeStimmen(snap({ pctB: 2 }), 'seitwaerts', CFG).votes.bollinger).toBe('buy');
  });

  it('schweigt in der Mitte — in beiden Regimes', () => {
    expect(regimeStimmen(snap({ pctB: 50 }), 'trend', CFG).votes.bollinger).toBe('hold');
    expect(regimeStimmen(snap({ pctB: 50 }), 'seitwaerts', CFG).votes.bollinger).toBe('hold');
  });
});

describe('RSI — Momentum-Lesart nur im Trend', () => {
  it('bestätigt im Trend die Richtung statt gegen sie zu arbeiten', () => {
    // Genau der Wert, bei dem die Live-Logik schweigt (zwischen 30 und 70)
    // und die Blockade entsteht.
    expect(regimeStimmen(snap({ rsi: 60 }), 'trend', CFG).votes.rsi).toBe('buy');
    expect(regimeStimmen(snap({ rsi: 40 }), 'trend', CFG).votes.rsi).toBe('sell');
  });

  it('hat eine Totzone um die Mitte', () => {
    for (const r of [RSI_MITTE, RSI_MITTE + RSI_TOTZONE, RSI_MITTE - RSI_TOTZONE]) {
      expect(regimeStimmen(snap({ rsi: r }), 'trend', CFG).votes.rsi).toBe('hold');
    }
  });

  it('bleibt seitwärts bei den Extremschwellen', () => {
    expect(regimeStimmen(snap({ rsi: 60 }), 'seitwaerts', CFG).votes.rsi).toBe('hold');
    expect(regimeStimmen(snap({ rsi: 25 }), 'seitwaerts', CFG).votes.rsi).toBe('buy');
    expect(regimeStimmen(snap({ rsi: 75 }), 'seitwaerts', CFG).votes.rsi).toBe('sell');
  });
});

describe('MACD bleibt unverändert', () => {
  it('stimmt in beiden Regimes gleich ab', () => {
    const m = { line: 2, signal: 1, histogram: 0.5 };
    expect(regimeStimmen(snap({ macd: m }), 'trend', CFG).votes.macd).toBe('buy');
    expect(regimeStimmen(snap({ macd: m }), 'seitwaerts', CFG).votes.macd).toBe('buy');
  });
});

describe('Stress', () => {
  it('gibt gar keine Stimme ab', () => {
    // Ein Signal, dem man nicht trauen kann, ist schlechter als keins.
    const s = regimeStimmen(
      snap({ rsi: 80, pctB: 99, macd: { line: 2, signal: 1, histogram: 1 } }),
      'stress',
      CFG,
    );
    expect(s.votes).toEqual({});
    expect(s.buyVotes).toBe(0);
    expect(s.sellVotes).toBe(0);
  });
});

describe('Der Fall vom 04.08. — löst die Variante die Blockade?', () => {
  it('erzeugt im Trend eine Kaufkonfluenz, wo die Live-Logik schwieg', () => {
    // Reale Lage: RSI zwischen den Schwellen (Live: hold), Bollinger in den
    // mittleren 90 % (Live: hold), MACD auf buy. Live-Ergebnis: 1 Stimme,
    // knapp verfehlt — 13-mal von 13.
    const s = regimeStimmen(
      snap({ rsi: 58, pctB: 88, macd: { line: 2, signal: 1, histogram: 0.4 } }),
      'trend',
      CFG,
    );
    expect(s.buyVotes).toBe(2); // rsi + macd
    expect(regimeRichtung(s, 2)).toBe('buy');
  });

  it('erzeugt trotzdem KEIN Signal, wenn die Stimmen sich aufheben', () => {
    // Wichtig: Die Variante soll die Konfluenz erreichbar machen, nicht
    // abschaffen. Steht es 1:1, bleibt es „hold".
    const s = regimeStimmen(
      snap({ rsi: 58, pctB: 3, macd: { line: 1, signal: 1, histogram: 0 } }),
      'trend',
      CFG,
    );
    expect(s.buyVotes).toBe(1); // rsi
    expect(s.sellVotes).toBe(1); // bollinger (unteres Band = Schwäche im Trend)
    expect(regimeRichtung(s, 2)).toBe('hold');
  });

  it('lässt die Mehrheit entscheiden, wenn zwei gegen eine stehen', () => {
    // 2:1 ist kein Patt — die Konfluenz ist erreicht und hat Vorsprung.
    const s = regimeStimmen(
      snap({ rsi: 58, pctB: 3, macd: { line: 1, signal: 2, histogram: -0.4 } }),
      'trend',
      CFG,
    );
    expect(s.sellVotes).toBe(2);
    expect(regimeRichtung(s, 2)).toBe('sell');
  });
});

describe('regimeRichtung', () => {
  it('verlangt die Konfluenz und einen Vorsprung', () => {
    expect(regimeRichtung({ votes: {}, buyVotes: 2, sellVotes: 2 }, 2)).toBe('hold');
    expect(regimeRichtung({ votes: {}, buyVotes: 1, sellVotes: 0 }, 2)).toBe('hold');
    expect(regimeRichtung({ votes: {}, buyVotes: 3, sellVotes: 1 }, 2)).toBe('buy');
    expect(regimeRichtung({ votes: {}, buyVotes: 0, sellVotes: 2 }, 2)).toBe('sell');
  });

  it('verträgt eine unsinnige Schwelle, ohne aus 0 Stimmen ein Signal zu machen', () => {
    expect(regimeRichtung({ votes: {}, buyVotes: 0, sellVotes: 0 }, 0)).toBe('hold');
  });
});
