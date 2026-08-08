/**
 * Secret-Diagnose: Der erste Entwurf hat die Aufruf-Konvention von `gfetch`
 * geraten statt gelesen — es gibt bei Erfolg kein `.status`, und bei jedem
 * Nicht-2xx wird geworfen. Ergebnis war „unerwartete Antwort HTTP undefined"
 * für ein Secret, das in Wahrheit existierte.
 *
 * Diese Fehlerklasse ist im CI teuer: Der Schritt ist absichtlich nie rot,
 * also fällt eine falsche Auswertung überhaupt nicht auf — sie liefert
 * einfach eine irreführende Antwort, und auf die setzt danach eine
 * Deploy-Entscheidung auf. Deshalb hier alle vier Ausgänge, netzfrei.
 */
import { describe, expect, it } from 'vitest';
import { pruefeSecret } from '../../scripts-ci/check-secret.mjs';

const BASIS = 'https://secretmanager.googleapis.com/v1/projects/p/secrets';

/** Bildet die gfetch-Konvention nach: Erfolg → Daten, Fehler → Wurf mit .status. */
function fake(routen: Record<string, unknown | (() => never)>) {
  return async (url: string): Promise<unknown> => {
    const treffer = Object.entries(routen).find(([teil]) => url.includes(teil));
    if (!treffer) throw Object.assign(new Error(`GET ${url} → 404`), { status: 404 });
    const wert = treffer[1];
    if (typeof wert === 'function') return (wert as () => never)();
    return wert;
  };
}

const wirft = (status: number, text = 'Fehler') => () => {
  throw Object.assign(new Error(`GET → ${status}: ${text}`), { status });
};

describe('pruefeSecret', () => {
  it('vorhanden mit aktiver Version ⇒ bereit zum Binden', async () => {
    const r = await pruefeSecret(
      'ANTHROPIC_API_KEY',
      BASIS,
      fake({
        '/versions?': { versions: [{ name: 'v1' }, { name: 'v2' }] },
        '/ANTHROPIC_API_KEY': { createTime: '2026-07-20T10:00:00Z' },
      }),
    );
    expect(r.stand).toBe('bereit');
    expect(r.text).toContain('VORHANDEN mit 2 aktiven Version(en)');
    expect(r.text).toContain('2026-07-20');
  });

  it('404 auf das Secret ⇒ existiert nicht (kein „Prüfung fehlgeschlagen")', async () => {
    const r = await pruefeSecret('BROKER_MASTER_KEY', BASIS, fake({}));
    expect(r.stand).toBe('fehlt');
    expect(r.text).toBe('EXISTIERT NICHT.');
  });

  it('existiert, aber ohne aktive Version ⇒ Warnung statt „bereit"', async () => {
    const r = await pruefeSecret(
      'LEER',
      BASIS,
      fake({ '/versions?': { versions: [] }, '/LEER': { createTime: '2026-08-01T00:00:00Z' } }),
    );
    expect(r.stand).toBe('ohne_version');
    expect(r.text).toContain('KEINE aktive Version');
  });

  it('403 ⇒ fehlende Leseberechtigung wird als solche benannt', async () => {
    const r = await pruefeSecret('X', BASIS, fake({ '/X': wirft(403, 'PERMISSION_DENIED') }));
    expect(r.stand).toBe('kein_zugriff');
    expect(r.text).toContain('roles/secretmanager.viewer');
  });

  it('Secret lesbar, Versionsliste nicht ⇒ meldet vorhanden mit Vorbehalt', async () => {
    const r = await pruefeSecret(
      'Y',
      BASIS,
      fake({ '/versions?': wirft(500, 'kaputt'), '/Y': { createTime: '2026-08-02T00:00:00Z' } }),
    );
    expect(r.stand).toBe('vorhanden_version_unklar');
    expect(r.text).toContain('VORHANDEN');
  });

  it('nennt immer den geprüften Namen zurück', async () => {
    const r = await pruefeSecret('EGAL', BASIS, fake({}));
    expect(r.name).toBe('EGAL');
  });
});
