/**
 * Zwei Audit-Befunde vom 11.08. — beide aus derselben Familie:
 * Eine Sache, zwei Antworten.
 *
 * Diese Familie hat in dieser Woche vier Fehler produziert (Broker-Abgleich
 * gefiltert/ungefiltert, Krypto-Schreibweise hin/zurück, Anteilsklassen,
 * Cache-Absagen). Das Audit hat gezielt danach gesucht und zwei weitere
 * gefunden.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { positionValue } from '../../shared/src/index.js';
import { shadowEquity } from '../src/core/rulesTrading.js';

/* ── Befund A: Die Depotbewertung stand zweimal da — mit Unterschied ───────
 *
 * `shadowEquity` rechnete die Short-Formel selbst, statt `positionValue` zu
 * rufen. Die Formeln sahen gleich aus, verhielten sich aber verschieden:
 *
 *   positionValue   `price > 0` ⇒ ein Kurs von 0 fällt auf den EINSTAND
 *   shadowEquity    `?? avgEntry` ⇒ greift nur bei `undefined`, ein Kurs
 *                   von 0 bewertete die Position mit NULL
 *
 * Das Schattendepot entscheidet, welche Strategie befördert wird — also
 * welche echtes Geld bekommt. Ein einziger Nullkurs aus einer patzenden
 * Quelle hätte dort einen Totalverlust angezeigt und eine funktionierende
 * Strategie aus dem Rennen genommen, ohne dass irgendwo ein Fehler stünde.
 */
describe('Befund A: Depotbewertung — eine Formel für alle', () => {
  const buch = (side: 'long' | 'short') => ({
    balance: 1_000,
    positions: { AAPL: { qty: 10, avgEntry: 100, side } },
  });

  it('bewertet einen KURS VON NULL konservativ zum Einstand, nicht mit null', () => {
    // Der eigentliche Fehler. Vorher: 1.000 + 0 = 1.000 (Totalverlust).
    const out = shadowEquity(buch('long') as never, new Map([['AAPL', 0]]));
    expect(out).toBe(2_000);
  });

  it('gilt genauso für Shorts', () => {
    // Short zu 0 bewertet hätte 1.000 + (10·100 + 100·10) = 3.000 ergeben —
    // ein Phantom-Gewinn von 100 %, weil „Kurs 0" wie „auf null gefallen"
    // gelesen wurde.
    const out = shadowEquity(buch('short') as never, new Map([['AAPL', 0]]));
    expect(out).toBe(2_000);
  });

  it('fehlender Kurs verhält sich weiterhin wie vorher', () => {
    expect(shadowEquity(buch('long') as never, new Map())).toBe(2_000);
  });

  it('ein gültiger Kurs bewertet Long zum Marktwert', () => {
    expect(shadowEquity(buch('long') as never, new Map([['AAPL', 120]]))).toBe(2_200);
  });

  it('und Short als Margin plus unrealisiertem Gewinn', () => {
    // Kurs fiel von 100 auf 80: Margin 1.000 + Gewinn 200.
    expect(shadowEquity(buch('short') as never, new Map([['AAPL', 80]]))).toBe(2_200);
  });

  it('stimmt Position für Position mit positionValue überein', () => {
    // Die strukturelle Aussage: Es gibt nur noch EINE Formel.
    for (const side of ['long', 'short'] as const) {
      for (const kurs of [0, 50, 100, 250]) {
        const b = buch(side);
        const erwartet = 1_000 + positionValue({ qty: 10, avgEntry: 100, side }, kurs);
        expect(shadowEquity(b as never, new Map([['AAPL', kurs]])), `${side} @ ${kurs}`).toBe(
          Math.round(erwartet * 100) / 100,
        );
      }
    }
  });
});

/* ── Befund B: „kein Broker" und „nicht nachsehen können" ──────────────────
 *
 * `brokerVerbindungLesend` gibt für beides `null`. Fürs Routing ist das
 * richtig — nicht routen ist in beiden Fällen die sichere Antwort. Für die
 * MELDUNG ist es genau der Fall, gegen den `AbgleichZustand.fehler` gebaut
 * wurde; der Modulkopf von `brokerAbgleich.ts` sagt es selbst:
 *
 *   „Ohne sie sähe ein Konto, dessen Broker seit Stunden nicht antwortet, im
 *    Heartbeat exakt so aus wie eines ganz ohne Broker."
 *
 * Über den Firestore-Pfad trat genau das ein: Ein Lesefehler ließ das Konto
 * aus `verbunden` verschwinden, und niemand sah es.
 *
 * Der Merkzettel wird hier über die öffentliche Schnittstelle geprüft — ohne
 * Firestore, weil der Zustand ein reiner Prozess-Merker ist.
 */
describe('Befund B: Lesefehler ist kein „kein Broker"', () => {
  it('ein Konto ohne Lesefehler gilt nicht als unlesbar', async () => {
    const { verbindungUnlesbar } = await import('../src/core/orderRouting.js');
    expect(verbindungUnlesbar('niemals-gelesen')).toBe(false);
  });

  /* Der eigentliche Nachweis ist strukturell.
   *
   * Ob `abgleichFuerKonto` bei einem Firestore-Lesefehler `fehler` statt
   * `kein_broker` meldet, ließe sich nur mit einem Firestore-Mock prüfen —
   * und ein Test, der das Verhalten nachbaut, prüft am Ende die Nachbildung
   * (dieselbe Lehre wie gestern bei der Klassen-Kreuzung).
   *
   * Was sich sicher prüfen lässt: dass der Abgleich den Unterschied
   * ÜBERHAUPT abfragt. Fällt diese Zeile weg, ist der Befund zurück, und
   * dieser Test fällt — unabhängig davon, wie die Fehlerbehandlung darum
   * herum aussieht. */
  const pfad = join(import.meta.dirname, '..', 'src', 'core', 'brokerAbgleich.ts');

  it('der Abgleich fragt den Unterschied ab', () => {
    expect(readFileSync(pfad, 'utf8')).toContain('verbindungUnlesbar(uid)');
  });

  it('und macht daraus den Zustand „fehler", nicht „kein_broker"', () => {
    const text = readFileSync(pfad, 'utf8');
    // Der Block zwischen der Abfrage und dem Rückgabewert muss `fehler`
    // liefern; ein `kein_broker` an dieser Stelle wäre der alte Zustand.
    const ab = text.indexOf('verbindungUnlesbar(uid)');
    const bis = text.indexOf('return OHNE;', ab);
    expect(ab).toBeGreaterThan(0);
    expect(text.slice(ab, bis)).toContain("zustand: 'fehler'");
  });
});
