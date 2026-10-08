/**
 * Task 19, Teil 2: Finnhub-Adapter und Profil-Lauf.
 *
 * Verhalten mit gemocktem fetch: drei Abrufe je Symbol mit Schlüssel NUR in
 * der URL, Drossel (429) als Grund statt Weiterbrennen, Timeout als Grund;
 * dazu Quelltext-Wächter für das, was den Deploy betrifft: Secret-Guard
 * (dunkel ohne Schlüssel), Bindung + Diagnose-Liste, Export.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GEWINNTERMIN_TAGE, ProfilQuelleFehler, holeProfil } from '../src/core/profilQuelle.js';

const hier = dirname(fileURLToPath(import.meta.url));
const sync = readFileSync(join(hier, '../src/scheduled/profilSync.ts'), 'utf8');
const index = readFileSync(join(hier, '../src/index.ts'), 'utf8');
const workflow = readFileSync(join(hier, '../../.github/workflows/deploy-functions.yml'), 'utf8');
const quelle = readFileSync(join(hier, '../src/core/profilQuelle.ts'), 'utf8');

const antwort = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('holeProfil — Finnhub-Adapter', () => {
  it('drei Abrufe je Symbol, Schlüssel nur in der URL, Symbol übersetzt, Kalender ab heute bis +180 Tage', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/stock/profile2')) return antwort(200, { name: 'Berkshire', finnhubIndustry: 'Insurance', country: 'US' });
      if (url.includes('/stock/metric')) return antwort(200, { metric: { marketCapitalization: 900000, beta: 0.9 } });
      return antwort(200, { earningsCalendar: [{ date: '2026-11-07' }] });
    });
    const p = await holeProfil('BRK-B', 'geheim', '2026-10-08', fetchImpl, 'now');
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe('https://finnhub.io/api/v1/stock/profile2?symbol=BRK.B&token=geheim');
    expect(urls[1]).toBe('https://finnhub.io/api/v1/stock/metric?symbol=BRK.B&metric=all&token=geheim');
    expect(GEWINNTERMIN_TAGE).toBe(180);
    expect(urls[2]).toBe('https://finnhub.io/api/v1/calendar/earnings?symbol=BRK.B&from=2026-10-08&to=2027-04-06&token=geheim');
    expect(p).toMatchObject({ name: 'Berkshire', branche: 'Insurance', marktkapMio: 900000, beta: 0.9, gewinntermin: '2026-11-07', updatedAt: 'now' });
  });

  it('429 wird zum Grund rate_limit, 403 zu kein_zugriff — ohne den Schlüssel in der Meldung', async () => {
    const f429 = vi.fn(async () => antwort(429, {}));
    await expect(holeProfil('AAPL', 'geheim', '2026-10-08', f429)).rejects.toMatchObject({ grund: 'rate_limit' });
    const f403 = vi.fn(async () => antwort(403, {}));
    const err = await holeProfil('AAPL', 'geheim', '2026-10-08', f403).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfilQuelleFehler);
    expect(String((err as Error).message)).not.toContain('geheim');
    expect((err as ProfilQuelleFehler).grund).toBe('kein_zugriff');
  });
});

describe('profilSync — Deploy-Wächter', () => {
  it('ohne Schlüssel dunkel mit Grund, nie ein Fehler', () => {
    expect(sync).toContain("const schluessel = (): string => (process.env.FINNHUB_API_KEY ?? '').trim();");
    expect(sync).toContain("await standRef.set({ at: now.toISOString(), grund: 'keine_schluessel', v: PROFIL_STAND_V }, { merge: true });");
    expect(sync).toContain("return { ...leer, grund: 'keine_schluessel' };");
  });

  it('das Secret ist gebunden UND in der Deploy-Diagnose gelistet (ein gebundenes, fehlendes Secret bricht den Deploy)', () => {
    expect(sync).toContain("secrets: ['FINNHUB_API_KEY'],");
    expect(workflow).toContain('ALPACA_API_KEY ALPACA_SECRET_KEY FINNHUB_API_KEY');
  });

  it('Drossel bricht den Lauf ab (Grund statt Kontingent verbrennen); Budget-Konstanten unter der 60er-Grenze', () => {
    expect(sync).toContain("if (err instanceof ProfilQuelleFehler && (err.grund === 'rate_limit' || err.grund === 'kein_zugriff')) {");
    expect(sync).toContain('export const PROFIL_ABSTAND_MS = 3300;');
    expect(sync).toContain('export const PROFIL_PRO_LAUF = 80;');
    // 3 Abrufe je 3,3 s ≈ 55/min
    expect(3 * (60_000 / 3300)).toBeLessThan(60);
  });

  it('Lauf und Emulator-Trigger sind exportiert; der Trigger ist im Projekt gesperrt; Schreibziel ist market/{sym}.profil (nur Angemeldete)', () => {
    expect(index).toContain("export { profilSync, profilSyncNow } from './scheduled/profilSync.js';");
    expect(sync).toContain("if (process.env.FUNCTIONS_EMULATOR !== 'true') {");
    expect(sync).toContain('await db.doc(`market/${sym}`).set({ profil }, { merge: true });');
    expect(sync).not.toContain("doc('meta/profil/"); // kein öffentliches meta-Unterdokument
    // der Adapter kennt keine Yahoo-URL — marktQuelle pinnt Yahoo als Kursquelle, Profile sind getrennt
    expect(quelle).not.toContain('yahoo');
  });
});
