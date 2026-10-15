import { describe, expect, it } from 'vitest';
import {
  SOCKEL_MIN_KALENDERWOCHEN,
  SOCKEL_MIN_WOCHEN,
  SOCKEL_REIBUNG_PCT,
  bewerteSockelAusstieg,
  blockBootstrap80,
  isoWoche,
  sockelAusstiege,
  sockelEntscheidung,
  sockelKontrafaktStand,
  type SockelAusstieg,
  type SockelTradeRoh,
} from '../src/sockelKontrafakt.js';

const AB = '2026-10-01'; // Testdaten liegen vor dem Produktions-Start (V5 eigener Test)

// 15:00 UTC = 11:00 ET — Handelszeit; 22:00 UTC = 18:00 ET — Abend-Lauf ohne Broker.
const t = (tag: string, teil: Partial<SockelTradeRoh>, uhr = '15:00'): SockelTradeRoh => ({
  symbol: 'AXTI', side: 'sell', at: `${tag}T${uhr}:00.000Z`, price: 98, quelle: 'sockel', ...teil,
});

describe('Sockel-Ausstiege an Prozent-Marken (Task 30)', () => {
  it('F2: der Lauf am SELBEN Abend ist der Messpunkt, Rückkauf zu seinem eigenen Brutto-Preis', () => {
    const { faelle } = sockelAusstiege([
      t('2026-10-07', { riskExit: 'stop_loss', price: 97.9, rawPrice: 98, entryPrice: 100 }),
      t('2026-10-07', { side: 'buy', price: 99.1, rawPrice: 99 }, '22:00'), // 18:00 ET
      t('2026-10-14', { side: 'buy', price: 104, rawPrice: 104 }), // Aufstockung eine Woche später
    ], AB);
    expect(faelle).toEqual([{
      symbol: 'AXTI', exitAt: '2026-10-07T15:00:00.000Z', exitTag: '2026-10-07', exitPreis: 98, einstand: 100,
      tagT: '2026-10-07', rueckkaufPreis: 99,
    }]);
  });

  it('V1: Brutto-Ausstieg — Broker-Fill vor Rohkurs vor Effektivpreis', () => {
    const fall = (teil: Partial<SockelTradeRoh>) => sockelAusstiege([t('2026-10-07', { riskExit: 'stop_loss', entryPrice: 100, ...teil })], AB).faelle[0]!;
    expect(fall({ price: 97.9, rawPrice: 98, brokerFillPrice: 97.5 }).exitPreis).toBe(97.5);
    expect(fall({ price: 97.9, rawPrice: 98 }).exitPreis).toBe(98);
    expect(fall({ price: 97.9 }).exitPreis).toBe(97.9);
  });

  it('V6: fill_sync wird gezählt, nicht bewertet; Rebalance-, Konfluenz- und Signal-Verkäufe zählen nicht', () => {
    const r = sockelAusstiege([
      t('2026-10-07', { riskExit: 'fill_sync', entryPrice: 100 }),
      t('2026-10-07', { riskExit: 'core_rebalance', entryPrice: 100 }),
      t('2026-10-07', { riskExit: 'stop_loss', entryPrice: 100, quelle: 'konfluenz' }),
      t('2026-10-07', { riskExit: 'signal', entryPrice: 100 }),
    ], AB);
    expect(r).toEqual({ faelle: [], unklar: 1 });
  });

  it('V5: Ausstiege vor dem Mess-Start zählen nicht (auch nicht als unklar)', () => {
    const r = sockelAusstiege([
      t('2026-10-09', { riskExit: 'stop_loss', entryPrice: 100 }),
      t('2026-10-09', { riskExit: 'fill_sync', entryPrice: 100 }),
    ]);
    expect(r).toEqual({ faelle: [], unklar: 0 });
  });

  it('R4: T = früherer von „nächster Lauf" und „Ausstieg + 7 Tage"', () => {
    const ohne = sockelAusstiege([t('2026-10-07', { riskExit: 'trailing_stop', entryPrice: 90 })], AB).faelle[0]!;
    expect(ohne).toMatchObject({ tagT: '2026-10-14', rueckkaufPreis: null });
    const spaet = sockelAusstiege([
      t('2026-10-07', { riskExit: 'trailing_stop', entryPrice: 90 }),
      t('2026-10-20', { side: 'buy', price: 99 }),
    ], AB).faelle[0]!;
    expect(spaet).toMatchObject({ tagT: '2026-10-14', rueckkaufPreis: null });
  });

  it('ein Lauf ohne Kauf dieses Symbols ist Messpunkt ohne Rückkauf', () => {
    const { faelle } = sockelAusstiege([
      t('2026-10-07', { riskExit: 'stop_loss', entryPrice: 100 }),
      t('2026-10-07', { side: 'buy', symbol: 'SNDK', price: 50 }, '22:00'),
    ], AB);
    expect(faelle[0]).toMatchObject({ tagT: '2026-10-07', rueckkaufPreis: null });
  });
});

describe('Bewertung gegen Tageskerzen', () => {
  const a: SockelAusstieg = {
    symbol: 'AXTI', exitAt: '2026-10-07T15:00:00.000Z', exitTag: '2026-10-07', exitPreis: 98, einstand: 100,
    tagT: '2026-10-13', rueckkaufPreis: null,
  };
  const k = (date: string, open: number, low: number, close: number) => ({ date, open, low, close });
  const kerzen = [
    k('2026-10-07', 101, 97, 98.5),
    k('2026-10-08', 98.5, 96, 101),
    k('2026-10-09', 101, 99, 104),
    k('2026-10-12', 104, 100, 105),
    k('2026-10-13', 105, 104, 107.8),
    k('2026-10-14', 60, 50, 60), // NACH T — darf nichts ändern
  ];

  it('Lookahead: T nicht strikt vor heute ⇒ offen', () => {
    expect(bewerteSockelAusstieg(a, kerzen, '2026-10-13')).toEqual({ stand: 'offen' });
  });

  it('ohne Rückkauf: Halten bis Schluss T (+10 %), Gebühren heben sich auf; robust zahlt Halten Reibung', () => {
    expect(bewerteSockelAusstieg(a, kerzen, '2026-10-15')).toEqual({
      stand: 'bewertet', deltaPct: 10, deltaRobustPct: 10 - SOCKEL_REIBUNG_PCT, notbremse: false,
    });
  });

  it('mit Rückkauf: gemessen am Rückkaufpreis, Halten spart zwei Gebühren (+ Reibung robust)', () => {
    const b = bewerteSockelAusstieg({ ...a, tagT: '2026-10-07', rueckkaufPreis: 99 }, kerzen, '2026-10-15');
    expect(b.stand).toBe('bewertet');
    const d = (b as { deltaPct: number; deltaRobustPct: number });
    expect(d.deltaPct).toBeGreaterThan((99 / 98 - 1) * 100);
    expect(d.deltaRobustPct).toBeCloseTo(d.deltaPct + SOCKEL_REIBUNG_PCT, 4);
  });

  it('F1: Notbremse im Pfad mit Kurslücke füllt zum Eröffnungskurs, nicht zum Bremskurs', () => {
    const crash = kerzen.map((x) => (x.date === '2026-10-09' ? k('2026-10-09', 60, 55, 58) : x));
    const b = bewerteSockelAusstieg(a, crash, '2026-10-15');
    expect(b).toMatchObject({ stand: 'bewertet', notbremse: true });
    expect((b as { deltaPct: number }).deltaPct).toBeCloseTo((60 / 98 - 1) * 100, 3);
  });

  it('F1: Gap am Ausstiegstag — der Stop füllte schon unter der Bremse ⇒ beide draußen, Delta 0', () => {
    const b = bewerteSockelAusstieg({ ...a, exitPreis: 70 }, kerzen, '2026-10-15');
    expect(b).toEqual({ stand: 'bewertet', deltaPct: 0, deltaRobustPct: 0, notbremse: true });
  });

  it('V7: erste Kerze zu weit nach dem Ausstieg ⇒ ohne_kurse (der Absturz fehlt)', () => {
    expect(bewerteSockelAusstieg(a, kerzen.filter((x) => x.date >= '2026-10-12'), '2026-10-15')).toEqual({ stand: 'ohne_kurse' });
    expect(bewerteSockelAusstieg(a, [], '2026-10-15')).toEqual({ stand: 'ohne_kurse' });
  });
});

describe('Aggregat und Entscheidungsregel', () => {
  it('ISO-Woche', () => {
    expect(isoWoche('2026-10-07')).toBe('2026-W41');
    expect(isoWoche('2026-10-12')).toBe('2026-W42');
    expect(isoWoche('2026-01-01')).toBe('2026-W01');
  });

  it('gespiegelte Konten zählen als EINE Symbol-Woche; offen/ohne Kurse/unklar getrennt', () => {
    const a = (sym: string, tag: string): SockelAusstieg => ({
      symbol: sym, exitAt: `${tag}T15:00:00.000Z`, exitTag: tag, exitPreis: 98, einstand: 100, tagT: '2026-10-13', rueckkaufPreis: null,
    });
    const b = (d: number) => ({ stand: 'bewertet' as const, deltaPct: d, deltaRobustPct: d - 0.5, notbremse: false });
    const s = sockelKontrafaktStand([
      { a: a('AXTI', '2026-10-07'), b: b(4) },
      { a: a('AXTI', '2026-10-08'), b: b(2) }, // gleiche Woche ⇒ Mittel 3
      { a: a('SNDK', '2026-10-07'), b: b(-1) },
      { a: a('SNDK', '2026-10-13'), b: { stand: 'offen' } },
      { a: a('ERAS', '2026-10-13'), b: { stand: 'ohne_kurse' } },
    ], 2, AB);
    expect(s).toMatchObject({ ab: AB, n: 2, kalenderwochen: 1, nTrades: 3, offen: 1, ohneKurse: 1, unklar: 2, mittelPct: 1, mittelRobustPct: 0.5, entscheidung: 'zu_wenig' });
  });

  it('Regel: Mindestmengen, Survivorship-Sperre, und beide Rechnungen müssen übereinstimmen', () => {
    const N = SOCKEL_MIN_WOCHEN;
    const W = SOCKEL_MIN_KALENDERWOCHEN;
    expect(sockelEntscheidung(N - 1, W, 0, [1, 2], [1, 2])).toBe('zu_wenig');
    expect(sockelEntscheidung(N, W - 1, 0, [1, 2], [1, 2])).toBe('zu_wenig');
    expect(sockelEntscheidung(N, W, 0.11, [1, 2], [1, 2])).toBe('zu_wenig');
    expect(sockelEntscheidung(N, W, 0, [0.1, 2], [0.2, 2])).toBe('ohne_marken');
    expect(sockelEntscheidung(N, W, 0, [-2, -0.1], [-2, -0.3])).toBe('marken_behalten');
    expect(sockelEntscheidung(N, W, 0, [-1, 1], [-1, 1])).toBe('unentschieden');
    // ohne Reibung „ohne Marken", mit Reibung nicht mehr ⇒ unentschieden
    expect(sockelEntscheidung(N, W, 0, [0.1, 2], [-0.4, 1.5])).toBe('unentschieden');
  });

  it('V3: Block-Bootstrap zieht ganze Wochen — deterministisch, um den Mittelwert', () => {
    const bloecke = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
    const k1 = blockBootstrap80(bloecke)!;
    expect(blockBootstrap80(bloecke)).toEqual(k1);
    expect(k1[0]).toBeLessThan(5.5);
    expect(k1[1]).toBeGreaterThan(5.5);
    expect(blockBootstrap80([[3, 4]])).toBeNull();
  });

  it('V3: jede gezogene Woche geht mit ALLEN ihren Symbol-Wochen ein, nicht nur mit einer', () => {
    // Jede Woche hat Mittel 5 — wer nur den ersten Wert zieht, landet bei 0.
    expect(blockBootstrap80([[0, 10], [0, 10], [0, 10], [0, 10]])).toEqual([5, 5]);
  });

  it('V3: ein gemeinsamer Wochenschock macht das Intervall breiter als unabhängige Fälle', () => {
    // 4 Wochen × 5 Symbole; jede Woche ein eigener Schock — die Werte innerhalb sind fast gleich.
    const bloecke = [[-3, -3.1, -2.9, -3, -3], [2, 2.1, 1.9, 2, 2], [-1, -1, -1.1, -0.9, -1], [3, 3, 3.1, 2.9, 3]];
    const block = blockBootstrap80(bloecke)!;
    const flach = blockBootstrap80(bloecke.flat().map((v) => [v]))!;
    expect(block[1] - block[0]).toBeGreaterThan(flach[1] - flach[0]);
  });
});
