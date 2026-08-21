/**
 * Wächter des Symbol-Steckbriefs (Owner 21.08., 16:5x: „mehr Infos zu den
 * einzelnen Symbolen … welche Marken/welche Märkte, was verbirgt sich hinter
 * dem Kürzel — sei kreativ, ohne zu überladen").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '@autotrd/shared';
import { STECKBRIEFE, steckbriefText, symbolHerkunft } from '../src/symbolSteckbrief.js';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');

const alleSymbole = Object.values(CATALOG)
  .flatMap((gruppen) => Object.values(gruppen))
  .flatMap((eintraege) => eintraege.map(([s]) => s));

describe('Steckbrief-Daten — jeder Katalog-Eintrag hat eine echte Erklärung', () => {
  it('ALLE Katalog-Symbole tragen eine kuratierte Beschreibung', () => {
    const ohne = alleSymbole.filter((s) => !STECKBRIEFE[s]);
    expect(ohne, `ohne Steckbrief: ${ohne.join(', ')}`).toEqual([]);
  });

  it('keine Karteileichen — jeder Steckbrief gehört zu einem Katalog-Symbol', () => {
    const katalog = new Set(alleSymbole);
    const fremd = Object.keys(STECKBRIEFE).filter((s) => !katalog.has(s));
    expect(fremd, `nicht im Katalog: ${fremd.join(', ')}`).toEqual([]);
  });

  it('Beschreibungen sind eine kompakte Zeile — nicht überladen, nie leer', () => {
    for (const [sym, text] of Object.entries(STECKBRIEFE)) {
      expect(text.length, `${sym}: zu kurz`).toBeGreaterThan(20);
      expect(text.length, `${sym}: zu lang (${text.length})`).toBeLessThanOrEqual(160);
    }
  });

  it('symbolHerkunft liefert Klasse, Gruppe und Klarnamen aus dem Katalog', () => {
    const xlk = symbolHerkunft('XLK');
    expect(xlk?.gruppe).toBeTruthy();
    expect(xlk?.name).toBe('Technology');
    expect(symbolHerkunft('GIBTSNICHT')).toBeNull();
    // Fallback bleibt ehrlich: unbekanntes Symbol ⇒ leerer Text, kein Erfinden.
    expect(steckbriefText('GIBTSNICHT')).toBe('');
  });
});

describe('Steckbrief-UI — Hover am PC, langes Drücken am Touch, Portal an body', () => {
  it('Livebar-Kacheln und Signal-Zeilen tragen den data-sym-Anker', () => {
    expect(dashboard).toContain('item.dataset.sym = sym; // Anker für den Symbol-Steckbrief (16:5x)');
    expect(dashboard).toContain('tr.dataset.sym = sym; // Anker für den Symbol-Steckbrief (16:5x)');
  });

  it('ÜBERALL, wo Symbole stehen (Owner 18:1x): alle Anker im Selektor', () => {
    for (const anker of [
      '.lb-item[data-sym]',
      '#sigBody tr[data-sym]',
      '.mkt-cell[data-sym]',
      '#jBody tr[data-sym]',
      '#pBody tr[data-sym]',
      '#moTop .fl-row[data-sym]',
      '#mainHdSym[data-sym]',
    ]) {
      expect(dashboard, `Anker fehlt im Selektor: ${anker}`).toContain(anker);
    }
    // … und die Renderer setzen das Attribut wirklich:
    expect(dashboard).toContain('cell.dataset.sym = symbol; // Anker für den Symbol-Steckbrief (18:1x)');
    expect(dashboard).toContain('tr.dataset.sym = t.symbol; // Anker für den Symbol-Steckbrief (18:1x)');
    expect(dashboard).toContain('tr.dataset.sym = p.symbol; // Anker für den Symbol-Steckbrief (18:1x)');
    expect(dashboard).toContain(`data-sym="\${esc(eintrag.symbol)}"`);
    expect(dashboard).toContain('hd.dataset.sym = sym; // Anker für den Symbol-Steckbrief (18:1x)');
    // Der Raster-Aufbau setzt den Kopf-Wert an EIGENER Stelle — auch dort
    // muss der Anker mitkommen (E2E-Fund: value ohne data-sym).
    expect(dashboard).toContain(".dataset.sym = st.currentSymbol; // Anker für den Symbol-Steckbrief (18:1x)");
    // Der fokussierte Symbol-Sucher bleibt Kärtchen-frei (Vorschlagsliste!):
    // Guard im Anker + focusin räumt den Klick-Anflug-Timer ab.
    expect(dashboard).toContain('el === document.activeElement');
    expect(dashboard).toContain("document.addEventListener('focusin', (ev) => {");
  });

  it('Trade-Fenster zeigt die Zeile FEST — am Touch-Gerät ohne jede Geste', () => {
    expect(dashboard).toContain('<div class="hint sym-steck" id="mtSteck"></div>');
    expect(dashboard).toContain("const mtSteckText = steckbriefText(sym);");
    // Longpress-Kärtchen darf nie über dem öffnenden Detail-Sheet hängen.
    const openDetailKopf = dashboard.slice(dashboard.indexOf('function openDetail('));
    expect(openDetailKopf.slice(0, 400)).toContain('versteckeSymbolTip();');
  });

  it('das Kärtchen ist ein Portal an document.body — nie in einer Glass-Card (§6)', () => {
    expect(dashboard).toContain("symTipEl.id = 'symTip';");
    expect(dashboard).toContain('document.body.appendChild(symTipEl);');
    expect(css).toContain('.sym-tip { position: fixed; z-index: 300;');
    expect(css).toContain('pointer-events: none; }');
  });

  it('Maus wartet kurz, Touch braucht langen Druck, Wischen bricht ab', () => {
    expect(dashboard).toContain('}, 320);');
    expect(dashboard).toContain('}, 450);');
    expect(dashboard).toContain('symTipLangdruck = null; // Wischen ist Scrollen, kein Nachschlagen');
    expect(dashboard).toContain("if (ev.pointerType !== 'mouse') return;");
    expect(dashboard).toContain('wireSymbolTip();');
  });

  it('Detail-Modal zeigt dieselbe Zeile — dort ist Platz, dort steht sie immer', () => {
    expect(dashboard).toContain('<div class="hint sym-steck"></div>');
    expect(dashboard).toContain('const sText = steckbriefText(symbol);');
  });
});
