/**
 * Wächter der Fill-Nachbuchung (Owner-Fund 21.08.: „Verbindung zu Alpaca
 * war nicht mehr ganz synchron … 5 Trades waren nicht registriert.
 * funktioniert die Selbstheilung nicht?").
 *
 * Zwei Fehler steckten übereinander:
 *
 *  1. **Kopf-Blockade.** Die Auswahl war `orderBy('at').limit(3)` — immer
 *     die ältesten drei. Ein Eintrag, der nicht buchbar ist, blieb liegen;
 *     beim nächsten Lauf griff dieselbe Abfrage dieselben drei. Steckten
 *     die ältesten drei fest, kamen Eintrag vier und fünf NIE an die Reihe.
 *     Die Heilung lief also — und buchte für immer nichts.
 *
 *  2. **Kein Messwert.** Nur der Erfolgsfall ging in ein Log. Eine Heilung,
 *     die seit Tagen nichts mehr bucht, sah exakt aus wie eine, die nichts
 *     zu tun hat. Deshalb konnte der Rückstand unbemerkt liegen bleiben.
 *
 * Beide Eigenschaften sind hier festgenagelt. Sie sind Quelltext-Prüfungen,
 * weil die Buchung Firestore braucht — aber sie prüfen die EIGENSCHAFT
 * (kein toter Eintrag am Kopf, Rückstand wird gemeldet), nicht bloss, dass
 * eine Funktion aufgerufen wird. Genau diese Unterscheidung hat am selben
 * Abend beim Admin-Abgleich gefehlt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const broker = lies('core', 'broker.ts');
const scan = lies('scheduled', 'scanMarket.ts');
const fn = (): string =>
  broker.slice(broker.indexOf('export async function bucheUnverbuchteFills'));

describe('Nachbuchung: ein toter Eintrag blockiert die Schlange nicht', () => {
  it('die Auswahl ist nicht mehr „die ältesten drei, ungefiltert"', () => {
    /* Der eigentliche Fehler: `.limit(3)` DIREKT an der Abfrage bedeutet,
     * dass die drei ältesten die einzigen sind, die je drankommen. */
    const f = fn();
    expect(f).not.toMatch(/orderBy\('at'\)\s*\n?\s*\.limit\(limit\)/);
    expect(f).toContain("orderBy('at')");
    expect(f).toContain('.limit(NACHBUCHUNG_FENSTER)');
  });

  it('aufgegebene Einträge werden bei der Auswahl übersprungen', () => {
    const f = fn();
    // Auswahl: erst die noch Buchbaren, DANN erst der Deckel.
    expect(f).toMatch(/filter\(\(d\) => !aufgegeben\(d\)\)\s*\.slice\(0, limit\)/);
    expect(f).toContain('versucheVon(d) >= NACHBUCHUNG_TOT_AB || unbrauchbar(d)');
  });

  it('ein Eintrag ohne Fill-Preis verbraucht KEINEN Platz', () => {
    /* Der zweite Anlauf am 21.08.: Erst wurden auch unbrauchbare Einträge
     * fünfmal „versucht" — sie hielten gesunde Fills fünf Läufe lang auf.
     * In der Emulator-Probe war das der Unterschied zwischen Lauf 6 und
     * Lauf 1. Ob etwas buchbar ist, steht im Eintrag; das gehört vor die
     * Auswahl, nicht in den Versuch. */
    const f = fn();
    expect(f).toContain('const unbrauchbar = (d: FirebaseFirestore.QueryDocumentSnapshot): boolean =>');
    expect(f).toContain("!(zahl(d.get('fillPreis')) > 0)");
    // …und die Auswahl kennt `unbrauchbar` VOR der Schleife.
    expect(f.indexOf('const unbrauchbar')).toBeLessThan(f.indexOf('const dran ='));
  });

  it('jeder Fehlversuch zählt hoch — sonst verlässt nichts je den Kopf', () => {
    const f = fn();
    // Die gescheiterte Buchung zählt hoch; der unbrauchbare Eintrag wird
    // EINMAL als aufgegeben festgeschrieben. Fehlt eins von beidem, staut
    // sich die entsprechende Sackgasse wieder am Kopf.
    expect(f).toContain("await merkeFehlversuch(doc, r.reason ?? 'unbekannt');");
    expect(f).toContain('versuche: versucheVon(doc) + 1,');
    expect(f).toContain('versuche: NACHBUCHUNG_TOT_AB,');
    expect(f).toContain("letzterGrund: 'kein_verwertbarer_fill',");
  });

  it('ein aufgegebener Eintrag wird NICHT gelöscht — er ist echtes Depot', () => {
    /* Löschen wäre die bequeme Lösung und die falsche: Der Fill liegt real
     * beim Broker. Verschwindet der Vermerk, verschwindet der einzige
     * Hinweis darauf, dass das Buch unvollständig ist. Er bleibt liegen und
     * wartet auf die Übernahme. */
    const f = fn();
    const merker = f.slice(f.indexOf('const merkeFehlversuch'), f.indexOf('let gebucht'));
    expect(merker).not.toContain('delete()');
  });
});

describe('Nachbuchung: der Rückstand ist sichtbar', () => {
  it('die Funktion meldet Rückstand, nicht nur Erfolg', () => {
    expect(broker).toContain('export interface NachbuchungsStand');
    expect(fn()).toContain('return { gebucht, offen: Math.max(0, fenster.size - gebucht), steckt };');
  });

  it('der Scan summiert ihn über alle Konten', () => {
    expect(scan).toContain('nachbuchungLauf.steckt += nachbuchung.steckt;');
    expect(scan).toContain('if (nachbuchung.steckt > 0) nachbuchungLauf.konten += 1;');
  });

  it('und schreibt ihn in den Herzschlag', () => {
    /* Ohne diese Zeile wäre der Fix unbeobachtbar: Er würde wirken oder
     * auch nicht, und man erführe es beim nächsten Mal wieder erst, wenn
     * jemand Trades von Hand vermisst. */
    expect(scan).toContain('nachbuchung: nachbuchungLaufGesamt,');
  });

  it('nicht gemessen ≠ nichts gefunden — der Herzschlag darf `null` tragen', () => {
    expect(scan).toContain('let nachbuchungLaufGesamt: NachbuchungsLauf | null = null;');
  });
});
