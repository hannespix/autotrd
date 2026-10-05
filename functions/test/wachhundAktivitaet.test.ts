/**
 * Quelltext-Wächter (05.10.): Der Wachhund schreibt das Untätigkeits-Urteil
 * in ein EIGENES Feld und nie in `alarm` — sonst antwortete `healthz` bei
 * einem ruhigen Markt mit 503 und weckte den externen Uptime-Check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const quelle = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', 'wachhund.ts'), 'utf8');

describe('wachhund — Untätigkeit verdrahtet', () => {
  it('liest laufende Engines und die 7-Tage-Trades aus dem Heartbeat', () => {
    expect(quelle).toContain("laufend: health.get('konten.laufend')");
    expect(quelle).toContain("trades7t: health.get('trading.trades7t')");
  });
  it('schreibt das Urteil getrennt vom Herzschlag-Alarm', () => {
    expect(quelle).toContain("await db.doc('meta/health').set({ alarm, aktivitaet }, { merge: true });");
  });
});
