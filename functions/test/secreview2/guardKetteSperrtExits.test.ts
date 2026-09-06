/**
 * SECREVIEW2 #12 — CLAUDE.md §0.4: „Exits werden nie gesperrt." Im Takt gibt es nur EINEN Verbindungs-
 * Pfad: `brokerVerbindung()` (Order-Pfad). Für ein Live-Konto liefert er null, sobald ein Glied der
 * Kette fehlt (ALPACA_ALLOW_LIVE, Kill-Switch, Nutzer-Schalter, Reife) — und tick.ts L326 überspringt
 * den Nutzer dann komplett (`kein_broker`), samt Abgleich, Schutz-Stop-Prüfung, Trailing, EOD-Flatten
 * und zurückgestellten Exits. Für `holdsOvernight: false`-Strategien (orb_breakout) liegt der Stop als
 * DAY-Bracket-Bein beim Broker und verfällt um 16:00 (orders.ts L316) — der Kill-Switch, gedacht gegen
 * NEUE Live-Orders, lässt so eine Live-Position über Nacht ohne Stop und ohne Exit-Pfad stehen.
 *
 * Gegenbeispiel: Nutzer mit offener Position und zurückgestelltem Exit, Order-Pfad verriegelt.
 * Erwartung: Der Takt bedient wenigstens die Exits (Abgleich + Exit), statt den Nutzer zu überspringen.
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { engineStatePath } from '../../src/engine/state.ts';
import { brokerMitPosition, stateMitPosition, T1, welt, type Welt } from './_welt.ts';

const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: verriegelter Order-Pfad sperrt auch Exits', () => {
  it('Position + zurückgestellter Exit, Kette verriegelt ⇒ Exit muss trotzdem laufen', async () => {
    const w = welt({ verriegelt: ['u1'] });
    welten.push(w);
    w.trading.autoFillMarket = true; // die Exit-Marktorder füllt sofort
    // Live-Konto (AK-Schlüssel), Kette verriegelt (Kill-Switch): State und Schutz-Stop im Modus live.
    await brokerMitPosition(w.trading, undefined, 'live');
    w.db.seed(engineStatePath('u1'), stateMitPosition({ deferredIntents: { AAPL: { kind: 'exit', symbol: 'AAPL', reason: 'kill_switch', decidedAt: T1 - 60_000 } } }, 'live'));
    const r = await w.run(T1);
    expect(r.skippedUsers, 'Nutzer mit offener Position wird komplett übersprungen — kein Abgleich, kein Exit').not.toContainEqual({ uid: 'u1', reason: 'kein_broker' });
    expect(r.ok).toBe(1);
    expect(w.trading.callsOf('getAccount').length).toBeGreaterThan(0);
    expect(w.trading.positions.has('AAPL'), 'zurückgestellter Exit nicht ausgeführt').toBe(false);
    // Die Sperre ist sichtbar (Spiegel) und im Journal begründet; ein Einstieg wäre weiterhin blockiert.
    const engine = w.db.get('users/u1')?.engine as { entryLock?: unknown; notes?: string[] };
    expect(engine.entryLock).toBe('Kill-Switch aktiv');
    expect(engine.notes?.some((n) => n.includes('Einstiege gesperrt'))).toBe(true);
    expect(w.trading.callsOf('submitOrder').every((c) => (c.args[0] as { side: string }).side === 'sell')).toBe(true);
  });
});
