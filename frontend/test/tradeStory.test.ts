/**
 * Wächter des Maschinen-Videos (V2, Owner 20.08.: „Autotuning und Trading
 * in den Mittelpunkt", keine Ergebniszahlen).
 *
 * Die Auswahl-/Paarungs-Logik ist pur und wird funktional geprüft; die
 * Ehrlichkeitsregeln hängen an Quelltext- und Wörterbuch-Pins: Das Video
 * behauptet KEINE Rendite — deshalb dürfen weder die Maler Zahlen
 * formatieren noch die ts.*-Texte Ziffern enthalten.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HistoryTrade } from '@autotrd/shared';
import {
  aktBei,
  aktPlan,
  findeTradePaare,
  kursFenster,
  storyKontext,
  tradeProzent,
  waehleTradeStory,
} from '../src/tradeStory.js';

const T = (
  symbol: string,
  side: 'buy' | 'sell',
  price: number,
  executedAt: string,
  pnl?: number,
): HistoryTrade => ({ symbol, side, qty: 2, price, executedAt, ...(pnl !== undefined ? { pnl } : {}) });

describe('findeTradePaare — Exits finden ihre Eröffnung', () => {
  it('Long: buy → sell(pnl); die Eröffnung ist der jüngste Gegenseiten-Trade davor', () => {
    const paare = findeTradePaare([
      T('NVDA', 'buy', 100, '2026-08-18T14:00:00.000Z'),
      T('NVDA', 'sell', 104, '2026-08-18T18:00:00.000Z', 8),
    ]);
    expect(paare).toHaveLength(1);
    expect(paare[0]!.einstieg.price).toBe(100);
    expect(paare[0]!.exit.pnl).toBe(8);
  });

  it('Short: sell (ohne pnl) → buy(pnl) — der Cover findet den Short-Einstieg', () => {
    const paare = findeTradePaare([
      T('TSLA', 'sell', 200, '2026-08-18T14:00:00.000Z'),
      T('TSLA', 'buy', 190, '2026-08-18T19:00:00.000Z', 20),
    ]);
    expect(paare).toHaveLength(1);
    expect(paare[0]!.einstieg.side).toBe('sell');
  });

  it('zwei Runden im selben Symbol: jeder Exit paart mit SEINER Eröffnung', () => {
    const paare = findeTradePaare([
      T('GLD', 'buy', 50, '2026-08-10T10:00:00.000Z'),
      T('GLD', 'sell', 52, '2026-08-10T15:00:00.000Z', 4),
      T('GLD', 'buy', 53, '2026-08-12T10:00:00.000Z'),
      T('GLD', 'sell', 51, '2026-08-12T15:00:00.000Z', -4),
    ]);
    expect(paare).toHaveLength(2);
    expect(paare.find((p) => p.exit.pnl === -4)!.einstieg.price).toBe(53);
  });

  it('Exit ohne auffindbare Eröffnung fliegt ehrlich raus', () => {
    expect(findeTradePaare([T('EWJ', 'sell', 70, '2026-08-18T18:00:00.000Z', 5)])).toHaveLength(0);
  });
});

describe('waehleTradeStory — die beste Geschichte', () => {
  const jetzt = new Date('2026-08-20T20:00:00.000Z');
  it('größte Bewegung (|%|) unter den jungen Trades gewinnt', () => {
    const wahl = waehleTradeStory(
      [
        T('KLEIN', 'buy', 100, '2026-08-18T10:00:00.000Z'),
        T('KLEIN', 'sell', 101, '2026-08-18T15:00:00.000Z', 2),
        T('GROSS', 'buy', 100, '2026-08-17T10:00:00.000Z'),
        T('GROSS', 'sell', 92, '2026-08-17T15:00:00.000Z', -16),
      ],
      jetzt,
    );
    expect(wahl?.exit.symbol).toBe('GROSS');
  });

  it('nur alte Trades: der größte insgesamt statt gar keiner', () => {
    const wahl = waehleTradeStory(
      [
        T('ALT', 'buy', 100, '2026-05-01T10:00:00.000Z'),
        T('ALT', 'sell', 110, '2026-05-01T15:00:00.000Z', 20),
      ],
      jetzt,
    );
    expect(wahl?.exit.symbol).toBe('ALT');
  });

  it('ohne geschlossene Trades: null', () => {
    expect(waehleTradeStory([T('NVDA', 'buy', 100, '2026-08-18T10:00:00.000Z')], jetzt)).toBeNull();
  });

  it('tradeProzent rechnet auf den Einsatz', () => {
    const paar = findeTradePaare([
      T('X', 'buy', 100, '2026-08-18T10:00:00.000Z'),
      T('X', 'sell', 104, '2026-08-18T15:00:00.000Z', 8),
    ])[0]!;
    expect(tradeProzent(paar)).toBe(4); // 8 auf 200 Einsatz
  });
});

describe('kursFenster — die Bühne des Trades', () => {
  const eMs = Date.parse('2026-08-18T14:00:00.000Z');
  const xMs = Date.parse('2026-08-18T18:00:00.000Z');
  it('behält Vorlauf und Nachlauf, wirft Fernes weg, sortiert aufsteigend', () => {
    const kurse = [
      { at: eMs - 3 * 3_600_000, c: 1 }, // zu früh (Vorlauf ~1,4 h)
      { at: xMs + 20 * 60_000, c: 4 },
      { at: eMs - 60 * 60_000, c: 2 },
      { at: eMs + 60 * 60_000, c: 3 },
      { at: xMs + 5 * 3_600_000, c: 9 }, // zu spät
    ];
    const fenster = kursFenster(kurse, eMs, xMs);
    expect(fenster.map((k) => k.c)).toEqual([2, 3, 4]);
  });

  it('Blitz-Trades bekommen das Mindest-Polster (Viertelstunde)', () => {
    const fenster = kursFenster(
      [
        { at: eMs - 12 * 60_000, c: 1 },
        { at: eMs, c: 2 },
        { at: eMs + 8 * 60_000, c: 3 },
      ],
      eMs,
      eMs + 60_000,
    );
    expect(fenster).toHaveLength(3);
  });
});

describe('aktPlan/aktBei — die fünf Akte', () => {
  it('Reihenfolge Scanner→Signal→Netz→Tuning→Abspann, ~20 s gesamt', () => {
    const plan = aktPlan();
    expect(plan.map((a) => a.id)).toEqual(['scanner', 'signal', 'netz', 'lernen', 'abspann']);
    const gesamt = plan.reduce((s, a) => s + a.dauerMs, 0);
    expect(gesamt).toBeGreaterThanOrEqual(15_000);
    expect(gesamt).toBeLessThanOrEqual(22_000);
  });

  it('aktBei findet Akt und Fortschritt', () => {
    const plan = aktPlan();
    expect(aktBei(plan, 0).akt.id).toBe('scanner');
    expect(aktBei(plan, 3600).akt.id).toBe('signal');
    expect(aktBei(plan, 999_999).p).toBe(1);
  });
});

describe('storyKontext — nur eingefrorene Journal-Fakten', () => {
  it('filtert die Stimmen auf die Einstiegsseite und baut die Konfluenz-Angabe', () => {
    const k = storyKontext(
      { votes: { rsi: 'buy', macd: 'buy', bollinger: 'sell' }, konfluenz: 2, minKonfluenz: 2 },
      'buy',
    );
    expect(k.stimmen).toEqual(['RSI', 'MACD']);
    expect(k.konfluenz).toBe('2/2');
  });

  it('ohne Kontext: leer, ohne Erfindung', () => {
    expect(storyKontext(null, 'buy')).toEqual({ stimmen: [], konfluenz: null });
    expect(storyKontext({ konfluenz: 3 }, 'buy').konfluenz).toBeNull();
  });
});

describe('Quelltext-Pins — Ehrlichkeit des Maschinen-Videos', () => {
  const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const video = lese('../src/tradeStoryVideo.ts');
  const dashboard = lese('../src/dashboard.ts');
  const i18n = lese('../src/i18n.ts');

  it('das Video formatiert KEINE Rendite und KEIN Geld', () => {
    expect(video).not.toMatch(/formatRendite|money\(|toFixed\(/);
  });

  it('die ts.*-Texte sind zifferfrei (DE und EN) — keine Zahlen-Behauptung', () => {
    const zeilen = i18n.split('\n').filter((z) => /^\s*'ts\./.test(z));
    expect(zeilen.length).toBeGreaterThanOrEqual(40); // beide Sprachen
    for (const zeile of zeilen) {
      const wert = /:\s*'([^']*)'/.exec(zeile)?.[1] ?? '';
      expect(wert, zeile).not.toMatch(/\d/);
    }
  });

  it('der Papier-Hinweis steht im Abspann, solange kein Echtgeld läuft', () => {
    expect(video).toMatch(/if \(!d\.echtgeld\) \{[\s\S]*?ts\.papierHinweis/);
  });

  it('jeder Akt malt auf der festen Bühne (maleRahmen zuerst)', () => {
    expect(video).toMatch(/maleRahmen\(ctx\);\s*\n\s*if \(akt === 'scanner'\)/);
  });

  it('dashboard lädt das Modul NUR dynamisch (kein Bundle-Wachstum)', () => {
    expect(dashboard).toMatch(/import\('\.\/tradeStoryVideo\.js'\)/);
    expect(dashboard).not.toMatch(/^import .* from '\.\/tradeStoryVideo/m);
  });

  it('die Kurse kommen aus echten Stores — Intraday zuerst, Tages-Fallback, sonst Absage', () => {
    expect(dashboard).toMatch(/loadIntradayChunks\(paar\.exit\.symbol/);
    expect(dashboard).toMatch(/loadDailyChunk\(paar\.exit\.symbol/);
    expect(dashboard).toContain("t('ts.keineKurse')");
  });
});
