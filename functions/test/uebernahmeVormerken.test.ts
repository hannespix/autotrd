/**
 * Wächter der Übernahme-Vormerkung (Owner-Entscheidung 22.08.).
 *
 * Ausgangslage: Ein Konto stand auf Abgleich-Sperre, und der Admin hatte
 * keinen Weg, sie aufzulösen — der „Abgleichen"-Knopf MISST nur neu, und
 * die einzige Heilung (`adoptBroker`) gibt es ausschliesslich für das
 * eigene Konto.
 *
 * Die Entscheidung war bewusst NICHT „Admin darf fremde Bücher
 * überschreiben". Die Übernahme schreibt Bestand und Barbestand neu; käme
 * die Abweichung aus einem Aussetzer beim Broker, zerstörte die „Heilung"
 * korrekte Daten. Also merkt der Admin sie nur VOR, und der Konto-Inhaber
 * entscheidet.
 *
 * Zwei Eigenschaften tragen das, und beide stehen hier:
 *
 *  1. Der Vormerk-Zweig fasst KEIN fremdes Geld an — nur den Vermerk.
 *  2. Er entsteht nur bei einer FRISCH GEMESSENEN Sperre; sonst wäre er
 *     ein allgemeines Recht, fremden Nutzern Aufforderungen ins Konto zu
 *     legen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const admin = lies('callable', 'admin.ts');
const adopt = lies('callable', 'adoptBroker.ts');

/** Der Vormerk-Zweig allein. */
function zweig(): string {
  const a = admin.indexOf("if (action === 'uebernahmeVormerken')");
  const b = admin.indexOf("if (action === 'setAdmin')");
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return admin.slice(a, b);
}

describe('Vormerken fasst kein fremdes Geld an', () => {
  it('kein Schreibzugriff auf Wallet, Positionen oder Strategie', () => {
    const z = zweig();
    expect(z).not.toContain('paperBalance:');
    expect(z).not.toContain('baseCapital');
    expect(z).not.toContain("collection('positions').doc");
    expect(z).not.toContain('settings.strategy');
  });

  it('geschrieben wird genau ein Feld: der Vermerk', () => {
    /* `ref.set(...)` kommt genau einmal vor, und der Inhalt ist
     * `risk.uebernahmeVorgemerkt`. Käme ein zweites `set` dazu, wäre die
     * Zusicherung „nur ein Vermerk" nicht mehr durch Lesen prüfbar. */
    const z = zweig();
    expect([...z.matchAll(/\bref\.set\(/g)]).toHaveLength(1);
    expect(z).toContain('uebernahmeVorgemerkt: {');
  });

  it('der Vermerk sagt, WER ihn gesetzt hat', () => {
    // Ein Schnitt am fremden Buch, den niemand zuordnen kann, ist kein Schnitt.
    expect(zweig()).toContain('vonAdmin: uid,');
  });

  it('das eigene Konto bleibt tabu — derselbe Weg wie set/setAdmin', () => {
    expect(zweig()).toContain('const ref = targetRef();');
  });
});

describe('Vormerken nur bei gemessener Sperre', () => {
  it('erst messen, dann schreiben — nie umgekehrt', () => {
    const z = zweig();
    const messen = z.indexOf('const befund = await abgleichFuerKonto(');
    const schreiben = z.indexOf('ref.set(');
    expect(messen).toBeGreaterThan(-1);
    expect(schreiben).toBeGreaterThan(messen);
  });

  it('ohne Sperre entsteht kein Vermerk — und das ist kein Fehler', () => {
    /* `vorgemerkt: false` ist die Antwort auf die Frage, die der Admin mit
     * dem Klick gestellt hat, nicht ein Scheitern. Ein Wurf wäre hier
     * falsch: Er verwandelte „alles in Ordnung" in eine Fehlermeldung. */
    const z = zweig();
    expect(z).toContain('if (!befund.sperre) {');
    const ohne = z.slice(z.indexOf('if (!befund.sperre) {'), z.indexOf('await ref.set('));
    expect(ohne).toContain('vorgemerkt: false,');
    expect(ohne).not.toContain('HttpsError');
  });

  it('die Sperre kommt aus dem Abgleich, nicht aus einer eigenen Auslegung', () => {
    // Zwei Wahrheiten über dieselbe Sperre wären schlimmer als keine.
    expect(zweig()).toContain('const befund = await abgleichFuerKonto(');
    expect(zweig()).not.toMatch(/sperre\s*=\s*(true|false)/);
  });
});

describe('Die Vormerkung verfällt, wenn sie erfüllt ist', () => {
  it('eine erfolgreiche Übernahme räumt sie weg', () => {
    /* Eine Bitte, die nach Erfüllung stehen bleibt, ist eine Mahnung ohne
     * Anlass — der Nutzer würde beim nächsten Blick erneut aufgefordert,
     * sein Buch zu überschreiben. */
    expect(adopt).toContain('uebernahmeVorgemerkt: null');
  });

  it('zusammen mit dem Lauf-Marker im letzten Batch', () => {
    const stelle = adopt.indexOf('uebernahmeVorgemerkt: null');
    expect(adopt.slice(stelle - 200, stelle)).toContain('resetLaeuftSeit: null');
  });
});
