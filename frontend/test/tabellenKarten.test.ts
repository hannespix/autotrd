/**
 * Wächter des mobilen Karten-Layouts (Owner 21.08.: „readability und
 * responsivität vor allem Smartphones"): Unter 480px werden Signal- und
 * Positions-Tabelle zu gestapelten Label:Wert-Karten. Die Pins sichern,
 * dass der Umbau vollständig im 480er-Media-Block wohnt (Desktop bleibt
 * echte Tabelle), dass die Labels aus data-th kommen und dass beide
 * Tabellen die Karten-Klasse wirklich tragen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const css = lese('../src/theme.css');
const dashboard = lese('../src/dashboard.ts');

/** Der {…}-Block ab einer Selektor-/At-Regel-Position, per Klammer-Zählung. */
function blockAb(quelle: string, start: number): string {
  const auf = quelle.indexOf('{', start);
  let tiefe = 0;
  for (let i = auf; i < quelle.length; i++) {
    if (quelle[i] === '{') tiefe++;
    else if (quelle[i] === '}' && --tiefe === 0) return quelle.slice(start, i + 1);
  }
  return '';
}

/** Der 480er-Media-Block, der das Karten-Layout enthält. */
function kartenMedienBlock(): string {
  let idx = -1;
  for (;;) {
    idx = css.indexOf('@media (max-width: 480px)', idx + 1);
    if (idx < 0) return '';
    const block = blockAb(css, idx);
    if (block.includes('.tbl-karten')) return block;
  }
}

describe('Karten-Layout der Signal-/Positions-Tabellen (mobil)', () => {
  it('der Umbau wohnt in einem 480er-Media-Block und trägt alle Bausteine', () => {
    const block = kartenMedienBlock();
    expect(block).not.toBe('');
    // Kopfzeile weg, Zeilen und Zellen gestapelt, Labels aus data-th.
    expect(block).toContain('.tbl-karten thead { display: none; }');
    expect(block).toContain('content: attr(data-th)');
    // Der Exit-Ausblick klebt als Fuß an seiner Positions-Karte.
    expect(block).toContain(':has(+ .pos-sub)');
  });

  it('KEINE .tbl-karten-Regel außerhalb des Media-Blocks — Desktop bleibt Tabelle', () => {
    const block = kartenMedienBlock();
    const gesamt = css.split('.tbl-karten').length - 1;
    const imBlock = block.split('.tbl-karten').length - 1;
    expect(gesamt).toBeGreaterThan(0);
    expect(gesamt).toBe(imBlock);
  });

  it('beide Tabellen tragen die Karten-Klasse, die Zeilen die data-th-Labels', () => {
    expect(dashboard.match(/class="tbl tbl-karten"/g)?.length ?? 0).toBe(2);
    // Kürzel-Labels sind in beiden Sprachen gleich und bleiben Literale …
    for (const label of ['RSI', 'MACD', 'BB %', 'Signal', 'Qty', 'P&amp;L', '%']) {
      expect(dashboard).toContain(`data-th="${label}"`);
    }
    // … echte Wörter laufen durchs Wörterbuch (i18n-Wächter Tranche 5m).
    for (const schluessel of ['tab.konfluenz', 'tab.eintritt', 'tab.aktuell']) {
      expect(dashboard).toContain(`data-th="\${t('${schluessel}')}"`);
    }
    expect(dashboard).toContain('td class="pos-act"');
  });
});
