/**
 * SECREVIEW2 #5 — Kein Zeitbudget je Nutzer. `runUser` (tick.ts L460) wartet unbegrenzt auf den
 * Broker des Nutzers; der REST-Client braucht bei hängendem Endpunkt 3 × 15 s + Backoff ≈ 47 s
 * für EINEN Aufruf (rest.ts: DEFAULT_TIMEOUT_MS 15 000, MAX_ATTEMPTS 3). Die Function hat 55 s.
 * Folge: Ein Nutzer mit kaputter Verbindung reißt den Takt ins Timeout; die Lease bleibt 90 s stehen
 * (kein `finally` nach dem Kill), und alle Nutzer, die in der (stabilen!) Reihenfolge des
 * `users`-Queries hinter ihm stehen, werden Takt für Takt nicht bedient — auch ihre Exits nicht.
 *
 * Gegenbeispiel: u1 hängt in `getAccount`, u5 ist gesund. Der Takt muss trotzdem in endlicher Zeit
 * enden und u5 bedienen. Dieser Test SCHLÄGT FEHL (Timeout des Rennens), solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AlpacaAccount } from '../../../src/alpaca/types.ts';
import { FakeAlpaca } from '../../../test/fakes/fakeAlpaca.ts';
import { T1, USER_SETTINGS, welt, type Welt } from './_welt.ts';

class HaengenderBroker extends FakeAlpaca {
  override getAccount(): Promise<AlpacaAccount> {
    return new Promise<AlpacaAccount>(() => undefined); // antwortet nie
  }
}

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: ein hängender Broker blockiert den ganzen Takt', () => {
  it('u1 hängt ⇒ Takt endet trotzdem binnen 3 s und u5 wird bedient', async () => {
    const gesund = new FakeAlpaca();
    // Budget je Nutzer im Test 1 s (Produktion: USER_BUDGET_MS) — der Takt muss vor dem 3-s-Rennen zurück sein.
    const w = welt({ extraUsers: { u5: gesund }, parallel: 1, userBudgetMs: 1_000 });
    welten.push(w);
    w.trading.throwOn('getAccount', new Error('unbenutzt')); // u1 bekommt unten den hängenden Client
    (w.deps as { clientFor: (v: { schluessel: { keyId: string } }) => FakeAlpaca }).clientFor = (v) =>
      v.schluessel.keyId === 'PKu1' ? new HaengenderBroker() : gesund;
    w.db.seed('users/u5', { settings: USER_SETTINGS });

    const ergebnis = await Promise.race([
      w.run(T1),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
    ]);
    expect(ergebnis, 'runEngineTick kehrt nicht zurück — kein Zeitbudget je Nutzer').not.toBe('timeout');
    expect(gesund.callsOf('getAccount').length, 'u5 wurde nie bedient').toBeGreaterThan(0);
    const r = ergebnis as Exclude<typeof ergebnis, 'timeout'>;
    expect(r.failed).toEqual([{ uid: 'u1', error: expect.stringContaining('Zeitbudget') }]);
    expect(r.ok).toBe(1);
    expect(String((w.db.get('users/u1')?.engine as { lastError?: unknown })?.lastError)).toContain('Zeitbudget');
  });
});
