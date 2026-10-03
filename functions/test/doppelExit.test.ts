/**
 * Audit-Befund 11.08.: Puls und Scan konnten denselben Exit zweimal zum
 * Broker routen — und aus einem gewollten Ausstieg wurde ein ungewollter
 * Short.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Die Idempotenz beim Broker hängt an der `clientOrderId`, und die enthält
 * die Kennung des LAUFS:
 *
 *   riskPulse    jede Minute      `puls-2026-08-11T10:03Z`
 *   scanMarket   alle 5 Minuten   `2026-08-11T10:03Z`
 *
 * Beide sind minutengenau — aber verschieden. Für Alpaca sind das zwei
 * Orders, und weil der Puls jede Minute und der Scan alle fünf läuft,
 * überlappen sie sich zwangsläufig.
 *
 * Die Abfolge:
 *
 *   10:03:00  Der Puls liest `positions/AAPL`, `riskExitReason` feuert,
 *             `routeOrder` geht raus. `warteAufFill` pollt bis zu 6 × 700 ms
 *             — die Position steht in Firestore also noch rund vier Sekunden.
 *   10:03:02  Der laufende Scan erreicht dieselbe Position, liest sie als
 *             offen, feuert ebenfalls, zweite echte Order.
 *   danach    Beide Fills laufen: 10 Stück verkauft, 10 weitere LEERverkauft.
 *             Der Puls bucht, der Scan bekommt `keine_position` und schreibt
 *             nur `unbookedFills`.
 *
 * Übrig bleibt ein echter Short über −10 Stück beim Broker, ohne Stop und
 * ohne Buchung. Der Abgleich stuft ihn als harmlos ein: Bei eigener Menge 0
 * ist er weder Fehl- noch Doppelbestand, landet in `fremdbestand` und löst
 * keine Sperre aus.
 *
 * Der Modulkopf von `broker.ts` beschreibt genau dieses Risiko — für einen
 * anderen Fall: „aus einem gewollten Ausstieg würde ein ungewollter Einstieg
 * in die Gegenrichtung, mit echtem Risiko und ohne Stop".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auftragsLauf } from '../src/core/broker.js';
import { clientOrderId } from '../src/core/alpacaBroker.js';

/** Die beiden Kennungen, wie Puls und Scan sie für dieselbe Minute bilden. */
const PULS = 'puls-2026-08-11T10:03Z';
const SCAN = '2026-08-11T10:03Z';

const POS = { openedAt: '2026-08-06T14:00:00Z' };
const EXIT = { riskExit: 'stop_loss' };

describe('Ein Risiko-Exit hängt an der Position, nicht am Lauf', () => {
  it('Puls und Scan erzeugen dieselbe Kennung — der eigentliche Befund', () => {
    expect(auftragsLauf(EXIT, POS, PULS)).toBe(auftragsLauf(EXIT, POS, SCAN));
  });

  it('und damit dieselbe Order-Kennung beim Broker', () => {
    // Die Stelle, an der die Idempotenz wirklich entschieden wird.
    const vomPuls = clientOrderId('u1', 'AAPL', 'sell', 10, auftragsLauf(EXIT, POS, PULS));
    const vomScan = clientOrderId('u1', 'AAPL', 'sell', 10, auftragsLauf(EXIT, POS, SCAN));
    expect(vomPuls).toBe(vomScan);
  });

  it('ohne den Fix wären es zwei verschiedene', () => {
    // Der Gegenbeweis: Genau dieser Unterschied war der Befund.
    expect(clientOrderId('u1', 'AAPL', 'sell', 10, PULS)).not.toBe(
      clientOrderId('u1', 'AAPL', 'sell', 10, SCAN),
    );
  });

  it('eine NEU eröffnete Position bekommt eine neue Kennung', () => {
    // Sonst könnte eine Position, die geschlossen und später wieder
    // eröffnet wurde, nie ein zweites Mal ausgestoppt werden: Alpaca hielte
    // die Order für eine Wiederholung und wiese sie ab.
    const spaeter = { openedAt: '2026-08-11T15:30:00Z' };
    expect(auftragsLauf(EXIT, POS, SCAN)).not.toBe(auftragsLauf(EXIT, spaeter, SCAN));
  });

  it('jeder Exit-Grund führt auf dieselbe Kennung', () => {
    // Puls und Scan können denselben Ausstieg verschieden benennen — der
    // eine sieht `stop_loss`, der andere `trailing_stop`, je nachdem wo der
    // Kurs beim Lesen stand. Es ist trotzdem derselbe Ausstieg.
    for (const grund of ['stop_loss', 'trailing_stop', 'take_profit', 'max_hold']) {
      expect(auftragsLauf({ riskExit: grund }, POS, SCAN)).toBe(auftragsLauf(EXIT, POS, PULS));
    }
  });
});

describe('Alles andere behält die Lauf-Kennung', () => {
  it('ein Einstieg ist an seinen Lauf gebunden', () => {
    // Zwei Scans, die dasselbe Symbol kaufen wollen, sind zwei
    // Entscheidungen — keine Wiederholung derselben. Würden sie unter einer
    // gemeinsamen Kennung laufen, verschluckte der Broker den zweiten Kauf.
    expect(auftragsLauf({}, null, SCAN)).toBe(SCAN);
    expect(auftragsLauf({}, POS, SCAN)).toBe(SCAN);
  });

  it('ein Handeingabe-Verkauf ebenso', () => {
    // Er trägt keinen `riskExit` — der Nutzer, der zweimal auf Verkaufen
    // klickt, meint auch zweimal.
    expect(auftragsLauf({ riskExit: undefined }, POS, SCAN)).toBe(SCAN);
    expect(auftragsLauf({ riskExit: '' }, POS, SCAN)).toBe(SCAN);
  });

  it('ohne Position bleibt es beim Lauf', () => {
    expect(auftragsLauf(EXIT, null, SCAN)).toBe(SCAN);
  });

  it('und bei einem Altbestand ohne openedAt auch', () => {
    // Bisheriges Verhalten statt einer geratenen Kennung: Ein Dokument ohne
    // Öffnungszeit gäbe keine stabile Bezugsgröße her.
    expect(auftragsLauf(EXIT, {}, SCAN)).toBe(SCAN);
    expect(auftragsLauf(EXIT, { openedAt: '' }, SCAN)).toBe(SCAN);
  });
});

/* Die reine Funktion allein reicht nicht — dieselbe Lehre wie bei
 * `pruefeFassung`, der Klassen-Kreuzung und `watchlistUnion`. Geprüft wird
 * deshalb, dass `executeTrade` die abgeleitete Kennung an ALLEN Stellen
 * benutzt: Bliebe eine bei `laufId`, wäre der Befund genau dort zurück —
 * und im Fall der Fehlerspur wäre er sogar unsichtbar, weil `unbookedFills`
 * dann eine Kennung nennt, unter der die Order nie lief. */
describe('Quelltext: executeTrade leitet die Kennung EINMAL ab', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'core', 'broker.ts');

  it('die Ableitung steht vor dem Routing', () => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('const lauf = auftragsLauf(req, position, laufId);');
    expect(ab, 'Ableitung in executeTrade nicht gefunden').toBeGreaterThan(0);
    expect(text.indexOf('const routing = await routeOrder(', ab)).toBeGreaterThan(ab);
  });

  it('und ab da benutzt niemand mehr die rohe Lauf-Kennung', () => {
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('const lauf = auftragsLauf(req, position, laufId);');
    const bis = text.indexOf('export async function executePaperTrade', ab);
    const block = text.slice(ab + 50, bis);
    // `laufId` darf hier nur noch als Wert von `laufId:` auftauchen, wenn
    // rechts `lauf` steht — ein nacktes `laufId,` wäre der alte Zustand.
    expect(block).not.toMatch(/(?<!: )\blaufId\b(?!:)/);
  });
});
