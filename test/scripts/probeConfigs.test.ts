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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/core/config.ts';

const dir = new URL('../../config/', import.meta.url);
const repo = new URL('../../', import.meta.url);
const roh = (name: string): Record<string, unknown> => parseYaml(readFileSync(new URL(name, dir), 'utf8')) as Record<string, unknown>;
const laden = (name: string) => parseConfig(roh(name));
const plattform = laden('platform.yaml');

/**
 * Eine Probe darf vom Risiko der Plattform NUR abweichen, wenn sie das vor
 * dem Lauf in der Wissensbibliothek festgeschrieben hat (`vorregistrierung:`
 * zeigt auf docs/wissen/vorregistrierung/…, und das Dokument nennt die
 * Config). Stille Abweichung bleibt „keine Messung mehr"; vorregistrierte
 * Abweichung ist der Zweck der Vorregistrierung (docs/wissen/README.md).
 */
function vorregistrierung(name: string): string | null {
  const v = roh(name).vorregistrierung;
  if (typeof v !== 'string') return null;
  const pfad = new URL(v, repo);
  if (!v.startsWith('docs/wissen/vorregistrierung/') || !existsSync(pfad)) {
    throw new Error(`${name}: vorregistrierung zeigt auf ${v} — das Dokument fehlt oder liegt nicht unter docs/wissen/vorregistrierung/`);
  }
  const text = readFileSync(pfad, 'utf8');
  if (!text.includes(`config/${name}`)) throw new Error(`${name}: die Vorregistrierung ${v} nennt config/${name} nicht`);
  return v;
}

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
  // Die zweite Latte (Basis-Allokation): auch ihre Schwellen entscheiden über Bestehen.
  'basis',
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

      it('rechnet mit demselben Risiko — oder hat die Abweichung vorregistriert', () => {
        const v = vorregistrierung(datei);
        if (v === null) {
          expect(cfg.risk, `${datei}: anderes Risiko als die Produktion`).toEqual(plattform.risk);
        } else {
          // Vorregistriert: Sizing darf abweichen, der Mess-Schalter für Shorts nicht.
          expect(cfg.risk.allowShort, `${datei}: allowShort weicht trotz Vorregistrierung ab`).toBe(plattform.risk.allowShort);
        }
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
