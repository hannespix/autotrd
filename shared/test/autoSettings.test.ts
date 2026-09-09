/**
 * `settings.auto` — das Einstellungs-Schema des Auto-Traders.
 *
 * Geprüft wird die Seite, auf der Geld verloren geht: Werte außerhalb der
 * Schema-Hülle des Kerns dürfen nie gespeichert werden (der Takt lehnte sie
 * beim Lesen ab und überspränge den Nutzer still), eine leere Symbol-Liste
 * darf nie als `[]` landen (der Takt scheiterte mit „kein Symbol des
 * Universums"), und die Alt-Ableitung muss exakt die des Engine-Takts sein.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_DEFAULTS,
  AUTO_GRENZEN,
  AUTO_SYMBOLS_MAX,
  autoSettingsFromLegacy,
  normalisiereSymbole,
  validateAutoSettings,
  type AutoSettings,
} from '../src/index.js';

const gueltig: AutoSettings = {
  riskPerTradePct: 1,
  maxPositionPct: 25,
  maxPositions: 3,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  allowShort: true,
};

describe('validateAutoSettings — gültige Eingaben', () => {
  it('akzeptiert AUTO_DEFAULTS und liefert sie als vollständigen Wert zurück', () => {
    const p = validateAutoSettings(AUTO_DEFAULTS);
    expect(p.ok).toBe(true);
    expect(p.fehler).toEqual([]);
    expect(p.wert).toEqual({ ...AUTO_DEFAULTS });
    // Das Schema des Kerns hat dieselben Voreinstellungen (config.test.ts pinnt die Gegenseite).
    expect(AUTO_DEFAULTS).toMatchObject({ riskPerTradePct: 0.5, maxPositionPct: 20, maxPositions: 4, maxDailyLossPct: 2, maxDrawdownPct: 10, allowShort: false });
    expect(AUTO_DEFAULTS.symbols).toBeUndefined();
  });

  it('Grenzen sind inklusive: beide Ränder jedes Feldes gehen durch', () => {
    for (const [feld, [min, max]] of Object.entries(AUTO_GRENZEN)) {
      for (const v of [min, max]) {
        const p = validateAutoSettings({ ...gueltig, [feld]: v });
        expect(p.ok, `${feld}=${v}`).toBe(true);
      }
    }
  });

  it('normalisiert Symbole: trimmen, Großschreibung, Duplikate raus, Reihenfolge bleibt', () => {
    const p = validateAutoSettings({ ...gueltig, symbols: [' msft', 'aapl', 'MSFT', 'Aapl ', 'BTC/USD', 'brk.b'] });
    expect(p.ok).toBe(true);
    expect(p.wert?.symbols).toEqual(['MSFT', 'AAPL', 'BTC/USD', 'BRK.B']);
  });

  it('notifyTelegram fehlend ⇒ false; unbekannte Schlüssel werden nicht übernommen', () => {
    const p = validateAutoSettings({ ...gueltig, hebel: 3, watchlist: ['QQQ'] });
    expect(p.ok).toBe(true);
    expect(p.wert).toEqual({ ...gueltig, notifyTelegram: false, basis: true });
    expect(Object.keys(p.wert ?? {})).not.toContain('hebel');
  });

  it('basis fehlend ⇒ AN (Voreinstellung), false bleibt false, true bleibt true — immer ausdrücklich gespeichert', () => {
    expect(validateAutoSettings(gueltig).wert?.basis).toBe(true);
    expect(validateAutoSettings({ ...gueltig, basis: false }).wert?.basis).toBe(false);
    expect(validateAutoSettings({ ...gueltig, basis: true }).wert?.basis).toBe(true);
    expect(AUTO_DEFAULTS.basis).toBe(true);
  });
});

describe('validateAutoSettings — die Seite, auf der Geld verloren geht', () => {
  it('kein Objekt ⇒ val.objekt|auto', () => {
    for (const x of [null, undefined, 'auto', 42, []]) {
      expect(validateAutoSettings(x)).toEqual({ ok: false, wert: null, fehler: ['val.objekt|auto'] });
    }
  });

  it('jede Zahl ist PFLICHT — ein halbes Objekt wird nicht mit Voreinstellungen aufgefüllt', () => {
    const p = validateAutoSettings({ allowShort: false });
    expect(p.ok).toBe(false);
    expect(p.wert).toBeNull();
    expect(p.fehler).toEqual([
      'val.zahl|riskPerTradePct',
      'val.zahl|maxPositionPct',
      'val.zahl|maxPositions',
      'val.zahl|maxDailyLossPct',
      'val.zahl|maxDrawdownPct',
    ]);
  });

  it('Strings, NaN und Infinity sind keine Zahlen', () => {
    const p = validateAutoSettings({ ...gueltig, riskPerTradePct: '1', maxPositionPct: Number.NaN, maxDrawdownPct: Number.POSITIVE_INFINITY });
    expect(p.fehler).toEqual(['val.zahl|riskPerTradePct', 'val.zahl|maxPositionPct', 'val.zahl|maxDrawdownPct']);
  });

  it('außerhalb der Hülle ⇒ val.bereich|feld|min|max (dieselbe Hülle wie das Schema des Kerns)', () => {
    expect(validateAutoSettings({ ...gueltig, riskPerTradePct: 5.01 }).fehler).toEqual(['val.bereich|riskPerTradePct|0|5']);
    expect(validateAutoSettings({ ...gueltig, riskPerTradePct: -0.1 }).fehler).toEqual(['val.bereich|riskPerTradePct|0|5']);
    expect(validateAutoSettings({ ...gueltig, maxPositionPct: 101 }).fehler).toEqual(['val.bereich|maxPositionPct|0|100']);
    expect(validateAutoSettings({ ...gueltig, maxPositions: 0 }).fehler).toEqual(['val.bereich|maxPositions|1|50']);
    expect(validateAutoSettings({ ...gueltig, maxPositions: 51 }).fehler).toEqual(['val.bereich|maxPositions|1|50']);
    expect(validateAutoSettings({ ...gueltig, maxDailyLossPct: 50.5 }).fehler).toEqual(['val.bereich|maxDailyLossPct|0|50']);
    expect(validateAutoSettings({ ...gueltig, maxDrawdownPct: 91 }).fehler).toEqual(['val.bereich|maxDrawdownPct|0|90']);
  });

  it('maxPositions muss ganzzahlig sein — nie still runden', () => {
    expect(validateAutoSettings({ ...gueltig, maxPositions: 2.5 }).fehler).toEqual(['val.ganzzahl|maxPositions']);
  });

  it('allowShort ist Pflicht, notifyTelegram und basis optional — alle nur als Boolean', () => {
    expect(validateAutoSettings({ ...gueltig, allowShort: 'true' }).fehler).toEqual(['val.boolean|allowShort']);
    expect(validateAutoSettings({ ...gueltig, notifyTelegram: 1 }).fehler).toEqual(['val.boolean|notifyTelegram']);
    expect(validateAutoSettings({ ...gueltig, basis: 'an' }).fehler).toEqual(['val.boolean|basis']);
    expect(validateAutoSettings({ ...gueltig, basis: 0 }).fehler).toEqual(['val.boolean|basis']);
    const ohne = { ...gueltig } as Record<string, unknown>;
    delete ohne.allowShort;
    expect(validateAutoSettings(ohne).fehler).toEqual(['val.boolean|allowShort']);
  });

  it('meldet alle Probleme auf einmal, nicht nur das erste', () => {
    const p = validateAutoSettings({ ...gueltig, maxPositions: 0, allowShort: null, symbols: 'AAPL' });
    expect(p.fehler).toEqual(['val.bereich|maxPositions|1|50', 'val.boolean|allowShort', 'val.symbole|symbols']);
  });
});

describe('validateAutoSettings — Symbole', () => {
  it('leere Liste ⇒ Feld weggelassen (ganzes Universum), nie ein gespeichertes []', () => {
    const p = validateAutoSettings({ ...gueltig, symbols: [] });
    expect(p.ok).toBe(true);
    expect(p.wert).not.toHaveProperty('symbols');
    const nurLeer = validateAutoSettings({ ...gueltig, symbols: ['', '  '] });
    expect(nurLeer.ok).toBe(true);
    expect(nurLeer.wert).not.toHaveProperty('symbols');
  });

  it('keine Liste von Strings, Leerzeichen im Ticker oder ein „|" ⇒ val.symbole|symbols', () => {
    expect(validateAutoSettings({ ...gueltig, symbols: 'AAPL' }).fehler).toEqual(['val.symbole|symbols']);
    expect(validateAutoSettings({ ...gueltig, symbols: [1, 'AAPL'] }).fehler).toEqual(['val.symbole|symbols']);
    expect(validateAutoSettings({ ...gueltig, symbols: ['AA PL'] }).fehler).toEqual(['val.symbole|symbols']);
    // Ein `|` im Symbol zerlegte den Fehlercode selbst — deshalb hart verboten.
    expect(validateAutoSettings({ ...gueltig, symbols: ['A|B'] }).fehler).toEqual(['val.symbole|symbols']);
    expect(validateAutoSettings({ ...gueltig, symbols: ['X'.repeat(25)] }).fehler).toEqual(['val.symbole|symbols']);
  });

  it('höchstens AUTO_SYMBOLS_MAX — gezählt NACH dem Entfernen der Duplikate', () => {
    const viele = Array.from({ length: AUTO_SYMBOLS_MAX + 1 }, (_, i) => `S${i}`);
    expect(validateAutoSettings({ ...gueltig, symbols: viele }).fehler).toEqual([`val.hoechstens|symbols|${AUTO_SYMBOLS_MAX}`]);
    const genau = viele.slice(0, AUTO_SYMBOLS_MAX);
    expect(validateAutoSettings({ ...gueltig, symbols: [...genau, ...genau] }).ok).toBe(true);
  });

  it('mit Universum: nur dessen Symbole, Vergleich nach Normalisierung, Fremde namentlich', () => {
    const universum = ['aapl', 'MSFT ', 'BTC/USD'];
    const ok = validateAutoSettings({ ...gueltig, symbols: ['AAPL', 'msft', 'btc/usd'] }, universum);
    expect(ok.ok).toBe(true);
    expect(ok.wert?.symbols).toEqual(['AAPL', 'MSFT', 'BTC/USD']);
    const fremd = validateAutoSettings({ ...gueltig, symbols: ['AAPL', 'XYZ', 'ABC'] }, universum);
    expect(fremd.ok).toBe(false);
    expect(fremd.fehler).toEqual(['val.unbekannteSymbole|symbols|XYZ, ABC']);
  });

  it('ohne Universum wird nichts gegen eine Liste geprüft', () => {
    expect(validateAutoSettings({ ...gueltig, symbols: ['XYZ'] }).ok).toBe(true);
  });

  it('normalisiereSymbole ist idempotent', () => {
    const einmal = normalisiereSymbole([' a', 'b', 'A']);
    expect(normalisiereSymbole(einmal)).toEqual(einmal);
    expect(einmal).toEqual(['A', 'B']);
  });
});

describe('autoSettingsFromLegacy — dieselbe Ableitung wie der Engine-Takt', () => {
  it('Alt-Felder werden übernommen, Drawdown-Sperre und Telegram sind Voreinstellung', () => {
    const auto = autoSettingsFromLegacy({
      engine: { riskPerTradePct: 1, maxPositionPct: 10, maxOpenPositions: 8, dailyLossLimitPct: 3, running: true },
      signals: { allowShort: true },
    });
    expect(auto).toEqual({
      riskPerTradePct: 1,
      maxPositionPct: 10,
      maxPositions: 8,
      maxDailyLossPct: 3,
      maxDrawdownPct: 10,
      allowShort: true,
      notifyTelegram: false,
      basis: true,
    });
    expect(auto.symbols).toBeUndefined();
  });

  it('klemmt in die Hülle: riskPerTradePct 0 ⇒ Voreinstellung, 100 Positionen ⇒ 50, 80 % Tagesverlust ⇒ 50', () => {
    const auto = autoSettingsFromLegacy({
      engine: { riskPerTradePct: 0, maxPositionPct: 0, maxOpenPositions: 100, dailyLossLimitPct: 80 },
      signals: {},
    });
    expect(auto).toEqual({ ...AUTO_DEFAULTS, maxPositions: 50, maxDailyLossPct: 50 });
  });

  it('dailyLossLimitPct 0 hieß „aus" und bleibt 0 (der Kern prüft > 0)', () => {
    expect(autoSettingsFromLegacy({ engine: { dailyLossLimitPct: 0 } }).maxDailyLossPct).toBe(0);
  });

  it('Bruchzahlen bei Positionen werden abgerundet; Müll fällt auf Voreinstellungen', () => {
    expect(autoSettingsFromLegacy({ engine: { maxOpenPositions: 7.9 } }).maxPositions).toBe(7);
    expect(autoSettingsFromLegacy({ engine: { riskPerTradePct: 'viel', maxPositionPct: Number.NaN }, signals: { allowShort: 'ja' } })).toEqual({ ...AUTO_DEFAULTS });
    expect(autoSettingsFromLegacy(null)).toEqual({ ...AUTO_DEFAULTS });
    expect(autoSettingsFromLegacy('strategie')).toEqual({ ...AUTO_DEFAULTS });
  });

  it('was die Ableitung liefert, besteht die Validierung — sonst hätte das Formular einen ungültigen Startwert', () => {
    for (const engine of [
      { riskPerTradePct: 9, maxPositionPct: 500, maxOpenPositions: 0.2, dailyLossLimitPct: -1 },
      { riskPerTradePct: 0.001, maxPositionPct: 0.05 },
      {},
    ]) {
      const auto = autoSettingsFromLegacy({ engine, signals: {} });
      expect(validateAutoSettings(auto).ok, JSON.stringify(engine)).toBe(true);
    }
  });
});
