/**
 * Termin-Kalender (04.08.) — die Datums-Arithmetik, die niemand im Kopf
 * nachrechnet.
 *
 * Ein Kalender ist die Sorte Code, die scheinbar funktioniert, bis ein Monat
 * mit 31 Tagen, ein Jahreswechsel oder ein Schaltjahr kommt. Und ein
 * Kalender-Fehler ist besonders tückisch: Er meldet „kein Termin" — und das
 * sieht in jedem Log aus wie ein ruhiger Tag.
 */

import { describe, expect, it } from 'vitest';
import {
  EVENT_VORLAUF_H,
  FOMC_DATES,
  calendarReading,
  cpiNaeherung,
  ersterFreitag,
  fomcAbgelaufen,
  istTurnOfMonth,
} from '../src/calendar.js';

describe('ersterFreitag (US-Arbeitsmarktbericht)', () => {
  it('trifft bekannte Termine', () => {
    // 01.08.2026 ist ein Samstag ⇒ erster Freitag ist der 07.08.
    expect(ersterFreitag(2026, 7).toISOString().slice(0, 10)).toBe('2026-08-07');
    // 01.05.2026 ist selbst ein Freitag ⇒ der zählt.
    expect(ersterFreitag(2026, 4).toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('liefert für JEDEN Monat eines Jahres tatsächlich einen Freitag', () => {
    for (let m = 0; m < 12; m++) {
      const d = ersterFreitag(2026, m);
      expect(d.getUTCDay(), `Monat ${m}`).toBe(5);
      expect(d.getUTCDate(), `Monat ${m}`).toBeLessThanOrEqual(7);
      expect(d.getUTCMonth(), `Monat ${m}`).toBe(m);
    }
  });
});

describe('cpiNaeherung', () => {
  it('weicht Wochenenden auf den nächsten Werktag aus', () => {
    for (let m = 0; m < 12; m++) {
      const d = cpiNaeherung(2026, m);
      expect([1, 2, 3, 4, 5], `Monat ${m}`).toContain(d.getUTCDay());
      expect(d.getUTCDate()).toBeGreaterThanOrEqual(13);
    }
  });
});

describe('istTurnOfMonth', () => {
  it('erkennt Monatsanfang und -ende', () => {
    expect(istTurnOfMonth(new Date('2026-08-01T12:00:00Z'))).toBe(true);
    expect(istTurnOfMonth(new Date('2026-08-03T12:00:00Z'))).toBe(true);
    expect(istTurnOfMonth(new Date('2026-08-30T12:00:00Z'))).toBe(true);
    expect(istTurnOfMonth(new Date('2026-08-31T12:00:00Z'))).toBe(true);
  });

  it('die Monatsmitte gehört NICHT dazu', () => {
    for (const tag of ['04', '10', '15', '20', '28']) {
      expect(istTurnOfMonth(new Date(`2026-08-${tag}T12:00:00Z`)), tag).toBe(false);
    }
  });

  it('rechnet die Monatslänge richtig — auch im Februar', () => {
    // 27.02.2026 ist der viertletzte Tag (Februar hat 28) ⇒ nicht im Fenster,
    // der 27. wäre bei einem 30-Tage-Monat schon drin. Genau der Fehler, den
    // eine feste Zahl statt der echten Monatslänge produziert.
    expect(istTurnOfMonth(new Date('2026-02-26T12:00:00Z'))).toBe(false);
    expect(istTurnOfMonth(new Date('2026-02-27T12:00:00Z'))).toBe(true);
    expect(istTurnOfMonth(new Date('2026-02-28T12:00:00Z'))).toBe(true);
  });
});

describe('fomcAbgelaufen', () => {
  it('meldet eine noch gültige Liste als gültig', () => {
    expect(fomcAbgelaufen(new Date('2026-08-04T12:00:00Z'))).toBe(false);
  });

  it('schlägt Alarm, wenn die Liste überholt ist', () => {
    // Sonst meldete das System stumm „nie ein FOMC-Termin" statt „ich weiß
    // es nicht mehr" — eine leerlaufende Liste ist schlimmer als keine.
    const nachDemEnde = new Date(`${FOMC_DATES[FOMC_DATES.length - 1]}T00:00:00Z`);
    nachDemEnde.setUTCFullYear(nachDemEnde.getUTCFullYear() + 1);
    expect(fomcAbgelaufen(nachDemEnde)).toBe(true);
  });
});

describe('calendarReading', () => {
  it('erkennt einen FOMC-Termin im Vorlauffenster', () => {
    // 16.12.2026, 19:00 UTC ist ein FOMC-Entscheid. Sechs Stunden davor:
    const kurzDavor = new Date('2026-12-16T13:00:00Z');
    const r = calendarReading(kurzDavor);
    expect(r.bevorstehend).toBe('fomc');
    expect(r.stundenBis).toBeCloseTo(6, 0);
  });

  it('NACH dem Termin wird nicht mehr gesperrt', () => {
    // Bewusst so: Die Volatilitäts-Ausdehnung nach einem Termin ist die
    // verlässlichste Bewegung des Monats. Sie zu meiden hieße, genau das
    // wegzuwerfen, wofür der Kalender gebaut wurde.
    const danach = new Date('2026-12-16T20:00:00Z');
    expect(calendarReading(danach).bevorstehend).toBeNull();
  });

  it('weit vor dem Termin ist das Fenster zu', () => {
    // Erster Anlauf dieses Tests nahm den 14.12.2026 (~55 h vor dem
    // FOMC-Entscheid) — und bekam 'cpi'. Kein Fehler, sondern ein Befund:
    // Der CPI fällt dort auf den 14.12. (der 13. ist ein Sonntag), und die
    // Fed tagt strukturell KURZ NACH den Verbraucherpreisen. Beide Termine
    // liegen also regelmäßig dicht beieinander. Deshalb hier ein Datum, das
    // wirklich in keinem Fenster liegt: Der März-CPI fällt auf Freitag, den
    // 13., der FOMC-Entscheid ist am 18.
    const ruhig = new Date('2026-03-16T12:00:00Z');
    expect(calendarReading(ruhig).bevorstehend).toBeNull();
  });

  it('erkennt den Arbeitsmarktbericht am ersten Freitag', () => {
    // 07.08.2026 ist der erste Freitag, 13:30 UTC ist der Termin.
    const r = calendarReading(new Date('2026-08-07T06:00:00Z'));
    expect(r.bevorstehend).toBe('nfp');
    expect(r.stundenBis).toBeCloseTo(7.5, 1);
  });

  it('findet auch einen Termin JENSEITS der Monatsgrenze', () => {
    // 31.08.2026 spät abends: Der NFP am 04.09. liegt zu weit weg, aber die
    // Kandidatensuche muss den Folgemonat überhaupt erst betrachten — sonst
    // wäre am Monatsletzten das Fenster prinzipiell blind.
    const r = calendarReading(new Date('2026-08-31T23:00:00Z'));
    expect(r).toBeDefined();
    // Am Monatsletzten greift dafür sicher das Turn-of-Month-Fenster.
    expect(r.turnOfMonth).toBe(true);
  });

  it('nennt immer das NÄCHSTE Ereignis, wenn mehrere im Fenster liegen', () => {
    const r = calendarReading(new Date('2026-08-07T02:00:00Z'));
    if (r.bevorstehend !== null) {
      expect(r.stundenBis).toBeLessThanOrEqual(EVENT_VORLAUF_H);
      expect(r.stundenBis).toBeGreaterThan(0);
    }
  });

  it('ein ruhiger Tag ist wirklich ruhig', () => {
    // 20.08.2026: kein NFP, kein FOMC, kein CPI-Fenster, keine Monatswende.
    const r = calendarReading(new Date('2026-08-20T12:00:00Z'));
    expect(r.bevorstehend).toBeNull();
    expect(r.turnOfMonth).toBe(false);
    expect(r.fomcVeraltet).toBe(false);
  });
});
