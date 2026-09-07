/**
 * Genau EINE Kopie von `@firebase/app` im Baum.
 *
 * Der Fall, der die Plattform lahmgelegt hat: `firebase@11.10.0` hängt fest
 * an `@firebase/app@0.13.2`, seine Teilpakete (`auth`, `app-check`,
 * `firestore`, `functions`) fordern aber `0.14.4`. npm hob 0.14.4 in die
 * Wurzel und ließ 0.13.2 unter `firebase/` liegen — zwei Kopien, zwei
 * Komponenten-Registries. `registerAuth()`/`registerAppCheck()` schrieben in
 * die eine, `initializeApp()` las die andere, und `getAuth()` warf beim
 * Start „Component auth has not been registered yet". Das lief in KEINEN
 * Test: Die Oberfläche blieb einfach weiß, weil der Fehler auf Modulebene
 * flog, bevor irgendetwas gerendert wurde.
 *
 * Ein Bundler-Kniff (`resolve.dedupe`) hätte nur das Bundle geheilt, nicht
 * den Dev-Server und nicht die Tests. Deshalb steht die Auflösung in
 * `overrides` der Wurzel-package.json — und dieser Test hält sie fest.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Alle Verzeichnisse `<irgendwo>/node_modules/@firebase/app` einsammeln. */
function kopien(wurzel: string, tiefe = 0): string[] {
  if (tiefe > 6) return [];
  const nm = join(wurzel, 'node_modules');
  let eintraege: string[];
  try {
    eintraege = readdirSync(nm);
  } catch {
    return [];
  }
  const gefunden: string[] = [];
  for (const e of eintraege) {
    if (e === '.bin' || e === '.package-lock.json') continue;
    const p = join(nm, e);
    if (e === '@firebase') {
      try {
        if (readdirSync(p).includes('app')) gefunden.push(join(p, 'app'));
      } catch {
        /* unlesbar ⇒ überspringen */
      }
    }
    // Scoped-Pakete eine Ebene tiefer durchsuchen, sonst direkt.
    const kinder = e.startsWith('@')
      ? readdirSync(p).map((k) => join(p, k))
      : [p];
    for (const k of kinder) {
      try {
        if (statSync(k).isDirectory()) gefunden.push(...kopien(k, tiefe + 1));
      } catch {
        /* Symlink ins Leere ⇒ überspringen */
      }
    }
  }
  return gefunden;
}

describe('@firebase/app im Abhängigkeitsbaum', () => {
  it('existiert genau einmal — zwei Kopien = zwei Registries = weiße Seite', () => {
    const wurzel = new URL('../../', import.meta.url).pathname;
    const gefunden = [...new Set(kopien(wurzel))];
    const mitVersion = gefunden.map((p) => {
      const v = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version as string;
      return `${v} @ ${p.replace(wurzel, '')}`;
    });
    expect(mitVersion, `Mehrere @firebase/app:\n${mitVersion.join('\n')}`).toHaveLength(1);
  });

  it('die Wurzel-package.json hält die Auflösung fest', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.overrides?.['@firebase/app']).toBeTruthy();
  });
});
