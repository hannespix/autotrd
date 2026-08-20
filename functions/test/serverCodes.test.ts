/**
 * Server-Fehlercodes statt deutscher Klartexte (Task #145, Tranche 1).
 *
 * Die Callables werfen für statische Fehlermeldungen `srv.*`-Codes; das
 * Frontend übersetzt sie über sein Wörterbuch (serverText, i18n.ts) und
 * reicht Unbekanntes durch. Zwei Wächter halten den Vertrag:
 *
 *  1. Kein NEUES deutsches Literal: Jedes reine String-Literal als zweites
 *     HttpsError-Argument muss ein srv.*-Code sein. Dynamische Templates
 *     und Helfer-Aufrufe (accessDeniedReason, tore.grund, …) sind bewusst
 *     außen vor — Tranche 2 (Parameter-Codes) ist im Task dokumentiert.
 *  2. Kein toter Code: Jeder geworfene srv.*-Code hat im Frontend-Wörterbuch
 *     eine DEUTSCHE und eine ENGLISCHE Zeile. Ein umbenannter oder
 *     vergessener Schlüssel zeigte dem Nutzer sonst den rohen Code an —
 *     serverText reicht Unbekanntes wortwörtlich durch, genau deshalb ist
 *     die Lücke hier ein Testfehler und kein Laufzeitfehler.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const srcDir = join(hier, '../src');

function alleQuellen(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...alleQuellen(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const dateien = alleQuellen(srcDir).map((p) => ({
  name: p.slice(srcDir.length + 1),
  code: readFileSync(p, 'utf8'),
}));

// Reines Literal (einfach ODER doppelt gequotet) als zweites Argument.
const LITERAL = /new HttpsError\(\s*'[a-z-]+',\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*[,)]/g;

describe('HttpsError-Meldungen sind Codes, keine Klartexte', () => {
  it('jedes statische Literal beginnt mit srv.', () => {
    const verstoesse: string[] = [];
    for (const { name, code } of dateien) {
      for (const m of code.matchAll(LITERAL)) {
        const text = m[1]!.slice(1, -1);
        if (!text.startsWith('srv.')) verstoesse.push(`${name}: ${text.slice(0, 60)}`);
      }
    }
    expect(verstoesse, `Klartext statt srv.*-Code: ${verstoesse.join(' | ')}`).toEqual([]);
  });

  it('auch dynamische Templates sind Parameter-Codes (`srv.xyz|wert`), kein Klartext', () => {
    /* Tranche 2: Ein Template als zweites Argument trägt den Code vor dem
     * ersten `|`, der eine dynamische Wert folgt dahinter ({0} im
     * Wörterbuch). Seit Tranche 3a OHNE Ausnahme — auch die frühere
     * kursAlter.grund-Mischform läuft als Parameter-Code (der Grund selbst
     * bleibt deutsch, bis kursZuAlt Codes liefert). */
    const verstoesse: string[] = [];
    for (const { name, code } of dateien) {
      for (const m of code.matchAll(/new HttpsError\(\s*'[a-z-]+',\s*`([^`]*)`/g)) {
        const inhalt = m[1]!;
        if (!inhalt.startsWith('srv.')) verstoesse.push(`${name}: ${inhalt.slice(0, 60)}`);
      }
    }
    expect(verstoesse, `Klartext-Template statt srv.*|-Code: ${verstoesse.join(' | ')}`).toEqual([]);
  });

  it('jeder geworfene srv.*-Code hat DE- UND EN-Zeile im Frontend-Wörterbuch', () => {
    const woerterbuch = readFileSync(join(hier, '../../frontend/src/i18n.ts'), 'utf8');
    const enStart = woerterbuch.indexOf('export const EN');
    expect(enStart).toBeGreaterThan(0);
    const deTeil = woerterbuch.slice(0, enStart);
    const enTeil = woerterbuch.slice(enStart);
    // shared/ liefert Codes an die Callables (bindungsMeldung) — auch die
    // müssen im Wörterbuch stehen, sonst zeigt serverText den rohen Code.
    const geteilt = alleQuellen(join(hier, '../../shared/src')).map((p) => ({
      name: `shared/${p.split('/').pop()!}`,
      code: readFileSync(p, 'utf8'),
    }));
    const fehlend: string[] = [];
    for (const { name, code } of [...dateien, ...geteilt]) {
      // \b-Suche statt Quote-Suche: fängt Codes in '…'-Literalen UND in
      // `srv.xyz|${…}`-Templates gleichermaßen.
      for (const m of code.matchAll(/\b(srv\.\w+)\b/g)) {
        const schluessel = m[1]!;
        if (!deTeil.includes(`'${schluessel}':`)) fehlend.push(`${name}: ${schluessel} ohne DE`);
        if (!enTeil.includes(`'${schluessel}':`)) fehlend.push(`${name}: ${schluessel} ohne EN`);
      }
    }
    expect(fehlend, fehlend.join(' | ')).toEqual([]);
  });

  it('es gibt überhaupt geworfene srv.*-Codes (der Scan läuft nicht ins Leere)', () => {
    // Ein umgebauter HttpsError-Aufrufstil ließe beide Wächter oben leer
    // durchlaufen — grün ohne Aussage. Der Anker: Tranche 1 stellte 47 um.
    const anzahl = dateien.reduce((s, { code }) => s + [...code.matchAll(/'srv\.\w+'/g)].length, 0);
    expect(anzahl).toBeGreaterThanOrEqual(47);
  });
});
