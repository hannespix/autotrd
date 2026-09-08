/**
 * Erkundungs-Configs dürfen die Latte nicht senken.
 *
 * Eine Probe ist erst dann eine Messung, wenn sie mit denselben Toren
 * gefahren wird wie die Produktion. Sonst passiert genau das, wogegen der
 * ganze Neubau gebaut ist: Man dreht so lange an den Gates, bis ein Ergebnis
 * herauskommt, und hält das Ergebnis anschließend für eine Kante
 * (CLAUDE.md §0.9 — „wir sollten nicht handeln" ist ein zulässiges Ergebnis).
 *
 * Erlaubt ist, das DATENFENSTER zu ändern (Zeitrahmen, Historie, Assetklasse,
 * Universum) — das misst etwas anderes. Verboten ist, die BEWERTUNG zu ändern.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/core/config.ts';

const dir = new URL('../../config/', import.meta.url);
const laden = (name: string) => parseConfig(parseYaml(readFileSync(new URL(name, dir), 'utf8')));
const plattform = laden('platform.yaml');

/** Alles, was über BESTEHEN entscheidet — nicht, was gemessen wird. */
const TORE = [
  'minOosTrades',
  'minFoldPositiveShare',
  'minPsrOos',
  'stressCostMultiplier',
  'maxFoldNetShare',
  'dsrIsGate',
  'promotionMargin',
  'objective',
] as const;

const proben = readdirSync(new URL('.', dir)).filter((f) => f.endsWith('.yaml') && f !== 'platform.yaml' && f !== 'config.example.yaml');

describe('Erkundungs-Configs', () => {
  it('es gibt welche (sonst prüft dieser Test nichts)', () => {
    expect(proben.length).toBeGreaterThan(0);
  });

  for (const datei of proben) {
    describe(datei, () => {
      const cfg = laden(datei);

      it('fährt dieselben Tore wie die Plattform', () => {
        for (const tor of TORE) {
          expect(cfg.optimizer[tor], `${datei}: ${tor} weicht von platform.yaml ab — das ist keine Messung mehr`).toEqual(plattform.optimizer[tor]);
        }
      });

      it('rechnet mit denselben Kosten', () => {
        expect(cfg.costs, `${datei}: andere Kosten als die Produktion`).toEqual(plattform.costs);
      });

      it('rechnet mit demselben Risiko', () => {
        expect(cfg.risk, `${datei}: anderes Risiko als die Produktion`).toEqual(plattform.risk);
      });

      it('schreibt in einen eigenen State-Ordner, nicht in den der Produktion', () => {
        // `paths.home` der Plattform ist ./var — eine Probe darf champion.json
        // und den Bars-Cache des Produktivlaufs nicht überschreiben.
        expect(cfg.paths.home).not.toBe(plattform.paths.home);
      });

      it('handelt nicht ohne Champion', () => {
        expect(cfg.strategy.allowWithoutChampion).toBe(false);
      });
    });
  }
});
