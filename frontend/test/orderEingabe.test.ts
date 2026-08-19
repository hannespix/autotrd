/**
 * Fünf Audit-Befunde vom 11.08. im Order-Pfad des Dashboards.
 *
 * Alle fünf haben dieselbe Wurzel: Der Weg von der Eingabe zur Order lief
 * über fünf Lesestellen mit vier verschiedenen Regeln, und zwei Knöpfe
 * schickten dasselbe Vorhaben auf verschiedenen Wegen los.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DE } from '../src/i18n.js';
import { join } from 'node:path';
import { eingabeStueckzahl, MAX_QTY } from '@autotrd/shared';

const dashboard = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

/* ── Befund A: Vorschau und Order rechneten verschieden ────────────────────
 *
 * Die Felder sind `type="number"` ohne `step`, nehmen also `2,7`.
 *
 *   Vorschau (`updateOrderPreview`)  Math.max(1, Number(v) || 1)   ⇒ 2,7
 *   Absenden (`submitOrderTicket`)   … Math.floor …                 ⇒ 2
 *
 * Die Vorschau zeigte „2,7 × 250,00 = 675,00 $", ausgeführt wurden 500,00 $.
 * Kapitalbindung, Prozent-vom-Cash und Stop-Level bezogen sich auf eine
 * Order, die so nie stattfand.
 *
 * In der Trade-Karte fehlte das Abrunden an ALLEN drei Stellen — dort
 * rechneten Zwischensumme, Gebühr, Gesamtbetrag, „Barbestand danach" und der
 * Bestätigungstext mit 2,5 Stück durch, und als einziges Ergebnis kam die
 * Server-Absage „qty muss eine ganze Zahl 1–10000 sein".
 */
describe('Befund A: eine Regel für jede Stückzahl-Eingabe', () => {
  it('rundet ab — nie auf', () => {
    // Aufrunden bände mehr Kapital, als der Nutzer eingetippt hat.
    expect(eingabeStueckzahl('2.7')).toBe(2);
    expect(eingabeStueckzahl('2.5')).toBe(2);
    expect(eingabeStueckzahl(2.999)).toBe(2);
  });

  it('ganze Zahlen bleiben, wie sie sind', () => {
    expect(eingabeStueckzahl('10')).toBe(10);
    expect(eingabeStueckzahl(1)).toBe(1);
  });

  it('unter 1 wird 1 — der Server nimmt nichts Kleineres', () => {
    expect(eingabeStueckzahl('0')).toBe(1);
    expect(eingabeStueckzahl('0.4')).toBe(1);
    expect(eingabeStueckzahl('-5')).toBe(1);
  });

  it('leere und unsinnige Eingaben ergeben 1', () => {
    expect(eingabeStueckzahl('')).toBe(1);
    expect(eingabeStueckzahl('abc')).toBe(1);
    expect(eingabeStueckzahl(null)).toBe(1);
    expect(eingabeStueckzahl(undefined)).toBe(1);
    expect(eingabeStueckzahl(Number.NaN)).toBe(1);
  });

  it('klemmt auf die Server-Obergrenze', () => {
    // Sonst schickt die Karte eine Order los, die garantiert abgelehnt wird —
    // nachdem sie die ganze Vorschau darauf aufgebaut hat. Der „Max"-Knopf
    // erzeugt bei günstigen Symbolen mühelos fünfstellige Mengen.
    expect(eingabeStueckzahl('25000')).toBe(MAX_QTY);
    expect(eingabeStueckzahl(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('MAX_QTY ist dieselbe Zahl wie im trade-Callable', () => {
    const server = readFileSync(
      join(import.meta.dirname, '..', '..', 'functions', 'src', 'callable', 'trade.ts'),
      'utf8',
    );
    const treffer = /const MAX_QTY = ([\d_]+);/.exec(server);
    expect(treffer, 'MAX_QTY im Callable nicht gefunden').not.toBeNull();
    expect(Number(treffer![1]!.replace(/_/g, ''))).toBe(MAX_QTY);
  });

  it('alle Eingabefelder laufen über dieselbe Funktion', () => {
    const text = dashboard();
    // Keine handgeschriebene Variante mehr neben der gemeinsamen Regel.
    expect(text).not.toMatch(/Math\.max\(1, (Math\.floor\()?Number\(\(\$\('(ot|m)Qty'\)/);
    // Und sie wird an allen fünf Stellen benutzt (Vorschau, Absenden,
    // manualTrade, mtRecompute, armOrRun).
    expect((text.match(/eingabeStueckzahl\(/g) ?? []).length).toBe(5);
  });
});

/* ── Befund B: Enter löste mehrfach aus, der Klick nicht ───────────────────
 *
 * Der Doppelklick-Schutz war allein `btn.disabled` — ein deaktivierter Knopf
 * feuert kein `click` mehr. Der Enter-Pfad hängt aber am Eingabefeld: Shift+B
 * öffnet das Ticket mit dem Fokus in `#otQty`, zweimal schnell Enter schickte
 * zwei `callTrade`. Serverseitig ist ein Kauf mit ausdrücklicher Menge auf
 * eine bestehende Long-Position ein NACHKAUF — aus 10 Stück wurden 20, und
 * das Fenster schloss nach der ersten Antwort.
 */
describe('Befund B: das Order-Ticket fängt den Wiedereintritt selbst ab', () => {
  it('submitOrderTicket steigt aus, wenn schon eine Order läuft', () => {
    const text = dashboard();
    const ab = text.indexOf('async function submitOrderTicket');
    expect(ab).toBeGreaterThan(0);
    const bis = text.indexOf('await callTrade(', ab);
    // Die Prüfung muss VOR dem Absenden stehen — danach wäre sie wirkungslos.
    expect(text.slice(ab, bis)).toContain('if (btn.disabled) return;');
  });

  it('der Enter-Pfad ruft weiterhin dieselbe Funktion', () => {
    // Der Fix sitzt bewusst IN submitOrderTicket und nicht am Listener:
    // Sonst müsste jeder künftige Auslöser die Sperre erneut mitbringen.
    const text = dashboard();
    expect(text).toContain("if ((e as KeyboardEvent).key === 'Enter') void submitOrderTicket();");
  });
});

/* ── Befund C: „Cover" schickte die Stückzahl einer fremden Karte mit ──────
 *
 * Der Exit-Knopf rief `manualTrade`, und die reicht bei `side === 'buy'` die
 * Menge aus `#mQty` mit — dem Feld der Trade-Karte. Für einen Long (`sell`,
 * ohne Menge) ging das gut, für einen Short (`buy`, mit Menge) nicht: Wer
 * dort zuvor „Max" geklickt hatte, hatte fünfstellige Werte stehen, und der
 * Cover wurde mit „qty muss eine ganze Zahl 1–10000 sein" abgelehnt. Die
 * Meldung landete in `#mtHint`, also in einer anderen Karte — bei der
 * Position passierte sichtbar nichts.
 */
describe('Befund C: Positionen schließen ohne fremde Stückzahl', () => {
  it('der Exit-Knopf ruft positionSchliessen, nicht manualTrade', () => {
    const text = dashboard();
    const ab = text.indexOf("tr.querySelector('[data-exit]')");
    expect(ab).toBeGreaterThan(0);
    const block = text.slice(ab, ab + 400);
    expect(block).toContain('positionSchliessen(');
    expect(block).not.toContain('manualTrade(');
  });

  it('positionSchliessen sendet KEINE Menge', () => {
    const text = dashboard();
    const ab = text.indexOf('async function positionSchliessen');
    expect(ab).toBeGreaterThan(0);
    const bis = text.indexOf('async function manualTrade', ab);
    const block = text.slice(ab, bis);
    expect(block).toContain('await callTrade({ symbol, side });');
    expect(block).not.toContain('qty');
  });

  it('der Massen-Pfad macht es unverändert genauso', () => {
    // `schliessePositionen` war schon immer richtig — der Einzelfall zieht
    // jetzt nach, statt eine zweite Regel zu führen.
    expect(dashboard()).toContain(
      "await callTrade({ symbol: sym, side: pos?.side === 'short' ? 'buy' : 'sell' });",
    );
  });
});

/* ── Befund D: Die Vorschau behauptete einen Teilverkauf, den es nicht gibt ─
 *
 * Der Server schließt beim Verkauf einer Long-Position immer die GANZE
 * Position (`planeMenge` gibt `pos.qty` und ignoriert `req.qty`). Die
 * Vorschau rechnete trotzdem mit dem Feldwert: Wer 100 Stück QQQ zu 250 hielt
 * und Shift+S drückte, las „1 × 250,00 = 250,00 $ (0,3 % vom Cash)" und
 * liquidierte mit dem Bestätigen 25.000 $ — die Zahl war um den Faktor 100
 * falsch, genau bei der Entscheidung, die sie stützen soll.
 */
describe('Befund D: die Vorschau sagt, was wirklich passiert', () => {
  it('erkennt, dass die Order eine offene Position schließt', () => {
    const text = dashboard();
    const ab = text.indexOf('function updateOrderPreview');
    const bis = text.indexOf('function ', ab + 40);
    const block = text.slice(ab, bis);
    expect(block).toContain('st.positions.find(');
    // Long wird durch `sell` geschlossen, Short durch `buy` — beide Fälle.
    expect(block).toContain("offen.side === 'short'");
  });

  it('rechnet dann mit der Positionsgröße statt der Eingabe', () => {
    const text = dashboard();
    const ab = text.indexOf('function updateOrderPreview');
    const bis = text.indexOf('function ', ab + 40);
    const block = text.slice(ab, bis);
    expect(block).toContain('const wirkMenge = schliesst ? offen.qty : qty;');
    expect(block).toContain('const exposure = wirkMenge * q.price;');
  });

  it('und sagt es dem Nutzer', () => {
    const text = dashboard();
    // Der Wortlaut wohnt seit Tranche 5n im Wörterbuch (Task #139);
    // gepinnt bleibt der Schlüssel an der Stelle plus der Text dort.
    expect(text).toContain("${t('op.schliesstGanze')}");
    expect(DE['op.schliesstGanze']).toContain('Schließt die GANZE Position');
  });
});
