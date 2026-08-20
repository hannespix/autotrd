/**
 * Sockel-Nachschub (Owner 20.08.: „das Ziel ist, Depot und Geld arbeiten zu
 * lassen — es geht nicht darum, alles als Bargeld liegen zu lassen").
 *
 * Der Befund: `rebalanceOrders` ist ein reiner Bestands-Diff — es kauft
 * FEHLENDE Ziel-Symbole und verkauft, was nicht mehr ins Ziel gehört.
 * Eine GEHALTENE Position wurde nie ans Zielgewicht nachgekauft. Drei Wege
 * führten deshalb dauerhaft in Bargeld: anteilig ausgeführte Erstkäufe
 * (zu wenig Cash am Kauftag) blieben für immer klein, wachsende Equity
 * vergrößerte nur den Bargeld-Rest, und Cash aus Exits der aktiven Engine
 * fand nie in den Sockel zurück.
 *
 * `nachschubOrders` schließt die Lücke — bewusst eng: NUR Käufe (Gewinner
 * über Zielgewicht werden nicht gestutzt — das wäre ein Kosten-Roundtrip
 * am stärksten Papier), nur im wöchentlichen Rebalance-Takt, und nur wenn
 * die Position mehr als NACHSCHUB_TOLERANZ unter ihrem Ziel liegt.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  NACHSCHUB_TOLERANZ,
  nachschubOrders,
  rebalanceOrders,
  type TargetPosition,
} from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));
const ziel: TargetPosition[] = [
  { symbol: 'AAA', weight: 0.5 },
  { symbol: 'BBB', weight: 0.5 },
];

describe('nachschubOrders — die pure Rechnung', () => {
  it('kauft die Differenz zum Zielgewicht, wenn die Position deutlich drunter liegt', () => {
    // Budget 10.000, Ziel je 5.000 — AAA steht bei 2.000 (60 % drunter).
    const orders = nachschubOrders(new Map([['AAA', 2000], ['BBB', 5000]]), ziel, 10_000);
    expect(orders).toEqual([{ symbol: 'AAA', side: 'buy', notional: 3000 }]);
  });

  it('innerhalb des Toleranzbands passiert NICHTS — kein Nachjustieren auf den Cent', () => {
    // 4.000 von 5.000 = 20 % drunter, Toleranz 25 %: kein Kauf. Genau die
    // Grenze, die den Nachschub vom Cent-Nachjustieren trennt, dessen
    // Kosten die Auswertung vom 27.07. verurteilt hat.
    const orders = nachschubOrders(new Map([['AAA', 4000], ['BBB', 5000]]), ziel, 10_000);
    expect(orders).toEqual([]);
    expect(NACHSCHUB_TOLERANZ).toBe(0.25);
  });

  it('verkauft NIE — eine Position über Zielgewicht bleibt unangetastet', () => {
    // Der Gewinner des Portfolios (9.000 von 5.000) wird nicht gestutzt.
    const orders = nachschubOrders(new Map([['AAA', 9000], ['BBB', 500]]), ziel, 10_000);
    expect(orders.every((o) => o.side === 'buy')).toBe(true);
    expect(orders).toEqual([{ symbol: 'BBB', side: 'buy', notional: 4500 }]);
  });

  it('fehlende Symbole sind Sache von rebalanceOrders — keine Doppel-Order', () => {
    // AAA wird gar nicht gehalten: rebalanceOrders kauft es voll ein,
    // nachschubOrders schweigt. Zusammen ergibt das genau EINE Order je
    // Symbol — sonst kaufte der Lauf das Zielgewicht zweimal.
    const bestand = new Map([['BBB', 1000]]);
    const neu = rebalanceOrders(new Set(bestand.keys()), ziel, 10_000);
    const nach = nachschubOrders(bestand, ziel, 10_000);
    expect(neu.map((o) => o.symbol)).toEqual(['AAA']);
    expect(nach.map((o) => o.symbol)).toEqual(['BBB']);
  });

  it('Shorts und kaputte Werte werden übersprungen, leeres Budget kauft nichts', () => {
    expect(nachschubOrders(new Map([['AAA', -500], ['BBB', 0]]), ziel, 10_000)).toEqual([]);
    expect(nachschubOrders(new Map([['AAA', 100]]), ziel, 0)).toEqual([]);
    expect(nachschubOrders(new Map([['AAA', 100]]), ziel, -5)).toEqual([]);
  });
});

describe('die Verdrahtung — alle drei Bücher rechnen mit derselben Mechanik', () => {
  const momentumRun = readFileSync(
    join(hier, '../src/scheduled/momentumRun.ts'),
    'utf8',
  );

  it('Schatten-Book, Momentum-Wallets und Kern-Sockel rufen nachschubOrders', () => {
    /* Drei Stellen, ein Zweck: Würde nur der Sockel nachgekauft, beweise
     * der Schatten eine Strategie, die niemand fährt — und umgekehrt.
     * Die Zahl ist exakt gepinnt, damit ein still gelöschter Aufruf
     * auffällt und ein vierter Aufrufer sich hier begründen muss. */
    const treffer = momentumRun.match(/nachschubOrders\(/g) ?? [];
    expect(treffer.length).toBe(3);
  });

  it('Aufstockungen zählen nicht gegen das Positionslimit — sie öffnen nichts', () => {
    /* Ohne die Ausnahme könnte ein volles Depot (offenZahl == posLimit)
     * nie ans Zielgewicht zurück: Das Limit begrenzt, wie viele Positionen
     * OFFEN sind — ein Nachkauf ändert diese Zahl nicht. Beide Hüllen
     * (Momentum-Wallet und Sockel) tragen dieselbe Regel. */
    expect(momentumRun.match(/if \(!aufstockung && offenZahl >= posLimit\) continue;/g) ?? [])
      .toHaveLength(2);
    expect(momentumRun.match(/if \(!aufstockung\) offenZahl \+= 1;/g) ?? []).toHaveLength(2);
  });

  it('die Sockel-Besitzgrenze bleibt: Engine-Positionen kauft der Sockel weiter nicht', () => {
    // Der Nachschub-Umbau hat die Zeile umformuliert (aufstockung ==
    // sockel.has) — die Bedeutung muss identisch geblieben sein: Ein
    // Symbol, das die AKTIVE Engine hält, bleibt für Sockel-Käufe tabu.
    expect(momentumRun).toContain('if (alle.has(o.symbol) && !aufstockung) continue;');
  });
});
