/**
 * Ampel-gedeckte Trendstimme (Owner-Go 17.08.) — was sie darf und was nicht.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Scan vom 17.08., 13 Krypto-Symbole: `knappVerfehlt` 13 von 13. Jedes
 * einzelne Symbol verfehlte die Konfluenz um GENAU EINE Stimme — MACD hatte
 * eine Meinung (6 Kauf / 7 Verkauf), RSI meldete 13× „halten", Bollinger
 * 12×, und die Prognose stimmt zu Recht nicht mit (44 % Trefferquote über
 * 639 bewertete Prognosen). Bauartbedingter Stillstand, kein Marktzustand.
 *
 * ── Was diese Tests eigentlich bewachen ───────────────────────────────────
 *
 * Nicht, dass die Regel greift — das ist der leichte Teil. Sondern dass sie
 * ENG bleibt. Eine Erleichterung der Einstiegsschwelle ist der gefährlichste
 * Änderungstyp in diesem Repo (der 5-min-Befund vom 30.07.: 525 Trades in
 * zwei Tagen, Gebühren das 4,7-Fache des Bruttos). Jede der Grenzen unten
 * ist eine, deren Wegfall genau dorthin zurückführen würde.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, type SignalsConfig } from '../../shared/src/index.js';
import { computeSignal } from '../src/core/engine.js';

/**
 * Kursreihe mit EINER Trendstimme und sonst Schweigen — die Lage vom 17.08.
 *
 * Ruhige Welle mit leichtem Aufwärtsdrift: MACD dreht ins Positive, während
 * RSI (30/70) und Bollinger (`bbBreakoutPct` 95) in ihrer stummen Zone
 * bleiben. Die Parameter sind gesucht und nicht geraten — mit einem
 * geradlinigen Anstieg landet der RSI sofort über 70, und dann prüften die
 * Tests eine andere Lage als die, um die es geht. Der Vorbedingungs-Test
 * unten nagelt das Stimmbild fest.
 */
function welle(drift: number, phase: number, n = 180, amp = 2, periode = 40): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(100 + i * drift + amp * Math.sin((i + phase) / periode));
  return out;
}

/** Aufwärts: MACD kauft, RSI und Bollinger schweigen. */
function trendSerie(): number[] {
  return welle(0.02, 2);
}

/** Spiegelbild: MACD verkauft, RSI und Bollinger schweigen. */
function abwaertsSerie(): number[] {
  return welle(-0.02, 4, 200, 2, 14);
}

const sig = (
  closes: number[],
  over: Partial<SignalsConfig>,
  opts?: Parameters<typeof computeSignal>[5],
): ReturnType<typeof computeSignal> =>
  computeSignal(
    closes,
    closes[closes.length - 1]!,
    DEFAULT_STRATEGY.indicators,
    { ...DEFAULT_STRATEGY.signals, ...over },
    null,
    opts,
  );

describe('Ampel-gedeckte Trendstimme — die Lage vom 17.08.', () => {
  const closes = trendSerie();

  it('Vorbedingung: genau EINE Stimme, und die kommt vom Trendfolger', () => {
    // Wenn diese Erwartung bricht, prüfen die Tests darunter nicht mehr das,
    // was sie zu prüfen vorgeben — die Serie wäre dann keine 17.08.-Lage.
    const s = sig(closes, { trendSolo: false });
    expect(s.votes.macd).toBe('buy');
    expect(s.votes.rsi).toBe('hold');
    expect(s.buyVotes).toBe(1);
    expect(DEFAULT_STRATEGY.signals.minConfluence).toBe(2);
  });

  it('ohne die Regel bleibt es beim Stillstand', () => {
    expect(sig(closes, { trendSolo: false }, { regime: 'trend' }).direction).toBe('hold');
  });

  it('mit Regel UND Trend-Ampel entsteht ein Kauf-Signal', () => {
    const s = sig(closes, { trendSolo: true }, { regime: 'trend' });
    expect(s.direction).toBe('buy');
    // Die gemeldete Schwelle ist die, die WIRKLICH galt — sonst zählte der
    // Scan das Signal als „um eine Stimme verfehlt".
    expect(s.requiredConfluence).toBe(1);
  });
});

describe('die Regel bleibt eng — jede Grenze einzeln', () => {
  const closes = trendSerie();

  it('ohne Ampel-Angabe greift sie NICHT', () => {
    // Backtest, Anzeige und Regelbaum-Parität kennen den Ampel-Zustand
    // nicht. Sie sollen die strengere Sicht bekommen, nicht stillschweigend
    // eine andere Einstiegsschwelle.
    expect(sig(closes, { trendSolo: true }).direction).toBe('hold');
    expect(sig(closes, { trendSolo: true }, {}).direction).toBe('hold');
  });

  it('im Seitwärts- und Stressmarkt greift sie NICHT', () => {
    expect(sig(closes, { trendSolo: true }, { regime: 'seitwaerts' }).direction).toBe('hold');
    expect(sig(closes, { trendSolo: true }, { regime: 'stress' }).direction).toBe('hold');
  });

  it('abgeschaltet greift sie NICHT — auch bei Trend-Ampel', () => {
    expect(sig(closes, { trendSolo: false }, { regime: 'trend' }).direction).toBe('hold');
    // Und ein fehlendes Feld gilt wie „aus": Nur ein echtes `true` zählt.
    const ohne = { ...DEFAULT_STRATEGY.signals };
    delete (ohne as { trendSolo?: boolean }).trendSolo;
    expect(
      computeSignal(closes, closes[closes.length - 1]!, DEFAULT_STRATEGY.indicators, ohne, null, {
        regime: 'trend',
      }).direction,
    ).toBe('hold');
  });

  it('eine GEGENSTIMME blockt weiter — auch mit Ampel', () => {
    // Der wichtigste Riegel: Die Regel senkt die Schwelle, sie hebelt nicht
    // den Widerspruch aus. Ein Kauf braucht weiter `buyVotes > sellVotes`.
    const s = sig(closes, { trendSolo: true }, { regime: 'trend' });
    expect(s.direction).toBe('buy');
    const gekontert = computeSignal(
      closes,
      closes[closes.length - 1]!,
      DEFAULT_STRATEGY.indicators,
      { ...DEFAULT_STRATEGY.signals, trendSolo: true, forecastSolo: true, forecastWeight: 1 },
      { predictedPct: -5 }, // Prognose sagt klar „runter" → eine Verkaufsstimme
      { regime: 'trend' },
    );
    expect(gekontert.sellVotes).toBeGreaterThanOrEqual(1);
    expect(gekontert.direction).toBe('hold');
  });
});

describe('die Verkaufsseite bekommt sie NIE', () => {
  it('eine einzelne Verkaufs-Trendstimme erzeugt kein Signal', () => {
    const closes = abwaertsSerie();
    const s = sig(closes, { trendSolo: true }, { regime: 'trend' });
    expect(s.votes.macd).toBe('sell');
    expect(s.sellVotes).toBe(1);
    // Im Aufwärtstrend zu verkaufen ist genau das, was die Ampel sperrt.
    // Eine Erleichterung dafür wäre eine Regel gegen sich selbst.
    expect(s.direction).toBe('hold');
    expect(s.requiredConfluence).toBe(DEFAULT_STRATEGY.signals.minConfluence);
  });
});

describe('der AUSSTIEG bleibt unberührt', () => {
  const closes = trendSerie();

  it('mit offener Position gilt weiter die Ausstiegs-Konfluenz', () => {
    // Weder leichter noch schwerer: Die Regel fasst `exitReq` nicht an.
    const mit = sig(closes, { trendSolo: true }, { hasPosition: true, regime: 'trend' });
    const ohne = sig(closes, { trendSolo: false }, { hasPosition: true, regime: 'trend' });
    expect(mit.direction).toBe(ohne.direction);
    expect(mit.requiredConfluence).toBe(ohne.requiredConfluence);
    expect(mit.requiredConfluence).toBe(DEFAULT_STRATEGY.signals.exitConfluence);
  });

  it('auch auf einem offenen Short (Eindecken ist die Kaufrichtung)', () => {
    const mit = sig(closes, { trendSolo: true }, {
      hasPosition: true,
      positionSide: 'short',
      regime: 'trend',
    });
    const ohne = sig(closes, { trendSolo: false }, {
      hasPosition: true,
      positionSide: 'short',
      regime: 'trend',
    });
    expect(mit.direction).toBe(ohne.direction);
    expect(mit.requiredConfluence).toBe(ohne.requiredConfluence);
  });
});
