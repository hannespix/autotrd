/**
 * SECREVIEW2 #2 — Der Wächter „Halt (errors) nach maxConsecutiveErrors Fehlern in Folge" (engine.ts L1022)
 * ist im Functions-Takt tot: Jeder Takt baut die Engine neu und `Engine.start()` setzt
 * `st.consecutiveErrors = 0` (engine.ts L239), BEVOR der Takt läuft. Der persistierte Zähler aus dem
 * State-Doc wird also jede Minute auf 0 zurückgesetzt — eine Fehlerserie über Takte hinweg
 * (Broker lehnt jeden Exit ab, Order-Ausführung scheitert Takt für Takt) erreicht nie die Schwelle.
 *
 * Aufbau: offene Position mit Schutz-Stop beim Broker, ein zurückgestellter Exit im State, und der
 * Broker wirft bei jedem Storno HTTP 500. Config: maxConsecutiveErrors = 3. Nach drei Takten mit
 * Order-Fehler muss der Halt 'errors' stehen.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AlpacaError } from '../../../src/alpaca/types.ts';
import { engineStatePath } from '../../src/engine/state.ts';
import { brokerMitPosition, stateDoc, stateMitPosition, T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: Halt (errors) über Takte hinweg', () => {
  it('drei Takte mit gescheiterter Order-Ausführung ⇒ Halt errors (maxConsecutiveErrors = 3)', async () => {
    const w = welt();
    welten.push(w);
    await brokerMitPosition(w.trading);
    w.db.seed(engineStatePath('u1'), stateMitPosition({ deferredIntents: { AAPL: { kind: 'exit', symbol: 'AAPL', reason: 'signal', decidedAt: T1 - 60_000 } } }));
    w.trading.throwOn('cancelOrder', new AlpacaError('Alpaca DELETE /v2/orders/x → HTTP 500', 500, null, true));

    const gesehen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await w.run(T1 + i * 60_000);
      // Engine-interne Order-Fehler machen den Nutzer im Takt-Ergebnis nicht zu `failed` (onError fängt sie) —
      // sie stehen als 'error'-Ereignis im Journal und müssten den Zähler im State wachsen lassen.
      expect(r.ok).toBe(1);
      const fehler = w.db.list('users/u1/journal').filter((d) => d.data.kind === 'error' && d.data.where === 'tick');
      expect(fehler.length).toBe(i + 1);
      gesehen.push(stateDoc(w.db)?.consecutiveErrors ?? -1);
    }
    expect(gesehen, 'consecutiveErrors im State-Doc wird jeden Takt auf 0 zurückgesetzt und zählt nie hoch').toEqual([1, 2, 3]);
    expect(stateDoc(w.db)?.halt).toMatchObject({ halted: true, reason: 'errors' });
  });
});
