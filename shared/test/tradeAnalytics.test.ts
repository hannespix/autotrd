/**
 * Auswertungen der Handelshistorie.
 *
 * Der Grund für diese Tests ist derselbe wie überall in diesem Repo: Eine
 * falsche Kennzahl sieht aus wie eine richtige. Ein Histogramm mit
 * verschobenen Fächern, eine Stunden-Auswertung in der falschen Zeitzone
 * oder eine Serie, die bei einer Null abbricht — nichts davon wirft einen
 * Fehler, alles davon führt zu einer falschen Entscheidung über echtes Geld.
 */

import { describe, expect, it } from 'vitest';
import {
  byHour,
  byWeekday,
  bySymbol,
  chronological,
  closedOnly,
  equityCurve,
  historySummary,
  hourInZone,
  pnlHistogram,
  streaks,
  weekdayInZone,
  type HistoryTrade,
} from '../src/tradeAnalytics.js';

const t = (
  executedAt: string,
  pnl: number | null,
  symbol = 'AAPL',
): HistoryTrade => ({
  symbol,
  side: pnl === null ? 'buy' : 'sell',
  qty: 1,
  price: 100,
  executedAt,
  ...(pnl === null ? {} : { pnl }),
});

describe('closedOnly / chronological', () => {
  it('trennt Eröffnungen von realisierten Ergebnissen', () => {
    // Ein Kauf hat kein Ergebnis — ihn mitzuzählen würde jede Trefferquote
    // halbieren, weil jeder Roundtrip aus zwei Zeilen besteht.
    const alle = [t('2026-07-01T14:00:00Z', null), t('2026-07-01T15:00:00Z', 5)];
    expect(closedOnly(alle).length).toBe(1);
  });

  it('sortiert aufsteigend — die Abfrage liefert absteigend', () => {
    const roh = [t('2026-07-03T14:00:00Z', 1), t('2026-07-01T14:00:00Z', 2)];
    expect(chronological(roh).map((x) => x.executedAt)).toEqual([
      '2026-07-01T14:00:00Z',
      '2026-07-03T14:00:00Z',
    ]);
  });

  it('behandelt pnl = 0 als realisiert, nicht als fehlend', () => {
    // Ein Nullergebnis IST ein geschlossener Trade (Gewinn = Gebühren).
    // Als „offen" zu zählen würde die Historie stillschweigend verkürzen.
    expect(closedOnly([t('2026-07-01T14:00:00Z', 0)]).length).toBe(1);
  });
});

describe('equityCurve', () => {
  it('summiert in ZEITLICHER Reihenfolge, nicht in Eingabereihenfolge', () => {
    // Kommen die Trades absteigend herein (wie aus Firestore), ergäbe eine
    // naive Summe denselben Endwert — aber einen gespiegelten VERLAUF.
    // Genau der Verlauf ist das, was man im Chart ablesen will.
    const roh = [t('2026-07-03T14:00:00Z', -30), t('2026-07-01T14:00:00Z', 100)];
    expect(equityCurve(roh, 1000).map((s) => s.value)).toEqual([1100, 1070]);
  });

  it('startet beim übergebenen Kontostand', () => {
    expect(equityCurve([t('2026-07-01T14:00:00Z', 50)], 25_000)[0]!.value).toBe(25_050);
  });

  it('ignoriert offene Trades', () => {
    const gemischt = [t('2026-07-01T14:00:00Z', null), t('2026-07-02T14:00:00Z', 10)];
    expect(equityCurve(gemischt).length).toBe(1);
  });
});

describe('pnlHistogram', () => {
  it('legt ein Fach exakt auf die Null — Gewinn und Verlust nie im selben', () => {
    // Der eigentliche Zweck des Diagramms ist die Frage „wie verteilen sich
    // Gewinne gegen Verluste". Ein Fach von −5 bis +5 beantwortet sie nicht.
    const bins = pnlHistogram([t('a', -100), t('b', 100)].map((x, i) =>
      t(`2026-07-0${i + 1}T14:00:00Z`, x.pnl!),
    ), 5);
    const mitte = bins[Math.floor(bins.length / 2)]!;
    expect(mitte.from).toBeLessThan(0);
    expect(mitte.to).toBeGreaterThan(0);
    expect(Math.abs(mitte.from)).toBeCloseTo(mitte.to, 6);
  });

  it('erzwingt eine ungerade Fachzahl', () => {
    const t1 = t('2026-07-01T14:00:00Z', -10);
    const t2 = t('2026-07-02T14:00:00Z', 10);
    expect(pnlHistogram([t1, t2], 4).length).toBe(5);
  });

  it('steckt den exakten Höchstwert ins letzte Fach statt daneben', () => {
    // Der klassische Off-by-one: floor((max+spanne)/breite) === n.
    const trades = [t('2026-07-01T14:00:00Z', -50), t('2026-07-02T14:00:00Z', 50)];
    const bins = pnlHistogram(trades, 5);
    expect(bins.reduce((a, b) => a + b.n, 0), 'kein Trade darf verschwinden').toBe(2);
    expect(bins[bins.length - 1]!.n).toBe(1);
    expect(bins[0]!.n).toBe(1);
  });

  it('leere Historie ⇒ leere Liste, kein Absturz', () => {
    expect(pnlHistogram([])).toEqual([]);
  });

  it('lauter Nullergebnisse ⇒ ein einziges Fach statt Division durch 0', () => {
    const bins = pnlHistogram([t('2026-07-01T14:00:00Z', 0), t('2026-07-02T14:00:00Z', 0)]);
    expect(bins).toEqual([{ from: 0, to: 0, n: 2 }]);
  });
});

describe('Zeitzone', () => {
  it('rechnet die US-Eröffnung im SOMMER auf 9 Uhr ET', () => {
    // 13:30 UTC im Juli = 09:30 EDT.
    expect(hourInZone('2026-07-28T13:30:00Z')).toBe(9);
  });

  it('… und im WINTER ebenfalls auf 9 Uhr ET', () => {
    // 14:30 UTC im Januar = 09:30 EST. Über UTC gerechnet lägen die beiden
    // Eröffnungen in verschiedenen Fächern — der auffälligste Effekt des
    // Handelstags wäre über zwei Balken verschmiert.
    expect(hourInZone('2026-01-28T14:30:00Z')).toBe(9);
  });

  it('Wochentag zählt ab Montag = 0', () => {
    // 2026-07-28 ist ein Dienstag.
    expect(weekdayInZone('2026-07-28T14:00:00Z')).toBe(1);
  });

  it('ein später UTC-Abend kann in ET noch derselbe Tag sein', () => {
    // 2026-07-29T02:00Z ist Mittwoch in UTC, aber Dienstag 22:00 in ET.
    expect(weekdayInZone('2026-07-29T02:00:00Z')).toBe(1);
  });
});

describe('byWeekday / byHour', () => {
  it('behält leere Fächer — eine Lücke ist die Information', () => {
    expect(byWeekday([]).length).toBe(7);
    expect(byHour([]).length).toBe(24);
  });

  it('summiert Ergebnis und Treffer je Fach', () => {
    const trades = [
      t('2026-07-28T14:00:00Z', 10), // Di, 10 Uhr ET
      t('2026-07-28T15:00:00Z', -4), // Di, 11 Uhr ET
      t('2026-07-29T14:00:00Z', 6), // Mi, 10 Uhr ET
    ];
    const wd = byWeekday(trades);
    expect(wd[1]).toMatchObject({ key: 'Di', n: 2, pnl: 6, wins: 1, winRatePct: 50 });
    expect(wd[2]).toMatchObject({ key: 'Mi', n: 1, pnl: 6 });
    expect(byHour(trades)[10]).toMatchObject({ n: 2, pnl: 16, wins: 2 });
  });
});

describe('bySymbol', () => {
  it('sortiert nach BETRAG — der größte Verlust ist so wichtig wie der Gewinn', () => {
    const trades = [
      t('2026-07-01T14:00:00Z', 5, 'AAPL'),
      t('2026-07-02T14:00:00Z', -80, 'TSLA'),
      t('2026-07-03T14:00:00Z', 20, 'BTC-USD'),
    ];
    expect(bySymbol(trades).map((b) => b.key)).toEqual(['TSLA', 'BTC-USD', 'AAPL']);
  });

  it('fasst mehrere Trades desselben Symbols zusammen', () => {
    const trades = [
      t('2026-07-01T14:00:00Z', 10, 'AAPL'),
      t('2026-07-02T14:00:00Z', -4, 'AAPL'),
    ];
    expect(bySymbol(trades)[0]).toMatchObject({ key: 'AAPL', n: 2, pnl: 6, wins: 1 });
  });
});

describe('streaks', () => {
  it('findet die längste Verlustserie — die praktisch wichtigste Zahl', () => {
    const pnls = [5, -1, -2, -3, -4, 7, -1];
    const trades = pnls.map((p, i) => t(`2026-07-${String(i + 1).padStart(2, '0')}T14:00:00Z`, p));
    expect(streaks(trades)).toEqual({ longestWin: 1, longestLoss: 4, current: -1 });
  });

  it('eine Null bricht die Serie NICHT', () => {
    // Ein Nullergebnis ist weder Gewinn noch Verlust. Es als Bruch zu werten
    // würde eine echte Sechser-Verlustserie als zwei harmlose Dreier melden.
    const pnls = [-1, -2, 0, -3];
    const trades = pnls.map((p, i) => t(`2026-07-0${i + 1}T14:00:00Z`, p));
    expect(streaks(trades).longestLoss).toBe(3);
  });

  it('leere Historie ⇒ alles 0', () => {
    expect(streaks([])).toEqual({ longestWin: 0, longestLoss: 0, current: 0 });
  });
});

describe('historySummary', () => {
  it('trennt offene von geschlossenen Zeilen und findet die Extreme', () => {
    const trades = [
      t('2026-07-01T14:00:00Z', null),
      t('2026-07-02T14:00:00Z', 40),
      t('2026-07-03T14:00:00Z', -15),
    ];
    expect(historySummary(trades)).toEqual({
      total: 3,
      closed: 2,
      open: 1,
      pnl: 25,
      bestTrade: 40,
      worstTrade: -15,
      from: '2026-07-01T14:00:00Z',
      to: '2026-07-03T14:00:00Z',
    });
  });

  it('leere Historie ⇒ null statt NaN oder -Infinity', () => {
    // Math.max() ohne Argumente liefert -Infinity — im Dashboard stünde
    // dann „-∞ €" als bester Trade.
    expect(historySummary([])).toMatchObject({ bestTrade: null, worstTrade: null, pnl: 0 });
  });
});
