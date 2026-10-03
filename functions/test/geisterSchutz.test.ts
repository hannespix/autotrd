/**
 * Geister-Dokument-Schutz (Befund 24.08., im Zug der Konto-Löschung).
 *
 * `shared/src/zugang.ts`: Ein FEHLENDES `accessLevel`-Feld gilt als
 * `approved` — Absicht für Bestandskonten, aber eine Falle für jedes
 * `set({...}, {merge:true})` auf `users/{uid}`: Existiert das Dokument
 * nicht mehr (nach einer künftigen Löschung), legt `set(merge)` es NEU an
 * — ohne `accessLevel` — und das Geister-Dokument gilt sofort wieder als
 * freigeschaltet.
 *
 * Mehrere Hintergrundläufe schreiben unbeaufsichtigt (Minuten Laufzeit über
 * viele Konten, kein Gate) auf das User-Root-Dokument: `snapshotEquity`
 * (täglich, ALLE Konten, kein resetLaeuft-Gate), `brokerAbgleich.vermerke`,
 * der Cooldown-Stempel nach einer Buchungspanne (`broker.ts`) und der
 * Breaker-Vermerk im Scan. Diese Tests prüfen, dass jede dieser Stellen
 * `update()` mit einzelnen `FieldPath`s statt `set(merge)` mit einem
 * verschachtelten Objekt-Literal benutzt — `update()` auf ein fehlendes
 * Dokument wirft (vom bestehenden `.catch()` geschluckt) statt es
 * wiederauferstehen zu lassen, und der einzelne FieldPath verhindert, dass
 * Geschwisterfelder unter `risk`/`engineCooldowns` (u. a. das
 * `resetLaeuftSeit`-Sperrfeld selbst!) beim Schreiben verloren gehen.
 *
 * Reine Quelltext-Wächter: Firestore-`update()`-Semantik lässt sich nicht
 * sinnvoll nachbauen, ohne am Ende nur die Nachbildung zu prüfen (dieselbe
 * Lehre wie bei `watchlistUnion.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lese = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', ...teile), 'utf8');

describe('brokerAbgleich.vermerke — update(FieldPath) statt set(merge)', () => {
  const text = lese('src', 'core', 'brokerAbgleich.ts');

  it('schreibt über einen einzelnen FieldPath, nicht über ein Objekt-Literal', () => {
    // Ab dem Ende des Begründungs-Kommentars (der selbst absichtlich
    // `set(merge)` erwähnt) bis zum Funktionsende — nur DORT zählt der
    // tatsächliche Aufruf.
    const kommentarEnde = text.indexOf('*/', text.indexOf('async function vermerke('));
    const bis = text.indexOf('\n}', kommentarEnde);
    const block = text.slice(kommentarEnde, bis);
    expect(block).toContain("new FieldPath('risk', 'abgleich')");
    expect(block).not.toContain('.set(');
    expect(block).not.toContain('merge: true');
  });
});

describe('broker.ts — Cooldown-Stempel nach Buchungspanne per FieldPath', () => {
  const text = lese('src', 'core', 'broker.ts');

  it('engineCooldowns wird über FieldPath(symbol) gesetzt, nicht per Objekt', () => {
    // Seit dem Root-Cause-Fix 25.08. (gemeinsames Netz `merkeUnbookedFill`
    // für alle drei Fill-Buchungs-Pfade) trägt der Parameter den generischen
    // Namen `symbol`, nicht mehr `req.symbol` — die FieldPath-Disziplin
    // selbst ist unverändert.
    const ab = text.indexOf('Cooldown nach Fill-Panne');
    const block = text.slice(Math.max(0, ab - 200), ab + 300);
    expect(block).toContain("new FieldPath('engineCooldowns', symbol)");
    expect(block).not.toContain('{ engineCooldowns:');
  });
});

describe('snapshotEquity.ts — Breaker-Armierung per FieldPath je Feld', () => {
  const text = lese('src', 'scheduled', 'snapshotEquity.ts');

  it('alle fünf risk-Felder einzeln, kein verschachteltes risk-Objekt', () => {
    const ab = text.indexOf('Breaker-Armierung');
    const block = text.slice(Math.max(0, ab - 400), ab + 100);
    for (const feld of [
      'vortagEquity',
      'vortagEquityAm',
      'breakerAusgeloestAm',
      'breakerGrund',
      'breakerVerlustPct',
    ]) {
      expect(block).toContain(`new FieldPath('risk', '${feld}')`);
    }
    expect(block).not.toContain('risk: {');
  });
});

describe('scanMarket.ts — Breaker-Vermerk per FieldPath je Feld', () => {
  const text = lese('src', 'scheduled', 'scanMarket.ts');

  it('alle drei risk-Felder einzeln, kein verschachteltes risk-Objekt', () => {
    const ab = text.indexOf('Breaker-Vermerk ${uid}');
    const block = text.slice(Math.max(0, ab - 400), ab + 50);
    for (const feld of ['breakerAusgeloestAm', 'breakerGrund', 'breakerVerlustPct']) {
      expect(block).toContain(`new FieldPath('risk', '${feld}')`);
    }
    expect(block).not.toContain('risk: {');
  });

  it('der Exit-Umbau-Schreibvorgang läuft nur für mayTrade-Konten', () => {
    // Die einzige verbliebene set(merge) mit dynamischen, verschachtelten
    // Feldern (Objekt-Spread über engineTeil) — statt sie zu zerlegen, wird
    // sie für genau die Konten unerreichbar gemacht, die sich löschen
    // lassen (blocked/archiviert): mayTrade() ist für sie false.
    const ab = text.indexOf('const plan = exitUmbauPlan(');
    const bis = text.indexOf('if (plan', ab);
    expect(text.slice(ab, bis + 60)).toMatch(/if \(plan && mayTrade\(userDoc\.data\(\)\)\)/);
  });
});
