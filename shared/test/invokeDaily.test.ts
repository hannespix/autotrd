/**
 * Der Deploy-Anstoß der Tages-Läufe (`scripts-ci/invoke-daily.mjs`).
 *
 * Diese Logik entscheidet, ob der Owner morgen Zahlen sieht — und sie ist im
 * CI unsichtbar: Der Schritt ist `continue-on-error`, ein falsches
 * Übersprungen sieht im grünen Log genauso aus wie ein richtiges. Genau das
 * ist am 08.08. passiert: Der Deploy vermerkte um 22:25 UTC
 * `stand: 'kein_schluessel'` in `meta/aiBericht` (das Secret war im selben
 * Lauf erst gebunden worden), das Gate hielt den Vermerk für einen Bericht
 * und hätte den ersten echten Lauf bis zum Folgetag verhindert.
 *
 * Deshalb hier beides netzfrei: die Spur-Auswertung und das Tages-Gate.
 */
import { describe, expect, it } from 'vitest';
import { berichtSpur, markerIstEndgueltig, runDaily } from '../../scripts-ci/invoke-daily.mjs';

const heute = new Date().toISOString().slice(0, 10);
const gestern = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe('berichtSpur', () => {
  it('nur ein fertiger Bericht zählt als Spur', () => {
    const doc = { stand: 'bericht', at: `${heute}T22:25:00.000Z`, date: heute };
    expect(berichtSpur(doc)).toEqual({ at: doc.at, date: heute });
  });

  it('der Vermerk „kein Schlüssel" ist KEINE Spur (Regression 08.08.)', () => {
    expect(berichtSpur({ stand: 'kein_schluessel', at: `${heute}T22:25:02Z`, date: heute })).toBeNull();
  });

  it('ein Fehlversuch ist KEINE Spur — der nächste Anlauf darf laufen', () => {
    expect(berichtSpur({ stand: 'fehler', at: `${heute}T22:25:02Z`, date: heute })).toBeNull();
  });

  it('fehlendes Dokument ⇒ keine Spur', () => {
    expect(berichtSpur(null)).toBeNull();
    expect(berichtSpur(undefined)).toBeNull();
  });
});

describe('markerIstEndgueltig', () => {
  it('ein Mittags-Lauf sperrt den Tag nicht (der Abend-Schlusskurs fehlt noch)', () => {
    expect(markerIstEndgueltig({ at: `${heute}T12:30:00Z` })).toBe(false);
  });

  it('ein Lauf nach US-Schluss (≥20 UTC) sperrt den Tag', () => {
    expect(markerIstEndgueltig({ at: `${heute}T21:15:00Z` })).toBe(true);
  });

  it('ohne Zeitstempel niemals endgültig', () => {
    expect(markerIstEndgueltig(null)).toBe(false);
    expect(markerIstEndgueltig({ date: heute })).toBe(false);
  });
});

/** Ein Lauf, dessen Spur ein Test-Skript beliebig setzen kann. */
function lauf(service: string, spuren: unknown[], extra: Record<string, unknown> = {}) {
  let i = 0;
  return {
    service,
    label: service,
    ...extra,
    // Erster Aufruf = Vorher-Prüfung, danach die Nachweis-Runden.
    spur: async () => spuren[Math.min(i++, spuren.length - 1)] ?? null,
  };
}

async function fahre(runs: unknown[], force = false) {
  const angestossen: string[] = [];
  const r = await runDaily({
    project: 'p',
    force,
    runs,
    invoke: async (s: string) => {
      angestossen.push(s);
    },
    wait: async () => undefined,
    log: () => undefined,
  });
  return { ...r, angestossen };
}

describe('runDaily — das Tages-Gate', () => {
  it('überspringt, was heute nach US-Schluss schon lief', async () => {
    const r = await fahre([lauf('a', [{ at: `${heute}T21:15:00Z` }])]);
    expect(r.angestossen).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('stößt trotzdem an, wenn der letzte Lauf von heute Mittag stammt', async () => {
    const r = await fahre([lauf('a', [{ at: `${heute}T12:00:00Z` }, { at: `${heute}T23:00:00Z` }])]);
    expect(r.angestossen).toEqual(['a']);
    expect(r.failed).toBe(0);
  });

  it('stößt an, wenn die letzte Spur von gestern ist', async () => {
    const r = await fahre([lauf('a', [{ at: `${gestern}T21:15:00Z` }, { at: `${heute}T23:00:00Z` }])]);
    expect(r.angestossen).toEqual(['a']);
  });

  it('--force ignoriert das Gate', async () => {
    const r = await fahre([lauf('a', [{ at: `${heute}T21:15:00Z` }])], true);
    expect(r.angestossen).toEqual(['a']);
  });

  it('ohne frische Spur wird ein Pflichtlauf als Fehlschlag gezählt', async () => {
    const r = await fahre([lauf('a', [null, null])]);
    expect(r.failed).toBe(1);
  });

  it('ein optionaler Lauf ohne Nachweis macht den Deploy NICHT rot', async () => {
    const r = await fahre([lauf('a', [null, null], { optional: true })]);
    expect(r.ran).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('ein fehlgeschlagener Invoke stoppt die folgenden Läufe nicht', async () => {
    const kaputt = {
      service: 'x',
      label: 'x',
      spur: async () => null,
    };
    const angestossen: string[] = [];
    const r = await runDaily({
      project: 'p',
      runs: [kaputt, lauf('y', [null, { at: `${heute}T23:00:00Z` }])],
      invoke: async (s: string) => {
        if (s === 'x') throw new Error('500');
        angestossen.push(s);
      },
      wait: async () => undefined,
      log: () => undefined,
    });
    expect(angestossen).toEqual(['y']);
    expect(r.failed).toBe(1);
  });

  it('die Reihenfolge der Läufe bleibt erhalten — der Bericht kommt nach den Kennzahlen', async () => {
    const angestossen: string[] = [];
    await runDaily({
      project: 'p',
      runs: [lauf('snapshotequity', [null]), lauf('kibericht', [null])],
      invoke: async (s: string) => {
        angestossen.push(s);
      },
      wait: async () => undefined,
      log: () => undefined,
    });
    expect(angestossen).toEqual(['snapshotequity', 'kibericht']);
  });
});
