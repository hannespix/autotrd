/**
 * Die Erklärung am BUY/SELL/HOLD-Etikett (Owner-Wunsch 22.08.).
 *
 * Zwei Fehlerklassen sind hier gefährlich, und beide sind lautlos:
 *
 *  1. **Erfundene Begründung.** Ein Punkt, der behauptet „keine Stimme", wo
 *     gar nicht gerechnet wurde, ist schlimmer als ein fehlender Punkt — er
 *     sieht aus wie ein Ergebnis. Und wenn die Einzelstimmen nicht auf die
 *     angezeigte Gesamtzahl aufgehen, widerspricht sich die Karte selbst.
 *  2. **Anlageberatung.** Die App sagt in ihrem eigenen Fuß, dass sie keine
 *     gibt. Ein Wort wie „günstig" oder „dürfte" trägt eine Erwartung über
 *     den Kursverlauf — auch technisch gemeint. Deshalb prüft die
 *     Verbotsliste unten JEDEN erzeugten Text und alle neuen Textbausteine
 *     in DE und EN, nicht nur die Absicht des Autors.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signalErklaerung } from '../src/signalErklaerung.js';
import { DE, EN } from '../src/i18n.js';
import type { IndicatorRow, SignalRow } from '../src/data.js';

const sig = (o: Partial<SignalRow>): SignalRow => ({
  direction: 'hold',
  buyVotes: 0,
  sellVotes: 0,
  requiredConfluence: 2,
  votes: {},
  price: 100,
  at: '2026-08-22T15:35:00.000Z',
  ...o,
});

const ind: IndicatorRow = {
  rsi: 27.4,
  macd: { line: 1.2, signal: 0.8, histogram: 0.4 },
  bollinger: { upper: 110, middle: 100, lower: 90, pctB: 38 },
};

/** Alles, was der Nutzer zu sehen bekäme, als ein Text. */
const alles = (e: ReturnType<typeof signalErklaerung>): string =>
  [e.kopf, e.zaehlung, ...e.bausteine.map((b) => `${b.quelle} ${b.wert} ${b.stimme}`), ...e.fuss].join(' | ');

describe('Die Stimmen gehen auf', () => {
  it('ein Punkt je GERECHNETER Quelle — fehlende Schlüssel erfinden nichts', () => {
    const e = signalErklaerung(sig({ direction: 'buy', buyVotes: 2, votes: { rsi: 'buy', macd: 'buy' } }), ind);
    // Bollinger fehlt im Dokument ⇒ KEIN Punkt, auch nicht „keine Stimme".
    expect(e.bausteine.map((b) => b.quelle)).toEqual([DE['se.rsi'], DE['se.macd']]);
  });

  it('eine gerechnete, aber neutrale Quelle bekommt ihren Punkt', () => {
    const e = signalErklaerung(
      sig({ direction: 'buy', buyVotes: 2, votes: { rsi: 'buy', macd: 'buy', bollinger: 'hold' } }),
      ind,
    );
    expect(e.bausteine).toHaveLength(3);
    expect(e.bausteine[2]!.stimme).toContain(DE['se.keineStimme']);
  });

  it('die Prognose zählt mit ihrem echten Gewicht — als Rest, nicht nachgebaut', () => {
    // buyVotes 3 bei einer Indikator-Kaufstimme ⇒ die Prognose trug 2.
    const e = signalErklaerung(
      sig({ direction: 'buy', buyVotes: 3, votes: { rsi: 'buy', forecast: 'buy' } }),
      ind,
    );
    const p = e.bausteine.find((b) => b.quelle === DE['se.prognose']);
    expect(p, 'Prognose-Punkt fehlt').toBeDefined();
    expect(p!.stimme).toContain('2');
  });

  it('ohne forecast-Schlüssel gibt es KEINEN Prognose-Punkt', () => {
    // Fehlender Schlüssel heißt: Gewicht war 0, sie hat nicht mitgezählt.
    const e = signalErklaerung(sig({ direction: 'buy', buyVotes: 2, votes: { rsi: 'buy', macd: 'buy' } }), ind);
    expect(e.bausteine.some((b) => b.quelle === DE['se.prognose'])).toBe(false);
  });

  it('kein MACD-Punkt bei „hold" — das Histogramm ist die Differenz, der Fall ist tot', () => {
    const e = signalErklaerung(sig({ votes: { macd: 'hold', rsi: 'hold' } }), ind);
    expect(e.bausteine.some((b) => b.quelle === DE['se.macd'])).toBe(false);
  });

  it('ohne Indikatorwerte stehen die Punkte ohne Zahl da statt mit einer falschen', () => {
    const e = signalErklaerung(sig({ direction: 'buy', buyVotes: 2, votes: { rsi: 'buy', macd: 'buy' } }), null);
    expect(e.bausteine).toHaveLength(2);
    for (const b of e.bausteine) expect(b.wert).toBe('');
  });
});

describe('Der Zählsatz nennt den richtigen Grund', () => {
  it('Gleichstand: keine Seite vorn — die Schwelle ist NICHT der Grund', () => {
    const e = signalErklaerung(sig({ buyVotes: 1, sellVotes: 1, votes: { rsi: 'buy', macd: 'sell' } }), ind);
    expect(e.zaehlung).toContain(DE['se.gleichstand']);
    expect(e.zaehlung).not.toContain(DE['se.eineFehlte']);
  });

  it('eine Stimme zu wenig: DANN ist die Schwelle der Grund', () => {
    const e = signalErklaerung(sig({ buyVotes: 1, sellVotes: 0, votes: { rsi: 'buy' } }), ind);
    expect(e.zaehlung).toContain(DE['se.eineFehlte']);
    expect(e.zaehlung).not.toContain(DE['se.gleichstand']);
  });

  it('die Trendstimmen-Zeile nur bei gesenkter Schwelle UND MACD-Kaufstimme', () => {
    const solo = signalErklaerung(
      sig({ direction: 'buy', buyVotes: 1, requiredConfluence: 1, votes: { macd: 'buy' } }),
      ind,
    );
    expect(solo.zaehlung).toContain(DE['se.trendSolo']);
    // Normale Schwelle ⇒ keine Sonderzeile.
    const normal = signalErklaerung(
      sig({ direction: 'buy', buyVotes: 2, requiredConfluence: 2, votes: { macd: 'buy', rsi: 'buy' } }),
      ind,
    );
    expect(normal.zaehlung).not.toContain(DE['se.trendSolo']);
  });
});

describe('Der Fuß trennt Signal und eigenes Konto — ohne falsche Kausalkette', () => {
  it('sagt „getrennt gerechnet", nicht „danach entscheidet das Einstiegs-Tor"', () => {
    /* Die angezeigte Zeile ist gar nicht die Eingabe des Tors: Der
     * Anzeige-Scan rechnet einmal je Symbol mit den Systemwerten, der
     * Handelspfad je Konto komplett neu. Zwei parallele Rechnungen als
     * Reihenschaltung darzustellen wäre eine erfundene Ursache. */
    const e = signalErklaerung(sig({ direction: 'buy', buyVotes: 2, votes: { rsi: 'buy', macd: 'buy' } }), ind);
    expect(e.fuss.join(' ')).toContain(DE['se.getrenntGerechnet']);
    const text = alles(e);
    expect(text).not.toMatch(/Einstiegs-Tor|entry gate/i);
    expect(text).not.toMatch(/noch keine Order|not yet an order/i);
  });

  it('nennt keine Ausstiegs-Schwelle und keine Entwarnung über Leerverkäufe', () => {
    const e = signalErklaerung(sig({ direction: 'sell', sellVotes: 2, votes: { rsi: 'sell', bollinger: 'sell' } }), ind);
    const text = alles(e);
    expect(text).not.toMatch(/Ausstieg|exitConfluence|nichts zu verkaufen/i);
  });
});

/* ── Verbotsliste (Anlageberatung) ──────────────────────────────────────── */

const VERBOTEN = [
  'günstig', 'teuer', 'Chance', 'lohnt', 'überkauft', 'überverkauft',
  'Aufwärtstrend', 'Abwärtstrend', 'dürfte', 'wird steigen', 'wird fallen',
  'Kursziel', 'empfehlen', 'Empfehlung wert', 'attraktiv', 'Einstiegskurs',
  'cheap', 'expensive', 'opportunity', 'overbought', 'oversold',
  'uptrend', 'downtrend', 'will rise', 'will fall', 'price target', 'attractive',
];

describe('Kein Satz wird zur Anlageberatung', () => {
  const faelle = [
    signalErklaerung(sig({ direction: 'buy', buyVotes: 2, votes: { rsi: 'buy', macd: 'buy', bollinger: 'hold' } }), ind),
    signalErklaerung(sig({ direction: 'sell', sellVotes: 3, buyVotes: 1, votes: { rsi: 'sell', bollinger: 'sell', macd: 'buy', forecast: 'sell' } }), ind),
    signalErklaerung(sig({ buyVotes: 1, sellVotes: 1, votes: { rsi: 'buy', macd: 'sell' } }), ind),
    signalErklaerung(sig({ direction: 'buy', buyVotes: 1, requiredConfluence: 1, votes: { macd: 'buy' } }), ind),
  ];

  it('kein erzeugter Text enthält ein Wort der Verbotsliste', () => {
    for (const e of faelle) {
      const text = alles(e).toLowerCase();
      for (const w of VERBOTEN) {
        expect(text, `„${w}" in: ${alles(e)}`).not.toContain(w.toLowerCase());
      }
    }
  });

  it('auch die Bausteine selbst — in DE UND EN', () => {
    const schluessel = Object.keys(DE).filter((k) => k.startsWith('se.'));
    expect(schluessel.length, 'keine se.-Schlüssel gefunden').toBeGreaterThan(10);
    for (const k of schluessel) {
      for (const block of [DE as Record<string, string>, EN as Record<string, string>]) {
        const v = block[k];
        if (typeof v !== 'string') continue;
        for (const w of VERBOTEN) {
          expect(v.toLowerCase(), `„${w}" in ${k}: ${v}`).not.toContain(w.toLowerCase());
        }
      }
    }
  });

  it('jeder se.-Schlüssel existiert auch auf Englisch', () => {
    // Ein fehlender EN-Text fiele im Betrieb auf den deutschen zurück — die
    // Verbotsliste oben prüfte dann eine Sprache, die niemand sieht.
    for (const k of Object.keys(DE).filter((x) => x.startsWith('se.'))) {
      expect((EN as Record<string, string>)[k], `EN fehlt: ${k}`).toBeTruthy();
    }
  });

  it('der Kopf sagt ausdrücklich, dass es keine Empfehlung ist', () => {
    for (const e of faelle) expect(e.kopf.toLowerCase()).toContain('keine empfehlung');
  });
});

describe('Quelltext-Wächter: die Zelle bleibt sortierbar und das Chart ruhig', () => {
  const dash = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

  it('der Anker sitzt am SPAN, der Zellinhalt bleibt reiner Text', () => {
    // sortiereSigZeilen vergleicht cells[idx].textContent — Sätze in der
    // Zelle zerlegten die Signal-Sortierung.
    expect(dash).toContain('data-warum="${sym}"');
    expect(dash).toMatch(/<span class="stag t-\$\{dir\}" data-warum="\$\{sym\}">\$\{dir\.toUpperCase\(\)\}<\/span>/);
  });

  it('das fest verdrahtete HOLD im Zeilen-Template ist weg', () => {
    // Es behauptete eine Rechnung, die für nie gescannte Symbole nie lief.
    expect(dash).not.toContain('<span class="stag t-hold">HOLD</span>');
  });

  it('die Erklärung hat Vorrang vor dem Symbol-Steckbrief', () => {
    const stelle = dash.indexOf('function symTipAnker');
    const block = dash.slice(stelle, dash.indexOf('function wireSymbolTip'));
    expect(block).toContain('WARUM_ANKER');
    expect(block.indexOf('WARUM_ANKER')).toBeLessThan(block.indexOf('SYM_TIP_ANKER'));
  });

  it('ein Tap auf die Signal-Zelle wechselt nicht das Haupt-Chart', () => {
    expect(dash).toContain("if ((ev.target as Element | null)?.closest?.(WARUM_ANKER)) return;");
  });
});
