/**
 * Der Takt sagt, wenn er ein Konto AUSLÄSST — und ein Wartungsskript schreibt
 * nie in den Spiegel.
 *
 * Befund vom 02.10.2026 (zwei Nutzer-Screenshots): Konten hingen seit dem
 * Umstieg vom 07.09. fest. Die Kette war:
 *
 *  1. `scripts/umstieg.mjs` legte seinen Hinweistext in `engine.lastError` ab —
 *     ein Feld, das dem Spiegel des Takts gehört.
 *  2. Die Oberfläche hielt das Doc dadurch für einen echten Stand und malte ein
 *     grünes „frei — Einstiege erlaubt" für ein Konto, das nie getaktet wurde.
 *  3. Der einzige Hinweis, der die Ursache nennt („noch kein Takt gelaufen —
 *     ohne verbundenen Broker überspringt der Takt es"), hing an `!engine` und
 *     fiel damit weg.
 *  4. Nichts löschte den roten Text: Einen übersprungenen Nutzer spiegelte der
 *     Takt überhaupt nicht — nur ein tatsächlich gelaufener Takt setzte
 *     `lastError: null`.
 *
 * Ergebnis für den Nutzer: einschalten wie aufgefordert, und es bleibt beim
 * selben roten Fehler, ohne jede Angabe, was fehlt.
 *
 * Diese Wächter decken Punkt 1 und 4 ab; Punkt 2 und 3 stehen in
 * `frontend/test/spiegelPhantom.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineFieldOf, mirrorError, mirrorSkipped } from '../../src/engine/mirror.ts';
import { FakeFirestore } from '../fakes/firestore.ts';
import type { EngineStatus } from '../../../src/engine/engine.ts';

const NOW = Date.UTC(2026, 9, 2, 14, 0, 0);
const ISO = new Date(NOW).toISOString();

const lese = (...teile: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', '..', ...teile), 'utf8');
const tick = lese('functions', 'src', 'engine', 'tick.ts');
const umstieg = lese('scripts', 'umstieg.mjs');
const strategyCallable = lese('functions', 'src', 'callable', 'strategy.ts');
const dashboard = lese('frontend', 'src', 'dashboard.ts');

function status(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    mode: 'paper',
    running: false,
    halt: { halted: false, reason: null, since: null, until: null, note: null },
    positions: [],
    pendingEntries: [],
    pendingExits: [],
    deferredIntents: [],
    protectiveOrders: {},
    lastBarAt: {},
    equity: 100_000,
    cash: 50_000,
    dayStartEquity: 100_000,
    peakEquity: 100_000,
    day: '2026-10-02',
    dayTradeCount: 0,
    localDayTrades: 0,
    patternDayTrader: false,
    streamStatus: { data: null, trade: null, dataLastMessageAt: null, tradeLastMessageAt: null },
    clock: null,
    consecutiveErrors: 0,
    startedAt: null,
    uptimeMs: 0,
    lastTickAt: null,
    lastReconcileAt: null,
    lastFlushAt: null,
    ...over,
  } as EngineStatus;
}

describe('Übersprungene Konten werden gespiegelt, nicht verschwiegen', () => {
  it('mirrorSkipped nennt den Grund, stempelt den Takt und räumt den alten Fehler ab', async () => {
    const db = new FakeFirestore();
    // Genau der Stand, den der Umstieg hinterließ: ein Hinweistext ohne Takt.
    db.seed('users/u1', { engine: { lastError: 'Umstieg 2026-09-07: Engine ausgeschaltet — bitte Einstellungen prüfen und bewusst einschalten' } });

    await mirrorSkipped(db, 'u1', 'kein_broker', NOW);

    const e = db.get('users/u1')?.engine as Record<string, unknown>;
    expect(e.skipped).toBe('kein_broker');
    // Der Zeitstempel ist das Unterscheidungsmerkmal: ab jetzt ist es ein echter Stand.
    expect(e.lastTickAt).toBe(ISO);
    // Ein Übersprung ist KEIN abgebrochener Takt — der alte rote Text muss weg.
    expect(e.lastError).toBeNull();
  });

  it('ein gelaufener Takt räumt den Übersprung-Grund ab — sonst behauptet die Karte eine Sperre, die es nicht mehr gibt', async () => {
    expect(engineFieldOf({ mode: 'paper', status: status(), now: NOW, lastError: null, champion: { source: 'test', symbols: [] }, commandsSeen: false }).skipped).toBeNull();

    const db = new FakeFirestore();
    db.seed('users/u1', { engine: { skipped: 'kein_broker', lastTickAt: ISO } });
    await mirrorError(db, 'u1', 'Broker-Verbindung: 401', NOW);
    const e = db.get('users/u1')?.engine as Record<string, unknown>;
    expect(e.skipped).toBeNull();
    expect(e.lastError).toBe('Broker-Verbindung: 401');
  });

  it('jeder Grund, den der Takt spiegelt, hat im Dashboard einen Klartext', () => {
    const gruende = [...tick.matchAll(/markSkipped\(db, \w+, '([a-z_]+)'/g)].map((m) => m[1]!);
    // Die drei Stellen, an denen der Takt vor dem Lauf aussteigt.
    expect([...new Set(gruende)].sort()).toEqual(['kein_broker', 'reset_laeuft', 'zugang']);
    const block = dashboard.match(/const SKIP_TEXT: Record<string, string> = \{[\s\S]*?\};/)?.[0] ?? '';
    for (const g of gruende) {
      const key = g.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      expect(block, `SKIP_TEXT ohne ${g}`).toMatch(new RegExp(`^\\s*${g}: t\\('skip\\.${key}'\\),`, 'm'));
    }
  });

  it('der Takt steigt an keiner Stelle mehr stumm aus', () => {
    // Jede der drei Abbruch-Stellen meldet sich im Spiegel.
    for (const grund of ['zugang', 'reset_laeuft', 'kein_broker']) {
      const push = new RegExp(`reason: '${grund}'`);
      expect(tick, `${grund} wird nicht gepusht`).toMatch(push);
      expect(tick, `${grund} wird nicht gespiegelt`).toMatch(new RegExp(`markSkipped\\(db, \\w+, '${grund}'`));
    }
  });
});

describe('Wartungsskripte fassen den Spiegel nicht an', () => {
  it('das Umstiegs-Skript schreibt nur noch den Schalter', () => {
    expect(umstieg).not.toContain("'engine.lastError'");
    expect(umstieg).toContain("'settings.strategy.engine.running': false");
  });
});

describe('Einschalten räumt den Stand von davor ab', () => {
  /*
   * Das Verhalten prüft `functions/test/saveStrategy.test.ts` (drei Fälle:
   * vorhandenen Stand abräumen, keinen anlegen, beim Ausschalten nichts
   * anfassen). Hier steht nur die Bedingung selbst — sie war im ersten Anlauf
   * falsch und baute die Falle neu ein, deshalb bekommt sie einen eigenen Wächter.
   */
  it('abgeräumt wird nur ein VORHANDENER Stand — sonst legte der Punktpfad ein neues Phantom an', () => {
    const fn = strategyCallable.slice(strategyCallable.indexOf('export async function speichereEinstellungen'));
    expect(fn).toContain("update['engine.lastError'] = null;");
    expect(fn).toContain("update['engine.skipped'] = null;");
    // Die Bedingung fragt BEIDES ab: Einschalten und ein Stand, der schon da ist.
    expect(fn).toMatch(/if \(running === true && isRecord\(\(vorher\.data\(\)[^)]*\)\?\.engine\)\)/);
    // Und nie am Schalter allein — das träfe auch das Ausschalten.
    expect(fn).not.toMatch(/if \(running !== undefined\) update\['engine\.lastError'\]/);
  });
});

describe('die Wächter erkennen einen eingebauten Fehler', () => {
  it('ein Skript, das wieder in den Spiegel schreibt, fällt auf', () => {
    const kaputt = "batch.update(ref, { 'engine.lastError': 'Umstieg …' });";
    expect(kaputt).toContain("'engine.lastError'");
  });

  it('ein Grund ohne Klartext fällt auf', () => {
    const block = "const SKIP_TEXT: Record<string, string> = {\n  zugang: t('skip.zugang'),\n};";
    expect(block).not.toMatch(/^\s*kein_broker: t\('skip\.keinBroker'\),/m);
  });
});
