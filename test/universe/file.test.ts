/**
 * `var/universe.json` — die Auswahl, die zwischen zwei Schritten des
 * nächtlichen Laufs über die Platte reist.
 *
 * Sie wird beim Laden misstrauisch geprüft: Diese Datei entscheidet, WAS die
 * Plattform am nächsten Tag handelt. Käme sie kaputt oder untergeschoben
 * durch, stünde in `meta/engineConfig` etwas, das nie jemand gemessen hat.
 * Deshalb ist der Kandidatenpool aus der Config die Obergrenze des
 * Möglichen — und ein Fehler bricht ab, statt still auf die Config
 * zurückzufallen (nur eine FEHLENDE Datei ist der harmlose Normalfall des
 * ersten Laufs).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.ts';
import { UNIVERSE_REGELN } from '../../src/universe/select.ts';
import { ladeUniverseDatei, mitUniverse, schreibeUniverseDatei, UNIVERSE_FILE_VERSION } from '../../src/universe/file.ts';

const dir = mkdtempSync(join(tmpdir(), 'autotrd-universe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg = parseConfig({
  universe: { symbols: ['SPY', 'AAPL'], benchmark: 'SPY', candidates: ['SPY', 'AAPL', 'MSFT', 'NVDA'], maxSymbols: 3 },
});

let n = 0;
function datei(inhalt: unknown): string {
  const p = join(dir, `u${n++}.json`);
  writeFileSync(p, JSON.stringify(inhalt), 'utf8');
  return p;
}
const gueltig = (symbols: string[], updatedAt = Date.now()) => ({ version: UNIVERSE_FILE_VERSION, updatedAt, symbols, regeln: UNIVERSE_REGELN, zugang: [], abgang: [], bewertung: [] });

describe('ladeUniverseDatei', () => {
  it('fehlende Datei ⇒ null (erster Lauf, kein Fehler)', () => {
    expect(ladeUniverseDatei(join(dir, 'gibtsnicht.json'), cfg)).toBeNull();
  });

  it('gültige Auswahl kommt durch, in kanonischer Schreibweise', () => {
    expect(ladeUniverseDatei(datei(gueltig(['SPY', 'msft'])), cfg)).toEqual(['SPY', 'MSFT']);
  });

  it('Symbol außerhalb des Kandidatenpools ⇒ Abbruch', () => {
    expect(() => ladeUniverseDatei(datei(gueltig(['SPY', 'GME'])), cfg)).toThrow(/außerhalb des Kandidatenpools: GME/);
  });

  it('mehr Symbole als maxSymbols ⇒ Abbruch', () => {
    expect(() => ladeUniverseDatei(datei(gueltig(['SPY', 'AAPL', 'MSFT', 'NVDA'])), cfg)).toThrow(/4 Symbole, erlaubt sind 3/);
  });

  it('ohne Benchmark ⇒ Abbruch, sonst greift kein Marktfilter', () => {
    expect(() => ladeUniverseDatei(datei(gueltig(['AAPL', 'MSFT'])), cfg)).toThrow(/Benchmark SPY/);
  });

  it('eine alte Auswahl ⇒ Abbruch: sie beschreibt nicht mehr, was heute liquide ist', () => {
    const alt = datei(gueltig(['SPY', 'AAPL'], Date.now() - 20 * 86_400_000));
    expect(() => ladeUniverseDatei(alt, cfg)).toThrow(/Tage alt/);
    // Ohne Datum ebenfalls — geraten wird nicht.
    expect(() => ladeUniverseDatei(datei({ ...gueltig(['SPY']), updatedAt: 'gestern' }), cfg)).toThrow(/undatiert/);
  });

  it('doppelte Symbole ⇒ Abbruch', () => {
    expect(() => ladeUniverseDatei(datei(gueltig(['SPY', 'AAPL', 'aapl'])), cfg)).toThrow(/doppelte Symbole/);
  });

  it('falsche Version ⇒ Abbruch statt stiller Fehldeutung', () => {
    expect(() => ladeUniverseDatei(datei({ ...gueltig(['SPY']), version: 99 }), cfg)).toThrow(/Version 99/);
  });

  it('leere oder unsinnige Liste ⇒ Abbruch', () => {
    expect(() => ladeUniverseDatei(datei(gueltig([])), cfg)).toThrow(/keine gültige Symbolliste/);
    expect(() => ladeUniverseDatei(datei({ ...gueltig(['SPY']), symbols: [1, 2] }), cfg)).toThrow(/keine gültige Symbolliste/);
  });

  it('ohne Kandidatenpool gilt das Config-Universum als Obergrenze', () => {
    const ohnePool = parseConfig({ universe: { symbols: ['SPY', 'AAPL'], benchmark: 'SPY' } });
    expect(ladeUniverseDatei(datei(gueltig(['SPY', 'AAPL'])), ohnePool)).toEqual(['SPY', 'AAPL']);
    expect(() => ladeUniverseDatei(datei(gueltig(['SPY', 'MSFT'])), ohnePool)).toThrow(/außerhalb des Kandidatenpools: MSFT/);
  });
});

describe('schreibeUniverseDatei', () => {
  it('schreibt, was danach wieder geladen werden kann', () => {
    const p = join(dir, 'roundtrip.json');
    const auswahl = { symbols: ['SPY', 'AAPL'], bewertung: [], zugang: ['AAPL'], abgang: [] };
    const doc = schreibeUniverseDatei(p, auswahl, UNIVERSE_REGELN, 'SPY', Date.now());
    expect(doc.version).toBe(UNIVERSE_FILE_VERSION);
    expect(doc.benchmark).toBe('SPY');
    expect(ladeUniverseDatei(p, cfg)).toEqual(['SPY', 'AAPL']);
  });
});

describe('mitUniverse', () => {
  it('ersetzt nur die Symbolliste, sonst nichts', () => {
    const neu = mitUniverse(cfg, ['MSFT', 'SPY']);
    expect(neu.universe.symbols).toEqual(['MSFT', 'SPY']);
    expect(neu.universe.benchmark).toBe('SPY');
    expect(neu.universe.candidates).toEqual(cfg.universe.candidates);
    expect(neu.risk).toBe(cfg.risk);
    expect(cfg.universe.symbols, 'die Ausgangs-Config bleibt unangetastet').toEqual(['SPY', 'AAPL']);
  });
});
