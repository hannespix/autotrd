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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Wie viele Konten stehen hinter einer Klassen-Kante? (MG5)
 *
 * Die Zahl entscheidet, ob ein Konto seine Gewichte nach fremder Erfahrung
 * stellen darf. Stammen 58 Trades aus sieben Konten oder aus einem einzigen?
 * Im zweiten Fall ist der „globale" Wert schlicht dessen eigener.
 */
describe('aggregateTradingHealth: Konten je Klasse', () => {
  const mitKlasse = (
    n: number,
    byClass: Record<string, { n: number; pnl: number; notional: number }>,
  ): AccountContribution => ({
    stats: { n, wins: 0, avgWin: 10, avgLoss: -10 },
    byClass,
  });

  it('zählt nur Konten, die in DIESER Klasse gehandelt haben', () => {
    const h = aggregateTradingHealth([
      mitKlasse(10, { crypto: { n: 10, pnl: -5, notional: 1000 } }),
      mitKlasse(10, { crypto: { n: 10, pnl: -5, notional: 1000 } }),
      mitKlasse(10, { stocks_us: { n: 10, pnl: 5, notional: 1000 } }),
    ]);
    expect(h.klassen.crypto?.konten).toBe(2);
    expect(h.klassen.stocks_us?.konten).toBe(1);
    expect(h.klassen.crypto?.n).toBe(20);
  });

  it('ein leerer Klassen-Eintrag ist kein Beitrag', () => {
    // Ein Eintrag mit n = 0 entsteht schon durch das bloße Anlegen einer
    // Watchlist — er hat nichts gemessen und darf die Vertrauensschwelle
    // nicht mit hochzählen.
    const h = aggregateTradingHealth([
      mitKlasse(10, { fx: { n: 10, pnl: 1, notional: 500 } }),
      mitKlasse(5, { fx: { n: 0, pnl: 0, notional: 0 }, gold: { n: 5, pnl: 1, notional: 100 } }),
    ]);
    expect(h.klassen.fx?.konten).toBe(1);
  });
});

/* ── Exit-Geld je Ausstiegsgrund (22.08., Multi-Agenten-Befund) ────────────
 *
 * Anteil und Trefferquote beantworten „wie oft", nicht „wie viel". In der
 * Woche zum 22.08. standen die vier Ausstiegsarten bei fast gleichen
 * Stückzahlen (23/22/21/9) — daraus war nicht ablesbar, ob die 22 Stopps
 * 200 $ oder 2 000 $ gekostet haben. Genau daran hängt aber, ob das Problem
 * bei den Gebühren liegt oder beim Bruttoergebnis.
 *
 * Die Zahl war die ganze Zeit da: `ExitBucket.pnl` wird in `exitBreakdown`
 * summiert und reist im Konto-Beitrag bis hierher — verworfen wurde sie erst
 * vom Parametertyp der letzten Stufe. Eine Zahl, die den ganzen Weg mitreist
 * und einen Schritt vor dem Ziel wegfällt, ist schwerer zu finden als eine,
 * die es nie gab. Deshalb steht sie hier fest.
 */
describe('Exit-Geld erreicht die letzte Stufe', () => {
  /* DREI Konten, nicht zwei: Die Geldsumme je Ausstiegsgrund unterliegt
   * derselben Schwelle wie `fees` und `netPnl` (MIN_ACCOUNTS_PUBLIC).
   * Beim Einbau am 22.08. hing sie an nichts — die Tests standen deshalb
   * mit zwei Konten und haetten die Luecke nie gezeigt. */
  const mitGeld = (
    exits: Record<string, { n: number; pnl: number; wins: number }>,
  ): AccountContribution[] => [konto(10, 5, { exits }), konto(10, 5, { exits }), konto(10, 5, { exits })];

  it('pnl je Ausstiegsgrund kommt an und wird summiert', () => {
    const h = aggregateTradingHealth(
      mitGeld({
        stop_loss: { n: 4, pnl: -800, wins: 0 },
        take_profit: { n: 3, pnl: 300, wins: 3 },
      }),
    );
    // Drei identische Konten ⇒ dreifache Summen.
    expect(h.exits['stop_loss']?.pnl).toBe(-2400);
    expect(h.exits['take_profit']?.pnl).toBe(900);
  });

  it('die Abdeckung stimmt: Summe der n über alle Eimer == trades7t', () => {
    /* Auflage aus der Synthese: nicht nur „nicht leer" prüfen. Ein Eimer,
     * der stillschweigend wegfällt, verschöbe jede Aussage über das Geld —
     * und wäre an einer bloßen Nicht-Leer-Prüfung vorbeigekommen. */
    const exits7t = {
      signal: { n: 21, pnl: 140, wins: 15 },
      take_profit: { n: 23, pnl: 610, wins: 23 },
      stop_loss: { n: 22, pnl: -1900, wins: 0 },
      trailing_stop: { n: 9, pnl: -70, wins: 1 },
    };
    const h = aggregateTradingHealth([
      { ...konto(10, 5), exits7t },
      { ...konto(10, 5), exits7t },
      { ...konto(10, 5), exits7t },
    ] as AccountContribution[]);
    const summeN = Object.values(h.exits7t).reduce((a, e) => a + e.n, 0);
    expect(summeN).toBe(h.trades7t);
    expect(Object.keys(h.exits7t).sort()).toEqual(Object.keys(exits7t).sort());
    // Und das Geld trägt das Vorzeichen, auf das es ankommt.
    expect(h.exits7t['stop_loss']!.pnl).toBeLessThan(0);
    expect(h.exits7t['take_profit']!.pnl).toBeGreaterThan(0);
  });

  it('ein fehlendes pnl im Beitrag zählt als 0, nicht als NaN', () => {
    // Altbestand aus der Zeit vor dem Feld darf die Summe nicht vergiften:
    // Ein einziges NaN würde den ganzen Eimer unbrauchbar machen.
    const h = aggregateTradingHealth([
      { ...konto(10, 5), exits: { signal: { n: 2, wins: 1 } } },
      { ...konto(10, 5), exits: { signal: { n: 2, pnl: 50, wins: 1 } } },
      { ...konto(10, 5), exits: { signal: { n: 2, pnl: 50, wins: 1 } } },
    ] as unknown as AccountContribution[]);
    expect(h.exits['signal']?.pnl).toBe(100);
    expect(Number.isFinite(h.exits['signal']!.pnl!)).toBe(true);
  });
});

describe('Das Urteil behauptet keine Ursache, die es nicht gemessen hat', () => {
  /* Bis zum 22.08. stand hier „… — Handelsfrequenz zu hoch", gebildet allein
   * aus feeShare > 0,5, ohne dass eine einzige Frequenzgröße in die
   * Entscheidung einging. Nachgerechnet trug der Satz auch nicht: ~415 $
   * Gebühren gegen ~1 650 $ Brutto-Verschlechterung in derselben Woche. */
  const teuer = () =>
    tradingVerdict({
      ...aggregateTradingHealth([
        konto(10, 5, { costs: { n: 10, fees: 800, grossPnl: 1000 } }),
        konto(10, 5, { costs: { n: 10, fees: 800, grossPnl: 1000 } }),
      ]),
    });

  it('die Gebühren-Aussage bleibt — Kostenwahrheit wird nie abgeschwächt', () => {
    expect(teuer()).toContain('Gebühren fressen');
    expect(teuer()).toContain('%');
  });

  it('die Frequenz-Behauptung ist weg', () => {
    expect(teuer()).not.toContain('Handelsfrequenz');
    expect(teuer()).not.toContain('zu hoch');
  });
});

describe('Das Exit-Geld unterliegt derselben Schwelle wie fees und netPnl', () => {
  /* Nachgetragen am 22.08., am selben Tag wie der Einbau. `netPnl`, `fees`
   * und `klassen[].fees` haengen an `accounts >= MIN_ACCOUNTS_PUBLIC`; das
   * neue `pnl` je Ausstiegsgrund hing an nichts. Bei EINEM beitragenden
   * Konto waeren das dessen Betraege mit einem anderen Etikett — in einem
   * Dokument, das oeffentlich lesbar ist.
   *
   * Der Dateikopf von tradingHealth.ts sagt genau, warum das jetzt und
   * nicht spaeter zu schliessen ist: „Es wird kritisch in dem Moment, in
   * dem sich der zweite Nutzer registriert — und dann ist es zu spaet, die
   * Schwelle nachzuruesten." */
  const exits = { stop_loss: { n: 4, pnl: -800, wins: 0 } };

  it('unter der Schwelle bleibt das Geld weg — Anteil und Quote bleiben', () => {
    const h = aggregateTradingHealth([konto(10, 5, { exits }), konto(10, 5, { exits })]);
    expect(h.accounts).toBeLessThan(MIN_ACCOUNTS_PUBLIC);
    expect(h.exits['stop_loss']?.pnl).toBeNull();
    // Die STRUKTUR bleibt öffentlich — nur der Betrag nicht.
    expect(h.exits['stop_loss']?.n).toBe(8);
    expect(h.exits['stop_loss']?.share).toBe(1);
    expect(h.amountsWithheld).toBe(true);
  });

  it('ab der Schwelle kommt es dazu — dieselbe Grenze wie bei fees', () => {
    const h = aggregateTradingHealth([
      konto(10, 5, { exits, costs: { n: 10, fees: 50, grossPnl: 100 } }),
      konto(10, 5, { exits, costs: { n: 10, fees: 50, grossPnl: 100 } }),
      konto(10, 5, { exits, costs: { n: 10, fees: 50, grossPnl: 100 } }),
    ]);
    expect(h.accounts).toBeGreaterThanOrEqual(MIN_ACCOUNTS_PUBLIC);
    expect(h.exits['stop_loss']?.pnl).toBe(-2400);
    // Exit-Geld und Gebühren fallen GEMEINSAM — eine gemeinsame Schwelle,
    // nicht zwei, die auseinanderlaufen können.
    expect(h.fees).not.toBeNull();
    expect(h.amountsWithheld).toBe(false);
  });
});

describe('Quelltext-Wächter: kein zweiter Gebühren-Quotient', () => {
  /* Die naheliegende „Reparatur" wäre ein feeShare7t — endlich auf derselben
   * Zeitachse wie exits7t. Sie ist die SCHLECHTERE Zahl: Ein Quotient mit dem
   * Bruttoergebnis im Nenner sieht umso besser aus, je schlechter die Woche
   * war (415/1600 ≈ 0,26 in einer Woche mit ~2 000 $ Verlust), geht bei einer
   * ausgeglichenen Woche routinemäßig durch null — und stünde als Urteil im
   * täglichen KI-Bericht. Deshalb steht hier die Geld-SUMME je Ausstiegsgrund
   * und ausdrücklich kein weiteres Verhältnis. */
  const quelle = readFileSync(join(import.meta.dirname, '..', 'src', 'tradingHealth.ts'), 'utf8');

  it('feeShare wird genau EINMAL gebildet — kein 7-Tage-Zwilling', () => {
    // Nur die RECHNUNG zählen, nicht die Typdeklaration — sonst zählt der
    // Wächter sich selbst an der Schnittstelle fest und wird beim ersten
    // Umbenennen eines Feldes rot, ohne dass etwas passiert wäre.
    const treffer = quelle.match(/feeShare:\s*brutto/g) ?? [];
    expect(treffer, 'feeShare wird nicht genau einmal gerechnet').toHaveLength(1);
    for (const verboten of ['feeShare7t', 'fees7t', 'grossPnl7t']) {
      expect(quelle, `${verboten} ist ausdrücklich nicht gewollt`).not.toContain(verboten);
    }
  });

  it('das Exit-Geld bleibt eine Summe und wird durch nichts geteilt', () => {
    const block = quelle.slice(quelle.indexOf('const exitShares'), quelle.indexOf('const exits ='));
    expect(block).toContain('Math.round(e.pnl * 100) / 100');
    expect(block, 'aus dem Exit-Geld ist ein Verhältnis geworden').not.toMatch(/pnl[^;]*\/\s*(summe|brutto|grossPnl)/);
  });
});
