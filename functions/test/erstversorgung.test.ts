/**
 * Welche Symbole einen Kurs bekommen — und warum „Markt offen" nicht reicht.
 *
 * ── Der Live-Befund (11.08., Owner-Screenshot 08:31 deutscher Zeit) ───────
 *
 * Die Marktübersicht zeigte bei 128 von 132 Symbolen „--". Nur AAPL, MSFT,
 * NVDA und XOM hatten einen Kurs — genau die vier, die schon vor dem
 * Alpaca-Katalog-Umbau ein Dokument hatten.
 *
 * Die Ursache stand als Kommentar im Code und klang vernünftig: „Ein
 * geschlossener Markt kann keinen neuen Kurs haben." Für ein Symbol mit
 * Bestand stimmt das. Für ein Symbol OHNE Kurs ist es genau falsch herum —
 * dort ist der letzte Schlusskurs nicht redundant, sondern das Fehlende.
 *
 * Die 54 neuen US-Aktien kamen am Vorabend dazu, seither war der US-Markt
 * durchgehend geschlossen. Sie wären erst am nächsten Handelstag sichtbar
 * geworden — über ein Wochenende gut zwei Tage. Und das ist kein Randfall:
 * Wer in Europa morgens die App öffnet, sieht IMMER einen geschlossenen
 * US-Markt.
 */
import { describe, expect, it } from 'vitest';
import { zuVersorgende } from '../src/scheduled/scanMarket.js';

const KATALOG = ['AAPL', 'MSFT', 'AMD', 'INTC', 'BTC-USD', 'ETH-USD'];

describe('zuVersorgende', () => {
  it('holt alles, dessen Markt offen ist', () => {
    const out = zuVersorgende(KATALOG, ['BTC-USD', 'ETH-USD'], new Set(KATALOG));
    expect(out.sort()).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('holt zusätzlich alles, was noch NIE einen Kurs hatte', () => {
    // Der Live-Fall: Nachts ist nur Krypto offen, die neuen US-Aktien haben
    // noch keinen Kurs. Ohne diese Gruppe blieben sie bis 15:30 leer.
    const out = zuVersorgende(KATALOG, ['BTC-USD', 'ETH-USD'], new Set(['AAPL', 'BTC-USD', 'ETH-USD']));
    expect(out.sort()).toEqual(['AMD', 'BTC-USD', 'ETH-USD', 'INTC', 'MSFT']);
  });

  it('holt bei komplett leerem Bestand den ganzen Katalog', () => {
    expect(zuVersorgende(KATALOG, [], new Set()).sort()).toEqual([...KATALOG].sort());
  });

  it('holt nichts, wenn alles versorgt und alles geschlossen ist', () => {
    // Der Ruhezustand — nachts nach der Erstversorgung darf kein Symbol mehr
    // abgefragt werden, sonst ist der Kostenhebel weg.
    expect(zuVersorgende(KATALOG, [], new Set(KATALOG))).toEqual([]);
  });

  it('nennt kein Symbol doppelt, wenn es offen UND unversorgt ist', () => {
    const out = zuVersorgende(KATALOG, ['BTC-USD'], new Set(['AAPL', 'MSFT', 'AMD', 'INTC']));
    expect(out.filter((s) => s === 'BTC-USD')).toHaveLength(1);
    expect(out.sort()).toEqual(['BTC-USD', 'ETH-USD']);
  });
});

describe('Der Deckel auf die Erstversorgung', () => {
  const gross = Array.from({ length: 300 }, (_, i) => `S${i}`);

  it('begrenzt, wie viele Unversorgte ein Lauf nachholt', () => {
    expect(zuVersorgende(gross, [], new Set(), 40)).toHaveLength(40);
  });

  it('arbeitet sich über mehrere Läufe durch den Katalog', () => {
    // Ohne diesen Nachweis wäre der Deckel eine Sperre statt einer Bremse.
    const versorgt = new Set<string>();
    let laeufe = 0;
    while (versorgt.size < gross.length && laeufe < 20) {
      for (const s of zuVersorgende(gross, [], versorgt, 40)) versorgt.add(s);
      laeufe++;
    }
    expect(versorgt.size).toBe(gross.length);
    expect(laeufe).toBe(Math.ceil(gross.length / 40));
  });

  it('begrenzt NICHT die offenen Märkte — die dürfen alle', () => {
    // Der Deckel gilt der Erstversorgung. Ein offener Markt muss vollständig
    // versorgt werden, sonst hinkt die Hälfte des Katalogs dem Kurs
    // hinterher.
    expect(zuVersorgende(gross, gross, new Set(gross), 40)).toHaveLength(300);
  });

  it('behandelt einen Deckel von 0 als „keine Erstversorgung", nicht als Fehler', () => {
    expect(zuVersorgende(KATALOG, ['BTC-USD'], new Set(), 0)).toEqual(['BTC-USD']);
  });

  it('kommt mit einem negativen Deckel klar', () => {
    expect(zuVersorgende(KATALOG, [], new Set(), -5)).toEqual([]);
  });
});
