/**
 * Zwei Audit-Befunde vom 11.08. am Broker-Kern.
 *
 * Beide gehören zur Familie „eine Sache, zwei Antworten" — derselben, die in
 * dieser Woche schon den Broker-Abgleich, die Krypto-Schreibweise, die
 * Anteilsklassen, die Cache-Absagen und die Depotbewertung erwischt hat.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mengeZuKlein } from '../src/core/broker.js';

/* ── Befund A: Der Fill kam an, die Buchung lehnte ihn ab ──────────────────
 *
 * Die Mengen-Untergrenze stand zweimal im Code, mit verschiedenen Antworten:
 *
 *   executeTrade (Routing)    `asset?.fractionable ?? (klasse === 'crypto')`
 *   executePaperTrade (Buch)  `cls === 'crypto'`
 *
 * Seit dem Alpaca-Assets-Sync kennt die routende Schicht echte Bruchstücke
 * auch bei Aktien — die buchende nicht. Die Folge war kein abgelehnter Trade,
 * sondern ein AUSGEFÜHRTER, der nicht ankam.
 *
 * Der Weg, den ein Kauf über 0,25 NVDA nahm:
 *
 *   1. `planeMenge` rechnet mit `fractionable: true` ⇒ 0,249875 Stück
 *   2. `executeTrade` prüft gegen 1e-6 ⇒ passiert
 *   3. Alpaca füllt die Order ⇒ rund 200 $ real investiert
 *   4. `executePaperTrade` prüft gegen 1 (NVDA ist kein Krypto) ⇒ ABGELEHNT
 *
 * Übrig blieben ein `unbookedFills`-Dokument und ein `logger.error`. Keine
 * Position, kein Cash-Abzug, kein Schutz-Stop. Und weil der Cooldown nur bei
 * Erfolg gesetzt wird und keine Position entsteht, wiederholte der
 * 5-Minuten-Scan denselben Vorgang, solange das Kaufsignal stand — nach einer
 * Stunde lagen ~3 Stück beim Broker und im Buch stand nichts.
 */
describe('Befund A: mengeZuKlein — ein bestätigter Fill wird gebucht', () => {
  describe('ohne Fill (die Order geht erst raus)', () => {
    it('lehnt Bruchstücke bei unteilbaren Papieren ab', () => {
      expect(mengeZuKlein(0.25, false, false)).toBe(true);
      expect(mengeZuKlein(0.999, false, false)).toBe(true);
    });

    it('lässt ganze Stücke durch', () => {
      expect(mengeZuKlein(1, false, false)).toBe(false);
      expect(mengeZuKlein(42, false, false)).toBe(false);
    });

    it('lässt Bruchstücke durch, wo sie erlaubt sind', () => {
      expect(mengeZuKlein(0.25, true, false)).toBe(false);
      expect(mengeZuKlein(1e-6, true, false)).toBe(false);
    });

    it('aber auch dort nicht beliebig klein', () => {
      // Unterhalb der Alpaca-Granularität wäre die Order sinnlos.
      expect(mengeZuKlein(1e-9, true, false)).toBe(true);
      expect(mengeZuKlein(0, true, false)).toBe(true);
    });
  });

  describe('mit bestätigtem Fill (das Geld ist geflossen)', () => {
    it('bucht 0,25 Stück eines unteilbaren Papiers — der eigentliche Befund', () => {
      // Vorher: `true` ⇒ qty_unter_1 ⇒ FILL NICHT GEBUCHT.
      expect(mengeZuKlein(0.25, false, true)).toBe(false);
    });

    it('bucht auch sehr kleine Fills', () => {
      // Eine Teilausführung über 0,004 Stück ist real geflossen. Sie nicht zu
      // buchen hieße, den Kauf bestehen zu lassen und nur das Buch dahinter
      // zurückfallen zu lassen — genau die Lage, die zum Fremdbestand führt.
      expect(mengeZuKlein(0.004, false, true)).toBe(false);
      expect(mengeZuKlein(1e-9, false, true)).toBe(false);
    });

    it('lehnt aber eine Menge von NULL weiterhin ab', () => {
      // Eine Position über null Stück ist keine Position. Das ist die eine
      // Prüfung, die auch nach einem Fill sinnvoll bleibt.
      expect(mengeZuKlein(0, false, true)).toBe(true);
      expect(mengeZuKlein(-1, false, true)).toBe(true);
    });
  });

  it('lehnt NaN in JEDER Lage ab', () => {
    // Der alte Ausdruck war `qty < grenze` — und `NaN < 1` ist `false`, die
    // Menge wäre also durchgerutscht und hätte eine Position mit NaN Stück
    // angelegt. `!(qty >= grenze)` fängt sie.
    for (const fractional of [true, false]) {
      for (const fill of [true, false]) {
        expect(mengeZuKlein(Number.NaN, fractional, fill), `${fractional}/${fill}`).toBe(true);
      }
    }
  });
});

/* Die reine Funktion allein reicht nicht — dieselbe Lehre wie bei
 * `pruefeFassung` und der Klassen-Kreuzung. `executePaperTrade` läuft in
 * einer Firestore-Transaktion; ein Test, der sie nachbaut, prüfte am Ende die
 * Nachbildung. Geprüft wird deshalb, dass ALLE drei Prüfstellen durch die
 * gemeinsame Funktion laufen. Bliebe eine mit eigener Formel zurück, wäre der
 * Befund genau dort wieder da. */
describe('Quelltext: es gibt nur noch EINE Untergrenze', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'core', 'broker.ts');

  it('keine handgeschriebene Schwelle mehr neben der Funktion', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toContain('qty < (fractional ? 1e-6 : 1)');
  });

  it('jede Ablehnung mit qty_unter_1 stammt aus mengeZuKlein', () => {
    const text = readFileSync(pfad, 'utf8');
    const zeilen = text.split('\n');
    // Die Prüfung steht in der Zeile davor oder in derselben.
    for (const [i, zeile] of zeilen.entries()) {
      if (!zeile.includes("reason: 'qty_unter_1'")) continue;
      const umfeld = zeilen.slice(Math.max(0, i - 2), i + 1).join('\n');
      expect(umfeld, `Zeile ${i + 1}: eigene Schwelle statt mengeZuKlein`).toMatch(
        /mengeZuKlein\(|!\(qty > 0\)/,
      );
    }
  });

  it('und der Buchungspfad kennt den Unterschied zwischen Plan und Fill', () => {
    const text = readFileSync(pfad, 'utf8');
    // Beide Aufrufe in executePaperTrade müssen `echterFill` durchreichen —
    // sonst greift die Untergrenze weiter gegen einen bestätigten Fill.
    const treffer = text.match(/mengeZuKlein\(qty, fractional, echterFill\)/g) ?? [];
    expect(treffer.length, 'Kauf UND Short-Eröffnung müssen echterFill kennen').toBe(2);
  });
});

/* ── Befund B: Die Broker-Karte las das falsche Feld ───────────────────────
 *
 * `pruefeBrokerStatus` las `userDoc.get('settings')` statt
 * `get('settings.strategy')`. Unter `settings` liegen drei Dinge nebeneinander
 * — `strategy`, `ui`, `autoTune` —, die Hülle hat also weder `broker` noch
 * `engine`. Zwei Zeilen später greift `resolveBrokerMode` ungeschützt auf
 * `strategy.broker.mode` zu.
 *
 * Die Karte warf damit für JEDES Konto mit Profil; funktioniert hat nur der
 * Fallback auf `DEFAULT_STRATEGY` — also ausgerechnet der Fall ohne
 * `settings`. Es war die einzige Stelle in `functions/src`, die `settings` als
 * Strategie las.
 */
describe('Befund B: die Broker-Karte liest settings.strategy', () => {
  it('nirgends in functions/src wird `settings` als Strategie gelesen', () => {
    const pfade = [
      join(import.meta.dirname, '..', 'src', 'callable', 'brokerStatus.ts'),
      join(import.meta.dirname, '..', 'src', 'core', 'broker.ts'),
    ];
    for (const p of pfade) {
      expect(readFileSync(p, 'utf8'), p).not.toContain("get('settings')");
    }
  });

  it('pruefeBrokerStatus holt die Strategie aus settings.strategy', () => {
    const text = readFileSync(
      join(import.meta.dirname, '..', 'src', 'callable', 'brokerStatus.ts'),
      'utf8',
    );
    const ab = text.indexOf('export async function pruefeBrokerStatus');
    expect(ab).toBeGreaterThan(0);
    const bis = text.indexOf('resolveBrokerMode(', ab);
    expect(text.slice(ab, bis)).toContain("get('settings.strategy')");
  });
});

/* ── Befund C: „Depot nicht abrufbar" sah aus wie „stimmt überein" ─────────
 *
 * `alpacaPositionen(...).catch(() => [])` machte aus einem gescheiterten
 * Abruf ein leeres Depot. Der Abgleich fand dann erwartungsgemäß keine
 * Abweichung, und die Karte meldete „Eigenes Buch und Broker-Depot stimmen
 * überein."
 *
 * Dasselbe Muster, das `brokerAbgleich.ts` an seiner Stelle ausdrücklich
 * aufgelöst hat: „Ohne sie sähe ein Konto, dessen Broker seit Stunden nicht
 * antwortet, exakt so aus wie eines ganz ohne Broker." Im Callable stand es
 * noch — und es ist dieselbe Familie wie `verbindungUnlesbar` aus Paket 1.
 *
 * Der Fall ist nicht konstruiert: Nach einem Reset ist das Buch leer, beim
 * Broker liegen Positionen (der Vorfall vom 05.08., der `adoptBroker` nötig
 * machte). Antwortet `/v2/account`, aber `/v2/positions` läuft in einen
 * Timeout, sah der Nutzer eine Unbedenklichkeitsbescheinigung.
 */
describe('Befund C: unlesbares Depot ist kein leeres Depot', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'callable', 'brokerStatus.ts');

  it('der Fehlschlag wird als solcher festgehalten, nicht zu [] geglättet', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toContain('alpacaPositionen(modus, keys).catch(() => [])');
    expect(text).toContain('lesbar: false as const');
  });

  it('die Meldung nennt den Unterschied', () => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('teile.push(');
    const bis = text.indexOf('logger.info(', ab);
    const block = text.slice(text.lastIndexOf('teile.push(', bis), bis);
    expect(block).toContain('!depot.lesbar');
    expect(block).toContain('UNBEKANNT');
  });

  it('und das Log ebenso', () => {
    // Sonst wäre der Befund nur von der Meldung in die Diagnose gewandert:
    // „abweichungen=0" hieße weiter zweierlei.
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('brokerStatus ${uid}: modus=');
    expect(ab).toBeGreaterThan(0);
    expect(text.slice(ab, ab + 400)).toContain("depot.lesbar ? abweichungen.length : 'unbekannt'");
  });
});
