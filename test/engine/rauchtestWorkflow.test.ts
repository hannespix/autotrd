/**
 * Wächter um den Rauchtest herum: Workflow, CLI-Oberfläche, Doku.
 *
 * Der Rauchtest ist das einzige Stück dieses Repos, das im laufenden Betrieb
 * absichtlich eine Order erzeugt. Genau deshalb darf er nie von selbst
 * laufen, nie gegen Echtgeld, nie gegen die Plattform-Config und nie etwas
 * veröffentlichen. Diese Datei hält das fest — sie prüft Text, weil ein
 * Workflow nichts anderes ist.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const lies = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const WF = '.github/workflows/rauchtest.yml';
const text = lies(WF);
const wf = parseYaml(text) as Record<string, unknown>;
/** Der WIRKSAME Teil: Kommentare erklären, was nicht passieren darf — geprüft wird der Rest. */
const wirksam = text
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const cli = lies('src/cli.ts');
const betrieb = lies('docs/BETRIEB.md');

describe('Rauchtest-Workflow', () => {
  it('läuft NUR von Hand — kein Zeitplan, kein Aufruf durch andere Workflows', () => {
    const ausloeser = wf['on'] as Record<string, unknown>;
    expect(Object.keys(ausloeser)).toEqual(['workflow_dispatch']);
    expect(ausloeser['schedule']).toBeUndefined();
    expect(wirksam).not.toMatch(/^\s*schedule:/m);
    expect(wirksam).not.toMatch(/workflow_call/);
  });

  it('schaltet Echtgeld ab und lehnt einen Live-Key ab', () => {
    expect(text).toContain('ALPACA_ALLOW_LIVE=0');
    expect(wirksam).not.toContain('ALPACA_ALLOW_LIVE=1');
    // Ein AK-Key muss den Lauf beenden, bevor irgendetwas startet.
    expect(text).toMatch(/AK\*\)[^\n]*::error::/);
    expect(text).toMatch(/::error::ALPACA_API_KEY \/ ALPACA_SECRET_KEY fehlen/);
  });

  it('gibt keinen Key aus', () => {
    expect(text).not.toMatch(/echo[^\n]*\$ALPACA_(API|SECRET)_KEY/);
    expect(text).not.toMatch(/echo[^\n]*\$\{ALPACA_/);
  });

  it('läuft nur gegen eine Paper-Config, nie gegen die Plattform-Config', () => {
    expect(text).toContain('config/config.example.yaml');
    expect(wirksam).not.toContain('config/platform.yaml');
    // Die Beispiel-Config, gegen die er läuft, steht tatsächlich auf Paper.
    expect(lies('config/config.example.yaml')).toMatch(/^\s*mode:\s*paper\s*$/m);
  });

  it('veröffentlicht nichts (kein Service-Account, kein Champion, kein Firestore)', () => {
    expect(wirksam).not.toMatch(/google-github-actions\/auth/);
    expect(wirksam).not.toMatch(/publish-champion|publish-profile|sync-engine-config/);
    expect(wirksam).not.toMatch(/firebase|firestore/i);
  });

  it('begrenzt die Stückzahl und lädt das Protokoll auch nach einem Fehlschlag hoch', () => {
    expect(text).toMatch(/QTY" -gt 5/);
    expect(text).toMatch(/upload-artifact/);
    const schritte = ((wf['jobs'] as Record<string, { steps: Array<Record<string, unknown>> }>)['rauchtest']?.steps ?? []).filter((s) => String(s['uses'] ?? '').includes('upload-artifact'));
    expect(schritte).toHaveLength(1);
    expect(schritte[0]?.['if']).toBe('always()');
  });
});

describe('Rauchtest in CLI und Doku', () => {
  it('die CLI kennt das Kommando und seine Optionen', () => {
    expect(cli).toMatch(/case 'rauchtest':/);
    expect(cli).toMatch(/symbol: \{ type: 'string' \}/);
    expect(cli).toMatch(/qty: \{ type: 'string' \}/);
    expect(cli).toMatch(/timeout: \{ type: 'string' \}/);
    // USAGE verspricht nichts, was die CLI nicht liest (vgl. secreview #8).
    expect(cli).toMatch(/rauchtest: --symbol <sym> --qty <n> --timeout <sek>/);
  });

  it('alles, was das Kommando ausgibt oder schreibt, geht durch redact() (§0.8)', () => {
    const body = cli.slice(cli.indexOf('async function cmdRauchtest('), cli.indexOf('/* ───────────────────────── Symbolprofil'));
    expect(body).toMatch(/writeFileSync\(pfad, redact\(erg\.protokoll\)/);
    expect(body).toMatch(/out\(redact\(JSON\.stringify\(erg/);
    expect(body).toMatch(/out\(redact\(erg\.protokoll\)\)/);
    // Kein ungeschwärzter Weg nach draußen.
    expect(body).not.toMatch(/out\(erg\.protokoll\)/);
    expect(body).not.toMatch(/out\(JSON\.stringify\(erg/);
  });

  it('BETRIEB.md beschreibt das Kommando, die Echtgeld-Sperre und den eigenen Ordner', () => {
    expect(betrieb).toMatch(/## 10\. Rauchtest des Orderpfads/);
    expect(betrieb).toMatch(/--symbol/);
    expect(betrieb).toMatch(/--qty/);
    expect(betrieb).toMatch(/<home>\/rauchtest\//);
    expect(betrieb).toMatch(/rauchtestKind/);
  });
});
