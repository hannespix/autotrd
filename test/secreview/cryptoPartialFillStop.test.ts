/**
 * SECREVIEW #3 — Krypto: Der Schutz-Stop wird nach dem ERSTEN (Teil-)Fill
 * gesetzt (orders.ts applyEntryFill L418) — mit der bis dahin gefüllten Menge.
 * Füllt der Rest der Marktorder später, wird nur die Buch-Menge nachgezogen;
 * `protectiveOrders.has(sym)` ist bereits true, also folgt kein zweiter/
 * angepasster Stop. `ensureProtectiveStops` prüft nur die EXISTENZ eines
 * Stops, nie seine Menge (L802ff). Ergebnis: Ein Teil der Position hat
 * dauerhaft keinen Broker-Stop. (Bei Aktien passt Alpaca die Bracket-Beine
 * selbst an; hier ist es eine eigene stop_limit-Order.)
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { MIN } from '../../src/core/time.ts';
import { OPEN1, TEN_CLOSES, minuteBars, startScenario, testConfig } from '../fakes/harness.ts';

describe('secreview: Krypto-Schutz-Stop deckt nach Teilfill nicht die ganze Position', () => {
  it('Stop-Menge == Positionsmenge nach vollständigem Fill (auch nach reconcile/ensureProtectiveStops)', async () => {
    const sc = await startScenario({ config: testConfig({ universe: { assetClass: 'crypto', symbols: ['BTC/USD'] } }) });
    sc.pushBars('BTC/USD', minuteBars(OPEN1, TEN_CLOSES));
    await sc.engine.tick(OPEN1 + 10 * MIN + 5_000);

    const entry = sc.fake.openOrders('BTC/USD').find((o) => o.type === 'market' && o.side === 'buy')!;
    expect(entry, 'Krypto-Einstieg (Marktorder gtc, kein Bracket)').toBeDefined();
    const total = entry.qty!;
    expect(total).toBeGreaterThan(1);

    // Teilfill (halbe Menge) ⇒ Position teilweise im Buch, Schutz-Stop folgt.
    sc.fake.fill(entry.id, 100.4, Math.floor(total / 2));
    await sc.engine.idle();
    const stopsAfterPartial = sc.fake.openOrders('BTC/USD').filter((o) => o.type === 'stop_limit');
    expect(stopsAfterPartial).toHaveLength(1);
    expect(stopsAfterPartial[0]!.qty).toBe(Math.floor(total / 2));

    // Restfill ⇒ Position vollständig; jetzt müsste der Stop die ganze Menge decken.
    sc.fake.fill(entry.id, 100.4);
    await sc.engine.idle();
    await sc.engine.reconcileNow(OPEN1 + 11 * MIN); // ensureProtectiveStops läuft mit

    const pos = sc.engine.status().positions[0]!;
    expect(pos.qty).toBe(total);
    const stops = sc.fake.openOrders('BTC/USD').filter((o) => o.type === 'stop_limit');
    const covered = stops.reduce((s, o) => s + (o.qty ?? 0), 0);
    expect(covered, `Schutz-Stop deckt ${covered} von ${total} — der Rest ist nackt`).toBeCloseTo(total, 6);
  });
});

describe('secreview: auch bei Aktien wird die Stop-Menge nie gegen die Positionsmenge geprüft', () => {
  it('Abgleich übernimmt eine größere Broker-Menge (Hand-Nachkauf) — das Bracket-Stop-Bein deckt weiter nur die alte Menge, ensureProtectiveStops sieht „Stop vorhanden"', async () => {
    const { openPositionViaFill } = await import('../fakes/harness.ts');
    const sc = await startScenario();
    await openPositionViaFill(sc); // 199 Stück, Stop-Bein 199
    sc.fake.setPosition('AAPL', 'long', 299, 100.4); // +100 von Hand im Dashboard
    await sc.engine.reconcileNow(OPEN1 + 12 * MIN);
    expect(sc.engine.status().positions[0]!.qty).toBe(299); // Buch folgt dem Broker …
    const covered = sc.fake.openOrders('AAPL').filter((o) => o.type === 'stop').reduce((s, o) => s + (o.qty ?? 0), 0);
    expect(covered, `… der Broker-Stop deckt aber nur ${covered} von 299`).toBe(299);
  });
});
