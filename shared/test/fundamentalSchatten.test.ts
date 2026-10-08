/** Task 19, Teil 2c: Fundamental-Schatten — pure Beurteilung und Tagesaggregat. */
import { describe, expect, it } from 'vitest';
import {
  DOLLARVOL_MIN_USD,
  GEWINNTERMIN_SPERRTAGE,
  MARKTKAP_MIN_MIO,
  fundamentalBefund,
  fundamentalSchattenTag,
  tageBis,
} from '../src/fundamentalSchatten.js';

describe('fundamentalBefund', () => {
  const heute = '2026-10-08';

  it('Gewinntermin: nah bei 0…SPERRTAGE Kalendertagen, sonst nicht; vergangener Termin = veraltet = keine Aussage', () => {
    expect(fundamentalBefund({ gewinntermin: '2026-10-08' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 0, gewinnterminNah: true });
    expect(fundamentalBefund({ gewinntermin: '2026-10-10' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 2, gewinnterminNah: true });
    expect(fundamentalBefund({ gewinntermin: '2026-10-11' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 3, gewinnterminNah: false });
    expect(fundamentalBefund({ gewinntermin: '2026-10-07' }, null, 10, heute)).toMatchObject({ tageBisZahlen: null, gewinnterminNah: false });
    expect(fundamentalBefund({ gewinntermin: null }, null, 10, heute)).toMatchObject({ tageBisZahlen: null, gewinnterminNah: false });
    expect(fundamentalBefund({ gewinntermin: 'bald' }, null, 10, 'heute')).toMatchObject({ tageBisZahlen: null });
    expect(GEWINNTERMIN_SPERRTAGE).toBe(2);
    expect(tageBis('2026-10-31', '2026-11-01')).toBe(1); // Monatsgrenze, DST-frei (UTC-Mitternacht)
  });

  it('Tag 0 (Red-Team N1): vor Eröffnung veröffentlicht = schon draußen, zählt nicht; nach Schluss oder unbekannt zählt', () => {
    expect(fundamentalBefund({ gewinntermin: '2026-10-08', gewinnterminZeit: 'bmo' }, null, 10, heute)).toMatchObject({ tageBisZahlen: 0, gewinnterminNah: false, gewinnterminZeit: 'bmo' });
    expect(fundamentalBefund({ gewinntermin: '2026-10-08', gewinnterminZeit: 'amc' }, null, 10, heute).gewinnterminNah).toBe(true);
    expect(fundamentalBefund({ gewinntermin: '2026-10-08', gewinnterminZeit: null }, null, 10, heute).gewinnterminNah).toBe(true);
    // Morgen bmo ist morgen früh — heute einsteigen heißt vor den Zahlen.
    expect(fundamentalBefund({ gewinntermin: '2026-10-09', gewinnterminZeit: 'bmo' }, null, 10, heute).gewinnterminNah).toBe(true);
  });

  it('Liquidität: Ø-Volumen × Kurs; fehlt eins davon, ist nichts messbar (nicht „illiquide")', () => {
    expect(fundamentalBefund(null, { volDurchschnitt3M: 100_000 }, 15, heute)).toMatchObject({ dollarVolUsd: 1_500_000, illiquide: true });
    expect(fundamentalBefund(null, { volDurchschnitt3M: 100_000 }, 25, heute)).toMatchObject({ dollarVolUsd: 2_500_000, illiquide: false });
    expect(fundamentalBefund(null, { volDurchschnitt3M: null }, 25, heute)).toMatchObject({ dollarVolUsd: null, illiquide: false });
    expect(fundamentalBefund(null, { volDurchschnitt3M: 100_000 }, 0, heute)).toMatchObject({ dollarVolUsd: null, illiquide: false });
    expect(fundamentalBefund(null, null, null, heute)).toMatchObject({ profilVorhanden: false, dollarVolUsd: null, illiquide: false, kleinstwert: false });
    expect(DOLLARVOL_MIN_USD).toBe(2_000_000);
  });

  it('Kleinstwert: Marktkap unter der Schwelle; 0/null = unbekannt', () => {
    expect(fundamentalBefund({ marktkapMio: 14.5 }, null, 1, heute)).toMatchObject({ profilVorhanden: true, kleinstwert: true });
    expect(fundamentalBefund({ marktkapMio: MARKTKAP_MIN_MIO }, null, 1, heute).kleinstwert).toBe(false);
    expect(fundamentalBefund({ marktkapMio: null }, null, 1, heute).kleinstwert).toBe(false);
    expect(fundamentalBefund({}, null, 1, heute).profilVorhanden).toBe(true);
  });
});

describe('fundamentalSchattenTag (Tagesaggregat im Herzschlag)', () => {
  const heute = '2026-10-08';
  const us = (p: Parameters<typeof fundamentalBefund>[0], k: Parameters<typeof fundamentalBefund>[1] = null) => ({ klasse: 'stocks_us', befund: fundamentalBefund(p, k, 50, heute) });
  const zaehler = { gewinntermin_wuerde_blocken: 3, illiquide_wuerde_blocken: 1, kleinstwert_wuerde_blocken: 0 };

  it('ohne US-Aktien im Scan: null — das Feld bleibt unverändert (Red-Team H1: der Krypto-Scan um 18:20 ET überschreibt nichts)', () => {
    const krypto = [{ klasse: 'crypto', befund: fundamentalBefund(null, { volDurchschnitt3M: 1 }, 1, heute) }, { klasse: 'forex', befund: null }];
    expect(fundamentalSchattenTag({ tag: heute, scans: 4, gewinnterminNah: 7 }, krypto, zaehler, heute, 'T')).toBeNull();
    expect(fundamentalSchattenTag(null, [], zaehler, heute, 'T')).toBeNull();
  });

  it('Deckung zählt NUR Profil-Klassen (Red-Team M5); messbarer Gewinntermin getrennt von „mit Profil"', () => {
    const eintraege = [
      us({ marktkapMio: 10, gewinntermin: '2026-10-30' }, { volDurchschnitt3M: 1000 }),
      us({ marktkapMio: 10, gewinntermin: '2026-09-01' }), // veraltet: Profil ja, Termin nicht messbar
      us(null, { volDurchschnitt3M: 1000 }),
      { klasse: 'crypto', befund: fundamentalBefund(null, { volDurchschnitt3M: 1 }, 1, heute) },
      { klasse: 'indices', befund: null },
    ];
    expect(fundamentalSchattenTag(null, eintraege, zaehler, heute, 'T1')).toEqual({
      tag: heute, scans: 1, at: 'T1', usAktien: 3, mitProfil: 2, gewinnterminMessbar: 1, mitVolumen: 2,
      gewinnterminNah: 3, illiquide: 1, kleinstwert: 0,
      parameter: { sperrtage: 2, dollarVolMinUsd: 2_000_000, marktkapMinMio: 300 },
    });
  });

  it('gleicher ET-Tag summiert die Zähler und zählt den Scan; Deckung ist die des letzten Scans; neuer Tag beginnt frisch', () => {
    const eintraege = [us({ marktkapMio: 10 })];
    const s1 = fundamentalSchattenTag(null, eintraege, zaehler, heute, 'T1')!;
    const s2 = fundamentalSchattenTag(s1, [us({ marktkapMio: 10 }), us(null)], { gewinntermin_wuerde_blocken: 2, illiquide_wuerde_blocken: 0, kleinstwert_wuerde_blocken: 5 }, heute, 'T2')!;
    expect(s2).toMatchObject({ scans: 2, at: 'T2', usAktien: 2, mitProfil: 1, gewinnterminNah: 5, illiquide: 1, kleinstwert: 5 });
    const s3 = fundamentalSchattenTag(s2, eintraege, zaehler, '2026-10-09', 'T3')!;
    expect(s3).toMatchObject({ tag: '2026-10-09', scans: 1, gewinnterminNah: 3, illiquide: 1, kleinstwert: 0 });
    // Kaputter Vorbestand (Nicht-Zahlen) wird als 0 gelesen, nie NaN.
    expect(fundamentalSchattenTag({ tag: heute, scans: 'x' as never, gewinnterminNah: Number.NaN }, eintraege, zaehler, heute, 'T')).toMatchObject({ scans: 1, gewinnterminNah: 3 });
  });
});
