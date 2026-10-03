/**
 * Totmann-Wächter (Audit 13.08., K-4a).
 *
 * Der historische Fall steht als erster Test: Der Scheduler-Job fehlte
 * wochenlang, und nichts schlug an. Jede Regel hier ist gegen genau die
 * Ausfalltypen geschrieben, die von außen wie ein ruhiger Markt aussehen.
 */
import { describe, expect, it } from 'vitest';

import {
  bewerteHerzschlag,
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
