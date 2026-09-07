/**
 * Quelltext-Wächter: brokerStatus zeigt nie das Betreiber-Konto und
 * schickt nie ein Chiffrat als Passwort (Audit 13.08., H2).
 *
 * Der Doppelfehler von damals: (1) Ohne eigene Schlüssel zählte die
 * Betreiber-Umgebung als „Schlüssel vorhanden" — der Nutzer sah Cash und
 * Depot des BETREIBER-Kontos (Cross-User-Leck). (2) Das `secretKey`-Feld
 * wurde ROH gelesen — seit dem keyVault liegt dort ein AES-256-GCM-Chiffrat,
 * das als Passwort an Alpaca ging.
 *
 * Seit dem Rückbau der Handelsplattform gibt es dafür genau EINE Stelle:
 * `brokerZugang.brokerVerbindungLesend` liest und entschlüsselt. Die Karte
 * darf weder selbst ins Schlüssel-Dokument greifen noch auf die Umgebung
 * zurückfallen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const status = readFileSync(join(hier, '../src/callable/brokerStatus.ts'), 'utf8');
const zugang = readFileSync(join(hier, '../src/core/brokerZugang.ts'), 'utf8');

describe('brokerStatus — Schlüssel-Grenze (H2)', () => {
  it('holt die Verbindung ausschließlich über brokerZugang', () => {
    expect(status).toContain("from '../core/brokerZugang.js'");
    expect(status).toContain('await brokerVerbindungLesend(uid)');
    // Kein eigener Griff ins Schlüssel-Dokument, kein rohes Geheimnis.
    expect(status).not.toContain("d.get('secretKey')");
    expect(status).not.toContain('private/broker');
    expect(status).not.toContain('entschluessle(');
  });

  it('brokerZugang entschlüsselt über den keyVault — nie roh verwenden', () => {
    const fn = zugang.slice(zugang.indexOf('export async function brokerVerbindungLesend'));
    const gelesen = fn.indexOf("doc.get('secretKey')");
    const entschluesselt = fn.indexOf('entschluessle(gespeichert)');
    expect(gelesen).toBeGreaterThan(-1);
    expect(entschluesselt).toBeGreaterThan(gelesen);
  });

  it('kein env-Fallback — ohne eigene Schlüssel kein Broker', () => {
    expect(status).toContain('const schluesselVorhanden = verbindung !== null;');
    for (const verboten of ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY', 'envSchluessel', 'alpacaKonfiguriert']) {
      expect(status, `${verboten} darf in brokerStatus nicht vorkommen`).not.toContain(verboten);
    }
  });

  it('das Konto wird am Endpunkt der SCHLÜSSELART gefragt, nie am Wunsch-Modus', () => {
    // Ein Papier-Schlüssel darf nie an den Echtgeld-Endpunkt — und umgekehrt.
    expect(status).toContain('mode: verbindung.mode,');
    expect(status).not.toContain('mode: modus');
  });

  it('der effektive Modus kommt aus derselben Guard-Kette wie der Order-Pfad', () => {
    expect(status).toContain('const scharf = await brokerVerbindung(uid);');
  });
});
