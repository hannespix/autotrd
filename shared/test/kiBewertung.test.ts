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
  fallSchluessel,
  handelbarZurBezugszeit,
  holdoutArm,
  benchmarkPct,
  BENCHMARK_H_MAX,
  BENCHMARK_MIN_FENSTER,
  fallKennzahlen,
  KI_HOLDOUT_BUCKET,
  isoWocheEt,
  KI_GEWICHT_BUCKET,
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
  gestimmtAt: '2026-09-01T13:45:00Z',
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
  it('B1: ein Urteilskurs VOR dem ersten Sehen (Vortagsschluss nach Börsenschluss) zählt nicht — dann der Schluss danach', () => {
    const alt = urteil({ pruefung: { kurskontext: { aktuell: { p: 100.5, t: '2026-09-01T13:00:00Z' } } } }); // Trade vor firstSeenAt 13:30
    const r = bewerteUrteil(alt, schluesse, 0, '2026-09-10');
    expect(r.stand === 'bewertet' && r.einstiegQuelle === 'schluss' && r.einstieg === 102).toBe(true);
    const ohneT = urteil({ pruefung: { kurskontext: { aktuell: { p: 100.5 } } } });
    expect(bewerteUrteil(ohneT, schluesse, 0, '2026-09-10')).toMatchObject({ einstiegQuelle: 'schluss' });
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

describe('Buckets und Fälle', () => {
  it('wirksam heißt: der Scan hat TATSÄCHLICH gestimmt (gestimmtAt) — Long und Short getrennt', () => {
    expect(KI_GEWICHT_BUCKET).toBe('holdout_a'); // das Gewicht rechnet NUR aus Arm A
    expect(KI_HOLDOUT_BUCKET).toBe('holdout_b');
    // Stufe 4a: der Gewichts-Bucket bekommt zusätzlich seinen Holdout-Arm (Hash des Fallschlüssels).
    const arm = holdoutArm('AAPL|2026-09-01');
    expect(bucketsFuer(urteil())).toEqual(['gesamt', 'pruefung', 'wirksam_long', `holdout_${arm}`, 'handelbar', 'ereignis_zahlen']);
    expect(bucketsFuer(urteil({ richtung: 'negativ' }))).toEqual(['gesamt', 'pruefung', 'wirksam_short', 'handelbar', 'ereignis_zahlen']);
    // „hätte dürfen" ohne abgegebene Stimme ist Schatten
    expect(bucketsFuer(urteil({ gestimmtAt: undefined }))).toEqual(['gesamt', 'pruefung', 'schatten', 'handelbar', 'ereignis_zahlen']);
    expect(bucketsFuer(urteil({ handlungsfaehig: false, stufe: 'sichtung', gestimmtAt: null, sichtung: { ereignis: 'X Y' } }))).toEqual([
      'gesamt', 'sichtung', 'schatten', 'handelbar',
    ]);
  });
  it('Bezug außerhalb der Handelszeit → ausserhalb (Aktie 17:30 ET); Krypto ist immer handelbar', () => {
    const spaet = urteil({ firstSeenAt: '2026-09-01T21:30:00Z', decidedAt: '2026-09-01T21:40:00Z', gespeichertAt: '2026-09-01T21:41:00Z' });
    expect(handelbarZurBezugszeit(spaet)).toBe(false);
    expect(bucketsFuer(spaet)).toContain('ausserhalb');
    expect(handelbarZurBezugszeit(urteil({ symbol: 'BTC-USD', firstSeenAt: '2026-09-06T03:00:00Z', decidedAt: '2026-09-06T03:05:00Z', gespeichertAt: '2026-09-06T03:06:00Z' }))).toBe(true);
    expect(handelbarZurBezugszeit(urteil())).toBe(true); // 09:41 ET
  });
  it('ein Fall je (Symbol, Bezugstag ET) — Folgeartikel desselben Tages teilen den Schlüssel', () => {
    expect(fallSchluessel(urteil())).toBe('AAPL|2026-09-01');
    expect(fallSchluessel(urteil({ newsId: 'n2', decidedAt: '2026-09-01T19:00:00Z', gespeichertAt: '2026-09-01T19:01:00Z' }))).toBe('AAPL|2026-09-01');
    expect(fallSchluessel(urteil({ symbol: undefined }))).toBeNull();
    expect(fallSchluessel({})).toBeNull();
  });
});

describe('kiGewicht — spricht erst ab KI_MIN_FAELLE, DÄMPFT nur, lockert nie Schutz', () => {
  it('unter der Mindestzahl bleibt es bei 1, egal wie gut', () => {
    expect(KI_MIN_FAELLE).toBe(40);
    expect(kiGewicht({ n: 39, treffer: 39, nettoSum: 50 })).toBe(1);
    expect(kiGewicht(undefined)).toBe(1);
    expect(kiGewicht(null)).toBe(1);
  });
  it('Deckel 1 (Red-Team B3: ohne Benchmark und Holdout keine Verstärkung); 35 % → 0,25 (Boden)', () => {
    expect(KI_GEWICHT_MAX).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 50, nettoSum: 10 })).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 65, nettoSum: 10 })).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 80, nettoSum: 10 })).toBe(1);
    expect(kiGewicht({ n: 100, treffer: 35, nettoSum: -10 })).toBe(KI_GEWICHT_MIN);
    expect(kiGewicht({ n: 100, treffer: 10, nettoSum: -10 })).toBe(KI_GEWICHT_MIN);
    expect(kiGewicht({ n: 100, treffer: 44, nettoSum: -1 })).toBeCloseTo(0.7, 2);
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
  it('handelbare Lage über drei Handelstage ohne eine einzige Aktion → Alarm; sonst nicht', () => {
    expect(KI_WIRKUNG_LAGE_MIN).toBe(24);
    const t = (tag: string, lageScans: number, aktionen: number) => ({ tag, lageScans, aktionen });
    expect(bewerteKiWirkung([t('2026-10-05', 10, 0), t('2026-10-06', 8, 0), t('2026-10-07', 6, 0)]).ok).toBe(false);
    expect(bewerteKiWirkung([t('2026-10-05', 10, 0), t('2026-10-06', 8, 0), t('2026-10-07', 6, 1)]).ok).toBe(true);
    expect(bewerteKiWirkung([t('2026-10-05', 5, 0), t('2026-10-06', 8, 0), t('2026-10-07', 6, 0)]).ok).toBe(true); // 19 < 24
    expect(bewerteKiWirkung([t('2026-10-06', 60, 0), t('2026-10-07', 60, 0)]).ok).toBe(true); // zwei Tage reichen nicht
  });
  it('nur die jüngsten drei Tage zählen', () => {
    const alt = [
      { tag: '2026-10-01', lageScans: 60, aktionen: 0 },
      { tag: '2026-10-05', lageScans: 2, aktionen: 1 },
      { tag: '2026-10-06', lageScans: 2, aktionen: 0 },
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
    expect(t).toContain('×1.00 (unter 40 wirksamen Fällen bleibt es bei Stufe 2b).');
    expect(wochenNachricht('2026-W41', null, null, 1)).toContain('noch keine bewerteten Fälle');
  });
});

describe('Stufe 4a — Benchmark, Holdout, Kennzahlen', () => {
  const reihe = (n: number, start = '2026-06-01'): { date: string; close: number }[] => {
    const out: { date: string; close: number }[] = [];
    const d = new Date(`${start}T00:00:00Z`);
    let close = 100;
    while (out.length < n) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
        close = Math.round(close * 1.01 * 100) / 100; // +1 % je Handelstag
        out.push({ date: d.toISOString().slice(0, 10), close });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };
  it('benchmarkPct = mittlere h-Tage-Bewegung STRIKT vor dem Bezugstag; weder die Bezugstag-Kerze noch spätere zählen', () => {
    const r = reihe(80);
    const bezug = r[70]!.date;
    const b = benchmarkPct(r, bezug, 3);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(3.03, 1); // (1.01^3 − 1) × 100
    // Kerzen AB dem Bezugstag ändern NICHTS — auch nicht die des Bezugstags selbst
    // (Spike +50 %, Red-Team 4a B3: ihr Schluss liegt zur Bezugszeit nicht vor).
    const manipuliert = r.map((s) => (s.date >= bezug ? { ...s, close: s.close * 1.5 } : s));
    expect(benchmarkPct(manipuliert, bezug, 3)).toBe(b);
    // und ein Trendbruch VOR dem 60-Tage-Deckel ändert auch nichts
    const alt = r.map((s, i) => (i < 5 ? { ...s, close: s.close * 0.1 } : s));
    expect(benchmarkPct(alt, bezug, 3)).toBe(b);
  });
  it('Mindestfenster exakt: 19 → null, 20 → Zahl; h > BENCHMARK_H_MAX → null', () => {
    expect(BENCHMARK_MIN_FENSTER).toBe(20);
    expect(BENCHMARK_H_MAX).toBe(3);
    // Fenster = Kerzen vor dem Bezug − h; h=1 → 20 Kerzen vor dem Bezug ergeben 19 Fenster
    const r = reihe(40);
    const bezug19 = r[20]!.date; // 20 Kerzen davor → 19 Fenster
    const bezug20 = r[21]!.date; // 21 Kerzen davor → 20 Fenster
    expect(benchmarkPct(r, bezug19, 1)).toBeNull();
    expect(benchmarkPct(r, bezug20, 1)).not.toBeNull();
    expect(benchmarkPct(r, r[39]!.date, 4)).toBeNull(); // h=4: keine Drift-Schätzung
    expect(benchmarkPct(r, r[39]!.date, 3)).not.toBeNull();
  });
  it('bewerteUrteil trägt Markt und Über-Markt; ohne Vorlauf null', () => {
    const r = reihe(80);
    const bezugTag = r[70]!.date;
    const u = urteil({
      firstSeenAt: `${bezugTag}T14:00:00Z`, decidedAt: `${bezugTag}T14:05:00Z`, gespeichertAt: `${bezugTag}T14:06:00Z`,
      pruefung: null, horizontTage: 3,
    });
    const x = bewerteUrteil(u, r, 0.01, '2026-12-31'); // 1 % Roundtrip-Kosten: netto ≠ brutto
    expect(x.stand).toBe('bewertet');
    if (x.stand !== 'bewertet') return;
    expect(x.marktPct).toBeCloseTo(3.03, 1);
    expect(x.nettoPct).toBeCloseTo(x.bruttoPct - 1, 3);
    expect(x.ueberMarktPct).toBeCloseTo(x.nettoPct - 3.03, 2); // NETTO-Basis (B5), nicht brutto
    const y = bewerteUrteil(urteil({ pruefung: null }), schluesse, 0, '2026-09-10');
    expect(y.stand === 'bewertet' && y.marktPct === null && y.ueberMarktPct === null).toBe(true);
  });
  it('holdoutArm ist deterministisch und MISCHT: ein Symbol über 60 Tage alterniert nicht, 60 Symbole an einem Tag clustern nicht', () => {
    expect(holdoutArm('AAPL|2026-09-01')).toBe(holdoutArm('AAPL|2026-09-01'));
    // ein Symbol × 60 Tage: etwa halbe/halbe, und kein tägliches Kippen (B1)
    const tage = reihe(60).map((s) => holdoutArm(`AAPL|${s.date}`));
    const a = tage.filter((x) => x === 'a').length;
    expect(a).toBeGreaterThanOrEqual(18);
    expect(a).toBeLessThanOrEqual(42);
    let wechsel = 0;
    for (let i = 1; i < tage.length; i += 1) if (tage[i] !== tage[i - 1]) wechsel += 1;
    expect(wechsel).toBeLessThan(50); // der Paritätshash kippte 59-mal
    // 60 Symbole × ein Tag: beide Arme deutlich besetzt
    const symbole = Array.from({ length: 60 }, (_, i) => `S${String(i).padStart(3, '0')}|2026-09-01`).map(holdoutArm);
    const b = symbole.filter((x) => x === 'b').length;
    expect(b).toBeGreaterThanOrEqual(18);
    expect(b).toBeLessThanOrEqual(42);
    // Parität des Symbols entscheidet NICHT: AAPL/MSFT/TSLA (gleiche Parität im alten Hash) liegen nicht zwingend zusammen
    const probe = ['AAPL', 'MSFT', 'TSLA', 'AMZN', 'GOOG', 'BTC-USD', 'NVDA', 'META'].map((s) => holdoutArm(`${s}|2026-09-01`));
    expect(new Set(probe).size).toBe(2);
  });
  it('fallKennzahlen: Quote, Ø netto, Über-Markt-Quote — null ohne Fälle', () => {
    expect(fallKennzahlen({ n: 4, treffer: 3, nettoSum: 2, nMarkt: 2, trefferMarkt: 1 })).toEqual({ n: 4, quotePct: 75, nettoAvgPct: 0.5, ueberMarktQuotePct: 50 });
    expect(fallKennzahlen(undefined)).toEqual({ n: 0, quotePct: null, nettoAvgPct: null, ueberMarktQuotePct: null });
  });
  it('Wochenbericht nennt den Holdout und die Über-Markt-Quote', () => {
    const t = wochenNachricht('2026-W41', { n: 40, treffer: 24, nettoSum: 8, nMarkt: 30, trefferMarkt: 15 }, null, 1, { n: 20, treffer: 9, nettoSum: -1 });
    expect(t).toContain('Anteil über Symbol-Drift 50 %');
    expect(t).toContain('Arm A (steuert): 40 Fälle');
    expect(t).toContain('Holdout B (steuert nicht): 20 Fälle, Trefferquote 45 %');
  });
});
