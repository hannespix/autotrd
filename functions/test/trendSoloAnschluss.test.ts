/**
 * Anschluss-Wächter: Bekommt die Trendstimme ihre Ampel überhaupt? (17.08.)
 *
 * Die Regel selbst ist in `trendSolo.test.ts` geprüft — pur, an der
 * Entscheidungsfunktion. Was diese Datei prüft, ist das, was eine reine
 * Funktions-Prüfung nie sehen kann: dass der Scan den Ampel-Zustand
 * tatsächlich DURCHREICHT.
 *
 * Ohne diesen Anschluss wäre die Regel stumm — `opts.regime` bliebe
 * undefined, `trendSolo` griffe nie, und der Owner-Go vom 17.08. hätte im
 * Handel exakt null Wirkung. Es gäbe keinen Testfehler, keine Fehlermeldung,
 * nur weiterhin 13× „hold". Genau so ist `live_tag` zwölf Tage lang eine
 * Reihe mit zehn Einträgen geblieben.
 *
 * Beide Aufrufstellen müssen sie bekommen — die des HANDELS und die des
 * SCHATTENS. Rechnete der Schatten mit einer anderen Einstiegsschwelle als
 * die Engine, würde er eine Logik messen, die niemand handelt.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const engine = readFileSync(join(hier, '../src/core/engine.ts'), 'utf8');

describe('scanMarket: die Ampel erreicht beide Signal-Berechnungen', () => {
  it('der HANDELS-Pfad reicht sie durch', () => {
    const stelle = scan.indexOf('const sig = computeSignal(');
    expect(stelle, 'Handels-Aufruf nicht gefunden').toBeGreaterThan(0);
    const block = scan.slice(stelle, stelle + 1200);
    expect(block).toContain('hasPosition: pos !== null,');
    expect(block, 'Ampel fehlt im Handels-Pfad').toContain('regime,');
  });

  it('der SCHATTEN-Pfad reicht sie durch', () => {
    const stelle = scan.indexOf('const sig = computeSignal(\n        closes,');
    expect(stelle, 'Schatten-Aufruf nicht gefunden').toBeGreaterThan(0);
    const block = scan.slice(stelle, stelle + 1200);
    expect(block, 'Ampel fehlt im Schatten-Pfad').toContain('{ regime: regime.state }');
  });

  it('die Wirkung ist im Heartbeat ablesbar', () => {
    // Ohne diesen Zähler ließe sich nicht belegen, ob die Regel wirkt oder
    // ob nur der Markt lebhafter war.
    expect(scan).toContain('trendSolo: { erzeugt: soloSignale, ampel: regime.state },');
    expect(scan).toContain(
      'if (sig.direction === \'buy\' && sig.buyVotes < DEFAULT_STRATEGY.signals.minConfluence) {',
    );
  });
});

describe('engine: die drei Grenzen stehen im Quelltext', () => {
  it('Trendfolger, Trend-Ampel, Kaufseite — alle drei in EINER Bedingung', () => {
    // Als Block geprüft, nicht als drei einzelne Vorkommen: Eine Bedingung,
    // die versehentlich mit `||` verknüpft wird, hätte dieselben drei
    // Zeilen und eine völlig andere Wirkung.
    expect(engine).toContain(
      "const trendSoloAktiv =\n" +
        "    signals.trendSolo === true &&\n" +
        "    !inPosition &&\n" +
        "    opts?.regime === 'trend' &&\n" +
        "    votes.macd === 'buy';",
    );
  });

  it('nur die KAUF-Schwelle wird gesenkt, die Verkaufsseite behält entryReq', () => {
    expect(engine).toContain('const buyReq = trendSoloAktiv ? 1 : entryReq;');
    expect(engine).toContain('} else if (buyVotes >= buyReq && buyVotes > sellVotes) {');
    expect(engine).toContain('} else if (sellVotes >= entryReq && sellVotes > buyVotes) {');
  });

  it('der Ausstieg fasst `exitReq` unverändert an', () => {
    // Der Riegel gegen die gefährlichste Variante dieses Fehlers: eine
    // Erleichterung, die versehentlich auch den Exit betrifft, würde
    // Positionen früher aufgeben — und Exits dürfen nie erschwert, aber
    // auch nicht unbeabsichtigt verändert werden.
    expect(engine).toContain(
      'const exitReq = Math.max(1, signals.exitConfluence ?? Math.max(1, signals.minConfluence - 1));',
    );
    expect(engine).not.toContain('exitReq = trendSoloAktiv');
  });
});
