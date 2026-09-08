/**
 * Positionen ohne führende Strategie.
 *
 * Der Fehler, den dieser Test verhindert: `inputs` entsteht aus
 * `universe.symbols` und braucht eine Strategie. Fällt beides weg — das
 * Symbol ist aus dem Universum gefallen (die nächtliche Auswahl kann das),
 * der Champion hat es über Nacht auf `noTrade` gesetzt, oder es ist
 * adoptierter Fremdbestand —, bekam die offene Position gar nichts mehr:
 * keinen Signal-Exit, keinen Trailing-Nachzug, kein EOD-Flatten. Sie lag nur
 * noch am Broker-Stop, zählte aber weiter gegen `maxPositions` und ins
 * Exposure; bei `holdsOvernight: false` wäre sie unbegrenzt über Nacht
 * gehalten worden.
 *
 * Das ist der Fehler des Vorgängersystems in Reinform: etwas halten, das
 * niemand mehr bewirtschaftet. Regel 4 sagt „Exits werden nie gesperrt" —
 * also wird die Position glattgestellt, sobald ihre Regel weg ist.
 */
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import type { Strategy } from '../../src/core/types.ts';
import { openPositionViaFill, startScenario } from '../fakes/harness.ts';

describe('Position ohne führende Strategie', () => {
  it('wird glattgestellt, sobald der Champion das Symbol fallen lässt', async () => {
    // `strategies` wird je Tick neu befragt — genau wie live, wo der Champion
    // über Nacht wechselt, während die Position offen bleibt.
    const strategies: Record<string, Strategy | null> = {};
    const sc = await startScenario({ strategies });
    await openPositionViaFill(sc);
    expect(sc.engine.status().positions.map((p) => p.symbol)).toEqual(['AAPL']);
    const vorher = sc.fake.callsOf('submitOrder').length;

    // Champion sagt ab morgen: kein Handel in AAPL.
    strategies.AAPL = null;
    await sc.engine.tick(sc.now() + 5 * MIN);

    const neu = sc.fake.callsOf('submitOrder').slice(vorher);
    expect(neu.length, 'die Position wird geschlossen, nicht liegen gelassen').toBeGreaterThan(0);
    const intents = sc.events('intent').map((e) => e.intent as { kind: string; symbol: string; reason?: string });
    expect(intents.some((i) => i.kind === 'exit' && i.symbol === 'AAPL' && i.reason === 'unmanaged')).toBe(true);
    expect(sc.events('note').some((e) => String(e.text).includes('ohne führende Strategie'))).toBe(true);
  });

  it('meldet es nur einmal, auch wenn der Exit mehrere Takte braucht', async () => {
    const strategies: Record<string, Strategy | null> = {};
    const sc = await startScenario({ strategies });
    await openPositionViaFill(sc);
    strategies.AAPL = null;
    await sc.engine.tick(sc.now() + 5 * MIN);
    await sc.engine.tick(sc.now() + 10 * MIN);
    const meldungen = sc.events('note').filter((e) => String(e.text).includes('ohne führende Strategie'));
    expect(meldungen).toHaveLength(1);
  });

  it('rührt Positionen NICHT an, solange ihre Strategie da ist — auch ohne neue Bar', async () => {
    const sc = await startScenario();
    await openPositionViaFill(sc);
    const vorher = sc.fake.callsOf('submitOrder').length;
    // Takt ohne neue Bar: `inputs` ist leer, die Position bleibt trotzdem unbehelligt.
    await sc.engine.tick(sc.now() + 5 * MIN);
    expect(sc.fake.callsOf('submitOrder')).toHaveLength(vorher);
    expect(sc.engine.status().positions.map((p) => p.symbol)).toEqual(['AAPL']);
    expect(sc.events('note').some((e) => String(e.text).includes('ohne führende Strategie'))).toBe(false);
  });
});
