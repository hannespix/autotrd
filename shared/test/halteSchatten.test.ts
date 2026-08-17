/**
 * Haltedauer-gerechter Schatten (17.08.) — der Befund und seine Sperre.
 *
 * ── Was hier eigentlich geprüft wird ──────────────────────────────────────
 *
 * Der Klassen-Schatten entscheidet, ob eine abgeschaltete Anlageklasse in den
 * Handel zurückdarf. Er maß die Kursbewegung von einem Scan zum nächsten —
 * fünf Minuten — und zog davon die vollen Roundtrip-Kosten ab. Live gilt für
 * Krypto seit dem 15.08. eine Mindesthalte von 48 Stunden.
 *
 * Die Kante war damit keine falsche Zahl, sondern eine Zahl ohne Einheit:
 * 0,011 % Bewegung gegen 0,50 % Kosten. Diese Rechnung kann keine
 * Signalquelle gewinnen, und sie hat mit dem Handel, den sie freigeben soll,
 * nichts zu tun.
 *
 * Die Tests unten nageln beide Hälften der Korrektur fest — das FENSTER
 * (`pruefeHalteSlot`) und die EINHEIT (`alterMin` im Aggregat). Die zweite
 * ist die wichtigere: Solange der gemessene Horizont neben der Kante steht,
 * kann dieser Fehler nicht mehr unbemerkt zurückkommen.
 */
import { describe, expect, it } from 'vitest';
import {
  addiereSchatten,
  bewerteSchattenSignal,
  halteMaxAlterMs,
  HALTE_KULANZ_MS,
  pruefeHalteSlot,
  pruefeTagSlot,
  TAG_HORIZONT_MS,
  TAG_MAX_ALTER_MS,
  werteSchattenAus,
} from '../src/classShadow.js';
import { KLASSEN_MINDESTHALTE, wirksameMindesthalte } from '../src/strategy.js';

const T = (iso: string): number => Date.parse(iso);
const KRYPTO_MS = 2_880 * 60_000; // 48 h — der Boden aus KLASSEN_MINDESTHALTE
const slot = { direction: 'buy' as const, price: 100, at: '2026-08-15T12:00:00.000Z' };

describe('halteMaxAlterMs — die Kulanz ist keine neue Zahl', () => {
  it('reproduziert die Tages-Fassung exakt (24 h Horizont ⇒ 96 h Deckel)', () => {
    // Wenn diese Zeile bricht, sind Tages- und Halte-Slot auseinandergelaufen
    // und zwei Reihen mit „96 h" im Kopf meinen zwei verschiedene Dinge.
    expect(halteMaxAlterMs(TAG_HORIZONT_MS)).toBe(TAG_MAX_ALTER_MS);
    expect(TAG_MAX_ALTER_MS - TAG_HORIZONT_MS).toBe(HALTE_KULANZ_MS);
  });

  it('legt die Kulanz auf jeden Horizont, auch auf den Krypto-Boden', () => {
    expect(halteMaxAlterMs(KRYPTO_MS)).toBe(KRYPTO_MS + HALTE_KULANZ_MS);
  });

  it('behandelt kaputte Horizonte wie 0 statt NaN weiterzugeben', () => {
    for (const h of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(halteMaxAlterMs(h)).toBe(HALTE_KULANZ_MS);
    }
  });
});

describe('pruefeHalteSlot — das Fenster ist die Haltedauer der Klasse', () => {
  it('lässt ein Krypto-Signal 48 h reifen, nicht 24 h', () => {
    // Der Kern des Befunds: Nach einem Tag ist ein Krypto-Signal NICHT reif,
    // obwohl der Tages-Slot es längst bewerten würde.
    expect(pruefeHalteSlot(slot, T('2026-08-16T12:00:00Z'), KRYPTO_MS).status).toBe('wartet');
    expect(pruefeTagSlot(slot, T('2026-08-16T12:00:00Z')).status).toBe('reif');
    // Punktgenau nach 48 h wird bewertet.
    expect(pruefeHalteSlot(slot, T('2026-08-17T11:59:00Z'), KRYPTO_MS).status).toBe('wartet');
    expect(pruefeHalteSlot(slot, T('2026-08-17T12:00:00Z'), KRYPTO_MS).status).toBe('reif');
  });

  it('gibt das reife Signal unverfälscht heraus — mit gemessenem Alter', () => {
    const b = pruefeHalteSlot(slot, T('2026-08-17T12:00:00Z'), KRYPTO_MS);
    expect(b.status).toBe('reif');
    if (b.status !== 'reif') throw new Error('unerreichbar');
    expect(b.signal.direction).toBe('buy');
    expect(b.signal.price).toBe(100);
    expect(b.signal.alterMs).toBe(KRYPTO_MS);
  });

  it('verfällt erst nach Horizont + Kulanz — Marktlücken zählen nicht als Signalgüte', () => {
    const knappDrin = KRYPTO_MS + HALTE_KULANZ_MS - 60_000;
    const drueber = KRYPTO_MS + HALTE_KULANZ_MS + 60_000;
    expect(pruefeHalteSlot(slot, T(slot.at) + knappDrin, KRYPTO_MS).status).toBe('reif');
    expect(pruefeHalteSlot(slot, T(slot.at) + drueber, KRYPTO_MS).status).toBe('verfallen');
  });

  it('Horizont 0 heißt „sofort reif" — für eine Klasse ohne Mindesthalte richtig', () => {
    // Kein Sonderfall zum Wegwerfen: Wer sofort wieder aussteigen darf, für
    // den IST das nächste Scan-Fenster die Haltedauer.
    expect(pruefeHalteSlot(slot, T(slot.at) + 300_000, 0).status).toBe('reif');
  });

  it('kaputte und rückdatierte Einträge zählen als leer, nicht als Messwert', () => {
    expect(pruefeHalteSlot(undefined, T('2026-08-17T12:00:00Z'), KRYPTO_MS).status).toBe('leer');
    expect(pruefeHalteSlot(null, T('2026-08-17T12:00:00Z'), KRYPTO_MS).status).toBe('leer');
    expect(pruefeHalteSlot({ ...slot, at: 'kaputt' }, T('2026-08-17T12:00:00Z'), KRYPTO_MS).status)
      .toBe('leer');
    // Uhr verstellt: Das Signal liegt in der Zukunft.
    expect(pruefeHalteSlot(slot, T('2026-08-15T11:00:00Z'), KRYPTO_MS).status).toBe('leer');
  });

  it('der Horizont kommt aus derselben Quelle wie die Live-Sperre', () => {
    // Verkabelungs-Probe: Der Scan rechnet
    // `wirksameMindesthalte(...) * 60_000`. Wäre hier eine eigene Konstante,
    // liefen Messung und Handel beim nächsten Boden-Wechsel auseinander.
    expect(wirksameMindesthalte(1_440, 'crypto') * 60_000).toBe(KRYPTO_MS);
    expect(KLASSEN_MINDESTHALTE['crypto']).toBe(2_880);
  });
});

describe('gemessener Horizont im Aggregat — die Einheit der Kante', () => {
  const beitrag = (alterMs: number | undefined): ReturnType<typeof bewerteSchattenSignal> =>
    bewerteSchattenSignal(
      { direction: 'buy', price: 100, ...(alterMs !== undefined ? { alterMs } : {}) },
      101,
      0.004,
    );

  it('trägt das Alter vom Signal in den Beitrag', () => {
    expect(beitrag(KRYPTO_MS).alterMs).toBe(KRYPTO_MS);
    expect(beitrag(undefined).alterMs).toBeUndefined();
  });

  it('rechnet den mittleren Horizont in Minuten aus', () => {
    let k = addiereSchatten(undefined, beitrag(KRYPTO_MS));
    k = addiereSchatten(k, beitrag(KRYPTO_MS));
    const a = werteSchattenAus(k);
    expect(a.nAlter).toBe(2);
    expect(a.alterMin).toBe(2_880);
    // Und die Kosten stimmen jetzt auch: +1 % Bewegung − 0,40 % Roundtrip.
    expect(a.kantePct).toBeCloseTo(0.6, 4);
  });

  it('zählt mit EIGENEM Nenner — Altbestand ohne Alter verzerrt nichts', () => {
    // Der Fehler, der hier verhindert wird: Ein Aggregat mit 200 Signalen und
    // nur zwei gemessenen Altern würde bei Division durch `n` einen Horizont
    // von 29 Minuten behaupten — und ausgerechnet die Zahl, die einen
    // Fünf-Minuten-Horizont ENTLARVEN soll, wäre dann selbst falsch.
    let k = addiereSchatten({ n: 198, summePct: 0, treffer: 99 }, beitrag(KRYPTO_MS));
    k = addiereSchatten(k, beitrag(KRYPTO_MS));
    const a = werteSchattenAus(k);
    expect(a.n).toBe(200);
    expect(a.nAlter).toBe(2);
    expect(a.alterMin).toBe(2_880);
  });

  it('meldet „nicht gemessen" als null, nicht als 0', () => {
    // 0 Minuten Horizont wäre eine Aussage („gleichzeitig gemessen"), und
    // zwar eine falsche. Altbestand hat keinen Horizont, Punkt.
    const a = werteSchattenAus({ n: 500, summePct: -12, treffer: 240 });
    expect(a.alterMin).toBeNull();
    expect(a.nAlter).toBe(0);
  });

  it('macht den ALTEN Befund als Zahl sichtbar', () => {
    // Fünf Minuten Fenster, 0,50 % Roundtrip: Genau die Lage vom 16.08. —
    // Richtung stimmt (roh positiv), Kante tief negativ. Mit dem Horizont
    // daneben ist auf einen Blick klar, dass hier nicht die Signalquelle
    // versagt, sondern die Messvorschrift.
    const fuenfMin = bewerteSchattenSignal(
      { direction: 'buy', price: 100, alterMs: 300_000 },
      100.011,
      0.005,
    );
    const a = werteSchattenAus(addiereSchatten(undefined, fuenfMin));
    expect(a.alterMin).toBe(5);
    expect(a.rohPct).toBeGreaterThan(0);
    expect(a.kantePct).toBeLessThan(-0.45);
  });
});
