/**
 * Anschluss-Wächter: Die Seitwärts-Bremse ist ANGESCHLOSSEN (Hebel 2, 15.08.).
 *
 * Der Serienfehler dieser Woche war mehrfach „Funktion korrekt, nur nicht
 * angeschlossen". Die Bremse hat vier Anschlüsse, und jeder ist einzeln
 * gepinnt: der zentrale Cooldown (deckt ALLE Einstiegs-Pfade), das Sizing
 * im Classic-Pfad (long + short), das Sizing der Regelbaum-Einstiege
 * (long + short) und die Tuner-Flotte (cooldownMin ist Gitter-Achse — ohne
 * Bremse kürte sie Sieger, die live gebremst würden). Dazu die Messbarkeit:
 * meta/health trägt je Lauf, was die Bremse angewandt hat.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const fleet = readFileSync(join(hier, '../src/core/tuneFleet.ts'), 'utf8');

describe('Seitwärts-Bremse — Anschluss-Wächter', () => {
  it('der zentrale Cooldown läuft durch die Bremse — EINE Zeile deckt alle Entry-Pfade', () => {
    expect(scan).toContain('const cdMin = regimeCooldownMin(cdBasis, regime);');
    // Die alte ungebremste Fassung ist restlos verschwunden.
    expect(scan).not.toContain('const cdMin = clamped.engine.cooldownMin ?? 15;');
  });

  it('Classic-Sizing (long UND short) trägt den Größen-Dämpfer', () => {
    const treffer =
      scan.match(/\* klassenGewicht\(clamped, symbol\) \* regimeGroessenFaktor\(regime\);/g) ?? [];
    expect(treffer, 'beide Classic-sizeFactor-Stellen erwartet').toHaveLength(2);
    // Keine ungebremste Fassung mehr.
    expect(scan).not.toContain('}) * klassenGewicht(clamped, symbol);');
  });

  it('Regelbaum-Einstiege (long UND short) tragen den Größen-Dämpfer', () => {
    const treffer = scan.match(/sizeFactor: regimeGroessenFaktor\(regime\),/g) ?? [];
    expect(treffer, 'beide Regelbaum-Einstiege erwartet').toHaveLength(2);
  });

  it('die Tuner-Flotte bekommt das Regime durchgereicht und bremst den Cooldown', () => {
    // Aufrufstelle in scanMarket: regime als letztes Argument.
    const aufruf = scan.indexOf('stepFleet(');
    expect(aufruf).toBeGreaterThan(0);
    expect(scan.slice(aufruf, aufruf + 500)).toContain('regime,');
    // Und in der Flotte selbst wirkt die Bremse auf den Varianten-Cooldown.
    expect(fleet).toContain(
      'const cdMin = regimeState ? regimeCooldownMin(cdBasis, regimeState) : cdBasis;',
    );
  });

  it('meta/health dokumentiert die angewandte Bremse je Lauf (Messbarkeit)', () => {
    const stelle = scan.indexOf('regimeBremse: {');
    expect(stelle, 'regimeBremse fehlt im Heartbeat').toBeGreaterThan(0);
    const block = scan.slice(stelle, stelle + 400);
    expect(block).toContain('cooldownFaktor');
    expect(block).toContain('groessenFaktor');
  });

  it('die Bremse fasst keine Exits an — sie hängt nur an Cooldown und Einstiegs-Sizing', () => {
    // Gegenrichtungs-Wächter wie bei der Mindesthalte: regimeGroessenFaktor
    // darf nirgends im Umfeld eines riskExit-/Schutz-Pfads auftauchen.
    for (const treffer of scan.matchAll(/riskExitReason\(/g)) {
      const umfeld = scan.slice(
        Math.max(0, (treffer.index ?? 0) - 300),
        (treffer.index ?? 0) + 300,
      );
      expect(umfeld).not.toContain('regimeGroessenFaktor');
      expect(umfeld).not.toContain('regimeCooldownMin');
    }
  });
});
