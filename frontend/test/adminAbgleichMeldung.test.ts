/**
 * Die Antwort des Admin-Abgleichs muss den Neuaufbau der Liste überleben
 * (Owner-Fund 22.08.: „ich kann ihn als Admin nicht abgleichen und
 * entsperren").
 *
 * Der Abgleich lief die ganze Zeit korrekt und schrieb seinen Vermerk. Nur
 * war seine Antwort nach Sekundenbruchteilen wieder weg:
 *
 *     admBtn:          run().then(() => loadAdminList())
 *     run():           err.textContent = 'Sperre bleibt: …'; err.hidden = false;
 *     loadAdminList(): err.hidden = true;      ← löscht genau das
 *
 * Sichtbar blieb derselbe rote Chip wie vorher. Eine saubere Messung sah
 * damit exakt aus wie ein Knopf ohne Funktion — und die Begründung, mit der
 * man entscheidet, was als Nächstes zu tun ist, las nie jemand.
 *
 * Der Wächter prüft die EIGENSCHAFT (die Meldung überlebt und hängt am
 * betroffenen Konto), nicht bloss, dass eine Funktion aufgerufen wird.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(
  join(import.meta.dirname, '..', 'src', 'dashboard.ts'),
  'utf8',
);

/** Der Rumpf des Abgleich-Knopfs. */
function knopf(): string {
  const start = dashboard.indexOf("admBtn(t('adm.abgleichen')");
  expect(start).toBeGreaterThan(-1);
  return dashboard.slice(start, start + 900);
}

describe('Admin-Abgleich: die Antwort überlebt den Neuaufbau', () => {
  it('der Knopf schreibt NICHT in die flüchtige Fehlerzeile', () => {
    /* `err` wird von `loadAdminList()` als Erstes versteckt — wer dorthin
     * schreibt, schreibt ins Nichts, weil `admBtn` direkt danach neu lädt. */
    const k = knopf();
    expect(k).not.toContain('err.textContent =');
    expect(k).not.toContain('err.hidden = false;');
  });

  it('sondern in einen Merker, der den Neuaufbau übersteht', () => {
    expect(dashboard).toContain(
      'let letzterAbgleich: { uid: string; text: string; sperre: boolean } | null = null;',
    );
    expect(knopf()).toContain('letzterAbgleich = {');
  });

  it('und die Meldung erscheint an DEM Konto, um das es geht', () => {
    /* Eine gemeinsame Fehlerzeile am Kartenrand liesse offen, welches der
     * Konten gemeint ist — bei mehreren Zeilen ist das der Unterschied
     * zwischen Information und Rätsel. */
    expect(dashboard).toContain('if (letzterAbgleich?.uid === row.uid) {');
    /* Nachgezogen am 22.08.: Die Meldung steht weiterhin an DEM Konto (im
     * Verwaltungs-Streifen dieser Zeile) — und seit dem Umbau ZUSAETZLICH
     * ueber der Liste. Das ist kein Rueckfall in die anonyme Fehlerzeile am
     * Kartenrand, vor der der Kommentar oben warnt: Sie nennt die E-Mail.
     *
     * Noetig wurde sie, weil im ERFOLGSFALL die Sperre verschwindet und die
     * Zeile den Abschnitt OFFEN verlaesst — eine Meldung, die nur an der
     * Zeile haengt, kann den Erfolg baulich nicht anzeigen. */
    expect(dashboard).toContain('zeile(letzterAbgleich.text,');
    expect(dashboard).toContain('m.textContent = `${wer?.email ?? la.uid} — ${la.text}`;');
  });

  it('gelöst wird grün, bestehende Sperre rot — die Farbe trägt die Nachricht', () => {
    expect(dashboard).toMatch(
      /letzterAbgleich\.sperre \? 'var\(--rd\)' : 'var\(--gn\)'/,
    );
  });

  it('der Grund steht drin — er ist die Entscheidungsgrundlage', () => {
    /* „Sperre bleibt" allein hilft niemandem. Erst „im Buch stehen 2
     * Positionen, die der Broker nicht hat: …" sagt, was zu tun ist. */
    expect(knopf()).toContain("`${t('adm.abgleichBleibt')} ${erg.grund ?? ''}`.trim()");
  });
});
