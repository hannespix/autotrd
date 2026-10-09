/**
 * Task 22 (KI-News tiefer integrieren), Paket 1: Die Erklärung der KI sagt,
 * was der Code tut (shared/kiAktion.ts), und die Trefferbilanz kennzeichnet
 * eine zu kleine Stichprobe ausdrücklich.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KI_MAX_ALTER_MIN, KI_MIN_FAELLE } from '@autotrd/shared';
import { DE, EN } from '../src/i18n.js';
import { INFO_DE, INFO_EN } from '../src/infotips.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('KI-Erklärung entspricht kiAktion.ts', () => {
  it('eine gute Nachricht KANN allein kaufen — in Probegröße, ohne Hebel', () => {
    const de = INFO_DE['kiNachrichten']?.d ?? '';
    const en = INFO_EN['kiNachrichten']?.d ?? '';
    expect(de).not.toContain('nie allein');
    expect(en).not.toContain('never alone');
    expect(de).toContain('kann einen Kauf also allein auslösen, dann aber nur in halber Größe (Probegröße) und ohne geliehenes Geld');
    expect(en).toContain('can trigger a buy on its own, but then only at half size (probe size) and without borrowed money');
  });

  it('Quelle und Alter der Meldungen stimmen (Alpaca/Benzinga, nicht die Yahoo-/Google-Zeilen)', () => {
    expect(KI_MAX_ALTER_MIN).toBe(45);
    expect(INFO_DE['kiNachrichten']?.d).toContain('aus dem Nachrichtenstrom von Alpaca, meist Benzinga; höchstens 45 Minuten alt');
    expect(INFO_EN['kiNachrichten']?.d).toContain('from Alpaca’s news stream, mostly Benzinga; at most 45 minutes old');
  });

  it('eine schlechte Nachricht sperrt neue Käufe (kiVeto)', () => {
    expect(INFO_DE['kiNachrichten']?.d).toContain('Eine schlechte Nachricht sperrt neue Käufe des Werts');
    expect(INFO_EN['kiNachrichten']?.d).toContain('Bad news blocks new buys of the symbol');
  });

  it('Trefferbilanz: unter KI_MIN_FAELLE grau und „noch kein Urteil"', () => {
    expect(KI_MIN_FAELLE).toBe(40);
    expect(dashboard).toContain('const reif = n >= KI_MIN_FAELLE;');
    expect(dashboard).toContain("const zusatz = reif ? '' : ` · ${t('ew.kiBilanzWenig').replace('{0}', String(KI_MIN_FAELLE))}`;");
    expect(DE['ew.kiBilanzWenig']).toContain('noch zu wenig Fälle');
    expect(EN['ew.kiBilanzWenig']).toContain('too few cases');
    expect(DE['ew.kiBilanzTitel']).toContain('Raten träfe ungefähr jedes zweite Mal (50 %)');
  });
});
