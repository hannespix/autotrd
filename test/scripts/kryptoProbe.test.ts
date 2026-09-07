/**
 * Krypto-Probe: Erkundung, die nichts scharf schaltet.
 *
 * Zwei Dinge dürfen hier nie passieren, und beide würden Geld kosten:
 *
 * 1. Der Probe-Workflow veröffentlicht nach Firestore. Ein Krypto-Champion
 *    in `meta/champion` stellt beim nächsten Takt die Engine JEDES
 *    eingeschalteten Nutzers auf Krypto um — eine Assetklasse, die im
 *    Vorgängersystem −1 133 $ gekostet hat.
 * 2. Jemand senkt die Gates, damit Krypto „endlich etwas findet". Die
 *    Kosten sind bei Krypto rund sechsmal so hoch (0,25 % Taker je Seite);
 *    genau deshalb muss die Latte dieselbe bleiben. Wer sie senkt, misst
 *    nichts mehr (CLAUDE.md §0.9).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '../../src/core/config.ts';

const lies = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const config = (p: string) => parseConfig(parseYaml(lies(p)));

const KRYPTO = ['config/crypto-60.yaml', 'config/crypto-1440.yaml'];
const WORKFLOW = '.github/workflows/krypto-probe.yml';

describe('Krypto-Configs', () => {
  it.each(KRYPTO)('%s ist eine gültige Krypto-Config ohne Shorts', (pfad) => {
    const c = config(pfad);
    expect(c.universe.assetClass).toBe('crypto');
    // Alpaca bietet Krypto nur als Spot; die Engine blockt Shorts ohnehin.
    expect(c.risk.allowShort).toBe(false);
    // orb_breakout braucht eine Eröffnungsspanne — bei 24/7 gibt es keine.
    expect(c.optimizer.strategies).not.toContain('orb_breakout');
  });

  it.each(KRYPTO)('%s lockert KEIN Gate gegenüber der Plattform-Config', (pfad) => {
    const p = config('config/platform.yaml').optimizer;
    const k = config(pfad).optimizer;
    // Jede dieser Zahlen ist eine Hürde. Sie darf für Krypto strenger sein,
    // niemals lockerer — sonst vergleicht man Äpfel mit Wunschdenken.
    expect(k.minOosTrades).toBeGreaterThanOrEqual(p.minOosTrades);
    expect(k.minFoldPositiveShare).toBeGreaterThanOrEqual(p.minFoldPositiveShare);
    expect(k.minPsrOos).toBeGreaterThanOrEqual(p.minPsrOos);
    expect(k.stressCostMultiplier).toBeGreaterThanOrEqual(p.stressCostMultiplier);
    expect(k.promotionMargin).toBeGreaterThanOrEqual(p.promotionMargin);
    expect(k.samples).toBeGreaterThanOrEqual(p.samples);
    expect(k.objective).toBe(p.objective);
  });

  it.each(KRYPTO)('%s bepreist Krypto mindestens so teuer wie die Plattform-Config', (pfad) => {
    expect(config(pfad).costs.cryptoTakerPct).toBeGreaterThanOrEqual(config('config/platform.yaml').costs.cryptoTakerPct);
  });

  it.each(KRYPTO)('%s hat genug OOS-Bars, damit minOosTrades ohne Latte-Senken erreichbar ist', (pfad) => {
    const c = config(pfad);
    const o = c.optimizer;
    const folds = Math.floor((o.lookbackDays - o.holdoutDays - o.isDays) / o.stepDays);
    expect(folds, 'zu wenige Folds für eine belastbare OOS-Kette').toBeGreaterThanOrEqual(5);
    const barsProTag = 1440 / c.timeframe; // Krypto handelt rund um die Uhr
    const oosBars = folds * o.oosDays * barsProTag;
    // Ein Trade je höchstens 30 Bars — darüber wird das Gate zur Zufallshürde.
    expect(oosBars / o.minOosTrades).toBeGreaterThanOrEqual(5);
  });
});

describe('Krypto-Probe-Workflow', () => {
  const wf = (): string => lies(WORKFLOW);

  it('fasst Firestore nicht an — weder Service-Account noch Veröffentlichung', () => {
    const text = wf();
    for (const verboten of [
      'FIREBASE_SERVICE_ACCOUNT',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'publish-champion',
      'sync-engine-config',
      'firebase-tools',
    ]) {
      expect(text, `${WORKFLOW} darf ${verboten} nicht enthalten`).not.toContain(verboten);
    }
  });

  it('läuft nur von Hand — kein Zeitplan, kein Push-Auslöser', () => {
    const d = parseYaml(wf()) as { on?: Record<string, unknown>; true?: Record<string, unknown> };
    // YAML 1.1 liest das nackte `on` als Boolean true — beide Formen prüfen.
    const ausloeser = d.on ?? d.true ?? {};
    expect(Object.keys(ausloeser)).toEqual(['workflow_dispatch']);
  });

  it('arbeitet in einem eigenen Ablageort, damit der Aktien-Lauf unberührt bleibt', () => {
    const text = wf();
    expect(text).toContain('--home var-krypto');
    expect(text).not.toContain('--home var ');
  });

  it('bietet nur die Krypto-Configs zur Auswahl an', () => {
    const d = parseYaml(wf()) as Record<string, never>;
    const ausloeser = (d as { on?: unknown; true?: unknown }).on ?? (d as { true?: unknown }).true;
    const optionen = (ausloeser as { workflow_dispatch: { inputs: { config: { options: string[] } } } })
      .workflow_dispatch.inputs.config.options;
    expect([...optionen].sort()).toEqual([...KRYPTO].sort());
  });
});
