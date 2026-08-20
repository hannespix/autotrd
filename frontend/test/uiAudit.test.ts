/**
 * UI-Audit-Wächter (Owner 20.08.: „großes UI-Audit — mobil bedienbar,
 * Texte lesbar, ⓘ groß genug und gut erreichbar").
 *
 * Gemessen wurde im Browser (frontend/e2e/ui-audit.mjs, Emulator-Suite,
 * 4 Breiten × hell/dunkel): 36–176 Touch-Ziele je Ansicht unter 40 px,
 * alle 30 ⓘ-Knöpfe bei 16 px, Erklärtexte (.hint) bei 9 px, Hint-Kontrast
 * 3,49–3,74 statt 4,5. Diese Pins halten die Korrekturen fest — wer eine
 * Zahl hier verstellt, verstellt eine gemessene Bedienbarkeits-Grenze und
 * braucht einen neuen Browser-Nachweis, kein Bauchgefühl.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');

describe('Lesbarkeit — Schrift-Boden und Kontrast', () => {
  it('keine sichtbare Schrift unter 10 px mehr im Stylesheet', () => {
    // 8px (.mkt-cnm) und 9px (.hint, .lbl, .lb-sym, …) waren die Befunde.
    expect(css).not.toMatch(/font-size:\s*[89]px/);
  });

  it('Erklärtexte (.hint) stehen bei 11 px — sie sind Prosa, keine Deko', () => {
    expect(css).toContain('.hint { font-size: 11px;');
  });

  it('die t3-Textfarbe hält ≥4,5:1 gegen den Kartengrund (beide Themes)', () => {
    /* Gemessen vor dem Fix: dunkel 3,74, hell 3,49. Die Werte hier sind
     * gegen --card-solid (#0e1420) bzw. Weiß durchgerechnet: 5,43 / 5,3. */
    expect(css).toContain('--t3: #7e8ca6;');
    expect(css).toContain('--t3: #5e6c85;');
  });
});

describe('Bedienbarkeit — Trefferflächen', () => {
  it('ⓘ-Knöpfe sind 20 px groß (vorher 16) — der kleinste Knopf der App', () => {
    expect(css).toMatch(/\.ibtn \{[^}]*width: 20px; height: 20px;/);
  });

  it('am Touch-Gerät bekommen kleine Inline-Knöpfe das unsichtbare Polster', () => {
    /* Der ::after-Trick (inset −13 px) hebt 15–19-px-Zwerge (▾ ✕ ⠿, lchip,
     * hud-tgl) über die 40-px-Trefferfläche, ohne im Layout ein Pixel zu
     * bewegen. Die Selektor-Liste ist der Vertrag. */
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse.length).toBeGreaterThan(100);
    for (const sel of ['.ibtn::after', '.sect button::after', '.tf-btn::after', '.otab::after', '.legal-foot a::after', '.burg::after']) {
      expect(coarse, `${sel} fehlt im Touch-Polster`).toContain(sel);
    }
    expect(coarse).toContain('inset: -13px;');
    // <select> kann kein ::after tragen — Grundhöhe statt Polster.
    expect(coarse).toContain('select { min-height: 40px; }');
  });

  it('die unsichtbaren Polster erzeugen nie eine Querscroll-Leiste', () => {
    // Ein ::after am rechten Rand ragte sonst über den Viewport — gemessen
    // als scrollWidth 402 bei 390er-Schirm, bevor clip das abfing.
    expect(css).toContain('html { overflow-x: clip; }');
  });

  it('der Burger (☰) hat sein Polster direkt am Element — er ist die mobile Navigation', () => {
    expect(css).toMatch(/\.burg \{[^}]*padding: 10px; margin: -10px;/);
  });

  it('der Detail-Sheet-Schließer bleibt bei 40 px (Owner-Befund 20.08.)', () => {
    expect(css).toMatch(/\.dclose \{[^}]*width: 40px; height: 40px;/);
  });
});
