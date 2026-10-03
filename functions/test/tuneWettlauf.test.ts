/**
 * Audit-Befund 11.08. (B5): autoTune schrieb aus einem veralteten Stand.
 *
 * ── Der Ablauf, um den es geht ────────────────────────────────────────────
 *
 * `tuneAll` liest ALLE Konten mit laufender Engine einmal zu Beginn und
 * arbeitet sie dann der Reihe nach ab. Je Konto folgen mehrere Netzrunden:
 * Flotte lesen, bis zu 400 Trades lesen, Journal schreiben. Zwischen dem
 * Snapshot und dem Schreibvorgang liegen also leicht Minuten.
 *
 * Geschrieben wurde `settings.strategy` KOMPLETT aus diesem alten Stand plus
 * der einen Tuner-Änderung. Wer in der Zwischenzeit in der App etwas
 * einstellte, verlor es — ohne Meldung, ohne Spur, und ohne dass es später
 * jemandem auffiele: Die Oberfläche zeigt einfach wieder den alten Wert.
 *
 * ── Der scharfe Fall ──────────────────────────────────────────────────────
 *
 * `engine.running` wurde ausdrücklich aus der alten Fassung zurückgeschrieben
 * („Schalter gehört dem Owner"). Wer die Engine um 17:45 abschaltet — der
 * Moment, in dem der Tuner läuft — hätte sie eine Minute später wieder an
 * gehabt. Ein Not-Aus, der sich selbst zurücknimmt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_STRATEGY, type Strategy } from '../../shared/src/index.js';
import { basisUnveraendert, markiereNichtUebernommen } from '../src/scheduled/autoTune.js';
import type { JournalEntry } from '../src/core/tuneFleet.js';

const s = (patch: (k: Strategy) => void = () => {}): Strategy => {
  const k = structuredClone(DEFAULT_STRATEGY) as Strategy;
  patch(k);
  return k;
};

describe('basisUnveraendert', () => {
  it('gleiche Strategie ⇒ unverändert', () => {
    expect(basisUnveraendert(s(), s())).toBe(true);
  });

  it('ein geänderter Parameter ⇒ verändert', () => {
    expect(basisUnveraendert(s((k) => (k.indicators.rsi.period = 21)), s())).toBe(false);
  });

  it('eine geänderte Watchlist ⇒ verändert', () => {
    // Der häufigste Eingriff überhaupt und einer, der den Handel sofort
    // betrifft.
    expect(basisUnveraendert(s((k) => k.watchlist.push('TSLA')), s())).toBe(false);
  });

  it('eine geänderte Positionsgröße ⇒ verändert', () => {
    expect(basisUnveraendert(s((k) => (k.engine.maxPositionPct = 5)), s())).toBe(false);
  });

  it('NUR der Engine-Schalter ⇒ zählt als unverändert', () => {
    /* Ihn umzulegen ist die häufigste und harmloseste Änderung. Zählte er
     * als „Basis geändert", verlöre der Tuner seine Beförderung wegen eines
     * Klicks, der mit den Parametern nichts zu tun hat. Stattdessen wird er
     * beim Schreiben aus dem frischen Stand übernommen. */
    expect(basisUnveraendert(s((k) => (k.engine.running = false)), s((k) => (k.engine.running = true)))).toBe(
      true,
    );
  });

  it('ein fehlendes Dokument ⇒ verändert (nicht schreiben)', () => {
    // Im Zweifel nicht schreiben: Ein Konto ohne Strategie ist nichts, worauf
    // eine Beförderung passt.
    expect(basisUnveraendert(undefined, s())).toBe(false);
  });

  it('die Schlüsselreihenfolge spielt keine Rolle', () => {
    // Firestore gibt Maps nicht zwingend in derselben Reihenfolge zurück wie
    // geschrieben. Ein naiver JSON-Vergleich meldete dann „geändert", der
    // Tuner käme nie mehr zum Zug — und niemand sähe warum.
    const a = s();
    const b = JSON.parse(
      JSON.stringify({ signals: a.signals, engine: a.engine, indicators: a.indicators, ...a }),
    ) as Strategy;
    expect(basisUnveraendert(b, a)).toBe(true);
  });

  it('rührt die übergebenen Objekte nicht an', () => {
    // Der Vergleich blendet `running` aus — täte er das am Original, stünde
    // hinterher der falsche Schalter im Objekt, das gleich geschrieben wird.
    const frisch = s((k) => (k.engine.running = true));
    const basis = s((k) => (k.engine.running = true));
    basisUnveraendert(frisch, basis);
    expect(frisch.engine.running).toBe(true);
    expect(basis.engine.running).toBe(true);
  });

  it('unterscheidet auch tief verschachtelte Werte', () => {
    expect(
      basisUnveraendert(s((k) => (k.signals.forecastWeight = 0.9)), s((k) => (k.signals.forecastWeight = 0.3))),
    ).toBe(false);
  });
});

/* Die reine Funktion allein reicht nicht: Sie könnte richtig entscheiden und
 * trotzdem nirgends gefragt werden. Und ein Lesen VOR der Transaktion wäre
 * wertlos — dann prüfte man einen Stand, der beim Schreiben schon wieder alt
 * sein kann. Genau darum geht der Befund. */
describe('Quelltext: die Übernahme läuft in einer Transaktion', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'autoTune.ts');
  const block = (): string => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('const uebernommen = await db.runTransaction(');
    expect(ab, 'Transaktion nicht gefunden').toBeGreaterThan(0);
    return text.slice(ab, text.indexOf('await schreibeJournal(', ab));
  };

  it('liest den Stand INNERHALB der Transaktion frisch', () => {
    expect(block()).toContain('await tx.get(userDoc.ref)');
  });

  it('vergleicht ihn gegen die Basis der Entscheidung', () => {
    expect(block()).toContain('basisUnveraendert(jetztGeclampt, base)');
  });

  it('schreibt Strategie UND Flotten-Reset im selben Zug', () => {
    /* Getrennt gäbe es einen Moment, in dem die neue Basis gegen
     * Schattenkonten der alten geprüft würde — und der nächste Lauf
     * entschiede auf Zahlen aus zwei verschiedenen Welten. */
    const b = block();
    expect(b).toContain('tx.set(userDoc.ref, { settings: { strategy: neu } }, { merge: true })');
    expect(b).toContain('tx.set(fleetRef,');
  });

  it('nimmt den Engine-Schalter aus dem FRISCHEN Stand', () => {
    // Der Kern des scharfen Falls. `base.engine.running` bleibt nur als
    // Rückfall für ein Dokument ohne lesbaren Schalter.
    const b = block();
    expect(b).toContain('const schalter = jetzt?.engine?.running;');
    expect(b).toContain("typeof schalter === 'boolean' ? schalter : base.engine.running");
  });

  it('schreibt außerhalb der Transaktion nicht mehr an settings.strategy', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toContain('await userDoc.ref.set({ settings: { strategy: neu } }');
  });

  it('stellt eine verworfene Übernahme im Journal richtig', () => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('if (uebernommen) {');
    const b = text.slice(ab, text.indexOf('await schreibeJournal(', ab));
    expect(b).toContain('markiereNichtUebernommen(entries, winner.id)');
  });

  it('und das Journal wird trotzdem geschrieben', () => {
    // Ein Sprung aus der Konto-Schleife hätte die Prüfergebnisse ALLER
    // Varianten mit verschluckt — auch die der abgelehnten, die den Tuner
    // erst nachvollziehbar machen.
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('if (uebernommen) {');
    const bis = text.indexOf('await schreibeJournal(', ab);
    expect(bis).toBeGreaterThan(ab);
    expect(text.slice(ab, bis)).not.toMatch(/\b(continue|return)\b/);
  });
});

describe('markiereNichtUebernommen', () => {
  const eintrag = (variantId: string, promoted: boolean): JournalEntry => ({
    at: '2026-08-11T21:45:00Z',
    variantId,
    change: 'RSI-Periode 14 → 21',
    reason: 'Vorsprung 1,2 %, p=0,03',
    promoted,
    p: 0.03,
    edge: 1.2,
    nCandidate: 40,
    nIncumbent: 60,
  });

  it('setzt promoted der Siegerin zurück', () => {
    const entries = [eintrag('a', true)];
    markiereNichtUebernommen(entries, 'a');
    expect(entries[0]!.promoted).toBe(false);
  });

  it('nennt den Grund, statt die Begründung zu ersetzen', () => {
    // Die Zahlen der Prüfung bleiben — sie sind weiterhin wahr.
    const entries = [eintrag('a', true)];
    markiereNichtUebernommen(entries, 'a');
    expect(entries[0]!.reason).toContain('p=0,03');
    expect(entries[0]!.reason).toContain('nicht übernommen');
  });

  it('lässt die abgelehnten Varianten in Ruhe', () => {
    const entries = [eintrag('a', true), eintrag('b', false)];
    markiereNichtUebernommen(entries, 'a');
    expect(entries[1]!.reason).toBe('Vorsprung 1,2 %, p=0,03');
    expect(entries[1]!.promoted).toBe(false);
  });

  it('eine unbekannte Kennung ändert nichts', () => {
    const entries = [eintrag('a', true)];
    markiereNichtUebernommen(entries, 'x');
    expect(entries[0]!.promoted).toBe(true);
  });
});
