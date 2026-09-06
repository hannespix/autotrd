/**
 * Benachrichtigungs-Fabrik. Jede Benachrichtigung landet IMMER im Log
 * (das Log ist die Wahrheit über das Geschehen); Telegram kommt dazu, wenn
 * `notify.telegram: true` gesetzt ist UND Token + Chat-ID in der Umgebung
 * stehen. Fehlt eines davon, wird das einmal beim Bau als Warnung geloggt
 * — nicht bei jeder Nachricht.
 */
import type { Config, Env } from '../core/config.ts';
import { log, logger } from '../core/log.ts';
import { createTelegramNotifier, type Notifier } from './telegram.ts';

export type { Notifier, NotifyLevel } from './telegram.ts';
export { createTelegramNotifier } from './telegram.ts';

/** Nur ins Log — der Fallback, der immer funktioniert. */
export function createLogNotifier(): Notifier {
  return async (level, text) => {
    log(level, text, { channel: 'notify' });
  };
}

export function createNotifier(a: { config: Config; env: Env; fetchFn?: typeof fetch }): Notifier {
  const logOnly = createLogNotifier();
  if (!a.config.notify.telegram) return logOnly;

  const botToken = a.env.TELEGRAM_BOT_TOKEN;
  const chatId = a.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    logger.warn('notify.telegram ist aktiv, aber TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID fehlen — Benachrichtigungen nur im Log');
    return logOnly;
  }

  const telegram = createTelegramNotifier({ botToken, chatId, ...(a.fetchFn ? { fetchFn: a.fetchFn } : {}) });
  logger.info('Telegram-Benachrichtigung aktiv');
  return async (level, text) => {
    await logOnly(level, text);
    await telegram(level, text);
  };
}
