/**
 * Symbol-Logos über UNSERE Domain (Owner 20.08.: „richtige Logos wie im
 * Screenshot").
 *
 * Der Browser fragt nie einen Dritt-Server: Diese Function holt das Logo
 * serverseitig bei Parqet (assets.parqet.com — Ticker-basiert, EU) und
 * reicht es mit langen Cache-Headern durch. Je Browser und Symbol entsteht
 * damit höchstens ein Request im Monat; der Instanz-Cache bündelt den Rest.
 * Kein Logo ⇒ 404 mit Tages-Cache — das Frontend zeigt dann einfach das
 * Monogramm weiter (Fallback-Kette in symbolAvatar.ts). Bewusst OHNE
 * Storage-Abhängigkeit: ein kalter Cache kostet nur den ersten Treffer.
 */
import { onRequest } from 'firebase-functions/v2/https';

const SYMBOL_OK = /^[A-Z0-9.^-]{1,12}$/;

/** Instanz-Cache: Symbol → Bild oder „gibt es nicht" (null). */
const cache = new Map<string, { typ: string; bytes: Buffer } | null>();

async function holeLogo(symbol: string): Promise<{ typ: string; bytes: Buffer } | null> {
  const quellen = [`https://assets.parqet.com/logos/symbol/${encodeURIComponent(symbol)}?format=png`];
  // Alpaca-Krypto heißt BTCUSD/ETHUSD — Parqet führt die Coins unter crypto/.
  if (symbol.endsWith('USD') && symbol.length > 4) {
    quellen.push(`https://assets.parqet.com/logos/crypto/${encodeURIComponent(symbol.slice(0, -3))}?format=png`);
  }
  for (const url of quellen) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const typ = res.headers.get('content-type') ?? '';
      if (!typ.startsWith('image/')) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 50) return { typ, bytes };
    } catch {
      // Zeitüberschreitung o. Ä. — nächste Quelle bzw. sauberes 404.
    }
  }
  return null;
}

export const logo = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  const symbol = String(req.query['symbol'] ?? '').toUpperCase();
  if (!SYMBOL_OK.test(symbol)) {
    res.status(400).send('symbol?');
    return;
  }
  if (!cache.has(symbol)) cache.set(symbol, await holeLogo(symbol));
  const treffer = cache.get(symbol) ?? null;
  if (!treffer) {
    res.set('Cache-Control', 'public, max-age=86400').status(404).send('');
    return;
  }
  res.set('Cache-Control', 'public, max-age=2592000, immutable');
  res.type(treffer.typ).send(treffer.bytes);
});
