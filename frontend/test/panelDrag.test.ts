/**
 * Wächter des Pointer-Drags (Owner 21.08.: „Karten an den Mauszeiger oder
 * Finger anheften und animiert an die neue Stelle gleiten; im Tool
 * rumschieben").
 *
 * Die Regeln: KEIN HTML5-DnD mehr (kann weder Touch noch eigenen Clone),
 * das Original bleibt als Platzhalter im Fluss, ein ID-bereinigter Clone
 * folgt dem Zeiger, Nachbarn gleiten per FLIP, Karten dürfen zwischen
 * leftCol und rightCol wechseln (Spalte wird im Workspace persistiert),
 * und reduzierte Bewegung bekommt harte Schnitte bei voller Funktion.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const data = lese('../src/data.ts');
const css = lese('../src/theme.css');
const drag = dashboard.match(/function startePanelDrag[\s\S]*?\n\}/)?.[0] ?? '';

describe('Pointer-Drag — Anheften, FLIP-Gleiten, Spaltenwechsel', () => {
  it('HTML5-DnD ist vollständig ersetzt', () => {
    expect(dashboard).not.toContain('dragstart');
    expect(dashboard).not.toContain('dataTransfer');
    expect(dashboard).not.toContain('draggable');
    expect(dashboard).toContain('startePanelDrag(card, ev);');
  });

  it('ein Klick bleibt ein Klick — Drag erst ab 5 px Bewegung', () => {
    expect(drag).toContain('if (Math.hypot(px - start.clientX, py - start.clientY) < 5) return;');
    // Nie bewegt → kein Commit, kein Klick-Guard — der Titelzeilen-Handler übernimmt.
    expect(drag).toContain('if (!clone) return;');
  });

  it('der Clone ist ID-bereinigt — Renderer dürfen nie in den Geist malen', () => {
    expect(drag).toContain("c.removeAttribute('id');");
    expect(drag).toContain("c.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));");
    expect(drag).toContain("c.classList.add('panel-fliegt');");
  });

  it('Nachbarn gleiten per FLIP, reduzierte Bewegung bekommt den harten Schnitt', () => {
    expect(drag).toContain('const vorher = messeAlle();');
    expect(drag).toMatch(/\{ transform: `translate\(\$\{dx\}px, \$\{dy\}px\)` \}, \{ transform: 'translate\(0, 0\)' \}/);
    // Beide Animations-Pfade prüfen die Systempräferenz.
    expect(drag).toContain('if (reduzierteBewegung) return;');
    expect(drag).toContain('if (reduzierteBewegung) {');
    // Sicherheitsnetz gegen stehende Animations-Uhren (gleiche Lehre wie #382).
    expect(drag).toContain('window.setTimeout(weg, 400);');
  });

  it('Spaltenwechsel: Ziel ist die Sidebar unter dem Zeiger, sonst bleibt alles', () => {
    expect(drag).toContain('px >= r.left && px <= r.right;');
    // Drop friert Reihenfolge UND Spalte ein; der Klick-Guard fällt hier.
    expect(drag).toContain('commitPanelOrder();');
    expect(drag).toContain('dragEndeUm = Date.now();');
  });

  it('unterste Position (Owner-Befund 21.08.): stabil einsortieren, ans echte Ende hängen', () => {
    // Entscheidung im Fluss OHNE die gezogene Karte — sonst ist die Wahl
    // bistabil und die Karte flattert am Listenende (Ping-Pong).
    expect(drag).toContain('basisTop - rKarte.height - luecke');
    // „Ans Ende" ist appendChild — der alte .sb-rs-Anker steht nach
    // applyPanelOrder am SPALTENANFANG und sortierte nach ganz oben.
    // (Auf den echten Aufruf gepinnt — Kommentare dürfen .sb-rs erklären.)
    expect(drag).not.toContain("querySelector(':scope > .sb-rs')");
    expect(drag).toContain('else ziel.appendChild(card);');
    // Der Boot-Spaltenumzug nutzt denselben Weg.
    expect(dashboard).not.toContain("ziel.insertBefore(card, ziel.querySelector(':scope > .sb-rs'));");
    // Persistenz-Vereinigung: Auch Nicht-Registry-Karten (haltedauer,
    // erkenntnisse) behalten ihre sortierten Positionen — sonst rutscht
    // eine ans Ende gezogene Karte beim nächsten Laden zurück.
    expect(dashboard).toContain(
      '[...new Set([...Object.keys(PANEL_TITLES), ...Object.keys(st.wsOrder), ...Object.keys(st.wsCol)])]',
    );
  });

  it('die Spalte wird persistiert und beim Laden streng validiert', () => {
    expect(dashboard).toContain("st!.wsCol[c.dataset.panel ?? ''] = colId;");
    expect(dashboard).toContain("...(st!.wsCol[id] !== undefined ? { col: st!.wsCol[id] } : {}),");
    expect(dashboard).toContain("cfg?.col === 'leftCol' || cfg?.col === 'rightCol'");
    // applyPanelOrder stellt Karten mit gespeicherter Spalte um, bevor sortiert wird.
    expect(dashboard).toContain('for (const [id, colId] of Object.entries(st.wsCol)) {');
    expect(data).toContain("col?: 'leftCol' | 'rightCol'");
  });

  it('Zitter-Fix (Owner 12:35): Einsortieren rechnet auf Layout-, nie auf FLIP-Zwischenständen', () => {
    // Während Nachbarn gleiten, ist ihr getBoundingClientRect transient —
    // eine Entscheidung darauf kippt hin und her (Zittern + Dauer-FLIPs).
    expect(drag).toContain('const flipVersatz = (el: HTMLElement)');
    expect(drag).toContain('new DOMMatrixReadOnly(t)');
    expect(drag).toContain('const basisTop = r.top - flipVersatz(s).y;');
    // Auch das FLIP-Delta zielt auf die Layout-Ruhe, nicht den Rest-Translate.
    expect(drag).toContain('const dx = alt.left - (neu.left - v.x);');
  });

  it('Griff-Pille (Owner 12:35): der Geist ist der Karten-Kopf und klebt am Grip', () => {
    // Große Module hingen als voller Glass-Klotz am Finger — jetzt fliegt
    // nur der Kopf (Body aus, Breite gedeckelt), der Grip exakt unterm Zeiger.
    expect(drag).toContain('const pillenB = Math.min(r0.width, 340);');
    expect(drag).toContain("if (body) body.style.display = 'none';");
    expect(drag).toContain('const ankerX = Math.min(Math.max(pillenB - gripVonRechts, 24), pillenB - 12);');
    expect(drag).toContain('`translate(${px - ankerX}px, ${py - offYc}px) rotate(1.5deg)`');
    // Abhebe-Pop nur ohne reduzierte Bewegung.
    expect(drag).toContain('scale(.9)');
    // DIE „komische Grafikbox": Der Clone erbt mit .card die cardIn-
    // Animation (fill both, transform none) — sie überschreibt den
    // inline-translate zum Zeiger. animation:none am Geist ist tragend.
    expect(css).toMatch(/\.panel-fliegt \{[^}]*animation: none;/);
    // Doppelklasse: .card { animation: cardIn } steht später im Blatt und
    // gewinnt sonst bei gleicher Spezifität — der Geist stünde wieder fest.
    expect(css).toContain('.card.panel-fliegt { animation: none; }');
  });

  it('Mittelspalte (Owner 21.08.): Reorder per Grip, aber nie Main↔Sidebar', () => {
    // Die Hauptansicht bekommt eine Spalten-Id und ihre Karten den Grip —
    // sortiert wird NUR innerhalb der Mitte (Chart-Werkbank bleibt).
    expect(dashboard).toContain('<div class="col-m" id="centerCol">');
    expect(dashboard).toContain("const inMitte = card.parentElement?.id === 'centerCol';");
    expect(drag).toContain("quelle.id === 'centerCol'");
    expect(drag).toContain("(quelle.id === 'centerCol' ? ['centerCol'] : ['leftCol', 'rightCol'])");
    // Ordnung wird für alle drei Spalten eingefroren, die SPALTE nur für
    // Sidebars — der Lade-Pfad validiert weiter auf die zwei Sidebar-Ids.
    expect(dashboard).toContain("for (const colId of ['leftCol', 'rightCol', 'centerCol'] as const) {");
    expect(dashboard).toContain("if (colId !== 'centerCol') st!.wsCol[c.dataset.panel ?? ''] = colId;");
    expect(dashboard).toContain("for (const colId of ['leftCol', 'rightCol', 'centerCol']) {");
    // sig-grid (Signal-Kacheln, kein Karten-Kopf) sortiert als
    // [data-panel]-Geschwister mit — sonst rutschte es beim Boot-appendChild
    // vor alle Karten.
    expect(drag).toContain(":scope > [data-panel]");
  });

  it('CSS: der fliegende Clone existiert, der Grip blockt Touch-Scroll', () => {
    expect(css).toContain('.panel-fliegt { position: fixed;');
    expect(css).toContain('.sect-grip { touch-action: none; }');
  });

  it('Stufe B: der Grip bleibt am Finger sichtbar — nur der Spalten-Resize verschwindet', () => {
    // Vor Stufe B versteckte diese Regel `.sb-rs, .sect-grip` gemeinsam —
    // damit gab es auf Touch-Geräten keinen Startpunkt für den Drag.
    expect(css).toMatch(/@media \(max-width: 900px\), \(pointer: coarse\) and \(max-width: 1200px\) \{[\s\S]*?\.sb-rs \{ display: none; \}/);
    expect(css).not.toMatch(/\.sb-rs, \.sect-grip \{ display: none; \}/);
  });

  it('Stufe B: gestapelte Spalten treffen per Punkt, die Kante scrollt selbst nach', () => {
    // Punkt-Treffer zuerst (Smartphone: beide Spalten gleiche Breite),
    // horizontaler Treffer als Desktop-Fallback.
    expect(drag).toContain('return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;');
    // Autoscroll in beide Richtungen + Selbstantrieb, solange der Zeiger
    // an der Kante steht (dort kommen keine pointermove-Events mehr).
    expect(drag).toContain('if (py < RAND) window.scrollBy(0, -Math.ceil((RAND - py) * 0.35));');
    expect(drag).toContain('if (py < RAND || py > window.innerHeight - RAND) raf = requestAnimationFrame(bewege);');
    // Haptik nur für echte Finger.
    expect(drag).toContain("if (start.pointerType !== 'mouse') navigator.vibrate?.(10);");
  });
});
