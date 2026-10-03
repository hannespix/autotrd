/**
 * Audit-Befund 11.08. (C4): Der Universum-Sync ließ Block-Leichen liegen.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Der Lauf schrieb die Blöcke `0 … n-1` und rührte alles darüber nicht an.
 * Schrumpft das Universum — ein Delisting-Schwung, ein geänderter Filter,
 * eine unvollständige Antwort von Alpaca —, bleibt der letzte Block mit bis
 * zu 2.000 Symbolen als Leiche liegen.
 *
 * ── Der Kommentar war das eigentliche Problem ─────────────────────────────
 *
 * An der Schreibstelle stand: „Volles `set` statt `merge`: Ein geschrumpftes
 * Universum muss die Blöcke am Ende wirklich leeren, sonst ranken delistete
 * Papiere weiter mit." Das galt für das ZÄHL-Dokument. Für die Blöcke galt
 * es nie. Ein Kommentar, der eine Garantie verspricht, die der Code nicht
 * gibt, ist schlimmer als gar keiner — der nächste Leser prüft sie nicht
 * mehr nach.
 *
 * ── Warum jetzt, obwohl noch nichts kaputt ist ────────────────────────────
 *
 * Einen Leser gibt es heute nicht; die Rangliste zieht das Universum erst im
 * nächsten Schritt. Die naheliegende Bauweise dafür ist
 * `collection('bloecke').get()` — und die liest die Leichen mit. Dann
 * ständen delistete Papiere in der Rangliste, und niemand stellte den
 * Zusammenhang zu einem Sync-Lauf von vor Wochen her.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verwaisteBloecke } from '../src/scheduled/universumSync.js';

describe('verwaisteBloecke', () => {
  it('nichts zu tun, wenn die Zahl gleich bleibt', () => {
    expect(verwaisteBloecke(['0', '1', '2'], 3)).toEqual([]);
  });

  it('nichts zu tun, wenn das Universum wächst', () => {
    // Die neuen Blöcke schreibt der Lauf selbst; hier gibt es nichts zu
    // löschen.
    expect(verwaisteBloecke(['0', '1'], 4)).toEqual([]);
  });

  it('meldet den überzähligen Block beim Schrumpfen', () => {
    expect(verwaisteBloecke(['0', '1', '2', '3', '4', '5'], 5)).toEqual(['5']);
  });

  it('meldet ALLE überzähligen, nicht nur den letzten', () => {
    // Ein Filter-Wechsel kann das Universum halbieren.
    expect(verwaisteBloecke(['0', '1', '2', '3', '4', '5'], 2)).toEqual(['2', '3', '4', '5']);
  });

  it('fasst nichts an, was keine Blocknummer ist', () => {
    /* Löschen ist unumkehrbar, und was hier liegt, haben wir nicht angelegt.
     * Eine Kennung wie `alt` oder `01` gehört nicht zu diesem Schema — sie
     * könnte alles sein. */
    expect(verwaisteBloecke(['0', 'alt', 'backup', '007', '1.5', '-1', ''], 1)).toEqual([]);
  });

  it('erkennt eine Nummer, die als Text anders geschrieben ist', () => {
    // `007` ist die Zahl 7, aber nicht die Kennung, die wir schreiben. Der
    // Rückweg über String(n) fängt das ab.
    expect(verwaisteBloecke(['007'], 0)).toEqual([]);
    expect(verwaisteBloecke(['7'], 0)).toEqual(['7']);
  });

  it('null Blöcke bedeutet: alles weg', () => {
    // Kann nur eintreten, wenn der Lauf ohne Einträge käme — und dann bricht
    // er vorher ab. Trotzdem geprüft: Die Funktion darf nicht davon
    // abhängen, dass ihr Aufrufer sich richtig verhält.
    expect(verwaisteBloecke(['0', '1'], 0)).toEqual(['0', '1']);
  });

  it('eine leere Sammlung ist kein Sonderfall', () => {
    expect(verwaisteBloecke([], 3)).toEqual([]);
  });
});

describe('Quelltext: der Sync räumt wirklich auf', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'universumSync.ts');
  const text = (): string => readFileSync(pfad, 'utf8');

  it('löscht die verwaisten Blöcke im SELBEN Batch wie den neuen Stand', () => {
    /* Getrennt gäbe es einen Moment, in dem das Zähl-Dokument schon die neue
     * Zahl nennt und die alten Blöcke noch liegen — genau die Lage, die ein
     * Leser falsch auflöst. */
    const t = text();
    const ab = t.indexOf('const batch = db.batch();');
    const bis = t.indexOf('await batch.commit();', ab);
    expect(bis).toBeGreaterThan(ab);
    const block = t.slice(ab, bis);
    expect(block).toContain('verwaisteBloecke(');
    expect(block).toContain('batch.delete(');
  });

  it('holt nur die Kennungen, nicht die Symbole', () => {
    // Es gibt keinen Grund, bis zu 2.000 Symbole je Block zu lesen, die
    // gleich gelöscht werden.
    expect(text()).toContain('.listDocuments()');
  });

  it('ein misslungenes Aufräumen kippt den Sync nicht', () => {
    // Der neue Stand ist wichtiger als die Leichen von gestern, und der
    // nächste Lauf versucht es erneut.
    const t = text();
    const ab = t.indexOf('const vorhanden = await db.collection');
    expect(t.slice(Math.max(0, ab - 200), ab)).toContain('try {');
  });

  it('der irreführende Kommentar ist weg', () => {
    /* Er behauptete, das volle `set` leere die Blöcke am Ende. Bliebe er
     * stehen, wäre der Fix zwar da, aber die falsche Erklärung daneben — und
     * die nächste Änderung liefe wieder auf sie herein. */
    expect(text()).not.toContain('muss die Blöcke am Ende wirklich leeren');
  });
});
