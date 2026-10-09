/** Task 22: Anzeige-Kopie der KI-Einordnungen — Whitelist, kein Fremdtext. */
import { describe, expect, it } from 'vitest';
import { KI_ANZEIGE_MAX, kiAktuell, kiAnzeigeEintrag, kiAnzeigeGespeichert, kiAnzeigeMischen, kiWirkt } from '../src/kiAnzeige.js';

const urteil = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  newsId: '4711', symbol: 'AAPL', richtung: 'positiv', handlungsfaehig: true, stufe: 'pruefung',
  staerke: 0.734, eingepreist: 'nein', horizontTage: 3, firstSeenAt: '2026-10-09T14:00:00.000Z', decidedAt: '2026-10-09T14:05:00.000Z',
  sichtung: { ereignis: 'zahlen', kurz: 'Apple übertrifft die Erwartungen deutlich' },
  pruefung: { begruendung: 'Gegenargument: …', kurskontext: { preis: 230 }, usd: 0.004, modell: 'm', aufrufId: 'x' },
  schlagzeile: 'Apple beats', url: 'https://example.com', laufId: 'lauf', promptV: 3, ...over,
});

describe('kiAnzeigeEintrag', () => {
  it('nimmt NUR die Whitelist — kein Freitext, keine Schlagzeile, keine Kurse, keine Kosten', () => {
    const e = kiAnzeigeEintrag('4711_AAPL', urteil())!;
    expect(Object.keys(e).sort()).toEqual(['decidedAt', 'eingepreist', 'ereignis', 'firstSeenAt', 'gegengeprueft', 'handlungsfaehig', 'horizontTage', 'id', 'newsId', 'richtung', 'staerke']);
    const json = JSON.stringify(e);
    for (const verboten of ['übertrifft', 'Gegenargument', 'Apple beats', 'example.com', 'kurskontext', '230', 'usd', 'modell', 'laufId', 'promptV']) {
      expect(json, verboten).not.toContain(verboten);
    }
    expect(e).toMatchObject({ richtung: 'positiv', gegengeprueft: true, handlungsfaehig: true, staerke: 0.7, eingepreist: 'nein', horizontTage: 3, ereignis: 'zahlen' });
  });

  it('verwirft, was nicht in Form ist, statt zu raten', () => {
    expect(kiAnzeigeEintrag('4711_AAPL', urteil({ richtung: null }))).toBeNull();
    expect(kiAnzeigeEintrag('4711_AAPL', urteil({ richtung: 'super' }))).toBeNull();
    expect(kiAnzeigeEintrag('4711_AAPL', urteil({ decidedAt: 'gestern' }))).toBeNull();
    expect(kiAnzeigeEintrag('<script>', urteil())).toBeNull();
    const e = kiAnzeigeEintrag('4711_AAPL', urteil({ eingepreist: 'vielleicht', sichtung: { ereignis: 'erfunden' }, staerke: 7, horizontTage: -2 }))!;
    expect(e).toMatchObject({ eingepreist: null, ereignis: null, staerke: 1, horizontTage: null });
  });

  it('Sichtung ohne Gegenprobe bleibt als solche erkennbar', () => {
    expect(kiAnzeigeEintrag('4711_AAPL', urteil({ stufe: 'sichtung', handlungsfaehig: false }))).toMatchObject({ gegengeprueft: false, handlungsfaehig: false });
  });
});

describe('kiAnzeigeMischen', () => {
  it('je Kennung einmal, jüngste zuerst, gedeckelt — gespeicherte Einträge werden erneut geprüft', () => {
    const eintraege = Array.from({ length: 14 }, (_, i) =>
      kiAnzeigeEintrag(`${i}_AAPL`, urteil({ newsId: String(i), decidedAt: `2026-10-09T${String(10 + (i % 10)).padStart(2, '0')}:0${i % 6}:00.000Z` }))!);
    const alt = [...eintraege.slice(0, 5), { id: 'kaputt', richtung: 'x' }, { ...eintraege[0], schlagzeile: 'eingeschleust' }];
    const neu = kiAnzeigeMischen(alt, eintraege.slice(3));
    expect(neu).toHaveLength(KI_ANZEIGE_MAX);
    expect(new Set(neu.map((e) => e.id)).size).toBe(KI_ANZEIGE_MAX);
    expect(neu.map((e) => e.decidedAt)).toEqual([...neu.map((e) => e.decidedAt)].sort().reverse());
    expect(JSON.stringify(neu)).not.toContain('eingeschleust');
    expect(kiAnzeigeGespeichert({ id: 'kaputt', richtung: 'x' })).toBeNull();
  });
});

describe('kiAktuell / kiWirkt — dieselbe Logik wie der Handel (kiSignaleAus, traegt)', () => {
  const jetzt = Date.parse('2026-10-09T16:00:00.000Z');
  const e = (newsId: string, over: Record<string, unknown> = {}) => kiAnzeigeEintrag(`${newsId}_AAPL`, urteil({ newsId, firstSeenAt: '2026-10-09T14:30:00.000Z', decidedAt: '2026-10-09T15:00:00.000Z', ...over }))!;

  it('frisch, bestätigt, nicht eingepreist ⇒ wirkt und ist maßgeblich', () => {
    const a = e('1');
    expect(kiWirkt(a, jetzt)).toBe(true);
    expect(kiAktuell([a], 'AAPL', jetzt)).toBe(a);
  });

  it('eine jüngere geprüfte NEUTRALE Einordnung löst die ältere ab — kein Abzeichen', () => {
    const alt = e('1');
    const neutral = e('2', { richtung: 'neutral', firstSeenAt: '2026-10-09T15:20:00.000Z', decidedAt: '2026-10-09T15:30:00.000Z' });
    expect(kiAktuell([neutral, alt], 'AAPL', jetzt)).toBeNull();
  });

  it('unbestätigt, schon eingepreist, zu alt oder aus der Zukunft ⇒ wirkt nicht', () => {
    expect(kiWirkt(e('1', { handlungsfaehig: false }), jetzt)).toBe(false);
    expect(kiAktuell([e('1', { handlungsfaehig: false })], 'AAPL', jetzt)).toBeNull();
    expect(kiWirkt(e('1', { eingepreist: 'ja' }), jetzt)).toBe(false);
    expect(kiWirkt(e('1', { firstSeenAt: '2026-10-09T09:00:00.000Z' }), jetzt)).toBe(false); // 7 h > KI_GUELTIG_STUNDEN
    expect(kiWirkt(e('1', { decidedAt: '2026-10-09T17:00:00.000Z' }), jetzt)).toBe(false);
  });
});
