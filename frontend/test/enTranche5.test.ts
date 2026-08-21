/**
 * Wächter der EN-Tranche 5 (21.08.): die letzten shared-Sätze der Oberfläche.
 *
 * `kurvenErklaerung()` und das Reife-`fazit` entstanden in shared als fertige
 * DEUTSCHE Sätze — in der englischen Oberfläche standen sie unübersetzt.
 * Seit dieser Tranche liefert shared die TEILE (Code + Zahlen), und die
 * Oberfläche baut den Satz. Die Fallunterscheidung bleibt in shared: Läge
 * sie doppelt vor, sagten deutsche und englische Fassung Verschiedenes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { erklaerungsTeile, liveReife } from '@autotrd/shared';
import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('shared liefert Teile, die Oberfläche den Satz', () => {
  it('jeder Fall der Erklärung hat einen Code — kein fertiger Satz mehr', () => {
    const faelle = [
      { herkunft: 'snapshots' as const, snapshots: 12, trades: 9 },
      { herkunft: 'trades' as const, snapshots: 0, trades: 9 },
      { herkunft: 'trades' as const, snapshots: 1, trades: 3, resetAm: '2026-08-14T00:00:00Z' },
      { herkunft: 'leer' as const, snapshots: 0, trades: 0 },
      { herkunft: 'leer' as const, snapshots: 0, trades: 4 },
    ];
    const codes = new Set(faelle.flatMap((f) => erklaerungsTeile(f).map((t) => t.code)));
    expect([...codes].sort()).toEqual([
      'ausAbschluessen', 'einSnapshot', 'keineSnapshots', 'nochKeineAbschluesse', 'ohneZeitpunktOderErgebnis',
    ]);
  });

  it('der Datenfehler-Fall trägt bewusst KEINEN Snapshot-Zusatz', () => {
    /* „4 Abschlüsse ohne Zeitpunkt" ist ein Datenfehler und darf nicht wie
     * „noch zu früh" klingen — ein angehängter Snapshot-Hinweis täte genau
     * das (Kommentar in kurveAusTrades.ts). */
    const teile = erklaerungsTeile({ herkunft: 'leer', snapshots: 0, trades: 4 });
    expect(teile.map((t) => t.code)).toEqual(['ohneZeitpunktOderErgebnis']);
  });

  it('die Oberfläche baut den Satz über t() — nicht mehr über den shared-Satz', () => {
    expect(dashboard).toContain('erklaerung: kurvenText({');
    expect(dashboard).not.toContain('erklaerung: kurvenErklaerung({');
    // Die Fallunterscheidung kommt weiterhin NUR aus shared.
    expect(dashboard).toContain('return erklaerungsTeile(e)');
  });

  it('die Live-Reife nennt offene Kriterien sprachneutral', () => {
    const befund = liveReife({ trades: 3, profitFactor: 0.9, feeShare: 0.7, netPnl: -20, tageStrecke: 2 });
    expect(befund.offeneCodes).toEqual([
      'stichprobe', 'profitfaktor', 'gebuehrenanteil', 'nettoergebnis', 'messstrecke',
    ]);
    // Der deutsche Satz bleibt daneben — alte gespeicherte Befunde tragen ihn.
    expect(befund.fazit).toContain('Noch nicht bereit');
  });

  it('das Fazit fällt auf den gespeicherten Satz zurück, wenn Codes fehlen', () => {
    /* Ein Befund aus der Zeit vor dieser Tranche hat keine `offeneCodes` —
     * dann ist der gespeicherte deutsche Satz besser als ein leerer. */
    expect(dashboard).toContain('if (!r.offeneCodes) return r.fazit;');
  });

  it('alle neuen Schlüssel gibt es in beiden Sprachen', () => {
    for (const k of Object.keys(DE).filter((s) => s.startsWith('kv.') || s.startsWith('lv.krit.'))) {
      expect(EN[k as keyof typeof EN], `${k} ohne englische Fassung`).toBeTruthy();
      expect(EN[k as keyof typeof EN], `${k} nur kopiert`).not.toBe(undefined);
    }
    // Die fünf Kriterien-Namen sind wirklich übersetzt, nicht durchgereicht.
    expect(EN['lv.krit.gebuehrenanteil']).toBe('Fee share');
    expect(EN['lv.krit.messstrecke']).toBe('Measurement window');
  });
});
