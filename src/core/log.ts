/**
 * Strukturiertes Logging mit Secret-Schwärzung. Alpaca-Fehlertexte können
 * den gesendeten Header enthalten — deshalb wird JEDE Ausgabe durch
 * `redact()` geführt. Die Schlüssel werden beim Start registriert.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';
const secrets: string[] = [];
let sink: (line: string) => void = (line) => process.stdout.write(line + '\n');

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

/** Werte registrieren, die nie im Log erscheinen dürfen (Keys, Tokens). */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6 && !secrets.includes(value)) secrets.push(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('«geschwärzt»');
  // Alpaca-Header-Muster zusätzlich generisch schwärzen
  out = out.replace(/(APCA-API-(?:KEY-ID|SECRET-KEY)\s*[:=]\s*)\S+/gi, '$1«geschwärzt»');
  out = out.replace(/\b(PK|AK)[A-Z0-9]{16,}\b/g, '$1«geschwärzt»');
  return out;
}

export function safeStringify(value: unknown): string {
  try {
    return redact(
      JSON.stringify(value, (_k, v) => {
        if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
        if (typeof v === 'bigint') return v.toString();
        return v as unknown;
      }),
    );
  } catch {
    return '"<nicht serialisierbar>"';
  }
}

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: redact(msg) };
  if (data) Object.assign(rec, data);
  sink(safeStringify(rec));
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};

/** Fehlermeldung eines unbekannten Wurfobjekts, geschwärzt. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return redact(e.message);
  return redact(String(e));
}
