/**
 * Die Config, die Nutzer tatsächlich handeln.
 *
 * Der Fehler, den dieser Test verhindert: ein großes Universum OHNE gepoolte
 * Bewertung. Je Symbol fragt der Optimierer „hat die Strategie eine Kante auf
 * TSLA?" — und „bestes Symbol aus dreißig" ist selbst eine Auswahl, die der
 * Deflated Sharpe nicht bestraft. Dreißig Symbole einzeln bewertet wären
 * also dreißig Lotterien statt zehn: schlechter, nicht besser.
 *
 * Wie schnell das schiefgeht, steht im Lauf vom 07.09.2026: TSLA bestand je
 * Symbol alle acht Gates (103 OOS-Trades, +958,46 $) — dieselbe Strategie
 * über den ganzen Korb machte −1 672,49 $ auf 344 Trades.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/core/config.ts';
import { AUTO_SYMBOLS_MAX } from '../../shared/src/autoSettings.ts';

/** Über dieser Zahl ist die Symbolwahl selbst ein Freiheitsgrad, der gezählt werden muss. */
const OHNE_POOLING_HOECHSTENS = 10;

const cfg = parseConfig(parseYaml(readFileSync(new URL('../../config/platform.yaml', import.meta.url), 'utf8')));

describe('config/platform.yaml', () => {
  it('bewertet ein großes Universum gepoolt — sonst sind es viele Lotterien statt einer Messung', () => {
    if (cfg.universe.symbols.length > OHNE_POOLING_HOECHSTENS) {
      expect(
        cfg.optimizer.pooled,
        `${cfg.universe.symbols.length} Symbole ohne optimizer.pooled: je Symbol bewertet ist „bestes Symbol aus ` +
          `${cfg.universe.symbols.length}" ein ungezählter Freiheitsgrad. Entweder pooled: true, oder höchstens ` +
          `${OHNE_POOLING_HOECHSTENS} Symbole.`,
      ).toBe(true);
    }
  });

  it('bleibt im Rahmen, den Alpaca und die Nutzer-Einstellungen hergeben', () => {
    // IEX-Basis erlaubt 30 Stream-Abonnements; der Benchmark zählt mit.
    const abos = new Set(cfg.universe.symbols);
    if (cfg.universe.benchmark) abos.add(cfg.universe.benchmark);
    expect(abos.size, 'über 30 antwortet Alpaca mit 405 „symbol limit exceeded"').toBeLessThanOrEqual(30);
    // Dasselbe gilt für die nächtliche Auswahl — sie ersetzt diese Liste.
    expect(cfg.universe.maxSymbols, 'die Auswahl darf das Stream-Limit nicht sprengen').toBeLessThanOrEqual(30);
    // Ein Nutzer muss das ganze Universum auswählen dürfen.
    expect(cfg.universe.symbols.length).toBeLessThanOrEqual(AUTO_SYMBOLS_MAX);
    expect(cfg.universe.maxSymbols).toBeLessThanOrEqual(AUTO_SYMBOLS_MAX);
  });

  it('handelt keine Symbole, für die der Benchmark fehlt', () => {
    expect(cfg.universe.benchmark, 'ohne Benchmark greift kein Marktfilter').toBeTruthy();
    expect(cfg.universe.symbols).toContain(cfg.universe.benchmark!);
    // Auch nach einer Auswahl muss der Benchmark wählbar bleiben.
    if (cfg.universe.candidates) expect(cfg.universe.candidates).toContain(cfg.universe.benchmark!);
  });

  it('der Kandidatenpool hat genug zu wählen — sonst ist die nächtliche Auswahl Theater', () => {
    const pool = cfg.universe.candidates;
    if (!pool) return;
    expect(pool.length, `${pool.length} Kandidaten für ${cfg.universe.maxSymbols} Plätze: Da wird nichts ausgewählt`).toBeGreaterThanOrEqual(
      cfg.universe.maxSymbols * 2,
    );
    // Das aktuelle Universum muss im Pool sein, sonst verlöre die Auswahl Symbole,
    // die die Config gerade handelt (der Config-Transform stellt das sicher).
    for (const s of cfg.universe.symbols) expect(pool).toContain(s);
  });

  it('nimmt keine gehebelten oder inversen ETFs in den Pool — 3×-Produkte sprengen das ATR-Sizing', () => {
    // Sie stehen ganz oben in jeder Umsatzliste und würden die Auswahl nach
    // Liquidität sofort dominieren. Genau deshalb ist die Sperre hier und nicht
    // im Kopf dessen, der die Liste pflegt.
    const verboten = [
      'TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SPXL', 'SPXS', 'UDOW', 'SDOW', 'TNA', 'TZA',
      'SOXL', 'SOXS', 'LABU', 'LABD', 'NUGT', 'DUST', 'JNUG', 'JDST', 'YINN', 'YANG',
      'FAS', 'FAZ', 'UVXY', 'SVXY', 'VXX', 'VIXY', 'BOIL', 'KOLD', 'UCO', 'SCO',
      'NVDL', 'TSLL', 'TSLQ', 'CONL', 'AMDL', 'MSTX', 'MSTU',
    ];
    const pool = new Set(cfg.universe.candidates ?? cfg.universe.symbols);
    const treffer = verboten.filter((s) => pool.has(s));
    expect(treffer, `gehebelt/invers im Pool: ${treffer.join(', ')}`).toEqual([]);
  });
});
