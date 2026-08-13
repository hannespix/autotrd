/**
 * Audit-Befund 11.08.: Die Verlust-Notbremse verlor ihre Klebrigkeit an der
 * UTC-Mitternacht — also um 20:00 bzw. 19:00 New Yorker Zeit.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * `circuitBreaker.ts` sagt ausdrücklich: „Einmal ausgelöst, bleibt sie
 * ausgelöst — bis jemand sie ausdrücklich zurücksetzt." Dafür gibt es
 * `resetBreaker`, und `snapshotEquity` löscht den Marker einmal täglich um
 * 17:15 ET.
 *
 * Verglichen wurde aber gegen `now.toISOString().slice(0, 10)` — den
 * UTC-Kalendertag, während der Handelstag in New York liegt:
 *
 *   17:15 ET  snapshotEquity setzt vortagEquity, löscht den Marker.
 *   18:30 ET  Krypto-Absturz, Grenze gerissen, Einstiege gesperrt.
 *   20:00 ET  = 00:00 UTC. Der Tagesstempel springt, der Marker trägt noch
 *             den vorigen ⇒ `bereitsAusgeloest` wird false.
 *   danach    Erholt sich die Equity etwas, gibt pruefeBreaker frei.
 *
 * Das Konto handelt dann rund fünfzehn Stunden vor dem nächsten regulären
 * Reset wieder. Krypto läuft durch, der Fall ist also nicht theoretisch.
 *
 * Dass die Bremse sich am Tageswechsel selbst löst, ist gewollt. Falsch war
 * die GRENZE.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { breakerHeuteAusgeloest, handelstagET } from '../src/scheduled/scanMarket.js';

describe('handelstagET', () => {
  it('gibt den New Yorker Kalendertag', () => {
    // 18:30 ET am 11.08. ist 22:30 UTC desselben Tages.
    expect(handelstagET(new Date('2026-08-11T22:30:00Z'))).toBe('2026-08-11');
  });

  it('rollt erst um MITTERNACHT ET weiter, nicht um Mitternacht UTC', () => {
    // Sommerzeit (EDT, UTC−4): 00:00 UTC ist 20:00 ET des Vortages.
    expect(handelstagET(new Date('2026-08-12T00:00:00Z'))).toBe('2026-08-11');
    expect(handelstagET(new Date('2026-08-12T03:59:00Z'))).toBe('2026-08-11');
    expect(handelstagET(new Date('2026-08-12T04:00:00Z'))).toBe('2026-08-12');
  });

  it('und im Winter eine Stunde später', () => {
    // Normalzeit (EST, UTC−5): der Tag wechselt erst um 05:00 UTC.
    expect(handelstagET(new Date('2026-01-12T04:59:00Z'))).toBe('2026-01-11');
    expect(handelstagET(new Date('2026-01-12T05:00:00Z'))).toBe('2026-01-12');
  });
});

describe('Die Notbremse bleibt über die UTC-Mitternacht gesperrt', () => {
  /** Ausgelöst um 18:30 ET am 11.08. (= 22:30 UTC). */
  const AUSGELOEST = '2026-08-11T22:30:00.000Z';

  it('kurz nach dem Auslösen: gesperrt', () => {
    expect(breakerHeuteAusgeloest(AUSGELOEST, new Date('2026-08-11T23:00:00Z'))).toBe(true);
  });

  it('nach der UTC-Mitternacht: WEITERHIN gesperrt — der eigentliche Befund', () => {
    // Vorher gab die Bremse hier frei: 00:30 UTC ist der 12. in UTC, aber
    // erst 20:30 am 11. in New York.
    expect(breakerHeuteAusgeloest(AUSGELOEST, new Date('2026-08-12T00:30:00Z'))).toBe(true);
  });

  it('bis kurz vor Mitternacht ET: gesperrt', () => {
    expect(breakerHeuteAusgeloest(AUSGELOEST, new Date('2026-08-12T03:59:00Z'))).toBe(true);
  });

  it('erst mit dem neuen Handelstag gibt sie frei', () => {
    // 04:00 UTC = 00:00 ET des 12. — jetzt ist es wirklich ein neuer Tag.
    expect(breakerHeuteAusgeloest(AUSGELOEST, new Date('2026-08-12T04:00:00Z'))).toBe(false);
  });

  it('ein nie ausgelöster Breaker sperrt nicht', () => {
    for (const leer of [null, undefined, '', 0, false]) {
      expect(breakerHeuteAusgeloest(leer, new Date('2026-08-11T23:00:00Z')), `${leer}`).toBe(false);
    }
  });

  it('ein unlesbarer Marker gilt als ausgelöst', () => {
    // Im Zweifel gesperrt lassen, nicht freigeben — dieselbe Richtung, die
    // clampStrategyRisk bei jedem unsinnigen Wert nimmt.
    expect(breakerHeuteAusgeloest('kaputt', new Date('2026-08-11T23:00:00Z'))).toBe(true);
    expect(breakerHeuteAusgeloest({}, new Date('2026-08-11T23:00:00Z'))).toBe(false);
  });

  it('das gespeicherte Format bleibt ein ISO-Zeitstempel', () => {
    // Beide Seiten des Vergleichs laufen durch handelstagET, deshalb braucht
    // kein Bestandsdokument eine Migration.
    expect(breakerHeuteAusgeloest('2026-08-11T22:30:00.000Z', new Date('2026-08-11T23:00:00Z'))).toBe(
      true,
    );
  });
});

/* Wie in den Paketen davor: Die Funktion allein sagt nichts darüber, ob die
 * Gates sie benutzen. Es gibt ZWEI — der Scan und die zentralen Konto-Tore
 * (seit 13.08. das Breaker-Gate von Handeingabe UND Momentum-Lauf) —, und
 * eines davon zu vergessen wäre schlimmer als beide falsch zu haben: Der
 * Nutzer bekäme dann je nach Weg eine andere Antwort auf dieselbe Frage. */
describe('Quelltext: beide Breaker-Gates rechnen in New Yorker Zeit', () => {
  const quelle = (rel: string[]): string =>
    readFileSync(join(import.meta.dirname, '..', 'src', ...rel), 'utf8');

  for (const [name, rel] of [
    ['Scan', ['scheduled', 'scanMarket.ts']],
    ['Konto-Tore', ['core', 'kontoTore.ts']],
  ] as const) {
    it(`${name} benutzt breakerHeuteAusgeloest`, () => {
      const text = quelle([...rel]);
      // Mit Doppelpunkt: die Objekt-Eigenschaft im Aufruf, nicht die
      // Erwähnung im Doc-Kommentar.
      const ab = text.indexOf('bereitsAusgeloest:');
      expect(ab, 'Breaker-Gate nicht gefunden').toBeGreaterThan(0);
      expect(text.slice(ab, ab + 300)).toContain('breakerHeuteAusgeloest(');
    });

    it(`${name} vergleicht nicht mehr gegen den UTC-Tag`, () => {
      const text = quelle([...rel]);
      // Mit Doppelpunkt: die Objekt-Eigenschaft im Aufruf, nicht die
      // Erwähnung im Doc-Kommentar.
      const ab = text.indexOf('bereitsAusgeloest:');
      const block = text.slice(ab, ab + 300);
      expect(block).not.toContain('toISOString().slice(0, 10)');
    });
  }
});
