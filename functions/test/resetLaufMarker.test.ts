/**
 * Audit-Befund 11.08. (A7): Der Reset lief ohne Lauf-Marker.
 *
 * Die reine Logik prüft `shared/test/resetSperre.test.ts`. Hier geht es um
 * die Verdrahtung, und die ist bei diesem Befund der eigentliche Punkt: Ein
 * Marker, den niemand setzt, oder eine Sperre, die nur einer der beiden
 * Handelspfade beachtet, wäre schlimmer als keiner — sie erzeugte Vertrauen
 * für beide.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

describe('Der Reset meldet sich an und wieder ab', () => {
  const reset = (): string => quelle('callable', 'reset.ts');

  it('setzt den Marker, BEVOR etwas verschwindet', () => {
    /* Danach wäre er sinnlos: Das Archivieren ist der erste Schritt und
     * gleichzeitig der, bei dem ein gleichzeitiger Trade den größten Schaden
     * anrichtet — sein Kauf bliebe unarchiviert zurück.
     *
     * Seit der Härtung 24.08. (update()+FieldPath statt set(merge) — dieselbe
     * Geister-Dok.-Begründung wie an fünf anderen Stellen) lautet der
     * Aufruf `new FieldPath('risk', 'resetLaeuftSeit'), now`, nicht mehr
     * `resetLaeuftSeit: now`. */
    const text = reset();
    const marker = text.indexOf("new FieldPath('risk', 'resetLaeuftSeit'), now");
    const archiv = text.indexOf('await archiviereTrades(');
    expect(marker, 'Marker wird nicht gesetzt').toBeGreaterThan(0);
    expect(archiv).toBeGreaterThan(marker);
  });

  it('räumt ihn im SELBEN Schreibvorgang wie den neuen Kontostand ab', () => {
    // Getrennt gäbe es einen Moment, in dem der Handel frei ist und das
    // Wallet noch nicht steht — genau der Zustand, den der Marker verhindern
    // soll, nur am anderen Ende. Ein EINZIGER update()-Aufruf statt eines
    // set(merge) — die Bündelung in einem Aufruf ist weiterhin die Zusage.
    const text = reset();
    const ab = text.indexOf("new FieldPath('wallet', 'paperBalance'), balance,");
    const risikoLoeschen = text.indexOf(
      "new FieldPath('risk', 'resetLaeuftSeit'), FieldValue.delete()",
      ab,
    );
    expect(ab).toBeGreaterThan(0);
    expect(risikoLoeschen, 'resetLaeuftSeit-Löschung fehlt').toBeGreaterThan(ab);
    // Beide Felder gehören zu EINEM update()-Aufruf, nicht zu getrennten —
    // ein `);` (Aufruf-Ende) zwischen ihnen bewiese zwei separate Writes.
    expect(text.slice(ab, risikoLoeschen)).not.toContain(');');
  });
});

describe('Reset selbst prüft Freischaltung und laufende Vorgänge (Red-Team-Befund 24.08.)', () => {
  const reset = (): string => quelle('callable', 'reset.ts');

  it('mayTradeSnap-Gate steht vor dem Marker-Setzen', () => {
    // Vor der Härtung konnte ein gesperrtes/archiviertes Konto sein Wallet
    // trotzdem jederzeit selbst zurücksetzen — mit demselben
    // Geister-Dok.-Risiko wie an fünf anderen Stellen, plus keiner Rücksicht
    // auf einen zeitgleich laufenden Vorgang (z. B. eine Admin-Löschung).
    const text = reset();
    const gate = text.indexOf('if (!mayTradeSnap(snap)) {');
    const marker = text.indexOf("new FieldPath('risk', 'resetLaeuftSeit'), now");
    expect(gate, 'mayTradeSnap-Gate fehlt').toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(gate);
  });

  it('Vorrang-Check gegen einen bereits laufenden resetLaeuftSeit-Marker', () => {
    const text = reset();
    const check = text.indexOf("resetLaeuft(snap.get('risk.resetLaeuftSeit'), new Date())");
    const gate = text.indexOf('if (!mayTradeSnap(snap)) {');
    expect(check, 'Vorrang-Check fehlt').toBeGreaterThan(0);
    expect(check).toBeGreaterThan(gate);
  });
});

describe('Beide Handelspfade beachten die Sperre', () => {
  it('der Scan überspringt ein Konto im Reset', () => {
    const text = quelle('scheduled', 'scanMarket.ts');
    expect(text).toContain("resetLaeuft(userDoc.get('risk.resetLaeuftSeit')");
    const ab = text.indexOf("resetLaeuft(userDoc.get('risk.resetLaeuftSeit')");
    expect(text.slice(ab, ab + 200)).toContain('continue;');
  });

  it('und zählt es, statt still zu schweigen', () => {
    // Ein übersprungenes Konto ist ein Nicht-Ereignis. Steht die Zahl über
    // mehrere Scans hinweg > 0, hängt ein Reset — das ist ein Hinweis, den
    // man nur sieht, wenn er gezählt wird.
    const text = quelle('scheduled', 'scanMarket.ts');
    expect(text).toContain('konten.reset_laeuft += 1;');
    expect(text).toContain('reset_laeuft: number;');
    expect(text).toContain('reset_laeuft: 0,');
  });

  it('der manuelle Handel lehnt ab — auch den Verkauf', () => {
    /* Anders als bei der Notbremse, die Verkäufe ausdrücklich durchlässt.
     * Hier geht es nicht um Risiko, sondern um Buchführung: Ein Verkauf
     * mitten im Archivieren hinterlässt einen Trade, den der Reset nicht
     * mehr mitnimmt.
     *
     * Seit dem 13.08. entscheidet das zentral core/kontoTore.ts: Die Sperre
     * steht dort als `handel` (nicht `einstieg`) — sie trifft also jede
     * Richtung. Hier bleibt zu prüfen, dass das Callable sie VOR der
     * Einstiegs-Unterscheidung abfragt und hart ablehnt. */
    const tore = quelle('core', 'kontoTore.ts');
    const abTore = tore.indexOf("resetLaeuft(snap.get('risk.resetLaeuftSeit')");
    expect(abTore, 'Reset-Gate fehlt in den Konto-Toren').toBeGreaterThan(0);
    expect(tore.slice(abTore, abTore + 200)).toContain("handel: 'reset_laeuft'");

    const text = quelle('callable', 'trade.ts');
    const ab = text.indexOf('if (tore.handel)');
    expect(ab, 'Handel-Sperre fehlt im Handels-Callable').toBeGreaterThan(0);
    const einstieg = text.indexOf('const istEinstieg =');
    expect(ab, 'Gate steht hinter der Einstiegs-Unterscheidung').toBeLessThan(einstieg);
    // 500 statt 200 Zeichen Fenster: Seit dem #145-Grenzfall (20.08.) steht
    // zwischen Gate und Wurf ein Begründungs-Kommentar — die Aussage des
    // Wächters (Gate → harter Wurf) ist unverändert.
    expect(text.slice(ab, ab + 500)).toContain('HttpsError');
  });

  it('beide benutzen DIESELBE Funktion', () => {
    // Zwei Ableitungen wären zwei Gelegenheiten, das Verfallsfenster
    // verschieden zu setzen.
    for (const pfad of [
      ['scheduled', 'scanMarket.ts'],
      ['core', 'kontoTore.ts'],
    ] as const) {
      expect(quelle(...pfad)).toContain('resetLaeuft');
    }
  });
});
