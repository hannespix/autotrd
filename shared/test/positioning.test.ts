/**
 * Positionierungs-Bewertung (04.08., Stufe 1: nur messen).
 *
 * Warum das Tests braucht, obwohl noch nichts gehandelt wird: Die Zustände
 * dieser Datei sind die Grundlage, an der später die Evidenz gemessen wird.
 * Eine Fehlklassifikation hier fällt nie auf — sie erzeugt keinen Fehler,
 * sondern eine Statistik, die etwas anderes zählt, als ihr Name sagt. Und
 * genau auf diese Statistik soll später die Hebel-Ampel hören.
 */

import { describe, expect, it } from 'vitest';
import {
  FUNDING_CROWDED,
  FUNDING_SHORTS_PAY,
  OI_BUILD_PCT,
  OI_DROP_PCT,
  positioningState,
  positioningSummary,
  type PositioningReading,
} from '../src/positioning.js';

describe('positioningState', () => {
  it('erkennt das Short-Squeeze-Setup: Shorts zahlen UND liegen falsch', () => {
    // Am 04.08. live gemessen: DOGE und XRP standen bei negativem Funding
    // mit +1,38 % bzw. +0,69 % in 24 h — genau diese Konstellation.
    const r = positioningState({
      fundingRate: -0.0002,
      openInterest: 1000,
      openInterestPrev: 1000,
      priceChangePct: 1.4,
    });
    expect(r.state).toBe('short_squeeze_setup');
  });

  it('negatives Funding OHNE steigenden Kurs ist kein Squeeze', () => {
    // Der Unterschied ist der ganze Witz: Shorts, die zahlen und trotzdem
    // recht behalten, stehen unter keinerlei Zwang.
    const r = positioningState({
      fundingRate: -0.0002,
      openInterest: 1000,
      openInterestPrev: 1000,
      priceChangePct: -2,
    });
    expect(r.state).not.toBe('short_squeeze_setup');
  });

  it('erkennt überfüllte Longs am Funding über der Schwelle', () => {
    const r = positioningState({
      fundingRate: FUNDING_CROWDED + 0.0001,
      openInterest: null,
      priceChangePct: 0.5,
    });
    expect(r.state).toBe('longs_ueberfuellt');
  });

  it('normales Funding ist neutral — kein Alarm aus dem Alltag', () => {
    // 0,01 % je 8-h-Periode ist der langjährige Normalwert (~11 % p. a.).
    const r = positioningState({ fundingRate: 0.0001, openInterest: null, priceChangePct: 0.3 });
    expect(r.state).toBe('neutral');
    expect(r.fundingAnnualPct).toBeCloseTo(11, 0);
  });

  it('trennt Rally mit neuem Geld von Rally ohne Nachschub', () => {
    const basis = { fundingRate: 0.0001, priceChangePct: 3 };
    const eindeckung = positioningState({
      ...basis,
      openInterest: 900,
      openInterestPrev: 1000, // −10 %
    });
    const neuesGeld = positioningState({
      ...basis,
      openInterest: 1100,
      openInterestPrev: 1000, // +10 %
    });
    // Im Chart sehen beide gleich aus — der Unterschied steckt allein im OI.
    expect(eindeckung.state).toBe('rally_ohne_nachschub');
    expect(neuesGeld.state).toBe('neues_geld');
    expect(eindeckung.oiChangePct).toBeCloseTo(OI_DROP_PCT * 2, 5);
    expect(neuesGeld.oiChangePct).toBeCloseTo(OI_BUILD_PCT * 2, 5);
  });

  it('ohne Daten ist der Zustand neutral, nicht geraten', () => {
    // Die einzige verantwortbare Antwort: Geraten sähe in der späteren
    // Auswertung genauso aus wie gemessen.
    const r = positioningState({ fundingRate: null, openInterest: null });
    expect(r.state).toBe('neutral');
    expect(r.fundingRate).toBeNull();
    expect(r.oiChangePct).toBeNull();
    expect(r.fundingAnnualPct).toBeNull();
  });

  it('ohne Vergleichswert gibt es keine OI-Aussage', () => {
    const r = positioningState({ fundingRate: 0.0001, openInterest: 1000, priceChangePct: 5 });
    expect(r.oiChangePct).toBeNull();
    expect(r.state).toBe('neutral'); // OI-Regeln greifen nicht ohne Vergleich
  });

  it('unsinnige Zahlen kippen nicht in einen Zustand', () => {
    for (const f of [NaN, Infinity]) {
      const r = positioningState({ fundingRate: f, openInterest: null, priceChangePct: 5 });
      expect(r.state, `fundingRate ${String(f)}`).toBe('neutral');
      expect(r.fundingRate).toBeNull();
    }
  });

  it('das Squeeze-Setup hat Vorrang vor allen anderen Regeln', () => {
    // Reihenfolge nach Schärfe der Aussage, nicht nach Häufigkeit.
    const r = positioningState({
      fundingRate: FUNDING_SHORTS_PAY - 0.001,
      openInterest: 500,
      openInterestPrev: 1000, // wäre auch 'rally_ohne_nachschub'
      priceChangePct: 4,
    });
    expect(r.state).toBe('short_squeeze_setup');
  });
});

describe('positioningSummary', () => {
  it('zählt Zustände und die Abdeckung', () => {
    const lese = (state: PositioningReading['state']): PositioningReading => ({
      state,
      fundingRate: 0,
      oiChangePct: null,
      fundingAnnualPct: 0,
    });
    const m = new Map<string, PositioningReading>([
      ['BTC-USD', lese('longs_ueberfuellt')],
      ['ETH-USD', lese('neutral')],
      ['DOGE-USD', lese('short_squeeze_setup')],
      ['XRP-USD', lese('short_squeeze_setup')],
    ]);
    const s = positioningSummary(m);
    expect(s.abgedeckt).toBe(4);
    expect(s.zustaende['short_squeeze_setup']).toBe(2);
    expect(s.zustaende['longs_ueberfuellt']).toBe(1);
  });

  it('leere Messung heißt Abdeckung 0 — sichtbar, nicht still', () => {
    // Ohne diese Zahl ließe sich ein toter Feed nicht von einem
    // ereignislosen Markt unterscheiden. Genau diese Verwechslung war beim
    // News-Veto der Grund, `newsFetched` mitzuschreiben.
    const s = positioningSummary(new Map());
    expect(s.abgedeckt).toBe(0);
    expect(s.zustaende).toEqual({});
  });
});
