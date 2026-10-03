/**
 * Wächter der drei stillen Bremsen (Kapital-Panel 21.08., Hebel 1).
 *
 * Owner-Befund: „meistens nur 1–2 aktive Positionen, das Bargeld arbeitet zu
 * wenig." Welche Bremse das verursacht, war nicht zu beantworten:
 * Positions-Deckel, Cooldown und Sockel-Besitzgrenze waren nackte
 * `continue`-Zeilen. Ein Symbol, das an ihnen scheitert, sah im Heartbeat
 * exakt aus wie ein Symbol ohne Signal.
 *
 * Das Red-Team hat genau deshalb JEDE Verhaltensänderung abgelehnt, bevor
 * gezählt wird. Dieser Wächter hält die Zählung fest — und verhindert, dass
 * eine neue Bremse wieder still eingebaut wird.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scan = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts'), 'utf8');

describe('Jede Einstiegs-Bremse wird gezählt', () => {
  it('die drei Zähler stehen in der Gate-Struktur und in BEIDEN Initialisierungen', () => {
    const s = scan();
    for (const feld of ['pos_limit', 'cooldown_aktiv', 'sockel_besitz']) {
      expect(s, `${feld} fehlt in EntryGateStats`).toContain(`  ${feld}: number;`);
      // Zwei Init-Blöcke: der Konto-Lauf und das Scan-Aggregat.
      expect((s.match(new RegExp(`^\\s+${feld}: 0,$`, 'gm')) ?? []).length, feld).toBe(2);
    }
  });

  it('KEINE nackte continue-Zeile mehr an den Bremsen — sonst zählt sie niemand', () => {
    /* Die eigentliche Sperre: Wer eine dieser Zeilen kopiert (es gibt sie in
     * Regelbaum-, Strategie- und Classic-Pfad, long wie short), bekommt den
     * Zähler mit — oder dieser Test wird rot. */
    const s = scan();
    const nackt = [
      /if \(positions\.size >= posLimit\) continue;/,
      /if \(Object\.keys\(book\.positions\)\.length >= posLimit\) continue;/,
      /if \(cooldownActive\([^)]*\)\) continue;/,
      /if \(coreSymbols\.has\(symbol\)\) continue;/,
    ];
    for (const re of nackt) {
      expect(s, `nackte Bremse ohne Zähler: ${re}`).not.toMatch(re);
    }
  });

  it('alle Pfade zählen — long und short, Regelbaum, Strategie und Classic', () => {
    const s = scan();
    // 6 Positions-Deckel (2 Regelbaum + 4 übrige), 8 Cooldowns, 4 Sockel.
    expect((s.match(/gate\.pos_limit \+= 1;/g) ?? []).length).toBe(6);
    expect((s.match(/gate\.cooldown_aktiv \+= 1;/g) ?? []).length).toBe(8);
    expect((s.match(/gate\.sockel_besitz \+= 1;/g) ?? []).length).toBe(4);
  });

  it('das Regime meldet, wenn es MANGELS DATEN auf seitwärts steht', () => {
    /* Der Fallback halbiert die Positionsgröße wie ein echtes
     * Seitwärts-Regime. Wie oft er greift, hat vor dem 21.08. niemand
     * gemessen — das Red-Team hat es zur Bedingung gemacht, bevor über eine
     * Lockerung überhaupt gesprochen wird. */
    expect(scan()).toContain(
      'datenlos: regime.aboveSma200 === null && regime.realizedVolPct === null,',
    );
  });
});
