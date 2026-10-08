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
    expect(quelle).toContain("((health.get('konten.gehandelt') as number | undefined) ?? 0)");
    expect(quelle).toContain("((health.get('konten.momentum') as number | undefined) ?? 0)");
    expect(quelle).toContain("trades7t: health.get('trading.trades7t')");
  });
  it('schreibt das Urteil getrennt vom Herzschlag-Alarm', () => {
    expect(quelle).toContain("await db.doc('meta/health').set({ alarm, aktivitaet, nachrichten, fillSync: { zustand: fillSyncZustand } }, { merge: true });");
  });
  it('bewertet den Nachrichten-Sammler aus seinem Stand — auch nur in einem eigenen Feld', () => {
    expect(quelle).toContain("const stand = await db.doc('meta/nachrichtenStand').get();");
    expect(quelle).toContain("rueckstandS: stand.get('rueckstandS')");
    expect(quelle).toContain("logger.error(`NACHRICHTEN: ${nachrichten.text}`);");
    // Nie in den Herzschlag-Alarm — ohne Nachrichten handelt das System weiter.
    expect(quelle).not.toMatch(/naechsterAlarm\([^)]*nachrichten/);
  });
});
