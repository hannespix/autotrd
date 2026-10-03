/**
 * Watchlist-Editor (Stufe 3b, Task 121) — Quelltext-Wächter.
 *
 * Der Befund davor: Seit dem „Automatisch gewählt"-Umbau (28.07.) gab es im
 * Dashboard KEINEN Weg mehr, `strategy.watchlist` zu bearbeiten — die Chips
 * unter „Beobachtet" sind reine Anzeige, die `wl-browse`-CSS war eine Leiche.
 * Damit war die komplette Server-Kette aus #283 (freie Symbole via
 * Alpaca-Universum: saveStrategy → Scan → Handel) für Nutzer unerreichbar:
 * Ein Feature, dessen einzige Eingangstür fehlt, existiert nicht.
 *
 * Die Wächter prüfen die Existenz UND die Eigenschaften, die den Editor von
 * einer zweiten Anzeige unterscheiden: Er schreibt über submitStrategy
 * (Serverfehler landen sichtbar in #stratErr), Enter nimmt auch freie
 * Symbole, und der Client hält die MAX_WATCHLIST-Grenze, statt den Server
 * eine sichere Absage schicken zu lassen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DE } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Watchlist-Editor — Markup und Verdrahtung', () => {
  it('Editor-Elemente existieren im Layout (wlEdit, wlInput, wlSymList, wlCount)', () => {
    for (const id of ['id="wlEdit"', 'id="wlInput"', 'id="wlSymList"', 'id="wlCount"']) {
      expect(dashboard, `${id} fehlt im Markup`).toContain(id);
    }
  });

  it('rendert aus der GESPEICHERTEN Strategie, nie optimistisch', () => {
    // fillForm läuft je User-Doc-Snapshot; der Editor hängt genau dort.
    const fill = dashboard.slice(dashboard.indexOf('function fillForm'));
    expect(fill.slice(0, 800)).toContain('renderWlEditor(s)');
  });

  it('Entfernen und Hinzufügen schreiben über submitStrategy (Serverfehler → #stratErr)', () => {
    const editor = dashboard.slice(dashboard.indexOf('function renderWlEditor'));
    const entfernen = editor.indexOf('watchlist: st.strategy.watchlist.filter((w) => w !== sym)');
    expect(entfernen, 'Chip-✕ schreibt nicht über die Strategie').toBeGreaterThan(0);
    const hinzu = dashboard.indexOf('watchlist: [...liste, sym]');
    expect(hinzu, 'Hinzufügen schreibt nicht über die Strategie').toBeGreaterThan(0);
    // Beide Wege laufen durch submitStrategy — die eine Stelle, die
    // Server-Absagen („weder Katalog noch Alpaca-Universum") anzeigt.
    expect((editor.slice(0, 2500).match(/submitStrategy\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('Enter nimmt die getippte Eingabe — freie Symbole erreichen den Server', () => {
    const wire = dashboard.slice(dashboard.indexOf('function wireWlEditor'));
    const enter = wire.indexOf("ev.key === 'Enter'");
    expect(enter).toBeGreaterThan(0);
    expect(wire.slice(enter, enter + 400)).toContain('wlHinzufuegen(inp.value)');
  });

  it('Client hält die MAX_WATCHLIST-Grenze mit Klartext', () => {
    const add = dashboard.slice(dashboard.indexOf('function wlHinzufuegen'));
    expect(add.slice(0, 900)).toContain('liste.length >= MAX_WATCHLIST');
    // Wortlaut wohnt seit 5o im Wörterbuch; die Grenze bleibt mit Klartext quittiert.
    expect(add.slice(0, 900)).toContain("t('wl.begrenztB')");
    expect(DE['wl.begrenztB']).toContain('erst eines entfernen');
  });

  it('der Editor ist verdrahtet (wireWlEditor wird im Init gerufen)', () => {
    expect(dashboard).toContain('wireWlEditor();');
  });
});
