import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogLevel, setLogSink } from '../../src/core/log.ts';
import { TELEGRAM_MAX_TEXT, createTelegramNotifier, truncateText } from '../../src/notify/telegram.ts';

const TOKEN = '7000000001:AAF-testtoken-abcdefghijklmnopqrstuv';
const CHAT = '123456789';

interface Call {
  url: string;
  init: RequestInit;
}

/** Fake für fetch: zeichnet Aufrufe auf, antwortet per Handler (Default: 200 ok). */
function fakeFetch(handler?: (call: Call) => Response | Promise<Response>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, init: init ?? {} };
    calls.push(call);
    return handler ? handler(call) : new Response('{"ok":true,"result":{}}', { status: 200 });
  };
  return { fn, calls };
}

function bodyOf(call: Call): { chat_id: string; text: string; disable_web_page_preview: boolean } {
  return JSON.parse(String(call.init.body)) as { chat_id: string; text: string; disable_web_page_preview: boolean };
}

const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  setLogLevel('debug');
  setLogSink((l) => {
    lines.push(l);
  });
});

afterEach(() => {
  vi.useRealTimers();
  setLogLevel('info');
  setLogSink((l) => process.stdout.write(l + '\n'));
});

describe('createTelegramNotifier', () => {
  it('sendet POST an die Bot-URL mit chat_id, Text und ohne Link-Vorschau', async () => {
    const { fn, calls } = fakeFetch();
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: fn });
    await notify('info', 'Hallo Welt');

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(call)).toEqual({ chat_id: CHAT, text: 'ℹ️ Hallo Welt', disable_web_page_preview: true });
  });

  it('setzt je Level das passende Präfix', async () => {
    const { fn, calls } = fakeFetch();
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: fn });
    await notify('info', 'a');
    await notify('warn', 'b');
    await notify('error', 'c');
    expect(calls.map((c) => bodyOf(c).text)).toEqual(['ℹ️ a', '⚠️ b', '🚨 c']);
  });

  it('kürzt lange Texte auf 3900 Zeichen', async () => {
    const { fn, calls } = fakeFetch();
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: fn });
    await notify('info', 'x'.repeat(5000));
    const text = bodyOf(calls[0]!).text;
    expect(text.length).toBe(TELEGRAM_MAX_TEXT);
    expect(text.startsWith('ℹ️ xxx')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });

  it('truncateText zerschneidet kein Surrogatpaar', () => {
    const s = 'a'.repeat(8) + '🚨' + 'b'.repeat(8);
    // Schnitt fiele genau zwischen die beiden Hälften des Emojis (Index 9)
    const out = truncateText(s, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).toBe('a'.repeat(8) + '…');
    expect(truncateText('kurz', 10)).toBe('kurz');
  });

  it('Level-Filter: unterhalb von minLevel wird nichts gesendet', async () => {
    const { fn, calls } = fakeFetch();
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: fn, minLevel: 'warn' });
    await notify('info', 'leise');
    expect(calls).toHaveLength(0);
    await notify('warn', 'laut');
    await notify('error', 'lauter');
    expect(calls).toHaveLength(2);
  });

  it('wirft nie — weder bei Netzfehler noch bei HTTP-Fehler', async () => {
    const boom = fakeFetch(() => {
      throw new Error('ECONNRESET');
    });
    const n1 = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: boom.fn });
    await expect(n1('error', 'x')).resolves.toBeUndefined();

    const rejected = fakeFetch(() => new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 }));
    const n2 = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: rejected.fn });
    await expect(n2('warn', 'y')).resolves.toBeUndefined();

    const warned = lines.filter((l) => l.includes('"level":"warn"') && l.includes('Telegram'));
    expect(warned).toHaveLength(2);
    expect(warned[1]).toContain('"status":400');
    expect(warned[1]).toContain('chat not found');
  });

  it('der Bot-Token erscheint nie im Log — auch nicht über Fehlertexte oder Antwort-Bodies', async () => {
    const leaky = fakeFetch((call) => {
      if (call.url.endsWith('sendMessage') && bodyOf(call).text.includes('eins')) {
        throw new Error(`fetch failed for ${call.url}`);
      }
      return new Response(`Unauthorized for ${call.url}`, { status: 401 });
    });
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: leaky.fn });
    await notify('error', 'eins');
    await notify('error', 'zwei');

    const telegramLines = lines.filter((l) => l.includes('Telegram'));
    expect(telegramLines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l).not.toContain(TOKEN);
    expect(telegramLines.some((l) => l.includes('«geschwärzt»'))).toBe(true);
  });

  it('Drossel: höchstens 20 je Minute; der Rest wird an die nächste Nachricht gehängt', async () => {
    const { fn, calls } = fakeFetch();
    let clock = 1_700_000_000_000;
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: fn, now: () => clock });

    for (let i = 0; i < 25; i++) await notify('warn', `m${i}`);
    expect(calls).toHaveLength(20);
    expect(bodyOf(calls[19]!).text).toBe('⚠️ m19');

    // Noch im Fenster: weiterhin gedrosselt
    clock += 30_000;
    await notify('info', 'immer noch zu viel');
    expect(calls).toHaveLength(20);

    // Fenster abgelaufen: nächste Nachricht kommt durch und trägt die Zusammenfassung
    clock += 31_000;
    await notify('info', 'danach');
    expect(calls).toHaveLength(21);
    const text = bodyOf(calls[20]!).text;
    expect(text.startsWith('ℹ️ danach')).toBe(true);
    expect(text).toContain('… und 6 weitere Nachrichten');

    // Zähler ist geleert: keine doppelte Zusammenfassung
    await notify('info', 'noch eine');
    expect(bodyOf(calls[21]!).text).toBe('ℹ️ noch eine');
    expect(lines.filter((l) => l.includes('gedrosselt'))).toHaveLength(6);
  });

  it('Drossel: ohne weitere Nachricht kommt die Zusammenfassung nach Ablauf des Fensters von selbst', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch();
    const notify = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetchFn: fn });

    for (let i = 0; i < 23; i++) await notify(i === 22 ? 'error' : 'info', `m${i}`);
    expect(calls).toHaveLength(20);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(20);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls).toHaveLength(21);
    // Schwerstes unterdrücktes Level bestimmt das Präfix
    expect(bodyOf(calls[20]!).text).toBe('🚨 … und 3 weitere Nachrichten in der letzten Minute unterdrückt (Drossel 20/min)');
  });
});
