/**
 * Statischer Abgleich: Wird eine Element-ID benutzt, die es im Markup gibt?
 *
 * ── Gegen welche Fehlerklasse das schützt ────────────────────────────────
 *
 * Das Frontend holt Elemente über einen Helfer, der ein Nicht-Finden
 * verschweigt:
 *
 *   const $ = (id: string): HTMLElement => document.getElementById(id)!;
 *
 * Das `!` ist eine Behauptung, keine Prüfung. Ein Tippfehler in der ID
 * kompiliert sauber durch — `HTMLElement` ist der versprochene Typ, egal
 * was zur Laufzeit herauskommt. Erst im Browser wird daraus ein
 * `Cannot read properties of null`, und weil das Dashboard sein Markup in
 * einem Rutsch aufbaut, reißt ein einziger solcher Zugriff die ganze
 * Oberfläche mit: weißer Screen statt einer kaputten Zeile.
 *
 * Genau diese Klasse fängt weder Typecheck noch Build noch die
 * bestehende Testsuite — die Oberfläche wird nirgends gerendert. Ein
 * statischer Abgleich kostet dagegen nichts und deckt sie vollständig ab:
 * Alle IDs stehen im selben Quellbaum, sowohl die benutzten als auch die
 * im Markup vergebenen.
 *
 * ── Warum nur diese Richtung ─────────────────────────────────────────────
 *
 * Eine ID im Markup OHNE Zugriff ist harmlos — sie kann für CSS, für
 * `querySelectorAll` oder als Ankerpunkt da sein. Die umgekehrte Richtung
 * ist der Fehler.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

/** Alle Frontend-Quellen als ein Text — Markup und Zugriffe liegen gemischt. */
function quellen(): Array<{ datei: string; text: string }> {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ datei: f, text: readFileSync(join(SRC, f), 'utf8') }));
}

/**
 * Im Markup vergebene IDs.
 *
 * Template-Literale mit `${…}` werden bewusst NICHT aufgelöst: Eine
 * dynamisch zusammengesetzte ID ist zur Prüfzeit unbekannt, und ein
 * Test, der sie zu raten versucht, meldet Fehlalarme statt Fehler.
 */
function vergebeneIds(alle: ReturnType<typeof quellen>): Set<string> {
  const out = new Set<string>();
  for (const { text } of alle) {
    for (const m of text.matchAll(/\bid=["']([A-Za-z][A-Za-z0-9_-]*)["']/g)) out.add(m[1]!);
    // Programmatisch gesetzte IDs (`el.id = 'foo'`) zählen genauso.
    for (const m of text.matchAll(/\.id\s*=\s*['"]([A-Za-z][A-Za-z0-9_-]*)['"]/g)) out.add(m[1]!);
  }
  return out;
}

/** Zugriffe über den `$`-Helfer und über `getElementById`. */
function benutzteIds(alle: ReturnType<typeof quellen>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { datei, text } of alle) {
    for (const m of text.matchAll(/\$\(['"]([A-Za-z][A-Za-z0-9_-]*)['"]\)/g)) {
      out.set(m[1]!, datei);
    }
    for (const m of text.matchAll(/getElementById\(['"]([A-Za-z][A-Za-z0-9_-]*)['"]\)/g)) {
      out.set(m[1]!, datei);
    }
  }
  return out;
}

describe('Element-IDs: jeder Zugriff findet ein Element', () => {
  const alle = quellen();
  const vergeben = vergebeneIds(alle);
  const benutzt = benutzteIds(alle);

  it('greift auf keine ID zu, die es im Markup nicht gibt', () => {
    const fehlend = [...benutzt.entries()]
      .filter(([id]) => !vergeben.has(id))
      .map(([id, datei]) => `${id} (${datei})`);
    // Die Fehlermeldung nennt die ID UND die Datei — bei einem Tippfehler
    // will man nicht erst suchen müssen, wo er steht.
    expect(fehlend, `IDs ohne Element im Markup: ${fehlend.join(', ')}`).toEqual([]);
  });

  it('findet überhaupt etwas — der Test darf nicht still leerlaufen', () => {
    // Ein Test, der wegen einer geänderten Schreibweise nichts mehr
    // erkennt, ist schlimmer als keiner: Er meldet dauerhaft „grün".
    expect(benutzt.size).toBeGreaterThan(100);
    expect(vergeben.size).toBeGreaterThan(100);
  });

  it('erkennt einen eingebauten Fehler', () => {
    // Selbsttest der Erkennung: Eine erfundene ID muss auffallen.
    const kunstlich = new Map(benutzt).set('gibtEsNichtXyz', 'test');
    const fehlend = [...kunstlich.keys()].filter((id) => !vergeben.has(id));
    expect(fehlend).toContain('gibtEsNichtXyz');
  });
});
