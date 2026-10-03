/**
 * Kapitaldeckel (Audit 13.08., Hochbefund 1): Einstiege rechnen mit
 * min(Buch, Broker), nicht mehr mit dem Buchstand allein.
 *
 * Der Anlassfall (Owner-Screenshot 12.08.): Buch +39 311 $, Alpaca
 * −45 286 $. `kontoAbgleich` berechnete das `sicheresCash` längst — aber
 * niemand LAS es: `sizeOrder` und die Deckungsprüfung nahmen weiter
 * `wallet.paperBalance`, und jeder weitere Kauf vergrößerte genau die
 * Lücke, die ihn erlaubt hatte.
 *
 * Teil 1 testet die pure Deckel-Funktion, Teil 2 hält die VERDRAHTUNG
 * fest — gegen die Fehlerklasse „Funktion korrekt, nur nicht angeschlossen",
 * die dieser Befund exakt war.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KAPITAL_DECKEL_STD, kapitalDeckel } from '../src/core/broker.js';

const jetzt = '2026-08-13T12:00:00.000Z';
const frisch = (sicheresCash: number): unknown => ({
  at: '2026-08-13T11:55:00.000Z',
  konto: { sicheresCash },
});

describe('kapitalDeckel — die pure Rechnung', () => {
  it('klemmt aufs Broker-Minimum, wenn der Abgleich frisch ist', () => {
    expect(kapitalDeckel(frisch(1_000), 39_311.17, jetzt)).toBe(1_000);
    // Der Anlassfall: Broker tief im Minus → es wird NICHTS mehr freigegeben.
    expect(kapitalDeckel(frisch(-45_286.34), 39_311.17, jetzt)).toBe(-45_286.34);
  });

  it('lässt das Buch gelten, wenn es ohnehin das Minimum ist', () => {
    expect(kapitalDeckel(frisch(50_000), 4_000, jetzt)).toBe(4_000);
  });

  it('fällt ohne Vermerk, ohne Kontoteil oder mit Unlesbarem aufs Buch zurück', () => {
    expect(kapitalDeckel(undefined, 4_000, jetzt)).toBe(4_000);
    expect(kapitalDeckel(null, 4_000, jetzt)).toBe(4_000);
    expect(kapitalDeckel({ at: jetzt }, 4_000, jetzt)).toBe(4_000);
    expect(kapitalDeckel({ at: jetzt, konto: { sicheresCash: 'x' } }, 4_000, jetzt)).toBe(4_000);
    expect(kapitalDeckel({ konto: { sicheresCash: 1 } }, 4_000, jetzt)).toBe(4_000);
  });

  it('lässt einen abgelaufenen Vermerk nicht ewig weiterklemmen', () => {
    const alt = {
      at: new Date(Date.parse(jetzt) - (KAPITAL_DECKEL_STD + 1) * 3_600_000).toISOString(),
      konto: { sicheresCash: 1 },
    };
    expect(kapitalDeckel(alt, 4_000, jetzt)).toBe(4_000);
  });

  it('traut einem Zukunfts- oder Kauderwelsch-Stempel nur in die konservative Richtung', () => {
    // Unlesbares oder zukünftiges `at` beweist NICHT, dass der Vermerk alt
    // ist — der Deckel gilt dann trotzdem.
    expect(kapitalDeckel({ at: '9999-01-01T00:00:00Z', konto: { sicheresCash: 1 } }, 4_000, jetzt)).toBe(1);
    expect(kapitalDeckel({ at: 'kaputt', konto: { sicheresCash: 1 } }, 4_000, jetzt)).toBe(1);
  });
});

describe('Kapitaldeckel — die Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const broker = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');
  const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

  it('executePaperTrade: BEIDE Einstiegs-Pfade sizen und prüfen mit der Deckung', () => {
    // Zwei Einstiegs-Pfade (Kauf + Short-Eröffnung) → zweimal Sizing auf
    // `deckung`, keinmal mehr auf `balance`.
    expect(broker.match(/sizeOrder\(strategy, deckung,/g)?.length).toBe(2);
    expect(broker).not.toContain('sizeOrder(strategy, balance,');
    expect(broker).toContain('cost > deckung');
    expect(broker).toContain('margin > deckung');
    // Die Wallet-Buchung bleibt beim ECHTEN Buchstand — geklemmte Buchungen
    // machten das Buch zum Lügner.
    expect(broker).toContain("'wallet.paperBalance': roundCents(balance - cost)");
  });

  it('executePaperTrade liest den Deckel aus dem Abgleich-Vermerk', () => {
    expect(broker).toContain("kapitalDeckel(userSnap.get('risk.abgleich'), balance, now)");
  });

  it('scanMarket: das Hebel-Budget speist sich aus dem gedeckelten Cash', () => {
    expect(scan).toMatch(/const kontoCash = kapitalDeckel\(/);
  });

  it('executeTrade: auch die ECHTE Order bemisst sich am gedeckelten Kapital (Red-Team 20.08.)', () => {
    /* Rest von Hochbefund 1: Der Deckel vom 13.08. saß nur im Buchungspfad —
     * die reale Alpaca-Order wurde weiter am ungedeckelten Buchstand
     * bemessen. Beim Anlassfall-Konto ging sie in voller Größe raus; ein
     * Margin-Konto füllt so etwas auf Kredit. Gedeckelt wird NUR das
     * Einstiegs-Sizing (planeMenge): Schließende Mengen kommen aus der
     * Position, eine ausdrückliche req.qty bleibt unangetastet — Exits
     * werden nie erschwert. */
    expect(broker).toContain('const deckelOrder = kapitalDeckel(');
    expect(broker).toMatch(/planeMenge\(req, strategy, \{\s*balance: deckelOrder,/);
  });
});
