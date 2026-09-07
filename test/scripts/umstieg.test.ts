/**
 * Umstiegs-Planung: Wer wird ausgeschaltet, wer bleibt, was wird archiviert.
 * Die Regeln stehen in scripts/lib/umstieg.mjs — hier der Fall, in dem sie
 * Geld kosten würden: ein Nutzer, der im Altsystem „an" hatte, darf nach dem
 * Umstieg NICHT ungefragt mit dem Champion handeln.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs ohne Typen
import { planeUmstieg, userSichtVon } from '../../scripts/lib/umstieg.mjs';
// @ts-expect-error — .mjs ohne Typen
import { engineConfigDocFrom } from '../../scripts/lib/engineConfig.mjs';
import { parseConfig } from '../../src/core/config.ts';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

describe('Umstieg: Planung', () => {
  it('Engine aus für alle außer Admins und Behalten-Liste; alte Positions-Spiegel werden archiviert', () => {
    const users = [
      userSichtVon('owner', { admin: true, settings: { strategy: { engine: { running: true } } } }, ['AAPL']),
      userSichtVon('alice', { settings: { strategy: { engine: { running: true } } } }, ['TSLA', 'MSFT']),
      userSichtVon('bob', { settings: { strategy: { engine: { running: false } } } }, []),
      userSichtVon('carol', { settings: { strategy: { engine: { running: true } } } }, []),
      userSichtVon('leer', {}, []),
    ];
    const plan = planeUmstieg(users, { behalten: ['carol'] });
    expect(plan.ausschalten).toEqual(['alice']);
    expect(plan.behalten).toEqual(['owner', 'carol']);
    expect(plan.archivieren).toEqual([
      { uid: 'owner', docs: ['AAPL'] },
      { uid: 'alice', docs: ['TSLA', 'MSFT'] },
    ]);
  });

  it('kaputte Nutzer-Docs (settings kein Objekt) gelten als „aus" und ohne Admin', () => {
    const s = userSichtVon('x', { settings: 'kaputt', admin: 'ja' }, []);
    expect(s).toEqual({ uid: 'x', admin: false, running: false, positions: [] });
  });
});

describe('Umstieg: meta/engineConfig', () => {
  it('trägt broker.feed und universe, aber keine barGraceSec (Takt-Karenz bleibt dem Takt)', () => {
    const cfg = parseConfig(parseYaml(readFileSync('config/platform.yaml', 'utf8')));
    const doc = engineConfigDocFrom(cfg);
    expect(doc.broker).toEqual({ mode: 'paper', feed: 'iex' });
    expect(doc.universe.symbols.length).toBeGreaterThan(0);
    expect(doc.engine.barGraceSec).toBeUndefined();
    expect(doc.riskDefaults.maxDailyLossPct).toBe(2);
  });
});
