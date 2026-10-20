/**
 * Kurzfrist-Umkehr (RSI-2), Task 34: pure Regeln + Parität zur
 * Python-Rückrechnung, auf der die Owner-Entscheidung vom 20.10. beruht.
 *
 * Die Parität ist der wichtigste Test hier: Weicht das TS-Signal vom
 * zurückgerechneten ab, handelt das Tool eine Strategie, die nie
 * getestet wurde. Testdaten: echte Tagesschlüsse (SPY, BTC-USD), 700
 * Tage bis 19.10.2026, Erwartung aus bt.py (pandas ewm adjust=False).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  UMKEHR,
  UMKEHR_KRYPTO,
  abgeschlosseneKerzen,
  handelstageSeit,
  umkehrAusstieg,
  umkehrAuswahl,
  umkehrEinstieg,
  umkehrNotbremseLevel,
  umkehrParameterFuer,
  umkehrPositionsWert,
  umkehrRisk,
} from '../src/umkehr.js';
import { DEFAULT_STRATEGY, resolveRisk, risikoFuer, sockelRisk, umkehrPruefPosition } from '../src/strategy.js';

interface Fall { i: number; einstieg: boolean; erholt: boolean; rsi: number }
interface Reihe { schwelle: number; daten: string[]; schluesse: number[]; erwartet: Fall[] }
const hier = dirname(fileURLToPath(import.meta.url));
const paritaet = JSON.parse(readFileSync(join(hier, 'umkehrParitaet.json'), 'utf8')) as Record<string, Reihe>;

describe('Parität zur Rückrechnung (bt.py)', () => {
  for (const [symbol, r] of Object.entries(paritaet)) {
    it(`${symbol}: Einstiegs- und Erholungs-Signal Tag für Tag identisch`, () => {
      const p = symbol === 'BTC-USD' ? UMKEHR_KRYPTO : UMKEHR;
      expect(p.rsiSchwelle).toBe(r.schwelle);
      let einstiege = 0;
      for (const f of r.erwartet) {
        const bis = r.schluesse.slice(0, f.i + 1);
        const e = umkehrEinstieg(bis, p);
        expect(e.signal, `${symbol} ${r.daten[f.i]} Einstieg`).toBe(f.einstieg);
        expect(e.rsi).toBeCloseTo(f.rsi, 4);
        expect(umkehrAusstieg(bis, 1, p) === 'umkehr_erholt', `${symbol} ${r.daten[f.i]} erholt`).toBe(f.erholt);
        if (e.signal) einstiege += 1;
      }
      expect(einstiege).toBeGreaterThan(0);
    });
  }
});

describe('Regeln', () => {
  const steigend = (n: number): number[] => Array.from({ length: n }, (_, i) => 100 + i * 0.5);

  it('Einstieg nur über dem 200-Tage-Schnitt UND nach starkem Rücksetzer', () => {
    const basis = steigend(260);
    expect(umkehrEinstieg(basis).signal).toBe(false); // RSI hoch
    const ruecksetzer = [...basis, basis.at(-1)! - 3, basis.at(-1)! - 6];
    const e = umkehrEinstieg(ruecksetzer);
    expect(e.signal).toBe(true);
    expect(e.rsi!).toBeLessThan(10);
    // Gleicher Rücksetzer im Abwärtstrend (unter SMA200) ⇒ kein Kauf.
    const fallend = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
    expect(umkehrEinstieg([...fallend, fallend.at(-1)! - 3, fallend.at(-1)! - 6]).signal).toBe(false);
  });

  it('zu kurze oder kaputte Historie ⇒ nie ein Signal', () => {
    expect(umkehrEinstieg(steigend(199)).signal).toBe(false);
    const kaputt = [...steigend(259), Number.NaN, 90, 85];
    expect(umkehrEinstieg(kaputt).signal).toBe(false);
    expect(umkehrAusstieg([...steigend(10), Number.NaN], 3)).toBeNull();
  });

  it('Ausstieg: Erholung über SMA5 oder Frist nach 10 Handelstagen', () => {
    const tief = [100, 100, 100, 100, 100, 95, 94];
    expect(umkehrAusstieg(tief, 2)).toBeNull();
    // Genau AUF dem 5-Tage-Schnitt ist noch keine Erholung (Rückrechnung: c > SMA5).
    expect(umkehrAusstieg([100, 100, 100, 100, 100], 2)).toBeNull();
    expect(umkehrAusstieg([...tief, 101], 3)).toBe('umkehr_erholt');
    expect(umkehrAusstieg(tief, 9)).toBeNull();
    expect(umkehrAusstieg(tief, 10)).toBe('umkehr_frist');
  });

  it('Handelstage zählen ab Einstiegstag inklusive, Kerzen statt Kalender', () => {
    const tage = ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'];
    expect(handelstageSeit('2026-10-16', tage)).toBe(3); // Wochenende zählt nicht
    expect(handelstageSeit('2026-10-21', tage)).toBe(0);
  });

  it('Auswahl: tiefster RSI zuerst, deterministisch, nie mehr als frei', () => {
    const k = [{ symbol: 'XLF', rsi: 7 }, { symbol: 'AAPL', rsi: 3 }, { symbol: 'XLE', rsi: 7 }, { symbol: 'X', rsi: Number.NaN }];
    expect(umkehrAuswahl(k, 2).map((x) => x.symbol)).toEqual(['AAPL', 'XLE']);
    expect(umkehrAuswahl(k, 0)).toEqual([]);
    expect(umkehrAuswahl(k, 9)).toHaveLength(3);
  });

  it('Krypto strenger als ETFs (Rückrechnung 9 Coins), sonst dieselben Regeln', () => {
    expect(umkehrParameterFuer('crypto')).toEqual({ ...UMKEHR, rsiSchwelle: 5, notbremsePct: 25 });
    expect(umkehrParameterFuer('etf_sectors')).toBe(UMKEHR);
    expect(umkehrParameterFuer(null)).toBe(UMKEHR);
  });

  it('Risiko-Hülle: nur Notbremse (−15 %, Krypto −25 %), kein Ziel, kein Trailing', () => {
    expect(umkehrRisk()).toEqual({ stopLossPct: 15, takeProfitPct: 0, trailingStopPct: 0, atrStopMult: 0, atrTakeMult: 0, maxHoldDays: 0 });
    expect(umkehrRisk(UMKEHR_KRYPTO).stopLossPct).toBe(25);
    expect(umkehrNotbremseLevel(100)).toBe(85);
    expect(umkehrNotbremseLevel(100, UMKEHR_KRYPTO)).toBe(75);
  });

  it('Weiche: Umkehr-Käufe bekommen nur die Notbremse ihrer Klasse; Sockel geht vor; Rest unverändert', () => {
    const e = DEFAULT_STRATEGY.engine;
    expect(risikoFuer(e, 'etf_sectors', false, 'umkehr')).toEqual(umkehrRisk());
    expect(risikoFuer(e, 'crypto', false, 'umkehr')).toEqual(umkehrRisk(UMKEHR_KRYPTO));
    expect(risikoFuer(e, 'etf_sectors', true, 'umkehr')).toEqual(sockelRisk());
    expect(risikoFuer(e, 'etf_sectors', false, 'konfluenz')).toEqual(resolveRisk(e, 'etf_sectors'));
    expect(risikoFuer(e, 'etf_sectors', false)).toEqual(resolveRisk(e, 'etf_sectors'));
    const p = { avgEntry: 100, stopLoss: 98, takeProfit: 104, quelle: 'umkehr', core: false };
    expect(umkehrPruefPosition(p, 'stocks_us')).toMatchObject({ stopLoss: 85, takeProfit: null });
    expect(umkehrPruefPosition(p, 'crypto')).toMatchObject({ stopLoss: 75, takeProfit: null });
    expect(umkehrPruefPosition({ ...p, quelle: 'konfluenz' }, 'stocks_us')).toMatchObject({ stopLoss: 98, takeProfit: 104 });
    expect(umkehrPruefPosition({ ...p, core: true }, 'stocks_us')).toMatchObject({ stopLoss: 98 });
  });

  it('Positionswert: aktives Kapital (nach Sockel) durch 10 Plätze', () => {
    expect(umkehrPositionsWert(100_000, 0)).toBe(10_000);
    expect(umkehrPositionsWert(100_000, 40)).toBe(6_000);
    expect(umkehrPositionsWert(100_000, 140)).toBe(0);
    expect(umkehrPositionsWert(-5, 0)).toBe(0);
  });

  it('nur abgeschlossene Kerzen: die laufende Tageskerze fällt weg, abends nicht', () => {
    const k = [{ date: '2026-10-19' }, { date: '2026-10-20' }];
    expect(abgeschlosseneKerzen(k, '2026-10-20', false)).toEqual([{ date: '2026-10-19' }]);
    expect(abgeschlosseneKerzen(k, '2026-10-20', true)).toEqual(k);
  });
});
