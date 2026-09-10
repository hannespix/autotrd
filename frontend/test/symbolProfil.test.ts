/**
 * Symbolprofil im Frontend — das Lesen von `meta/symbolProfile` und die
 * Anzeige-Entscheidungen je Zeile (Red-Team 10.09.2026: M1, M2, M5, G1, G2).
 *
 * Der Fehler, den diese Tests verhindern: Das Profil zeigt eine Zahl, die
 * für diesen Nutzer nicht gilt, ohne es zu sagen — den Rang des
 * Plattform-Korbs, ein Profil zu einem alten Champion, „0.0M" ohne Daten,
 * eine ausgegraute Basis, die für den Nutzer sehr wohl handelt.
 */
import { describe, expect, it } from 'vitest';
import { leseSymbolProfil, profilAnzeige, profilVeraltet, type SymbolProfilEintragDoc } from '../src/data.js';

const roh = (symbol: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  symbol,
  klasse: { klasse: 'Gold', cluster: 'basis_etf', sektor: null, benchmark: false },
  stand: { t: 1_725_000_000_000, close: 200, bars: 300 },
  volatilitaet: { pct: 14.2, fensterBars: 63, quelle: 'x' },
  trend: { richtung: 'auf', seitBars: 37, sma: 190, regimeLen: 150, quelle: 'x' },
  momentum: { pct: 8.5, lookback: 126, skip: 21, quelle: 'x' },
  rang: { rank: 2, of: 9, pct: 0.125, korb: 'basis', symbole: ['GLD', 'SPY', 'IWM', 'EFA', 'XLRE', 'IEF', 'LQD', 'TLT', 'EEM'] },
  stop: { pct: 20, quelle: 'x' },
  liquiditaet: { dollarVolumenTag: 1.5e9, tage: 60, fensterTage: 60, letzterKurs: 200, alterTage: 0, handelbar: true, grund: null },
  taktik: { quelle: 'basis', strategie: 'regime_allocation', params: {}, sizing: { mode: 'allocation', positionPct: 20 }, einstiege: 'erlaubt', grund: 'Basis-Allokation', imEngineUniversum: true },
  haltedauer: { medianHandelstage: null, quelle: 'unbekannt' },
  bewertung: { configCommit: 'abc', measuredAt: 1_700_000_000_000, quelle: 'x' },
  ...over,
});

const doc = (profile: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  generatedAt: 1_726_000_000_000,
  now: 1_725_900_000_000,
  asOf: null,
  timeframe: 1440,
  benchmark: 'SPY',
  lauf: { nummer: 41, id: '123', configCommit: 'deadbeef' },
  params: { lookback: 126, skip: 21, regimeLen: 150, quelle: 'x' },
  championUpdatedAt: 1_725_800_000_000,
  profile,
  ...over,
});

describe('leseSymbolProfil', () => {
  it('liest Kopf und Einträge, bildet die Codes des Kerns auf Anzeige-Codes ab und sortiert nach Symbol', () => {
    const p = leseSymbolProfil(doc([roh('SPY', { taktik: { quelle: 'champion', strategie: 'cross_sectional_momentum', einstiege: 'gesperrt', grund: 'g', imEngineUniversum: false } }), roh('GLD')]))!;
    expect(p.versionUnbekannt).toBe(false);
    expect(p.lauf).toEqual({ nummer: 41, configCommit: 'deadbeef' });
    expect(p.championUpdatedAt).toBe(1_725_800_000_000);
    expect(p.asOf).toBeNull();
    expect(p.profile.map((e) => e.symbol)).toEqual(['GLD', 'SPY']);
    const gld = p.profile[0]!;
    expect(gld.trend).toEqual({ richtung: 'up', seitBars: 37 });
    expect(gld.rang).toEqual({ rank: 2, of: 9, symbole: ['GLD', 'SPY', 'IWM', 'EFA', 'XLRE', 'IEF', 'LQD', 'TLT', 'EEM'] });
    expect(gld.liquiditaet).toEqual({ dollarVolumenTag: 1.5e9, tage: 60, handelbar: true, grund: null });
    expect(gld.taktik).toMatchObject({ quelle: 'basis', einstiege: 'allowed', imEngineUniversum: true });
    expect(gld.bewertung).toEqual({ configCommit: 'abc', measuredAt: 1_700_000_000_000 });
    const spy = p.profile[1]!;
    expect(spy.taktik).toMatchObject({ quelle: 'champion', einstiege: 'locked', imEngineUniversum: false });
  });

  it('Stichtag und fremde Zahlen: asOf wird gelesen, Unsinn wird null, ein Eintrag ohne Symbol fällt weg', () => {
    const p = leseSymbolProfil(doc([roh('GLD', { volatilitaet: { pct: 'viel' }, rang: { rank: 'eins', of: 9 } }), { taktik: {} }], { asOf: 1_725_000_000_000 }))!;
    expect(p.asOf).toBe(1_725_000_000_000);
    expect(p.profile).toHaveLength(1);
    expect(p.profile[0]!.volatilitaetPct).toBeNull();
    expect(p.profile[0]!.rang).toBeNull();
  });

  it('fremde Version ⇒ versionUnbekannt mit leerer Liste — nicht „noch kein Profil" (G2); kein Objekt ⇒ null', () => {
    const p = leseSymbolProfil(doc([roh('GLD')], { version: 3 }))!;
    expect(p.versionUnbekannt).toBe(true);
    expect(p.version).toBe(3);
    expect(p.profile).toEqual([]);
    expect(leseSymbolProfil(null)).toBeNull();
    expect(leseSymbolProfil('x')).toBeNull();
  });
});

describe('profilAnzeige — was je Nutzer abweicht', () => {
  const lese = (r: Record<string, unknown>): SymbolProfilEintragDoc => leseSymbolProfil(doc([r]))!.profile[0]!;
  const basis = lese(roh('GLD'));
  const alpha = lese(roh('AAPL', { klasse: { klasse: 'Aktie', cluster: 'aktie', sektor: 'Technologie', benchmark: false }, rang: { rank: 3, of: 30, pct: 0.07, korb: 'champion', symbole: ['NVDA', 'MSFT', 'AAPL'] }, taktik: { quelle: 'champion', strategie: 'cross_sectional_momentum', einstiege: 'erlaubt', grund: 'g', imEngineUniversum: true } }));
  const alphaOhneRang = lese(roh('MSFT', { rang: null, taktik: { quelle: 'champion', strategie: 'trend_donchian', einstiege: 'erlaubt', grund: 'g', imEngineUniversum: true } }));

  it('ohne Teilauswahl: nichts ausgegraut, kein Plattform-Korb-Hinweis', () => {
    expect(profilAnzeige(basis, null)).toMatchObject({ inaktiv: false, plattformKorb: false });
    expect(profilAnzeige(alpha, null)).toMatchObject({ inaktiv: false, plattformKorb: false });
  });

  it('mit Teilauswahl: die BASIS bleibt aktiv (sie kommt als Block, M5); nur nicht gewählte Alpha-Zeilen sind ausgegraut', () => {
    const auswahl = new Set(['NVDA']);
    expect(profilAnzeige(basis, auswahl).inaktiv).toBe(false);
    expect(profilAnzeige(alpha, auswahl).inaktiv).toBe(true);
    expect(profilAnzeige(alpha, new Set(['AAPL'])).inaktiv).toBe(false);
  });

  it('mit Teilauswahl trägt der Alpha-Rang den Hinweis „Plattform-Korb" (M1) — der Basis-Rang nicht, ohne Rang nichts', () => {
    const auswahl = new Set(['AAPL']);
    expect(profilAnzeige(alpha, auswahl).plattformKorb).toBe(true);
    expect(profilAnzeige(basis, auswahl).plattformKorb).toBe(false);
    expect(profilAnzeige(alphaOhneRang, auswahl).plattformKorb).toBe(false);
  });

  it('Umsatz: ohne Daten (tage 0) null statt „0.0M" (G1)', () => {
    expect(profilAnzeige(basis, null).umsatz).toBe(1.5e9);
    const leer = lese(roh('TLT', { liquiditaet: { dollarVolumenTag: 0, tage: 0, handelbar: false, grund: 'keine Tagesbars' } }));
    expect(profilAnzeige(leer, null).umsatz).toBeNull();
  });
});

describe('profilVeraltet — Profil neben einem anderen Champion (M2)', () => {
  it('gleicher Zeitstempel ⇒ aktuell; anderer ⇒ veraltet; fehlt eine Seite ⇒ kein Urteil', () => {
    expect(profilVeraltet({ championUpdatedAt: 5 }, 5)).toBe(false);
    expect(profilVeraltet({ championUpdatedAt: 5 }, 6)).toBe(true);
    expect(profilVeraltet({ championUpdatedAt: null }, 6)).toBe(false);
    expect(profilVeraltet({ championUpdatedAt: 5 }, null)).toBe(false);
  });
});
