/**
 * Wächter der Sizing-Schattenmessung im Scan (Kapital-Panel 21.08., Hebel 2).
 *
 * Die Rechnung selbst prüft `shared/test/sizingSchatten.test.ts`. Hier steht
 * die Eigenschaft, auf der die ganze Maßnahme beruht:
 *
 *   **Die Messung ändert keine einzige Order.**
 *
 * Sie läuft NACH der Buchung, ihr Ergebnis fließt in kein qty, keinen Preis
 * und keinen Kontostand. Ginge das verloren, hätten wir statt einer
 * Schattenmessung eine unbewiesene Verhaltensänderung im Geld-Pfad — genau
 * das, was das Red-Team ausgeschlossen hat.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scan = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts'), 'utf8');

describe('Die Messung ändert nichts', () => {
  it('das Ergebnis wird nirgends zugewiesen oder weitergereicht', () => {
    const s = scan();
    expect(s).not.toMatch(/=\s*merkeSizing\(/);
    // Die pure Rechnung wird NUR im Sammler benutzt, nicht im Order-Pfad.
    expect((s.match(/\bsizingSchatten\(\{/g) ?? []).length).toBe(1);
    expect(s).not.toMatch(/executeTrade\([^;]*sizingSchatten/s);
    expect(s).not.toMatch(/sizeOrder\([^)]*sizingSchatten/);
  });

  it('gemessen wird erst NACH der Buchung — und nur bei echtem Trade', () => {
    const s = scan();
    expect(s).toContain('if (!r.executed || !r.trade) return;');
    const treffer = [...s.matchAll(/merkeSizing\(r, .+?\);/g)];
    expect(treffer.length).toBe(4);
    for (const m of treffer) {
      const davor = s.slice(Math.max(0, m.index! - 2500), m.index!);
      expect(davor, 'Aufruf ohne vorangehendes if (r.executed)').toContain('if (r.executed) {');
    }
  });

  it('vier echte Einstiege werden gemessen — Exits und Schattenbuch nie', () => {
    const s = scan();
    expect((s.match(/merkeSizing\(r, regimeGroessenFaktor\(regime\), symbol\);/g) ?? []).length).toBe(2);
    expect((s.match(/merkeSizing\(r, sizeFactor, symbol\);/g) ?? []).length).toBe(2);
    /* Exits schließen ganz — eine Größenfrage stellt sich dort nicht; und
     * der Schatten-Regelbaum (shadowTrade) bucht kein Geld. Beide dürfen
     * die Messreihe nicht verwässern. */
    for (const exit of ['Engine-Sell', 'Engine-Cover', 'Strategie-Sell']) {
      const i = s.indexOf(`logger.info(\`${exit}`);
      if (i < 0) continue;
      expect(s.slice(Math.max(0, i - 600), i), `${exit} wird gemessen`).not.toContain('merkeSizing(');
    }
    expect(s).not.toMatch(/shadowTrade\([^;]*merkeSizing/s);
  });

  it('das Aggregat steht im Heartbeat — mit ehrlichem null, wenn nicht gemessen wurde', () => {
    const s = scan();
    expect(s).toContain('let sizingSchattenLauf: SizingSchattenSumme | null = null;');
    expect(s).toContain('sizingSchattenLauf = res.sizing;');
    expect(s).toContain('sizingSchatten: sizingSchattenLauf,');
  });

  it('gemessen wird gegen den Stand VOR den Käufen dieses Laufs', () => {
    /* `kontoCash` ist bereits kapitalgedeckelt, `kontoWert` die Summe der
     * Positionswerte zu Beginn — zusammen der Entscheidungszeitpunkt. Würde
     * hier der laufende Kontostand benutzt, schrumpfte die Referenz mit
     * jedem Kauf und die Messung bewiese ihre eigene These. */
    const s = scan();
    expect(s).toContain('equity: kontoCash + kontoWert,');
    expect(s).toContain('deckung: kontoCash,');
  });
});
