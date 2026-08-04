/**
 * Tests der Währungsumrechnung.
 *
 * Zwei Fehler wären hier teuer und beide unauffällig:
 *   1. Der gekippte Kurs (Kehrwert) — verschiebt jedes Ergebnis um Faktor
 *      ~1,18 statt es leicht zu verzerren, sieht aber wie eine plausible
 *      Zahl aus.
 *   2. Ein Kurs aus der Zukunft — Lookahead in Euro, derselbe Fehler wie in
 *      der Prognose-Auswertung.
 */

import { describe, expect, it } from 'vitest';
import {
  FX_MAX_RUECKGRIFF_TAGE,
  brauchtUmrechnung,
  eurBetrag,
  fxTagFuer,
  leseFxAntwort,
  nachEur,
} from '../src/fx.js';

describe('nachEur — die Richtung des Kurses', () => {
  it('teilt durch den Kurs, statt zu multiplizieren', () => {
    // 1 EUR = 1,10 USD ⇒ 1.100 USD sind 1.000 EUR. Wer multipliziert,
    // bekommt 1.210 — plausibel aussehend und um 21 % falsch.
    expect(nachEur(1100, 1.1)).toBe(1000);
  });

  it('rundet auf Cent', () => {
    expect(nachEur(1000, 1.1)).toBe(909.09);
  });

  it('gibt NaN statt einer erfundenen Zahl bei unsinnigem Kurs', () => {
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isNaN(nachEur(100, r))).toBe(true);
    }
  });
});

describe('Der Fall, wegen dem es diese Datei gibt', () => {
  it('macht aus einem Dollar-Nullsummengeschäft einen Euro-Gewinn', () => {
    // Kauf 1.000 $ bei 1,10 · Verkauf 1.000 $ bei 1,05. In Dollar ±0, in
    // Euro +43,29 — und genau der ist steuerpflichtig. Wer erst das
    // Ergebnis umrechnet, erklärt null.
    const einstand = nachEur(1000, 1.1);
    const erloes = nachEur(1000, 1.05);
    expect(einstand).toBe(909.09);
    expect(erloes).toBe(952.38);
    expect(Math.round((erloes - einstand) * 100) / 100).toBe(43.29);
  });

  it('zeigt, was die unzulässige Rechnung ergäbe', () => {
    // Zur Dokumentation des Unterschieds: Ergebnis (0 $) umgerechnet bleibt
    // 0 € — unabhängig davon, welchen Kurs man nimmt.
    expect(nachEur(0, 1.05)).toBe(0);
  });
});

describe('fxTagFuer — nie in die Zukunft greifen', () => {
  const tage = ['2026-08-03', '2026-07-31', '2026-07-30'];

  it('nimmt den Tag selbst, wenn es ihn gibt', () => {
    expect(fxTagFuer('2026-07-31', tage)).toBe('2026-07-31');
  });

  it('greift auf den letzten veröffentlichten Tag zurück', () => {
    // Sonntag, 02.08. — die EZB veröffentlicht nicht, Krypto handelt.
    expect(fxTagFuer('2026-08-02', tage)).toBe('2026-07-31');
  });

  it('nimmt NIEMALS einen späteren Kurs', () => {
    // Der 03.08. läge nach dem Handelstag. Ein Kurs von morgen ist
    // Lookahead — derselbe Fehler wie in der Prognose-Auswertung.
    expect(fxTagFuer('2026-08-01', tage)).toBe('2026-07-31');
    expect(fxTagFuer('2026-07-29', tage)).toBeNull();
  });

  it('gibt auf, statt zu weit zurückzugreifen', () => {
    expect(fxTagFuer('2026-08-20', tage)).toBeNull();
    // Genau an der Grenze (7 Tage) noch gültig, einen Tag darüber nicht mehr.
    expect(fxTagFuer('2026-08-10', ['2026-08-03'], FX_MAX_RUECKGRIFF_TAGE)).toBe('2026-08-03');
    expect(fxTagFuer('2026-08-11', ['2026-08-03'], FX_MAX_RUECKGRIFF_TAGE)).toBeNull();
  });

  it('verträgt kaputte Datumsangaben', () => {
    expect(fxTagFuer('gestern', tage)).toBeNull();
    expect(fxTagFuer('2026-08-03', ['irgendwas'])).toBeNull();
  });

  it('deckt die Weihnachtslücke ab', () => {
    // 24.12. bis 02.01. ist die längste Lücke im EZB-Kalender.
    expect(FX_MAX_RUECKGRIFF_TAGE).toBeGreaterThanOrEqual(7);
  });
});

describe('eurBetrag', () => {
  const kurs = { date: '2026-08-03', rate: 1.1, source: 'ecb' };

  it('rechnet Fremdwährung um', () => {
    expect(eurBetrag(1100, 'USD', kurs)).toBe(1000);
  });

  it('lässt Euro-Beträge unangetastet — auch ohne Kurs', () => {
    expect(eurBetrag(1000, 'EUR', null)).toBe(1000);
    expect(eurBetrag(1000, 'eur', null)).toBe(1000);
  });

  it('behandelt eine fehlende Währung als USD', () => {
    expect(brauchtUmrechnung(undefined)).toBe(true);
    expect(eurBetrag(1100, undefined, kurs)).toBe(1000);
  });

  it('gibt null statt einer Schätzung, wenn der Kurs fehlt', () => {
    // Ein erfundener Kurs sieht in der Ausgabe aus wie ein echter. Eine
    // fehlende Zahl fällt auf und wird nachgetragen.
    expect(eurBetrag(1100, 'USD', null)).toBeNull();
    expect(eurBetrag(1100, 'USD', { date: 'x', rate: 0, source: 'ecb' })).toBeNull();
  });
});

describe('leseFxAntwort', () => {
  it('liest eine wohlgeformte Antwort', () => {
    expect(leseFxAntwort({ date: '2026-08-03', rates: { USD: 1.0854 } })).toEqual({
      date: '2026-08-03',
      rate: 1.0854,
      source: 'ecb',
    });
  });

  it('verwirft alles Unvollständige, statt zu raten', () => {
    for (const roh of [
      null,
      'text',
      { rates: { USD: 1.1 } },
      { date: '03.08.2026', rates: { USD: 1.1 } },
      { date: '2026-08-03' },
      { date: '2026-08-03', rates: {} },
      { date: '2026-08-03', rates: { USD: 0 } },
      { date: '2026-08-03', rates: { USD: '1.1' } },
    ]) {
      expect(leseFxAntwort(roh)).toBeNull();
    }
  });

  it('holt auch andere Währungen', () => {
    expect(leseFxAntwort({ date: '2026-08-03', rates: { CHF: 0.95 } }, 'CHF')?.rate).toBe(0.95);
  });
});
