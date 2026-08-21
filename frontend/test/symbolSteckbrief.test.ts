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
    expect(xlk?.ausserhalbKatalog).toBeUndefined();
  });

  it('frei eingegebene Symbole (RCON & Co.) bekommen eine ehrliche Notversorgung', () => {
    // Owner 21:4x: „rcon hat zb noch keine Symbol Infos" — Alpaca kennt
    // Tausende Ticker, der Katalog 132. Klasse per Heuristik, Rest ehrlich.
    const rcon = symbolHerkunft('RCON');
    expect(rcon?.ausserhalbKatalog).toBe(true);
    expect(rcon?.klassenLabel).toBeTruthy();
    expect(rcon?.gruppe).toBe(''); // keine erfundene Gruppe
    expect(rcon?.name).toBe('RCON');
    // KEIN erfundener Beschreibungstext — der Aufrufer zeigt den Hinweis.
    expect(steckbriefText('RCON')).toBe('');
    expect(symbolHerkunft('  ')).toBeNull();
  });
});

describe('Steckbrief-UI — Hover am PC, langes Drücken am Touch, Portal an body', () => {
  it('Livebar-Kacheln und Signal-Zeilen tragen den data-sym-Anker', () => {
    expect(dashboard).toContain('item.dataset.sym = sym; // Anker für den Symbol-Steckbrief (16:5x)');
    expect(dashboard).toContain('tr.dataset.sym = sym; // Anker für den Symbol-Steckbrief (16:5x)');
  });

  it('ÜBERALL, wo Symbole stehen (Owner 18:1x + 21:2x): generischer Anker + Setz-Stellen', () => {
    // Der Anker ist GENERISCH — jede Stelle mit data-sym ist automatisch
    // Kärtchen-fähig; eine neue Symbol-Anzeige braucht nur das Attribut.
    expect(dashboard).toContain("const SYM_TIP_ANKER = '[data-sym]';");
    // … und die Renderer setzen das Attribut wirklich:
    expect(dashboard).toContain('cell.dataset.sym = symbol; // Anker für den Symbol-Steckbrief (18:1x)');
    expect(dashboard).toContain('tr.dataset.sym = t.symbol; // Anker für den Symbol-Steckbrief (18:1x)');
    expect(dashboard).toContain('tr.dataset.sym = p.symbol; // Anker für den Symbol-Steckbrief (18:1x)');
    expect(dashboard).toContain(`data-sym="\${esc(eintrag.symbol)}"`);
    expect(dashboard).toContain('hd.dataset.sym = sym; // Anker für den Symbol-Steckbrief (18:1x)');
    // Trade-Fenster hat eine EIGENE Auswahl (mtSelect) — auch dort der Anker.
    expect(dashboard).toContain(".dataset.sym = sym; // Anker für den Steckbrief (21:4x)");
    // Der Raster-Aufbau setzt den Kopf-Wert an EIGENER Stelle — auch dort
    // muss der Anker mitkommen (E2E-Fund: value ohne data-sym).
    expect(dashboard).toContain(".dataset.sym = st.currentSymbol; // Anker für den Symbol-Steckbrief (18:1x)");
    // Nachzügler-Runde (Owner 21:2x „noch nicht alle!"): Symbol-Sucher
    // (Haupt-Kopf, Raster-Panels — zentral in wireSymbolAuswahl),
    // Prognose-Labor-Kopf, Trade-Journal, Broker-Abgleich, Stop-Dialog.
    expect(dashboard).toContain('inp.dataset.sym = sym; // Anker für den Symbol-Steckbrief (21:2x)');
    expect(dashboard).toContain('if (inp.value) inp.dataset.sym = inp.value;');
    expect(dashboard).toContain("$('flSym').dataset.sym = sym;");
    expect(dashboard).toContain(`<span class="tn-nm" data-sym="\${esc(r.symbol)}">`);
    expect(dashboard).toContain(`<td data-sym="\${e(a.symbol)}">`);
    expect(dashboard).toContain(`<b style="min-width:64px" data-sym="\${escText(p.symbol)}">`);
    // Der fokussierte Symbol-Sucher bleibt Kärtchen-frei (Vorschlagsliste!):
    // Guard im Anker + focusin räumt den Klick-Anflug-Timer ab.
    expect(dashboard).toContain('el === document.activeElement');
    expect(dashboard).toContain("document.addEventListener('focusin', (ev) => {");
  });

  it('Symbole ohne Steckbrief bekommen den ehrlichen Hinweis, kein leeres Kärtchen', () => {
    expect(dashboard).toContain("herkunft?.ausserhalbKatalog === true");
    expect(dashboard).toContain("t('steck.ohneEintrag')");
    // Kein leerer Gruppen-Chip bei katalogfremden Symbolen.
    expect(dashboard).toContain('herkunft.gruppe ? `<span>${escText(herkunft.gruppe)}</span>` : \'\'');
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
