/**
 * Quelltext-Wächter (20.11.): Der Klassen-Regler misst Umkehr-Konten an der
 * Umkehr. Abgeschaltete Klassen werden NICHT per Schalter zurückgeholt —
 * die Umkehr stand am 20.11. selbst im Minus; zurück führt nur der Regler,
 * auf positivem Beleg.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const lies = (...teile: string[]) => readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');
const snap = lies('scheduled', 'snapshotEquity.ts');
const lauf = lies('scheduled', 'umkehrLauf.ts');

describe('Regler: Beleg passend zum Modus', () => {
  it('Umkehr-Konten bekommen die Belege der Umkehr, alle anderen unverändert die Klasse', () => {
    expect(snap).toContain("const umkehrModus = userDoc.get('settings.strategy.engine.mode') === 'umkehr';");
    expect(snap).toContain("? ergebnisseFuerQuelle('umkehr', attr.byClassQuelle, klassenGlobalRoh, [...Object.keys(attr.byClass), ...Object.keys(gewichte)])");
    // Weder der gemischte Klassenbeleg noch Schatten oder Gesamt-Klasse fließen im Umkehr-Modus ein.
    expect(snap).toContain('for (const [klasse, slice] of umkehrModus ? [] : Object.entries(attr.byClass)) {');
    expect(snap).toContain('for (const klasse of umkehrModus ? [] : schattenKlassenBekannt) {');
    expect(snap).toContain('for (const [klasse, g] of umkehrModus ? [] : Object.entries(klassenGlobal)) {');
    // Schwellen und Schritt des Reglers sind dieselben — kein Sonderweg danach.
    expect(snap).toContain('const rat = berateKlassen(ergebnisse, gewichte);');
  });
});

describe('Keine Rückkehr per Schalter — und die Klasse wird auch am Morgen geprüft', () => {
  it('es gibt keinen Weg, der abgeschaltete Klassen ohne Beleg zurücksetzt (Red-Team 20.11.)', () => {
    expect(lauf).not.toContain('klassenRueckkehr');
    expect(lauf).not.toMatch(/classWeights[^\n]*(update|set)\(/);
    expect(lauf).not.toMatch(/(update|set)\([^\n]*classWeights/);
  });

  it('die Umkehr liest das Klassen-Gewicht — am Abend im Plan UND am Morgen vor dem Kauf', () => {
    expect(lauf).toContain('klemmeGewicht(clamped.engine.classWeights?.[classify(symbol)]) > 0;');
    expect(lauf).toContain('const klasseAn = klasseErlaubt(clamped);');
    expect(lauf).toContain('klasseAn(x.symbol) && !alle.has(x.symbol) && !symbolSperreAusVermerk(');
    expect(lauf).toContain('ohne.klasseAus += klasseAus;');
    // Die Reserve läuft durch denselben Filter.
    expect(lauf).toContain('reserve: reserve.filter(kaufbar),');
  });

  it('Karte und Journal tragen, woran gemessen wurde', () => {
    expect(snap.match(/beleg: umkehrModus \? 'umkehr' : 'klasse',/g)).toHaveLength(2);
  });
});
