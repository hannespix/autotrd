/**
 * Zwei Audit-Befunde vom 11.08.: Grenzen, die mit dem Universum wachsen.
 *
 * Beide sind heute folgenlos und werden es beim Alpaca-Universum nicht mehr
 * sein. Sie gehören deshalb VOR den Ausbau, nicht danach.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sammelBatch, BATCH_MAX } from '../src/scheduled/scanMarket.js';

/** Firestore-Attrappe: zählt Commits und die Operationen je Commit. */
function attrappe(): {
  db: never;
  commits: number[];
  fehlerAb?: number;
} {
  const commits: number[] = [];
  let offen = 0;
  const db = {
    batch: () => ({
      set: (): void => {
        offen += 1;
      },
      commit: async (): Promise<void> => {
        commits.push(offen);
        offen = 0;
        await Promise.resolve();
      },
    }),
  };
  return { db: db as never, commits };
}

/* ── Befund A: supplyCatalog sammelte alles in EINEM Batch ─────────────────
 *
 * Ein Schreibvorgang je versorgtem Symbol, zwei je Tageskerze, plus der
 * Zustand — bei 132 Katalog-Symbolen rund 153 Operationen. Firestore
 * committet höchstens 500. `zuHolen` ist in der Katalogbreite ungedeckelt
 * (`zuVersorgende` deckelt nur die ERSTversorgung), also wächst die Zahl mit
 * dem Universum: ab rund 479 offenen Symbolen reißt das Limit.
 *
 * Der Fehler wäre nicht laut, sondern lähmend. Der `catch` in `runScan`
 * schreibt `lastError` und macht weiter — verloren geht der GESAMTE Batch,
 * inklusive `versorgt` und `barCursor`. Jeder Folgescan startet vom selben
 * Zustand und scheitert identisch: Die Marktübersicht fröre dauerhaft ein,
 * während der Heartbeat „läuft" meldet.
 */
describe('Befund A: sammelBatch gibt ab, bevor er überläuft', () => {
  it('unter der Grenze bleibt es ein einziger Commit', () => {
    // Der heutige Normalfall — das Verhalten darf sich nicht ändern.
    const a = attrappe();
    const b = sammelBatch(a.db);
    return (async (): Promise<void> => {
      for (let i = 0; i < 153; i++) await b.set({}, {});
      expect(a.commits).toEqual([]);
      await b.fertig();
      expect(a.commits).toEqual([153]);
    })();
  });

  it('bei genau der Grenze wird abgegeben', async () => {
    const a = attrappe();
    const b = sammelBatch(a.db, 10);
    for (let i = 0; i < 10; i++) await b.set({}, {});
    expect(a.commits).toEqual([10]);
  });

  it('darüber entstehen mehrere Blöcke, keiner über der Grenze', async () => {
    const a = attrappe();
    const b = sammelBatch(a.db, 10);
    for (let i = 0; i < 25; i++) await b.set({}, {});
    await b.fertig();
    expect(a.commits).toEqual([10, 10, 5]);
    for (const c of a.commits) expect(c).toBeLessThanOrEqual(10);
  });

  it('die Alpaca-Größenordnung bleibt unter dem Firestore-Limit', async () => {
    // 8.000 offene Symbole — die Lage, für die der Fix gebaut ist.
    const a = attrappe();
    const b = sammelBatch(a.db);
    for (let i = 0; i < 8_000; i++) await b.set({}, {});
    await b.fertig();
    expect(a.commits.length).toBe(Math.ceil(8_000 / BATCH_MAX));
    for (const c of a.commits) expect(c).toBeLessThanOrEqual(500);
  });

  it('ein leerer Lauf committet gar nicht', async () => {
    // Sonst kostete jeder Scan außerhalb der Handelszeiten einen Schreibzugriff.
    const a = attrappe();
    await sammelBatch(a.db).fertig();
    expect(a.commits).toEqual([]);
  });

  it('fertig() zweimal gerufen committet nicht doppelt', async () => {
    const a = attrappe();
    const b = sammelBatch(a.db, 10);
    await b.set({}, {});
    await b.fertig();
    await b.fertig();
    expect(a.commits).toEqual([1]);
  });

  it('BATCH_MAX lässt Luft unter dem Firestore-Limit von 500', () => {
    expect(BATCH_MAX).toBeLessThan(500);
    expect(BATCH_MAX).toBeGreaterThan(100);
  });

  it('reicht die Optionen durch — merge darf nicht verlorengehen', async () => {
    // Ein `set` ohne `{ merge: true }` ERSETZT das Dokument. Ginge die Option
    // beim Durchreichen verloren, löschte der Scan bei jedem Kurs-Update die
    // Prognosen, News und Signale desselben Symbols.
    const gesehen: unknown[] = [];
    const db = {
      batch: () => ({
        set: (_r: unknown, _d: unknown, o: unknown): void => {
          gesehen.push(o);
        },
        commit: async (): Promise<void> => {
          await Promise.resolve();
        },
      }),
    };
    const b = sammelBatch(db as never, 10);
    await b.set({}, {}, { merge: true });
    await b.set({}, {});
    expect(gesehen).toEqual([{ merge: true }, {}]);
  });
});

describe('Quelltext: supplyCatalog benutzt den Sammler', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'scanMarket.ts');

  it('kein roher db.batch() mehr in supplyCatalog', () => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('const batch = sammelBatch(db);');
    expect(ab, 'Sammler in supplyCatalog nicht gefunden').toBeGreaterThan(0);
    const bis = text.indexOf('return { fresh: fetched, open: offen.length };', ab);
    const block = text.slice(ab, bis);
    // Alle Schreibvorgänge müssen awaited sein — ein vergessenes `await`
    // ließe den Commit ins Leere laufen.
    expect(block).not.toMatch(/(?<!await )batch\.set\(/);
    expect(block).toContain('await batch.fertig()');
  });
});

/* ── Befund B: Zwei Tagesläufe holten die volle market-Sammlung ────────────
 *
 * `momentumRun` und `tagRueckblick` brauchen je EIN Feld, holten aber das
 * ganze Dokument — und ein `market/{sym}` trägt `forecast.points`,
 * `forecastIntraday.points`, `news`, `lastSignal` und `quote`.
 *
 * Bei 10.000 Symbolen à ~10 KB sind das ~100 MB in einem Rutsch, bei 512 MiB
 * Funktionsspeicher. Der Ausfall wäre still: OOM-Kill ⇒ `meta/momentum.top`
 * bleibt auf dem Vorabend stehen ⇒ `collectScanSymbols` wählt am nächsten Tag
 * nach einer veralteten Rangliste, ohne dass irgendwo „Ranking ist alt" steht.
 */
describe('Befund B: die Tagesläufe holen nur die Felder, die sie brauchen', () => {
  const quelle = (datei: string): string =>
    readFileSync(join(import.meta.dirname, '..', 'src', 'scheduled', datei), 'utf8');

  for (const datei of ['momentumRun.ts', 'tagRueckblick.ts'] as const) {
    it(`${datei} holt nicht mehr die vollen Dokumente`, () => {
      expect(quelle(datei)).not.toContain(".collection('market').get()");
    });
  }

  it('momentumRun braucht ein Feld und holt eins', () => {
    expect(quelle('momentumRun.ts')).toContain(
      ".collection('market').select('deepBackfillV').get()",
    );
  });

  it('tagRueckblick braucht ZWEI Felder und holt beide', () => {
    /* Der Fix hätte hier beinahe einen neuen Fehler erzeugt: Zuerst stand nur
     * `tagRueckblickV` im `select`. `deepBackfillV` ein paar Zeilen darunter
     * ist aber kein Beiwerk, sondern das Gate, das Symbole mit veralteter
     * Historie draußen hält — ohne das Feld ist es `undefined`, das Gate
     * schließt für alles, und der Lauf findet nichts mehr zu tun.
     *
     * Gefunden hat das der Budget-Test, weil seine Firestore-Attrappe seit
     * diesem Paket nachbildet, was `select` wirklich tut: nur die genannten
     * Felder ausliefern. Eine Attrappe, die `select` ignoriert hätte, wäre
     * grün geblieben. */
    const text = quelle('tagRueckblick.ts');
    expect(text).toContain(".select('tagRueckblickV', 'deepBackfillV')");
    for (const feld of ['tagRueckblickV', 'deepBackfillV']) {
      expect(text, `${feld} wird gelesen, muss also im select stehen`).toContain(
        `d.get('${feld}')`,
      );
    }
  });
});
