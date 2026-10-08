/**
 * Task 19, Teil 2c: Fundamental-Schatten im Einstiegs-Tor — Quelltext-Wächter.
 * Die Zähler dürfen nur ZÄHLEN (nie in einen return/Grund münden), nur was
 * das scharfe Kosten-Tor durchlässt, und müssen im Herzschlag samt Deckung
 * ankommen — sonst misst niemand, was ein Veto kosten würde.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const bericht = readFileSync(join(hier, '../src/scheduled/kiBericht.ts'), 'utf8');

describe('Fundamental-Schatten (Task 19 Teil 2c)', () => {
  it('beurteilt aus Profil + Kennzahlen desselben Dokuments, Kalendertag in New York', () => {
    expect(scan).toContain("symDoc.get('profil') as Parameters<typeof fundamentalBefund>[0],");
    expect(scan).toContain("symDoc.get('kennzahlen') as Parameters<typeof fundamentalBefund>[1],");
    expect(scan).toContain('budgetTag(now),');
    expect(scan).toContain('atrPct: atrPctVal, news, fundamental });');
  });

  it('zählt nur, was das scharfe Tor durchlässt — und entscheidet nichts', () => {
    expect(scan).toContain('if (kosten.ok && fb?.gewinnterminNah) gate.gewinntermin_wuerde_blocken += 1;');
    expect(scan).toContain('if (kosten.ok && fb?.illiquide) gate.illiquide_wuerde_blocken += 1;');
    expect(scan).toContain('if (kosten.ok && fb?.kleinstwert) gate.kleinstwert_wuerde_blocken += 1;');
    // Kein Rückgabe-Grund, kein Sperr-Pfad aus dem Befund.
    expect(scan).not.toMatch(/return '(gewinntermin|illiquide|kleinstwert)/);
    expect(scan).not.toMatch(/fb\?\.(gewinnterminNah|illiquide|kleinstwert)\)\s*return/);
    expect(scan).not.toMatch(/fundamental\?\.(gewinnterminNah|illiquide|kleinstwert)\)\s*return/);
  });

  it('beide Zähler-Initialisierungen tragen die drei Felder; Herzschlag trägt Deckung + Zähler; Lagebericht nimmt sie', () => {
    expect(scan.match(/gewinntermin_wuerde_blocken: 0,\n {4}illiquide_wuerde_blocken: 0,\n {4}kleinstwert_wuerde_blocken: 0,/g)).toHaveLength(2);
    expect(scan).toContain('fundamentalSchatten: fundamentalSchattenStand([...marketData.values()].map((d) => d.fundamental), entryGate),');
    expect(bericht).toContain("...nimm('fundamentalSchatten'),");
  });
});
