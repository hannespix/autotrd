/**
 * Der Journal-Leser („warum hat die Engine nicht gehandelt?").
 *
 * ── Warum dieser Wächter existiert ────────────────────────────────────────
 *
 * Am 16.09.2026 sagte das Symbolprofil für BAC einen Einstieg voraus, die
 * Engine stellte keinen — und vier Log-Suchen fanden nichts. Der Grund war
 * nicht, dass nichts passiert war, sondern dass die Blockier-Gründe aus
 * `decide()` ins Firestore-Journal gehen (`users/{uid}/journal`,
 * engine.ts:855) und nicht nach Cloud Logging. „Kein Treffer" las sich wie
 * „alles ruhig" und hieß in Wahrheit „an der falschen Stelle gesucht".
 *
 * Deshalb ist der wichtigste Test hier nicht die Formatierung, sondern die
 * Unterscheidung, an der ich hängengeblieben bin: **kein Eintrag** heißt
 * NICHT „geprüft und abgelehnt", sondern „gar nicht beurteilt". Ein Werkzeug,
 * das beides gleich darstellt, hätte mir nicht geholfen.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs ohne Typen (wie test/scripts/wachhund.test.ts)
import { ERKLAEREND, alsMarkdown, gruende, zeile } from '../../scripts/module/warum.mjs';

const ev = (o: Record<string, unknown>) => ({ ts: Date.UTC(2026, 8, 16, 13, 45, 30), ...o });

describe('Journal-Leser: warum wurde nicht gehandelt', () => {
  it('liest den Blockier-Grund aus `note` und `text` — nicht aus `kind`', () => {
    // engine.ts schreibt den Blockier-TYP nach `note`, weil `kind` schon der
    // Ereignistyp des Journals ist. Wer das verwechselt, zeigt überall
    // „decision" an und nirgends den Grund.
    const z = zeile(ev({ kind: 'decision', note: 'blocked', text: 'Bargeld reicht nicht', symbol: 'BAC' }));
    expect(z.art).toBe('decision/blocked');
    expect(z.text).toBe('Bargeld reicht nicht');
    expect(z.symbol).toBe('BAC');
    expect(z.t).toBe('13:45:30');
  });

  it('zählt die Gründe — die Antwort steht in der häufigsten Zeile, nicht in der jüngsten', () => {
    const g = gruende([
      ev({ kind: 'decision', note: 'blocked', text: 'Plätze belegt', symbol: 'AAPL' }),
      ev({ kind: 'decision', note: 'blocked', text: 'Plätze belegt', symbol: 'MSFT' }),
      ev({ ts: Date.UTC(2026, 8, 16, 19, 0, 0), kind: 'decision', note: 'decision', text: 'Einstieg', symbol: 'BAC' }),
    ]);
    expect(g[0]!.anzahl).toBe(2);
    expect(g[0]!.text).toBe('Plätze belegt');
    expect([...g[0]!.symbole].sort()).toEqual(['AAPL', 'MSFT']);
    expect(g[1]!.text).toBe('Einstieg');
  });

  it('WÄCHTER: „kein Eintrag" wird als NICHT BEURTEILT ausgewiesen — nicht als stilles Einverständnis', () => {
    const md = alsMarkdown([{ uid: 'u1', events: [] }], { symbol: 'BAC', stunden: 24 });
    expect(md).toContain('Kein Eintrag');
    expect(md, 'der Unterschied muss dastehen, sonst wiederholt sich der Fehler vom 16.09.').toMatch(/etwas anderes als .entschieden und abgelehnt/);
  });

  it('nennt Symbol und Zeitraum im Kopf — ein Bericht ohne Bezug ist wertlos', () => {
    expect(alsMarkdown([], { symbol: 'BAC', stunden: 6 })).toContain('Symbol BAC, letzte 6 h');
    expect(alsMarkdown([], { stunden: 6 })).toContain('alle Symbole, letzte 6 h');
  });

  it('die erklärenden Ereignisarten schließen die ein, an denen ein Einstieg hängt', () => {
    for (const k of ['decision', 'intent', 'order', 'fill', 'trade', 'halt']) expect(ERKLAEREND, k).toContain(k);
  });

  it('WÄCHTER: ein gekürztes Fenster wird gemeldet — sonst liest sich die Kürzung wie ein Befund', () => {
    /*
     * Der erste Lauf (17.09.2026) fragte mit `orderBy asc` und filterte das
     * Symbol danach in JS. Das Journal war voll mit einer Notiz je Minute,
     * also kamen die ÄLTESTEN 400 Ereignisse zurück, BAC war nicht darunter,
     * und der Bericht meldete „kein Eintrag" — über ein Symbol, das er nie
     * gesehen hatte. Die Abfrage liest jetzt jüngste-zuerst; wo das Limit
     * trotzdem greift, MUSS es dastehen.
     */
    const md = alsMarkdown([{ uid: 'u1', events: [], gekuerzt: { limit: 400, abIso: '2026-09-16T17:58:03.000Z' } }], { symbol: 'BAC', stunden: 48 });
    expect(md).toContain('Fenster gekürzt');
    expect(md).toContain('400');
    expect(md, 'der Leser muss sagen, bis wohin er überhaupt geschaut hat').toContain('2026-09-16T17:58:03.000Z');
    expect(md, 'ohne diesen Satz wiederholt sich der Fehlalarm').toMatch(/nur .nicht in diesem Ausschnitt/);
  });

  it('ohne Kürzung steht die Warnung NICHT da — sonst wird sie zum Hintergrundrauschen', () => {
    expect(alsMarkdown([{ uid: 'u1', events: [] }], { symbol: 'BAC', stunden: 48 })).not.toContain('Fenster gekürzt');
  });

  it('kürzt lange Symbollisten, ohne die Zahl zu verschweigen', () => {
    const viele = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((s) => ev({ kind: 'decision', note: 'blocked', text: 'x', symbol: s }));
    const md = alsMarkdown([{ uid: 'u1', events: viele }], { stunden: 1 });
    expect(md).toContain('… (8)');
  });
});
