import { describe, expect, it } from 'vitest';
import {
  SOCKEL_MIN_WOCHEN,
  bewerteSockelAusstieg,
  bootstrap80,
  isoWoche,
  sockelAusstiege,
  sockelEntscheidung,
  sockelKontrafaktStand,
  type SockelAusstieg,
  type SockelTradeRoh,
} from '../src/sockelKontrafakt.js';

// 15:00 UTC = 11:00 ET — mitten im Handelstag, eindeutig im ET-Tag.
const t = (tag: string, teil: Partial<SockelTradeRoh>): SockelTradeRoh => ({
  symbol: 'AXTI', side: 'sell', at: `${tag}T15:00:00.000Z`, price: 98, quelle: 'sockel', ...teil,
});

describe('Sockel-Ausstiege an Prozent-Marken (Task 30)', () => {
  it('Stop-Ausstieg mit Messpunkt am nächsten Sockel-Lauf und Rückkauf', () => {
    const a = sockelAusstiege([
      t('2026-10-06', { side: 'buy', price: 100 }),
      t('2026-10-07', { riskExit: 'stop_loss', price: 98, entryPrice: 100 }),
      t('2026-10-13', { side: 'buy', price: 103 }), // Rebalance kauft zurück
    ]);
    expect(a).toEqual([{ symbol: 'AXTI', exitTag: '2026-10-07', exitPreis: 98, einstand: 100, tagT: '2026-10-13', rueckkauf: true }]);
  });

  it('nur Prozent-Marken und nur Sockel: Rebalance-Verkauf, Konfluenz-Stop und Käufe zählen nicht', () => {
    const a = sockelAusstiege([
      t('2026-10-07', { riskExit: 'core_rebalance', entryPrice: 100 }),
      t('2026-10-07', { riskExit: 'stop_loss', entryPrice: 100, quelle: 'konfluenz' }),
      t('2026-10-07', { riskExit: 'signal', entryPrice: 100 }),
      t('2026-10-08', { side: 'buy', entryPrice: 100 }),
    ]);
    expect(a).toEqual([]);
  });

  it('ohne Folge-Lauf: Messpunkt = Ausstieg + 7 Tage, kein Rückkauf', () => {
    const [a] = sockelAusstiege([t('2026-10-07', { riskExit: 'trailing_stop', entryPrice: 90 })]);
    expect(a).toMatchObject({ tagT: '2026-10-14', rueckkauf: false });
  });

  it('ein Lauf am SELBEN Tag ist kein Messpunkt (der Stop kann davor gelegen haben)', () => {
    const [a] = sockelAusstiege([
      t('2026-10-07', { riskExit: 'stop_loss', entryPrice: 100 }),
      { ...t('2026-10-07', { side: 'buy' }), at: '2026-10-07T19:00:00.000Z' },
    ]);
    expect(a!.tagT).toBe('2026-10-14');
  });
});

describe('Bewertung gegen Tageskerzen — Lookahead-Gate', () => {
  const a: SockelAusstieg = { symbol: 'AXTI', exitTag: '2026-10-07', exitPreis: 98, einstand: 100, tagT: '2026-10-13', rueckkauf: false };
  const kerzen = [
    { date: '2026-10-07', low: 97, close: 98.5 },
    { date: '2026-10-08', low: 96, close: 101 },
    { date: '2026-10-09', low: 99, close: 104 },
    { date: '2026-10-12', low: 100, close: 105 },
    { date: '2026-10-13', low: 104, close: 107.8 },
    { date: '2026-10-14', low: 50, close: 60 }, // NACH T — darf nichts ändern
  ];

  it('T nicht strikt vor heute ⇒ offen (auch wenn die Kerze schon da ist)', () => {
    expect(bewerteSockelAusstieg(a, kerzen, '2026-10-13')).toEqual({ stand: 'offen' });
  });

  it('Halten bis T: +10 % gegen den Ausstieg, die Kerze nach T zählt nicht', () => {
    const b = bewerteSockelAusstieg(a, kerzen, '2026-10-15');
    expect(b).toEqual({ stand: 'bewertet', haltenPct: 10, deltaPct: 10, notbremse: false });
  });

  it('Notbremse im Pfad (Tief ≤ 75 % des Einstands) ⇒ Halten endet bei der Bremse', () => {
    const crash = kerzen.map((k) => (k.date === '2026-10-09' ? { ...k, low: 70 } : k));
    const b = bewerteSockelAusstieg(a, crash, '2026-10-15');
    expect(b).toMatchObject({ stand: 'bewertet', notbremse: true });
    expect((b as { haltenPct: number }).haltenPct).toBeCloseTo((75 / 98 - 1) * 100, 3);
  });

  it('Rückkauf am Messtag: Halten spart einen Roundtrip', () => {
    const b = bewerteSockelAusstieg({ ...a, rueckkauf: true }, kerzen, '2026-10-15');
    expect(b.stand).toBe('bewertet');
    expect((b as { deltaPct: number }).deltaPct).toBeGreaterThan(10);
  });

  it('keine Kerze nach dem Ausstiegstag ⇒ ohne_kurse, nie eine Zahl aus dem Nichts', () => {
    expect(bewerteSockelAusstieg(a, kerzen.slice(0, 1), '2026-10-15')).toEqual({ stand: 'ohne_kurse' });
  });
});

describe('Aggregat und Entscheidungsregel', () => {
  it('ISO-Woche', () => {
    expect(isoWoche('2026-10-07')).toBe('2026-W41');
    expect(isoWoche('2026-10-12')).toBe('2026-W42');
    expect(isoWoche('2026-01-01')).toBe('2026-W01');
  });

  it('gespiegelte Konten zählen als EINE Symbol-Woche', () => {
    const a = (sym: string, tag: string): SockelAusstieg => ({ symbol: sym, exitTag: tag, exitPreis: 98, einstand: 100, tagT: '2026-10-13', rueckkauf: false });
    const b = (d: number) => ({ stand: 'bewertet' as const, haltenPct: d, deltaPct: d, notbremse: false });
    const s = sockelKontrafaktStand([
      { a: a('AXTI', '2026-10-07'), b: b(4) },
      { a: a('AXTI', '2026-10-08'), b: b(2) }, // gleiche Woche ⇒ Mittel 3
      { a: a('SNDK', '2026-10-07'), b: b(-1) },
      { a: a('SNDK', '2026-10-13'), b: { stand: 'offen' } },
    ]);
    expect(s).toMatchObject({ n: 2, nTrades: 3, offen: 1, ohneKurse: 0, mittelPct: 1, entscheidung: 'zu_wenig' });
  });

  it('Regel: unter 20 Wochen keine Aussage; Intervall über/unter/um 0', () => {
    expect(sockelEntscheidung(SOCKEL_MIN_WOCHEN - 1, [1, 2])).toBe('zu_wenig');
    expect(sockelEntscheidung(SOCKEL_MIN_WOCHEN, [0.1, 2])).toBe('ohne_marken');
    expect(sockelEntscheidung(SOCKEL_MIN_WOCHEN, [-2, -0.1])).toBe('marken_behalten');
    expect(sockelEntscheidung(SOCKEL_MIN_WOCHEN, [-1, 1])).toBe('unentschieden');
  });

  it('Bootstrap ist deterministisch und liegt um den Mittelwert', () => {
    const w = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const k1 = bootstrap80(w)!;
    expect(bootstrap80(w)).toEqual(k1);
    expect(k1[0]).toBeLessThan(5.5);
    expect(k1[1]).toBeGreaterThan(5.5);
    expect(bootstrap80([3])).toBeNull();
  });
});
