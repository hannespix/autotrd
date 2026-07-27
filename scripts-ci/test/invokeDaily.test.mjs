/**
 * Tests für den Tages-Läufe-Anstoß (invoke-daily.mjs).
 *
 * Warum das getestet gehört: Dieses Skript ist derzeit der EINZIGE Weg, auf
 * dem snapshotEquity, evalForecasts und tunerReview live überhaupt laufen —
 * es gibt im Projekt keinen Cloud-Scheduler-Job (Diagnose 27.07.). Wenn die
 * Ablauflogik hier kippt, bleiben Performance-Kurve, Prognose-Genauigkeit und
 * Prognose-Labor still leer, ohne dass irgendwo etwas rot wird. Genau dieser
 * lautlose Ausfall war der Fehler, den der Owner gemeldet hat.
 */

import { describe, expect, it } from 'vitest';
import { markerDay, markerIstEndgueltig, runDaily, unwrap } from '../invoke-daily.mjs';

const HEUTE = new Date().toISOString().slice(0, 10);
/** Zeitstempel von heute zur angegebenen UTC-Stunde. */
const heuteUm = (h) => `${HEUTE}T${String(h).padStart(2, '0')}:15:00.000Z`;

describe('unwrap (Firestore-REST)', () => {
  it('packt verschachtelte Maps aus — genau die Form von health.equitySnapshot', () => {
    // Wortlaut wie in der echten Antwort von firestore.googleapis.com.
    const feld = {
      mapValue: {
        fields: {
          at: { stringValue: '2026-07-27T21:15:00.000Z' },
          date: { stringValue: '2026-07-27' },
          users: { integerValue: '3' },
          snapped: { integerValue: '3' },
        },
      },
    };
    expect(unwrap(feld)).toEqual({
      at: '2026-07-27T21:15:00.000Z',
      date: '2026-07-27',
      users: 3,
      snapped: 3,
    });
  });

  it('macht aus Zahlen Zahlen und aus nullValue null', () => {
    expect(unwrap({ integerValue: '42' })).toBe(42);
    expect(unwrap({ doubleValue: 1.5 })).toBe(1.5);
    expect(unwrap({ nullValue: null })).toBeNull();
    expect(unwrap({ booleanValue: true })).toBe(true);
  });

  it('packt Listen aus', () => {
    expect(unwrap({ arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '2' }] } })).toEqual([
      'a',
      2,
    ]);
    expect(unwrap({ arrayValue: {} })).toEqual([]); // leere Liste hat kein `values`
  });
});

describe('markerDay', () => {
  it('erkennt die Spur egal ob sie date, at oder ts heißt', () => {
    expect(markerDay({ date: '2026-07-27', at: '2026-07-27T21:15:00Z' })).toBe('2026-07-27');
    expect(markerDay({ at: '2026-07-26T20:30:00Z' })).toBe('2026-07-26');
    expect(markerDay({ ts: '2026-07-25T21:30:00Z' })).toBe('2026-07-25'); // meta/tuner
  });

  it('liefert null, wenn es noch gar keine Spur gibt', () => {
    // Der Live-Zustand am 27.07.: das Feld existierte nicht — der Lauf muss
    // dann anspringen und darf nicht in den „schon erledigt"-Zweig fallen.
    expect(markerDay(null)).toBeNull();
    expect(markerDay({})).toBeNull();
    expect(markerDay({ at: 12345 })).toBeNull(); // kein ISO-String
  });
});

describe('markerIstEndgueltig', () => {
  it('erkennt einen Lauf nach US-Schluss', () => {
    expect(markerIstEndgueltig({ at: heuteUm(21) })).toBe(true); // Sommerzeit
    expect(markerIstEndgueltig({ at: heuteUm(22) })).toBe(true); // Winterzeit
    expect(markerIstEndgueltig({ ts: heuteUm(20) })).toBe(true); // Grenze
  });

  it('wertet einen Mittags-Lauf NICHT als endgültig', () => {
    // Sonst würde ein Snapshot vom Mittag den Abend-Lauf verdrängen, und in
    // der Equity-Serie stünde dauerhaft ein Zwischenstand statt des
    // Schlusskurses — Sharpe und Drawdown rechneten auf falscher Grundlage.
    expect(markerIstEndgueltig({ at: heuteUm(13) })).toBe(false);
    expect(markerIstEndgueltig({ at: heuteUm(19) })).toBe(false);
  });

  it('behandelt fehlende oder kaputte Zeitstempel als nicht endgültig', () => {
    expect(markerIstEndgueltig(null)).toBe(false);
    expect(markerIstEndgueltig({})).toBe(false);
    expect(markerIstEndgueltig({ date: HEUTE })).toBe(false); // nur Tag, keine Uhrzeit
    expect(markerIstEndgueltig({ at: 'kein Datum' })).toBe(false);
  });
});

/** Baut einen Lauf, dessen Spur erst NACH erfolgreichem Invoke frisch wird. */
function fakeRun(name, { spurVorher = null, schreibt = true, optional = false } = {}) {
  let spur = spurVorher;
  return {
    service: name,
    label: name,
    optional,
    spur: async () => spur,
    _invoke: async () => {
      if (schreibt) spur = { at: heuteUm(21) };
    },
  };
}

const sofort = async () => {};

async function laufe(runs, opts = {}) {
  const logs = [];
  const res = await runDaily({
    project: 'test',
    runs,
    wait: sofort,
    log: (m) => logs.push(m),
    invoke: async (svc) => {
      const r = runs.find((x) => x.service === svc);
      await r._invoke();
    },
    ...opts,
  });
  return { ...res, logs };
}

describe('runDaily', () => {
  it('stößt an, wenn es noch keine Spur gibt, und bestätigt sie danach', async () => {
    const runs = [fakeRun('snapshotequity')];
    const { ran, failed, logs } = await laufe(runs);
    expect(ran).toBe(1);
    expect(failed).toBe(0);
    expect(logs.join('\n')).toContain('letzte Spur keine');
  });

  it('überspringt einen Lauf, der heute NACH US-Schluss war (Idempotenz-Gate)', async () => {
    // Das ist der Selbst-Abschalter: Sobald der echte Scheduler oder pg_cron
    // die Läufe übernimmt, wird dieser Workflow zum No-Op.
    const runs = [fakeRun('snapshotequity', { spurVorher: { date: HEUTE, at: heuteUm(21) } })];
    const { ran, skipped, failed } = await laufe(runs);
    expect(ran).toBe(0);
    expect(skipped).toBe(1);
    expect(failed).toBe(0);
  });

  it('lässt den Abend-Lauf zu, obwohl mittags schon einer war', async () => {
    // Der Deploy stößt die Läufe mit an — der Mittags-Snapshot füllt die
    // Karte sofort, der Abend-Lauf korrigiert ihn dann auf den Schlusskurs.
    const runs = [fakeRun('snapshotequity', { spurVorher: { date: HEUTE, at: heuteUm(13) } })];
    expect((await laufe(runs)).ran).toBe(1);
  });

  it('stößt eine Spur von GESTERN sehr wohl an', async () => {
    const gestern = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const runs = [fakeRun('snapshotequity', { spurVorher: { date: gestern } })];
    expect((await laufe(runs)).ran).toBe(1);
  });

  it('--force ignoriert das Tages-Gate', async () => {
    const runs = [fakeRun('snapshotequity', { spurVorher: { date: HEUTE, at: heuteUm(21) } })];
    expect((await laufe(runs, { force: true })).ran).toBe(1);
  });

  it('meldet HTTP-2xx OHNE frische Spur als Fehlschlag', async () => {
    // Der wichtigste Fall: Ein antwortender Container beweist NICHTS. Nur die
    // Spur beweist, dass gearbeitet wurde — sonst hätten wir denselben
    // lautlosen Ausfall wie vorher, nur mit grünem Häkchen.
    const runs = [fakeRun('snapshotequity', { schreibt: false })];
    const { ran, failed, logs } = await laufe(runs);
    expect(ran).toBe(1);
    expect(failed).toBe(1);
    expect(logs.join('\n')).toContain('keine frische Spur');
  });

  it('färbt einen optionalen Lauf ohne Spur NICHT rot', async () => {
    const runs = [fakeRun('tunerreview', { schreibt: false, optional: true })];
    expect((await laufe(runs)).failed).toBe(0);
  });

  it('lässt einen kaputten Lauf die anderen nicht abwürgen', async () => {
    const kaputt = fakeRun('evalforecasts');
    kaputt._invoke = async () => {
      throw new Error('HTTP 500');
    };
    const heil = fakeRun('snapshotequity');
    const { ran, failed } = await laufe([kaputt, heil]);
    expect(ran).toBe(1); // der heile lief trotzdem
    expect(failed).toBe(1);
  });
});
