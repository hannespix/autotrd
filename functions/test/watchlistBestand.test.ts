/**
 * Bestandsschutz der Watchlist-Validierung (Owner-Befund 15.08.).
 *
 * Der Alpaca-first-Umbau (Stufe 2) nahm Indizes und Futures aus dem Katalog.
 * Watchlists aus der Zeit davor tragen sie noch — und `saveStrategy` lehnte
 * daraufhin JEDEN Speichern-Klick des Kontos ab („Unbekannte Symbole: ^NDX,
 * GC=F"), auch wenn die Änderung mit der Watchlist nichts zu tun hatte. Der
 * Klassen-Regler ließ sich so nicht mehr verstellen.
 *
 * Der Schutz ist eng: Nur Symbole, die im GESPEICHERTEN Stand schon stehen,
 * passieren die Prüfung — neu hinzukommende müssen weiterhin Katalog oder
 * Alpaca-Universum entstammen. Diese Wächter pinnen genau diese Reihenfolge.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = readFileSync(join(hier, '../src/callable/strategy.ts'), 'utf8');

describe('saveStrategy: Bestandsschutz (Quelltext-Wächter)', () => {
  it('Alt-Symbole aus dem gespeicherten Stand blockieren das Speichern nicht', () => {
    expect(quelle).toContain("vorher.get('settings.strategy.watchlist')");
    expect(quelle).toContain('unknown = unknown.filter((sym) => !bestand.has(sym));');
  });

  it('der Bestands-Filter steht VOR dem Universums-Blick und der Ablehnung', () => {
    const bestandAb = quelle.indexOf('!bestand.has(sym)');
    const universumAb = quelle.indexOf('await ladeUniversumSymbole()');
    const ablehnungAb = quelle.indexOf('Unbekannte Symbole (weder Katalog noch Alpaca-Universum)');
    expect(bestandAb).toBeGreaterThan(0);
    // Bestand zuerst (kostenlose Prüfung — das Doc ist ohnehin geladen),
    // Universum nur für den Rest, Ablehnung zuletzt.
    expect(bestandAb).toBeLessThan(universumAb);
    expect(universumAb).toBeLessThan(ablehnungAb);
  });

  it('das User-Doc wird EINMAL gelesen (Profil-Check + Bestand aus demselben Snapshot)', () => {
    const treffer = quelle.match(/await ref\.get\(\)/g) ?? [];
    expect(treffer, 'genau ein ref.get() erwartet').toHaveLength(1);
    expect(quelle).toContain('const vorher = await ref.get();');
    expect(quelle).toContain('if (!vorher.exists) {');
  });

  it('neue unbekannte Symbole werden weiterhin abgelehnt', () => {
    expect(quelle).toContain(
      "`Unbekannte Symbole (weder Katalog noch Alpaca-Universum): ${unknown.join(', ')}`",
    );
  });
});
