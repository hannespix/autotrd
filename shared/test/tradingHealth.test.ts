/**
 * Aggregierte Handelsqualität.
 *
 * Zwei Fehlerklassen sind hier gefährlich, und beide sind lautlos:
 *
 *  1. **Statistisch falsch aggregiert.** Ein Mittel über Konto-Quoten
 *     gewichtet drei Trades wie dreihundert — die Zahl sieht plausibel aus
 *     und ist beliebig weit von der Wahrheit weg.
 *  2. **Zu viel veröffentlicht.** `meta/**` ist öffentlich lesbar. Ein
 *     „Aggregat" über ein einziges Konto gibt dessen Beträge preis.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_ACCOUNTS_PUBLIC,
  aggregateTradingHealth,
  tradingVerdict,
  type AccountContribution,
} from '../src/tradingHealth.js';

const konto = (
  n: number,
  wins: number,
  opts: Partial<{
    avgWin: number;
    avgLoss: number;
    exits: Record<string, { n: number; pnl: number; wins: number }>;
    costs: { n: number; fees: number; grossPnl: number };
  }> = {},
): AccountContribution => ({
  stats: {
    n,
    wins,
    avgWin: opts.avgWin ?? 10,
    avgLoss: opts.avgLoss ?? -10,
  },
  ...(opts.exits ? { exits: opts.exits } : {}),
  ...(opts.costs ? { costs: opts.costs } : {}),
});

describe('aggregateTradingHealth: Trefferquote', () => {
  it('rechnet aus Summen, nicht als Mittel über Konto-Quoten', () => {
    // Konto A: 3 Trades, 3 Gewinne (100 %). Konto B: 300 Trades, 60 (20 %).
    // Ein Mittel über Quoten ergäbe 60 % — die Wahrheit sind 63/303 ≈ 20,8 %.
    const h = aggregateTradingHealth([konto(3, 3), konto(300, 60)]);
    expect(h.trades).toBe(303);
    expect(h.winRatePct).toBeCloseTo(20.79, 1);
  });

  it('ohne Trades ⇒ null statt NaN', () => {
    expect(aggregateTradingHealth([]).winRatePct).toBeNull();
  });

  it('zählt nur Konten MIT geschlossenen Trades', () => {
    // Ein frisch registriertes Konto ohne Trades ist kein Beitrag — es als
    // Konto zu zählen würde die Veröffentlichungsschwelle aushebeln.
    const h = aggregateTradingHealth([konto(10, 5), konto(0, 0), konto(0, 0)]);
    expect(h.accounts).toBe(1);
  });
});

describe('aggregateTradingHealth: Profit-Faktor', () => {
  it('rekonstruiert Brutto aus Durchschnitt × Anzahl', () => {
    // 10 Trades, 6 Gewinner à 20, 4 Verlierer à −10 ⇒ 120 / 40 = 3.
    const h = aggregateTradingHealth([konto(10, 6, { avgWin: 20, avgLoss: -10 })]);
    expect(h.profitFactor).toBe(3);
  });

  it('ein verlustfreies Konto schönt das Gesamtbild NICHT', () => {
    // Der Grund für die Rückrechnung: `tradeStats` liefert für ein Konto
    // ohne Verluste `profitFactor: null`. Würde man Konto-Faktoren mitteln,
    // fiele dieses Konto heraus — und ein Konto mit lauter Gewinnen ist
    // genau das, was das Gesamtbild am stärksten anheben müsste.
    const h = aggregateTradingHealth([
      konto(5, 5, { avgWin: 10, avgLoss: null as unknown as number }),
      konto(10, 2, { avgWin: 10, avgLoss: -10 }),
    ]);
    // Brutto-Gewinn 5·10 + 2·10 = 70, Brutto-Verlust 8·10 = 80
    expect(h.profitFactor).toBeCloseTo(0.875, 3);
  });

  it('ohne Verluste ⇒ null statt Unendlich', () => {
    expect(aggregateTradingHealth([konto(3, 3, { avgLoss: 0 })]).profitFactor).toBeNull();
  });
});

describe('aggregateTradingHealth: Ausstiegsgründe', () => {
  it('summiert über Konten und bildet Anteile', () => {
    const h = aggregateTradingHealth([
      konto(10, 4, { exits: { signal: { n: 8, pnl: -50, wins: 2 }, stop_loss: { n: 2, pnl: -20, wins: 0 } } }),
      konto(10, 6, { exits: { signal: { n: 6, pnl: 10, wins: 4 }, take_profit: { n: 4, pnl: 40, wins: 4 } } }),
    ]);
    expect(h.exits['signal']!.n).toBe(14);
    expect(h.exits['signal']!.share).toBeCloseTo(14 / 20, 4);
    expect(h.exits['signal']!.winRate).toBeCloseTo(6 / 14, 4);
    expect(h.exits['take_profit']!.share).toBeCloseTo(0.2, 4);
  });

  it('ohne Ausstiegsdaten ⇒ leere Aufschlüsselung, kein Absturz', () => {
    expect(aggregateTradingHealth([konto(5, 2)]).exits).toEqual({});
  });
});

describe('aggregateTradingHealth: Gebührenanteil', () => {
  it('setzt die Gebühren ins Verhältnis zum Bruttoergebnis', () => {
    const h = aggregateTradingHealth([
      konto(10, 5, { costs: { n: 10, fees: 30, grossPnl: 100 } }),
    ]);
    expect(h.feeShare).toBeCloseTo(0.3, 4);
  });

  it('bleibt bei einem Brutto-VERLUST positiv', () => {
    // Ohne Betragsbildung wäre das Verhältnis negativ und läse sich wie
    // „die Gebühren haben Geld eingebracht".
    const h = aggregateTradingHealth([
      konto(10, 2, { costs: { n: 10, fees: 30, grossPnl: -100 } }),
    ]);
    expect(h.feeShare).toBeCloseTo(0.3, 4);
  });

  it('ohne Kostendaten ⇒ null', () => {
    expect(aggregateTradingHealth([konto(5, 2)]).feeShare).toBeNull();
  });
});

describe('aggregateTradingHealth: Veröffentlichungsschwelle', () => {
  const mitGeld = (): AccountContribution =>
    konto(10, 5, { costs: { n: 10, fees: 12, grossPnl: 100 } });

  it('hält Beträge zurück, solange zu wenige Konten beitragen', () => {
    // meta/** ist öffentlich lesbar. Ein „Aggregat" über ein Konto gibt
    // dessen Beträge preis — Quoten sind dagegen unkritisch.
    const h = aggregateTradingHealth([mitGeld()]);
    expect(h.netPnl).toBeNull();
    expect(h.fees).toBeNull();
    expect(h.amountsWithheld).toBe(true);
    // Die strukturellen Kennzahlen kommen trotzdem durch:
    expect(h.winRatePct).toBe(50);
    expect(h.feeShare).toBeCloseTo(0.12, 4);
  });

  it('gibt Beträge ab der Schwelle frei', () => {
    const h = aggregateTradingHealth(
      Array.from({ length: MIN_ACCOUNTS_PUBLIC }, mitGeld),
    );
    expect(h.amountsWithheld).toBe(false);
    expect(h.netPnl).toBeCloseTo(88 * MIN_ACCOUNTS_PUBLIC, 2);
    expect(h.fees).toBeCloseTo(12 * MIN_ACCOUNTS_PUBLIC, 2);
  });

  it('die Schwelle zählt KONTEN, nicht Trades', () => {
    // Ein einzelnes Konto mit tausend Trades bleibt ein einzelnes Konto.
    const h = aggregateTradingHealth([
      konto(1000, 500, { costs: { n: 1000, fees: 900, grossPnl: 5000 } }),
    ]);
    expect(h.amountsWithheld).toBe(true);
  });
});

describe('tradingVerdict', () => {
  const basis = aggregateTradingHealth([konto(10, 5)]);

  it('nennt zuerst den teuersten Befund: alles stirbt am Signal', () => {
    const h = aggregateTradingHealth([
      konto(10, 4, { exits: { signal: { n: 9, pnl: -50, wins: 3 }, stop_loss: { n: 1, pnl: -5, wins: 0 } } }),
    ]);
    expect(tradingVerdict(h)).toContain('Signal');
  });

  it('meldet erdrückende Gebühren', () => {
    const h = aggregateTradingHealth([
      konto(10, 5, { costs: { n: 10, fees: 80, grossPnl: 100 } }),
    ]);
    expect(tradingVerdict(h)).toContain('Gebühren');
  });

  it('meldet einen Profit-Faktor unter 1', () => {
    const h = aggregateTradingHealth([konto(10, 3, { avgWin: 10, avgLoss: -10 })]);
    expect(tradingVerdict(h)).toContain('Profit-Faktor');
  });

  it('ohne Trades sagt es das, statt eine Schieflage zu erfinden', () => {
    expect(tradingVerdict(aggregateTradingHealth([]))).toContain('keine geschlossenen Trades');
  });

  it('bei unauffälligen Zahlen bleibt es unauffällig', () => {
    expect(basis.trades).toBe(10);
    expect(tradingVerdict(basis)).toBe('keine auffällige Schieflage');
  });
});
