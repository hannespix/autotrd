/**
 * Task 21, Phase 2: „Warum NICHT gekauft" ist REIN BEOBACHTEND an den
 * Einstiegs-Toren angeschlossen — jede echte Bremse merkt eine Absage vor,
 * das Schattenbuch nicht, und der Schreibvorgang kann keinen Trade stören.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scan = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts'), 'utf8');

describe('Absagen an den Einstiegs-Toren', () => {
  it('jede ECHTE Bremse merkt eine Absage vor (4 Deckel, 6 Cooldowns, 4 Sockel, 4 Sperren, 2 Steckbriefe)', () => {
    expect(scan.match(/gate\.pos_limit \+= 1; absage\(/g)?.length).toBe(4);
    expect(scan.match(/gate\.cooldown_aktiv \+= 1; absage\(/g)?.length).toBe(6);
    expect(scan.match(/gate\.sockel_besitz \+= 1; absage\(/g)?.length).toBe(4);
    expect(scan.match(/if \(sperre[LS]\) \{ absage\(symbol, '(long|short)', sperre[LS], '(regelbaum|konfluenz)'\); continue; \}/g)?.length).toBe(4);
    expect(scan.match(/gate\.filter_blockiert \+= 1;\n\s+absage\(/g)?.length).toBe(2);
  });

  it('gescheiterte Ausführung wird erfasst (fester Code), ein Kauf löscht die Absage (Red-Team 09.10.)', () => {
    expect(scan.match(/absageNachAusfuehrung\(symbol, '(long|short)', '(regelbaum|konfluenz)', r\.executed\);\n\s+if \(r\.executed\) \{/g)?.length).toBe(4);
    expect(scan).toContain("if (ausgefuehrt) absagen.delete(symbol);");
    expect(scan).toContain("else absageMerken(absagen, symbol, seite, 'ausfuehrung_abgelehnt', weg, { regime, ...sperrZahlen.get(symbol) });");
  });

  it('„nicht handelbar" ist keine Absage; Steckbrief-Zahlen vom sperrenden Bucket', () => {
    expect(scan).toContain("if (grund === 'nicht_handelbar') return;");
    expect(scan).toContain('const v = tech.blocked ? tech : bucketVerdict(filterBuckets[sb.gebucht]);');
    expect(scan.match(/steckbriefZahlen\(sb\)/g)?.length).toBe(2);
  });

  it('das Schattenbuch bleibt ohne Absage (es ist nicht das Konto des Nutzers)', () => {
    expect(scan.match(/entrySperre\(symbol, data\.atrPct, Object\.keys\(book\.positions\), '(long|short)', false\)\) continue;/g)?.length).toBe(2);
  });

  it('Beobachtung stört nie: absage() abgefangen, Write parallel, abgefangen, am Ende abgewartet', () => {
    expect(scan).toContain('absageMerken(absagen, symbol, seite, grund, weg, { regime, ...sperrZahlen.get(symbol), ...z });\n        } catch {');
    expect(scan).toContain(".catch((err: unknown) => logger.warn(`Absagen für ${uid} nicht geschrieben`, err)),");
    expect(scan).toContain('await Promise.allSettled(absagenSchreiben);');
  });

  it('die Kostenzahlen kommen aus DEMSELBEN Ergebnis, das entscheidet — nur im echten Buch', () => {
    expect(scan).toContain("const k = side === 'short' ? kostenShort : kosten;\n          sperrZahlen.set(symbol, { erwartetPct: k.edgePct, kostenPct: k.costPct, noetigPct: k.needPct });");
    expect(scan).toContain("return (side === 'short' ? kostenShort : kosten).ok ? null : 'unter_kosten';");
  });
});
