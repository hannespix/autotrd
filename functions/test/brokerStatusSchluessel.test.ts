/**
 * Quelltext-Wächter: brokerStatus zeigt nie das Betreiber-Konto und
 * schickt nie ein Chiffrat als Passwort (Audit 13.08., H2).
 *
 * Der Doppelfehler: (1) Ohne eigene Schlüssel zählte die
 * Betreiber-Umgebung als „Schlüssel vorhanden" — `keys = null` fiel in
 * `alpacaFetch` auf die env-Schlüssel zurück, und der Nutzer sah Cash und
 * Depot des BETREIBER-Kontos, gegen das auch noch sein Buch „abgeglichen"
 * wurde (Cross-User-Leck). (2) `nutzerSchluessel` las das `secretKey`-Feld
 * ROH — seit dem keyVault liegt dort ein AES-256-GCM-Chiffrat, das als
 * Passwort an Alpaca ging: Jedes neu verbundene Konto meldete fälschlich
 * „Verbindung fehlgeschlagen".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const status = readFileSync(join(hier, '../src/callable/brokerStatus.ts'), 'utf8');

describe('brokerStatus — Schlüssel-Grenze (H2)', () => {
  it('entschlüsselt das Geheimnis wie brokerVerbindung — nie roh verwenden', () => {
    expect(status).toContain("from '../core/keyVault.js'");
    const fn = status.slice(status.indexOf('async function nutzerSchluessel'));
    const gelesen = fn.indexOf("d.get('secretKey')");
    const entschluesselt = fn.indexOf('entschluessle(gespeichert)');
    expect(gelesen).toBeGreaterThan(-1);
    expect(entschluesselt).toBeGreaterThan(gelesen);
    // Das rohe Feld darf nicht mehr direkt als secret weiterlaufen.
    expect(fn).not.toContain('const secret = d.get(');
  });

  it('Papier-Modus kennt keinen env-Fallback — ohne eigene Schlüssel kein Broker', () => {
    expect(status).toContain(
      "modus === 'live' ? alpacaKonfiguriert() : eigeneKeys !== null",
    );
    // Die alte ODER-Form (eigene Schlüssel ODER Betreiber-Umgebung) war das
    // Leck und darf nicht zurückkommen.
    expect(status).not.toContain('eigeneKeys !== null || alpacaKonfiguriert()');
  });
});
