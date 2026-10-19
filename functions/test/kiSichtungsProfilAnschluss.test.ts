/**
 * Loop #138, 19.10.: Das Sichtungs-Profil ist nur dann eine Messung, wenn
 * JEDER Ausgang gezählt wird — ein vergessener Verfall-Weg sähe aus wie
 * „es gab keine Kandidaten". Quelltext-Wächter für die Verdrahtung.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const lauf = readFileSync(join(hier, '../src/scheduled/kiNachrichten.ts'), 'utf8');

describe('KI-Sichtungs-Profil im Lauf', () => {
  it('jede gesichtete Meldung zählt erst NACH erfolgreichem Ablegen', () => {
    expect(lauf).toContain(
      'if (!(await sichtungAblegen(m, eigene, kandidaten, fehlend, meta, aufrufId))) continue;\n        sichtungsProfilZaehlen(e.profil!, eigene, kandidaten.length);',
    );
  });

  it('alle vier Verfall-Wege der Gegenprobe zählen', () => {
    expect(lauf).toContain("...endUrteil(k.urteil, null, 'zu_alt') });\n        verfallen('zu_alt');");
    expect(lauf).toContain("...endUrteil(k.urteil, null, 'fehler') });\n          verfallen('fehler');");
    expect(lauf).toContain('if (ohne) verfallen(ohne);');
    expect(lauf).toContain("...endUrteil(k.urteil, null, 'budget') });\n          verfallen('budget');");
  });

  it('das Profil startet leer und landet im Tagestrichter (über e)', () => {
    expect(lauf).toContain('    profil: leeresSichtungsProfil(),\n');
    expect(lauf).toMatch(/kiTrichterTag\(\s*\{ trichter: vorher\.get\('trichter'\)[^)]*\},\s*e,/);
  });
});
