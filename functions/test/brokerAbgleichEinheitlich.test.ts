/**
 * Ein Konto, zwei Ansichten, EINE Antwort.
 *
 * ── Der Fehler, den das verhindert ────────────────────────────────────────
 *
 * Derselbe Abgleich läuft an zwei Stellen: `brokerAbgleich.ts` fährt ihn im
 * Scan (und speist damit den Heartbeat und die Einstiegs-Sperre),
 * `brokerStatus.ts` fährt ihn auf Knopfdruck für die Broker-Karte. Beide
 * riefen `abgleich()` — aber nur die erste filterte vorher auf die
 * Positionen, die WIRKLICH über den Broker entstanden sind.
 *
 * Die Folge war ein Widerspruch, den niemand auflösen konnte: Der Heartbeat
 * meldete `drift: 2, sauber: 0`, während in der App nichts fehlte — oder
 * umgekehrt, je nachdem, wer zuerst hinsah. Jede legitime Papier-Position
 * (aus der Zeit vor dem Verbinden, oder aus einem der Papier-Pfade in
 * `broker.ts`) erschien in der ungefilterten Ansicht als Fehlbestand. Ein
 * Warnzeichen, das dauerhaft leuchtet, obwohl nichts kaputt ist, macht blind
 * für den einen Fall, in dem wirklich etwas fehlt — und das ist der Fall, in
 * dem die Engine mit einer Deckung rechnet, die es nicht gibt.
 *
 * ── Warum der Quelltext-Teil dazugehört ───────────────────────────────────
 *
 * Die Verhaltenstests unten nageln `bestandsAbgleich()` fest. Sie sagen aber
 * nichts darüber, ob die beiden Aufrufstellen sie auch BENUTZEN — genau das
 * war der ursprüngliche Fehler. Wer künftig wieder `abgleich()` direkt ruft,
 * umgeht den Filter, ohne einen dieser Tests zu brechen. Deshalb prüft der
 * letzte Block statisch, dass beide Dateien durch die gemeinsame Funktion
 * gehen und keine von ihnen das rohe `abgleich()` importiert.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { abgleich, bestandsAbgleich, nurBrokerPositionen } from '../src/core/alpacaBroker.js';

/** Bestand beim Broker, wie ihn `alpacaPositionen()` liefert. */
const brokerPos = [
  { symbol: 'AAPL', qty: 10, seite: 'long' as const, avgEntry: 190, marktwert: 2000 },
];

describe('bestandsAbgleich — Papier-Positionen erzeugen keine Abweichung', () => {
  it('meldet nichts, wenn die Papier-Position dem Broker unbekannt ist', () => {
    const eigene = [
      { symbol: 'AAPL', qty: 10, side: 'long', broker: true },
      // Vor dem Verbinden im eigenen Buch entstanden — der Broker hat sie nie
      // gesehen und wird sie nie sehen.
      { symbol: 'MSFT', qty: 5, side: 'long' },
    ];
    expect(bestandsAbgleich(eigene, brokerPos)).toEqual([]);
  });

  it('meldet sie dagegen, wenn man den Filter umgeht — das war der Fehler', () => {
    // Dieser Test ist der Gegenbeleg: Er zeigt, dass der Filter tatsächlich
    // etwas tut. Ohne ihn stünde hier MSFT als Fehlbestand.
    const eigene = [
      { symbol: 'AAPL', qty: 10, side: 'long', broker: true },
      { symbol: 'MSFT', qty: 5, side: 'long' },
    ];
    const roh = abgleich(eigene, brokerPos);
    expect(roh.map((a) => a.symbol)).toEqual(['MSFT']);
  });

  it('behandelt broker: false wie fehlend — nur ein ausdrückliches true zählt', () => {
    const eigene = [{ symbol: 'MSFT', qty: 5, side: 'long', broker: false }];
    expect(bestandsAbgleich(eigene, [])).toEqual([]);
  });
});

describe('bestandsAbgleich — echte Abweichungen bleiben sichtbar', () => {
  it('findet den Fehlbestand: Buch führt broker-eröffnet, Broker hat nichts', () => {
    const eigene = [{ symbol: 'AAPL', qty: 10, side: 'long', broker: true }];
    const out = bestandsAbgleich(eigene, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'AAPL', eigeneMenge: 10, brokerMenge: 0, differenz: 10 });
  });

  it('findet den Fremdbestand: Broker hält, was im Buch fehlt', () => {
    const out = bestandsAbgleich([], brokerPos);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'AAPL', eigeneMenge: 0, brokerMenge: 10, differenz: -10 });
  });

  it('findet die Mengendifferenz auf einer broker-eröffneten Position', () => {
    const eigene = [{ symbol: 'AAPL', qty: 7, side: 'long', broker: true }];
    expect(bestandsAbgleich(eigene, brokerPos)[0]).toMatchObject({ differenz: -3 });
  });

  it('unterscheidet Long und Short bei gleicher Menge', () => {
    // Ein Short von 10 gegen einen Long von 10 ist keine Übereinstimmung,
    // sondern die größtmögliche Abweichung.
    const eigene = [{ symbol: 'AAPL', qty: 10, side: 'short', broker: true }];
    expect(bestandsAbgleich(eigene, brokerPos)[0]).toMatchObject({ differenz: -20 });
  });
});

describe('Beide Ansichten sehen dasselbe', () => {
  /**
   * Der eigentliche Regressionstest: gemischter Bestand, wie er real
   * vorkommt — broker-eröffnet, reines Papier, Sockel-Position. Egal wer
   * fragt, die Antwort muss dieselbe sein.
   */
  const gemischt = [
    { symbol: 'AAPL', qty: 10, side: 'long', broker: true },
    { symbol: 'MSFT', qty: 5, side: 'long' },
    { symbol: 'SPY', qty: 3, side: 'long', broker: false },
    { symbol: 'TLT', qty: 4, side: 'long', broker: true },
  ];

  it('liefert für denselben Bestand dieselbe Antwort, egal welche Ansicht fragt', () => {
    // Die Engine reicht `Position`-Dokumente hinein, die Karte ein
    // zusammengesetztes Objekt aus vier Feldern — auf beiden Wegen landet
    // dasselbe in `bestandsAbgleich`.
    const wieEngine = gemischt;
    const wieKarte = gemischt.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      side: p.side,
      broker: p.broker,
    }));
    expect(bestandsAbgleich(wieKarte, brokerPos)).toEqual(bestandsAbgleich(wieEngine, brokerPos));
  });

  it('und diese Antwort betrifft nur broker-eröffnete Symbole', () => {
    const out = bestandsAbgleich(gemischt, brokerPos);
    // AAPL stimmt überein, TLT fehlt beim Broker; MSFT und SPY sind Papier.
    expect(out.map((a) => a.symbol)).toEqual(['TLT']);
  });

  it('nurBrokerPositionen ist der Filter dahinter', () => {
    expect(nurBrokerPositionen(gemischt).map((p) => p.symbol)).toEqual(['AAPL', 'TLT']);
  });
});

describe('Quelltext: beide Aufrufstellen gehen durch die gemeinsame Funktion', () => {
  const dateien = [
    ['functions/src/core/brokerAbgleich.ts', join(import.meta.dirname, '..', 'src', 'core', 'brokerAbgleich.ts')],
    ['functions/src/callable/brokerStatus.ts', join(import.meta.dirname, '..', 'src', 'callable', 'brokerStatus.ts')],
  ] as const;

  for (const [name, pfad] of dateien) {
    it(`${name} ruft bestandsAbgleich`, () => {
      expect(readFileSync(pfad, 'utf8')).toContain('bestandsAbgleich(');
    });

    it(`${name} ruft nicht das ungefilterte abgleich()`, () => {
      const text = readFileSync(pfad, 'utf8');
      // Der Import ist die einzige Stelle, an der ein Umgehen entstehen kann
      // — steht `abgleich` nicht im Import, kann es auch nicht gerufen
      // werden. Der Prüfausdruck grenzt gegen `bestandsAbgleich` ab.
      const importe = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.[^']*alpacaBroker\.js'/g)]
        .flatMap((m) => (m[1] ?? '').split(','))
        .map((s) => s.replace(/\btype\b/, '').trim());
      expect(importe, `Importe aus alpacaBroker: ${importe.join(' | ')}`).not.toContain('abgleich');
    });
  }
});
