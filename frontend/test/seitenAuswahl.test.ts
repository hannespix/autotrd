/**
 * Wächter der Seiten-Auswahl (Owner 22.08.: „per checkbox auswählbare pages
 * was als Bild und Video exportiert wird … und angezeigt wird").
 *
 * Die tragende Entscheidung ist EINE Liste für alle drei Wege. Vorher gab
 * es die Seiten zweimal, mit verschiedenen Namen — Bild-Karten hiessen
 * `verlauf`/`womit`, die Video-Szenen `kurve`/`symbole`. Zwei Auswahlen
 * über zwei Vokabulare wären der sichere Weg dahin, dass jemand eine Seite
 * abwählt und sie im anderen Format trotzdem auftaucht.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLE_SEITEN,
  SEITEN,
  leseSeitenAuswahl,
  schreibeSeitenAuswahl,
  seiteGewaehlt,
  seiteZuSzene,
} from '../src/seiten.js';

const lies = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', ...teile), 'utf8');

/** localStorage stellen — in Node gibt es keins. */
const mitSpeicher = <T>(start: string | null, fn: (lesen: () => string | null) => T): T => {
  let wert = start;
  vi.stubGlobal('localStorage', {
    getItem: () => wert,
    setItem: (_k: string, v: string) => {
      wert = v;
    },
  });
  try {
    return fn(() => wert);
  } finally {
    vi.unstubAllGlobals();
  }
};

describe('Ein Verzeichnis für Anzeige, Bild und Video', () => {
  it('jede Seite erscheint mindestens auf einem Weg', () => {
    // Eine Seite, die weder Bild noch Video ist, wäre eine Checkbox ohne Wirkung.
    for (const s of SEITEN) expect(s.bild || s.video !== null, s.id).toBe(true);
  });

  it('die Video-Kennungen sind eindeutig — sonst zeigt die Zuordnung ins Leere', () => {
    const szenen = SEITEN.map((s) => s.video).filter((v): v is string => v !== null);
    expect(new Set(szenen).size).toBe(szenen.length);
  });

  it('die historischen Szenennamen bleiben zuordenbar', () => {
    /* `kurve` und `symbole` heissen im Video seit jeher so. Verliert die
     * Zuordnung sie, filtert der Regieplan sie nie — die Auswahl wäre für
     * genau diese zwei Szenen wirkungslos, und zwar still. */
    expect(seiteZuSzene('kurve')).toBe('verlauf');
    expect(seiteZuSzene('symbole')).toBe('womit');
    expect(seiteZuSzene('cta')).toBe('cta');
    expect(seiteZuSzene('gibtsnicht')).toBeNull();
  });
});

describe('Die Auswahl überlebt und bleibt ehrlich', () => {
  it('nie gespeichert ⇒ alle Seiten', () => {
    // Wer die Auswahl nie angefasst hat, bekommt die vollständige Ausgabe.
    mitSpeicher(null, () => expect(leseSeitenAuswahl()).toEqual([...ALLE_SEITEN]));
  });

  it('leer gespeichert bleibt leer — das ist eine Entscheidung, kein Defekt', () => {
    mitSpeicher('[]', () => expect(leseSeitenAuswahl()).toEqual([]));
  });

  it('unbekannte Kennungen fliegen raus statt durchzurutschen', () => {
    mitSpeicher('["depot","gibtsnicht"]', () => expect(leseSeitenAuswahl()).toEqual(['depot']));
  });

  it('kaputter Speicherinhalt ⇒ alle Seiten statt Absturz', () => {
    mitSpeicher('{kein json', () => expect(leseSeitenAuswahl()).toEqual([...ALLE_SEITEN]));
  });

  it('Schreiben normalisiert die Reihenfolge — die Ausgabe soll stabil sein', () => {
    mitSpeicher('[]', (lesen) => {
      schreibeSeitenAuswahl(['cta', 'ergebnis', 'depot']);
      expect(JSON.parse(lesen()!)).toEqual(['ergebnis', 'depot', 'cta']);
    });
  });

  it('`undefined` heisst „alle" — Aufrufer ohne Auswahl verlieren nichts', () => {
    for (const s of SEITEN) expect(seiteGewaehlt(s.id, undefined)).toBe(true);
  });
});

describe('Beide Ausgabewege lesen dieselbe Auswahl', () => {
  it('die Bild-Karten filtern danach', () => {
    const story = lies('shareStory.ts');
    expect(story).toContain('auswahl?: readonly SeitenId[]');
    expect(story).toContain("const dran = (id: StoryKarte['id']): boolean => seiteGewaehlt(id, auswahl);");
  });

  it('der Regieplan ebenfalls — über die Szenen-Zuordnung', () => {
    const video = lies('analyseVideo.ts');
    expect(video).toContain('const seite = seiteZuSzene(szene);');
    expect(video).toContain('regiePlan(chart, auswahl)');
  });

  it('die Datenbedingung bleibt VOR der Auswahl stehen', () => {
    /* Beide Bedingungen bedeuten Verschiedenes: abgewählt heisst „will ich
     * nicht", datenlos heisst „gäbe nichts zu zeigen". Ersetzt eine die
     * andere, entsteht entweder eine leere Karte oder eine, die trotz
     * Abwahl erscheint. */
    const story = lies('shareStory.ts');
    expect(story).toContain("if (dran('depot') && (d.positionen?.length ?? 0) > 0) {");
    expect(story).toContain("if (dran('verlauf') && d.zerlegung.tage.length >= 2) {");
  });

  it('ein Video ohne Szene entsteht gar nicht erst', () => {
    // Sonst fiele der Fehler erst beim Abspielen auf — als leerer Clip.
    expect(lies('analyseVideo.ts')).toContain("if (plan.length === 0) throw new Error(t('sh.keineSeiten'));");
  });

  it('die Punkt-Anzeige leert mit — sonst behauptet sie „Karte 1/5" ohne Karte', () => {
    /* Browser-Befund 22.08.: Der Leer-Pfad sprang zurück, BEVOR er die
     * Punkte anfasste. Sichtbar war nichts, das Vorlesegerät las weiter
     * den alten Stand vor. */
    const dash = lies('dashboard.ts');
    const i = dash.indexOf('if (storyKarten.length === 0) {');
    expect(i).toBeGreaterThan(-1);
    const block = dash.slice(i, dash.indexOf('return;', i));
    expect(block).toContain("dotsLeer.textContent = '';");
    expect(block).toContain("dotsLeer.setAttribute('aria-label', t('sh.keineSeiten'));");
  });

  it('und eine leere Vorschau stürzt nicht ab', () => {
    /* `storyKarten[storyIdx]!.svg` hätte bei leerer Auswahl geworfen und
     * die ganze Analyse-Karte mitgerissen. */
    expect(lies('dashboard.ts')).toContain('if (storyKarten.length === 0) {');
  });
});
