/**
 * Was der Kern als Halt-Grund kennt, muss die Karte auch benennen.
 *
 * Die Engine-Karte und „Warum handelt die Engine (nicht)?" übersetzen
 * `HaltReason` (src/core/types.ts) in Klartext. Kommt im Kern ein Grund
 * dazu, ohne dass die Tabelle im Dashboard nachzieht, stünde dort das rohe
 * Kürzel — und die Karte hätte keine Erklärung für genau die Sperre, die
 * gerade greift. Dieser Test liest BEIDE Dateien und vergleicht sie.
 *
 * Dazu die Regeln der Kommandos (CLAUDE.md §0.5: Sperren löst man über die
 * Ursache), so wie die Oberfläche sie dem Nutzer zeigen muss.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lese = (...teile: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', ...teile), 'utf8');
const dashboard = lese('frontend', 'src', 'dashboard.ts');
const types = lese('src', 'core', 'types.ts');

/** Die Halt-Gründe des Kerns aus der Typdefinition. */
function haltGruende(): string[] {
  const m = types.match(/export type HaltReason = ([^;]+);/);
  expect(m, 'HaltReason nicht gefunden').toBeTruthy();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

describe('Halt-Gründe: Kern und Karte kennen dieselben', () => {
  it('HALT_TEXT deckt jeden HaltReason ab', () => {
    const block = dashboard.match(/const HALT_TEXT: Record<string, string> = \{[\s\S]*?\};/)?.[0] ?? '';
    for (const g of haltGruende()) {
      // Schlüssel wie im Vertrag: daily_loss, drawdown, manual, errors, reconcile.
      expect(block, `HALT_TEXT ohne ${g}`).toMatch(new RegExp(`^\\s*${g}: t\\('halt\\.`, 'm'));
    }
  });

  it('„Warum handelt die Engine (nicht)?" hat für jeden Grund eine eigene Erklärung', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderEngineWhy'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(haltGruende()).toEqual(['daily_loss', 'drawdown', 'manual', 'errors', 'reconcile']);
    for (const k of ['ew.g.haltTag', 'ew.g.haltDrawdown', 'ew.g.haltManual', 'ew.g.haltReconcile', 'ew.g.haltErrors']) {
      expect(block, `${k} fehlt`).toContain(`t('${k}')`);
    }
  });

  it('der Test erkennt einen eingebauten Fehler', () => {
    const block = 'const HALT_TEXT: Record<string, string> = {\n  manual: t(\'halt.manual\'),\n};';
    expect(block).not.toMatch(/^\s*drawdown: t\('halt\./m);
  });
});

describe('Kommandos folgen den Regeln des Kerns', () => {
  const cmds = dashboard.match(/function renderEngineCommands[\s\S]*?\n\}/)?.[0] ?? '';

  it('Resume ist bei einem Tages-Halt gesperrt — er endet von selbst', () => {
    expect(cmds).toContain("h.reason === 'daily_loss'");
    expect(cmds).toContain("t('cmd.tagesHaltEndet')");
  });

  it('ein Drawdown-Halt verlangt die ausdrückliche Bestätigung', () => {
    const modal = dashboard.match(/function zeigeCmdModal[\s\S]*?\n\}/)?.[0] ?? '';
    expect(modal).toContain("st.engine?.halt?.reason === 'drawdown'");
    // Ohne Häkchen wird nichts gesendet — der Takt ignorierte das Resume ohnehin.
    expect(dashboard).toContain("$('cmdErr').textContent = t('cmd.ackFehlt');");
    expect(dashboard).toContain('ackDrawdown: true');
  });

  it('Halt wird sofort hinterlegt — es sperrt nur Einstiege, nie Exits', () => {
    expect(dashboard).toContain("void sendeKommando('halt', '', false)");
  });

  it('Flatten fragt nach — es ist unumkehrbar', () => {
    expect(dashboard).toContain("zeigeCmdModal('flatten')");
    expect(dashboard).not.toMatch(/sendeKommando\('flatten'/);
  });

  it('die Antwort heißt „hinterlegt", nicht „ausgeführt"', () => {
    // Der Takt führt aus — im nächsten Lauf. Eine Anzeige „erledigt" wäre gelogen.
    const fn = dashboard.match(/async function sendeKommando[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("t('cmd.hinterlegt')");
    expect(fn).toContain("t('cmd.wirktNaechsterTakt')");
  });
});
