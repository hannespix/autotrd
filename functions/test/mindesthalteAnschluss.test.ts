/**
 * Anschluss-Wächter: Klassen-Mindesthalte wirkt ÜBERALL, wo Haltedauer
 * gerechnet wird (Hebel 1c, 15.08.).
 *
 * Der Serienfehler dieser Woche war dreimal „Funktion korrekt, nur nicht
 * angeschlossen". Hier ist der Anschluss sogar vierfach: Kosten-Tor,
 * Short-Leihe, Signal-Ausstieg und Schatten-/Flotten-Messung müssen mit
 * DERSELBEN wirksamen Mindesthalte rechnen — rechnet das Tor mit zwei Tagen,
 * die die Engine nicht erzwingt, ist die Kostenrechnung eine Lüge; erzwingt
 * die Engine zwei Tage, die die Messung nicht kennt, misst der Tuner
 * Varianten, die live nie existieren.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const fleet = readFileSync(join(hier, '../src/core/tuneFleet.ts'), 'utf8');

describe('Klassen-Mindesthalte — Anschluss-Wächter', () => {
  it('entrySperre rechnet Kosten-Tor UND Short-Leihe mit minHalte', () => {
    expect(scan).toContain(
      'const minHalte = wirksameMindesthalte(clamped.engine.minHoldMin, klasse);',
    );
    expect(scan).toContain('minHoldMin: minHalte,');
    expect(scan).toMatch(/shortFinanzierungPct\(\s*minHalte,/);
  });

  it('ALLE Signal-Ausstiege bremsen mit der wirksamen Mindesthalte', () => {
    const seitenscharf =
      scan.match(
        /minHoldActive\(pos\.openedAt, now, wirksameMindesthalte\(clamped\.engine\.minHoldMin, classify\(symbol\)\)\)/g,
      ) ?? [];
    expect(seitenscharf, 'vier Signal-Ausstiegs-Stellen erwartet').toHaveLength(4);
    // Die alte Fassung ohne Klassen-Boden ist restlos verschwunden.
    expect(scan).not.toContain('minHoldActive(pos.openedAt, now, clamped.engine.minHoldMin ?? 0)');
  });

  it('kostenVielfaches (Hebel-Ampel) rechnet mit derselben Zahl', () => {
    const stelle = scan.indexOf('const kostenVielfaches =');
    expect(stelle).toBeGreaterThan(0);
    expect(scan.slice(stelle, stelle + 500)).toContain(
      'minHoldMin: wirksameMindesthalte(clamped.engine.minHoldMin, klasse),',
    );
  });

  it('der Klassen-Schatten misst unter denselben Bedingungen', () => {
    const stelle = scan.indexOf('function schattenKostenOk');
    expect(stelle).toBeGreaterThan(0);
    expect(scan.slice(stelle, stelle + 600)).toContain(
      'wirksameMindesthalte(DEFAULT_STRATEGY.engine.minHoldMin, klasse)',
    );
  });

  it('die Tuner-Flotte misst Varianten mit dem Klassen-Boden', () => {
    expect(fleet).toContain('wirksameMindesthalte(minHold, classify(symbol))');
    // Auch hier: keine bodenlose Fassung mehr.
    expect(fleet).not.toContain('minHoldActive(nachPos.openedAt, now, minHold)');
  });

  it('Risiko-Exits bleiben unberührt — minHold bremst NUR Signal-Ausstiege', () => {
    // Die Wächter-Logik der Gegenrichtung: wirksameMindesthalte darf in
    // scanMarket nirgends in einem riskExit-/Schutz-Kontext auftauchen.
    // Grobe, aber wirksame Prüfung: Kein Aufruf im Umkreis von riskExitReason.
    for (const treffer of scan.matchAll(/riskExitReason\(/g)) {
      const umfeld = scan.slice(Math.max(0, (treffer.index ?? 0) - 300), (treffer.index ?? 0) + 300);
      expect(umfeld).not.toContain('wirksameMindesthalte');
    }
  });
});
