/**
 * Task 19, Teil 2: Firmenprofil und Fundamentaldaten — pure Zusammenstellung
 * aus den Finnhub-Rohformen (gemessen 08.10. für CCG), nächster Gewinntermin,
 * Symbol-Übersetzung, Firestore-Tauglichkeit (nie undefined).
 */
import { describe, expect, it } from 'vitest';
import { PROFIL_KLASSEN, finnhubSymbol, naechsterGewinntermin, profilAus, profilHatInhalt } from '../src/profil.js';

const profile2 = { name: 'Cheche Group Inc', exchange: 'NASDAQ NMS - GLOBAL MARKET', finnhubIndustry: 'Insurance', marketCapitalization: 14.456311247484907, weburl: 'https://ir.chechegroup.com/', ipo: '2020-11-02', country: 'CN' };
const metric = { marketCapitalization: 14.456310999999998, beta: 0.25971144, peTTM: null, epsTTM: -26.1133, '52WeekHigh': 43.05, '52WeekLow': 4.65, dividendYieldIndicatedAnnual: null, '10DayAverageTradingVolume': 0.03524 };

describe('profilAus', () => {
  it('setzt die gemessene CCG-Antwort zusammen — KGV null bei Verlust, Dividende null, Gewinntermin null ohne Kalender', () => {
    const p = profilAus(profile2, metric, [], '2026-10-08', '2026-10-08T22:00:00.000Z');
    expect(p).toEqual({
      name: 'Cheche Group Inc', branche: 'Insurance', land: 'CN', boerse: 'NASDAQ NMS - GLOBAL MARKET', website: 'https://ir.chechegroup.com/', ipo: '2020-11-02',
      marktkapMio: 14.456310999999998, beta: 0.25971144, kgvTtm: null, epsTtm: -26.1133, w52Hoch: 43.05, w52Tief: 4.65,
      dividendenrenditePct: null, gewinntermin: null, quelle: 'finnhub', updatedAt: '2026-10-08T22:00:00.000Z',
    });
    for (const v of Object.values(p)) expect(v).not.toBeUndefined();
    expect(profilHatInhalt(p)).toBe(true);
  });

  it('Marktkap.: metric gewinnt, profile2 ist der Rückfall; leere oder kaputte Rohdaten → null, Website nur mit http(s)', () => {
    expect(profilAus(profile2, null, [], 'x', 'y').marktkapMio).toBe(14.456311247484907);
    const p = profilAus({ name: '  ', weburl: 'chechegroup.com', ipo: '2020/11/02', marketCapitalization: -1 }, { beta: 'nan', peTTM: 0 }, [], 'x', 'y');
    expect(p).toMatchObject({ name: null, website: null, ipo: null, marktkapMio: null, beta: null, kgvTtm: null });
    expect(profilHatInhalt(p)).toBe(false);
    expect(profilHatInhalt(profilAus(null, null, [], 'x', 'y'))).toBe(false);
  });
});

describe('naechsterGewinntermin', () => {
  it('frühester Termin ≥ heute; Vergangenes und Unlesbares zählt nicht', () => {
    const termine = [{ date: '2026-09-04' }, { date: '2026-12-10' }, { date: '2026-11-05' }, { date: 'bald' }, {}];
    expect(naechsterGewinntermin(termine, '2026-10-08')).toBe('2026-11-05');
    expect(naechsterGewinntermin(termine, '2026-11-05')).toBe('2026-11-05');
    expect(naechsterGewinntermin(termine, '2026-12-11')).toBeNull();
    expect(naechsterGewinntermin([], '2026-10-08')).toBeNull();
  });
});

describe('finnhubSymbol und Klassen', () => {
  it('Klassen-Suffix mit Punkt statt Bindestrich; sonst unverändert', () => {
    expect(finnhubSymbol('BRK-B')).toBe('BRK.B');
    expect(finnhubSymbol('aapl')).toBe('AAPL');
    expect(finnhubSymbol('BTC-USD')).toBe('BTC-USD'); // kein Ein-Buchstaben-Suffix — und ohnehin keine Profil-Klasse
  });
  it('nur US-Aktien beim Gratis-Tarif', () => {
    expect(PROFIL_KLASSEN).toEqual(['stocks_us']);
  });
});
