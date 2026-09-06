/**
 * Telegram-Benachrichtigung über die Bot-API (`sendMessage`).
 *
 * Grundsätze:
 * - Eine kaputte Benachrichtigung darf den Handel nie stören: Fehler werden
 *   nur geloggt, nie geworfen; ein Sendeversuch dauert höchstens
 *   TELEGRAM_TIMEOUT_MS.
 * - Der Bot-Token steht in der URL. Er wird beim Bau registriert
 *   (`registerSecret`), damit ihn keine Fehlermeldung ins Log trägt.
 * - Drossel: höchstens TELEGRAM_RATE_LIMIT Nachrichten je Minute. Was
 *   darüber liegt, wird gezählt und als „… und N weitere" nachgereicht —
 *   angehängt an die nächste Nachricht, die durchkommt, oder nach Ablauf
 *   des Fensters als eigene Nachricht (Timer ohne ref, hält den Prozess
 *   nicht am Leben).
 */
import { errMsg, logger, registerSecret } from '../core/log.ts';

export type NotifyLevel = 'info' | 'warn' | 'error';

/** Löst nie ab (rejected nie) — Aufruf mit `void notify(...)` ist sicher. */
export type Notifier = (level: NotifyLevel, text: string) => Promise<void>;

/** Telegram erlaubt 4096 Zeichen; Reserve für Präfix und Drossel-Hinweis. */
export const TELEGRAM_MAX_TEXT = 3900;
export const TELEGRAM_RATE_LIMIT = 20;
export const TELEGRAM_RATE_WINDOW_MS = 60_000;
export const TELEGRAM_TIMEOUT_MS = 10_000;

const RANK: Record<NotifyLevel, number> = { info: 0, warn: 1, error: 2 };
const PREFIX: Record<NotifyLevel, string> = { info: 'ℹ️', warn: '⚠️', error: '🚨' };

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  /** Für Tests: Ersatz für globales fetch. */
  fetchFn?: typeof fetch;
  /** Nachrichten unterhalb dieses Levels werden verworfen (Default: info = alles). */
  minLevel?: NotifyLevel;
  /** Für Tests: Uhr der Drossel. */
  now?: () => number;
}

/** Kürzt auf `max` UTF-16-Einheiten, ohne ein Surrogatpaar (Emoji) zu zerschneiden. */
export function truncateText(text: string, max = TELEGRAM_MAX_TEXT): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + '…';
}

export function createTelegramNotifier(opts: TelegramNotifierOptions): Notifier {
  const { botToken, chatId } = opts;
  registerSecret(botToken);
  const doFetch: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const minRank = RANK[opts.minLevel ?? 'info'];
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  /** Zeitstempel der im Fenster gesendeten Nachrichten (älteste zuerst). */
  const sentAt: number[] = [];
  let suppressed = 0;
  let suppressedWorst: NotifyLevel = 'info';
  let flushTimer: NodeJS.Timeout | null = null;

  const prune = (t: number): void => {
    while (sentAt.length > 0 && sentAt[0]! <= t - TELEGRAM_RATE_WINDOW_MS) sentAt.shift();
  };

  const summaryText = (n: number): string =>
    `… und ${n} weitere Nachricht${n === 1 ? '' : 'en'} in der letzten Minute unterdrückt (Drossel ${TELEGRAM_RATE_LIMIT}/min)`;

  const send = async (level: NotifyLevel, text: string): Promise<void> => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: truncateText(`${PREFIX[level]} ${text}`),
      disable_web_page_preview: true,
    });
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch (e) {
          detail = errMsg(e);
        }
        logger.warn('Telegram: sendMessage abgelehnt', { status: res.status, detail });
      }
    } catch (e) {
      logger.warn('Telegram: Senden fehlgeschlagen', { error: errMsg(e) });
    }
  };

  const takeSuppressed = (): { n: number; level: NotifyLevel } => {
    const out = { n: suppressed, level: suppressedWorst };
    suppressed = 0;
    suppressedWorst = 'info';
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return out;
  };

  const scheduleFlush = (t: number): void => {
    if (flushTimer) return;
    const oldest = sentAt[0] ?? t;
    const delay = Math.max(1, oldest + TELEGRAM_RATE_WINDOW_MS - t + 1);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delay);
    flushTimer.unref();
  };

  /** Nachgereichte Zusammenfassung, wenn nach dem Fenster keine weitere Nachricht kam. */
  const flush = async (): Promise<void> => {
    if (suppressed === 0) return;
    const t = now();
    prune(t);
    if (sentAt.length >= TELEGRAM_RATE_LIMIT) {
      scheduleFlush(t);
      return;
    }
    const { n, level } = takeSuppressed();
    sentAt.push(t);
    await send(level, summaryText(n));
  };

  return async (level, text) => {
    if (RANK[level] < minRank) return;
    const t = now();
    prune(t);
    if (sentAt.length >= TELEGRAM_RATE_LIMIT) {
      suppressed++;
      if (RANK[level] > RANK[suppressedWorst]) suppressedWorst = level;
      logger.debug('Telegram: gedrosselt', { level, suppressed });
      scheduleFlush(t);
      return;
    }
    sentAt.push(t);
    let msg = text;
    if (suppressed > 0) {
      const { n } = takeSuppressed();
      msg = `${text}\n\n${summaryText(n)}`;
    }
    await send(level, msg);
  };
}
