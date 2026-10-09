/**
 * Task 20 (Owner 09.10.: „als Laie absolut nicht verständlich"): Die
 * Erkenntnisse-Karte spricht Klartext — Etikett nach Bedeutung, beschriftete
 * Zahlen statt roher Schlüssel, Alt-Sätze in Fachsprache werden nicht zitiert.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');

describe('Erkenntnisse in Klartext', () => {
  it('Etikett nach Bedeutung, Alt-Einträge behalten ihr bisheriges Etikett', () => {
    expect(dashboard).toContain('const tonRang: Record<string, number> = { problem: 0, hinweis: 1, gut: 2, offen: 3 };');
    expect(dashboard).toContain("(e.ton ? tonMarke[e.ton] : undefined) ?? marke[e.status] ?? ''");
    expect(css).toContain('.tn-tag.tn-prob { background: var(--rd-soft); color: var(--rd); }');
  });

  it('Belege beschriftet statt roher Schlüssel; Klasse beim Namen', () => {
    expect(dashboard).toContain('const belege = erBelegText(key, e.beleg);');
    expect(dashboard).not.toContain("`${k} ${typeof v === 'number' ? String(Math.round(v * 100) / 100)");
    expect(dashboard).toContain("case 'klasse': teile.push(CLASS_LABELS[String(v)] ?? String(v)); break;");
  });

  it('Alt-Sätze aus der Fachsprache-Zeit werden nicht zitiert, nur der Wechsel genannt', () => {
    expect(dashboard).toContain("letzter.klar\n          ? `<div class=\"er-vor\">${t('er.zuvor')}");
    expect(dashboard).toContain("t('er.zuvorAnders').replace('{0}', datum(letzter.at))");
  });

  it('alle neuen Texte in DE und EN', () => {
    for (const k of ['er.zuvorAnders', 'er.tonGut', 'er.tonProblem', 'er.tonHinweis', 'er.tonOffen', 'er.bTrades', 'er.bMessungen', 'er.bNachKosten', 'er.bTreffer', 'er.bGebuehren', 'er.bSignalVerkauf', 'er.bHaltedauer', 'er.bGetestet', 'er.bUebernommen'] as const) {
      expect(DE[k], `${k} ohne DE`).toBeTruthy();
      expect(EN[k], `${k} ohne EN`).toBeTruthy();
    }
    expect(DE['er.hinweis']).not.toMatch(/Mindest-n|Thesen/);
  });
});
