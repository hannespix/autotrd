/**
 * SECREVIEW2 #3 — Tages-Notbremse: `decide()` emittiert die Glattstellungs-Exits NUR im Takt, in dem der
 * Halt AUSGELÖST wird (logic.ts L116-121, `hc.triggered`). Scheitert die Ausführung in genau diesem
 * Takt (Broker 5xx beim Storno der Beine), merkt sich der Dauerprozess den Exit in
 * `book.pendingExits` und wiederholt ihn per `retryPendingExits()` jede Sekunde. Im Functions-Takt
 * lebt `pendingExits` nur im Speicher der Engine-Instanz (book.ts L300: „nicht persistiert") — der
 * nächste Takt startet mit persistiertem Halt `daily_loss` (nicht mehr `triggered`) und ohne
 * pendingExits: Die Position bleibt offen, obwohl die Notbremse ausgelöst hat. Nur der Broker-Stop
 * begrenzt den Verlust — die Notbremse „alles glatt" (CLAUDE.md §2) ist damit wirkungslos.
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

describe('secreview2: Notbremse-Flatten wird nach Fehlschlag nie wiederholt', () => {
  it('Tagesverlust −3 % ⇒ Halt daily_loss; Exit scheitert einmal ⇒ nächster Takt muss ihn wiederholen', async () => {
    const w = welt();
    welten.push(w);
    await brokerMitPosition(w.trading);
    w.trading.account.equity = 97_000; // Tagesstart 100 000 ⇒ −3 % ≤ −2 % (maxDailyLossPct-Default)
    w.trading.account.cash = 77_000;
    w.db.seed(engineStatePath('u1'), stateMitPosition({ lastBarAt: {} }));

    // Takt 1: Notbremse löst aus, der Exit scheitert am Storno des Schutz-Stops (HTTP 500).
    w.trading.throwOn('cancelOrder', new AlpacaError('Alpaca DELETE /v2/orders/x → HTTP 500', 500, null, true), 1);
    const r1 = await w.run(T1);
    expect(r1.ok).toBe(1); // Order-Fehler sind engine-intern (onError) — der Nutzer gilt dem Takt als ok
    expect(w.db.list('users/u1/journal').some((d) => d.data.kind === 'halt' && d.data.reason === 'daily_loss')).toBe(true);
    expect(w.db.list('users/u1/journal').some((d) => d.data.kind === 'error' && String(d.data.where).startsWith('execute:exit'))).toBe(true);
    expect(stateDoc(w.db)?.halt).toMatchObject({ halted: true, reason: 'daily_loss' });
    expect(w.trading.positions.has('AAPL')).toBe(true);
    // Nur Marktorders zählen: Der GTC-Schutz-Stop stammt aus dem Test-Aufbau (brokerMitPosition).
    const marktVerkaeufe = () => w.trading.callsOf('submitOrder').filter((c) => (c.args[0] as { side: string; type: string }).side === 'sell' && (c.args[0] as { type: string }).type === 'market');
    expect(marktVerkaeufe()).toHaveLength(0);

    // Takt 2: Broker wieder gesund — die Glattstellung muss jetzt nachgeholt werden (die Marktorder füllt sofort).
    w.trading.clearFailures();
    w.trading.autoFillMarket = true;
    const r2 = await w.run(T1 + 60_000);
    expect(r2.ok).toBe(1);
    expect(marktVerkaeufe().length, 'kein Exit im Folgetakt — Notbremse-Flatten wird nicht wiederholt').toBeGreaterThan(0);
    expect(w.trading.positions.has('AAPL'), 'Position trotz Tages-Notbremse weiter offen').toBe(false);
  });
});
