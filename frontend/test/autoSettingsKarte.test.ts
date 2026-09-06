/**
 * Wächter der Einstellungen des Auto-Traders (settings.auto).
 *
 * Die Karte ersetzt das alte Strategie-Formular: sieben Felder plus die
 * Symbolauswahl. Was hier gepinnt ist, sind die Zusagen, die man dem
 * Formular nicht ansieht — dass die Grenzen dieselben sind wie im Schema des
 * Takts, dass der Client vor dem Senden prüft und Klartext zeigt, dass die
 * Symbolauswahl NUR als echte Teilmenge gespeichert wird, und dass ohne
 * `settings.auto` dieselbe Ableitung gilt wie im Takt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_GRENZEN, AUTO_SYMBOLS_MAX, validateAutoSettings } from '@autotrd/shared';
import { valText } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Formular — Felder und Grenzen', () => {
  it('die sieben Felder stehen im Markup', () => {
    for (const id of ['asRisk', 'asMaxPct', 'asMaxN', 'asDaily', 'asDd', 'asShort', 'asTelegram']) {
      expect(dashboard, `${id} fehlt`).toContain(`id="${id}"`);
    }
  });

  it('min/max der Zahlenfelder kommen aus AUTO_GRENZEN — nicht aus zweiten Konstanten', () => {
    for (const feld of ['riskPerTradePct', 'maxPositionPct', 'maxPositions', 'maxDailyLossPct', 'maxDrawdownPct'] as const) {
      expect(dashboard).toContain(`min="\${AUTO_GRENZEN.${feld}[0]}" max="\${AUTO_GRENZEN.${feld}[1]}"`);
    }
    // Die Grenzen selbst: die Hülle des Takts (src/core/config.ts, risk).
    expect(AUTO_GRENZEN.riskPerTradePct).toEqual([0, 5]);
    expect(AUTO_GRENZEN.maxPositions).toEqual([1, 50]);
    expect(AUTO_GRENZEN.maxDailyLossPct).toEqual([0, 50]);
    expect(AUTO_GRENZEN.maxDrawdownPct).toEqual([0, 90]);
  });

  it('das Formular rendert aus dem GESPEICHERTEN Stand, nie optimistisch', () => {
    const fn = dashboard.slice(dashboard.indexOf('function fillAutoForm'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain('const a = st.auto;');
    // Der Aufruf hängt am User-Doc-Listener — nach jedem Speichern kommt der
    // Stand über Firestore zurück.
    const mount = dashboard.slice(dashboard.indexOf('watchUserDoc(uid, (u) => {'));
    expect(mount.slice(0, 1500)).toContain('fillAutoForm();');
  });

  it('ohne settings.auto gilt dieselbe Ableitung wie im Takt (autoSettingsFromLegacy)', () => {
    expect(dashboard).toContain('st.auto = u.auto ? { ...AUTO_DEFAULTS, ...u.auto } : autoSettingsFromLegacy(u.strategy);');
  });
});

describe('Speichern — prüfen, senden, ehrlich melden', () => {
  it('erst lokal prüfen (Klartext sofort), dann serverseitig', () => {
    const fn = dashboard.slice(dashboard.indexOf('async function submitAuto'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain('const probe = validateAutoSettings(auto, st.universe);');
    expect(block).toContain('err.textContent = probe.fehler.map(valText).join(\' · \');');
    expect(block.indexOf('validateAutoSettings')).toBeLessThan(block.indexOf('saveStrategy'));
    // Serverfehler landen sichtbar in #asErr, nicht in der Konsole.
    expect(block).toContain('err.textContent = serverText(e);');
  });

  it('jeder Code, den validateAutoSettings erzeugen kann, löst sich in Klartext auf', () => {
    const faelle: unknown[] = [
      null,
      { riskPerTradePct: 'x', maxPositionPct: 200, maxPositions: 2.5, maxDailyLossPct: -1, maxDrawdownPct: 95, allowShort: 'ja', notifyTelegram: 1, symbols: [] },
      { riskPerTradePct: 1, maxPositionPct: 10, maxPositions: 2, maxDailyLossPct: 1, maxDrawdownPct: 5, allowShort: false, symbols: Array.from({ length: AUTO_SYMBOLS_MAX + 1 }, (_, i) => `S${i}`) },
    ];
    const codes = new Set<string>();
    for (const f of faelle) for (const p of validateAutoSettings(f).fehler) codes.add(p);
    for (const p of validateAutoSettings({ riskPerTradePct: 1, maxPositionPct: 10, maxPositions: 2, maxDailyLossPct: 1, maxDrawdownPct: 5, allowShort: false, symbols: ['ZZZZ'] }, ['SPY']).fehler) codes.add(p);
    expect(codes.size).toBeGreaterThanOrEqual(7);
    for (const p of codes) {
      const text = valText(p);
      expect(text, p).not.toMatch(/^val\./);
      expect(text, p).not.toContain('{');
    }
  });

  it('die Symbolauswahl wird NUR als echte Teilmenge gespeichert', () => {
    /* Sind alle gewählt, fällt das Feld weg — der Takt handelt dann das
     * ganze Universum, auch wenn es später wächst. Eine gespeicherte
     * Vollliste würde beim nächsten neuen Symbol still zur Teilmenge. */
    const fn = dashboard.slice(dashboard.indexOf('function autoFormSettings'));
    const block = fn.slice(0, fn.indexOf('\n}'));
    expect(block).toContain('const teilmenge = st && alle.length < st.universe.length;');
    expect(block).toContain('...(teilmenge ? { symbols: alle } : {}),');
  });

  it('das Universum kommt aus meta/engineConfig, mit der eingebauten Liste als Boden', () => {
    expect(dashboard).toContain("st.universe = cfg?.universe.symbols ?? [...DEFAULT_UNIVERSE];");
    expect(dashboard).toContain("universe: [...DEFAULT_UNIVERSE],");
  });

  it('die Karte sagt ab der ersten Änderung, dass noch nichts gespeichert ist', () => {
    expect(dashboard).toContain("for (const box of [$('asGrid'), $('asSymbols')]) {");
    expect(dashboard).toContain("m.textContent = `⚠ ${t('mt.nichtGespeichert')}`;");
  });
});
