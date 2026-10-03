/**
 * Wächter des Admin-Abgleichs (Owner 21.08.: „als Admin andere Konten mit
 * Broker abgleichen und Sperre lösen — die Sperre für Admin sichtbar
 * machen").
 *
 * Die zentrale Eigenschaft: **Der Admin hebt die Sperre nicht auf, er löst
 * die Messung neu aus.** Die Abgleich-Sperre schützt davor, dass die Engine
 * auf Basis eines falschen Buchs kauft — ein Knopf „Sperre aus" wäre genau
 * die Ausnahme, die den Schutz wertlos macht: Der Fehlbestand wäre ja
 * weiterhin da. Stimmt alles wieder, verschwindet die Sperre von selbst.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const admin = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'callable', 'admin.ts'), 'utf8');

describe('Der Admin misst neu — er übergeht nichts', () => {
  it('kein Weg, die Sperre direkt zu setzen oder zu löschen', () => {
    const s = admin();
    // Weder das Sperr-Feld noch der Vermerk werden hier geschrieben.
    expect(s).not.toMatch(/risk\.abgleich['"]?\s*:/);
    expect(s).not.toMatch(/sperre\s*:\s*false/);
    expect(s).not.toContain("FieldValue.delete()");
    // Der Zustand kommt AUSSCHLIESSLICH aus dem echten Abgleich.
    expect(s).toContain('const befund = await abgleichFuerKonto(');
    expect(s).toContain('sperre: befund.sperre,');
  });

  it('die Sperr-Anzeige nutzt dieselbe Funktion wie der Scan', () => {
    /* Eine eigene Auslegung hier hiesse: Die Admin-Ansicht könnte
     * „gesperrt" sagen, während die Engine handelt — zwei Wahrheiten über
     * dieselbe Sperre. */
    const s = admin();
    expect(s).toContain("import { abgleichSperreAusVermerk } from '../core/kontoTore.js';");
    expect(s).toContain('sperre: abgleichSperreAusVermerk(vermerk, jetzt),');
    // Und die Liste misst NICHT je Zeile am Broker (eine Lawine je Konto).
    const listBlock = s.slice(s.indexOf("if (action === 'list')"), s.indexOf("if (action === 'abgleich')"));
    expect(listBlock).not.toContain('abgleichFuerKonto(');
  });

  it('ein Zeitstempel für alle Zeilen — sonst entscheidet die Schleifenlaufzeit', () => {
    expect(admin()).toContain('const jetzt = new Date();');
    expect(admin()).toContain('abgleich: abgleichZeile(');
  });

  it('fremdes Geld bleibt unangetastet: nur der Vermerk entsteht neu', () => {
    const s = admin();
    /* Bis zum NÄCHSTEN Zweig, nicht bis zu einem namentlich genannten
     * (22.08.): Vorher endete der Schnitt fest bei `setAdmin`. Als
     * `uebernahmeVormerken` dazwischenkam, lag dessen `ref.set(...)` mit im
     * Block — der Wächter schlug an, obwohl der Abgleich-Zweig unverändert
     * nichts schreibt. Eine Grenze, die von der Reihenfolge fremder Zweige
     * abhängt, misst irgendwann etwas anderes als ihr Name sagt. */
    const start = s.indexOf("if (action === 'abgleich')");
    const naechster = s.indexOf("if (action === '", start + 10);
    expect(naechster).toBeGreaterThan(start);
    const block = s.slice(start, naechster);
    // Keine Schreibzugriffe auf Wallet, Positionen oder Strategie.
    expect(block).not.toMatch(/\.set\(|\.update\(/);
    expect(block).not.toContain('paperBalance:');
    // Positionen werden gelesen — die braucht der Vergleich.
    expect(block).toContain("collection('positions').get()");
  });

  it('das eigene Konto bleibt tabu — auch beim Abgleich', () => {
    /* targetRef() wirft bei `target === uid`; der Abgleich-Zweig geht
     * denselben Weg wie set/setAdmin, statt die UID selbst zu prüfen. */
    const block = admin().slice(
      admin().indexOf("if (action === 'abgleich')"),
      admin().indexOf("if (action === 'setAdmin')"),
    );
    expect(block).toContain('const ref = targetRef();');
  });
});
