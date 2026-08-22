/**
 * Die Admin-Freischaltungskarte, kompakte Fassung (Owner-Anfrage 22.08.).
 *
 * Der Anlass war messbar, nicht Geschmack: Bei 26 Konten war die Karte
 * 4 443 px hoch (Desktop) bzw. 6 013 px (390 px) und trug 79 Knöpfe — jeden
 * einzelnen VOLLBREIT, weil `.btn { width: 100% }` gilt und `admBtn` inline
 * nur Polsterung und Schriftgröße setzte. Bei 200 Konten wären das rund
 * 30 000 px.
 *
 * Was diese Datei bewacht, ist NICHT das Aussehen — das misst der
 * Browser-Prüfstand `frontend/e2e/admin-shot.mjs`. Hier stehen die
 * Zusagen, die man einem Bild nicht ansieht: dass folgenreiche Eingriffe
 * zwei Schritte kosten, dass die Sperre ein Messergebnis bleibt, und dass
 * der Nachrichten-Faden einen Verwaltungsklick überlebt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DE, EN } from '../src/i18n.js';

const dash = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
/** Nur der Admin-Teil — sonst treffen die Wächter zufällig anderen Code. */
const admin = dash.slice(dash.indexOf('let admZeilen'), dash.indexOf('function renderStrategyChips'));
/**
 * Derselbe Ausschnitt OHNE Kommentare.
 *
 * Die „gibt es nicht"-Prüfungen brauchen ihn: Der erste Entwurf dieses
 * Wächters war rot, weil im Quelltext erklärt steht, WARUM es kein
 * `confirm()` gibt — und die Prüfung genau diese Erklärung fand. Ein
 * Wächter, der auf den eigenen Kommentar hereinfällt, bewacht nichts.
 */
const codeOhneText = admin
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((z) => z.replace(/\/\/.*$/, ''))
  .join('\n');

describe('Keine Knopf-Kolonne mehr', () => {
  it('admBtn setzt keinen Inline-Stil mehr und trägt die schmale Klasse', () => {
    // Die Ursache war, dass admBtn `width` NICHT setzte und `.btn` mit
    // width:100% durchschlug. `.adm-akt` ist die Gegenmaßnahme.
    const stelle = dash.indexOf('function admBtn(');
    const block = dash.slice(stelle, stelle + 900);
    expect(block).toContain('adm-akt');
    expect(block, 'Inline-Stil ist zurück').not.toContain("style.cssText = 'padding:3px 8px");
  });

  it('die schmale Klasse ist zweiklassig — sonst entscheidet die Quellreihenfolge', () => {
    /* Genau daran ist der Alle/Keine-Knopf am 21.08. gescheitert: Ein
     * einklassiger Selektor (0,1,0) verliert gegen `.btn`, wenn der später
     * im Blatt steht. */
    expect(css).toContain('.adm-z .adm-akt {');
    expect(css).toContain('.adm-verw .adm-akt {');
  });

  it('die Zeilen-Pille setzt KEIN eigenes min-height', () => {
    // Auf Touch soll `.btn { min-height: 42px }` weiter greifen — die
    // Trefferfläche ist die eine Sache, die kompakter NICHT werden darf.
    const stelle = css.indexOf('.adm-z .adm-akt {');
    const regel = css.slice(stelle, css.indexOf('}', stelle));
    expect(regel).not.toContain('min-height');
  });

  it('beide Listen sind höhenbegrenzt — das hält den Not-Aus in Reichweite', () => {
    expect(css).toContain('.adm-liste.offen { max-height: 300px; }');
    expect(css).toContain('.adm-liste.register { max-height: 420px; }');
    expect(css).toContain('.adm-liste { overflow-y: auto;');
  });
});

describe('Anfragen oben', () => {
  it('OFFEN kennt genau zwei Gründe, in fester Rangfolge', () => {
    const stelle = admin.indexOf('function admOffenGrund');
    const block = admin.slice(stelle, admin.indexOf('}', admin.indexOf('return null', stelle)));
    expect(block).toContain("accessLevel === 'pending'");
    expect(block).toContain('abgleich?.sperre === true');
    // pending steht VOR der Sperre: die Registrierung ist die Anfrage.
    expect(block.indexOf("'pending'")).toBeLessThan(block.indexOf('sperre'));
  });

  it('OFFEN ist eine SICHT, keine Umlagerung — jedes Konto steht auch im Register', () => {
    /* Sonst fände der Filter ein Konto nicht, das gerade oben steht. Der
     * Registerteil filtert auf accessLevel, nicht auf „nicht offen". */
    expect(admin).toContain("list.append(admGruppe(t('adm.alleKonten'), rows.length));");
    expect(admin).toContain('rows.filter((r) => r.accessLevel === stufe)');
  });

  it('das Älteste steht zuerst', () => {
    expect(admin).toContain('return zeit(a) - zeit(b); // aeltestes zuerst');
  });
});

describe('Kompakter ja, riskanter nein', () => {
  const scharf = ['adm.wirklichSperren', 'adm.wirklichAdminGeben', 'adm.wirklichAdminNehmen', 'adm.wirklichVormerken'];

  it('die drei folgenreichen Eingriffe sind armiert', () => {
    // Sperren, Admin-Rechte und die Übernahme-Vormerkung berühren fremde
    // Rechte bzw. fremdes Geld. Sie kosten künftig drei bewusste Schritte:
    // öffnen, armieren, bestätigen.
    for (const k of scharf) expect(admin, `${k} nicht verdrahtet`).toContain(k);
    expect(admin).toContain("admArmBtn(\n        t('adm.sperren'),");
    expect(admin).toMatch(/admArmBtn\(\s*row\.admin \? t\('adm\.adminEntziehen'\)/);
    expect(admin).toMatch(/admArmBtn\(\s*t\('adm\.vormerken'\)/);
  });

  it('ZUM ADMIN MACHEN ist rot — heute sah es aus wie NACHRICHTEN', () => {
    /* Der Ernannte darf danach den Ernenner entlassen; die folgenreichste
     * Aktion der Karte darf nicht neutral aussehen. */
    const stelle = admin.indexOf("row.admin ? t('adm.adminEntziehen')");
    const block = admin.slice(stelle, stelle + 400);
    expect(block).toContain("'btn-r'");
    expect(block).not.toContain("'btn-n'");
  });

  it('FREISCHALTEN bleibt einstufig — es stellt her, es zerstört nicht', () => {
    expect(admin).toMatch(/admBtn\(t\('adm\.freischalten'\)/);
  });

  it('KEIN confirm() — ein unterdrückter Dialog wäre ein Knopf ohne Wirkung', () => {
    /* Browser bieten nach wiederholten Dialogen „weitere Dialoge
     * unterdrücken" an; danach liefert confirm() dauerhaft false. */
    expect(codeOhneText).not.toContain('confirm(');
    expect(codeOhneText).not.toContain('window.confirm');
  });

  it('der scharfe Zustand läuft von selbst ab', () => {
    expect(admin).toContain('window.setTimeout(admEntwaffne, 5000)');
  });

  it('KEIN Knopf, der eine Sperre setzt oder aufhebt', () => {
    /* CLAUDE.md §7: Die Abgleich-Sperre ist ein Messergebnis. Die Karte
     * darf sie sichtbar machen und die Messung anstoßen — ihren Zustand
     * setzt nur die Messung. */
    expect(codeOhneText).not.toMatch(/sperre\s*[:=]\s*(true|false)/);
    expect(codeOhneText).not.toContain('entsperren');
  });
});

describe('Der Nachrichten-Faden überlebt einen Verwaltungsklick', () => {
  it('Zeile und Verwaltung werden neu gebaut, der Faden NIE angefasst', () => {
    /* #417 wird damit baulich unmöglich statt per Merker verwaltet: Der
     * Faden hängt in einem eigenen Block, den admAktualisiereZeile nicht
     * berührt. */
    expect(admin).toContain("const faden = k.querySelector<HTMLElement>('.adm-faden');");
    const stelle = admin.indexOf('async function admAktualisiereZeile');
    const block = admin.slice(stelle, admin.indexOf('function admBtn', stelle));
    expect(block, 'der Faden wird überschrieben').not.toMatch(/faden\.(innerHTML|remove|replaceWith)/);
  });

  it('der Faden landet im Streifen, nicht am Ende der ganzen Liste', () => {
    // Vorher hing er an #admList — entgegen dem eigenen Doc-Kommentar.
    expect(dash).toContain('ziel.append(box);');
    expect(dash).toContain('void zeigeFaden(row.uid, fadenBlock)');
  });

  it('der Faden-Knopf bleibt bewusst KEIN admBtn', () => {
    const stelle = admin.indexOf('const fadenBtn = document.createElement');
    const block = admin.slice(stelle, stelle + 600);
    expect(block).not.toMatch(/admBtn\(/);
  });

  it('nach einer Aktion wird EINE Zeile aufgefrischt, nicht die Liste', () => {
    const stelle = admin.indexOf('function admBtn(');
    const block = admin.slice(stelle, stelle + 900);
    expect(block).toContain('admAktualisiereZeile(uid)');
  });
});

describe('Die Sperr-Marke wird nie geschluckt', () => {
  it('die Markenzone kürzt nicht', () => {
    // Ihre Unsichtbarkeit WAR der Owner-Befund vom 21.08.
    expect(css).toContain('.adm-mark { flex: none;');
  });

  it('der Sperr-Chip steht in der Zeile, der Risiko-Chip im Streifen', () => {
    /* Ein Vermerk, den JEDES neue Konto trägt, ist in einer Übersicht
     * Rauschen, das die eine rote Zeile versteckt. */
    const zeile = admin.slice(admin.indexOf('function admZeile'), admin.indexOf('function admFuelleVerw'));
    expect(zeile).toContain("t('adm.abgleichKurz')");
    expect(zeile).not.toContain("t('adm.risikoOk')");
    const verw = admin.slice(admin.indexOf('function admFuelleVerw'), admin.indexOf('function admGruppe'));
    expect(verw).toContain("t('adm.risikoOk')");
  });

  it('die Abgleich-Meldung steht AUSSERHALB der Liste', () => {
    /* Im Erfolgsfall verschwindet die Sperre, die Zeile verlässt also den
     * Abschnitt OFFEN. Eine Meldung an der Zeile könnte den Erfolg baulich
     * nicht anzeigen. */
    expect(dash).toContain('<div id="admMeldung"');
    expect(dash.indexOf('<div id="admMeldung"')).toBeLessThan(dash.indexOf('<div id="admList">'));
  });
});

describe('Textbausteine vollständig', () => {
  it('jeder neue adm.-Schlüssel existiert auch auf Englisch', () => {
    const neu = [
      'adm.laden', 'adm.offen', 'adm.alleKonten', 'adm.nichtsOffen', 'adm.wartetSeit',
      'adm.tage', 'adm.gruppeWartend', 'adm.gruppeGesperrt', 'adm.gruppeFrei',
      'adm.filterKonto', 'adm.mehrAktionen', 'adm.abgleichKurz', 'adm.kontenStand',
      'adm.geladen', 'adm.wirklichSperren', 'adm.wirklichAdminGeben',
      'adm.wirklichAdminNehmen', 'adm.wirklichVormerken',
    ];
    for (const k of neu) {
      expect((DE as Record<string, string>)[k], `DE fehlt: ${k}`).toBeTruthy();
      expect((EN as Record<string, string>)[k], `EN fehlt: ${k}`).toBeTruthy();
    }
  });

  it('der Not-Aus-Block ist Zeichen für Zeichen unverändert', () => {
    // Text-Tabu: Echtgeld-Texte werden nie angefasst oder abgeschwächt.
    expect(dash).toContain("<div class=\"wl-sec adm-trenner\">Echtgeld-Not-Aus</div>");
    expect(dash).toContain("${t('lay.notausHinweis')}");
    expect(dash).toContain('id="admKillBtn"');
  });

  it('id="admReload" bleibt — Zeile ~11277 bindet sie', () => {
    /* $ ist getElementById(id)! und wirft bei fehlendem Element; die
     * nächste Zeile registriert den Not-Aus-Handler. Beides stürbe mit. */
    expect(dash).toContain('id="admReload"');
    expect(dash).toContain("$('admReload').addEventListener");
  });
});
