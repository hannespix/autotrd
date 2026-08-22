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

/* ── Das Herkunfts-Etikett sitzt dort, wo es feuern kann (22.08.) ──────────
 *
 * Multi-Agenten-Befund: `soloTrend` stand seit dem 18.08. an GENAU EINER
 * Stelle im ganzen Scan — im Cover-Zweig (Kauf auf offenem Short). Das ist
 * der Signal-AUSSTIEG des Shorts; er verlangt `exitConfluence` (3), und
 * damit ist `konfluenz < minConfluence` (2) dort unerreichbar.
 *
 * Der Kommentar über dem Etikett sagte wörtlich, was die Platzierung selbst
 * vereitelte: „Ohne dieses Feld ließe sich ihr Ertrag später nicht von dem
 * der übrigen Käufe trennen." Ergebnis: Die einzige Frequenz-Kohorte, die es
 * seit dem 17.08. gibt, war dauerhaft unbeurteilbar — und `trendSolo.erzeugt`
 * im Herzschlag widerlegt das nicht, weil der Zähler je Scan bei 0 anfängt.
 *
 * Diese Datei prüft beides: dass die Engine die Erleichterung überhaupt nur
 * dem Long-EINSTIEG gibt (Verhalten), und dass das Etikett genau dort hängt
 * (Ort). Ein Etikett, das nie gesetzt wird, täuscht eine leere Kohorte vor —
 * und das ist schlimmer als gar keines, weil es wie ein Ergebnis aussieht.
 */
describe('soloTrend: nur der Long-Einstieg kann unter die Konfluenz fallen', () => {
  it('die Engine gibt die Erleichterung nur ausserhalb einer Position', () => {
    // `trendSoloAktiv` verlangt `!inPosition` — der Cover ist per Definition
    // IN Position. Hier am Quelltext der Entscheidungsfunktion festgenagelt,
    // weil genau diese Bedingung den Cover-Zweig ausschliesst.
    const stelle = engine.indexOf('const trendSoloAktiv =');
    expect(stelle, 'trendSoloAktiv nicht gefunden').toBeGreaterThan(0);
    const block = engine.slice(stelle, engine.indexOf('const buyReq', stelle));
    expect(block, 'die !inPosition-Bedingung ist weg').toContain('!inPosition');
    expect(block, 'die Erleichterung gilt nur der Kaufseite').toContain("votes.macd === 'buy'");
    // Und der Ausstieg bleibt unberührt: exitReq kommt in der Regel nicht vor.
    expect(block).not.toContain('exitReq');
  });

  it('das Etikett steht GENAU EINMAL im Scan', () => {
    const treffer = scan.match(/soloTrend: true/g) ?? [];
    expect(treffer, 'Etikett fehlt oder ist dupliziert').toHaveLength(1);
  });

  it('es steht im Long-Einstieg, nicht im Cover- und nicht im Short-Zweig', () => {
    const etikett = scan.indexOf('soloTrend: true');
    const longEinstieg = scan.indexOf("} else if (direction === 'buy' && !pos) {");
    const shortEinstieg = scan.indexOf("} else if (direction === 'sell' && !pos && allowShort) {");
    expect(longEinstieg, 'Long-Einstiegszweig nicht gefunden').toBeGreaterThan(0);
    expect(shortEinstieg, 'Short-Einstiegszweig nicht gefunden').toBeGreaterThan(longEinstieg);
    // Zwischen Long-Einstieg und Short-Einstieg — also im Long-Zweig.
    expect(etikett).toBeGreaterThan(longEinstieg);
    expect(etikett).toBeLessThan(shortEinstieg);
  });

  it('der Cover-Zweig trägt es nicht mehr', () => {
    const cover = scan.indexOf("if (direction === 'buy' && pos?.side === 'short') {");
    const longEinstieg = scan.indexOf("} else if (direction === 'buy' && !pos) {");
    expect(cover, 'Cover-Zweig nicht gefunden').toBeGreaterThan(0);
    const block = scan.slice(cover, longEinstieg);
    expect(block, 'das Etikett ist in den Cover-Zweig zurückgerutscht').not.toContain(
      'soloTrend: true',
    );
  });
});
