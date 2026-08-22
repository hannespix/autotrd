/**
 * Wächter der Risiko-Bestätigung in der Oberfläche (Owner 22.08.).
 *
 * Der Server ist die Autorität — aber wenn die Oberfläche den Nutzer in
 * einer Sackgasse stehen lässt oder den Text abschwächt, ist die
 * Zustimmung nichts wert. Beides steht hier.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

const main = lies('main.ts');
const i18n = lies('i18n.ts');

describe('Beide Wege zur Kontoanlage fragen', () => {
  it('Registrieren verlangt das Häkchen', () => {
    const block = main.slice(main.indexOf("'#registerBtn'"), main.indexOf("'#googleBtn'"));
    expect(block).toContain('if (!risikoOk()) {');
  });

  it('Google ebenfalls — es ist kein anderer Rechtsvorgang', () => {
    /* Über Google entsteht genauso ein neues Konto. Fragte nur der eine
     * Weg, wäre der andere die Lücke. */
    const block = main.slice(main.indexOf("'#googleBtn'"), main.indexOf("'#resetBtn'"));
    expect(block).toContain('if (!risikoOk()) {');
  });

  it('der Hinweis ist verlinkt, nicht nur behauptet', () => {
    // „Gelesen" bestätigen zu lassen, ohne den Text erreichbar zu machen,
    // wäre eine leere Geste.
    expect(main).toContain("openLegal('disclaimer');");
  });
});

describe('Wer ohne Bestätigung ankommt, landet nicht in einer Sackgasse', () => {
  it('der Fehler des Servers führt auf das Risiko-Tor', () => {
    expect(main).toContain("if (String((e as { message?: string })?.message ?? '').includes('risikoBestaetigung')) {");
    expect(main).toContain('renderRisikoTor();');
  });

  it('das Tor hat genau einen Ausgang — bestätigen oder abmelden', () => {
    /* Ein „später"-Knopf wäre die Ausnahme, die den Zweck aufhebt: Ein
     * Konto ohne Zustimmung ist genau das Konto, das zum Problem wird. */
    const tor = main.slice(main.indexOf('function renderRisikoTor'), main.indexOf('function renderLogin'));
    expect(tor).toContain("id=\"rtGo\"");
    expect(tor).toContain("id=\"rtOut\"");
    expect(tor).not.toMatch(/spaeter|später|skip|ueberspringen/i);
  });

  it('und schickt die Fassung mit, die der Nutzer gesehen hat', () => {
    expect(main).toContain('ensureProfile(RISIKO_VERSION)');
  });
});

describe('Der Text sagt, was er sagen muss', () => {
  const text = (sprache: 'de' | 'en'): string => {
    const treffer = [...i18n.matchAll(/'login\.risikoHaken':([\s\S]*?),\n {2}'/g)].map((m) => m[1]!);
    expect(treffer).toHaveLength(2);
    return sprache === 'de' ? treffer[0]! : treffer[1]!;
  };

  it('DE: eigenes Risiko, keine Anlageberatung, Totalverlust möglich', () => {
    /* Alle drei Aussagen tragen die Bestätigung. Wer eine davon wegkürzt,
     * nimmt ihr genau den Teil, auf den es ankommt (CLAUDE.md: Text-Diät
     * fasst Risiko- und Warntexte nicht an). */
    const d = text('de');
    expect(d).toContain('auf eigenes Risiko');
    expect(d).toContain('keine Anlageberatung');
    expect(d).toContain('Totalverlust');
  });

  it('EN: dieselben drei Aussagen, nicht abgeschwächt', () => {
    const e = text('en');
    expect(e).toContain('at my own risk');
    expect(e).toContain('not investment advice');
    expect(e).toContain('total loss');
  });

  it('und sagt geradeheraus, dass ohne sie kein Konto entsteht', () => {
    expect(i18n).toContain('ohne das entsteht kein Konto');
    expect(i18n).toContain('no account is created without it');
  });
});
