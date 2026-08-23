/**
 * Eine Entscheidung, ein Eintrag in der Steckbrief-Statistik.
 *
 * Diese Regression habe ich selbst eingebaut, am selben Tag: Seit dem
 * Teilschluss (#436) verkleinert ein Teilfill des Broker-Schutz-Stops die
 * Position, statt sie zu löschen. Damit meldete DIESELBE Entscheidung zweimal
 * an `recordFilterStat` — einmal beim Teilschluss, einmal beim Schluss des
 * Restes. Vorher gab es genau eine Buchung, weil die Position verschwand.
 *
 * Warum das die Statistik verzerrt, und nicht nur ihre Größe:
 *
 *   `n` meinte ab da BUCHUNGEN statt Entscheidungen. `FILTER_MIN_SAMPLES = 30`
 *   ist aber ausdrücklich als „30 realisierte Trades" begründet — ein Filter,
 *   der auf 5 Verlierern basiert, wäre „nur Rauschen mit Meinung".
 *
 *   Und die beiden Hälften sind NICHT unabhängig. Ein Ergebnis P, in P/2 + P/2
 *   zerlegt, lässt `pnlSum` unverändert, halbiert aber `pnlSqSum` (P² → P²/2).
 *   Über `bucketTStat` sinkt damit die geschätzte Streuung, während √n steigt:
 *   Der t-Wert wächst betragsmäßig — in BEIDE Richtungen. Ein Steckbrief
 *   konnte also früher unter `FILTER_T_BLOCK = −1,5` rutschen, als die
 *   Datenlage hergibt, und Einstiege blocken, die nichts getan haben.
 *
 * ── Und die Fehlrichtung ist NICHT die konservative ──────────────────────
 *
 * Das stand hier zuerst, mit Verweis darauf, dass ein falscher Block laut
 * `tradeFilter.ts` der billigere Fehler sei. Ein Widerlegungs-Durchgang hat
 * es umgedreht: Derselbe `BucketStat` speist nicht nur den Block.
 *
 *   `leverageGate`  LEV_MIN_SAMPLES 30, LEV_T_MIN 2, LEV_T_FULL 3
 *   `conviction`    CONVICTION_MIN_SAMPLES 15, CONVICTION_T_UP 1,5
 *
 * Die aufgeblähte `n` kippt damit das HEBEL-Tor bei der halben Evidenz: 15
 * echte Entscheidungen ergeben 30 Buchungen und erreichen `LEV_MIN_SAMPLES`,
 * und der ebenfalls aufgeblähte t-Wert trägt über `LEV_T_MIN` hinweg. Echtes
 * Geld, gehebelt, auf halber Datenbasis — während der Kommentar an
 * `LEV_T_MIN` ausdrücklich sagt: „Etwas nicht zu tun ist billig, mit Hebel
 * etwas zu tun ist teuer."
 *
 * Erreichbar bleibt der Fall nur über einen teilweise gefüllten
 * Broker-Schutz-Stop, ist also selten. Selten und teuer ist aber etwas
 * anderes als selten und billig.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bucketTStat,
  CONVICTION_MIN_SAMPLES,
  FILTER_MIN_SAMPLES,
  FILTER_T_BLOCK,
  LEV_MIN_SAMPLES,
} from '@autotrd/shared';
import { statistikBeitrag } from '../src/core/broker.js';

describe('Warum Doppelzählen die Schwelle verschiebt — die Rechnung', () => {
  /** Ein Steckbrief aus n identischen Ergebnissen p. */
  const gleich = (n: number, p: number) => ({
    n,
    wins: p > 0 ? n : 0,
    pnlSum: n * p,
    pnlSqSum: n * p * p,
  });

  it('dieselbe Summe, aber zerlegt: die geschätzte Streuung schrumpft', () => {
    // 20 Entscheidungen à −100 $, jede in zwei Hälften gebucht ⇒ 40 Buchungen
    // à −50 $. Gleiche Gesamtsumme, gleiche Trefferquote.
    const ganz = gleich(20, -100);
    const zerlegt = gleich(40, -50);
    expect(zerlegt.pnlSum).toBe(ganz.pnlSum);
    // Aber die Quadratsumme halbiert sich.
    expect(zerlegt.pnlSqSum).toBeCloseTo(ganz.pnlSqSum / 2, 6);
  });

  it('n zählt Buchungen statt Entscheidungen — die Mindestzahl wird zu früh erreicht', () => {
    // 20 echte Entscheidungen reichen nicht …
    expect(20).toBeLessThan(FILTER_MIN_SAMPLES);
    // … als 40 Buchungen aber schon. Der Filter urteilte dann über eine
    // Stichprobe, die es nicht gibt.
    expect(40).toBeGreaterThanOrEqual(FILTER_MIN_SAMPLES);
  });

  it('und die Blockschwelle ist eine t-Schwelle, also von beidem abhängig', () => {
    // Beide Steckbriefe beschreiben dieselbe Wirklichkeit. Wenn der zerlegte
    // einen betragsmäßig größeren t-Wert liefert, blockt er früher.
    const tGanz = bucketTStat(gleich(20, -100));
    const tZerlegt = bucketTStat(gleich(40, -50));
    // Bei identischen Werten ist die Streuung 0 ⇒ die Funktion verweigert
    // bewusst ein Urteil. Genau das ist die Absicherung, auf die man sich
    // hier NICHT verlassen darf — echte Trades streuen.
    expect(tGanz).toBeNull();
    expect(tZerlegt).toBeNull();
    expect(FILTER_T_BLOCK).toBe(-1.5);
  });

  it('aber NICHT immer — die Behauptung gilt nur für den proportionalen Split', () => {
    /* Ein erster Anlauf behauptete unbedingt „der t-Wert wächst". Das ist zu
     * viel: Echte Teilschlüsse sind ungleiche Tranchen zu verschiedenen
     * Kursen, und nur auf einzelnen Entscheidungen. Hier ein Gegenbeispiel —
     * Teilfill im Plus, Rest tief im Minus: |t| SCHRUMPFT, der Eimer blockt
     * also später statt früher. Der Fehler hat beide Richtungen. */
    const basis = { n: 33, wins: 16, pnlSum: 400, pnlSqSum: 33 * 120 ** 2 };
    const korrekt = {
      n: basis.n + 1,
      wins: basis.wins,
      pnlSum: basis.pnlSum - 200,
      pnlSqSum: basis.pnlSqSum + 200 ** 2,
    };
    const doppelt = {
      n: basis.n + 2,
      wins: basis.wins + 1,
      pnlSum: basis.pnlSum + 300 - 500,
      pnlSqSum: basis.pnlSqSum + 300 ** 2 + 500 ** 2,
    };
    const tK = bucketTStat(korrekt) as number;
    const tD = bucketTStat(doppelt) as number;
    expect(Math.abs(tD)).toBeLessThan(Math.abs(tK));
  });

  it('mit echter Streuung wächst der t-Wert durchs Zerlegen', () => {
    // Zwei Entscheidungen: −150 und −50. Zerlegt: viermal −75 bzw. −25.
    const ganz = { n: 2, wins: 0, pnlSum: -200, pnlSqSum: 150 ** 2 + 50 ** 2 };
    const zerlegt = { n: 4, wins: 0, pnlSum: -200, pnlSqSum: 2 * 75 ** 2 + 2 * 25 ** 2 };
    const tG = bucketTStat(ganz);
    const tZ = bucketTStat(zerlegt);
    expect(tG).not.toBeNull();
    expect(tZ).not.toBeNull();
    expect(Math.abs(tZ as number)).toBeGreaterThan(Math.abs(tG as number));
  });
});

describe('Die aufgeblähte n kippt das HEBEL-Tor bei halber Evidenz', () => {
  it('15 echte Entscheidungen reichen nicht — 30 Buchungen schon', () => {
    // Der teuerste Teil des Befundes: Derselbe BucketStat trägt nicht nur den
    // Block, sondern auch leverageGate und conviction.
    expect(15).toBeLessThan(LEV_MIN_SAMPLES);
    expect(30).toBeGreaterThanOrEqual(LEV_MIN_SAMPLES);
    // Und die Größen-Verstärkung greift schon bei der Hälfte davon.
    expect(CONVICTION_MIN_SAMPLES).toBe(15);
  });
});

describe('statistikBeitrag — eine Entscheidung, ein Eintrag', () => {
  it('ein Teilschluss meldet NICHTS', () => {
    expect(statistikBeitrag({ bucket: 'b', pnl: -50, teilSchluss: true })).toBeNull();
  });

  it('der volle Schluss meldet die SUMME über alle Tranchen', () => {
    // Teilschluss −50 gesammelt, Rest −30 ⇒ die Entscheidung kostete −80.
    expect(statistikBeitrag({ bucket: 'b', pnl: -30, filterPnl: -80 })).toEqual({
      bucket: 'b',
      pnl: -80,
    });
  });

  it('ohne Teilschluss ist der eigene P&L die ganze Wahrheit', () => {
    expect(statistikBeitrag({ bucket: 'b', pnl: -30 })).toEqual({ bucket: 'b', pnl: -30 });
  });

  it('ohne Steckbrief oder ohne P&L meldet nichts', () => {
    expect(statistikBeitrag({ pnl: -30 })).toBeNull();
    expect(statistikBeitrag({ bucket: 'b' })).toBeNull();
    expect(statistikBeitrag({ bucket: 'b', pnl: Number.NaN })).toBeNull();
    expect(statistikBeitrag(null)).toBeNull();
    expect(statistikBeitrag(undefined)).toBeNull();
  });

  it('der ganze Ablauf: Teilschluss dann Vollschluss ⇒ GENAU ein Eintrag', () => {
    // Genau die Behauptung des Commits, als Ablauf statt als Textvergleich.
    const teil = { bucket: 'b', pnl: -50, teilSchluss: true as const };
    const voll = { bucket: 'b', pnl: -30, filterPnl: -80 };
    const eintraege = [teil, voll].map(statistikBeitrag).filter((x) => x !== null);
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]).toEqual({ bucket: 'b', pnl: -80 });
  });
});

/* ── Quelltext-Wächter ─────────────────────────────────────────────────── */
describe('Wächter: Teilschluss sammelt, voller Schluss meldet', () => {
  const broker = readFileSync(join(__dirname, '../src/core/broker.ts'), 'utf8');

  it('der Buchungspfad geht durch die geprüfte Regel, nicht an ihr vorbei', () => {
    expect(broker).toContain('const beitrag = result.executed ? statistikBeitrag(t) : null;');
    expect(broker).toContain('await recordFilterStat(beitrag.bucket, beitrag.pnl)');
    // Die alte, bedingungslose Fassung darf nicht zurückkommen.
    expect(broker).not.toMatch(/if \(result\.executed && t\?\.bucket && typeof t\.pnl === 'number'\) \{/);
  });

  it('die Depot-Übernahme rettet die Lern-Identität', () => {
    // Sonst meldete eine teilgeschlossene Position ihr Ergebnis NIE — und ein
    // Teilfill entsteht per Konstruktion auf der Verlustseite.
    const adopt = readFileSync(join(__dirname, '../src/callable/adoptBroker.ts'), 'utf8');
    expect(adopt).toContain("...(alt?.bucket ? { bucket: alt.bucket } : {}),");
    expect(adopt).toContain('teilPnl: alt.teilPnl');
  });

  it('beide Schluss-Zweige sammeln auf teilPnl auf', () => {
    const treffer = broker.match(/tx\.update\(posRef, \{ qty: rest, teilPnl: roundCents\(teilBisher \+ pnl\) \}\)/g) ?? [];
    expect(treffer.length).toBe(2); // sell und cover
  });

  it('filterPnl steht nur am Rückgabewert, nie im Trade-Dokument', () => {
    // Es ist die Summe über alle Tranchen und gehört nicht an einen einzelnen
    // Trade, der nur seine eigene Tranche verantwortet.
    // Ohne abschließendes Komma im Muster: Der sell-Zweig steht einzeilig,
    // der cover-Zweig mehrzeilig — die Zeichensetzung dahinter unterscheidet
    // sich, die Sache nicht.
    const treffer = broker.match(/\.\.\.\(ganz \? \{ filterPnl: roundCents\(teilBisher \+ pnl\) \} : \{\}\)/g) ?? [];
    expect(treffer.length).toBe(2);
    // Kein tx.set schreibt das Feld.
    expect(broker).not.toMatch(/tx\.set\(tradeRef, \{[^}]*filterPnl/s);
  });
});
