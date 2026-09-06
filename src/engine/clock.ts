/**
 * Marktuhr: Die eigene Kalenderrechnung (core/time) ist die Grundlage,
 * `/v2/clock` des Brokers übersteuert sie — ersetzt sie aber nie. Fällt
 * der Broker aus, gilt der Kalender weiter; kennt der Broker einen
 * außerplanmäßigen Schluss, gewinnt der Broker. Krypto: immer offen.
 */
import type { AlpacaClient, AlpacaClock } from '../alpaca/types.ts';
import { errMsg, logger } from '../core/log.ts';
import { dayKeyFor, nextTradingDay, sessionBounds, MIN, type Calendar, type SessionBounds } from '../core/time.ts';
import type { AssetClass, Ms } from '../core/types.ts';

export interface MarketClockArgs {
  assetClass: AssetClass;
  calendar: Calendar | undefined;
  /** null ⇒ nur Kalender (Backtest-artige Nutzung). */
  client: AlpacaClient | null;
  now?: (() => Ms) | undefined;
}

export interface ClockSnapshot {
  isOpen: boolean;
  nextOpen: Ms;
  nextClose: Ms;
  timestamp: Ms;
  fetchedAt: Ms;
}

export class MarketClock {
  private readonly assetClass: AssetClass;
  private readonly calendar: Calendar | undefined;
  private readonly client: AlpacaClient | null;
  private readonly nowFn: () => Ms;
  private broker: ClockSnapshot | null = null;

  constructor(a: MarketClockArgs) {
    this.assetClass = a.assetClass;
    this.calendar = a.calendar;
    this.client = a.client;
    this.nowFn = a.now ?? (() => Date.now());
  }

  /** Broker-Uhr holen; Fehler ⇒ der letzte Stand bzw. der Kalender bleibt. */
  async refresh(): Promise<void> {
    if (!this.client) return;
    try {
      const c: AlpacaClock = await this.client.getClock();
      this.broker = { isOpen: c.isOpen, nextOpen: c.nextOpen, nextClose: c.nextClose, timestamp: c.timestamp, fetchedAt: this.nowFn() };
    } catch (e) {
      logger.warn('Marktuhr: /v2/clock nicht erreichbar — Kalender gilt', { error: errMsg(e) });
    }
  }

  /** Letzter Broker-Stand (für Status/Diagnose). */
  snapshot(): ClockSnapshot | null {
    return this.broker;
  }

  isOpen(at: Ms = this.nowFn()): boolean {
    if (this.assetClass === 'crypto') return true;
    const b = this.broker;
    if (b && at >= b.timestamp) {
      // Der Broker-Stand ist bis zum nächsten von ihm genannten Wechsel verbindlich.
      if (b.isOpen && at < b.nextClose) return true;
      if (b.isOpen && at >= b.nextClose && at < b.nextOpen) return false;
      if (!b.isOpen && at < b.nextOpen) return false;
    }
    const bounds = sessionBounds(dayKeyFor(at, this.assetClass), this.assetClass, this.calendar);
    return bounds !== null && at >= bounds.open && at < bounds.close;
  }

  today(at: Ms = this.nowFn()): string {
    return dayKeyFor(at, this.assetClass);
  }

  nextTradingDay(at: Ms = this.nowFn()): string {
    return nextTradingDay(this.today(at), this.assetClass, this.calendar);
  }

  /** Sitzungsgrenzen des Tages von `at`; ein früherer Broker-Schluss am selben Tag gewinnt. */
  sessionBoundsToday(at: Ms = this.nowFn()): SessionBounds | null {
    const bounds = sessionBounds(this.today(at), this.assetClass, this.calendar);
    if (!bounds || this.assetClass === 'crypto') return bounds;
    const b = this.broker;
    if (b && b.isOpen && dayKeyFor(b.nextClose, this.assetClass) === bounds.day && b.nextClose < bounds.close) {
      return { ...bounds, close: b.nextClose, minutes: Math.round((b.nextClose - bounds.open) / MIN) };
    }
    return bounds;
  }
}
