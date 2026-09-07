/**
 * Symbol-Schreibweisen an der Alpaca-Grenze.
 *
 * Kanonisch ist überall die Trading-Schreibweise (Aktien "AAPL", "BRK.B";
 * Krypto "BTC/USD"). Alpaca selbst ist nicht einheitlich: Der Bestand
 * (/v2/positions) liefert Krypto als "BTCUSD", Orders und Daten-API nutzen
 * "BTC/USD". Nutzer tippen alles Mögliche ("brk-b", "btc-usd", "BTCUSD").
 * Die Übersetzung steht NUR hier, damit sich die Regeln nicht über den
 * Code verteilen und still auseinanderlaufen.
 */
import type { AssetClass } from '../core/types.ts';

/** Quote-Währungen der Alpaca-Krypto-Paare. Beim Zerlegen gewinnt die längste passende Endung. */
export const CRYPTO_QUOTE_CURRENCIES: readonly string[] = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];

// Längste Endung zuerst, sonst würde "BTCUSDT" fälschlich als "BTCUSD"+"T" gelesen.
const QUOTES_BY_LENGTH = [...CRYPTO_QUOTE_CURRENCIES].sort((a, b) => b.length - a.length);

/** "BTCUSD" → ["BTC", "USD"]; null, wenn keine bekannte Quote-Endung passt (Basis darf nicht leer sein). */
export function splitCryptoPair(compact: string): [string, string] | null {
  const s = compact.trim().toUpperCase();
  for (const quote of QUOTES_BY_LENGTH) {
    if (s.length > quote.length && s.endsWith(quote)) {
      return [s.slice(0, -quote.length), quote];
    }
  }
  return null;
}

/**
 * Nutzereingabe → kanonische Schreibweise. Tolerant, aber ohne Raten:
 *  - Aktien: "brk-b"/"BRK-B" → "BRK.B" (nur Anteilsklassen-Muster
 *    [A-Z]{1,4}-[A-Z]; ".U"/".W" für Units/Warrants bleiben unangetastet).
 *  - Krypto: "btc-usd", "BTCUSD", "btc/usd" → "BTC/USD".
 * Ob das Symbol existiert, entscheidet später `getAsset()` — nicht diese Funktion.
 */
export function normalizeUserSymbol(input: string, assetClass: AssetClass): string {
  const s = input.trim().toUpperCase();
  if (assetClass === 'crypto') {
    const compact = s.replace(/\s+/g, '');
    if (compact.includes('/')) return compact;
    if (compact.includes('-')) return compact.replace('-', '/');
    const pair = splitCryptoPair(compact);
    return pair ? `${pair[0]}/${pair[1]}` : compact;
  }
  const shareClass = /^([A-Z]{1,4})-([A-Z])$/.exec(s);
  if (shareClass) return `${shareClass[1]}.${shareClass[2]}`;
  return s;
}

/**
 * Symbol aus dem Bestand (/v2/positions) → kanonisch. Alpaca liefert Krypto
 * dort ohne Schrägstrich ("BTCUSD"). Idempotent: "BTC/USD" bleibt "BTC/USD".
 * Aktien werden unverändert durchgereicht.
 */
export function fromPositionSymbol(symbol: string, assetClass: AssetClass): string {
  if (assetClass !== 'crypto') return symbol;
  const s = symbol.trim().toUpperCase();
  if (s.includes('/')) return s;
  const pair = splitCryptoPair(s);
  return pair ? `${pair[0]}/${pair[1]}` : s;
}

/** Kanonisch → Bestands-Schreibweise ("BTC/USD" → "BTCUSD"); Aktien unverändert. */
export function toPositionSymbol(symbol: string): string {
  return symbol.replace('/', '');
}

/** Für URL-Pfade: "BTC/USD" → "BTC%2FUSD" (ein roher Schrägstrich wäre ein Pfadsegment). */
export function encodePathSymbol(symbol: string): string {
  return encodeURIComponent(symbol);
}
