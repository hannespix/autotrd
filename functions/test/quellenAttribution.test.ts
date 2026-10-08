/**
 * Task 17 (08.10.): Die Quellen-Attribution ist ANGESCHLOSSEN.
 *
 * `tradeQuelle` und `byClassQuelle` sind pur getestet (shared/). Hier steht,
 * dass snapshotEquity die Herkunft aus den vorhandenen Feldern des Trade-
 * Dokuments baut (kein zusätzlicher Read), sie an den ClosedTrade hängt
 * und die Quellen-Aufschlüsselung ins öffentliche Aggregat reicht —
 * sonst wären beide Funktionen tote Helfer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');
const broker = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');
const anzahl = (nadel: string): number => snapshot.split(nadel).length - 1;

describe('Quellen-Attribution — Anschluss-Wächter', () => {
  it('die Herkunft kommt aus source, bucket, riskExit und sync des Schluss-Trades', () => {
    expect(anzahl('quelle: tradeQuelle({')).toBe(1);
    expect(anzahl("source: t.get('source'),")).toBe(1);
    expect(anzahl("bucket: t.get('bucket'),")).toBe(1);
    expect(anzahl("sync: t.get('sync'),")).toBe(1);
    // und zwar INNERHALB des pnl-Blocks: nur geschlossene Trades tragen die Herkunft
    const block = snapshot.slice(snapshot.indexOf('closed.push({'), snapshot.indexOf('const ts = tradeStats(closed);'));
    expect(block).toContain('quelle: tradeQuelle({');
  });

  it('der Steckbrief steht am Schluss-Trade — von der Position übernommen (Verkauf UND Cover)', () => {
    expect(broker.split('...(pos.bucket ? { bucket: pos.bucket } : {}),').length - 1).toBe(2);
  });

  it('die Quellen-Aufschlüsselung geht mit ins Aggregat', () => {
    expect(anzahl('byClassQuelle: attr.byClassQuelle,')).toBe(1);
    const beitrag = snapshot.slice(snapshot.indexOf('beitraege.push({'), snapshot.indexOf('beitraege.push({') + 900);
    expect(beitrag).toContain('byClassQuelle: attr.byClassQuelle,');
  });
});
