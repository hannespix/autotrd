/**
 * Cross-Sectional Momentum — die Regeln, an denen das Portfolio hängt.
 *
 * Jeder Test hier hält eine Entscheidung fest, die man beim Lesen des Codes
 * für Geschmackssache halten könnte, die es aber nicht ist: das ausgelassene
 * letzte Monat, die Weigerung bei zu kurzer Historie zu raten, der
 * geschlossene Marktfilter bei Unklarheit, das Nicht-Nachjustieren
 * bestehender Positionen. Genau diese vier Punkte entscheiden, ob die
 * Strategie das ist, was die Literatur beschreibt — oder eine ähnlich
 * aussehende, die anders funktioniert.
 */

import { describe, expect, it } from 'vitest';
import {
  MARKET_FILTER_SMA,
  MOMENTUM_DEFAULTS,
  MOMENTUM_TOP_N,
  applyMomentumOrders,
  emptyMomentumBook,
  istRebalanceFaellig,
  marketFilterPasses,
  momentumEquity,
  momentumScore,
  rankMomentum,
  rebalanceOrders,
  targetPortfolio,
} from '../src/momentum.js';
import { isTradable } from '../src/universe.js';
import { feeRateForClass } from '../src/strategy.js';

/** Kursreihe mit konstanter Tagesrendite — analytisch nachrechenbar. */
const rampe = (n: number, start: number, proTagPct: number): number[] =>
  Array.from({ length: n }, (_, i) => start * (1 + proTagPct / 100) ** i);

describe('momentumScore', () => {
  it('misst von t−252 bis t−21, nicht bis zum letzten Kurs', () => {
    // Reihe steigt bis Index 280, dann bricht sie ein. Der Score darf den
    // Einbruch NICHT sehen: Er endet 21 Tage vor dem Ende.
    const closes = [...rampe(281, 100, 0.1), ...Array.from({ length: 21 }, () => 10)];
    const s = momentumScore(closes)!;
    expect(s).toBeGreaterThan(0);
    // Gegenprobe: ohne Skip liefe der Score in den Einbruch und wäre negativ.
    expect(momentumScore(closes, { skipDays: 0 })!).toBeLessThan(0);
  });

  it('rechnet die Rendite über das Fenster korrekt', () => {
    // 253 Tage bei +0,1 %/Tag; Fenster ist [len-1-252 .. len-1-21] = 231 Tage.
    const closes = rampe(253, 100, 0.1);
    const erwartet = (1.001 ** 231 - 1) * 100;
    expect(momentumScore(closes)!).toBeCloseTo(erwartet, 6);
  });

  it('verweigert den Score bei zu kurzer Historie, statt zu raten', () => {
    // Ein Score aus drei Monaten ist mit einem aus zwölf nicht vergleichbar —
    // und ein Ranking über unvergleichbare Zahlen ist wertlos.
    expect(momentumScore(rampe(MOMENTUM_DEFAULTS.minBars - 1, 100, 0.1))).toBeNull();
    expect(momentumScore(rampe(MOMENTUM_DEFAULTS.minBars, 100, 0.1))).not.toBeNull();
  });

  it('verweigert den Score bei kaputten Kursen', () => {
    const closes = rampe(260, 100, 0.1);
    closes[260 - 1 - MOMENTUM_DEFAULTS.skipDays] = Number.NaN;
    expect(momentumScore(closes)).toBeNull();
    const nullen = rampe(260, 100, 0.1);
    nullen[Math.max(0, 260 - 1 - MOMENTUM_DEFAULTS.lookbackDays)] = 0;
    expect(momentumScore(nullen)).toBeNull();
  });
});

describe('rankMomentum', () => {
  const universum = {
    STARK: rampe(300, 100, 0.15),
    MITTEL: rampe(300, 100, 0.05),
    SCHWACH: rampe(300, 100, -0.05),
    KURZ: rampe(50, 100, 0.5), // zu wenig Historie
  };

  it('sortiert absteigend und lässt Unbewertbare ganz weg', () => {
    const r = rankMomentum(universum);
    expect(r.map((x) => x.symbol)).toEqual(['STARK', 'MITTEL', 'SCHWACH']);
    // KURZ wird nicht ans Ende gestellt, sondern gar nicht erst gewertet.
    expect(r.some((x) => x.symbol === 'KURZ')).toBe(false);
  });

  it('bricht Gleichstand deterministisch — zwei Läufe, ein Portfolio', () => {
    const gleich = { ZEBRA: rampe(300, 100, 0.1), ALPHA: rampe(300, 100, 0.1) };
    expect(rankMomentum(gleich).map((x) => x.symbol)).toEqual(['ALPHA', 'ZEBRA']);
    expect(rankMomentum(gleich)).toEqual(rankMomentum(gleich));
  });

  it('nimmt Map und Objekt gleichwertig entgegen', () => {
    const alsMap = new Map(Object.entries(universum));
    expect(rankMomentum(alsMap)).toEqual(rankMomentum(universum));
  });
});

describe('marketFilterPasses', () => {
  it('öffnet über der 200-Tage-Linie, schließt darunter', () => {
    expect(marketFilterPasses(rampe(MARKET_FILTER_SMA + 50, 100, 0.1))).toBe(true);
    expect(marketFilterPasses(rampe(MARKET_FILTER_SMA + 50, 100, -0.1))).toBe(false);
  });

  it('schließt bei zu kurzer Historie — eine Versicherung darf nicht raten', () => {
    expect(marketFilterPasses(rampe(MARKET_FILTER_SMA - 1, 100, 0.5))).toBe(false);
  });
});

describe('targetPortfolio', () => {
  const ranked = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, score: 20 - i }));

  it('nimmt die Top-N gleichgewichtet', () => {
    const t = targetPortfolio(ranked, true);
    expect(t).toHaveLength(MOMENTUM_TOP_N);
    expect(t.map((x) => x.symbol)).toEqual(ranked.slice(0, MOMENTUM_TOP_N).map((x) => x.symbol));
    const summe = t.reduce((a, b) => a + b.weight, 0);
    expect(summe).toBeCloseTo(1, 3);
    expect(new Set(t.map((x) => x.weight)).size).toBe(1); // wirklich GLEICH gewichtet
  });

  it('bleibt bei geschlossenem Marktfilter komplett flach', () => {
    expect(targetPortfolio(ranked, false)).toEqual([]);
  });

  it('kauft kein negatives Momentum — auch nicht das „am wenigsten schlechte"', () => {
    const alleNegativ = ranked.map((r) => ({ ...r, score: -Math.abs(r.score) - 1 }));
    expect(targetPortfolio(alleNegativ, true)).toEqual([]);
  });

  it('gewichtet auf die tatsächliche Zahl der Gewinner, nicht auf topN', () => {
    // Nur drei positive: je ein Drittel, nicht je ein Achtel (sonst bliebe
    // fünf Achtel des Kapitals unbeabsichtigt in Cash).
    const dreiPositiv = [
      { symbol: 'A', score: 5 },
      { symbol: 'B', score: 3 },
      { symbol: 'C', score: 1 },
      { symbol: 'D', score: -1 },
    ];
    const t = targetPortfolio(dreiPositiv, true);
    expect(t).toHaveLength(3);
    expect(t.reduce((a, b) => a + b.weight, 0)).toBeCloseTo(1, 3);
  });
});

describe('rebalanceOrders', () => {
  it('verkauft Abgänge, kauft Zugänge und lässt Bleiber in Ruhe', () => {
    // Der Bleiber ist der Kern: Jedes Nachjustieren einer bestehenden
    // Position kostet einen Roundtrip — genau die Reibung, an der die
    // Konten am 27.07. gestorben sind.
    const orders = rebalanceOrders(
      ['ALT', 'BLEIBT'],
      [
        { symbol: 'BLEIBT', weight: 0.5 },
        { symbol: 'NEU', weight: 0.5 },
      ],
      10_000,
    );
    expect(orders).toEqual([
      { symbol: 'ALT', side: 'sell', notional: null },
      { symbol: 'NEU', side: 'buy', notional: 5000 },
    ]);
  });

  it('stellt Verkäufe vor Käufe — sie bezahlen die Käufe', () => {
    const orders = rebalanceOrders(['X', 'Y'], [{ symbol: 'Z', weight: 1 }], 1000);
    expect(orders.map((o) => o.side)).toEqual(['sell', 'sell', 'buy']);
  });

  it('löst bei leerem Ziel alles auf (Marktfilter zu)', () => {
    const orders = rebalanceOrders(['A', 'B'], [], 5000);
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.side === 'sell')).toBe(true);
  });

  it('erzeugt ohne Veränderung KEINE Order', () => {
    expect(rebalanceOrders(['A'], [{ symbol: 'A', weight: 1 }], 5000)).toEqual([]);
  });
});

describe('Schatten-Konto', () => {
  const T0 = new Date('2026-07-28T20:00:00Z');
  const gratis = (): number => 0;

  it('kauft mit Cash und bucht Gebühren in den Einstand', () => {
    const book = emptyMomentumBook(10_000, T0);
    const nach = applyMomentumOrders({
      book,
      orders: [{ symbol: 'AAPL', side: 'buy', notional: 5000 }],
      preise: new Map([['AAPL', 100]]),
      feeRate: () => 0.001,
      now: T0,
    });
    // 5000 / (100 * 1,001) = 49,95 → 49 ganze Stücke
    expect(nach.holdings.AAPL!.qty).toBe(49);
    expect(nach.holdings.AAPL!.avgEntry).toBeCloseTo(100.1, 6);
    expect(nach.cash).toBeCloseTo(10_000 - 49 * 100.1, 2);
  });

  it('schreibt beim Verkauf das Ergebnis nach pnls — die Größe, die judgeCandidate braucht', () => {
    let book = emptyMomentumBook(10_000, T0);
    book = applyMomentumOrders({
      book,
      orders: [{ symbol: 'X', side: 'buy', notional: 1000 }],
      preise: new Map([['X', 100]]),
      feeRate: gratis,
      now: T0,
    });
    book = applyMomentumOrders({
      book,
      orders: [{ symbol: 'X', side: 'sell', notional: null }],
      preise: new Map([['X', 110]]),
      feeRate: gratis,
      now: T0,
    });
    expect(book.holdings.X).toBeUndefined();
    expect(book.pnls).toEqual([100]); // 10 Stück × 10 $ Gewinn
    expect(book.cash).toBeCloseTo(10_100, 2);
  });

  it('führt Verkäufe VOR Käufen aus — sie finanzieren die Käufe', () => {
    let book = emptyMomentumBook(1000, T0);
    book = applyMomentumOrders({
      book,
      orders: [{ symbol: 'ALT', side: 'buy', notional: 1000 }],
      preise: new Map([['ALT', 100]]),
      feeRate: gratis,
      now: T0,
    });
    expect(book.cash).toBeCloseTo(0, 6); // komplett investiert
    // Tausch ALT → NEU in EINEM Aufruf: ginge der Kauf zuerst, scheiterte er
    // mangels Cash und das Depot bliebe im alten Wert hängen.
    book = applyMomentumOrders({
      book,
      orders: [
        { symbol: 'ALT', side: 'sell', notional: null },
        { symbol: 'NEU', side: 'buy', notional: 1000 },
      ],
      preise: new Map([
        ['ALT', 100],
        ['NEU', 50],
      ]),
      feeRate: gratis,
      now: T0,
    });
    expect(book.holdings.ALT).toBeUndefined();
    expect(book.holdings.NEU!.qty).toBe(20);
  });

  it('führt anteilig aus, statt eine Order wegen fehlender Cents zu verwerfen', () => {
    const book = emptyMomentumBook(500, T0);
    const nach = applyMomentumOrders({
      book,
      orders: [{ symbol: 'TEUER', side: 'buy', notional: 1000 }],
      preise: new Map([['TEUER', 100]]),
      feeRate: gratis,
      now: T0,
    });
    expect(nach.holdings.TEUER!.qty).toBe(5); // 500 statt der gewünschten 1000
  });

  it('erlaubt Bruchstücke nur, wo sie zugelassen sind', () => {
    const preise = new Map([['BTC-USD', 60_000]]);
    const ganz = applyMomentumOrders({
      book: emptyMomentumBook(10_000, T0),
      orders: [{ symbol: 'BTC-USD', side: 'buy', notional: 10_000 }],
      preise,
      feeRate: gratis,
      now: T0,
    });
    expect(ganz.holdings['BTC-USD']).toBeUndefined(); // 0 ganze Stücke

    const teil = applyMomentumOrders({
      book: emptyMomentumBook(10_000, T0),
      orders: [{ symbol: 'BTC-USD', side: 'buy', notional: 10_000 }],
      preise,
      feeRate: gratis,
      fractional: () => true,
      now: T0,
    });
    expect(teil.holdings['BTC-USD']!.qty).toBeCloseTo(1 / 6, 6);
  });

  it('bewertet das Depot mit Live-Kursen, fällt aber auf den Einstand zurück', () => {
    let book = emptyMomentumBook(10_000, T0);
    book = applyMomentumOrders({
      book,
      orders: [{ symbol: 'A', side: 'buy', notional: 1000 }],
      preise: new Map([['A', 100]]),
      feeRate: gratis,
      now: T0,
    });
    expect(momentumEquity(book, new Map([['A', 120]]))).toBeCloseTo(9000 + 1200, 2);
    // Ohne Kurs: Einstand statt Loch in der Kurve.
    expect(momentumEquity(book, new Map())).toBeCloseTo(10_000, 2);
  });
});

describe('istRebalanceFaellig', () => {
  it('ist beim allerersten Lauf fällig', () => {
    expect(istRebalanceFaellig(null, new Date('2026-07-28T00:00:00Z'))).toBe(true);
  });

  it('zählt volle Tage seit dem letzten Lauf, nicht Wochentage', () => {
    // Ein fester Wochentag verschöbe bei jedem ausgefallenen Lauf die ganze
    // Kette um eine Woche.
    const letzte = '2026-07-21T20:00:00Z';
    expect(istRebalanceFaellig(letzte, new Date('2026-07-27T20:00:00Z'))).toBe(false);
    expect(istRebalanceFaellig(letzte, new Date('2026-07-28T20:00:00Z'))).toBe(true);
  });

  it('behandelt einen kaputten Zeitstempel als fällig', () => {
    expect(istRebalanceFaellig('kein-datum', new Date())).toBe(true);
  });
});

describe('feeRateForClass', () => {
  it('rechnet US-Aktien billiger und Krypto teurer als der alte Pauschalsatz', () => {
    // Genau die Verzerrung, die die Auswertung vom 27.07. unbrauchbar machte:
    // gehandelt wurde fast nur Krypto, gerechnet mit Aktien-Konditionen.
    expect(feeRateForClass('stocks_us')).toBeLessThan(feeRateForClass('crypto'));
    expect(feeRateForClass('crypto')).toBeGreaterThan(0.002);
    expect(feeRateForClass('stocks_us')).toBeLessThanOrEqual(0.0005);
  });

  it('fällt bei unbekannter Klasse auf den Pauschalsatz zurück', () => {
    expect(feeRateForClass('gibts-nicht')).toBeGreaterThan(0);
    expect(feeRateForClass(null)).toBeGreaterThan(0);
  });
});

/* ── Handelbarkeit im Zielportfolio (Befund 28.07.) ─────────────────────── */

describe('Zielportfolio kauft nur, was es zu kaufen gibt', () => {
  it('nicht handelbare Indizes gehören gefiltert, bevor das Ziel steht', () => {
    // Das Ranking läuft über den GANZEN Katalog — dort stehen ^GSPC und
    // ^N225 ganz oben, wenn die Weltbörsen laufen. Ohne Filter landete das
    // Zielportfolio voller Zahlen, die kein Broker verkauft. Der Filter sitzt
    // im Aufrufer (momentumRun), damit das Ranking als Marktbild vollständig
    // bleibt; dieser Test hält fest, dass er dort auch wirklich greift.
    const ranking = [
      { symbol: '^GSPC', score: 0.4 },
      { symbol: 'SPY', score: 0.38 },
      { symbol: '^N225', score: 0.3 },
      { symbol: 'AAPL', score: 0.25 },
      { symbol: 'EURUSD=X', score: 0.2 },
      { symbol: 'BTC-USD', score: 0.1 },
    ];
    const handelbar = ranking.filter((r) => isTradable(r.symbol));
    const ziel = targetPortfolio(handelbar, true, 8);
    expect(ziel.map((z) => z.symbol)).toEqual(['SPY', 'AAPL', 'BTC-USD']);
    // Gleichgewichtet über die verbliebenen drei, nicht über die ursprünglichen sechs
    expect(ziel[0]?.weight).toBeCloseTo(1 / 3, 3);
  });

  it('bleibt nach dem Filter nichts übrig, ist das Ziel leer statt falsch', () => {
    const nurIndizes = [
      { symbol: '^GSPC', score: 0.4 },
      { symbol: '^N225', score: 0.3 },
    ];
    expect(targetPortfolio(nurIndizes.filter((r) => isTradable(r.symbol)), true, 8)).toEqual([]);
  });
});
