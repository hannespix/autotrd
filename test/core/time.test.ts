import { describe, expect, it } from 'vitest';
import {
  addDays,
  barsPerYear,
  bucketEnd,
  bucketStart,
  etOffsetMin,
  isTradingDay,
  msFromET,
  nextTradingDay,
  nyseHolidays,
  prevTradingDay,
  sessionBounds,
  toET,
} from '../../src/core/time.ts';

describe('ET-Offset und DST', () => {
  it('kennt EST und EDT', () => {
    expect(etOffsetMin(Date.UTC(2026, 0, 15, 12))).toBe(-300);
    expect(etOffsetMin(Date.UTC(2026, 6, 15, 12))).toBe(-240);
  });

  it('wechselt exakt an den DST-Grenzen 2026 (08.03. 07:00 UTC, 01.11. 06:00 UTC)', () => {
    expect(etOffsetMin(Date.UTC(2026, 2, 8, 6, 59))).toBe(-300);
    expect(etOffsetMin(Date.UTC(2026, 2, 8, 7, 0))).toBe(-240);
    expect(etOffsetMin(Date.UTC(2026, 10, 1, 5, 59))).toBe(-240);
    expect(etOffsetMin(Date.UTC(2026, 10, 1, 6, 0))).toBe(-300);
  });

  it('toET/msFromET sind invers (auch um DST-Wechsel, außerhalb der doppelten Stunde)', () => {
    // 01:00–01:59 ET am 01.11. kommt zweimal vor (EDT und EST) — dort ist die Umkehrung
    // prinzipiell mehrdeutig; msFromET liefert das erste Vorkommen. Alle anderen Zeiten sind eindeutig.
    const samples = [
      Date.UTC(2026, 2, 8, 6, 30),
      Date.UTC(2026, 2, 8, 7, 30),
      Date.UTC(2026, 10, 1, 4, 30),
      Date.UTC(2026, 10, 1, 7, 30),
      Date.UTC(2025, 5, 1, 13, 30),
      Date.UTC(2026, 11, 31, 23, 59),
    ];
    for (const ms of samples) {
      const p = toET(ms);
      expect(msFromET(p.y, p.m, p.d, p.hh, p.mm, p.ss)).toBe(ms);
    }
  });

  it('liefert Tag, Wochentag und Minute des Tages', () => {
    const p = toET(Date.UTC(2026, 8, 4, 13, 30)); // Fr 04.09.2026 09:30 EDT
    expect(p.day).toBe('2026-09-04');
    expect(p.weekday).toBe(5);
    expect(p.minuteOfDay).toBe(570);
  });
});

describe('NYSE-Kalender (Fallback)', () => {
  it('kennt alle Feiertage 2026', () => {
    const h = nyseHolidays(2026);
    for (const d of [
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-03',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03',
      '2026-09-07',
      '2026-11-26',
      '2026-12-25',
    ]) {
      expect(h.has(d), d).toBe(true);
    }
    expect(h.size).toBe(10);
  });

  it('beachtet Nachhol-Regeln (2027) und die Neujahrs-Ausnahme (2022)', () => {
    const h27 = nyseHolidays(2027);
    expect(h27.has('2027-07-05')).toBe(true); // 4.7. ist Sonntag
    expect(h27.has('2027-12-24')).toBe(true); // 25.12. ist Samstag
    expect(h27.has('2027-06-18')).toBe(true); // Juneteenth am Samstag
    const h22 = nyseHolidays(2022);
    expect(h22.has('2022-01-01')).toBe(false); // Samstag: kein Nachholtag am 31.12.
    expect(h22.has('2021-12-31')).toBe(false);
    expect(h22.has('2022-06-20')).toBe(true);
    expect(h22.has('2022-12-26')).toBe(true);
  });

  it('Handelstage: Wochenende, Feiertag, Werktag; Krypto immer', () => {
    expect(isTradingDay('2026-09-05', 'us_equity')).toBe(false); // Samstag
    expect(isTradingDay('2026-09-07', 'us_equity')).toBe(false); // Labor Day
    expect(isTradingDay('2026-09-04', 'us_equity')).toBe(true);
    expect(isTradingDay('2026-09-05', 'crypto')).toBe(true);
  });

  it('Broker-Kalender übersteuert den Fallback', () => {
    const cal = new Map([['2026-09-07', { date: '2026-09-07', open: '09:30', close: '16:00' }]]);
    expect(isTradingDay('2026-09-07', 'us_equity', cal)).toBe(true);
    expect(isTradingDay('2026-09-04', 'us_equity', cal)).toBe(false);
  });
});

describe('Sitzungsgrenzen', () => {
  it('regulärer Tag 09:30–16:00 ET', () => {
    const b = sessionBounds('2026-09-04', 'us_equity')!;
    expect(b.open).toBe(Date.UTC(2026, 8, 4, 13, 30));
    expect(b.close).toBe(Date.UTC(2026, 8, 4, 20, 0));
    expect(b.minutes).toBe(390);
  });

  it('Frühschluss am Tag nach Thanksgiving und 24.12.', () => {
    expect(toET(sessionBounds('2026-11-27', 'us_equity')!.close).minuteOfDay).toBe(13 * 60);
    expect(toET(sessionBounds('2026-12-24', 'us_equity')!.close).minuteOfDay).toBe(13 * 60);
  });

  it('kein Handelstag ⇒ null; Krypto = UTC-Tag', () => {
    expect(sessionBounds('2026-07-03', 'us_equity')).toBeNull();
    expect(sessionBounds('2026-09-06', 'us_equity')).toBeNull();
    const c = sessionBounds('2026-09-06', 'crypto')!;
    expect(c.open).toBe(Date.UTC(2026, 8, 6));
    expect(c.close).toBe(Date.UTC(2026, 8, 7));
  });

  it('Kalender-Zeiten werden übernommen', () => {
    const cal = new Map([['2026-09-04', { date: '2026-09-04', open: '09:30', close: '13:00' }]]);
    const b = sessionBounds('2026-09-04', 'us_equity', cal)!;
    expect(b.close).toBe(Date.UTC(2026, 8, 4, 17, 0));
  });
});

describe('Buckets', () => {
  const b = sessionBounds('2026-09-04', 'us_equity')!;
  const et = (hh: number, mm: number) => msFromET(2026, 9, 4, hh, mm);

  it('richtet Intraday-Buckets an der Eröffnung aus', () => {
    expect(bucketStart(et(9, 32), 5, b)).toBe(b.open);
    expect(bucketStart(et(9, 35), 5, b)).toBe(b.open + 5 * 60_000);
    expect(bucketStart(et(15, 45), 60, b)).toBe(et(15, 30));
    expect(bucketStart(et(9, 29), 5, b)).toBeNull();
    expect(bucketStart(et(16, 0), 5, b)).toBeNull();
    expect(bucketStart(et(12, 0), 1440, b)).toBe(b.open);
  });

  it('der letzte Bucket endet am Schluss', () => {
    expect(bucketEnd(et(15, 30), 60, b)).toBe(b.close);
    expect(bucketEnd(et(15, 55), 5, b)).toBe(b.close);
    expect(bucketEnd(et(9, 30), 5, b)).toBe(et(9, 35));
  });

  it('Bars je Jahr', () => {
    expect(barsPerYear(1440, 'us_equity')).toBe(252);
    expect(barsPerYear(5, 'us_equity')).toBe(252 * 78);
    expect(barsPerYear(60, 'crypto')).toBe(365 * 24);
  });
});

describe('Tagesarithmetik', () => {
  it('addDays über Monats- und Jahresgrenzen', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('nächster/vorheriger Handelstag überspringt Wochenende und Feiertag', () => {
    expect(nextTradingDay('2026-09-04', 'us_equity')).toBe('2026-09-08'); // Sa, So, Labor Day
    expect(prevTradingDay('2026-09-08', 'us_equity')).toBe('2026-09-04');
    expect(nextTradingDay('2026-09-04', 'crypto')).toBe('2026-09-05');
  });
});
