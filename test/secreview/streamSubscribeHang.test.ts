/**
 * SECREVIEW #5 — `DataStream.subscribeBars()` wartet auf ein
 * `{"T":"subscription"}`-Frame (stream.ts L432-441). Antwortet Alpaca mit
 * einem Fehler-Frame (z. B. 405 „symbol limit exceeded" — der Basic-Plan
 * erlaubt 30 Symbole, die Config bis zu 50 + Benchmark; oder 400 „invalid
 * syntax" bei falscher Krypto-Schreibweise), landet das in `protocolError`
 * und die wartende Promise wird NIE erfüllt. `Engine.start()` hängt dann vor
 * dem Setzen der Timer (engine.ts L233): kein Tick, kein Abgleich, kein State-
 * Herzschlag — der Prozess sieht „lebendig" aus, tut aber nichts, und systemd
 * startet ihn nie neu.
 *
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { createDataStream, type WebSocketLike } from '../../src/alpaca/stream.ts';

class ScriptedWs implements WebSocketLike {
  readonly sent: string[] = [];
  private handlers: Record<string, Array<(ev: unknown) => void>> = {};
  private readonly onFrame: (frame: Record<string, unknown>, ws: ScriptedWs) => void;
  constructor(onFrame: (frame: Record<string, unknown>, ws: ScriptedWs) => void) {
    this.onFrame = onFrame;
    queueMicrotask(() => {
      this.dispatch('open', {});
      this.reply([{ T: 'success', msg: 'connected' }]);
    });
  }
  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as Record<string, unknown>;
    queueMicrotask(() => this.onFrame(frame, this));
  }
  close(): void {
    /* Server hält die Verbindung nach 405 offen */
  }
  addEventListener(type: string, handler: (ev: unknown) => void): void {
    (this.handlers[type] ??= []).push(handler);
  }
  reply(msgs: unknown[]): void {
    this.dispatch('message', { data: JSON.stringify(msgs) });
  }
  private dispatch(type: string, ev: unknown): void {
    for (const h of this.handlers[type] ?? []) h(ev);
  }
}

describe('secreview: subscribeBars hängt bei Fehler-Frame', () => {
  it('Alpaca antwortet auf subscribe mit 405 symbol limit exceeded ⇒ subscribeBars() muss ablehnen oder auflösen, nicht ewig warten', async () => {
    const stream = createDataStream({
      keyId: 'PKTESTTESTTESTTESTTEST',
      secret: 'secret-secret-secret',
      feed: 'iex',
      assetClass: 'us_equity',
      sleep: async () => undefined,
      wsFactory: () =>
        new ScriptedWs((frame, ws) => {
          if (frame.action === 'auth') ws.reply([{ T: 'success', msg: 'authenticated' }]);
          if (frame.action === 'subscribe') ws.reply([{ T: 'error', code: 405, msg: 'symbol limit exceeded' }]);
        }),
    });
    await stream.connect();
    const outcome = await Promise.race([
      stream.subscribeBars(['AAPL']).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((r) => setTimeout(() => r('hung'), 300)),
    ]);
    await stream.close();
    expect(outcome, 'subscribeBars() hängt ohne Timeout/Fehlerweitergabe — Engine.start() kommt nie zum Ende').not.toBe('hung');
  });
});
