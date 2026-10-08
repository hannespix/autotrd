/**
 * Task 19, Teil 2: Firmenprofil und Fundamentaldaten — pure Zusammenstellung
 * aus den Finnhub-Rohformen (Rohantwort 08.10. für CCG — die Abbildung ist
 * gepinnt, die WERTE selbst nicht beglaubigt: Red-Team H2, siehe Plausibilität),
 * nächster Gewinntermin,
 * Symbol-Übersetzung, Firestore-Tauglichkeit (nie undefined).
 */
import { describe, expect, it } from 'vitest';
import { METRIC_ABWEICHUNG_MAX, PROFIL_KLASSEN, finnhubSymbol, gewinnterminZeitVon, metricAbweichend, naechsterGewinntermin, profilAus, profilHatInhalt } from '../src/profil.js';

const profile2 = { name: 'Cheche Group Inc', exchange: 'NASDAQ NMS - GLOBAL MARKET', finnhubIndustry: 'Insurance', marketCapitalization: 14.456311247484907, weburl: 'https://ir.chechegroup.com/', currency: 'USD', ipo: '2020-11-02', country: 'CN' };
const metric = { marketCapitalization: 14.456310999999998, beta: 0.25971144, peTTM: null, epsTTM: -26.1133, '52WeekHigh': 43.05, '52WeekLow': 4.65, dividendYieldIndicatedAnnual: null, '10DayAverageTradingVolume': 0.03524 };

describe('profilAus', () => {
  it('bildet die CCG-Rohantwort ab (ohne Yahoo-Anker ungeprüft) — KGV null bei Verlust, Dividende null, Gewinntermin null ohne Kalender', () => {
    const p = profilAus(profile2, metric, [], '2026-10-08', '2026-10-08T22:00:00.000Z');
    expect(p).toEqual({
      name: 'Cheche Group Inc', branche: 'Insurance', land: 'CN', boerse: 'NASDAQ NMS - GLOBAL MARKET', website: 'https://ir.chechegroup.com/', waehrung: 'USD', ipo: '2020-11-02',
      marktkapMio: 14.456310999999998, beta: 0.25971144, kgvTtm: null, epsTtm: -26.1133, w52Hoch: 43.05, w52Tief: 4.65,
      dividendenrenditePct: null, gewinntermin: null, gewinnterminZeit: null, metricVerdacht: false, quelle: 'finnhub', updatedAt: '2026-10-08T22:00:00.000Z',
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

  it('Plausibilität (Red-Team H2): weicht das 52W-Hoch vom Yahoo-Anker ab, bleiben die metric-Werte leer, Marktkap kommt aus profile2', () => {
    // CCG: Finnhub 43,05 gegen Yahoo 18,16 — Berichtswährung statt Notierung.
    const p = profilAus(profile2, metric, [], '2026-10-08', 'y', { yahooW52Hoch: 18.16 });
    expect(p).toMatchObject({ metricVerdacht: true, kgvTtm: null, epsTtm: null, w52Hoch: null, w52Tief: null, dividendenrenditePct: null, marktkapMio: 14.456311247484907, beta: 0.25971144 });
    for (const v of Object.values(p)) expect(v).not.toBeUndefined();
    // Innerhalb der Toleranz (Intraday- vs. Schlusshoch) bleibt alles stehen.
    expect(profilAus(profile2, metric, [], '2026-10-08', 'y', { yahooW52Hoch: 43.05 / (1 + METRIC_ABWEICHUNG_MAX) + 0.01 })).toMatchObject({ metricVerdacht: false, epsTtm: -26.1133 });
    expect(metricAbweichend(43.05, 18.16)).toBe(true);
    expect(metricAbweichend(43.05, null)).toBe(false); // ohne Anker kein Verdacht
    expect(metricAbweichend(null, 18.16)).toBe(false);
    expect(metricAbweichend(43.05, 0)).toBe(false);
  });

  it('Währung aus profile2, groß geschrieben; fehlt sie → null (die Anzeige setzt dann kein $)', () => {
    expect(profilAus({ currency: 'usd' }, null, [], 'x', 'y').waehrung).toBe('USD');
    expect(profilAus({ currency: '' }, null, [], 'x', 'y').waehrung).toBeNull();
    expect(profilAus(null, null, [], 'x', 'y').waehrung).toBeNull();
  });
});

describe('naechsterGewinntermin', () => {
  it('frühester Termin ≥ heute; Vergangenes und Unlesbares zählt nicht', () => {
    const termine = [{ date: '2026-09-04' }, { date: '2026-12-10' }, { date: '2026-11-05' }, { date: 'bald' }, {}];
    expect(naechsterGewinntermin(termine, '2026-10-08')).toBe('2026-11-05');
    expect(naechsterGewinntermin(termine, '2026-11-05')).toBe('2026-11-05');
    // Nach Börsenschluss (Red-Team M3): der heutige Termin ist vorbei, der nächste zählt.
    expect(naechsterGewinntermin(termine, '2026-11-05', true)).toBe('2026-12-10');
    expect(naechsterGewinntermin([{ date: '2026-11-05', hour: 'amc' }], '2026-11-05', true)).toBeNull();
    expect(naechsterGewinntermin(termine, '2026-12-11')).toBeNull();
    expect(naechsterGewinntermin([], '2026-10-08')).toBeNull();
    // Tageszeit gehört zum gewählten Termin, nicht zum ersten Eintrag.
    const mitZeit = [{ date: '2026-11-05', hour: 'AMC' }, { date: '2026-12-10', hour: 'bmo' }, { date: '2026-11-05', hour: 'x' }];
    expect(gewinnterminZeitVon(mitZeit, '2026-11-05')).toBe('amc');
    expect(gewinnterminZeitVon(mitZeit, '2026-12-10')).toBe('bmo');
    expect(gewinnterminZeitVon([{ date: '2026-12-10', hour: 'später' }], '2026-12-10')).toBeNull();
    expect(gewinnterminZeitVon(mitZeit, null)).toBeNull();
    expect(profilAus(null, null, mitZeit, '2026-10-08', 'y')).toMatchObject({ gewinntermin: '2026-11-05', gewinnterminZeit: 'amc' });
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
