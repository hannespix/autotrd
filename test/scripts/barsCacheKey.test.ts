/**
 * Der Schlüssel des Bars-Caches (scripts/bars-cache-key.mjs).
 *
 * ── Warum dieser Wächter existiert ────────────────────────────────────────
 *
 * Am 13.09.2026 hashten `probe.yml` und `optimize.yml` die GANZE Config-Datei
 * als Cache-Schlüssel. Zwei Configs, die sich nur in `risk.tiers`
 * unterschieden, bekamen damit zwei getrennte Bars-Caches; der Backfill
 * füllte sie verschieden, und zwei Läufe, die „eine Änderung" messen
 * sollten, sahen verschiedene Daten (#56: ab 2021-03-22, #59: ab
 * 2021-03-24). Der frühere Datenbeginn gibt dem frühesten Fold zwei Bars
 * mehr Warmup — die IS-Suche wählte andere Parameter, und über die
 * Hysterese des Punkt-in-Zeit-Korbs wanderte das bis in Fold 10. Genau das
 * war die „Alpha-Verschiebung", die ich zuerst der Stufen-Bremse
 * zugeschrieben hatte.
 *
 * Die Regel, die dieser Test festnagelt: Der Schlüssel nennt GENAU das, was
 * die Bars-Wurzel auf der Platte bestimmt (`barStoreRoot`) — nicht mehr
 * (sonst trennt er Läufe, die dieselben Daten sehen sollten) und nicht
 * weniger (sonst liest ein Lauf Bars, die nicht seine sind).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/core/config.ts';
import { barStoreRoot, barsCacheKey } from '../../src/data/store.ts';

const dir = new URL('../../config/', import.meta.url);
const repo = new URL('../../', import.meta.url);
const laden = (name: string) => parseConfig(parseYaml(readFileSync(new URL(name, dir), 'utf8')));
const key = (name: string) => barsCacheKey(laden(name));

describe('Bars-Cache-Schlüssel', () => {
  it('trennt genau dann, wenn auch die Wurzel auf der Platte trennt', () => {
    // Der eigentliche Vertrag: gleicher Schlüssel ⇔ gleiche Wurzel. Ändert
    // jemand `barStoreRoot`, ohne den Schlüssel mitzuziehen, fällt es hier auf.
    const configs = ['platform.yaml', 'basis-1440.yaml', 'basis-1440-v3.yaml', 'basis-1440-v4.yaml', 'basis-1440-v5.yaml', 'crypto-1440.yaml', 'equity-1440.yaml'];
    const paare = configs.map((n) => {
      const c = laden(n);
      return { n, schluessel: barsCacheKey(c), wurzel: barStoreRoot('bars', c.universe.assetClass, c.broker.feed, c.broker.adjustment) };
    });
    for (const a of paare) {
      for (const b of paare) {
        expect(a.schluessel === b.schluessel, `${a.n} vs ${b.n}: Schlüssel ${a.schluessel}/${b.schluessel}, Wurzel ${a.wurzel}/${b.wurzel}`).toBe(a.wurzel === b.wurzel);
      }
    }
  });

  /*
   * Der scharfe Wächter. Die beiden Tests darüber und darunter prüfen nur
   * Configs, die zufällig im Repo liegen — und die haben, was den Schlüssel
   * angeht, viele Felder gemeinsam. Ein erster Entwurf dieses Wächters ließ
   * deshalb genau den alten Fehler durch: `risk.maxDrawdownPct` mit in den
   * Schlüssel zu nehmen, fiel nicht auf, weil V3/V4/V5 dort alle 10 stehen
   * haben.
   *
   * Also die Äquivalenzklasse direkt prüfen: ALLES außer den drei Größen der
   * Wurzel darf den Schlüssel nicht bewegen — und jede der drei muss ihn
   * bewegen.
   */
  it('hängt an genau drei Feldern — nichts anderes darf ihn bewegen', () => {
    const basis = {
      universe: { symbols: ['SPY', 'QQQ'], assetClass: 'us_equity' as const },
      broker: { mode: 'paper' as const, feed: 'iex' as const, adjustment: 'all' as const },
      timeframe: 1440,
    };
    const erwartet = barsCacheKey(parseConfig(basis));

    // Jede dieser Abwandlungen misst etwas anderes — aber aus DENSELBEN Bars.
    const egal: Record<string, Record<string, unknown>> = {
      'anderes Risiko': { risk: { maxDrawdownPct: 42, maxDailyLossPct: 7, riskPerTradePct: 3, maxPositionPct: 33, maxOpenPositions: 9 } },
      'Stufen-Bremsen (der Fall #56 vs #59)': { risk: { tiers: { alpha: { maxDailyLossPct: null, maxDrawdownPct: null }, basis: { maxDailyLossPct: 5, maxDrawdownPct: 30 } } } },
      'anderer Zeitrahmen': { timeframe: 60 },
      'andere Symbole': { universe: { symbols: ['AAPL', 'MSFT', 'NVDA', 'TLT'] } },
      'andere Sitzung': { session: { noEntryFirstMin: 30, flattenBeforeCloseMin: 20 } },
      'andere Kosten': { costs: { slippageBps: 99, spreadBps: 42 } },
      'anderer Optimierer': { optimizer: { seed: 4711, samples: 7, isDays: 200, oosDays: 30 } },
      'anderes Zuhause': { paths: { home: './woandershin' } },
      'anderer Broker-Modus': { broker: { mode: 'live' as const } },
    };
    for (const [was, patch] of Object.entries(egal)) {
      const cfg = parseConfig({
        ...basis,
        ...patch,
        universe: { ...basis.universe, ...(patch.universe as object | undefined) },
        broker: { ...basis.broker, ...(patch.broker as object | undefined) },
      });
      expect(barsCacheKey(cfg), `${was} darf den Bars-Cache nicht spalten`).toBe(erwartet);
    }

    // Und umgekehrt: Die drei, die die Wurzel bestimmen, MÜSSEN ihn spalten.
    const mussSpalten: Record<string, Record<string, unknown>> = {
      assetClass: { universe: { ...basis.universe, assetClass: 'crypto' as const, symbols: ['BTC/USD'] } },
      feed: { broker: { ...basis.broker, feed: 'sip' as const } },
      adjustment: { broker: { ...basis.broker, adjustment: 'raw' as const } },
    };
    for (const [was, patch] of Object.entries(mussSpalten)) {
      expect(barsCacheKey(parseConfig({ ...basis, ...patch })), `${was} bestimmt die Wurzel und MUSS den Cache trennen`).not.toBe(erwartet);
    }
  });

  it('teilt den Cache zwischen den drei Basis-Proben — sie sollten dieselben Bars sehen', () => {
    // V3 → V4 → V5 unterscheiden sich in `risk.tiers` (und `paths.home`).
    // Genau dieser Vergleich ist an getrennten Caches gescheitert (#56/#59).
    expect(key('basis-1440-v3.yaml')).toBe(key('basis-1440-v4.yaml'));
    expect(key('basis-1440-v4.yaml')).toBe(key('basis-1440-v5.yaml'));
  });

  it('trennt Krypto von Aktien und bereinigte von rohen Bars', () => {
    expect(key('crypto-1440.yaml')).not.toBe(key('equity-1440.yaml'));
    // Seit dem 15.09.2026 rechnet platform.yaml bereinigt („all") — ohne die
    // Ausschüttung im Kurs trüge BIL den Zins nicht, und Parken wie
    // Zinsmaßstab wären ungefähr null (src/risk/parken.ts). Roh geblieben ist
    // basis-1440.yaml, die erste Basis-Probe von vor diesem Befund.
    expect(key('platform.yaml')).not.toBe(key('basis-1440.yaml'));
  });

  it('das Kommando der Workflows sagt dasselbe wie die Funktion', () => {
    // Die Workflows rufen nicht die Funktion auf, sondern das Skript. Wenn
    // die beiden auseinanderlaufen, misst der Cache etwas anderes als der
    // Wächter darüber prüft — also einmal wirklich starten.
    const skript = fileURLToPath(new URL('../../scripts/bars-cache-key.mjs', import.meta.url));
    for (const name of ['platform.yaml', 'basis-1440-v4.yaml', 'crypto-1440.yaml']) {
      const pfad = fileURLToPath(new URL(name, dir));
      expect(execFileSync('node', [skript, pfad], { encoding: 'utf8' }).trim(), `${name}: Skript weicht von barsCacheKey ab`).toBe(key(name));
    }
  });

  it('wird von beiden Workflows wirklich benutzt — und kein Config-Hash mehr', () => {
    for (const wf of ['.github/workflows/probe.yml', '.github/workflows/optimize.yml']) {
      const text = readFileSync(new URL(wf, repo), 'utf8');
      expect(text, `${wf} ruft den Schlüssel nicht auf`).toContain('scripts/bars-cache-key.mjs');
      // Der Rückfall in den alten Fehler: hashFiles über eine Config-Datei.
      const hashZeilen = text.split('\n').filter((z) => z.includes('hashFiles') && z.includes('config'));
      expect(hashZeilen, `${wf} hasht wieder eine Config-Datei: ${hashZeilen.join(' | ')}`).toEqual([]);
    }
  });
});
