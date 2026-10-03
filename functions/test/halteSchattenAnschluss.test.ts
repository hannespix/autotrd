/**
 * Anschluss-Wächter: Hängt die Regler-ENTSCHEIDUNG wirklich am
 * haltedauer-gerechten Schatten? (17.08.)
 *
 * Die pure Mechanik steht in `shared/src/classShadow.ts` und ist dort
 * getestet. Was diese Datei prüft, ist das, was eine reine Funktions-Prüfung
 * nie sehen kann: dass der Scan den Halte-Slot tatsächlich schreibt, mit der
 * Klassen-Haltedauer bewertet, in ein EIGENES Aggregat schreibt — und dass
 * `snapshotEquity` genau dieses Aggregat liest.
 *
 * Ohne den letzten Schritt wäre der ganze Umbau ein zweites Feld in
 * Firestore, das niemand fragt, und die Kapitalentscheidung liefe weiter über
 * die Fünf-Minuten-Messung. Das ist kein hypothetischer Fehler: Genau so ist
 * `live_tag` seit dem 05.08. eine reine Beobachtungsreihe geblieben.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');

describe('scanMarket: der Halte-Slot wird geführt', () => {
  it('der Horizont kommt aus der LIVE-Sperre, nicht aus einer eigenen Konstante', () => {
    expect(scan).toContain(
      "wirksameMindesthalte(DEFAULT_STRATEGY.engine.minHoldMin, classify(symbol)) * 60_000",
    );
    expect(scan).toContain('const halteSlot = pruefeHalteSlot(');
    expect(scan).toContain("symDoc.get('lastSignalHalte')");
  });

  it('ein reifer Slot wird IMMER verbraucht — über dieselbe Aktion wie der Tages-Slot', () => {
    // Der Doppelzähl-Defekt vom 07.08.: Ein reifer Slot, der bei `hold`
    // liegen blieb, wurde alle fünf Minuten erneut bewertet. `tagSlotAktion`
    // ist die Stelle, die das verhindert — der Halte-Slot MUSS sie benutzen
    // und nicht seine eigene Fassung bekommen.
    expect(scan).toContain('const halteAktion = tagSlotAktion(halteSlot.status, sig.direction);');
    expect(scan).toContain("...(halteAktion === 'neu'");
    expect(scan).toContain("? { lastSignalHalte: FieldValue.delete() }");
  });

  it('bewertet wird mit Maker+Taker, nicht mit zweimal Taker', () => {
    expect(scan).toContain('roundtripFeeRateForClass(kl),');
    // Und der alte Pfad bleibt exakt wie er war — die Fünf-Minuten-Reihe
    // trägt 1 087 Signale, die mit 2 × Taker gerechnet wurden.
    expect(scan).toContain('const kosten = feeRateForClass(classify(symbol)) * 2;');
  });

  it('die Beiträge landen in einem EIGENEN Aggregat, nie in der alten Summe', () => {
    expect(scan).toContain(
      'schattenHalteKlassen[kl] = addiereSchatten(schattenHalteKlassen[kl], beitragHalte);',
    );
    expect(scan).toContain("klassenHalte: schattenInkremente(schattenHalteKlassen)");
    // Zwei Messvorschriften in einer Summe wären ein Mittelwert ohne
    // Bedeutung — an dem Kapital hängt.
    expect(scan).not.toContain('schattenKlassen[kl] = addiereSchatten(schattenKlassen[kl], beitragHalte)');
  });

  it('der Slot-Bestand ist im Heartbeat ablesbar', () => {
    // Bei `live_tag` fehlte diese Diagnose zwei Tage lang, und die Frage
    // „warum stehen da nur 10 Signale?" war ohne sie nicht zu beantworten.
    expect(scan).toContain('signalHalte: halteZaehler,');
    expect(scan).toContain('halteZaehler[halteSlot.status] += 1;');
  });

  it('die haltedauer-gerechte Kante steht im öffentlichen Heartbeat', () => {
    expect(scan).toContain('schattenHalte: schattenHalteStand,');
  });
});

describe('snapshotEquity: die Entscheidung liest die richtige Reihe', () => {
  it('der Schatten-BELEG kommt aus klassenHalte', () => {
    expect(snapshot).toContain(
      "const roh = (doc.get('klassenHalte') as Record<string, SchattenKlasse> | undefined) ?? {};",
    );
    // Genau eine Zeile darf `schattenGlobal` füllen, und sie muss aus `roh`
    // kommen — die alte Reihe steht nur noch zum Auffüllen der Liste bereit.
    expect(snapshot).toContain('schattenGlobal = Object.fromEntries(\n      Object.entries(roh).map');
  });

  it('die alte Reihe darf die Liste füllen, aber nichts belegen', () => {
    expect(snapshot).toContain('schattenKlassenBekannt = [...new Set([...Object.keys(roh), ...Object.keys(rohAlt)])];');
    expect(snapshot).toContain('ergebnisse[klasse] ??= { n: 0, kantePct: null, ...(s ? { schatten: s } : {}) };');
  });

  it('der Schatten geht unverändert als `schatten` in die Bewertung', () => {
    // Er darf ausschließlich ZURÜCKHOLEN (classAdvisor Schritt 2) — diese
    // Zeile ist der einzige Weg dorthin.
    expect(snapshot).toContain('...(schattenGlobal[klasse] ? { schatten: schattenGlobal[klasse] } : {}),');
  });
});
