/**
 * SECREVIEW2 #9 — Nur `engineTick` bindet `secrets: ['BROKER_MASTER_KEY', …]` (engineTick.ts L89).
 * Die Callables `connectBroker`, `brokerStatus`, `setLiveMode`, `resetWallet` laufen mit
 * `CALLABLE_OPTS = { enforceAppCheck, invoker }` (appcheck.ts L23) — ohne Secret. In ihrer Laufzeit
 * ist `process.env.BROKER_MASTER_KEY` leer, also `vaultBereit() === false` (keyVault.ts L73):
 *   - connectBroker speichert Papier-Schlüssel im KLARTEXT (`secretKey: vaultBereit() ? … : secret`,
 *     connectBroker.ts L236) und lehnt jeden AK-Schlüssel ab („verschlüsselte Ablage nicht eingerichtet"),
 *   - brokerStatus/setLiveMode/reset können ein `v1:`-Chiffrat nicht entschlüsseln (`entschluessle` ⇒ null)
 *     und melden „kein Broker" — der ganze Live-Pfad der App ist damit unerreichbar,
 * während der Takt (mit Secret) dieselben Docs entschlüsselt. docs/SETUP.md §2 verlangt die Deklaration
 * in connectBroker.ts ausdrücklich. Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = (p: string): string => readFileSync(join(hier, '../../src', p), 'utf8');

describe('secreview2: BROKER_MASTER_KEY erreicht die Callables nicht', () => {
  it.each(['callable/connectBroker.ts', 'callable/brokerStatus.ts', 'callable/setLiveMode.ts', 'callable/reset.ts'])(
    '%s bindet BROKER_MASTER_KEY (direkt oder über CALLABLE_OPTS)',
    (datei) => {
      const src = quelle(datei);
      const opts = quelle('core/appcheck.ts');
      const bindet = /secrets\s*:\s*\[[^\]]*BROKER_MASTER_KEY/.test(src) || /secrets\s*:\s*\[[^\]]*BROKER_MASTER_KEY/.test(opts);
      expect(bindet, `${datei}: keyVault ohne Hauptschlüssel ⇒ Klartext-Ablage / Live-Pfad tot`).toBe(true);
    },
  );
});
