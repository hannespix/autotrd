/**
 * Schatten-Kosten sind die ECHTEN Kosten (Owner 20.08.: „Krypto-Strategie
 * ändern, damit positive Trades möglich werden").
 *
 * Der Befund: Für die Schatten-Messung existiert seit dem 17.08. eigens
 * `roundtripFeeRateForClass` (Maker-Einstieg + Taker-Exit — für Krypto
 * 0,40 %), aber der Tag-Rückblick rechnete weiter `feeRateForClass * 2`
 * (0,50 %). Jeder Krypto-Schatten-Trade wurde dort mit 10 bp Kosten
 * bestraft, die es seit dem Maker-Umbau nicht mehr gibt — und der
 * Regler-Rückweg („Klasse schaltet sich selbst wieder ein, wenn die Kante
 * positiv ist") sähe die Kante schlechter als sie ist. Exakt der Fehler,
 * den der Kommentar an roundtripFeeRateForClass vorhergesagt hat: „ein *2
 * an fünf Stellen wäre fünf Gelegenheiten, die Korrektur an vier davon zu
 * vergessen."
 *
 * WICHTIG — die eine erlaubte Ausnahme: Die 5-Minuten-Schatten-Reihe in
 * scanMarket bleibt BEWUSST bei 2× Taker. Sie ist ein additives Aggregat
 * mit >1 000 Alt-Signalen, die mit 2× Taker gerechnet wurden — ein
 * Satzwechsel mittendrin mischte zwei Gebührenordnungen in eine Zahl
 * (Projektentscheidung 17.08., gepinnt in halteSchattenAnschluss.test.ts).
 * Der Tag-Rückblick DARF wechseln, weil seine Versions-Mechanik
 * (TAG_RUECKBLICK_V) das Aggregat beim Sprung leert statt fortzuschreiben.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  entryFeeRateForClass,
  feeRateForClass,
  roundtripFeeRateForClass,
} from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));

function alleQuellen(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...alleQuellen(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('die pure Rechnung — Maker rein, Taker raus', () => {
  it('Krypto-Roundtrip ist Maker + Taker, NICHT 2× Taker', () => {
    const roundtrip = roundtripFeeRateForClass('crypto');
    expect(roundtrip).toBe(entryFeeRateForClass('crypto') + feeRateForClass('crypto'));
    expect(roundtrip).toBeLessThan(feeRateForClass('crypto') * 2);
  });

  it('für Klassen ohne Maker-Satz bleibt der Roundtrip symmetrisch', () => {
    // Aktien-Einstiege laufen (noch) als Market — dort wäre ein billigerer
    // Schatten eine Schönrechnung, keine Korrektur.
    expect(roundtripFeeRateForClass('stocks_us')).toBe(feeRateForClass('stocks_us') * 2);
  });
});

describe('der Wächter — kein stilles feeRate*2 mehr in Messpfaden', () => {
  it('feeRateForClass * 2 existiert nur an der EINEN dokumentierten Stelle', () => {
    /* Die Ausnahme ist eng: genau scanMarket (5-Minuten-Reihe, Alt-Signale,
     * s. Kopf-Kommentar). Taucht die Rechnung in irgendeiner anderen Datei
     * auf, ist das ein neuer Messfehler — roundtripFeeRateForClass nehmen
     * oder hier mit Begründung eine Ausnahme eintragen. */
    const verstoesse: string[] = [];
    for (const p of alleQuellen(join(hier, '../src'))) {
      const code = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // Eine Ebene verschachtelter Klammern gehört ins Muster: Die echte
      // Stelle heißt feeRateForClass(classify(symbol)) * 2 — ein naives
      // [^)]* bricht an der inneren Klammer ab und der Wächter wäre blind
      // für genau den Fall, für den er gebaut wurde.
      if (/feeRateForClass\((?:[^()]|\([^()]*\))*\)\s*\*\s*2/.test(code)) {
        verstoesse.push(p.slice(p.indexOf('src')));
      }
    }
    expect(verstoesse).toEqual(['src/scheduled/scanMarket.ts']);
  });

  it('die scanMarket-Ausnahme trägt ihre Begründung im Code, nicht nur hier', () => {
    // Fällt der Kommentar der Zeile weg, liest der nächste Bearbeiter ein
    // nacktes *2 neben einem Import von roundtripFeeRateForClass — und
    // „korrigiert" es, wie am 20.08. tatsächlich passiert (der Fix machte
    // halteSchattenAnschluss rot und wurde zurückgedreht).
    const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
    const zeile = scan.indexOf('const kosten = feeRateForClass(classify(symbol)) * 2;');
    expect(zeile).toBeGreaterThan(0);
    expect(scan.slice(Math.max(0, zeile - 600), zeile)).toContain('BEWUSST 2× Taker');
  });

  it('der Tag-Rückblick rechnet mit den echten Sätzen — und startet per Versions-Sprung neu', () => {
    const tag = readFileSync(join(hier, '../src/scheduled/tagRueckblick.ts'), 'utf8');
    expect(tag).toContain('const kosten = roundtripFeeRateForClass(kl);');
    /* Ohne den Sprung auf ≥5 liefe der billigere Satz in das mit 2× Taker
     * gefüllte additive Aggregat — exakt die Mischung, die bei der
     * 5-Minuten-Reihe der Grund ist, NICHT zu wechseln. */
    const v = /export const TAG_RUECKBLICK_V = (\d+);/.exec(tag);
    expect(v, 'TAG_RUECKBLICK_V nicht gefunden').not.toBeNull();
    expect(Number(v![1])).toBeGreaterThanOrEqual(5);
  });
});
