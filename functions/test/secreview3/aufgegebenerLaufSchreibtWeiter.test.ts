/**
 * SECREVIEW3 — M7 `withBudget` (tick.ts L189-199) rennt `runUser` gegen einen Timer und meldet den Nutzer als
 * gescheitert — der Lauf selbst wird NICHT abgebrochen. Nur die REST-Frist greift (rest.ts `remainingMs`);
 * Firestore-Schreibvorgänge (`saveState` in start/tick/stop, `journal.flush` mit `bufferClearOp`,
 * `mirrorUser`) haben keine Frist. Der aufgegebene Lauf läuft weiter — in Cloud Functions gedrosselt und
 * typischerweise erst mit dem NÄCHSTEN Takt wieder mit CPU — und schreibt dann seinen ALTEN Stand:
 * `FirestoreStateStore.save` ist ein volles `set` (state.ts L81), `bufferClearOp` ein bedingungsloses
 * `update` (L91). Halt/Positionen/pendingExits des jüngeren Takts werden überschrieben, ein frisch
 * gepufferter Journal-Puffer geleert. Die Lease schützt nur zwischen Takten, nicht gegen die eigene Leiche.
 *
 * Gegenbeispiel: u1 hängt in Takt 1 in `listPositions` (Abgleich in `start()`, nach `load()`), Takt 2 setzt
 * per Kommando `halt`. Sobald der aufgegebene Lauf weiterkommt, ist der Halt weg.
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AlpacaClient } from '../../../src/alpaca/types.ts';
import { commandsPath } from '../../src/engine/commands.ts';
import { delegateClient } from '../../src/engine/sharedData.ts';
import { engineSpiegel, iso, stateDoc, T1, welt, type Welt } from '../secreview2/_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

const schlaf = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function warteBis(bedingung: () => boolean, ms: number, was: string): Promise<void> {
  const bis = Date.now() + ms;
  while (!bedingung()) {
    if (Date.now() > bis) throw new Error(`Timeout: ${was}`);
    await schlaf(5);
  }
}

describe('secreview3: aufgegebener Nutzer-Lauf schreibt nach dem Zeitbudget weiter', () => {
  it('Takt 1 gibt u1 auf; Takt 2 setzt Halt per Kommando; der Lauf aus Takt 1 überschreibt State und Spiegel', async () => {
    const w = welt({ userBudgetMs: 30 });
    welten.push(w);
    let haengt = true;
    let erreicht = false;
    let freigeben: () => void = () => undefined;
    const tor = new Promise<void>((r) => {
      freigeben = r;
    });
    const client: AlpacaClient = delegateClient(w.trading, {
      listPositions: async () => {
        if (haengt) {
          haengt = false;
          erreicht = true;
          await tor;
        }
        return w.trading.listPositions();
      },
    });
    (w.deps as { clientFor: () => AlpacaClient }).clientFor = () => client;

    const r1 = await w.run(T1);
    expect(r1.failed).toEqual([{ uid: 'u1', error: expect.stringContaining('Zeitbudget') }]);
    await warteBis(() => erreicht, 2_000, 'aufgegebener Lauf erreicht listPositions nicht');
    expect(stateDoc(w.db)).toBeUndefined(); // der aufgegebene Lauf hat noch nichts gespeichert

    // Takt 2 (gesund): Owner setzt halt — State und Spiegel tragen den Halt.
    w.db.seed(commandsPath('u1'), { halt: { at: iso(T1 + 60_000), reason: 'Owner' } });
    const r2 = await w.run(T1 + 60_000);
    expect(r2.ok).toBe(1);
    expect(stateDoc(w.db)?.halt).toMatchObject({ halted: true, reason: 'manual' });
    const schreibungen = () => w.db.log.filter((l) => l.startsWith('set users/u1') || l.startsWith('update users/u1')).length;
    const vorher = schreibungen();

    // Der aufgegebene Lauf aus Takt 1 bekommt wieder CPU — und darf NICHTS mehr schreiben (Schreibsperre, Secreview 3 #2):
    // weder State (volles set) noch Journal-Puffer (update) noch Spiegel.
    freigeben();
    await schlaf(300);
    expect(schreibungen(), 'aufgegebener Lauf hat nach dem Zeitbudget noch geschrieben').toBe(vorher);
    expect(stateDoc(w.db)?.halt, 'Halt aus Takt 2 vom aufgegebenen Lauf aus Takt 1 überschrieben (volles set des State-Docs)').toMatchObject({ halted: true, reason: 'manual' });
    expect(engineSpiegel(w.db).halt, 'Spiegel zeigt den Halt nicht mehr').toMatchObject({ halted: true });
  });
});
