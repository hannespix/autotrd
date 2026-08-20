/**
 * Wächter des Service-Worker-Caches (Live-Vorfall 20.08.).
 *
 * Die App zeigte „nur Hintergrund": Ein Asset-404 (Race mit dem
 * Deploy-Swap) war in den Cache gewandert und wurde per cache-first für
 * immer serviert — Reload und Browser-Cache-Leeren halfen nicht, erst der
 * nächste Deploy mit neuem Asset-Hash. Seitdem gilt: Der SW cached
 * AUSSCHLIESSLICH ok-Antworten, in allen drei Pfaden.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sw = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');

describe('Service Worker — niemals Fehlantworten cachen', () => {
  it('jedes cache.put steht hinter einem res.ok-Guard', () => {
    // Drei Cache-Pfade (Navigation, /assets/, stale-while-revalidate) —
    // dreimal put, dreimal Guard. Ein put ohne Guard ist die 404-Vergiftung.
    const puts = sw.match(/cache\.put\(/g) ?? [];
    const guards = sw.match(/if \(res\.ok\)/g) ?? [];
    expect(puts.length).toBe(3);
    expect(guards.length).toBe(3);
  });

  it('die Cache-Version ist gebumpt, damit vergiftete Bestände weggeräumt werden', () => {
    expect(sw).toContain("const VERSION = 'v3';");
  });
});
