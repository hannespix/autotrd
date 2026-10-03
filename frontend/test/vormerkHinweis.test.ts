/**
 * Der Hinweis auf eine vorgemerkte Depot-Übernahme muss beim KONTO-INHABER
 * ankommen — und ehrlich sagen, was die Übernahme tut (22.08.).
 *
 * Der Admin darf fremde Bücher nicht überschreiben; er bittet nur darum.
 * Damit ruht die ganze Auflösung auf diesem einen Text. Ist er unklar,
 * klickt jemand „Übernehmen", ohne zu wissen, dass sein Buch danach vom
 * Broker kommt — und im schlimmsten Fall überschreibt er korrekte Zahlen,
 * weil die Abweichung nur eine Störung beim Broker war.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const dashboard = lies('dashboard.ts');
const daten = lies('data.ts');
const i18n = lies('i18n.ts');

describe('Der Hinweis erreicht den Konto-Inhaber', () => {
  it('das User-Doc trägt das Feld bis in die Anzeige', () => {
    expect(daten).toContain("uebernahmeVorgemerkt: leseVormerkung(snap.get('risk.uebernahmeVorgemerkt')),");
    expect(dashboard).toContain('renderVormerkung(u.uebernahmeVorgemerkt);');
  });

  it('ein halb geschriebener Vermerk erzeugt KEINEN Hinweis', () => {
    /* An diesem Feld hängt eine Aufforderung, das eigene Buch zu
     * überschreiben. Ohne Zeitstempel ist es kein Vermerk, sondern Schrott
     * — und darf niemanden auffordern. */
    const fn = daten.slice(daten.indexOf('function leseVormerkung'), daten.indexOf('/** `risk.abgleich`'));
    expect(fn).toContain("if (typeof v.at !== 'string' || v.at.length === 0) return null;");
  });

  it('der Kasten steht direkt über dem Knopf, den er meint', () => {
    const kasten = dashboard.indexOf('id="bkVorgemerkt"');
    const knopf = dashboard.indexOf('id="bkAdopt"');
    expect(kasten).toBeGreaterThan(-1);
    expect(kasten).toBeLessThan(knopf);
  });

  it('ohne Vormerkung ist er weg — nicht bloss leer', () => {
    const fn = dashboard.slice(dashboard.indexOf('function renderVormerkung'), dashboard.indexOf('function renderAbgleich'));
    expect(fn).toContain('el.hidden = true;');
  });
});

describe('Der Text sagt, was die Übernahme wirklich tut', () => {
  const text = (sprache: 'de' | 'en'): string => {
    const treffer = [...i18n.matchAll(/'ab\.vormerkText':([\s\S]*?),\n {2}'/g)].map((m) => m[1]!);
    expect(treffer).toHaveLength(2);
    return sprache === 'de' ? treffer[0]! : treffer[1]!;
  };

  it('DE: benennt das Überschreiben — nicht „Problem beheben"', () => {
    const d = text('de');
    expect(d).toContain('ÜBERSCHREIBT');
    expect(d).toContain('Barbestand');
    // Und dass NICHTS gehandelt wird — sonst klingt es nach Verkaufsauftrag.
    expect(d).toContain('kauft und verkauft nichts');
  });

  it('EN: dieselbe Zusicherung, nicht abgeschwächt', () => {
    const e = text('en');
    expect(e).toContain('OVERWRITES');
    expect(e).toContain('cash');
    expect(e).toContain('buys and sells nothing');
  });

  it('beide warnen davor, korrekte Zahlen zu überschreiben', () => {
    /* Der Fall, den der Text tragen muss: War die Abweichung nur eine
     * Störung beim Broker, macht die „Heilung" es schlimmer. Wer das
     * wegkürzt, nimmt dem Nutzer die einzige Prüfung, die er hat. */
    expect(text('de')).toContain('würdest du korrekte Zahlen überschreiben');
    expect(text('en')).toContain('you would overwrite correct figures');
  });
});
