/**
 * Der Klassen-Regler misst Umkehr-Konten an der Umkehr (20.11.).
 *
 * Gemessen: 18 Umkehr-Signale × 7 Konten, 6 geplante Käufe, 50 Verwürfe
 * „Klasse aus". Die Klasse war abgeschaltet auf Verlusten der alten
 * Konfluenz-Engine und des Sockels — der Regler mischte alle Einstiegswege
 * und steuerte damit eine Strategie, deren eigene Kante er nie gemessen
 * hatte.
 */
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_MIN_TRADES,
  KLASSE_MIN_TRADES,
  SCHATTEN_PROBELOS,
  berateKlassen,
  ergebnisseFuerQuelle,
  rateKlasse,
  reglerSchritt,
  umkehrKlassenZurueck,
} from '../src/classAdvisor.js';
import { MIN_ACCOUNTS } from '../src/globalLearning.js';

/** stats.byClassQuelle eines Kontos: Aktien verbrennen über Konfluenz und Sockel, die Umkehr hat erst 8 Trades. */
const EIGEN = {
  stocks_us: {
    konfluenz: { n: 300, kantePct: -0.9 },
    sockel: { n: 60, kantePct: -4.2 },
    umkehr: { n: 8, kantePct: 0.35 },
  },
  crypto: { konfluenz: { n: 44, kantePct: -0.7 } },
};
/** meta/health.trading.klassen: Kante je Quelle erst ab der Konten-Schwelle veröffentlicht. */
const GLOBAL = {
  stocks_us: {
    n: 538,
    kantePct: -1.18,
    konten: 7,
    quellen: {
      sockel: { n: 120, kantePct: -3.1, konten: 6 },
      umkehr: { n: 40, kantePct: null, konten: 2 },
    },
  },
};

describe('ergebnisseFuerQuelle', () => {
  it('nimmt nur die Zahlen der Umkehr — Konfluenz und Sockel zählen nicht', () => {
    const e = ergebnisseFuerQuelle('umkehr', EIGEN, GLOBAL);
    expect(e['stocks_us']).toEqual({ n: 8, kantePct: 0.35, global: { n: 40, kantePct: null, konten: 2 } });
    // Krypto: die Umkehr hat dort noch nie gehandelt ⇒ kein Beleg, kein erfundener.
    expect(e['crypto']).toEqual({ n: 0, kantePct: null });
  });

  it('trägt nie einen Schatten-Beleg — der misst die Konfluenz-Signale', () => {
    for (const x of Object.values(ergebnisseFuerQuelle('umkehr', EIGEN, GLOBAL))) expect(x.schatten).toBeUndefined();
  });

  it('bekannte Klassen ohne jede Zahl stehen trotzdem in der Liste', () => {
    const e = ergebnisseFuerQuelle('umkehr', undefined, undefined, ['etf_sectors']);
    expect(e).toEqual({ etf_sectors: { n: 0, kantePct: null } });
  });

  it('kaputte Zahlen werden zu „kein Beleg", nicht zu 0 % Kante', () => {
    const e = ergebnisseFuerQuelle('umkehr', { x: { umkehr: { n: 12, kantePct: Number.NaN } } }, { x: { quellen: { umkehr: { n: Number.NaN, kantePct: undefined, konten: 4 } } } });
    expect(e['x']).toEqual({ n: 12, kantePct: null, global: { n: 0, kantePct: null, konten: 4 } });
  });
});

describe('der Regler auf Umkehr-Belegen', () => {
  it('der GEMISCHTE Klassenbeleg schaltet ab — genau das geschah bis zum 20.11.', () => {
    const gemischt = rateKlasse('stocks_us', { n: 368, kantePct: -1.5, global: { n: 538, kantePct: -1.18, konten: 7 } }, 1);
    expect(gemischt.empfehlung).toBe('abschalten');
  });

  it('auf Umkehr-Belegen: zu wenig Daten ⇒ das Gewicht bleibt, wie es ist (keine Automatik ohne Beleg)', () => {
    const e = ergebnisseFuerQuelle('umkehr', EIGEN, GLOBAL);
    for (const w of [0, 0.5, 1]) {
      const rat = rateKlasse('stocks_us', e['stocks_us']!, w);
      expect(rat.empfehlung).toBe('zu_wenig_daten');
      expect(reglerSchritt(rat)).toBe(w);
    }
  });

  it('verliert die UMKEHR selbst strukturell, schaltet derselbe Regler sie ab — eigene Trades', () => {
    const e = ergebnisseFuerQuelle('umkehr', { stocks_us: { umkehr: { n: KLASSE_MIN_TRADES, kantePct: -0.6 } } }, undefined);
    const rat = rateKlasse('stocks_us', e['stocks_us']!, 0.5);
    expect(rat.empfehlung).toBe('abschalten');
    expect(rat.quelle).toBe('eigen');
    expect(reglerSchritt(rat)).toBe(0);
  });

  it('… und auf dem Gesamtbestand, sobald genug Konten und Trades der Umkehr dahinterstehen', () => {
    const g = { stocks_us: { quellen: { umkehr: { n: GLOBAL_MIN_TRADES, kantePct: -0.6, konten: MIN_ACCOUNTS } } } };
    const rat = rateKlasse('stocks_us', ergebnisseFuerQuelle('umkehr', undefined, g)['stocks_us']!, 0.5);
    expect(rat.empfehlung).toBe('abschalten');
    expect(rat.quelle).toBe('global');
    // Unter der Konten-Schwelle trägt der Gesamtbestand nichts.
    const zuWenig = { stocks_us: { quellen: { umkehr: { n: 500, kantePct: -0.6, konten: MIN_ACCOUNTS - 1 } } } };
    expect(rateKlasse('stocks_us', ergebnisseFuerQuelle('umkehr', undefined, zuWenig)['stocks_us']!, 0.5).empfehlung).toBe('zu_wenig_daten');
  });

  it('berateKlassen läuft auf den Umkehr-Belegen ohne Sonderweg', () => {
    const b = berateKlassen(ergebnisseFuerQuelle('umkehr', EIGEN, GLOBAL), { stocks_us: 0.5, crypto: 0 });
    expect(b.raete.map((r) => r.empfehlung)).toEqual(['zu_wenig_daten', 'zu_wenig_daten']);
    expect(b.aenderungen).toBe(0);
  });
});

describe('umkehrKlassenZurueck — einmalige Rückkehr', () => {
  const log = (klasse: string, nach: number, at: string) => ({ klasse, nach, at });

  it('holt zurück, was der REGLER abgeschaltet hat — mit halbem Gewicht', () => {
    const z = umkehrKlassenZurueck(
      { stocks_us: 0, etf_sectors: 0, crypto: 0.5 },
      [log('stocks_us', 0.5, '2026-09-01T22:15:00Z'), log('stocks_us', 0, '2026-10-02T22:15:00Z'), log('etf_sectors', 0, '2026-10-05T22:15:00Z')],
      true,
    );
    expect(z).toEqual([
      { klasse: 'etf_sectors', von: 0, nach: SCHATTEN_PROBELOS },
      { klasse: 'stocks_us', von: 0, nach: SCHATTEN_PROBELOS },
    ]);
  });

  it('eine von Hand gesetzte 0 bleibt: kein Journal-Eintrag, oder der jüngste endet nicht auf 0', () => {
    expect(umkehrKlassenZurueck({ crypto: 0 }, [], true)).toEqual([]);
    expect(umkehrKlassenZurueck({ crypto: 0 }, [log('stocks_us', 0, '2026-10-02T22:15:00Z')], true)).toEqual([]);
    // Regler schaltete ab, später wieder an (0,5), danach setzte der Owner die 0 selbst.
    expect(
      umkehrKlassenZurueck({ crypto: 0 }, [log('crypto', 0, '2026-09-01T22:15:00Z'), log('crypto', 0.5, '2026-10-01T22:15:00Z')], true),
    ).toEqual([]);
  });

  it('bei abgewähltem Auto-Regler wird nichts angefasst', () => {
    expect(umkehrKlassenZurueck({ stocks_us: 0 }, [log('stocks_us', 0, '2026-10-02T22:15:00Z')], false)).toEqual([]);
  });

  it('laufende Klassen und fehlende Gewichte bleiben unberührt; kaputte Journal-Zeilen zählen nicht', () => {
    expect(umkehrKlassenZurueck({ stocks_us: 0.25 }, [log('stocks_us', 0, '2026-10-02T22:15:00Z')], true)).toEqual([]);
    expect(umkehrKlassenZurueck(undefined, [log('stocks_us', 0, '2026-10-02T22:15:00Z')], true)).toEqual([]);
    const kaputt = [{ klasse: 'stocks_us', nach: 0 } as unknown as { klasse: string; nach: number; at: string }];
    expect(umkehrKlassenZurueck({ stocks_us: 0 }, kaputt, true)).toEqual([]);
  });
});
