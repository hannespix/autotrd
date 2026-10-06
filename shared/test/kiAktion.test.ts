/**
 * KI-Kaskade Stufe 2b (05.10./06.10.) — die festen Regeln, die aus KI-Urteilen
 * Handlungen machen. Gepinnt wird besonders, was NIE passieren darf:
 * Ausstiege erschweren, Stops lockern, ein Urteil aus der Zukunft nutzen,
 * ein unbestätigtes Urteil handeln lassen, dem Kurs hinterherlaufen, mit
 * EINEM Urteil mehrfach handeln (Red-Team 06.10.).
 */
import { describe, expect, it } from 'vitest';
import {
  KI_PROBE_FAKTOR,
  istKiProbeBucket,
  kiGroessenFaktor,
  kiPositionsAktion,
  kiSignaleAus,
  kiStimme,
  kiUebersteuertNewsVeto,
  kiVeto,
  lexikonStimme,
  mitStimmen,
  type KiGenutzt,
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
  stufe: 'pruefung',
  publishedAt: '2026-10-06T14:20:00.000Z',
  firstSeenAt: '2026-10-06T14:21:00.000Z',
  decidedAt: '2026-10-06T14:30:00.000Z',
  pruefung: { kurskontext: { gesehen: { p: 100, t: '2026-10-06T14:25:00Z' } } },
  ...teil,
});
const signal = (teil: Partial<KiSignal> = {}): KiSignal => ({
  newsId: 'alp-1', symbol: 'ACME', richtung: 'positiv', handlungsfaehig: true, staerke: 0.8, eingepreist: 'nein',
  decidedAt: '2026-10-06T14:30:00.000Z', firstSeenAt: '2026-10-06T14:21:00.000Z', publishedAt: '2026-10-06T14:20:00.000Z',
  geprueft: true, kursGesehen: 100, ...teil,
});

describe('kiSignaleAus', () => {
  it('nimmt je Symbol das jüngste gültige Urteil mit Kurs beim Sehen', () => {
    const m = kiSignaleAus([
      urteil({ decidedAt: '2026-10-06T13:00:00.000Z', richtung: 'negativ' }),
      urteil({ decidedAt: '2026-10-06T14:30:00.000Z' }),
      urteil({ symbol: 'BETA', richtung: 'neutral', handlungsfaehig: false }),
    ], jetzt);
    expect(m.get('ACME')).toMatchObject({ richtung: 'positiv', kursGesehen: 100, handlungsfaehig: true, geprueft: true });
    expect(m.get('BETA')).toMatchObject({ richtung: 'neutral' });
  });

  it('ignoriert Urteile aus der Zukunft (kein Lookahead), zu alte und kaputte', () => {
    const m = kiSignaleAus([
      urteil({ decidedAt: '2026-10-06T15:00:01.000Z' }),
      urteil({ symbol: 'ALT', firstSeenAt: '2026-10-06T08:00:00.000Z', decidedAt: '2026-10-06T09:30:00.000Z' }),
      urteil({ symbol: 'KAPUTT', richtung: 'kaufen' }),
      urteil({ symbol: '', decidedAt: 'nie' }),
      null,
    ], jetzt);
    expect(m.size).toBe(0);
  });

  it('das Alter zählt ab dem ERSTEN SEHEN, nicht ab dem Schreiben des Urteils', () => {
    // gesehen 08:30, geurteilt 10:00 — um 15:00 sind es 6,5 h seit dem Sehen
    const m = kiSignaleAus([urteil({ firstSeenAt: '2026-10-06T08:30:00.000Z', decidedAt: '2026-10-06T10:00:00.000Z' })], jetzt);
    expect(m.size).toBe(0);
  });

  it('eine jüngere ungeprüfte oder neutrale Sichtung verdrängt kein gegengeprüftes Urteil (N2)', () => {
    const m = kiSignaleAus([
      urteil({ richtung: 'negativ', decidedAt: '2026-10-06T13:00:00.000Z' }),
      urteil({ newsId: 'alp-2', richtung: 'neutral', handlungsfaehig: false, stufe: 'sichtung', decidedAt: '2026-10-06T14:50:00.000Z' }),
      urteil({ newsId: 'alp-3', richtung: 'positiv', handlungsfaehig: false, stufe: 'sichtung', decidedAt: '2026-10-06T14:55:00.000Z' }),
    ], jetzt);
    expect(m.get('ACME')).toMatchObject({ newsId: 'alp-1', richtung: 'negativ' });
    // R1: ein jüngeres GEPRÜFTES Urteil löst ab — auch wenn es nicht bestätigt
    // ist und das ältere bestätigt war (sonst kaufte man gegen neue Evidenz)
    const r1 = kiSignaleAus([
      urteil({ eingepreist: 'teilweise', decidedAt: '2026-10-06T14:00:00.000Z' }),
      urteil({ newsId: 'alp-5', richtung: 'negativ', handlungsfaehig: false, staerke: 0.9, decidedAt: '2026-10-06T14:45:00.000Z' }),
    ], jetzt);
    expect(r1.get('ACME')).toMatchObject({ newsId: 'alp-5', richtung: 'negativ', handlungsfaehig: false });
    // … und eine geprüft NEUTRALE ebenso
    const neutral = kiSignaleAus([
      urteil({ decidedAt: '2026-10-06T14:00:00.000Z' }),
      urteil({ newsId: 'alp-6', richtung: 'neutral', handlungsfaehig: false, decidedAt: '2026-10-06T14:45:00.000Z' }),
    ], jetzt);
    expect(neutral.get('ACME')).toMatchObject({ newsId: 'alp-6', richtung: 'neutral' });
    // ein jüngeres GEGENGEPRÜFTES Urteil löst dagegen ab
    const n = kiSignaleAus([
      urteil({ richtung: 'negativ', decidedAt: '2026-10-06T13:00:00.000Z' }),
      urteil({ newsId: 'alp-4', decidedAt: '2026-10-06T14:40:00.000Z' }),
    ], jetzt);
    expect(n.get('ACME')).toMatchObject({ newsId: 'alp-4', richtung: 'positiv' });
  });

  it('Gleichstand hängt nicht an der Abfrage-Reihenfolge', () => {
    const a = urteil({ newsId: 'alp-a', staerke: 0.7 });
    const b = urteil({ newsId: 'alp-b', staerke: 0.7, richtung: 'negativ' });
    expect(kiSignaleAus([a, b], jetzt).get('ACME')?.newsId).toBe(kiSignaleAus([b, a], jetzt).get('ACME')?.newsId);
  });
});

describe('Einstieg', () => {
  const sig = (buy: number, sell: number, required = 2) => ({ direction: 'hold' as const, buyVotes: buy, sellVotes: sell, requiredConfluence: required });
  const stimme = (s: KiSignal | undefined, preis = 100.5, atr: number | null = 2, um = jetzt, genutzt?: KiGenutzt) =>
    kiStimme(s, 2, false, preis, atr, um, genutzt);

  it('gegengeprüft positiv, nicht eingepreist, frisch: Kaufstimme, die allein reicht', () => {
    const v = stimme(signal());
    expect(v).toEqual({ dir: 'buy', weight: 2 });
    expect(mitStimmen(sig(0, 0), [v]).direction).toBe('buy');
  });

  it('keine Stimme: mit Position, ohne Gegenprobe, eingepreist, neutral', () => {
    expect(kiStimme(signal(), 2, true, 100.5, 2, jetzt)).toBeNull();
    expect(stimme(signal({ handlungsfaehig: false }))).toBeNull();
    expect(stimme(signal({ eingepreist: 'ja' }))).toBeNull();
    expect(stimme(signal({ richtung: 'neutral' }))).toBeNull();
    expect(stimme(undefined)).toBeNull();
  });

  it('kein Hinterherlaufen (H3): schon ≥ 1,5 ATR gelaufen, zu alt, oder nicht prüfbar', () => {
    expect(stimme(signal(), 103)).toBeNull(); // +3 % ≥ 1,5 × 2 %
    expect(stimme(signal(), 102.9)).not.toBeNull();
    expect(stimme(signal({ richtung: 'negativ' }), 97)).toBeNull(); // spiegelbildlich
    // beidseitig (R2): 1,5 ATR GEGEN die Meldung gelaufen — kein Griff ins fallende Messer
    expect(stimme(signal(), 97)).toBeNull();
    expect(stimme(signal(), 97.1)).not.toBeNull();
    expect(stimme(signal(), 100.5, 2, Date.parse('2026-10-06T16:22:00Z'))).toBeNull(); // > 2 h seit dem Sehen
    expect(stimme(signal(), 100.5, 2, Date.parse('2026-10-06T16:20:00Z'))).not.toBeNull();
    expect(stimme(signal({ kursGesehen: null }))).toBeNull();
    expect(stimme(signal(), 100.5, null)).toBeNull();
  });

  it('ein Ereignis, eine Handlung (H3/R3): je Symbol höchstens eine KI-Handlung in 6 h', () => {
    expect(stimme(signal(), 100.5, 2, jetzt, { newsId: 'alp-1', at: '2026-10-05T10:00:00.000Z' })).toBeNull(); // dieselbe Meldung
    // Folgeartikel mit NEUER newsId binnen 6 h: ebenfalls gesperrt
    expect(stimme(signal(), 100.5, 2, jetzt, { newsId: 'alp-0', at: '2026-10-06T12:00:00.000Z' })).toBeNull();
    expect(stimme(signal(), 100.5, 2, jetzt, { newsId: 'alp-0', at: '2026-10-06T08:59:00.000Z' })).not.toBeNull();
    // unlesbarer Vermerk: im Zweifel keine zweite Handlung
    expect(stimme(signal(), 100.5, 2, jetzt, { newsId: 'alp-0' } as KiGenutzt)).toBeNull();
    expect(stimme(signal(), 100.5, 2, jetzt, undefined)).not.toBeNull();
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
    const v = { macd: 'buy', rsi: 'sell' };
    expect(lexikonStimme(1, 2, false, undefined, true, v)).toEqual({ dir: 'buy', weight: 1 });
    expect(mitStimmen(sig(0, 0), [lexikonStimme(1, 2, false, undefined, true, v)]).direction).toBe('hold');
    expect(lexikonStimme(1, 2, false, undefined, false, v)).toBeNull();
    expect(lexikonStimme(1, 2, false, signal(), true, v)).toBeNull();
    expect(lexikonStimme(1, 2, true, undefined, true, v)).toBeNull();
    expect(lexikonStimme(0, 2, false, undefined, true, v)).toBeNull();
    for (const req of [1, 2, 3, 4, 5]) {
      const w = lexikonStimme(-1, req, false, undefined, true, v);
      if (w) expect(w.weight).toBeLessThan(req);
    }
  });

  it('Lexikon nie ohne Indikator in derselben Richtung (M2: Prognose + Lexikon allein reicht nicht)', () => {
    expect(lexikonStimme(1, 2, false, undefined, true, { forecast: 'buy', macd: 'hold' })).toBeNull();
    expect(lexikonStimme(-1, 2, false, undefined, true, { macd: 'buy' })).toBeNull();
    expect(lexikonStimme(-1, 2, false, undefined, true, { bollinger: 'sell' })).toEqual({ dir: 'sell', weight: 1 });
  });

  it('richtungsbewusstes Veto', () => {
    expect(kiVeto(signal({ richtung: 'negativ' }), 'long')).toBe(true);
    expect(kiVeto(signal({ richtung: 'negativ', eingepreist: 'ja' }), 'long')).toBe(true);
    expect(kiVeto(signal({ richtung: 'negativ', handlungsfaehig: false }), 'long')).toBe(false);
    expect(kiVeto(signal({ richtung: 'positiv' }), 'short')).toBe(true);
    expect(kiVeto(signal({ richtung: 'positiv' }), 'long')).toBe(false);
  });

  it('Aufhebung des blinden Lexikon-Vetos nur für DASSELBE Ereignis (H2)', () => {
    const ereignis = Date.parse('2026-10-06T14:00:00Z') / 1000;
    expect(kiUebersteuertNewsVeto(signal(), 'long', ereignis)).toBe(true); // 20 min Abstand
    expect(kiUebersteuertNewsVeto(signal({ publishedAt: '2026-10-06T10:00:00.000Z' }), 'long', ereignis)).toBe(false);
    expect(kiUebersteuertNewsVeto(signal({ publishedAt: '2026-10-06T15:30:00.000Z' }), 'long', ereignis)).toBe(false);
    expect(kiUebersteuertNewsVeto(signal(), 'long', null)).toBe(false);
    expect(kiUebersteuertNewsVeto(signal(), 'short', ereignis)).toBe(false);
    expect(kiUebersteuertNewsVeto(signal({ handlungsfaehig: false }), 'long', ereignis)).toBe(false);
  });
});

describe('gehaltene Position', () => {
  const long = { side: 'long' as const, openedAt: '2026-10-05T15:00:00.000Z', kiStop: null };
  const short = { side: 'short' as const, openedAt: '2026-10-05T15:00:00.000Z', kiStop: null };
  const neg = (teil: Partial<KiSignal> = {}) => signal({ richtung: 'negativ', ...teil });

  it('gegengeprüft negativ, belegt nicht eingepreist, noch nicht gelaufen: verkaufen', () => {
    expect(kiPositionsAktion(neg(), long, 99, 2)).toEqual({ art: 'verkauf', grund: 'ki_news' });
  });

  it('schon ≥ 1,5 ATR gefallen: nicht am Tief verkaufen, Stop nachziehen', () => {
    const a = kiPositionsAktion(neg(), long, 96, 2); // 4 % ≥ 3 %
    expect(a).toMatchObject({ art: 'stop', grund: 'ki_eingepreist' });
    expect((a as { stop: number }).stop).toBeCloseTo(96 * 0.99, 6);
  });

  it('eingepreist „ja"/„teilweise"/„unklar"/fehlend: Stop statt Verkauf (M1)', () => {
    for (const e of ['ja', 'teilweise', 'unklar', null] as const) {
      expect(kiPositionsAktion(neg({ eingepreist: e }), long, 99, 2)).toMatchObject({ art: 'stop', grund: 'ki_eingepreist' });
    }
  });

  it('Markt läuft ≥ 1,5 ATR GEGEN die Meldung: Stop statt Verkauf (R2, beidseitig)', () => {
    expect(kiPositionsAktion(neg(), long, 103.5, 2)).toMatchObject({ art: 'stop', grund: 'ki_eingepreist' });
  });

  it('ohne Kurs beim Sehen oder ohne ATR: KEIN blinder Verkauf (M1)', () => {
    expect(kiPositionsAktion(neg({ kursGesehen: null }), long, 90, 2)).toMatchObject({ art: 'stop' });
    expect(kiPositionsAktion(neg(), long, 90, null)).toBeNull(); // ohne ATR keine geratene Stop-Distanz
  });

  it('unklar: nur nach gelaufener Gegenprobe, ab Stärke 0,6, mit 1 ATR Abstand (M5)', () => {
    const a = kiPositionsAktion(neg({ handlungsfaehig: false, staerke: 0.6 }), long, 99, 2);
    expect(a).toMatchObject({ art: 'stop', grund: 'ki_unklar' });
    expect((a as { stop: number }).stop).toBeCloseTo(99 * 0.98, 6);
    expect(kiPositionsAktion(neg({ handlungsfaehig: false, staerke: 0.55 }), long, 99, 2)).toBeNull();
    // bloße Sichtung (Budget, Alter, unlesbar): nichts
    expect(kiPositionsAktion(neg({ handlungsfaehig: false, geprueft: false, staerke: 0.9 }), long, 99, 2)).toBeNull();
  });

  it('der KI-Stop wird NIE gelockert — nur in Schutzrichtung', () => {
    expect(kiPositionsAktion(neg({ eingepreist: 'ja' }), { ...long, kiStop: { level: 98.5 } }, 99, 2)).toBeNull();
    // steigt der Kurs, zieht er nach (Ratsche) — nie zurück
    const hoch = kiPositionsAktion(neg({ eingepreist: 'ja' }), { ...long, kiStop: { level: 98.5 } }, 101, 2);
    expect((hoch as { stop: number }).stop).toBeCloseTo(101 * 0.99, 6);
    const s2 = kiPositionsAktion(signal({ handlungsfaehig: false }), short, 101, 2);
    expect(s2).toMatchObject({ art: 'stop', grund: 'ki_unklar' });
    expect((s2 as { stop: number }).stop).toBeCloseTo(101 * 1.02, 6);
    expect(kiPositionsAktion(signal({ handlungsfaehig: false }), { ...short, kiStop: { level: 102.5 } }, 101, 2)).toBeNull();
  });

  it('spiegelbildlich: Short + positives Urteil → eindecken', () => {
    expect(kiPositionsAktion(signal(), short, 101, 2)).toEqual({ art: 'verkauf', grund: 'ki_news' });
  });

  it('Urteil in Positionsrichtung, neutral oder fehlend: nichts', () => {
    expect(kiPositionsAktion(signal(), long, 99, 2)).toBeNull();
    expect(kiPositionsAktion(signal({ richtung: 'neutral' }), long, 99, 2)).toBeNull();
    expect(kiPositionsAktion(undefined, long, 99, 2)).toBeNull();
  });

  it('Position NACH dem Urteil eröffnet: die KI fasst sie nicht an', () => {
    const neu = { side: 'long' as const, openedAt: '2026-10-06T14:31:00.000Z', kiStop: null };
    expect(kiPositionsAktion(neg(), neu, 99, 2)).toBeNull();
    expect(kiPositionsAktion(neg(), { ...neu, openedAt: '2026-10-06T14:30:00.000Z' }, 99, 2)).toBeNull();
    // ohne lesbares Eröffnungsdatum (Altbestand) gilt die Position als älter
    expect(kiPositionsAktion(neg(), { side: 'long' }, 99, 2)).toEqual({ art: 'verkauf', grund: 'ki_news' });
  });
});

describe('istKiProbeBucket', () => {
  it('erkennt nur ki/lex als eigenen Signatur-Teil', () => {
    expect(istKiProbeBucket('crypto|intraday|bollinger+ki|long|trend')).toBe(true);
    expect(istKiProbeBucket('stock|daily|lex+macd|short|alle')).toBe(true);
    expect(istKiProbeBucket('stock|daily|bollinger+macd|long|alle')).toBe(false);
    expect(istKiProbeBucket('stock|daily|keine|long|kiosk')).toBe(false);
    expect(istKiProbeBucket(undefined)).toBe(false);
  });
});
