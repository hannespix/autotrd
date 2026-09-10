/**
 * Veröffentlichung des Symbolprofils (`meta/symbolProfile`): das Skript-Modul,
 * die Rules-Allowlist, der Workflow-Schritt und die Dokumentgröße.
 *
 * Der Fall, der schon einmal Geld gekostet hat (Berichte): ein Pfad, der zur
 * Laufzeit nicht passt, und niemand sieht es vor der Nacht. Deshalb steht
 * hier alles, woran die Veröffentlichung scheitern könnte — statisch, ohne
 * Netz, und mit einem Profil in Plattformgröße (40 Symbole).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BarSeries } from '../../src/core/bars.ts';
import { parseConfig } from '../../src/core/config.ts';
import { msFromET } from '../../src/core/time.ts';
import type { Bar } from '../../src/core/types.ts';
import { buildSymbolProfiles, type ProfilWahl, type SymbolProfileFile } from '../../src/profile/symbolprofile.ts';
import { getStrategy } from '../../src/strategy/index.ts';
// @ts-expect-error — .mjs ohne Typen
import { MAX_PROFIL_BYTES, profilBytes, profilDokument, profilZusammenfassung, pruefeProfil, SYMBOL_PROFILE_PFAD, veroeffentlicheProfil } from '../../scripts/module/symbolProfile.mjs';

const dir = mkdtempSync(join(tmpdir(), 'autotrd-profil-skript-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Ein Profil in Plattformgröße: 40 Symbole, 400 Tagesbars, Basis-Wahl für alle (Rang, Stop, Grund). */
function plattformProfil(): SymbolProfileFile {
  const symbols = Array.from({ length: 40 }, (_, k) => `S${String(k).padStart(2, '0')}`);
  const config = parseConfig({ universe: { symbols, benchmark: 'S00', candidates: symbols }, timeframe: 1440 });
  const tage: number[] = [];
  const d = new Date(Date.UTC(2024, 0, 2));
  while (tage.length < 400) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) tage.push(msFromET(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const serien = new Map(
    symbols.map((s, k) => {
      const bars: Bar[] = tage.map((t, i) => {
        const c = (50 + k) * (1 + ((k % 7) - 3) * 0.001 * i) * (1 + (i % 2 === 0 ? 0.004 : -0.004));
        return { t, o: c, h: c * 1.01, l: c * 0.99, c, v: 800_000 };
      });
      return [s, BarSeries.from(bars)] as const;
    }),
  );
  const strategy = getStrategy('regime_allocation');
  const params = { ...strategy.defaults, lookback: 126, skip: 21, regimeLen: 150, topPct: 0.4, exitPct: 0.6, stopPct: 20 };
  const wahl: ProfilWahl = { strategy, params, source: 'basis', sizing: { mode: 'allocation', positionPct: 20 }, entriesAllowed: true };
  return buildSymbolProfiles({
    config,
    champion: null,
    choiceFor: () => wahl,
    barsFor: (s) => serien.get(s)!,
    now: tage[399]! + 8 * 3_600_000, // nach dem Schluss der letzten Bar
    lauf: { nummer: 41, id: '1', configCommit: 'abc' },
    generatedAt: 1,
  });
}

describe('scripts/module/symbolProfile.mjs', () => {
  const profil = plattformProfil();

  it('40 Symbole passen bequem in EIN Firestore-Dokument (Grenze 900 kB)', () => {
    const { doc, bytes } = profilDokument(profil, { seconds: 1, nanoseconds: 0 });
    expect(bytes).toBeLessThan(MAX_PROFIL_BYTES / 4);
    expect(bytes).toBeGreaterThan(10_000);
    expect(doc.profile.length).toBe(40);
    expect(doc.publishedAt).toEqual({ seconds: 1, nanoseconds: 0 });
    expect(profilBytes(doc)).toBeGreaterThan(0);
    // Gemessen (10.09.2026): 68 151 Bytes für 40 Symbole, rund 1,7 kB je Symbol.
  });

  it('lehnt fremde Versionen, fehlende Listen, Einträge ohne Symbol/Taktik und doppelte Symbole ab — nie raten', () => {
    expect(pruefeProfil(null)).toMatch(/kein Objekt/);
    expect(pruefeProfil({ ...profil, version: 2 })).toMatch(/Version 2/);
    expect(pruefeProfil({ ...profil, profile: 'x' })).toMatch(/keine Liste/);
    expect(pruefeProfil({ ...profil, profile: [{ taktik: {} }] })).toMatch(/ohne symbol/);
    expect(pruefeProfil({ ...profil, profile: [{ symbol: 'A' }] })).toMatch(/ohne taktik/);
    expect(pruefeProfil({ ...profil, profile: [{ symbol: 'A', taktik: { quelle: 'magie' } }] })).toMatch(/unbekannt/);
    expect(pruefeProfil({ ...profil, profile: [profil.profile[0], profil.profile[0]] })).toMatch(/doppelte Symbole/);
    expect(pruefeProfil(profil)).toBeNull();
    expect(() => profilDokument({ ...profil, version: 2 }, null)).toThrow(/nicht veröffentlicht/);
  });

  it('Übergröße wird abgelehnt statt still gekürzt', () => {
    const fett = { ...profil, profile: profil.profile.map((p) => ({ ...p, ballast: 'x'.repeat(30_000) })) };
    expect(() => profilDokument(fett, null)).toThrow(/über der Grenze/);
  });

  it('Zusammenfassung nennt Taktiken, Sperren und das Ziel', () => {
    const z = profilZusammenfassung(profil);
    expect(z).toMatchObject({ symbole: 40, taktiken: { basis: 40 }, gesperrt: [], ziel: 'meta/symbolProfile', lauf: { nummer: 41 } });
  });

  it('veroeffentlicheProfil schreibt genau ein Dokument unter meta/symbolProfile (gerade Segmentzahl)', async () => {
    const geschrieben: Array<{ path: string; data: Record<string, unknown> }> = [];
    const db = { doc: (path: string) => ({ set: async (data: Record<string, unknown>) => void geschrieben.push({ path, data }) }) };
    const r = await veroeffentlicheProfil(db, profil, 'TS');
    expect(SYMBOL_PROFILE_PFAD.split('/').length % 2).toBe(0);
    expect(geschrieben.map((g) => g.path)).toEqual(['meta/symbolProfile']);
    expect(geschrieben[0]!.data.publishedAt).toBe('TS');
    expect(r).toMatchObject({ pfad: 'meta/symbolProfile', symbole: 40 });
  });
});

describe('Rules, Workflow, Skript', () => {
  it('firestore.rules gibt meta/symbolProfile genauso frei wie meta/champion (Allowlist, kein Schreiben)', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    const m = /match \/meta\/\{doc\} \{\s*allow read: if doc in \[([^\]]*)\];\s*allow write: if false;/.exec(rules);
    expect(m, 'Allowlist für meta/{doc} nicht gefunden').not.toBeNull();
    const liste = m![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(liste).toContain('champion');
    expect(liste).toContain('symbolProfile');
    expect(SYMBOL_PROFILE_PFAD).toBe('meta/symbolProfile');
  });

  it('optimize.yml: profile.json im Artefakt; Veröffentlichung NACH Champion und Config, mit continue-on-error', () => {
    const wf = readFileSync('.github/workflows/optimize.yml', 'utf8');
    expect(wf).toMatch(/var\/profile\.json/);
    const champion = wf.indexOf('node scripts/publish-champion.mjs --home var');
    const config = wf.indexOf('node scripts/sync-engine-config.mjs');
    const profil = wf.indexOf('node scripts/publish-profile.mjs --home var');
    expect(champion).toBeGreaterThan(0);
    expect(config).toBeGreaterThan(champion);
    expect(profil).toBeGreaterThan(config);
    const schritt = wf.slice(wf.lastIndexOf('- name:', profil), profil);
    expect(schritt).toMatch(/continue-on-error: true/);
    expect(schritt).toMatch(/FIREBASE_SERVICE_ACCOUNT != ''/);
    // M2: Das Profil hängt am CHAMPION, nicht an der Config — läuft auch nach
    // einem gescheiterten Config-Sync (always()), aber nie ohne veröffentlichten
    // Champion (steps.champion.outcome), und ein Fehler bleibt als Annotation sichtbar.
    expect(schritt).toMatch(/always\(\)/);
    expect(schritt).toMatch(/steps\.champion\.outcome == 'success'/);
    const championSchritt = wf.slice(wf.lastIndexOf('- name:', champion), champion);
    expect(championSchritt).toMatch(/id: champion/);
    const lauf = wf.slice(profil, wf.indexOf('- name:', profil));
    expect(lauf).toMatch(/::warning::Symbolprofil nicht veröffentlicht/);
    expect(lauf).toMatch(/exit 1/);
  });

  it('publish-profile.mjs --dry-run liest <home>/profile.json, prüft und schreibt nichts; ohne Datei Abbruch', () => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'profile.json'), JSON.stringify(plattformProfil()), 'utf8');
    const out = execFileSync('node', ['scripts/publish-profile.mjs', '--home', home, '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/--dry-run: nichts geschrieben/);
    const summary = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)) as Record<string, unknown>;
    expect(summary).toMatchObject({ symbole: 40, ziel: 'meta/symbolProfile' });
    expect(typeof summary.bytes).toBe('number');
    expect(() => execFileSync('node', ['scripts/publish-profile.mjs', '--home', join(dir, 'leer'), '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
  });
});
