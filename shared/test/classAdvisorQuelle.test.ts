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
  berateKlassen,
  ergebnisseFuerQuelle,
  rateKlasse,
  reglerSchritt,
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
    // Gesamtbestand: 40 Trades aus 2 Konten zählen als 20 — Kopien desselben Signals sind kein zweiter Beleg.
    expect(e['stocks_us']).toEqual({ n: 8, kantePct: 0.35, global: { n: 20, kantePct: null, konten: 2 } });
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

  it('… und auf dem Gesamtbestand, sobald genug UNABHÄNGIGE Trades der Umkehr dahinterstehen', () => {
    // Je Konto GLOBAL_MIN_TRADES Trades ⇒ die Stichprobe (n / konten) erreicht die Schwelle.
    const g = { stocks_us: { quellen: { umkehr: { n: GLOBAL_MIN_TRADES * MIN_ACCOUNTS, kantePct: -0.6, konten: MIN_ACCOUNTS } } } };
    const rat = rateKlasse('stocks_us', ergebnisseFuerQuelle('umkehr', undefined, g)['stocks_us']!, 0.5);
    expect(rat.empfehlung).toBe('abschalten');
    expect(rat.quelle).toBe('global');
    // Unter der Konten-Schwelle trägt der Gesamtbestand nichts.
    const zuWenig = { stocks_us: { quellen: { umkehr: { n: 500, kantePct: -0.6, konten: MIN_ACCOUNTS - 1 } } } };
    expect(rateKlasse('stocks_us', ergebnisseFuerQuelle('umkehr', undefined, zuWenig)['stocks_us']!, 0.5).empfehlung).toBe('zu_wenig_daten');
  });

  it('Kopien zählen nicht: der Stand vom 20.11. (24 Trades, 4 Konten, −0,93 %) ist kein Urteil — in keine Richtung', () => {
    const stand = { stocks_us: { quellen: { umkehr: { n: 24, kantePct: -0.9264, konten: 4 } } } };
    const e = ergebnisseFuerQuelle('umkehr', undefined, stand)['stocks_us']!;
    expect(e.global).toEqual({ n: 6, kantePct: -0.9264, konten: 4 });
    // Läuft die Klasse, bleibt sie; ist sie aus, bleibt sie aus. Kein Zurückholen ohne positiven Beleg.
    for (const w of [0, 0.5, 1]) expect(reglerSchritt(rateKlasse('stocks_us', e, w))).toBe(w);
    // Auch 50 ROHE Trades aus 7 Konten (≈ 7 Signale) reichen nicht — vorher wäre das ein endgültiges Aus gewesen.
    const roh50 = { stocks_us: { quellen: { umkehr: { n: GLOBAL_MIN_TRADES, kantePct: -0.6, konten: 7 } } } };
    expect(rateKlasse('stocks_us', ergebnisseFuerQuelle('umkehr', undefined, roh50)['stocks_us']!, 1).empfehlung).toBe('zu_wenig_daten');
  });

  it('eine abgeschaltete Klasse kommt nur auf POSITIVEM Umkehr-Beleg zurück — in Schritten, wie immer', () => {
    const gut = { stocks_us: { quellen: { umkehr: { n: GLOBAL_MIN_TRADES * 4, kantePct: 0.4, konten: 4 } } } };
    const rat = rateKlasse('stocks_us', ergebnisseFuerQuelle('umkehr', undefined, gut)['stocks_us']!, 0);
    expect(rat.empfehlung).toBe('verstaerken');
    expect(reglerSchritt(rat)).toBe(0.25);
  });

  it('berateKlassen läuft auf den Umkehr-Belegen ohne Sonderweg', () => {
    const b = berateKlassen(ergebnisseFuerQuelle('umkehr', EIGEN, GLOBAL), { stocks_us: 0.5, crypto: 0 });
    expect(b.raete.map((r) => r.empfehlung)).toEqual(['zu_wenig_daten', 'zu_wenig_daten']);
    expect(b.aenderungen).toBe(0);
  });
});
