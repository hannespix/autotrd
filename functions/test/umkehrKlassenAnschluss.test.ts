/**
 * Quelltext-Wächter (20.11.): Der Klassen-Regler misst Umkehr-Konten an der
 * Umkehr, und die auf fremdem Beleg abgeschalteten Klassen kommen genau
 * einmal zurück — vor dem Plan, nur für Paper-Konten, mit Journal.
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

describe('Einmalige Rückkehr im Abendlauf', () => {
  const start = lauf.indexOf('export async function klassenRueckkehrEinmal(');
  const rumpf = lauf.slice(start, lauf.indexOf('\n}\n', start));

  it('läuft VOR dem Laden der Konten — der Plan sieht die zurückgekehrten Klassen', () => {
    const aufruf = lauf.indexOf('await klassenRueckkehrEinmal(now)');
    expect(aufruf).toBeGreaterThan(0);
    expect(lauf.indexOf('const konten = await umkehrKonten();', aufruf)).toBeGreaterThan(aufruf);
    expect(lauf.slice(aufruf, aufruf + 400)).toMatch(/^await klassenRueckkehrEinmal\(now\)\.catch\(/);
  });

  it('nur Paper-Konten im Umkehr-Modus, je Konto genau einmal', () => {
    expect(rumpf).toContain("where('settings.strategy.engine.mode', '==', 'umkehr')");
    expect(rumpf).toContain("if (roh.broker.mode === 'live' || resolveBrokerMode(roh) !== 'paper') continue;");
    expect(rumpf).toContain("if ((await merker.get()).get('fertig') === true) continue;");
    expect(rumpf).toContain("batch.set(merker, { fertig: true, at: iso, klassen: liste.map((z) => z.klasse) });");
  });

  it('entscheidet über die pure Regel und schreibt jede Rückkehr ins Journal', () => {
    expect(rumpf).toContain('umkehrKlassenZurueck(roh.engine.classWeights, journal, roh.engine.classAutoTune !== false)');
    expect(rumpf).toContain("batch.update(u.ref, new FieldPath('settings', 'strategy', 'engine', 'classWeights', z.klasse), z.nach);");
    expect(rumpf).toContain("quelle: 'umstellung_umkehr',");
    // Kein set(merge) auf die Gewichte — ein Feldpfad je Klasse.
    expect(rumpf).not.toMatch(/classWeights[^\n]*merge/);
  });

  it('die Umkehr liest weiter das Klassen-Gewicht — das Tor selbst ist unverändert', () => {
    expect(lauf).toContain('klemmeGewicht(clamped.engine.classWeights?.[classify(symbol)]) > 0;');
  });
});
