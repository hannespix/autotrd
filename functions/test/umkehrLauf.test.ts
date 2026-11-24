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
  kaufAuftraegeMitGrund,
  abrutschStat,
  zaehleGrund,
  median,
  kryptoKerzeFrisch,
  kryptoStandErsetzen,
  planNachholenNoetig,
  kerzenFuerSignal,
  kerzenTag,
  kontoPlan,
  abendStandErsetzen,
  PLAN_RESERVE_MAX,
  PLAN_SUMMEN_MIN_KONTEN,
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

  /* 20.11.: 25 Signale nach einer −6-%-Woche, am Morgen kaufte kein Konto.
   * Die geplanten (stärksten) Signale waren für das Konto zu teuer und fielen
   * ersatzlos weg; die bezahlbaren dahinter wurden nie versucht. Seitdem
   * trägt der Plan die übrigen Signale als RESERVE, und der Morgen wählt. */
  describe('Reserve: was abends keinen Platz bekam, bleibt in Rangfolge im Plan', () => {
    it('Auswahl unverändert (stärkstes Signal zuerst), der Rest ist Reserve', () => {
      const p = kontoPlan(new Map(), signale, new Map(), 2);
      expect(p.kaufen.map((k) => k.symbol)).toEqual(['AAPL', 'XLF']);
      expect(p.reserve.map((k) => k.symbol)).toEqual(['QQQ']);
      expect(p.verworfen).toEqual({ gehalten: 0, klasseAus: 0, klumpen: 0, keinPlatz: 1 });
    });

    it('gehaltene und abgeschaltete Klassen kommen NICHT in die Reserve', () => {
      const halten = new Map<string, Position>([['AAPL', pos({ core: true, quelle: 'sockel' })]]);
      const p = kontoPlan(halten, signale, new Map(), 1, (s) => s !== 'QQQ');
      expect(p.kaufen.map((k) => k.symbol)).toEqual(['XLF']);
      expect(p.reserve).toEqual([]);
      expect(p.verworfen).toEqual({ gehalten: 1, klasseAus: 1, klumpen: 0, keinPlatz: 0 });
    });

    it('jedes Signal wird genau einmal gezählt; die Reserve ist gedeckelt', () => {
      const viele = Array.from({ length: 60 }, (_, i) => ({ symbol: `S${i}`, rsi: i / 10, schluss: 10 + i }));
      const p = kontoPlan(new Map(), viele, new Map(), 10);
      const v = p.verworfen;
      expect(p.kaufen.length + v.gehalten + v.klasseAus + v.klumpen + v.keinPlatz).toBe(viele.length);
      expect(p.reserve.length).toBe(PLAN_RESERVE_MAX);
      // Rangfolge: die Reserve setzt direkt hinter den geplanten Käufen fort.
      expect(p.reserve[0]!.rsi).toBeGreaterThanOrEqual(p.kaufen.at(-1)!.rsi);
    });
  });

  describe('Morgen: Reserve rückt nach, wenn ein geplanter Kauf ausfällt', () => {
    const preise: Record<string, number> = { AAPL: 200, QQQ: 500, XLF: 50, KO: 60, PFE: 25 };
    const preis = (s: string): number | null => preise[s] ?? null;
    const geplant = [{ symbol: 'AAPL', rsi: 3, schluss: 200 }, { symbol: 'QQQ', rsi: 4, schluss: 500 }];
    const reserve = [{ symbol: 'XLF', rsi: 6, schluss: 50 }, { symbol: 'KO', rsi: 7, schluss: 60 }, { symbol: 'PFE', rsi: 8, schluss: 25 }];

    it('ohne Reserve wie am 20.11.: beide zu teuer, kein Kauf', () => {
      const w = kaufAuftraegeMitGrund(geplant, preis, 5000, 120, 2);
      expect(w.auftraege).toEqual([]);
      expect(w.zuTeuer).toBe(2);
      expect(w.ersatz).toBe(0);
    });

    it('mit Reserve: die zwei nächstbesten bezahlbaren Signale füllen die Plätze', () => {
      const w = kaufAuftraegeMitGrund(geplant, preis, 5000, 120, 2, { reserve });
      expect(w.auftraege.map((a) => a.symbol)).toEqual(['XLF', 'KO']);
      expect(w.auftraege.map((a) => a.qty)).toEqual([2, 2]);
      expect(w.zuTeuer).toBe(2); // die geplanten bleiben als Ausfall gezählt …
      expect(w.ersatz).toBe(2); // … und der Ersatz ist sichtbar
      expect(w.keinPlatz).toBe(0); // ungenutzte Reserve (PFE) ist kein verpasster Kauf
    });

    it('geplante Käufe haben Vorrang; Reserve wird nur gebraucht, wenn Plätze frei bleiben', () => {
      const w = kaufAuftraegeMitGrund(geplant, preis, 5000, 600, 2, { reserve });
      expect(w.auftraege.map((a) => a.symbol)).toEqual(['AAPL', 'QQQ']);
      expect(w.ersatz).toBe(0);
    });

    it('nie mehr Käufe als freie Plätze, nie dasselbe Symbol zweimal', () => {
      // XLF steht zweimal in der Reserve, und es wären VIER Plätze frei: trotzdem nur einmal XLF.
      const doppelt = [{ symbol: 'XLF', rsi: 6, schluss: 50 }, ...reserve];
      const w = kaufAuftraegeMitGrund(geplant, preis, 5000, 120, 4, { reserve: doppelt });
      expect(w.auftraege.map((a) => a.symbol)).toEqual(['XLF', 'KO', 'PFE']);
      expect(kaufAuftraegeMitGrund(geplant, preis, 5000, 120, 1, { reserve }).auftraege).toHaveLength(1);
    });

    it('Klumpen-Limit gilt am Morgen mit dem, was wirklich gehalten und gekauft wird', () => {
      const sektoren = [{ symbol: 'SOXX', rsi: 1, schluss: 10 }, { symbol: 'XLF', rsi: 2, schluss: 10 }, { symbol: 'SPY', rsi: 3, schluss: 10 }];
      const p10 = (): number => 10;
      // Zwei Sektor-ETFs im Depot: nur noch EINER passt in den Block (SOXX), XLF nicht mehr; SPY ist ein anderer Block.
      const w = kaufAuftraegeMitGrund(sektoren, p10, 5000, 100, 5, { depot: ['XLK', 'SMH'] });
      expect(w.auftraege.map((a) => a.symbol)).toEqual(['SOXX', 'SPY']);
      expect(w.klumpen).toBe(1);
      // Ohne `depot` (Altaufrufer) keine Klumpen-Prüfung — Verhalten wie bisher.
      expect(kaufAuftraegeMitGrund(sektoren, p10, 5000, 100, 5).auftraege).toHaveLength(3);
    });

    it('das Bargeld begrenzt auch den Ersatz', () => {
      const w = kaufAuftraegeMitGrund(geplant, preis, 110, 120, 3, { reserve });
      // 110 × 0,98 = 107,8 ⇒ 2 × XLF (100), danach 10 Rest ⇒ nichts mehr.
      expect(w.auftraege.map((a) => a.symbol)).toEqual(['XLF']);
    });
  });

  describe('abendStandErsetzen — die Diagnose des Tages nicht mit Nullen überschreiben', () => {
    it('ein Lauf ohne neu geplantes Konto ersetzt den Stand desselben Kerzentags nicht', () => {
      expect(abendStandErsetzen({ tag: '2026-11-20' }, '2026-11-20', 0)).toBe(false);
    });
    it('neuer Kerzentag oder mindestens ein geplantes Konto ersetzt', () => {
      expect(abendStandErsetzen({ tag: '2026-11-19' }, '2026-11-20', 0)).toBe(true);
      expect(abendStandErsetzen({ tag: '2026-11-20' }, '2026-11-20', 3)).toBe(true);
      expect(abendStandErsetzen(undefined, '2026-11-20', 0)).toBe(true);
    });
  });

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

  it('zählt, WARUM ein Kandidat leer ausging (23.10.: Sammelzähler war blind)', () => {
    // Kein Kurs; dann reicht das Bargeld (300 × 0,98) für 5 × XLF à 50 — der
    // Rest von 50 trägt weder SPY (500) noch XLE (100): zweimal kein Bargeld.
    const r = kaufAuftraegeMitGrund([k('UNBEKANNT'), k('XLF'), k('SPY'), k('XLE')], px, 300, 10_000, 2);
    expect(r.auftraege).toEqual([{ symbol: 'XLF', qty: 5, preis: 50 }]);
    expect(r).toMatchObject({ keinKurs: 1, keinBargeld: 2, keinPlatz: 0 });
    const voll = kaufAuftraegeMitGrund([k('XLF'), k('XLE'), k('SPY')], px, 1e6, 1_000, 1);
    expect(voll).toMatchObject({ keinKurs: 0, keinBargeld: 0, keinPlatz: 2 });
    // Summe der Gründe + Aufträge = Kandidaten — nichts fällt durch.
    for (const x of [r, voll]) expect(x.auftraege.length + x.keinKurs + x.keinBargeld + x.keinPlatz).toBe(x === r ? 4 : 3);
  });

  it('„zu teuer" ≠ „kein Bargeld": Zielbetrag kleiner als ein Stück, Bargeld wäre da (26.10.)', () => {
    // Zielwert 400 je Platz, Bargeld reichlich: SPY (500) passt nicht in den Zielwert.
    const r = kaufAuftraegeMitGrund([k('SPY'), k('XLF')], px, 1e6, 400, 10);
    expect(r).toMatchObject({ zuTeuer: 1, keinBargeld: 0 });
    expect(r.auftraege).toEqual([{ symbol: 'XLF', qty: 8, preis: 50 }]);
    // Bargeld leer ⇒ weiterhin „kein Bargeld", auch wenn der Zielwert hoch wäre.
    expect(kaufAuftraegeMitGrund([k('SPY')], px, 100, 1e6, 10)).toMatchObject({ zuTeuer: 0, keinBargeld: 1 });
  });

  it('Grund-Codes sind öffentlich: nur [a-z0-9_], gedeckelt, Rest unter „sonstig"', () => {
    const z: Record<string, number> = {};
    zaehleGrund(z, 'zu_wenig_cash', 2);
    zaehleGrund(z, 'zu_wenig_cash', 1);
    zaehleGrund(z, 'Broker sagt: Konto 123 gesperrt', 1); // Freitext ⇒ nie durchreichen
    expect(z).toEqual({ zu_wenig_cash: 3, sonstig: 1 });
    const voll: Record<string, number> = {};
    for (let i = 0; i < 20; i++) zaehleGrund(voll, `g${i}`, 1);
    expect(Object.keys(voll).length).toBeLessThanOrEqual(13);
    expect(voll['sonstig']).toBe(8);
  });

  it('Krypto reserviert Kurs + Puffer (Red-Team N1), Aktien nicht', () => {
    const pk = (s: string): number | null => ({ 'BTC-USD': 100, 'ETH-USD': 100, XLF: 195 } as Record<string, number>)[s] ?? null;
    // Zielwert 400: je 4 BTC/ETH zu 100 reservieren 4 × 100,5 = 402 ⇒ Rest 1000 − 804 = 196,
    // × 0,98 = 192,08 < 195 ⇒ KEIN XLF. Ohne Puffer-Reservierung bliebe 200 × 0,98 = 196 ⇒ 1 XLF.
    const a = kaufAuftraegeMitGrund([k('BTC-USD'), k('ETH-USD'), k('XLF')], pk, 1000, 400, 10);
    expect(a.auftraege.map((x) => x.symbol)).toEqual(['BTC-USD', 'ETH-USD']);
    expect(a.keinBargeld).toBe(1);
  });

  it('Abrutschen: Median und Anteil ≥ 0,4 % (Red-Team M1)', () => {
    expect(abrutschStat([0.1, 0.45, 0.2, 0.5])).toEqual({ n: 4, medianPct: 0.325, anteilAb04Pct: 50 });
    expect(abrutschStat([])).toEqual({ n: 0, medianPct: null, anteilAb04Pct: null });
  });

  it('Median für die anonymen Kapital-Kennzahlen', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(median([])).toBeNull();
    expect(median([Number.NaN, 5])).toBe(5);
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
    expect(lauf).toContain('plan.verkaufen, plan.kaufen, `umk-${plan.tag}`, now, plan.reserve ?? []);');
    // seit 24.11. mit Schutz-Runde davor — das Einstiegs-Tor hält weiterhin nur KÄUFE auf
    expect(lauf).toContain('if (einstiegSperre !== null || kaufen.length === 0) {\n    await schutzRunde();\n    return { kaeufe, verkaeufe, ohne, abrutschen, verkaufFehl };\n  }');
    expect(lauf.indexOf('// 1) Verkäufe')).toBeLessThan(lauf.indexOf('// 2) Käufe'));
    // Jeder Plan genau einmal (M1), Verkauf nie zum erfundenen Kurs (M3).
    expect(lauf).toContain('      if (plan.ausgefuehrtAm) continue;');
    // 10.11.: ohne Kurs weiterhin kein Verkauf — aber als offener Ausstieg gezählt.
    expect(lauf).toContain("    if (px === null) {\n      // Kein Kurs ⇒ kein Verkauf zum erfundenen Preis (M3)");
    expect(lauf).toContain("      zaehleGrund(verkaufFehl, 'kein_kurs', 1);\n      continue;\n    }\n    const grund = await verkaufe(v, px);");
    // der Verkauf selbst (seit 24.11. als Helfer, weil die Nachholrunde ihn ein zweites Mal ruft)
    expect(lauf).toContain("const r = await executeTrade(\n      { uid: k.id, symbol: v.symbol, side: 'sell', price: px, source: 'engine', riskExit: v.grund, assetClass: classify(v.symbol) },");
    // Krypto: eigener Tageslauf direkt nach dem UTC-Tagesschluss (H1), KÄUFE je Tag einmal.
    // 22.10.: Vortageskerze kam erst nach 04:10 UTC — Versuche bis mittags.
    // 10.11.: Gestempelte Konten holen nur noch AUSSTIEGE nach (leere Kaufliste) —
    // der Kaufpfad hinter dem Stempel bleibt für sie unerreichbar.
    expect(lauf).toContain("const schonHeute = (await stand.get()).get('tag') === tag;");
    const nachholen = lauf.slice(lauf.indexOf('      if (schonHeute) {'), lauf.indexOf('      await stand.set({ tag, at: now.toISOString() });'));
    expect(nachholen.length).toBeGreaterThan(100);
    expect(nachholen).toContain('offen, [], `umk-${tag}`, now)');
    expect(nachholen.trimEnd().endsWith('continue;\n      }')).toBe(true);
    expect(lauf).toContain("schedule: '10 0-14/2 * * *', timeZone: 'UTC'");
    // 22.10.: Abendlauf brach an 512 MiB ab (517–595 MiB gemessen) — Abend und Morgen (holt nach) 1 GiB.
    expect(lauf).toContain("{ schedule: '45 16 * * 1-5', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 540, memory: '1GiB',");
    expect(lauf).toContain("{ schedule: '35 9 * * 1-5', timeZone: 'America/New_York', retryCount: 0, timeoutSeconds: 540, memory: '1GiB',");
    // Stand je Lauf ERSETZEN (keine Altfelder), späte Versuche überdecken den handelnden nicht.
    expect(lauf).toContain("return getFirestore().doc('meta/umkehr').set({ [teil]: wert }, { mergeFields: [teil] });");
    expect(lauf).not.toContain("doc('meta/umkehr').set({ abend");
    expect(lauf).not.toMatch(/meta\/umkehr'\)\.set\([^)]*\{ merge: true \}/);
    expect(lauf).toContain('if (kryptoStandErsetzen(alt, tag, bearbeitet)) {');
    // 21.10.: Yahoo lieferte die Vortageskerze um 00:10 UTC noch nicht — nur auf frischer Kerze handeln.
    expect(lauf).toContain("if (!kryptoKerzeFrisch(tag, now.getTime())) {");
    // 23.10.: Gründe aufgeschlüsselt, Kapital nur als Median (meta/** ist öffentlich).
    expect(lauf).toContain('ohne.keinBargeld += wahl.keinBargeld;');
    // 26.10.: Gründe der Ablehnungen und Sperren als Codes, „zu teuer" getrennt.
    expect(lauf).toContain("zaehleGrund(ohne.abgelehntGruende, r.reason ?? 'ohne_grund', 1);");
    expect(lauf).toContain('zaehleGrund(ohne.gesperrtGruende, einstiegSperre, kaufen.length);');
    expect(lauf).toContain('ohne.zuTeuer += wahl.zuTeuer;');
    // 27.10.: Abrutschen der Krypto-Käufe gemessen und veröffentlicht (aggregiert).
    expect(lauf).toContain('abrutschen: abrutschStat(abrutschen),');
    expect(lauf).toContain("if (klasse === 'crypto' && typeof fill === 'number' && fill > 0 && a.preis > 0) abrutschen.push((fill / a.preis - 1) * 100);");
    expect(lauf).toContain('bargeldMedianPct: rund(median(anteile.map((a) => a.bargeld))),');
    expect(lauf).toContain('altbestandMedianPct: rund(median(anteile.map((a) => a.altbestand))),');
    expect(lauf).toContain("else if (!umkehrBesitz(p)) altbestand += wert;");
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

describe('Reserve und Zählung sind im Lauf angeschlossen (20.11.)', () => {
  const lauf20 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/scheduled/umkehrLauf.ts'), 'utf8');

  it('Morgen- und Kryptolauf reichen die Reserve des Plans an die Ausführung', () => {
    expect(lauf20).toContain('plan.verkaufen, plan.kaufen, `umk-${plan.tag}`, now, plan.reserve ?? []);');
    expect(lauf20).toContain('plan.verkaufen, plan.kaufen, `umk-${tag}`, now, plan.reserve);');
    expect(lauf20).toContain('reserve: reserve.filter(kaufbar),');
    expect(lauf20).toContain("depot: [...alle.entries()].filter(([, p]) => umkehrBesitz(p)).map(([sym]) => sym),");
  });

  it('Stand abend: Summen erst ab der Konten-Schwelle, und nie mit Nullen überschrieben', () => {
    expect(PLAN_SUMMEN_MIN_KONTEN).toBe(3);
    expect(lauf20).toContain('...(geplant >= PLAN_SUMMEN_MIN_KONTEN ? { kontenMitKauf, geplanteKaeufe, verworfen } : {}),');
    expect(lauf20.indexOf('if (!abendStandErsetzen(standAlt, tag, geplant)) {')).toBeLessThan(lauf20.indexOf("await standSchreiben('abend', {"));
    expect(lauf20).toContain('for (const g of Object.keys(verworfen) as Array<keyof PlanVerworfen>) verworfen[g] += plan.verworfen[g];');
  });

  it('ausgefallene geplante Käufe werden als Summe der Gründe gezählt — Ersatz zählt nicht als Fehlschlag', () => {
    expect(lauf20).toContain('ohne.bargeldOderPlatz += wahl.keinKurs + wahl.keinPlatz + wahl.keinBargeld + wahl.zuTeuer + wahl.klumpen;');
    expect(lauf20).toContain('ohne.ersatz += wahl.ersatz;');
  });
});
