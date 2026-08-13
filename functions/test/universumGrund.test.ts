/**
 * Universum-Sync mit Grund (Owner-Thema #123, Befund 13.08.).
 *
 * `meta/alpacaUniversum` wurde seit #246 NIE geschrieben — und WARUM, stand
 * ausschließlich in Cloud Logging. Der Sync liefert seinen Abbruchgrund jetzt
 * als Rückgabewert, `universumSyncNow` reicht ihn in die HTTP-Antwort durch,
 * und die Deploy-Aufwärm-Kette druckt sie ins Actions-Log — die Frage „warum
 * ist das Universum leer?" ist damit ohne GCP-Konsole beantwortbar.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const sync = readFileSync(join(hier, '../src/scheduled/universumSync.ts'), 'utf8');
const daily = readFileSync(join(hier, '../../scripts-ci/invoke-daily.mjs'), 'utf8');
const scan = readFileSync(join(hier, '../../scripts-ci/invoke-scan.mjs'), 'utf8');
const workflow = readFileSync(join(hier, '../../.github/workflows/deploy-functions.yml'), 'utf8');

describe('Universum-Sync-Grund (Quelltext-Wächter)', () => {
  it('jeder Abbruchpfad liefert einen maschinenlesbaren Grund', () => {
    expect(sync).toContain("return { stand: null, grund: 'keine_schluessel' };");
    expect(sync).toContain('grund: `abruf_fehlgeschlagen: ${');
    expect(sync).toContain("return { stand: null, grund: 'leere_antwort' };");
    expect(sync).toContain('return { stand, grund: null };');
  });

  it('universumSyncNow reicht den Grund in die HTTP-Antwort durch', () => {
    expect(sync).toContain("res.json(r.stand ?? { ok: false, grund: r.grund ?? 'kein_stand' });");
  });

  it('die Deploy-Aufwärm-Kette stößt den Sync an und druckt die Antwort', () => {
    // Reihenfolge + logBody prüft invokeDaily.test.mjs an den RUNS selbst;
    // hier hängt der Anschluss: --only im Workflow und die logBody-Mechanik.
    expect(workflow).toContain('--only snapshotequity,evalforecasts,universumsyncnow,momentumrun,kibericht');
    expect(daily).toContain('await invoke(run.service, run.invokeOpts);');
    expect(scan).toContain('if (logBody) {');
  });
});
