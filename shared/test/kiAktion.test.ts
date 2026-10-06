/**
 * KI-Kaskade Stufe 2b (05.10.) — die festen Regeln, die aus KI-Urteilen
 * Handlungen machen. Gepinnt wird besonders, was NIE passieren darf:
 * Ausstiege erschweren, Stops lockern, ein Urteil aus der Zukunft nutzen,
 * ein unbestätigtes Urteil handeln lassen.
 */
import { describe, expect, it } from 'vitest';
import {
  KI_PROBE_FAKTOR,
  kiGroessenFaktor,
  kiPositionsAktion,
  kiSignaleAus,
  kiStimme,
  kiUebersteuertNewsVeto,
  kiVeto,
  lexikonStimme,
  mitStimmen,
  type KiSignal,
} from '../src/kiAktion.js';

const jetzt = Date.parse('2026-10-06T15:00:00Z');
const urteil = (teil: Record<string, unknown> = {}) => ({
  newsId: 'alp-1',
  symbol: 'ACME',
  richtung: 'positiv',
  handlungsfaehig: true,
  staerke: 0.8,
  eingepreist: 'nein',
  decidedAt: '2026-10-06T14:30:00.000Z',
  pruefung: { kurskontext: { gesehen: { p: 100, t: '2026-10-06T14:25:00Z' } } },
  ...teil,
});
const signal = (teil: Partial<KiSignal> = {}): KiSignal => ({
  newsId: 'alp-1', symbol: 'ACME', richtung: 'positiv', handlungsfaehig: true, staerke: 0.8, eingepreist: 'nein',
  decidedAt: '2026-10-06T14:30:00.000Z', kursGesehen: 100, ...teil,
});

describe('kiSignaleAus', () => {
  it('nimmt je Symbol das jüngste gültige Urteil mit Kurs beim Sehen', () => {
    const m = kiSignaleAus([
      urteil({ decidedAt: '2026-10-06T13:00:00.000Z', richtung: 'negativ' }),
      urteil({ decidedAt: '2026-10-06T14:30:00.000Z' }),
      urteil({ symbol: 'BETA', richtung: 'neutral', handlungsfaehig: false }),
    ], jetzt);
    expect(m.get('ACME')).toMatchObject({ richtung: 'positiv', kursGesehen: 100, handlungsfaehig: true });
    expect(m.get('BETA')).toMatchObject({ richtung: 'neutral' });
  });

  it('ignoriert Urteile aus der Zukunft (kein Lookahead), zu alte und kaputte', () => {
    const m = kiSignaleAus([
      urteil({ decidedAt: '2026-10-06T15:00:01.000Z' }),
      urteil({ symbol: 'ALT', decidedAt: '2026-10-06T08:00:00.000Z' }),
      urteil({ symbol: 'KAPUTT', richtung: 'kaufen' }),
      urteil({ symbol: '', decidedAt: 'nie' }),
      null,
    ], jetzt);
    expect(m.size).toBe(0);
  });
});

describe('Einstieg', () => {
  const sig = (buy: number, sell: number, required = 2) => ({ direction: 'hold' as const, buyVotes: buy, sellVotes: sell, requiredConfluence: required });

  it('gegengeprüft positiv, nicht eingepreist: Kaufstimme, die allein reicht', () => {
    const v = kiStimme(signal(), 2, false);
    expect(v).toEqual({ dir: 'buy', weight: 2 });
    expect(mitStimmen(sig(0, 0), [v]).direction).toBe('buy');
  });

  it('keine Stimme: mit Position, ohne Gegenprobe, eingepreist, neutral', () => {
    expect(kiStimme(signal(), 2, true)).toBeNull();
    expect(kiStimme(signal({ handlungsfaehig: false }), 2, false)).toBeNull();
    expect(kiStimme(signal({ eingepreist: 'ja' }), 2, false)).toBeNull();
    expect(kiStimme(signal({ richtung: 'neutral' }), 2, false)).toBeNull();
    expect(kiStimme(undefined, 2, false)).toBeNull();
  });

  it('Probegröße nur, wenn die KI die Richtung erst herstellt', () => {
    expect(kiGroessenFaktor('hold', 'buy')).toBe(KI_PROBE_FAKTOR);
    expect(kiGroessenFaktor('buy', 'buy')).toBe(1);
    expect(kiGroessenFaktor('hold', 'hold')).toBe(1);
  });

  it('mitStimmen: Gegenstimmen heben sich auf, Prognose-Pfeil und KI addieren sich', () => {
    expect(mitStimmen(sig(1, 0), [{ dir: 'buy', weight: 1 }, null]).direction).toBe('buy');
    expect(mitStimmen(sig(2, 0), [{ dir: 'sell', weight: 2 }]).direction).toBe('hold');
    expect(mitStimmen({ direction: 'buy', buyVotes: 2, sellVotes: 0, requiredConfluence: 2 }, []).direction).toBe('buy');
  });

  it('Lexikon-Rückfall: nur bei erschöpftem Budget, ohne KI-Urteil, halbes Gewicht — nie allein genug', () => {
    expect(lexikonStimme(1, 2, false, undefined, true)).toEqual({ dir: 'buy', weight: 1 });
    expect(mitStimmen(sig(0, 0), [lexikonStimme(1, 2, false, undefined, true)]).direction).toBe('hold');
    expect(lexikonStimme(1, 2, false, undefined, false)).toBeNull();
    expect(lexikonStimme(1, 2, false, signal(), true)).toBeNull();
    expect(lexikonStimme(1, 2, true, undefined, true)).toBeNull();
    expect(lexikonStimme(0, 2, false, undefined, true)).toBeNull();
    for (const req of [1, 2, 3, 4, 5]) {
      const v = lexikonStimme(-1, req, false, undefined, true);
      if (v) expect(v.weight).toBeLessThan(req);
    }
  });

  it('richtungsbewusstes Veto und Aufhebung des blinden Lexikon-Vetos', () => {
    expect(kiVeto(signal({ richtung: 'negativ' }), 'long')).toBe(true);
    expect(kiVeto(signal({ richtung: 'negativ', eingepreist: 'ja' }), 'long')).toBe(true);
    expect(kiVeto(signal({ richtung: 'negativ', handlungsfaehig: false }), 'long')).toBe(false);
    expect(kiVeto(signal({ richtung: 'positiv' }), 'short')).toBe(true);
    expect(kiVeto(signal({ richtung: 'positiv' }), 'long')).toBe(false);
    expect(kiUebersteuertNewsVeto(signal(), 'long')).toBe(true);
    expect(kiUebersteuertNewsVeto(signal(), 'short')).toBe(false);
    expect(kiUebersteuertNewsVeto(signal({ handlungsfaehig: false }), 'long')).toBe(false);
  });
});

describe('gehaltene Position', () => {
  const long = { side: 'long' as const, openedAt: '2026-10-05T15:00:00.000Z', kiStop: null };
  const short = { side: 'short' as const, openedAt: '2026-10-05T15:00:00.000Z', kiStop: null };

  it('gegengeprüft negativ, noch nicht gelaufen: verkaufen', () => {
    expect(kiPositionsAktion(signal({ richtung: 'negativ' }), long, 99, 2)).toEqual({ art: 'verkauf', grund: 'ki_news' });
  });

  it('schon ≥ 1,5 ATR gefallen: nicht am Tief verkaufen, Stop nachziehen', () => {
    const a = kiPositionsAktion(signal({ richtung: 'negativ' }), long, 96, 2); // 4 % ≥ 3 %
    expect(a).toMatchObject({ art: 'stop', grund: 'ki_eingepreist' });
    expect((a as { stop: number }).stop).toBeCloseTo(96 * 0.99, 6);
  });

  it('als eingepreist bewertet: Stop statt Verkauf', () => {
    expect(kiPositionsAktion(signal({ richtung: 'negativ', eingepreist: 'ja' }), long, 99, 2)).toMatchObject({ art: 'stop' });
  });

  it('unklar und stark: nur Stop; unklar und schwach: nichts', () => {
    expect(kiPositionsAktion(signal({ richtung: 'negativ', handlungsfaehig: false, staerke: 0.6 }), long, 99, 2)).toMatchObject({ art: 'stop', grund: 'ki_unklar' });
    expect(kiPositionsAktion(signal({ richtung: 'negativ', handlungsfaehig: false, staerke: 0.3 }), long, 99, 2)).toBeNull();
  });

  it('der KI-Stop wird NIE gelockert — nur in Schutzrichtung', () => {
    expect(kiPositionsAktion(signal({ richtung: 'negativ', handlungsfaehig: false }), { ...long, kiStop: { level: 98.5 } }, 99, 2)).toBeNull();
    // steigt der Kurs, zieht er nach (Ratsche) — nie zurück
    const hoch = kiPositionsAktion(signal({ richtung: 'negativ', handlungsfaehig: false }), { ...long, kiStop: { level: 98.5 } }, 101, 2);
    expect((hoch as { stop: number }).stop).toBeCloseTo(101 * 0.99, 6);
    const s2 = kiPositionsAktion(signal({ richtung: 'positiv', handlungsfaehig: false }), short, 101, 2);
    expect(s2).toMatchObject({ art: 'stop', grund: 'ki_unklar' });
    expect((s2 as { stop: number }).stop).toBeCloseTo(101 * 1.01, 6);
    expect(kiPositionsAktion(signal({ richtung: 'positiv', handlungsfaehig: false }), { ...short, kiStop: { level: 101.5 } }, 101, 2)).toBeNull();
  });

  it('spiegelbildlich: Short + positives Urteil → eindecken', () => {
    expect(kiPositionsAktion(signal({ richtung: 'positiv' }), short, 101, 2)).toEqual({ art: 'verkauf', grund: 'ki_news' });
  });

  it('Urteil in Positionsrichtung, neutral oder fehlend: nichts', () => {
    expect(kiPositionsAktion(signal({ richtung: 'positiv' }), long, 99, 2)).toBeNull();
    expect(kiPositionsAktion(signal({ richtung: 'neutral' }), long, 99, 2)).toBeNull();
    expect(kiPositionsAktion(undefined, long, 99, 2)).toBeNull();
  });

  it('ohne ATR: Verkauf weiter möglich, Stop nachziehen nicht (keine geratene Distanz)', () => {
    expect(kiPositionsAktion(signal({ richtung: 'negativ' }), long, 99, null)).toEqual({ art: 'verkauf', grund: 'ki_news' });
    expect(kiPositionsAktion(signal({ richtung: 'negativ', handlungsfaehig: false }), long, 99, null)).toBeNull();
  });

  it('Position NACH dem Urteil eröffnet: die KI fasst sie nicht an', () => {
    const neu = { side: 'long' as const, openedAt: '2026-10-06T14:31:00.000Z', kiStop: null };
    expect(kiPositionsAktion(signal({ richtung: 'negativ' }), neu, 99, 2)).toBeNull();
    const zeitgleich = { ...neu, openedAt: '2026-10-06T14:30:00.000Z' };
    expect(kiPositionsAktion(signal({ richtung: 'negativ' }), zeitgleich, 99, 2)).toBeNull();
    // ohne lesbares Eröffnungsdatum (Altbestand) gilt die Position als älter
    expect(kiPositionsAktion(signal({ richtung: 'negativ' }), { side: 'long' }, 99, 2)).toEqual({ art: 'verkauf', grund: 'ki_news' });
  });
});
