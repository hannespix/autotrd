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
  UMKEHR_AUSGESCHLOSSEN,
  kaufAuftraege,
  kryptoKerzeFrisch,
  kryptoStandErsetzen,
  planNachholenNoetig,
  kerzenFuerSignal,
  kerzenTag,
  kontoPlan,
  regelSchluesse,
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
    // AAPL hätte den tiefsten RSI, aber der Block US-Einzelaktien ist mit
    // U0…U9 schon voll — der eine freie Platz geht an XLF (Sektor-Block).
    expect(p.kaufen.map((k) => k.symbol)).toEqual(['XLF']);
  });

  it('Klumpen-Limit über das ganze Depot und abgeschaltete Klassen (Red-Team M6)', () => {
    const tech = [
      { symbol: 'XLK', rsi: 1, schluss: 1 },
      { symbol: 'SMH', rsi: 2, schluss: 1 },
      { symbol: 'SOXX', rsi: 3, schluss: 1 },
      { symbol: 'XLF', rsi: 4, schluss: 1 },
      { symbol: 'SPY', rsi: 5, schluss: 1 },
    ];
    const p = kontoPlan(new Map(), tech, new Map(), 10);
    expect(p.kaufen.map((k) => k.symbol)).toEqual(['XLK', 'SMH', 'SOXX', 'SPY']); // höchstens 3 aus dem Sektor-Block
    // Sockel und Altbestand zählen NICHT mit (Nachprüfung): drei Sockel-ETFs sperren den Block nicht.
    const sockel = new Map<string, Position>([
      ['IBB', pos({ symbol: 'IBB', core: true, quelle: 'sockel' })],
      ['ICLN', pos({ symbol: 'ICLN', core: true, quelle: 'sockel' })],
      ['TAN', pos({ symbol: 'TAN', quelle: 'konfluenz' })],
    ]);
    expect(kontoPlan(sockel, tech, new Map(), 10).kaufen.map((k) => k.symbol)).toEqual(['XLK', 'SMH', 'SOXX', 'SPY']);
    const ohneSektoren = kontoPlan(new Map(), tech, new Map(), 10, (s) => !['XLK', 'SMH', 'SOXX', 'XLF'].includes(s));
    expect(ohneSektoren.kaufen.map((k) => k.symbol)).toEqual(['SPY']);
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

describe('Kaufaufträge: Bargeld-Deckel (Red-Team M2)', () => {
  const k = (symbol: string, rsi = 1) => ({ symbol, rsi, schluss: 1 });
  const px = (s: string): number | null => ({ XLF: 50, SPY: 500, XLE: 100 } as Record<string, number>)[s] ?? null;

  it('je Platz der Zielwert, aber nie mehr als das freie Bargeld (mit Puffer)', () => {
    const a = kaufAuftraege([k('XLF'), k('SPY'), k('XLE')], px, 12_000, 10_000, 10);
    expect(a).toEqual([
      { symbol: 'XLF', qty: 200, preis: 50 }, // 10.000 Zielwert
      { symbol: 'SPY', qty: 3, preis: 500 }, // Rest 2.000 × 0,98 = 1.960 → 3 Stück
      { symbol: 'XLE', qty: 4, preis: 100 }, // Rest 500 × 0,98 = 490 → 4 Stück
    ]);
  });

  it('ohne Kurs oder ohne freien Platz kein Auftrag', () => {
    expect(kaufAuftraege([k('UNBEKANNT'), k('XLF')], px, 1e6, 1_000, 10).map((x) => x.symbol)).toEqual(['XLF']);
    expect(kaufAuftraege([k('XLF'), k('XLE')], px, 1e6, 1_000, 1)).toHaveLength(1);
    expect(kaufAuftraege([k('XLF')], px, 1e6, 1_000, 0)).toEqual([]);
    expect(kaufAuftraege([k('XLF')], px, Number.NaN, 1_000, 5)).toEqual([]);
  });
});

describe('Kurse für die Regel (Red-Team M4)', () => {
  const b = (close: number, adjClose?: number) => ({ date: 'x', open: close, high: close, low: close, close, volume: 0, ...(adjClose !== undefined ? { adjClose } : {}) });
  it('bereinigt, wenn jede Kerze ihn trägt — sonst durchgehend roh', () => {
    expect(regelSchluesse([b(10, 9), b(11, 10)])).toEqual([9, 10]);
    expect(regelSchluesse([b(10, 9), b(11)])).toEqual([10, 11]);
    expect(regelSchluesse([])).toEqual([]);
  });
  it('Universum ohne Fast-Bargeld- und Futures-ETFs, getrennt nach Börse und Krypto', () => {
    const alle = umkehrUniversum();
    const ausgeschlossen = ['BIL', 'SHY', 'AGG', 'LQD', 'TIP', 'USO', 'UNG'];
    expect([...UMKEHR_AUSGESCHLOSSEN].sort()).toEqual([...ausgeschlossen].sort());
    for (const s of ausgeschlossen) expect(alle).not.toContain(s);
    expect(alle).toContain('TLT'); // lange Anleihen schwanken genug und waren in der Rückrechnung
    expect(umkehrUniversum('krypto').every((s) => s.endsWith('-USD'))).toBe(true);
    expect(umkehrUniversum('boerse').some((s) => s.endsWith('-USD'))).toBe(false);
    expect(umkehrUniversum('boerse').length + umkehrUniversum('krypto').length).toBe(alle.length);
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
    expect(lauf).toContain('plan.verkaufen, plan.kaufen, `umk-${plan.tag}`, now);');
    expect(lauf).toContain('if (einstiegGesperrt || kaufen.length === 0) return { kaeufe, verkaeufe, ohne };');
    expect(lauf.indexOf('// 1) Verkäufe')).toBeLessThan(lauf.indexOf('// 2) Käufe'));
    // Jeder Plan genau einmal (M1), Verkauf nie zum erfundenen Kurs (M3).
    expect(lauf).toContain('      if (plan.ausgefuehrtAm) continue;');
    expect(lauf).toContain('    if (px === null) continue;\n    const r = await executeTrade(\n      { uid: k.id, symbol: v.symbol, side: \'sell\'');
    // Krypto: eigener Tageslauf direkt nach dem UTC-Tagesschluss (H1), je Tag einmal.
    // 22.10.: Vortageskerze kam erst nach 04:10 UTC — Versuche bis mittags.
    expect(lauf).toContain("schedule: '10 0-14/2 * * *', timeZone: 'UTC'");
    // Stand je Lauf ERSETZEN (keine Altfelder), späte Versuche überdecken den handelnden nicht.
    expect(lauf).toContain("return getFirestore().doc('meta/umkehr').set({ [teil]: wert }, { mergeFields: [teil] });");
    expect(lauf).not.toContain("doc('meta/umkehr').set({ abend");
    expect(lauf).not.toMatch(/meta\/umkehr'\)\.set\([^)]*\{ merge: true \}/);
    expect(lauf).toContain('if (kryptoStandErsetzen(alt, tag, bearbeitet)) {');
    // 21.10.: Yahoo lieferte die Vortageskerze um 00:10 UTC noch nicht — nur auf frischer Kerze handeln.
    expect(lauf).toContain("if (!kryptoKerzeFrisch(tag, now.getTime())) {");
    expect(lauf).toContain("if ((await stand.get()).get('tag') === tag) continue;");
    expect(lauf).toContain("const boerse = (s: string): boolean => !istKrypto(s);");
    // Nachprüfung: Kursausfall stempelt nicht, Abend überschreibt keinen gehandelten Tag,
    // Bargeld-Deckel mit Broker-Abgleich.
    expect(lauf).toContain('if (quotes.size === 0 && (verkaufen.length > 0 || kaufen.length > 0)) throw new KeineKurse();');
    expect(lauf).toContain("await k.ref.collection('meta').doc('umkehrPlan').set({ ausgefuehrtAm: null }, { merge: true })");
    expect(lauf).toContain('if (alt?.tag === tag && alt.ausgefuehrtAm) continue;');
    expect(lauf).toContain("const bargeld = kapitalDeckel(frisch.get('risk.abgleich'), buchCash, now.toISOString());");
    expect(lauf).toContain("if ((await boersenOffen(now.getTime())) === false) {");
  });

  it('Umstellung: einmalig, nur Konfluenz-Konten; neue Konten starten mit Umkehr; Speichern stellt nicht zurück', () => {
    expect(lauf).toContain("if ((await merker.get()).get('fertig') === true) return 0;");
    expect(lauf).toContain("if ((roh.engine.mode ?? 'confluence') !== 'confluence') continue;");
    expect(lauf).toContain("if (roh.broker.mode === 'live' || resolveBrokerMode(roh) !== 'paper') continue;"); // nie ein Echtgeld-Konto still umstellen
    expect(profil).toContain("basis.engine.mode = 'umkehr';");
    expect(dashboard).toContain("mode: basis.engine.mode ?? 'umkehr',");
    expect(dashboard).not.toContain("      mode: 'confluence',");
  });

  it('Läufe exportiert und beim Deploy angestoßen', () => {
    expect(index).toContain("export { umkehrAbend, umkehrKrypto, umkehrMorgen } from './scheduled/umkehrLauf.js';");
    expect(workflow).toContain('momentumrun,umkehrabend,kibericht');
    // 22.10.: Abendlauf scheiterte (code 13 / HTTP 500) ohne lesbare Spur —
    // seine Logs stehen NACH dem Anstoß in jedem Deploy-Log, nie rot.
    const logSchritt = workflow.slice(workflow.indexOf('- name: Umkehr-Abendlauf-Logs (Diagnose)'));
    expect(workflow.indexOf('- name: Umkehr-Abendlauf-Logs (Diagnose)')).toBeGreaterThan(workflow.indexOf('node scripts-ci/invoke-daily.mjs'));
    expect(logSchritt.slice(0, 400)).toContain('continue-on-error: true');
    expect(logSchritt.slice(0, 400)).toContain('run: node scripts-ci/fetch-scan-logs.mjs 1560 WARNING umkehrabend');
    const logs = lies('../../scripts-ci/fetch-scan-logs.mjs');
    expect(logs).toContain('`resource.labels.service_name="${dienst}"`,');
    expect(logs).toContain("if (!/^[a-z][a-z0-9-]{0,62}$/.test(dienst)) {");
  });
});

describe('ohlcDaily speichert keinen bereinigten Kurs (veraltet rückwirkend)', () => {
  it('chunkBarsByYear lässt adjClose weg', async () => {
    const { chunkBarsByYear } = await import('../src/core/marketData.js');
    const m = chunkBarsByYear([{ date: '2026-10-20', open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, adjClose: 1.4 }]);
    expect(m.get('2026')?.['2026-10-20']).toEqual({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 });
  });
});

describe('Krypto-Kerze frisch (21.10.)', () => {
  it('nur wenn die jüngste Kerze der gerade abgeschlossene UTC-Tag ist', () => {
    const t0 = Date.parse('2026-10-21T00:10:00Z');
    expect(kryptoKerzeFrisch('2026-10-20', t0)).toBe(true);
    expect(kryptoKerzeFrisch('2026-10-19', t0)).toBe(false); // Yahoo hinkt nach
    expect(kryptoKerzeFrisch('2026-10-21', t0)).toBe(false); // laufender Tag
    expect(kryptoKerzeFrisch('', t0)).toBe(false);
    expect(kryptoKerzeFrisch('2026-10-20', Date.parse('2026-10-21T04:10:00Z'))).toBe(true);
    expect(kryptoKerzeFrisch('2026-10-20', Date.parse('2026-10-21T14:10:00Z'))).toBe(true);
  });

  it('späte Versuche überdecken den Stand des handelnden Laufs nicht (22.10.)', () => {
    const gehandelt = { tag: '2026-10-21', veraltet: false };
    expect(kryptoStandErsetzen(gehandelt, '2026-10-21', 0)).toBe(false);
    expect(kryptoStandErsetzen(gehandelt, '2026-10-21', 2)).toBe(true);
    // Vorher veraltet oder anderer Tag ⇒ der frische Lauf schreibt, auch ohne Konto.
    expect(kryptoStandErsetzen({ tag: '2026-10-20', veraltet: true }, '2026-10-21', 0)).toBe(true);
    expect(kryptoStandErsetzen({ tag: '2026-10-21', veraltet: true }, '2026-10-21', 0)).toBe(true);
    expect(kryptoStandErsetzen(gehandelt, '2026-10-22', 0)).toBe(true);
    expect(kryptoStandErsetzen(undefined, '2026-10-21', 0)).toBe(true);
  });
});

describe('Morgen holt einen fehlenden Abendplan nach (21.10.)', () => {
  it('nur wenn der Plan nicht zum letzten abgeschlossenen Handelstag gehört', () => {
    expect(planNachholenNoetig('2026-10-20', '2026-10-21')).toBe(true);
    expect(planNachholenNoetig(undefined, '2026-10-21')).toBe(true);
    expect(planNachholenNoetig('2026-10-21', '2026-10-21')).toBe(false);
    expect(planNachholenNoetig('2026-10-20', null)).toBe(false); // ohne Kurse nichts erzwingen
  });

  it('Verdrahtung: Nachholen VOR der Konten-Schleife, Ergebnis im Herzschlag', () => {
    const lauf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/scheduled/umkehrLauf.ts'), 'utf8');
    const morgen = lauf.slice(lauf.indexOf('export async function runUmkehrMorgen'));
    expect(morgen.indexOf('const nachgeholt = await abendNachholen(now)')).toBeGreaterThan(-1);
    expect(morgen.indexOf('const nachgeholt = await abendNachholen(now)')).toBeLessThan(morgen.indexOf('for (const k of await umkehrKonten())'));
    expect(morgen).toContain('planNachgeholt: nachgeholt');
    expect(lauf).toContain("return kerzenFuerSignal('etf_regions', snap.bars, now.getTime()).at(-1)?.date ?? null;");
  });
});
