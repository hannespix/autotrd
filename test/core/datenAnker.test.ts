/**
 * Der Anker des Datenfensters (`datenAnker`, core/time.ts).
 *
 * ── Warum dieser Wächter existiert ────────────────────────────────────────
 *
 * `fetch` und `optimize` hängten ihr Fenster an verschiedenen Punkten auf:
 * `cmdFetch` an der WANDUHR, `runOptimization` am DATENENDE. An einem Tag
 * ohne Handel liegt dazwischen die Marktlücke — und `fetch` holte um genau
 * diese Lücke zu wenig. Am Sonntag, dem 13.09.2026:
 *
 *   fetch will ab    2021-03-23   (Anker Wanduhr)
 *   optimize will ab 2021-03-21   (Anker Datenende)
 *
 * Der Schnitt im Optimierer ist richtig, aber er kann keine Bars
 * herbeizaubern, die nie geholt wurden. Ein Lauf mit FRISCHEM Cache war
 * damit am Anfang zu kurz — ein Lauf mit altem nicht, weil der Backfill ab
 * `min(from, first)` fragt. Dieselbe Config maß also ein anderes Fenster,
 * je nachdem ob der Cache warm war. Genau daran ist der Vergleich #56 gegen
 * #59 gescheitert.
 *
 * Die Richtung ist unsymmetrisch, und der Test nagelt genau das fest: Der
 * Anker darf NIE ZU SPÄT liegen (dann fehlen Bars), zu früh ist harmlos.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { datenAnker, isTradingDay, prevTradingDayOrNull } from '../../src/core/time.ts';

describe('datenAnker', () => {
  it('an einem Handelstag ist der Anker der Tag selbst', () => {
    // Freitag, 11.09.2026 — regulärer Handelstag.
    expect(datenAnker('2026-09-11', 'us_equity')).toBe('2026-09-11');
  });

  it('am Wochenende zeigt er auf den Freitag davor — der Fall #56/#59', () => {
    expect(datenAnker('2026-09-12', 'us_equity')).toBe('2026-09-11'); // Samstag
    expect(datenAnker('2026-09-13', 'us_equity')).toBe('2026-09-11'); // Sonntag
  });

  it('überspringt auch Feiertage — nach einem langen Wochenende sind es mehr als zwei Tage', () => {
    // Labor Day 2026: Montag, 07.09. Der Anker an diesem Montag ist der
    // Freitag davor, also DREI Tage zurück statt zwei.
    expect(isTradingDay('2026-09-07', 'us_equity')).toBe(false);
    expect(datenAnker('2026-09-07', 'us_equity')).toBe('2026-09-04');
  });

  it('liegt NIE nach dem Tag selbst — zu spät heisst fehlende Bars', () => {
    // Ein Jahr am Stück: Der Anker darf an keinem einzigen Tag in die
    // Zukunft zeigen, und er muss immer ein Handelstag sein (ausser es gibt
    // in 30 Tagen davor keinen).
    let tag = '2026-01-01';
    for (let i = 0; i < 365; i++) {
      const a = datenAnker(tag, 'us_equity');
      expect(a <= tag, `${tag}: Anker ${a} liegt NACH dem Tag`).toBe(true);
      if (prevTradingDayOrNull(tag, 'us_equity') !== null) {
        expect(isTradingDay(a, 'us_equity'), `${tag}: Anker ${a} ist kein Handelstag`).toBe(true);
      }
      const d = new Date(Date.UTC(Number(tag.slice(0, 4)), Number(tag.slice(5, 7)) - 1, Number(tag.slice(8, 10))) + 86_400_000);
      tag = d.toISOString().slice(0, 10);
    }
  });

  it('Krypto handelt jeden Tag — der Anker ist immer der Tag selbst', () => {
    for (const tag of ['2026-09-11', '2026-09-12', '2026-09-13', '2026-01-01']) {
      expect(datenAnker(tag, 'crypto')).toBe(tag);
    }
  });

  it('cmdFetch benutzt ihn — und nicht mehr die Wanduhr', () => {
    // Der Wächter sitzt bewusst am Aufrufer: Die Funktion allein richtig zu
    // haben, hat den Fehler nicht verhindert. Ein erster Entwurf dieses
    // Fixes prüfte nur `datenAnker` — und hätte nicht gemerkt, wenn
    // `cmdFetch` weiter `now - days * DAY` rechnet.
    const cli = new URL('../../src/cli.ts', import.meta.url);
    const text = readFileSync(cli, 'utf8');
    const roh = text.slice(text.indexOf('async function cmdFetch'), text.indexOf('async function cmdBacktest'));
    // Kommentare raus: Der Block ERKLÄRT den alten Anker, und ein Wächter,
    // der an der Erklärung hängenbleibt, prüft den Code nicht.
    const code = roh.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code, 'cmdFetch ruft datenAnker nicht auf').toContain('datenAnker(');
    expect(code.includes('now - days * DAY'), 'cmdFetch rechnet wieder gegen die Wanduhr').toBe(false);
  });
});
