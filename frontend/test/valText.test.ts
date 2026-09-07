/**
 * Wächter der Validierungs-Codes.
 *
 * `validateAutoSettings` (Einstellungen des Auto-Traders) und
 * `validateStrategy` (Struktur des Alt-Payloads) liefern CODES statt Prosa —
 * `valText` macht daraus den Klartext der gewählten Sprache. Die
 * Vollständigkeits-Probe unten ist der eigentliche Vertrag: JEDER Code, den
 * eine der beiden Prüfungen erzeugen kann, muss sich auflösen. Ein Code ohne
 * Wörterbuch-Eintrag stünde sonst roh im UI (valText reicht Unbekanntes
 * wortwörtlich durch — genau deshalb ist die Lücke hier ein Testfehler).
 */
import { AUTO_SYMBOLS_MAX, validateAutoSettings, validateStrategy } from '@autotrd/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DE, serverText, valText } from '../src/i18n.js';

let sprache: string | null = null;
beforeEach(() => {
  sprache = null;
  globalThis.localStorage = {
    getItem: (k: string) => (k === 'autotrd-lang' ? sprache : null),
    setItem: () => undefined,
  } as unknown as Storage;
});

describe('valText — Codes werden Klartext', () => {
  it('setzt Feld und Grenzen ein (Deutsch)', () => {
    expect(valText('val.bereich|maxPositionPct|0|100')).toBe('maxPositionPct muss zwischen 0 und 100 liegen');
    expect(valText('val.zahl|riskPerTradePct')).toBe('riskPerTradePct muss eine Zahl sein');
    expect(valText('val.unbekannteSymbole|symbols|ZZZZ, YYYY')).toBe('Nicht im Plattform-Universum: ZZZZ, YYYY');
  });

  it('übersetzt nach Englisch, wenn EN gewählt ist', () => {
    sprache = 'en';
    expect(valText('val.pflichtFehlt|engine')).toBe("Required key 'engine' is missing");
    expect(valText('val.ganzzahl|maxPositions')).toBe('maxPositions must be an integer');
  });

  it('reicht Unbekanntes unverändert durch — nie ein roher Schlüssel im UI', () => {
    expect(valText('irgendein alter Text')).toBe('irgendein alter Text');
    expect(valText('val.gibtEsNicht|x')).toBe('val.gibtEsNicht|x');
  });

  it('serverText löst die von saveStrategy gejointen Codes auf', () => {
    const e = new Error('val.zahl|riskPerTradePct · val.boolean|allowShort');
    expect(serverText(e)).toBe('riskPerTradePct muss eine Zahl sein · allowShort muss boolean sein');
  });
});

describe('Vollständigkeit — jeder erzeugbare Code hat einen Wörterbuch-Eintrag', () => {
  /** Eingaben, die zusammen JEDEN Zweig von validateAutoSettings reißen. */
  const autoFaelle: Array<[unknown, readonly string[] | undefined]> = [
    [null, undefined],
    [{ riskPerTradePct: 'x', maxPositionPct: 200, maxPositions: 2.5, maxDailyLossPct: -1, maxDrawdownPct: 95, allowShort: 'ja', notifyTelegram: 1, symbols: 'SPY' }, undefined],
    [{ riskPerTradePct: 1, maxPositionPct: 10, maxPositions: 2, maxDailyLossPct: 1, maxDrawdownPct: 5, allowShort: false, symbols: ['SP Y'] }, undefined],
    [{ riskPerTradePct: 1, maxPositionPct: 10, maxPositions: 2, maxDailyLossPct: 1, maxDrawdownPct: 5, allowShort: false, symbols: Array.from({ length: AUTO_SYMBOLS_MAX + 1 }, (_, i) => `S${i}`) }, undefined],
    [{ riskPerTradePct: 1, maxPositionPct: 10, maxPositions: 2, maxDailyLossPct: 1, maxDrawdownPct: 5, allowShort: false, symbols: ['ZZZZ'] }, ['SPY']],
  ];
  /** Eingaben, die jeden Zweig der Struktur-Prüfung des Alt-Payloads reißen. */
  const strategieFaelle: unknown[] = [null, 'yaml', [], { strategy: {}, indices: {} }, {}, { engine: 'x' }, { engine: { running: 'x' } }];

  function alleCodes(): Set<string> {
    const codes = new Set<string>();
    for (const [wert, universum] of autoFaelle) for (const p of validateAutoSettings(wert, universum).fehler) codes.add(p);
    for (const wert of strategieFaelle) for (const p of validateStrategy(wert)) codes.add(p);
    return codes;
  }

  it('kein Code bleibt unaufgelöst, kein Platzhalter bleibt stehen', () => {
    const codes = alleCodes();
    // Die Fixtures reißen bewusst JEDEN Zweig — wächst eine der Prüfungen,
    // ohne dass ihr neuer Code hier durchläuft, ist das ein Testloch. Die
    // Zahl pinnt den Anspruch (Stand: 11 Muster, 16 verschiedene Codes).
    expect(codes.size).toBeGreaterThanOrEqual(16);
    for (const p of codes) {
      const text = valText(p);
      expect(text, p).not.toMatch(/^val\./);
      expect(text, p).not.toContain('{');
    }
  });

  it('jedes Muster der beiden Prüfungen hat eine Zeile — und keine Zeile ist ohne Erzeuger', () => {
    /* Gegenrichtung: Das Wörterbuch trägt keine val.-Zeilen mehr für Zweige,
     * die es nicht mehr gibt (Hebel, Sockel, Watchlist, …). Karteileichen
     * täuschten sonst vor, ein Code könne noch fallen. */
    const shared = ['validate.ts', 'autoSettings.ts']
      .map((f) => readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'src', f), 'utf8'))
      .join('\n');
    const erzeugbar = new Set([...shared.matchAll(/\b(val\.\w+)\b/g)].map((m) => m[1]!));
    const imWoerterbuch = Object.keys(DE).filter((k) => k.startsWith('val.'));
    expect(imWoerterbuch.filter((k) => !erzeugbar.has(k)), 'val.-Zeilen ohne Erzeuger').toEqual([]);
    expect([...erzeugbar].filter((k) => !imWoerterbuch.includes(k)), 'Muster ohne Wörterbuch-Zeile').toEqual([]);
    expect(erzeugbar.size).toBeGreaterThanOrEqual(11);
  });
});
