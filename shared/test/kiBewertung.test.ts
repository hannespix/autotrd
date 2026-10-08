/**
 * KI-Kaskade Stufe 3 (08.10.): Bewertung der Urteile nach Horizont, Gewicht
 * der KI-Stimme, Untätigkeits-Alarm — alles pure.
 *
 * Die beiden Fragen, die hier zählen: Kann ein Kurs VOR dem Urteil in die
 * Bewertung geraten (Lookahead)? Und kann das Gewicht Schutz lockern?
 */
import { describe, expect, it } from 'vitest';
import {
  bewerteKiWirkung,
  bewerteUrteil,
  bezugZeitMs,
  bucketsFuer,
  etTag,
  isoWocheEt,
  KI_GEWICHT_MAX,
  KI_GEWICHT_MIN,
  KI_MIN_FAELLE,
  KI_VERFALL_TAGE,
  KI_WIRKUNG_LAGE_MIN,
  kiGewicht,
  kiGroessenFaktor,
  KI_PROBE_FAKTOR,
  kiStimmGewicht,
  kostenRateFuer,
  wochenNachricht,
  zeitMs,
  type KiUrteilRoh,
} from '../src/index.js';

const schluesse = [
  { date: '2026-09-01', close: 100 },
  { date: '2026-09-02', close: 102 },
  { date: '2026-09-03', close: 101 },
  { date: '2026-09-04', close: 105 },
  { date: '2026-09-08', close: 104 },
  { date: '2026-09-09', close: 110 },
];

const urteil = (extra: Partial<KiUrteilRoh> = {}): KiUrteilRoh => ({
  newsId: 'n1',
  symbol: 'AAPL',
  richtung: 'positiv',
  handlungsfaehig: true,
  eingepreist: 'nein',
  horizontTage: 3,
  stufe: 'pruefung',
  firstSeenAt: '2026-09-01T13:30:00Z',
  decidedAt: '2026-09-01T13:40:00Z',
  gespeichertAt: { seconds: Date.parse('2026-09-01T13:41:00Z') / 1000 },
  sichtung: { ereignis: 'zahlen' },
  pruefung: { kurskontext: { aktuell: { p: 100.5, t: '2026-09-01T13:40:00Z' } } },
  ...extra,
});

describe('Bezugszeit und Tage', () => {
  it('zeitMs liest ISO, Timestamp-Objekt und {seconds}', () => {
    expect(zeitMs('2026-09-01T13:30:00Z')).toBe(Date.parse('2026-09-01T13:30:00Z'));
    expect(zeitMs({ toMillis: () => 5 })).toBe(5);
    expect(zeitMs({ seconds: 7 })).toBe(7000);
    expect(zeitMs({ _seconds: 7 })).toBe(7000);
    expect(zeitMs('kaputt')).toBeNull();
    expect(zeitMs(null)).toBeNull();
  });
  it('die Bezugszeit ist das SPÄTESTE von firstSeenAt, decidedAt, gespeichertAt', () => {
    expect(bezugZeitMs(urteil())).toBe(Date.parse('2026-09-01T13:41:00Z'));
    expect(bezugZeitMs({ decidedAt: '2026-09-01T13:40:00Z' })).toBe(Date.parse('2026-09-01T13:40:00Z'));
    expect(bezugZeitMs({})).toBeNull();
  });
  it('etTag ist das New-Yorker Datum', () => {
    expect(etTag(Date.parse('2026-09-02T02:00:00Z'))).toBe('2026-09-01'); // 22:00 ET am Vortag
  });
});

describe('bewerteUrteil — Gate und Rechnung', () => {
  it('Einstieg = Kurs beim Urteil, Ziel = Schluss des 3. Handelstags NACH dem Bezugstag, netto nach Kosten', () => {
    const r = bewerteUrteil(urteil(), schluesse, 0.001, '2026-09-10');
    expect(r.stand).toBe('bewertet');
    if (r.stand !== 'bewertet') return;
    expect(r.einstiegQuelle).toBe('urteil');
    expect(r.einstieg).toBe(100.5);
    expect(r.endTag).toBe('2026-09-04');
    expect(r.ziel).toBe(105);
    expect(r.bruttoPct).toBeCloseTo((105 / 100.5 - 1) * 100, 3);
    expect(r.kostenPct).toBe(0.1);
    expect(r.nettoPct).toBeCloseTo(r.bruttoPct - 0.1, 3);
    expect(r.treffer).toBe(true);
  });
  it('negatives Urteil: Richtung gespiegelt', () => {
    const r = bewerteUrteil(urteil({ richtung: 'negativ' }), schluesse, 0, '2026-09-10');
    expect(r.stand === 'bewertet' && r.bruttoPct < 0 && r.treffer === false).toBe(true);
  });
  it('LOOKAHEAD-GATE: End-Tag muss strikt vor heute liegen', () => {
    expect(bewerteUrteil(urteil(), schluesse, 0, '2026-09-04').stand).toBe('offen');
    expect(bewerteUrteil(urteil(), schluesse, 0, '2026-09-05').stand).toBe('bewertet');
  });
  it('kein Kurs vor dem Bezugstag wird je benutzt: ohne Urteilskurs ist der Einstieg der ERSTE Schluss DANACH', () => {
    const r = bewerteUrteil(urteil({ pruefung: null }), schluesse, 0, '2026-09-10');
    expect(r.stand).toBe('bewertet');
    if (r.stand !== 'bewertet') return;
    expect(r.einstiegQuelle).toBe('schluss');
    expect(r.einstieg).toBe(102); // 2026-09-02, nicht der 100er Schluss vom Bezugstag
    expect(r.endTag).toBe('2026-09-08'); // drei Schlüsse nach dem Einstiegsschluss
  });
  it('Urteil nach Börsenschluss (ET): der Schluss desselben Tages liegt VOR dem Urteil und zählt nicht', () => {
    const spaet = urteil({
      firstSeenAt: '2026-09-02T21:30:00Z', // 17:30 ET
      decidedAt: '2026-09-02T21:40:00Z',
      gespeichertAt: '2026-09-02T21:41:00Z',
      pruefung: null,
    });
    const r = bewerteUrteil(spaet, schluesse, 0, '2026-09-10');
    expect(r.stand === 'bewertet' && r.einstieg === 101 && r.bezugTag === '2026-09-02').toBe(true);
  });
  it('zu wenig Kerzen: offen — und nach KI_VERFALL_TAGE verfallen, nie bewertet', () => {
    expect(KI_VERFALL_TAGE).toBe(30);
    const wenig = schluesse.slice(0, 2);
    expect(bewerteUrteil(urteil(), wenig, 0, '2026-09-20').stand).toBe('offen');
    expect(bewerteUrteil(urteil(), wenig, 0, '2026-10-05')).toEqual({ stand: 'verfallen', grund: 'keine_kerzen' });
  });
  it('neutral und ohne Richtung werden übersprungen, nicht bewertet', () => {
    expect(bewerteUrteil(urteil({ richtung: 'neutral' }), schluesse, 0, '2026-09-10')).toEqual({ stand: 'uebersprungen', grund: 'neutral' });
    expect(bewerteUrteil(urteil({ richtung: null }), schluesse, 0, '2026-09-10')).toEqual({ stand: 'uebersprungen', grund: 'ohne_richtung' });
    expect(bewerteUrteil(urteil({ firstSeenAt: undefined, decidedAt: undefined, gespeichertAt: undefined }), schluesse, 0, '2026-09-10'))
      .toEqual({ stand: 'uebersprungen', grund: 'ohne_bezug' });
  });
  it('Horizont wird auf 1–10 geklemmt, Default 3', () => {
    const r1 = bewerteUrteil(urteil({ horizontTage: 99 }), schluesse, 0, '2026-09-30');
    expect(r1.stand).toBe('offen'); // 10 Handelstage gibt es hier nicht
    const r2 = bewerteUrteil(urteil({ horizontTage: null }), schluesse, 0, '2026-09-10');
    expect(r2.stand === 'bewertet' && r2.horizontTage === 3).toBe(true);
    const r3 = bewerteUrteil(urteil({ horizontTage: 0 }), schluesse, 0, '2026-09-10');
    expect(r3.stand === 'bewertet' && r3.horizontTage === 1 && r3.endTag === '2026-09-02').toBe(true);
  });
  it('Kosten je Symbol kommen aus der Anlageklasse (Krypto teurer als US-Aktie)', () => {
    expect(kostenRateFuer('BTC-USD')).toBeGreaterThan(kostenRateFuer('AAPL'));
    expect(kostenRateFuer('AAPL')).toBeGreaterThan(0);
  });
});

describe('Buckets', () => {
  it('gesamt, Stufe, wirksam/schatten, Ereignis', () => {
    expect(bucketsFuer(urteil())).toEqual(['gesamt', 'pruefung', 'wirksam', 'ereignis_zahlen']);
    expect(bucketsFuer(urteil({ eingepreist: 'ja' }))).toEqual(['gesamt', 'pruefung', 'schatten', 'ereignis_zahlen']);
    expect(bucketsFuer(urteil({ handlungsfaehig: false, stufe: 'sichtung', sichtung: { ereignis: 'X Y' } }))).toEqual([
      'gesamt', 'sichtung', 'schatten',
    ]);
  });
});

describe('kiGewicht — spricht erst ab KI_MIN_FAELLE, lockert nie Schutz', () => {
  it('unter der Mindestzahl bleibt es bei 1, egal wie gut', () => {
    expect(KI_MIN_FAELLE).toBe(20);
    expect(kiGewicht({ n: 19, treffer: 19, nettoSum: 50 })).toBe(1);
    expect(kiGewicht(undefined)).toBe(1);
    expect(kiGewicht(null)).toBe(1);
  });
  it('50 % → 1, 65 % → 2 (Deckel), 35 % → 0,25 (Boden)', () => {
    expect(kiGewicht({ n: 100, treffer: 50, nettoSum: 10 })).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 65, nettoSum: 10 })).toBe(KI_GEWICHT_MAX);
    expect(kiGewicht({ n: 100, treffer: 80, nettoSum: 10 })).toBe(KI_GEWICHT_MAX);
    expect(kiGewicht({ n: 100, treffer: 35, nettoSum: -10 })).toBe(KI_GEWICHT_MIN);
    expect(kiGewicht({ n: 100, treffer: 10, nettoSum: -10 })).toBe(KI_GEWICHT_MIN);
    expect(kiGewicht({ n: 100, treffer: 57, nettoSum: 1 })).toBeCloseTo(1.47, 2);
  });
  it('mehr als 1 nur mit positiver Netto-Summe', () => {
    expect(kiGewicht({ n: 100, treffer: 65, nettoSum: 0 })).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 65, nettoSum: -3 })).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 40, nettoSum: -3 })).toBeLessThan(1); // nach unten wirkt es immer
  });
});

describe('Anwendung in der Stimme (kiAktion)', () => {
  it('Stimmgewicht: ×1 trägt allein, ×0,5 braucht einen Indikator, ×0,25 schweigt, >1 überrollt nichts', () => {
    expect(kiStimmGewicht(2, 1)).toBe(2);
    expect(kiStimmGewicht(2, 0.5)).toBe(1);
    expect(kiStimmGewicht(2, 0.25)).toBe(0);
    expect(kiStimmGewicht(2, 2)).toBe(2);
    expect(kiStimmGewicht(3, 0.75)).toBe(2);
    expect(kiStimmGewicht(2, Number.NaN)).toBe(2);
  });
  it('Probegröße × Gewicht, nie über 1, nie unter 0,25; Bestätigungen bleiben 1', () => {
    expect(kiGroessenFaktor('hold', 'buy')).toBe(KI_PROBE_FAKTOR);
    expect(kiGroessenFaktor('hold', 'buy', 2)).toBe(1);
    expect(kiGroessenFaktor('hold', 'buy', 3)).toBe(1); // Deckel: nie über die volle Größe, auch bei absurdem Faktor
    expect(kiGroessenFaktor('hold', 'buy', 0.25)).toBe(0.25);
    expect(kiGroessenFaktor('hold', 'buy', 0.6)).toBe(0.3);
    expect(kiGroessenFaktor('buy', 'buy', 2)).toBe(1);
    expect(kiGroessenFaktor('buy', 'buy', 0.25)).toBe(1);
  });
});

describe('Untätigkeits-Alarm', () => {
  it('Lage über zwei Handelstage ohne eine einzige Aktion → Alarm; sonst nicht', () => {
    expect(KI_WIRKUNG_LAGE_MIN).toBe(12);
    const ruhig = [{ tag: '2026-10-06', lageScans: 8, aktionen: 0 }, { tag: '2026-10-07', lageScans: 6, aktionen: 0 }];
    expect(bewerteKiWirkung(ruhig).ok).toBe(false);
    expect(bewerteKiWirkung([{ tag: '2026-10-06', lageScans: 8, aktionen: 0 }, { tag: '2026-10-07', lageScans: 6, aktionen: 1 }]).ok).toBe(true);
    expect(bewerteKiWirkung([{ tag: '2026-10-06', lageScans: 5, aktionen: 0 }, { tag: '2026-10-07', lageScans: 6, aktionen: 0 }]).ok).toBe(true);
    expect(bewerteKiWirkung([{ tag: '2026-10-07', lageScans: 60, aktionen: 0 }]).ok).toBe(true); // ein Tag reicht nicht
  });
  it('nur die jüngsten zwei Tage zählen', () => {
    const alt = [
      { tag: '2026-10-01', lageScans: 60, aktionen: 0 },
      { tag: '2026-10-06', lageScans: 2, aktionen: 1 },
      { tag: '2026-10-07', lageScans: 2, aktionen: 0 },
    ];
    expect(bewerteKiWirkung(alt).ok).toBe(true);
  });
});

describe('Wochenbericht', () => {
  it('ISO-Woche in New York', () => {
    expect(isoWocheEt(Date.parse('2026-10-09T20:45:00Z'))).toBe('2026-W41');
    expect(isoWocheEt(Date.parse('2026-01-01T12:00:00Z'))).toBe('2026-W01'); // Do → Woche 1
    expect(isoWocheEt(Date.parse('2027-01-01T12:00:00Z'))).toBe('2026-W53'); // Fr → letzte Woche des Vorjahres
  });
  it('Text trägt nur Summen, kennt den Zustand unter der Mindestzahl', () => {
    const t = wochenNachricht('2026-W41', { n: 5, treffer: 3, nettoSum: 2.5 }, { n: 9, treffer: 4, nettoSum: -1 }, 1);
    expect(t).toContain('5 Fälle, Trefferquote 60 %, Ø netto +0.50 %');
    expect(t).toContain('9 Fälle, Trefferquote 44 %, Ø netto -0.11 %');
    expect(t).toContain('×1.00 (unter 20 wirksamen Fällen bleibt es bei Stufe 2b).');
    expect(wochenNachricht('2026-W41', null, null, 1)).toContain('noch keine bewerteten Fälle');
  });
});
