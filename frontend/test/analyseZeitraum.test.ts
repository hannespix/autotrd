/**
 * Owner-Wunsch 11.08.: „Die Handelsanalyse zeigt nur einen definierten, sehr
 * kurzen Bereich. Kann man diesen auch einstellbar machen?"
 *
 * Die reine Zeitraum-Logik steht in `shared/test/zeitraum.test.ts`. Hier
 * geht es um die Verdrahtung — und die ist bei diesem Feature der
 * eigentliche Knackpunkt: Ein Umschalter, der nur die Überschrift ändert,
 * wäre schlimmer als gar keiner. Er behauptete einen Zeitraum, den die Zahlen
 * darunter nicht haben.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DE } from '../src/i18n.js';

const quelle = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

const analyseBlock = (): string => {
  const text = quelle();
  const ab = text.indexOf('function renderAnalytics(): void {');
  expect(ab, 'renderAnalytics nicht gefunden').toBeGreaterThan(0);
  return text.slice(ab, text.indexOf('\n}', text.indexOf('box.innerHTML = `', ab)));
};

describe('Der Umschalter greift auf ALLE Zahlen durch', () => {
  it('die Auswertung rechnet auf dem gefilterten Fenster', () => {
    expect(analyseBlock()).toContain('imZeitraum(st.trades as HistoryTrade[], st.anZeitraum');
  });

  it('kein Diagramm greift an der Filterung vorbei auf st.trades', () => {
    /* Der Kern. Die sechs Ansichten teilen sich EINE Liste; griffe eine
     * davon wieder direkt auf `st.trades`, zeigte sie einen anderen Zeitraum
     * als der Kopf darüber — und niemand sähe den Unterschied an. */
    const block = analyseBlock();
    const ab = block.indexOf('const trades = imZeitraum(');
    const danach = block.slice(ab + 40);
    expect(danach).not.toContain('st.trades as HistoryTrade[]');
  });

  it('auch die Teilen-Grafik folgt dem Zeitraum', () => {
    // Sie ist das Bild aus dem Screenshot: Sie beschriftet sich mit ihrem
    // ersten und letzten Datum. Ungeschnitten stünde über der Auswertung
    // „90 Tage" und in der Grafik darunter „07.08. → 11.08.".
    const text = quelle();
    const ab = text.indexOf('function shareDatenBauen(');
    const bis = text.indexOf('\n}', text.indexOf('return {', ab));
    const block = text.slice(ab, bis);
    expect(block).toContain('anZeitfenster()');
    expect(block).not.toContain('st!.trades as HistoryTrade[]');
    expect(block).not.toContain('st!.equitySeries');
  });

  it('das Zeitfenster schneidet Trades UND Equity-Serie', () => {
    const text = quelle();
    const ab = text.indexOf('function anZeitfenster(');
    const block = text.slice(ab, text.indexOf('\n}', ab));
    expect((block.match(/imZeitraum\(/g) ?? []).length).toBe(2);
  });
});

describe('Der Umschalter besorgt die Historie, die er braucht', () => {
  it('waehleZeitraum lädt nach, solange die Historie nicht reicht', () => {
    /* Ohne diesen Schritt wäre der Umschalter eine Lüge: `st.trades` enthält
     * nur die geladenen Seiten (50 je Klick). Wer „90 Tage" wählt, während
     * vier geladen sind, bekäme eine Vier-Tage-Auswertung mit
     * 90-Tage-Beschriftung — genau der Zustand, den der Owner gemeldet hat. */
    const text = quelle();
    const ab = text.indexOf('async function waehleZeitraum(');
    expect(ab).toBeGreaterThan(0);
    const block = text.slice(ab, text.indexOf('\n}', text.indexOf('finally', ab)));
    expect(block).toContain('historieReicht(');
    expect(block).toContain('loadMoreTrades(');
  });

  it('das Nachladen hat einen Deckel', () => {
    // Ein Konto mit langer Historie und ein Fehlgriff auf „Alles" darf nicht
    // in eine Endlosschleife laufen.
    const text = quelle();
    const ab = text.indexOf('async function waehleZeitraum(');
    const block = text.slice(ab, text.indexOf('\n}', text.indexOf('finally', ab)));
    expect(block).toMatch(/runde < \d+/);
  });

  it('und prüft nach jedem await, ob der Nutzer noch da ist', () => {
    // Dieselbe Falle wie in `ladeAeltereTrades`: Nach einer Abmeldung wäre
    // `st` null, und der Zugriff darauf ein TypeError im Abmelde-Pfad.
    const text = quelle();
    const ab = text.indexOf('async function waehleZeitraum(');
    const block = text.slice(ab, text.indexOf('\n}', text.indexOf('finally', ab)));
    expect(block).toContain('if (!st) return;');
  });

  it('während des Ladens sind die Chips gesperrt', () => {
    // Sonst stapeln sich Ladeläufe, die sich gegenseitig die Seiten
    // wegschnappen.
    const text = quelle();
    expect(text).toContain('if (!st || st.anLaedt) return;');
    const ab = text.indexOf('function renderZeitraumChips(');
    const block = text.slice(ab, text.indexOf('\n}', text.indexOf('for (const b of', ab)));
    expect(block).toContain('disabled');
  });
});

describe('Der Kopf sagt, worauf die Zahlen beruhen', () => {
  it('nennt Anzahl UND Zeitraum', () => {
    // Genau die Angabe fehlte: „Trefferquote 30 %" aus vier Tagen sah aus
    // wie eine aus vier Monaten.
    // Seit Tranche 5o wohnt der Wortlaut im Wörterbuch — die Aussage bleibt:
    // Kopf = Anzahl (an.geschlossen) UND Zeitraum (zeitraumLabel) nebeneinander.
    const block = analyseBlock();
    expect(block).toContain("${t('an.geschlossen')} · ${zeitraumLabel(st.anZeitraum)}");
    expect(DE['an.geschlossen']).toBe('geschlossen');
  });

  it('und markiert einen Zeitraum, der noch nicht voll belegt ist', () => {
    expect(analyseBlock()).toContain('historieReicht(');
  });

  it('ein leerer Zeitraum schlägt einen längeren vor, statt nur „leer" zu sagen', () => {
    expect(analyseBlock()).toContain("t('an.laengerWaehlen')");
    expect(DE['an.laengerWaehlen']).toContain('längeren Zeitraum wählen?');
  });
});

describe('Voreinstellung', () => {
  it('startet bei 30 Tagen', () => {
    // Lang genug, dass die Kennzahlen etwas aussagen; kurz genug, dass die
    // erste Seite meist reicht und nichts nachgeladen werden muss.
    expect(quelle()).toContain('anZeitraum: 30,');
  });
});
