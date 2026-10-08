/**
 * Totmann-Wächter (Audit 13.08., K-4a).
 *
 * Der historische Fall steht als erster Test: Der Scheduler-Job fehlte
 * wochenlang, und nichts schlug an. Jede Regel hier ist gegen genau die
 * Ausfalltypen geschrieben, die von außen wie ein ruhiger Markt aussehen.
 */
import { describe, expect, it } from 'vitest';

import {
  bewerteAktivitaet,
  bewerteFillSync,
  bewerteHerzschlag,
  bewerteNachrichten,
  naechsterAktivitaetsZustand,
  naechsterAlarm,
  KURSQUELLE_MIN_FEHLER,
  SCAN_TOT_MIN,
  type AlarmZustand,
} from '../src/wachhund.js';

const T0 = Date.parse('2026-08-13T06:00:00.000Z');
const vor = (min: number): string => new Date(T0 - min * 60_000).toISOString();

describe('bewerteHerzschlag', () => {
  it('meldet den historischen Fall: gar kein Heartbeat', () => {
    // Wochenlang kein Scheduler-Job — meta/health existiert, aber ohne
    // lastRunAt (oder das Doc fehlt ganz und der Aufrufer reicht undefined).
    const u = bewerteHerzschlag({ jetztMs: T0 });
    expect(u.ok).toBe(false);
    expect(u.grund).toBe('kein_heartbeat');
    expect(u.text).toContain('Scheduler');
  });

  it('meldet kaputte Zeitstempel wie fehlende', () => {
    const u = bewerteHerzschlag({ jetztMs: T0, lastRunAt: 'kaputt' });
    expect(u.grund).toBe('kein_heartbeat');
  });

  it('schlägt an, wenn der Scan länger als die Schwelle steht', () => {
    const u = bewerteHerzschlag({ jetztMs: T0, lastRunAt: vor(SCAN_TOT_MIN + 1) });
    expect(u.ok).toBe(false);
    expect(u.grund).toBe('scan_steht');
    expect(u.minutenAlt).toBe(SCAN_TOT_MIN + 1);
    // Der Satz muss sagen, was auf dem Spiel steht — nicht nur „ist alt".
    expect(u.text).toContain('Stops');
  });

  it('toleriert genau die Schwelle — vier verpasste Läufe, nicht drei', () => {
    // Ein langsamer Lauf oder ein Deploy-Fenster darf keinen Alarm werfen.
    const u = bewerteHerzschlag({ jetztMs: T0, lastRunAt: vor(SCAN_TOT_MIN) });
    expect(u.ok).toBe(true);
  });

  it('meldet die gestörte Kursquelle: Lauf ja, Kurse nein', () => {
    // Das Yahoo-Bann-Szenario: der Scan LÄUFT, aber kein Symbol liefert.
    // Ohne diese Regel sähe der Wächter nur den frischen Heartbeat.
    const u = bewerteHerzschlag({
      jetztMs: T0,
      lastRunAt: vor(2),
      lastRunSkipped: null,
      symbolsOk: 0,
      symbolsFailed: KURSQUELLE_MIN_FEHLER,
    });
    expect(u.ok).toBe(false);
    expect(u.grund).toBe('kursquelle_gestoert');
  });

  it('alarmiert NICHT auf alten Symbol-Zahlen nach einem Skip-Lauf', () => {
    // Skip-Läufe schreiben symbolsOk/symbolsFailed nicht neu — die Werte
    // stammen vom letzten vollen Lauf. Auf ihnen zu alarmieren wäre ein
    // Fehlalarm am Wochenende.
    const u = bewerteHerzschlag({
      jetztMs: T0,
      lastRunAt: vor(2),
      lastRunSkipped: 'market_closed',
      symbolsOk: 0,
      symbolsFailed: 40,
    });
    expect(u.ok).toBe(true);
  });

  it('lässt Einzel-Ausfälle durch — erst NULL Kurse bei genug Fehlern zählen', () => {
    expect(
      bewerteHerzschlag({
        jetztMs: T0,
        lastRunAt: vor(2),
        lastRunSkipped: null,
        symbolsOk: 35,
        symbolsFailed: 5,
      }).ok,
    ).toBe(true);
    expect(
      bewerteHerzschlag({
        jetztMs: T0,
        lastRunAt: vor(2),
        lastRunSkipped: null,
        symbolsOk: 0,
        symbolsFailed: KURSQUELLE_MIN_FEHLER - 1,
      }).ok,
    ).toBe(true);
  });
});

describe('naechsterAlarm', () => {
  const jetzt = new Date(T0).toISOString();

  it('startet einen neuen Alarm mit seit=jetzt', () => {
    const a = naechsterAlarm(undefined, { ok: false, grund: 'scan_steht', text: 't' }, jetzt);
    expect(a.aktiv).toBe(true);
    expect(a.seit).toBe(jetzt);
  });

  it('behält seit, solange derselbe Grund anhält', () => {
    // „Alarm seit 04:32" ist die Information beim Aufwachen — ein seit,
    // das je Tick weiterspringt, wäre wertlos.
    const alt: AlarmZustand = {
      aktiv: true,
      grund: 'scan_steht',
      text: 't',
      seit: vor(120),
      at: vor(10),
    };
    const a = naechsterAlarm(alt, { ok: false, grund: 'scan_steht', text: 't2' }, jetzt);
    expect(a.seit).toBe(vor(120));
    expect(a.at).toBe(jetzt);
  });

  it('setzt seit neu, wenn der Grund wechselt — das ist ein NEUER Alarm', () => {
    const alt: AlarmZustand = {
      aktiv: true,
      grund: 'scan_steht',
      text: 't',
      seit: vor(120),
      at: vor(10),
    };
    const a = naechsterAlarm(alt, { ok: false, grund: 'kursquelle_gestoert', text: 't' }, jetzt);
    expect(a.seit).toBe(jetzt);
  });

  it('löst den Alarm bei Erholung auf statt ihn stehen zu lassen', () => {
    const alt: AlarmZustand = {
      aktiv: true,
      grund: 'scan_steht',
      text: 't',
      seit: vor(120),
      at: vor(10),
    };
    const a = naechsterAlarm(alt, { ok: true, text: 'Letzter Lauf vor 3 min.' }, jetzt);
    expect(a.aktiv).toBe(false);
    expect(a.grund).toBeUndefined();
  });
});

describe('Untätigkeits-Wächter (05.10.)', () => {
  const jetztMs = Date.parse('2026-10-05T20:00:00.000Z');
  const frisch = '2026-10-05T03:00:00.000Z';

  it('Engines an, aber 7 Tage kein geschlossener Trade → Alarm', () => {
    const u = bewerteAktivitaet({ jetztMs, laufend: 7, trades7t: 0, zaehlungAt: frisch });
    expect(u.ok).toBe(false);
    expect(u.text).toContain('7 Engine(s) an');
  });
  it('Trades vorhanden → ruhig', () => {
    expect(bewerteAktivitaet({ jetztMs, laufend: 7, trades7t: 12, zaehlungAt: frisch }).ok).toBe(true);
  });
  it('keine Engine an, fehlende oder alte Zählung → kein Alarm (fehlende Daten sind kein Befund)', () => {
    expect(bewerteAktivitaet({ jetztMs, laufend: 0, trades7t: 0, zaehlungAt: frisch }).ok).toBe(true);
    expect(bewerteAktivitaet({ jetztMs, laufend: 7, trades7t: 0 }).ok).toBe(true);
    expect(bewerteAktivitaet({ jetztMs, laufend: 7, trades7t: 0, zaehlungAt: '2026-10-02T03:00:00.000Z' }).ok).toBe(true);
  });
  it('„seit" bleibt stehen, solange der Alarm anhält; Entwarnung löscht es', () => {
    const alarm = { ok: false, text: 'x' };
    const a1 = naechsterAktivitaetsZustand(undefined, alarm, '2026-10-05T10:00:00.000Z');
    const a2 = naechsterAktivitaetsZustand(a1, alarm, '2026-10-05T10:10:00.000Z');
    expect(a2.seit).toBe('2026-10-05T10:00:00.000Z');
    const a3 = naechsterAktivitaetsZustand(a2, { ok: true, text: 'ok' }, '2026-10-05T10:20:00.000Z');
    expect(a3.aktiv).toBe(false);
    expect(a3.seit).toBeUndefined();
  });
});

describe('bewerteNachrichten (KI-Kaskade Stufe 1)', () => {
  const jetzt = Date.parse('2026-10-05T14:00:00Z');
  const basis = { jetztMs: jetzt, letzterLauf: '2026-10-05T13:58:00Z', letzterErfolg: '2026-10-05T13:58:00Z' };

  it('lief noch nie: kein Urteil', () => {
    expect(bewerteNachrichten({ jetztMs: jetzt }).ok).toBe(true);
  });
  it('frisch und ohne Rückstand: läuft', () => {
    expect(bewerteNachrichten({ ...basis, rueckstandS: 120 }).ok).toBe(true);
  });
  it('ohne Schlüssel: Alarm', () => {
    expect(bewerteNachrichten({ ...basis, grund: 'keine_schluessel' }).ok).toBe(false);
  });
  it('letzter Erfolg älter als 30 min: Alarm — auch wenn Läufe dazwischen „liefen"', () => {
    const u = bewerteNachrichten({ ...basis, letzterErfolg: '2026-10-05T13:20:00Z', fehlerFolge: 8 });
    expect(u.ok).toBe(false);
    expect(u.text).toContain('seit 40 min');
  });
  it('nie erfolgreich, obwohl gelaufen: Alarm', () => {
    expect(bewerteNachrichten({ jetztMs: jetzt, letzterLauf: '2026-10-05T13:58:00Z' }).ok).toBe(false);
  });
  it('Rückstand über 2 h trotz frischer Erfolge: Alarm (stummer Stillstand)', () => {
    const u = bewerteNachrichten({ ...basis, rueckstandS: 3 * 3600 });
    expect(u.ok).toBe(false);
    expect(u.text).toContain('3 h');
  });
});

describe('bewerteFillSync — vierte Frage: läuft der Ereigniskanal?', () => {
  const jetztMs = Date.parse('2026-10-08T12:00:00Z');
  it('nie gelaufen: kein Urteil; frisch: läuft (mit Fehlerzahl im Text)', () => {
    expect(bewerteFillSync({ jetztMs }).ok).toBe(true);
    expect(bewerteFillSync({ jetztMs, at: '2026-10-08T11:50:00Z' })).toEqual({ ok: true, text: 'Ereigniskanal läuft.' });
    expect(bewerteFillSync({ jetztMs, at: '2026-10-08T11:50:00Z', fehler: 2 }).text).toContain('2 Fehler');
  });
  it('länger als FILLSYNC_STILL_MAX_MIN still: Alarm', () => {
    const u = bewerteFillSync({ jetztMs, at: '2026-10-08T11:20:00Z' });
    expect(u.ok).toBe(false);
    expect(u.text).toContain('seit 40 min nicht');
    expect(bewerteFillSync({ jetztMs, at: 'kaputt' }).ok).toBe(false);
  });
});
