/**
 * Stream-Attrappen für den Takt: Es gibt keinen WebSocket. Bars kommen per
 * REST in den geteilten Cache, Fills holt der REST-Abgleich der Engine
 * (`syncOrders`) — beides Wege, die die Engine ohnehin für Stream-Ausfälle
 * kennt.
 *
 * `NoopDataStream.lastMessageAt()` ist die Datenfrische der Engine: Ohne
 * Wert sperrt `decide()` jeden Einstieg. Der Takt setzt sie auf den
 * Zeitpunkt des gelungenen Bars-Abrufs — und auf null, wenn er scheiterte.
 */
import type { DataStream, StreamStatusEvent, TradeStream, TradeUpdate } from '../../../src/alpaca/types.ts';
import type { Bar, Ms } from '../../../src/core/types.ts';

export class NoopDataStream implements DataStream {
  private lastAt: Ms | null;

  constructor(lastAt: Ms | null = null) {
    this.lastAt = lastAt;
  }

  async connect(): Promise<void> {
    // kein Stream im Takt
  }

  async subscribeBars(_symbols: string[]): Promise<void> {
    // kein Stream im Takt
  }

  onBar(_cb: (symbol: string, bar: Bar) => void): void {
    // es kommen nie Bars über den Stream
  }

  onStatus(_cb: (ev: StreamStatusEvent) => void): void {
    // kein Status
  }

  lastMessageAt(): Ms | null {
    return this.lastAt;
  }

  /** Datenfrische setzen (Zeitpunkt des gelungenen REST-Abrufs) bzw. löschen. */
  markFresh(at: Ms | null): void {
    this.lastAt = at;
  }

  async close(): Promise<void> {
    // nichts offen
  }
}

export class NoopTradeStream implements TradeStream {
  async connect(): Promise<void> {
    // kein Stream im Takt
  }

  onUpdate(_cb: (u: TradeUpdate) => void): void {
    // Fills liefert der REST-Abgleich
  }

  onStatus(_cb: (ev: StreamStatusEvent) => void): void {
    // kein Status
  }

  lastMessageAt(): Ms | null {
    return null;
  }

  async close(): Promise<void> {
    // nichts offen
  }
}
