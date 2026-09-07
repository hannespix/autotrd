/**
 * Quelltext-Wächter: Der Steuerbericht zählt jede Order genau einmal
 * (Audit 13.08., K-5b).
 *
 * Der Befund: Ein Reset archiviert die Trades (`tradesArchive`), und die
 * alte Depot-Übernahme konnte dieselben Orders danach erneut nach `trades`
 * importieren — der Steuerbericht (liest BEIDE Sammlungen) wies jede
 * Veräußerung doppelt aus. In einem Dokument fürs Finanzamt. Die Übernahme
 * ist mit dem Rückbau der Handelsplattform gegangen; die Entdopplung im
 * Bericht bleibt, weil Archiv und Live-Sammlung weiterhin beide gelesen
 * werden.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const steuer = readFileSync(join(hier, '../src/callable/taxReport.ts'), 'utf8');

describe('K-5b: der Steuerbericht zählt jede Order genau einmal', () => {
  it('entdoppelt über die brokerOrderId, trades gewinnt vor dem Archiv', () => {
    const fn = steuer.slice(steuer.indexOf('async function historie'));
    const set = fn.indexOf('const gesehen = new Set<string>()');
    const schleife = fn.indexOf("for (const sammlung of ['trades', 'tradesArchive'])");
    expect(set).toBeGreaterThan(-1);
    // Das Set entsteht VOR der Sammlungs-Schleife — es gilt über beide.
    expect(set).toBeLessThan(schleife);
    expect(fn).toContain('gesehen.has(orderId)');
  });
});
