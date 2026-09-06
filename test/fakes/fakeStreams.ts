/**
 * Fake-Streams: Ereignisse löst der Test aus. `FakeDataStream.push()`
 * speist Minutenbars ein und setzt die Frische; `FakeTradeStream.emit()`
 * stellt ein trade_update zu. Über `attach(fake)` laufen die Fills des
 * FakeAlpaca automatisch durch den Trade-Stream — wie beim echten Broker.
 */
import type { DataStream, StreamStatus, StreamStatusEvent, TradeStream, TradeUpdate } from '../../src/alpaca/types.ts';
import { MIN } from '../../src/core/time.ts';
import type { Bar, Ms } from '../../src/core/types.ts';

export class FakeDataStream implements DataStream {
  readonly subscribed: string[] = [];
  connected = false;
  closed = false;
  private readonly barCbs: Array<(symbol: string, bar: Bar) => void> = [];
  private readonly statusCbs: Array<(ev: StreamStatusEvent) => void> = [];
  private lastAt: Ms | null = null;

  async connect(): Promise<void> {
    this.connected = true;
    this.emitStatus('connected');
  }

  async subscribeBars(symbols: string[]): Promise<void> {
    for (const s of symbols) if (!this.subscribed.includes(s)) this.subscribed.push(s);
    this.emitStatus('subscribed');
  }

  onBar(cb: (symbol: string, bar: Bar) => void): void {
    this.barCbs.push(cb);
  }

  onStatus(cb: (ev: StreamStatusEvent) => void): void {
    this.statusCbs.push(cb);
  }

  lastMessageAt(): Ms | null {
    return this.lastAt;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.emitStatus('disconnected');
  }

  /** Bar einspeisen; `at` = Empfangszeit (Default: Bar-Ende). */
  push(symbol: string, bar: Bar, at?: Ms): void {
    this.lastAt = at ?? bar.t + MIN;
    for (const cb of this.barCbs) cb(symbol, bar);
  }

  /** Frische setzen, ohne eine Bar zu liefern (z. B. Abo-Bestätigung). */
  touch(at: Ms): void {
    this.lastAt = at;
  }

  emitStatus(status: StreamStatus, detail?: string): void {
    const ev: StreamStatusEvent = detail === undefined ? { status, at: this.lastAt ?? 0 } : { status, detail, at: this.lastAt ?? 0 };
    for (const cb of this.statusCbs) cb(ev);
  }
}

export class FakeTradeStream implements TradeStream {
  connected = false;
  closed = false;
  readonly delivered: TradeUpdate[] = [];
  private readonly cbs: Array<(u: TradeUpdate) => void> = [];
  private readonly statusCbs: Array<(ev: StreamStatusEvent) => void> = [];
  private lastAt: Ms | null = null;

  async connect(): Promise<void> {
    this.connected = true;
    this.emitStatus('connected');
  }

  onUpdate(cb: (u: TradeUpdate) => void): void {
    this.cbs.push(cb);
  }

  onStatus(cb: (ev: StreamStatusEvent) => void): void {
    this.statusCbs.push(cb);
  }

  lastMessageAt(): Ms | null {
    return this.lastAt;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.emitStatus('disconnected');
  }

  /** Ereignis zustellen (die Engine verarbeitet es in ihrer Warteschlange — danach `engine.idle()` abwarten). */
  emit(u: TradeUpdate, at?: Ms): void {
    this.lastAt = at ?? u.timestamp;
    this.delivered.push(u);
    for (const cb of this.cbs) cb(u);
  }

  /** Fills des Fake-Brokers automatisch durchreichen. */
  attach(fake: { onTradeUpdate(cb: (u: TradeUpdate) => void): void }): void {
    fake.onTradeUpdate((u) => this.emit(u));
  }

  emitStatus(status: StreamStatus, detail?: string): void {
    const ev: StreamStatusEvent = detail === undefined ? { status, at: this.lastAt ?? 0 } : { status, detail, at: this.lastAt ?? 0 };
    for (const cb of this.statusCbs) cb(ev);
  }
}
