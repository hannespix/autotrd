/**
 * Task 23 (Owner 09.10.: „überall im Tool, wo Symbole vorkommen, draufklicken
 * können … im Popup die detaillierten Informationen"): EIN Etikett-Erzeuger,
 * EIN Klick-Pfad in der Capture-Phase, und jede Symbol-Anzeige nutzt ihn.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');

describe('Symbol-Etikett → Detailblatt', () => {
  it('das Etikett ist Opt-in (Klasse), trägt data-sym für den Steckbrief und ist per Tastatur erreichbar', () => {
    expect(dashboard).toContain('return `<span class="sym-link" data-sym="${escText(sym)}" role="link" tabindex="0" title="${escText(t(\'sym.detailTitel\'))}">`');
  });

  it('EIN Klick-Pfad in der Capture-Phase — die Zeile darunter (Chart, Journal, HUD) bekommt den Klick nicht', () => {
    const fn = dashboard.slice(dashboard.indexOf('function wireSymbolLinks'), dashboard.indexOf('const MODAL_IDS'));
    expect(fn).toContain("document.addEventListener('click', (e) => {");
    // Der Klick-Block als Ganzes: Stoppen, Langdruck-Sperre, Öffnen — und
    // das Ganze in der Capture-Phase. (Der Tastatur-Block hat dieselben zwei
    // Stop-Zeilen; der Anker muss deshalb den Langdruck-Satz einschließen.)
    expect(fn).toContain(
      "    if (!el) return;\n    e.stopPropagation();\n    e.preventDefault();\n"
      + "    if (druckAb > 0 && Date.now() - druckAb > 400) return;\n"
      + "    const sym = el.dataset.sym;\n    if (sym) void oeffneSymbolDetail(sym);\n"
      + "  }, { capture: true, signal: docListenerSignal() });\n  document.addEventListener('keydown'",
    );
    expect(fn).toContain("    e.stopPropagation();\n    e.preventDefault();\n    const sym = el.dataset.sym;\n    if (sym) void oeffneSymbolDetail(sym);\n  }, { capture: true, signal: docListenerSignal() });\n}");
    expect(dashboard).toContain('  wireSymbolTip();\n  wireSymbolLinks();');
  });

  it('beliebiges Symbol: Klarname aus dem Katalog, market-Doc einmalig nachgeladen, alte Antwort verworfen', () => {
    expect(dashboard).toContain('const name = symbolHerkunft(sym)?.name ?? sym;');
    expect(dashboard).toContain('const data = await ladeMarktDoc(sym).catch(() => null);');
    expect(dashboard).toContain('if (!st || lauf !== symbolDetailLauf) return;');
    expect(data).toContain("const snap = await getDoc(doc(db(), 'market', symbol));");
  });

  it('alle Symbol-Anzeigen nutzen das Etikett: Chart-Kopf, HUD, Signale, Positionen, Historie, Absagen, Journal, Momentum, Journal-Karte, Abgleich', () => {
    for (const stelle of [
      "$('chSym').innerHTML = symbolEtikett(sym, false);",
      '<b>${symbolEtikett(sym, false)}</b>',
      'sigSym.innerHTML = symbolEtikett(sym);',
      'symTd.innerHTML = symbolEtikett(p.symbol, false);',
      'symZelle.innerHTML = symbolEtikett(t.symbol, false);',
      '<b class="abs-sym">${symbolEtikett(e.symbol, false)}</b>',
      '<h3>${symbolEtikett(row.symbol)}</h3>',
      '<span>${symbolEtikett(eintrag.symbol, false)}</span>',
      '${symbolEtikett(r.symbol, false)} · ${',
      '<td data-sym="${e(a.symbol)}">${symbolEtikett(a.symbol, false)}</td>',
      "`${symbolEtikett(x.symbol, false)} ${t('ab.buch')}",
    ]) {
      expect(dashboard, stelle).toContain(stelle);
    }
  });

  it('Eingabefelder, Suchlisten und Livebar-Kacheln bleiben KEINE Links (Fokus/Auswahl/Chart-Wechsel)', () => {
    expect(dashboard).not.toMatch(/mainHdSym[^\n]*sym-link/);
    expect(dashboard).not.toMatch(/gp-sym[^\n]*sym-link/);
    expect(dashboard).not.toMatch(/class="lb-item[^\n]*sym-link/);
    expect(dashboard).toContain("item.addEventListener('click', () => selectSymbol(sym));");
  });

  it('das Detailblatt liegt über dem Trade-Journal-Blatt; das Etikett zeigt den Zeiger', () => {
    expect(css).toContain('#detailModal { z-index: 230; }');
    expect(css).toContain('.sym-link { cursor: pointer;');
    expect(DE['sym.detailTitel']).toBeTruthy();
    expect(EN['sym.detailTitel']).toBeTruthy();
  });
});
