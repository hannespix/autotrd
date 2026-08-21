/**
 * Wächter der News-Bubble-Position (Owner-Bug 21.08.: „Position hängt an der
 * linken Sidebar, rutscht unter die rechte Sidebar").
 *
 * Wurzelursache damals: #evTip hing in der Chart-Glass-Card. Deren
 * backdrop-filter macht die Card zum Containing Block für position:fixed
 * (die Viewport-Koordinaten wurden gegen die Karten-Box aufgelöst — Versatz
 * = Sidebar-Breite) und zum eigenen Stacking Context (z-index 200 war
 * eingesperrt, die später gemalte rechte Spalte lag drüber). Der Fix ist ein
 * Portal an document.body. Diese Pins halten das Portal, sein Aufräumen beim
 * Unmount und die Klemmung des Touch-Zweigs fest.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dashboard = lese('../src/dashboard.ts');
const css = lese('../src/theme.css');

describe('News-Bubble — Portal an document.body', () => {
  it('showNewsTooltip portalt die Bubble VOR dem Messen/Positionieren', () => {
    const fn = dashboard.match(/function showNewsTooltip[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toBe('');
    // Echter Aufruf am Zeilenanfang — ein auskommentierter zählt nicht.
    expect(fn).toMatch(/^\s*if \(tip\.parentElement !== document\.body\) document\.body\.appendChild\(tip\);/m);
    // … und zwar bevor offsetWidth/offsetHeight gemessen werden.
    expect(fn.indexOf('document.body.appendChild(tip)')).toBeLessThan(fn.indexOf('tip.offsetWidth'));
  });

  it('unmountDashboard räumt das Portal — sonst bleibt nach Logout ein ID-Zwilling', () => {
    const fn = dashboard.match(/export function unmountDashboard[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/^\s*document\.getElementById\('evTip'\)\?\.remove\(\);/m);
  });

  it('Touch-Zweig klemmt an den Chart-Anker — Bubble nie über der Preisachse', () => {
    const fn = dashboard.match(/function showNewsTooltip[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('const g = anker?.getBoundingClientRect();');
    expect(fn).toContain('g.right - w - 4');
  });

  it('.evtip bleibt fixed mit z-index 200 (über Vollbild 150, unter Modals 220)', () => {
    const block = css.match(/\.evtip \{[\s\S]*?\}/)?.[0] ?? '';
    expect(block).toContain('position: fixed');
    expect(block).toContain('z-index: 200');
  });

  it('Fokus-Netz (Owner 21.08.): Fokusverlust blendet die Bubble SOFORT aus', () => {
    // Die Touch-Lesezeit (4 s) bleibt Obergrenze — aber Tipp/Klick woanders,
    // Seiten-Scroll und Fenster-/Tab-Wechsel beenden die Bubble sofort.
    expect(dashboard).toContain('function versteckeEvTipSofort()');
    const netz = dashboard.match(/function wireEvTipFokusNetz[\s\S]*?\n\}/)?.[0] ?? '';
    // In der Bubble darf man lesen; im Chart übernimmt das Crosshair — als
    // PUNKT-Treffer (über der Zeichenfläche liegen Overlay-Ebenen, deren
    // target nicht im .tv-lightweight-charts-Teilbaum steckt).
    expect(netz).toContain("ziel?.closest('#evTip')");
    expect(netz).toContain("document.querySelectorAll('.tv-lightweight-charts')");
    expect(netz).toContain('if (inChartFlaeche) return;');
    expect(netz).toContain("window.addEventListener('scroll', versteckeEvTipSofort, { passive: true, signal: docListenerSignal() });");
    expect(netz).toContain("window.addEventListener('blur', versteckeEvTipSofort, { signal: docListenerSignal() });");
    expect(netz).toContain("if (document.visibilityState === 'hidden') versteckeEvTipSofort();");
    // Abmelde-Disziplin: alle Listener hängen am docListenerSignal (die
    // document-Listener im Haus-Muster — der F11-Zähl-Wächter zählt sie mit).
    expect((netz.match(/signal: docListenerSignal\(\)/g) ?? []).length).toBe(4);
    expect(dashboard).toContain('wireEvTipFokusNetz();');
    // Die Touch-Lesezeit bleibt als Obergrenze bestehen.
    expect(dashboard).toContain('}, 4000);');
  });

  it('die Bubble hängt im Layout-HTML NICHT mehr fest verdrahtet mit Logik am Card-Platz', () => {
    // Das Grund-HTML darf den Platzhalter tragen (Erst-Render), aber die
    // Doku-Zeile in CLAUDE.md §6 muss das Portal nennen — wer sie liest,
    // baut den Bug sonst originalgetreu wieder ein.
    const claudeMd = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    expect(claudeMd).toContain('Portal an `document.body`');
  });
});
