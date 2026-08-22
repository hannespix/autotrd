/**
 * Waechter des Nachrichten-Fadens (Owner 22.08.).
 *
 * "Man soll eine Moeglichkeit haben, dem Admin zur Anmeldung auch eine
 *  Nachricht zukommen zu lassen … und der Admin soll antworten koennen …
 *  diese soll der Admin spaeter fuer jeden Account abrufen koennen."
 *
 * Drei Eigenschaften tragen das, und jede kann still brechen:
 *
 *  1. **Der Absender kommt vom WEG, nicht aus der Anfrage.** Stuende
 *     `von` in den Daten, koennte sich jeder eine Betreiber-Antwort in den
 *     eigenen Faden schreiben -- "Ihr Konto ist freigeschaltet" von einem
 *     Absender, den er selbst gesetzt hat.
 *  2. **Zwei getrennte Tueren.** Der Kunde schreibt ueber `nachricht`,
 *     der Admin ueber `adminUsers`. "Darf ich fremde Faeden sehen?" haengt
 *     damit davon ab, WELCHE Funktion man aufruft, nicht von einem
 *     Parameter.
 *  3. **Auch fuer wartende Konten.** Die erste Nachricht ist die zur
 *     Anmeldung. Ein Faden hinter der Freischaltung verfehlt den Zweck.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NACHRICHT_MAX, leseNachricht, pruefeNachricht } from '../../shared/src/nachrichten.js';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const kunde = lies('callable', 'nachricht.ts');
const admin = lies('callable', 'admin.ts');

describe('Der Absender kommt vom Weg, nicht aus der Anfrage', () => {
  it('die Kunden-Tuer schreibt IMMER `kunde`', () => {
    expect(kunde).toContain("von: 'kunde',");
    // Nirgends aus den Daten uebernommen.
    expect(kunde).not.toMatch(/von:\s*(von|data\.von|request\.data)/);
  });

  it('die Admin-Tuer schreibt IMMER `admin`', () => {
    const block = admin.slice(admin.indexOf("action === 'antworten'"), admin.indexOf("action === 'setAdmin'"));
    expect(block).toContain("von: 'admin',");
    expect(block).not.toMatch(/von:\s*(von|data\.von|request\.data)/);
  });
});

describe('Zwei getrennte Tueren', () => {
  it('die Kunden-Tuer kennt kein fremdes Ziel', () => {
    /* Kein `target`: Der Faden ist der des angemeldeten Kontos, und das
     * steht im Token -- nicht in den Daten. */
    expect(kunde).toContain("db.collection('users').doc(uid).collection('nachrichten')");
    expect(kunde).not.toContain('target');
  });

  it('die Admin-Tuer geht ueber targetRef -- eigenes Konto bleibt tabu', () => {
    const lesen = admin.slice(admin.indexOf("action === 'nachrichten'"), admin.indexOf("action === 'antworten'"));
    expect(lesen).toContain('const ref = targetRef();');
  });

  it('sie sitzt hinter der Admin-Pruefung', () => {
    // `adminUsers` prueft oben `admin !== true` und wirft; beide Zweige
    // liegen dahinter, sonst waere die Tuer offen.
    const wache = admin.indexOf("caller.get('admin') !== true");
    expect(wache).toBeGreaterThan(-1);
    expect(admin.indexOf("action === 'nachrichten'")).toBeGreaterThan(wache);
    expect(admin.indexOf("action === 'antworten'")).toBeGreaterThan(wache);
  });
});

describe('Auch wartende Konten duerfen schreiben', () => {
  it('die Kunden-Tuer hat KEIN mayTrade', () => {
    /* Die erste Nachricht ist die zur Anmeldung. Geschrieben wird Text,
     * nicht Geld -- ein Handels-Riegel waere hier das falsche Werkzeug. */
    // Auf den AUFRUF pruefen, nicht auf das Wort: Der Kopf der Datei
    // erklaert, warum es hier keinen gibt -- eine Erwaehnung ist kein Riegel.
    expect(kunde).not.toMatch(/mayTrade\(/);
  });
});

describe('Text wird geprueft, bevor er gespeichert wird', () => {
  it('leer, nur Leerzeichen oder kein Text ergibt nichts', () => {
    expect(pruefeNachricht('')).toBeNull();
    expect(pruefeNachricht('   \n  ')).toBeNull();
    expect(pruefeNachricht(42)).toBeNull();
    expect(pruefeNachricht(null)).toBeNull();
  });

  it('Zeilenumbrueche bleiben -- wer sich vorstellt, gliedert das', () => {
    expect(pruefeNachricht('Hallo\nich bin Max')).toBe('Hallo\nich bin Max');
  });

  it('Steuerzeichen fliegen raus', () => {
    // Sie machen die Anzeige kaputt, ohne etwas zu sagen.
    expect(pruefeNachricht('a\u0000b\u0007c')).toBe('abc');
  });

  it('und die Laenge ist gedeckelt', () => {
    const lang = 'x'.repeat(NACHRICHT_MAX + 500);
    expect(pruefeNachricht(lang)?.length).toBe(NACHRICHT_MAX);
  });

  it('halb geschriebene Nachrichten werden nicht angezeigt', () => {
    expect(leseNachricht({ von: 'kunde', text: 'hi', at: '2026-08-22' })).not.toBeNull();
    expect(leseNachricht({ von: 'fremd', text: 'hi', at: '2026-08-22' })).toBeNull();
    expect(leseNachricht({ von: 'kunde', at: '2026-08-22' })).toBeNull();
    expect(leseNachricht({ von: 'kunde', text: 'hi' })).toBeNull();
  });

  it('das Tageslimit steht im Code', () => {
    // Ein Faden ohne Deckel ist ein Einladungsschreiben an Spam.
    expect(kunde).toContain("consumeQuota(uid, 'nachricht', TAGESLIMIT)");
  });
});
