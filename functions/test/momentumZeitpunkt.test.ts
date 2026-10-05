/**
 * Befund 05.10.: Sockel-Orders der Broker-Konten liefen bei geschlossener
 * Börse — der Lauf lag um 18:00 ET, die Orders wurden nach Sekunden wieder
 * storniert, und `lastRebalance` wurde trotzdem gestempelt. Broker-Konten
 * bekamen ihren Sockel damit praktisch nie.
 *
 * Gepinnt werden die zwei puren Regeln, ihre Verwendung in BEIDEN
 * Rebalancing-Schleifen und die Übereinstimmung des Zeitplans zwischen Code
 * und Scheduler-Diagnose — die Diagnose korrigiert jeden Job auf IHREN Wert
 * und würde einen abweichenden Code-Zeitplan still zurückdrehen.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebalanceErledigt, rebalanceJetzt } from '../src/scheduled/momentumRun.js';

const wurzel = join(import.meta.dirname, '..', '..');
const lies = (...teile: string[]): string => readFileSync(join(wurzel, ...teile), 'utf8');

describe('rebalanceJetzt', () => {
  it('Konto ohne Broker: immer — es bucht im eigenen Buch', () => {
    expect(rebalanceJetzt(false, false)).toBe(true);
    expect(rebalanceJetzt(false, true)).toBe(true);
  });
  it('Konto mit Broker: nur bei offener Börse', () => {
    expect(rebalanceJetzt(true, true)).toBe(true);
    expect(rebalanceJetzt(true, false)).toBe(false);
  });
});

describe('rebalanceErledigt (gezählt werden VERSUCHTE Orders)', () => {
  it('nichts versucht (nichts zu tun oder alles vorab aussortiert) → erledigt', () => {
    expect(rebalanceErledigt(0, 0)).toBe(true);
  });
  it('mindestens eine Order ausgeführt → erledigt', () => {
    expect(rebalanceErledigt(8, 1)).toBe(true);
  });
  it('versucht, keine ausgeführt → NICHT erledigt, nächster Lauf erneut', () => {
    expect(rebalanceErledigt(8, 0)).toBe(false);
  });
});

describe('Quelltext-Wächter', () => {
  const quelle = lies('functions', 'src', 'scheduled', 'momentumRun.ts');

  it('beide Rebalancing-Schleifen fragen rebalanceJetzt UND rebalanceErledigt nach VERSUCHEN', () => {
    expect(quelle.match(/if \(!rebalanceJetzt\(hatBroker, aktienOffen\)\) \{/g)?.length).toBe(2);
    expect(quelle.match(/\} else if \(rebalanceErledigt\(versucht, ausgefuehrt\)\) \{/g)?.length).toBe(2);
    expect(quelle.match(/versucht \+= 1;/g)?.length).toBe(4);
  });

  it('Abendlauf 18:00 rankt; Morgenlauf 09:45 führt NUR die Broker-Konten aus', () => {
    expect(quelle).toContain("schedule: '0 18 * * *',");
    expect(quelle).toContain("schedule: '45 9 * * 1-5',");
    expect(quelle.match(/if \(nurBroker && !hatBroker\) continue;/g)?.length).toBe(2);
    expect(quelle).toContain('await rebalanceMomentumUsers(ziel, preise, now, true);');
    expect(quelle).toContain('await rebalanceCoreSleeve(ziel, preise, now, true);');
    const index = lies('functions', 'src', 'index.ts');
    expect(index).toContain('momentumAusfuehrung');
  });

  it('bei fehlenden Qualitätsdaten setzt JEDES Rebalancing aus — und das Ziel des Morgenlaufs bleibt stehen', () => {
    expect(quelle).toContain('const faellig = !aussetzen && istRebalanceFaellig(book.lastRebalance, now);');
    expect(quelle).toContain('const echte = aussetzen ? { konten: 0, orders: 0 } : await rebalanceMomentumUsers(ziel, preise, now);');
    expect(quelle).toContain('const sockel = aussetzen ? { konten: 0, orders: 0 } : await rebalanceCoreSleeve(ziel, preise, now);');
    expect(quelle).toContain('...(aussetzen ? {} : { zielGewichte: ziel, zielAt: now.toISOString() }),');
  });

  it('PDT bremst Momentum und Sockel NICHT (Wochen-Halten, kein Daytrade)', () => {
    expect(quelle.match(/const tore = toreRoh\.einstieg === 'pdt_schutz' \? \{ \.\.\.toreRoh, einstieg: null \} : toreRoh;/g)?.length).toBe(2);
  });

  it('Zeitplan jedes Scheduler-Jobs stimmt zwischen Code und Diagnose überein', () => {
    const diagnose = lies('scripts-ci', 'check-scheduler.mjs');
    const eintraege = [...diagnose.matchAll(/\{ fn: '(\w+)', service: '\w+', cron: '([^']+)'/g)];
    expect(eintraege.length).toBeGreaterThanOrEqual(8);
    const ordner = join(wurzel, 'functions', 'src', 'scheduled');
    const dateien = readdirSync(ordner).map((n) => readFileSync(join(ordner, n), 'utf8'));
    // Firebase schreibt „every N minutes" in die Cron-Form um — beide Formen gelten.
    const normal = (z: string): string =>
      z === 'every 5 minutes' ? '*/5 * * * *' : z === 'every 1 minutes' ? '* * * * *' : z;
    for (const [, fn, cron] of eintraege) {
      const datei = dateien.find((t) => t.includes(`export const ${fn} = onSchedule(`));
      expect(datei, `${fn}: keine Datei mit onSchedule`).toBeDefined();
      const ab = datei!.indexOf(`export const ${fn} = onSchedule(`);
      const zeitplan = /schedule: '([^']+)'/.exec(datei!.slice(ab))?.[1];
      expect(normal(zeitplan ?? ''), fn).toBe(cron);
    }
  });
});
