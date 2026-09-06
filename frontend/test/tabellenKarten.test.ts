/**
 * Wächter des mobilen Karten-Layouts (Owner 21.08.: „readability und
 * responsivität vor allem Smartphones"): Unter 480px wird die
 * Positionstabelle zu gestapelten Label:Wert-Karten. Die Pins sichern,
 * dass der Umbau vollständig im 480er-Media-Block wohnt (Desktop bleibt
 * echte Tabelle), dass die Labels aus data-th kommen und dass die Tabelle
 * die Karten-Klasse wirklich trägt.
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

describe('Karten-Layout der Positionstabelle (mobil)', () => {
  it('der Umbau wohnt in einem 480er-Media-Block und trägt alle Bausteine', () => {
    const block = kartenMedienBlock();
    expect(block).not.toBe('');
    // Kopfzeile weg, Zeilen und Zellen gestapelt, Labels aus data-th.
    expect(block).toContain('.tbl-karten thead { display: none; }');
    expect(block).toContain('content: attr(data-th)');
    // Die Ausblick-Zeile (Stop/Ziel/Strategie) klebt als Fuß an ihrer Positions-Karte …
    expect(block).toContain(':has(+ .pos-sub)');
    // … und ihre Zelle ist BLOCK, nicht flex: Die vielen Inline-Stücke
    // würden als Flex-Items ohne Umbruch aus der Karte ragen.
    expect(block).toMatch(/\.tbl-karten tr\.pos-sub td \{ display: block;/);
  });

  it('KEINE .tbl-karten-Regel außerhalb des Media-Blocks — Desktop bleibt Tabelle', () => {
    const block = kartenMedienBlock();
    const gesamt = css.split('.tbl-karten').length - 1;
    const imBlock = block.split('.tbl-karten').length - 1;
    expect(gesamt).toBeGreaterThan(0);
    expect(gesamt).toBe(imBlock);
  });

  it('die Positionstabelle trägt die Karten-Klasse, die Zeilen die data-th-Labels', () => {
    expect(dashboard.match(/class="tbl tbl-karten tbl-kompakt-pos"/g)?.length ?? 0).toBe(1);
    const block = kartenMedienBlock();
    // Die Positions-Karte ist ein Flex-Wrap-Layout: Kopf (Symbol + P&L + %
    // + Seite), ::after-Umbrecher mit der EINEN Trennlinie, Zahlenzeile
    // „Stück × Einstieg → aktuell".
    expect(block).toContain('.tbl-kompakt-pos tr { display: flex; flex-wrap: wrap;');
    expect(block).toContain(".tbl-kompakt-pos td:nth-child(3)::before { content: '×';");
    expect(block).toContain(".tbl-kompakt-pos td:nth-child(4)::before { content: '→';");
    expect(block).toContain('.tbl-kompakt-pos td[data-th]::before { content: none; }');
    expect(block).toContain('.tbl-kompakt-pos tr.pos-sub::after { content: none; }');
    expect(block).toContain('.tbl-kompakt-pos tr.pos-sub { display: block; }');
    expect(css).toContain('#pBody tr:not(.pos-sub) td:first-child { white-space: nowrap; }');
    // Kürzel-Labels sind in beiden Sprachen gleich und bleiben Literale …
    for (const label of ['Qty', 'P&amp;L', '%']) {
      expect(dashboard).toContain(`data-th="${label}"`);
    }
    // … echte Wörter laufen durchs Wörterbuch.
    for (const schluessel of ['tab.eintritt', 'tab.aktuell']) {
      expect(dashboard).toContain(`data-th="\${t('${schluessel}')}"`);
    }
    // Die siebte Zelle trägt die Seite (LONG/SHORT) — sie sitzt im Karten-Kopf.
    expect(dashboard).toContain('td class="pos-act"');
  });

  it('die Zeile unter jeder Position nennt Stop, Ziel und Schutz-Order — Stops liegen beim Broker', () => {
    const fn = dashboard.slice(dashboard.indexOf('function positionsAusblick'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain("t('eo.stop')");
    expect(block).toContain("t('eo.ziel')");
    expect(block).toContain("p.schutz?.orderId");
    expect(dashboard).toContain("t('pos.stopsBeimBroker')");
  });
});
