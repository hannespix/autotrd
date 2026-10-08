/**
 * Red-Team M3 (08.10.): Yahoo liefert bei FX für den laufenden Tag ZWEI
 * Zeilen — Tageszeile (23:00Z, close heute null) und Live-Tick. Trägt die
 * Tageszeile einmal einen close, gäbe es zwei Kerzen eines Datums: Vortag =
 * eigener Schluss, changePct falsch, bars/{date} doppelt. Je Datum gewinnt
 * die spätere Zeile — hier durch Verhalten belegt, mit globalem fetch-Mock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMarketSnapshot } from '../src/core/marketData.js';

const antwort = (ts: number[], close: (number | null)[], volume: number[]) => ({
  chart: {
    result: [
      {
        meta: { regularMarketPrice: close[close.length - 1], exchangeTimezoneName: 'Europe/London', currency: 'USD', fiftyTwoWeekHigh: 1.2, fiftyTwoWeekLow: 1.0, regularMarketVolume: 0, shortName: 'EUR/USD ' },
        timestamp: ts,
        indicators: { quote: [{ open: close.map((c) => c), high: close.map((c) => c), low: close.map((c) => c), close, volume }] },
      },
    ],
    error: null,
  },
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchYahoo — eine Kerze je Datum', () => {
  it('zwei Zeilen desselben Datums (Tageszeile + Live-Tick, beide mit close): die spätere gewinnt, Vortag bleibt der Vortag', async () => {
    // Yahoo datiert FX-Tageszeilen auf 23:00Z des Vorabends — in London-Sommerzeit ist das 00:00 des
    // Folgetags: 06.10. 23:00Z → 07.10., 07.10. 23:00Z → 08.10. (Tageszeile, diesmal MIT close),
    // 08.10. 19:11Z → 08.10. (Live-Tick). Yahoo sortiert aufsteigend, der Live-Tick kommt zuletzt.
    const ts = [Date.UTC(2026, 9, 6, 23) / 1000, Date.UTC(2026, 9, 7, 23) / 1000, Date.UTC(2026, 9, 8, 19, 11) / 1000];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => antwort(ts, [1.08, 1.09, 1.085], [0, 0, 0]) })));
    const snap = await getMarketSnapshot('EURUSD=X', '5d');
    expect(snap.bars.map((b) => b.date)).toEqual(['2026-10-07', '2026-10-08']);
    expect(snap.bars[1]!.close).toBe(1.085); // die spätere Zeile (Live-Tick) gewinnt
    expect(snap.kennzahlen.vortag).toBe(1.08);
    expect(snap.kennzahlen.volumen).toBeNull(); // FX: 0 heißt unbekannt
    expect(snap.kennzahlen.name).toBe('EUR/USD'); // getrimmt
  });

  it('heutige Tageszeile mit close null fällt heraus wie bisher — eine Kerze je Datum', async () => {
    const ts = [Date.UTC(2026, 9, 6, 23) / 1000, Date.UTC(2026, 9, 7, 23) / 1000, Date.UTC(2026, 9, 8, 19, 11) / 1000];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => antwort(ts, [1.08, null, 1.085], [0, 0, 0]) })));
    const snap = await getMarketSnapshot('EURUSD=X', '5d');
    expect(snap.bars.map((b) => b.date)).toEqual(['2026-10-07', '2026-10-08']);
    expect(snap.bars[1]!.close).toBe(1.085);
    expect(snap.kennzahlen.vortag).toBe(1.08);
  });
});
