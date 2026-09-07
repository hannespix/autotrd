import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Env } from '../../src/core/config.ts';
import { setLogSink } from '../../src/core/log.ts';
import { createNotifier } from '../../src/notify/index.ts';

const TOKEN = '7000000002:AAG-fabrik-token-abcdefghijklmnopqrstu';

function cfg(telegram: boolean) {
  return parseConfig({ universe: { symbols: ['SPY'] }, notify: { telegram } });
}

function env(token: string, chat: string): Env {
  return {
    ALPACA_API_KEY: '',
    ALPACA_SECRET_KEY: '',
    ALPACA_ALLOW_LIVE: '0',
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_CHAT_ID: chat,
    AUTOTRD_HOME: '',
  };
}

function fakeFetch(): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response('{"ok":true}', { status: 200 });
  };
  return { fn, urls };
}

const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  setLogSink((l) => {
    lines.push(l);
  });
});

afterEach(() => {
  setLogSink((l) => process.stdout.write(l + '\n'));
});

describe('createNotifier', () => {
  it('Telegram aktiv + Zugangsdaten ⇒ Log UND Telegram', async () => {
    const { fn, urls } = fakeFetch();
    const notify = createNotifier({ config: cfg(true), env: env(TOKEN, '42'), fetchFn: fn });
    await notify('warn', 'Halt ausgelöst');

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('api.telegram.org');
    const logged = lines.find((l) => l.includes('Halt ausgelöst'));
    expect(logged).toBeDefined();
    expect(logged).toContain('"level":"warn"');
    expect(logged).toContain('"channel":"notify"');
    for (const l of lines) expect(l).not.toContain(TOKEN);
  });

  it('Telegram aktiv, aber Chat-ID fehlt ⇒ nur Log, einmalige Warnung', async () => {
    const { fn, urls } = fakeFetch();
    const notify = createNotifier({ config: cfg(true), env: env(TOKEN, ''), fetchFn: fn });
    await notify('info', 'a');
    await notify('error', 'b');

    expect(urls).toHaveLength(0);
    expect(lines.filter((l) => l.includes('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID fehlen'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('"msg":"a"') && l.includes('"level":"info"'))).toBe(true);
    expect(lines.some((l) => l.includes('"msg":"b"') && l.includes('"level":"error"'))).toBe(true);
  });

  it('Telegram aus ⇒ nur Log, auch wenn Zugangsdaten vorhanden sind', async () => {
    const { fn, urls } = fakeFetch();
    const notify = createNotifier({ config: cfg(false), env: env(TOKEN, '42'), fetchFn: fn });
    await notify('info', 'ruhig');
    expect(urls).toHaveLength(0);
    expect(lines.some((l) => l.includes('"msg":"ruhig"'))).toBe(true);
  });
});
