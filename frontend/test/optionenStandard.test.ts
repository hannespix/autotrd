/**
 * Task 24 (Owner 09.10.): „bei den Werten in die Infos noch grob die
 * Standards reinschreiben … wie stark Änderungen ungefähr auf was auswirken
 * … so weiß man die Standards und kann einfach wieder zurücksetzen" — und
 * „alles so einfach verständlich wie möglich".
 *
 * Drei Dinge dürfen nicht verfallen: Der gezeigte Standard ist der echte
 * Standard (Quelle: DEFAULT_STRATEGY), jeder Eintrag hat ein Feld im Modal
 * und einen Tip, und die Sätze bleiben kurz und zweisprachig.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CORE_PCT,
  DEFAULT_MAX_OPEN_POSITIONS,
  DEFAULT_RISK_PER_TRADE_PCT,
  DEFAULT_STRATEGY,
  MIN_EDGE_MULTIPLE,
} from '@autotrd/shared';
import { INFO_DE } from '../src/infotips.js';
import { DE, EN } from '../src/i18n.js';
import {
  OPTIONEN_STANDARD,
  STANDARD_TEXT_DE,
  STANDARD_TEXT_EN,
  gleichStandard,
  standardBlockHtml,
  waehleStandardText,
  wertText,
} from '../src/optionenStandard.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const infotips = readFileSync(join(import.meta.dirname, '..', 'src', 'infotips.ts'), 'utf8');
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
const t = (k: string): string => (DE as Record<string, string>)[k] ?? k;

describe('Standardwerte kommen aus der Quelle, nicht aus dem Text', () => {
  const E = DEFAULT_STRATEGY.engine;
  const S = DEFAULT_STRATEGY.signals;
  it.each([
    ['startkapital', DEFAULT_STRATEGY.broker.initialCapital],
    ['maxPos', E.maxPositionPct],
    ['riskPerTrade', DEFAULT_RISK_PER_TRADE_PCT],
    ['maxOpenPositions', DEFAULT_MAX_OPEN_POSITIONS],
    ['corePct', DEFAULT_CORE_PCT],
    ['leverage', '1'],
    ['stopLoss', E.stopLossPct],
    ['takeProfit', E.takeProfitPct],
    ['trailingStop', E.trailingStopPct],
    ['maxHold', E.maxHoldDays],
    ['atrStop', 0],
    ['atrTake', 0],
    ['signalTimeframe', 'daily'],
    ['cooldownMin', E.cooldownMin],
    ['minConfluence', S.minConfluence],
    ['exitConfluence', S.exitConfluence],
    ['minEdgeMultiple', MIN_EDGE_MULTIPLE],
    ['dailyLossLimit', E.dailyLossLimitPct],
    ['flattenOnBreach', false],
    ['regimeGate', true],
    ['newsVeto', true],
    ['kiNachrichten', true],
    ['allowShort', false],
    ['classAutoTune', true],
    ['classWeights', 1],
  ])('%s → Standard %s', (key, soll) => {
    expect(OPTIONEN_STANDARD[key]?.standard).toBe(soll);
  });

  it('kein Standard steht als nackte Zahl in der Tabelle (außer dem Klassen-Gewicht 1)', () => {
    const tabelle = infotipsQuelle('OPTIONEN_STANDARD', '/* Zahlen, die in den Sätzen');
    const nackt = [...tabelle.matchAll(/standard: (\d+(?:\.\d+)?)/g)].map((m) => m[1]);
    expect(nackt).toEqual(['1']);
  });
});

function infotipsQuelle(von: string, bis: string): string {
  const q = readFileSync(join(import.meta.dirname, '..', 'src', 'optionenStandard.ts'), 'utf8');
  return q.slice(q.indexOf(von), q.indexOf(bis));
}

describe('jeder Eintrag ist angebunden', () => {
  it('jeder Schlüssel ist ein Tip (sonst erscheint der Block nirgends)', () => {
    for (const key of Object.keys(OPTIONEN_STANDARD)) {
      expect(INFO_DE[key], `Tip „${key}" fehlt`).toBeTruthy();
    }
  });

  it('jedes Feld steht im Options-Modal und trägt den ⓘ-Knopf des Tips', () => {
    for (const [key, o] of Object.entries(OPTIONEN_STANDARD)) {
      if (!o.feld) continue;
      expect(dashboard, `Feld #${o.feld}`).toContain(`id="${o.feld}"`);
      expect(dashboard, `iBtn('${key}')`).toContain(`iBtn('${key}')`);
    }
  });

  it('jeder Eintrag hat Kurz-Satz und Wirkung in DE und EN, und die Sätze bleiben kurz', () => {
    for (const key of Object.keys(OPTIONEN_STANDARD)) {
      const de = STANDARD_TEXT_DE[key];
      const en = STANDARD_TEXT_EN[key];
      expect(de?.kurz.length, `${key} kurz DE`).toBeGreaterThan(10);
      expect(de?.wirkung.length, `${key} wirkung DE`).toBeGreaterThan(10);
      expect(en?.kurz?.length, `${key} kurz EN`).toBeGreaterThan(10);
      expect(en?.wirkung?.length, `${key} wirkung EN`).toBeGreaterThan(10);
      expect(en?.kurz, `${key} kurz EN unübersetzt`).not.toBe(de?.kurz);
      expect(en?.wirkung, `${key} wirkung EN unübersetzt`).not.toBe(de?.wirkung);
      // „so einfach verständlich wie möglich": ein Satz, ein kurzer Absatz.
      expect(de!.kurz.length, `${key} kurz DE zu lang`).toBeLessThanOrEqual(130);
      expect(de!.wirkung.length, `${key} wirkung DE zu lang`).toBeLessThanOrEqual(330);
    }
    for (const key of Object.keys(STANDARD_TEXT_DE)) expect(OPTIONEN_STANDARD[key], `Text ohne Eintrag: ${key}`).toBeTruthy();
    for (const key of Object.keys(STANDARD_TEXT_EN)) expect(STANDARD_TEXT_DE[key], `EN-Karteileiche: ${key}`).toBeTruthy();
  });

  it('die Wirkung nennt den Schritt („Plus 1", „Plus 10", „Bei 2×")', () => {
    for (const [key, o] of Object.entries(OPTIONEN_STANDARD)) {
      if (o.art !== 'zahl' || key === 'startkapital') continue;
      const w = STANDARD_TEXT_DE[key]!.wirkung;
      const s = String(o.schritt).replace('.', ',');
      expect(w, `${key}: Schritt ${s} fehlt in „${w.slice(0, 40)}…"`).toMatch(new RegExp(`(Plus|Minus|Bei) ${s.replace(',', '[.,]')}\\b`));
    }
  });

  it('der feldweise Fallback zeigt nie Leeres', () => {
    const en = waehleStandardText('en');
    expect(Object.keys(en).sort()).toEqual(Object.keys(STANDARD_TEXT_DE).sort());
    expect(waehleStandardText('de')).toBe(STANDARD_TEXT_DE);
  });
});

describe('Anzeige für Laien', () => {
  it('Werte lesen sich wie gesprochen: „2 %", „0 (Aus)", „An", Hebel-Beschriftung, 1,5 mit Komma', () => {
    expect(wertText(OPTIONEN_STANDARD['stopLoss']!, 2, 'de', t)).toBe('2 %');
    expect(wertText(OPTIONEN_STANDARD['trailingStop']!, 0, 'de', t)).toBe('0 (Aus)');
    expect(wertText(OPTIONEN_STANDARD['regimeGate']!, true, 'de', t)).toBe('An');
    expect(wertText(OPTIONEN_STANDARD['leverage']!, '1', 'de', t)).toBe(DE['opt.hebel1']);
    expect(wertText(OPTIONEN_STANDARD['atrStop']!, 1.5, 'de', t)).toBe('1,5 ×');
    expect(wertText(OPTIONEN_STANDARD['atrStop']!, 1.5, 'en', t)).toBe('1.5 ×');
    expect(wertText(OPTIONEN_STANDARD['startkapital']!, 25000, 'de', t)).toBe('25.000 $');
  });

  it('Vergleich: Feldwert als String zählt numerisch; Schalter exakt', () => {
    expect(gleichStandard(OPTIONEN_STANDARD['stopLoss']!, '2')).toBe(true);
    expect(gleichStandard(OPTIONEN_STANDARD['stopLoss']!, '2.5')).toBe(false);
    expect(gleichStandard(OPTIONEN_STANDARD['regimeGate']!, true)).toBe(true);
    expect(gleichStandard(OPTIONEN_STANDARD['regimeGate']!, false)).toBe(false);
    expect(gleichStandard(OPTIONEN_STANDARD['stopLoss']!, null)).toBe(false);
  });

  it('Block: Kurz-Satz, Standard, Dein Wert, Wirkung — Rücksetz-Knopf NUR bei Abweichung', () => {
    const ab = standardBlockHtml('stopLoss', '3', 'de', t);
    expect(ab).toContain('class="ipop-kurz"');
    expect(ab).toContain('Standard: <b>2 %</b>');
    expect(ab).toContain('Dein Wert: <b>3 %</b>');
    expect(ab).toContain('data-reset="stopLoss"');
    expect(ab).toContain('Was eine Änderung bewirkt:');
    const gleich = standardBlockHtml('stopLoss', '2', 'de', t);
    expect(gleich).toContain('(= Standard)');
    expect(gleich).not.toContain('ipop-reset');
    // Ohne Feld im DOM: kein Vergleich, kein Knopf — der Standard steht trotzdem.
    const ohne = standardBlockHtml('stopLoss', null, 'de', t);
    expect(ohne).toContain('Standard: <b>2 %</b>');
    expect(ohne).not.toContain('Dein Wert');
    expect(ohne).not.toContain('ipop-reset');
    // Reglergruppe ohne Feld: nie ein Knopf.
    expect(standardBlockHtml('classWeights', '1.5', 'de', t)).not.toContain('ipop-reset');
    expect(standardBlockHtml('unbekannt', '1', 'de', t)).toBe('');
  });

  it('der Block schreibt keinen Feldwert ungeschützt ins Markup', () => {
    expect(standardBlockHtml('stopLoss', '<img src=x>', 'de', t)).not.toContain('<img');
  });
});

describe('Verdrahtung im Popover', () => {
  it('der Standard-Block steht OBEN, der Langtext zum Aufklappen darunter; andere Tips unverändert', () => {
    expect(infotips).toContain("if (!block) return `<b>${info.t}</b><p>${info.d}</p>`;");
    expect(infotips).toContain('<details class="ipop-mehr"><summary>${tx(\'tip.mehr\')}</summary><p>${info.d}</p></details>');
    expect(infotips).toContain('p.innerHTML = popoverHtml(key, info, feldWert(key));');
  });

  it('Rücksetzen schreibt ins Feld und feuert input + change — speichert aber NICHT', () => {
    const fn = infotips.slice(infotips.indexOf('function aufStandard'), infotips.indexOf('export function iBtn'));
    expect(fn).toContain("el.dispatchEvent(new Event('input', { bubbles: true }));");
    expect(fn).toContain("el.dispatchEvent(new Event('change', { bubbles: true }));");
    expect(fn).not.toMatch(/saveStrategy|setDoc|updateDoc/);
    expect(infotips).toContain("if (info && aufStandard(key)) p.innerHTML = popoverHtml(key, info, feldWert(key), tx('tip.eingetragen'));");
  });

  it('Wörterbuch und CSS tragen die neuen Teile', () => {
    for (const k of ['tip.standard', 'tip.deinWert', 'tip.wieStandard', 'tip.aufStandard', 'tip.eingetragen', 'tip.wirkung', 'tip.mehr', 'tip.an', 'tip.aus']) {
      expect(DE[k as keyof typeof DE], k).toBeTruthy();
      expect(EN[k as keyof typeof EN], k).toBeTruthy();
    }
    expect(css).toContain('.ipop-reset {');
    expect(css).toContain('.ipop-mehr summary {');
  });
});
