/**
 * Fremde Führung (Prüfbefund M4, 09.09.2026).
 *
 * Der Fehler, den dieser Test verhindert: Wechselt die Strategie eines Symbols
 * über Nacht (Alpha-Beförderung, Basis-Wechsel), führte die NEUE Strategie
 * die alte Position mit ihren Exit-Regeln — der 20-%-Katastrophen-Stop der
 * Basis wurde zum ATR-Trailing des Alpha-Champions (`move_stop 101,85`), ihr
 * Signal-Exit schnitt eine Position ab, die nach einer anderen Regel gemessen
 * wurde. Seit M4 hält die Engine eine Position, deren `strategy` nicht die
 * heutige Wahl ist: kein Signal-Exit, kein Stop-Nachzug, der Broker-Stop
 * bleibt; im Journal steht die Notiz einmal. Notbremsen und `flatten` gelten
 * weiter — Exits werden nie gesperrt.
 */
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import type { Strategy } from '../../src/core/types.ts';
import { OPEN1, minuteBars, openPositionViaFill, scriptedStrategy, startScenario } from '../fakes/harness.ts';

const BARS_10_14 = () => minuteBars(OPEN1 + 10 * MIN, [100.5, 100.6, 100.7, 100.8, 100.9]);

describe('Position einer anderen Strategie', () => {
  it('WÄCHTER (M4): Position der Strategie A, Symbol jetzt Strategie B ⇒ kein Exit aus B-Signalen, kein Stop-Nachzug, Stop unverändert, Notiz', async () => {
    const strategies: Record<string, Strategy | null> = { AAPL: scriptedStrategy({ id: 'A', enterAt: 1, holdsOvernight: true }) };
    const sc = await startScenario({ strategies });
    await openPositionViaFill(sc);
    const pos = sc.engine.status().positions[0]!;
    expect(pos.strategy).toBe('A');
    const stopVorher = pos.stop;
    const calls = sc.fake.calls.length;

    // Über Nacht führt B — mit Exit-Signal UND Trailing ab der nächsten Bar.
    strategies.AAPL = scriptedStrategy({ id: 'B', exitAt: 0, moveStopAt: 0, holdsOvernight: true });
    sc.pushBars('AAPL', BARS_10_14());
    await sc.engine.tick(OPEN1 + 15 * MIN + 5_000);

    const intents = sc.events('intent').map((e) => e.intent as { kind: string; symbol: string });
    expect(intents.filter((i) => i.kind === 'exit' || i.kind === 'move_stop')).toEqual([]);
    expect(sc.fake.calls.slice(calls).map((c) => c.method)).not.toContain('replaceOrder');
    expect(sc.fake.calls.slice(calls).map((c) => c.method)).not.toContain('cancelOrder');
    const nachher = sc.engine.status().positions[0]!;
    expect(nachher.stop).toBe(stopVorher);
    expect(nachher.strategy).toBe('A');
    expect(sc.fake.find('o-1-sl')?.status).toBe('new');
    const notizen = sc.events('note').filter((e) => String(e.text).includes('führt das Symbol jetzt und diese Position nicht'));
    expect(notizen).toHaveLength(1);
    expect(notizen[0]).toMatchObject({ symbol: 'AAPL', positionStrategy: 'A', strategy: 'B' });

    // Zweite Bar: keine zweite Notiz, weiterhin kein Exit.
    sc.pushBars('AAPL', minuteBars(OPEN1 + 15 * MIN, [101, 101.1, 101.2, 101.3, 101.4]));
    await sc.engine.tick(OPEN1 + 20 * MIN + 5_000);
    expect(sc.events('note').filter((e) => String(e.text).includes('führt das Symbol jetzt')).length).toBe(1);
    expect(sc.engine.status().positions).toHaveLength(1);
  });

  it('dieselbe Strategie führt wie bisher: Exit-Signal ⇒ Exit-Order', async () => {
    const strategies: Record<string, Strategy | null> = { AAPL: scriptedStrategy({ id: 'A', enterAt: 1, exitAt: 2, holdsOvernight: true }) };
    const sc = await startScenario({ strategies });
    await openPositionViaFill(sc);
    sc.pushBars('AAPL', BARS_10_14());
    await sc.engine.tick(OPEN1 + 15 * MIN + 5_000);
    const intents = sc.events('intent').map((e) => e.intent as { kind: string });
    expect(intents.some((i) => i.kind === 'exit')).toBe(true);
  });

  it('WÄCHTER: flatten (Kill-Switch) schließt auch eine fremd geführte Position — Exits werden nie gesperrt', async () => {
    const strategies: Record<string, Strategy | null> = { AAPL: scriptedStrategy({ id: 'A', enterAt: 1, holdsOvernight: true }) };
    const sc = await startScenario({ strategies });
    await openPositionViaFill(sc);
    strategies.AAPL = scriptedStrategy({ id: 'B', holdsOvernight: true });
    sc.pushBars('AAPL', BARS_10_14());
    await sc.engine.tick(OPEN1 + 15 * MIN + 5_000);
    await sc.engine.flatten('kill_switch');
    expect(sc.fake.ordersFor('AAPL').some((o) => o.type === 'market' && o.side === 'sell' && o.qty === 199)).toBe(true);
  });
});
