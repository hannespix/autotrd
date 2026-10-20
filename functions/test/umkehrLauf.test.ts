/**
 * Kurzfrist-Umkehr, Tagesläufe (Task 34): pure Teile des Laufs und die
 * Verdrahtung jeder Stelle, die eine Umkehr-Position anders behandeln muss
 * als eine Konfluenz-Position. Eine vergessene Stelle hieße: Der Scan
 * verkauft sie am alten 2-%-Stop, oder er kauft für das Konto weiter.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({}), FieldValue: {} }));

import type { Position } from '../../shared/src/index.js';
import { umkehrBesitz } from '../../shared/src/index.js';
import {
  PLAN_MAX_ALTER_TAGE,
  kerzenFuerSignal,
  kerzenTag,
  kontoPlan,
  planFrisch,
  sitzungVorbei,
  umkehrStueck,
  umkehrUniversum,
  type UmkehrPlan,
} from '../src/scheduled/umkehrLauf.js';

const hier = dirname(fileURLToPath(import.meta.url));
const lies = (rel: string): string => readFileSync(join(hier, rel), 'utf8');

const pos = (over: Partial<Position> = {}): Position => ({
  symbol: 'X', qty: 10, avgEntry: 100, stopLoss: 85, takeProfit: null, openedAt: '2026-10-15T13:35:00Z', quelle: 'umkehr', ...over,
});

describe('Plan je Konto', () => {
  const signale = [
    { symbol: 'XLF', rsi: 6, schluss: 50 },
    { symbol: 'AAPL', rsi: 3, schluss: 200 },
    { symbol: 'QQQ', rsi: 8, schluss: 500 },
  ];

  it('kauft nie, was das Konto schon hält (Sockel, Altbestand, Umkehr), tiefster RSI zuerst', () => {
    const halten = new Map<string, Position>([
      ['AAPL', pos({ core: true, quelle: 'sockel' })],
      ['MSFT', pos({ quelle: 'konfluenz' })],
    ]);
    const p = kontoPlan(halten, signale, new Map(), 10);
    expect(p.kaufen.map((k) => k.symbol)).toEqual(['XLF', 'QQQ']);
    expect(p.verkaufen).toEqual([]);
  });

  it('nur eigene Umkehr-Positionen zählen gegen die Plätze; Verkäufe machen Plätze frei', () => {
    const halten = new Map<string, Position>();
    for (let i = 0; i < 10; i++) halten.set(`U${i}`, pos({ symbol: `U${i}` }));
    halten.set('ALT', pos({ quelle: 'konfluenz' })); // zählt nicht
    expect(kontoPlan(halten, signale, new Map(), 10).kaufen).toEqual([]);
    const p = kontoPlan(halten, signale, new Map([['U3', 'umkehr_erholt' as const]]), 10);
    expect(p.verkaufen).toEqual([{ symbol: 'U3', grund: 'umkehr_erholt' }]);
    expect(p.kaufen.map((k) => k.symbol)).toEqual(['AAPL']);
  });

  it('Ausstiegssignal für fremde Positionen wird ignoriert (Besitzgrenze)', () => {
    const halten = new Map<string, Position>([['MSFT', pos({ quelle: 'konfluenz' })], ['SOCK', pos({ core: true, quelle: 'umkehr' })]]);
    const p = kontoPlan(halten, [], new Map([['MSFT', 'umkehr_frist' as const], ['SOCK', 'umkehr_frist' as const]]), 10);
    expect(p.verkaufen).toEqual([]);
    expect(umkehrBesitz({ core: true, quelle: 'umkehr' })).toBe(false);
    expect(umkehrBesitz({ quelle: 'umkehr' })).toBe(true);
    expect(umkehrBesitz({ quelle: 'konfluenz' })).toBe(false);
  });
});

describe('Kerzen und Zeiten', () => {
  const bars = [
    { date: '2026-10-19', open: 1, high: 1, low: 1, close: 1, volume: 0 },
    { date: '2026-10-20', open: 1, high: 1, low: 1, close: 1, volume: 0 },
  ];

  it('Aktien: heutige Kerze erst nach 16:00 ET; Krypto: laufender UTC-Tag nie', () => {
    const waehrend = Date.parse('2026-10-20T15:00:00Z'); // 11:00 ET
    const abends = Date.parse('2026-10-20T20:45:00Z'); // 16:45 ET
    expect(sitzungVorbei(waehrend)).toBe(false);
    expect(sitzungVorbei(abends)).toBe(true);
    expect(kerzenFuerSignal('etf_sectors', bars, waehrend).map((b) => b.date)).toEqual(['2026-10-19']);
    expect(kerzenFuerSignal('etf_sectors', bars, abends).map((b) => b.date)).toEqual(['2026-10-19', '2026-10-20']);
    expect(kerzenFuerSignal('crypto', bars, abends).map((b) => b.date)).toEqual(['2026-10-19']);
  });

  it('Kerzentag: ET für Börse, UTC für Krypto (Einstieg 21:00 ET = nächster UTC-Tag)', () => {
    const ms = Date.parse('2026-10-21T01:00:00Z');
    expect(kerzenTag('stocks_us', ms)).toBe('2026-10-20');
    expect(kerzenTag('crypto', ms)).toBe('2026-10-21');
  });

  it('Plan-Frische: höchstens PLAN_MAX_ALTER_TAGE, nie aus der Zukunft, nie kaputt', () => {
    const jetzt = new Date('2026-10-21T13:35:00Z');
    const plan = (erstelltAt: string): UmkehrPlan => ({ tag: '2026-10-20', erstelltAt, kaufen: [], verkaufen: [] });
    expect(planFrisch(plan('2026-10-20T20:45:00Z'), jetzt)).toBe(true);
    expect(planFrisch(plan(new Date(jetzt.getTime() - (PLAN_MAX_ALTER_TAGE + 1) * 86_400_000).toISOString()), jetzt)).toBe(false);
    expect(planFrisch(plan('2026-10-22T00:00:00Z'), jetzt)).toBe(false);
    expect(planFrisch(undefined, jetzt)).toBe(false);
    expect(planFrisch({ ...plan('x'), erstelltAt: 'kaputt' }, jetzt)).toBe(false);
  });

  it('Stückzahl: ganze Stücke für Aktien/ETFs, Krypto auf 6 Stellen, nie negativ', () => {
    expect(umkehrStueck(10_000, 333, 'stocks_us')).toBe(30);
    expect(umkehrStueck(10_000, 67_000, 'crypto')).toBe(0.149253);
    expect(umkehrStueck(100, 500, 'etf_sectors')).toBe(0);
    expect(umkehrStueck(1000, 150, 'etf_sectors')).toBe(6); // abrunden, nie über das Budget
    expect(umkehrStueck(-1, 10, 'stocks_us')).toBe(0);
  });

  it('Universum: nur handelbare Katalog-Klassen, keine Indizes/Devisen/Futures', () => {
    const u = umkehrUniversum();
    expect(u).toContain('SPY');
    expect(u).toContain('BTC-USD');
    expect(u.some((s) => s.startsWith('^') || s.endsWith('=X') || s.endsWith('=F'))).toBe(false);
    expect(u.length).toBeGreaterThan(100);
  });
});

describe('Verdrahtung — jede Stelle kennt die Umkehr', () => {
  const scan = lies('../src/scheduled/scanMarket.ts');
  const puls = lies('../src/scheduled/riskPulse.ts');
  const schutz = lies('../src/core/schutzStop.ts');
  const lauf = lies('../src/scheduled/umkehrLauf.ts');
  const profil = lies('../src/callable/profile.ts');
  const index = lies('../src/index.ts');
  const dashboard = lies('../../frontend/src/dashboard.ts');
  const workflow = lies('../../.github/workflows/deploy-functions.yml');

  it('Scan: blendet Umkehr-Positionen aus und eröffnet im Umkehr-Modus nichts (Schattenbuch misst weiter)', () => {
    expect(scan).toContain('const fremdGefuehrt = (p: Position): boolean => p.core === true || umkehrBesitz(p);');
    expect(scan).toContain(".filter(([, p]) => !fremdGefuehrt(p)),");
    expect(scan).toContain("if (echtesBuch && strategy.engine.mode === 'umkehr') return 'umkehr_modus';");
    expect(scan).toContain("if (grund === 'umkehr_modus') return;");
  });

  it('Puls und Broker-Schutz: Umkehr-Positionen nur an der Notbremse', () => {
    expect(puls).toContain('const umkehr = !sockel && umkehrBesitz(pos);');
    expect(puls).toContain('const pruefPos = umkehr ? umkehrPruefPosition(pos, cls) : sockelPruefPosition(pos);');
    expect(puls).toContain('risk: sockel ? sockelRisk() : umkehr ? umkehrRisk(umkehrParameterFuer(cls)) : resolveRisk(clamped.engine, cls),');
    expect(schutz).toContain('else if (umkehrBesitz(pos)) risk = umkehrRisk(umkehrParameterFuer(klasse));');
  });

  it('Lauf: Käufe gestempelt (quelle + Steckbrief + Lauf-Kennung), Verkäufe nie hinter Einstiegs-Toren', () => {
    expect(lauf).toContain("quelle: 'umkehr',");
    expect(lauf).toContain("signature: 'umkehr'");
    expect(lauf).toContain('const laufId = `umk-${plan.tag}`;');
    expect(lauf).toContain('if (!tore.einstieg) {');
    expect(lauf.indexOf('// 1) Verkäufe')).toBeLessThan(lauf.indexOf('// 2) Käufe'));
    expect(lauf).toContain('if (plan.ausgefuehrtAm === heute) continue;');
    expect(lauf).toContain("if ((await boersenOffen(now.getTime())) === false) {");
  });

  it('Umstellung: einmalig, nur Konfluenz-Konten; neue Konten starten mit Umkehr; Speichern stellt nicht zurück', () => {
    expect(lauf).toContain("if ((await merker.get()).get('fertig') === true) return 0;");
    expect(lauf).toContain("if (mode !== 'confluence') continue;");
    expect(profil).toContain("basis.engine.mode = 'umkehr';");
    expect(dashboard).toContain("mode: basis.engine.mode ?? 'umkehr',");
    expect(dashboard).not.toContain("      mode: 'confluence',");
  });

  it('Läufe exportiert und beim Deploy angestoßen', () => {
    expect(index).toContain("export { umkehrAbend, umkehrMorgen } from './scheduled/umkehrLauf.js';");
    expect(workflow).toContain('momentumrun,umkehrabend,kibericht');
  });
});
