/**
 * Audit-Befund 11.08. (F6): drei Rechenwege für denselben Positionswert.
 *
 * Die Rechnung selbst prüft `shared/test/positionLage.test.ts`. Hier steht,
 * dass alle Anzeigen sie auch benutzen — genau das war der Befund:
 * Nicht die Formel wich ab, sondern der Umgang mit einem fehlenden Kurs, und
 * zwar auf demselben Bildschirm.
 *
 * Seit 21.08. sind es VIER: Die teilbare Depot-Karte verlässt die App und
 * darf erst recht keine anderen Zahlen zeigen als die Tabelle daneben —
 * ein Bild in fremden Zeitleisten kann man nicht nachkorrigieren.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DE } from '../src/i18n.js';
import { join } from 'node:path';

const quelle = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Alle vier Anzeigen rechnen mit derselben Funktion', () => {
  it('genau vier Aufrufe — Summe, Tabelle, Stop-Dialog, Teilen-Karte', () => {
    const treffer = quelle().match(/positionLage\(/g) ?? [];
    expect(treffer.length).toBe(4);
  });

  it('keine eigene P&L-Formel mehr im Dashboard', () => {
    /* Die alte Schreibweise `(avgEntry - kurs) * qty` in ihren Varianten.
     * Solange sie irgendwo steht, kann eine vierte Anzeige entstehen, die
     * wieder anders mit fehlenden Kursen umgeht. */
    const text = quelle();
    expect(text).not.toContain('(p.avgEntry - live) * p.qty');
    expect(text).not.toContain('(live - p.avgEntry) * p.qty');
    expect(text).not.toContain('(short ? p.avgEntry - kurs : kurs - p.avgEntry) * p.qty');
  });

  it('die Summe zählt die Positionen ohne Kurs', () => {
    const text = quelle();
    expect(text).toContain('if (lage.pnl === null) ohneKurs += 1;');
  });
});

describe('Fehlende Kurse stehen dran, statt als Null durchzugehen', () => {
  it('das unrealisierte Ergebnis wird markiert', () => {
    // Vorher stand hier eine glatte Summe, in der jede kurslose Position
    // stillschweigend mit 0 zählte — dieselbe Anzeige wie „steht genau auf
    // Einstand", nur dass niemand das wusste.
    expect(quelle()).toContain("ohneKurs > 0 ? `${money(openPnl)} *` : money(openPnl)");
  });

  it('und der Grund steht im Tooltip, mit Zahlen', () => {
    const text = quelle();
    expect(text).toContain("${t('pf.ohneKursA')} ${ohneKurs} ${t('pf.ohneKursB')} ${st.positions.length} ${t('pf.ohneKursC')}");
    // Der Wortlaut wohnt seit Tranche 5m im Wörterbuch (Task #139).
    expect(DE['pf.ohneKursC']).toContain('fehlt ein aktueller Kurs');
  });

  it('die Positionsüberschrift nennt es ebenfalls', () => {
    // Der Owner-Screenshot vom 10.08. zeigte 128 von 132 Symbolen ohne Kurs.
    // Auf einen Tooltip zu zeigen reicht dort nicht — es muss ohne Mauszeiger
    // sichtbar sein.
    expect(quelle()).toContain("${ohneKurs} ${t('pf.ohneKurs')}");
  });

  it('der Stop-Dialog zeigt „—" statt einer erfundenen Null', () => {
    const text = quelle();
    const ab = text.indexOf('function zeigeStopDialog(');
    const block = text.slice(ab, text.indexOf('.join(\'\');', ab));
    expect(block).toContain("pnl === null ? '—'");
  });

  it('der Wert bleibt trotzdem auf Einstand — die Equity bricht nicht ein', () => {
    /* Die Position aus dem Depotwert zu streichen wäre schlimmer: Der
     * Depotwert bräche scheinbar ein, und die Notbremse rechnete am nächsten
     * Tag gegen eine Bezugsgröße, die es nie gab. */
    const text = quelle();
    expect(text).toContain('posValue += lage.wert;');
  });
});
