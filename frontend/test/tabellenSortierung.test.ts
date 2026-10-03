/**
 * Wächter der Spalten-Sortierung (Owner 21.08., 16:0x: „bei solchen Tabellen
 * soll man auch nach Spalten-Titeln per Titel-Klick sortieren können …
 * auf/abwärts je Klick") und der Dropdown-Farben im Dark-Theme.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');
const i18n = lese('../src/i18n.ts');

describe('Spalten-Sortierung — Klick auf den Titel, auf/ab im Wechsel', () => {
  it('beide Tabellen sind verdrahtet (idempotent über data-wired)', () => {
    expect(dashboard).toContain("wireSortKopf('sigBody', 'sig', sortiereSigZeilen);");
    expect(dashboard).toContain("wireSortKopf('jBody', 'jn', renderJournal);");
    expect(dashboard).toContain("if (!kopf || kopf.dataset.wired === '1') return;");
  });

  it('je Klick wechselt die Richtung, der Kopf trägt Pfeil und aria-sort', () => {
    expect(dashboard).toContain("alt?.idx === idx ? { idx, dir: alt.dir === 'auf' ? 'ab' : 'auf' } : { idx, dir: 'auf' }");
    expect(dashboard).toContain("h.classList.toggle('sort-auf', i === idx && neu.dir === 'auf');");
    expect(dashboard).toContain("h.setAttribute('aria-sort', neu.dir === 'auf' ? 'ascending' : 'descending');");
    expect(dashboard).toContain("th.title = t('tab.sortierenTitel');");
  });

  it('Auto-Signale: DOM-Sortierung ist zahlbewusst, Platzhalter immer ans Ende', () => {
    expect(dashboard).toContain("const zelleLeer = (s: string): boolean => s === '' || s === '--' || s === '—';");
    expect(dashboard).toContain("/-?\\d+(?:\\.\\d+)?/.exec(text.replace(/[$,%\\s]/g, ''))");
    expect(dashboard).toContain('if (zelleLeer(a.text)) return 1;');
    expect(dashboard).toContain('if (za !== null && zb !== null) return (za - zb) * dir || a.i - b.i;');
    // Frische Scan-Werte halten die Ordnung: paintRow und der Neuaufbau
    // wenden die gemerkte Sortierung erneut an (2 Aufrufe; die Kopf-
    // Verdrahtung übergibt zusätzlich die Funktions-Referenz).
    expect((dashboard.match(/sortiereSigZeilen\(\);/g) ?? []).length).toBe(2);
    expect(dashboard).toContain('sortiereSigZeilen(); // frisch gebaute Zeilen in die gemerkte Ordnung bringen');
  });

  it('Trade-Historie: sortiert die DATEN — die Zeit-Spalte wäre als Text falsch', () => {
    expect(dashboard).toContain('case 0: return x.executedAt;');
    expect(dashboard).toContain('default: return x.pnl ?? null; // offene Trades ohne P&L ⇒ ans Ende');
    expect(dashboard).toContain("if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;");
  });

  it('CSS: klickbare Köpfe mit Richtungs-Pfeil im Akzentton', () => {
    expect(css).toContain('.tbl th.sortierbar { cursor: pointer; user-select: none; -webkit-user-select: none; }');
    expect(css).toContain(".tbl th.sort-auf::after { content: ' ↑'; color: var(--ac); }");
    expect(css).toContain(".tbl th.sort-ab::after { content: ' ↓'; color: var(--ac); }");
  });

  it('der Titel-Tooltip existiert auf Deutsch und Englisch', () => {
    expect((i18n.match(/'tab\.sortierenTitel':/g) ?? []).length).toBe(2);
  });
});

describe('Dropdown-Farben (Owner 16:0x): native Popups folgen dem Theme', () => {
  it('color-scheme steht am Theme-Anker — dunkel als Default, hell bei data-theme', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='light']"));
    expect(root).toContain('color-scheme: dark;');
    const licht = css.slice(css.indexOf(":root[data-theme='light'] {"));
    expect(licht.slice(0, 200)).toContain('color-scheme: light;');
  });

  it('Optionen bekommen DECKENDE Theme-Farben — das Popup kann kein Glas', () => {
    expect(css).toContain('select.inp option { background: var(--card-solid); color: var(--t1); }');
  });
});
