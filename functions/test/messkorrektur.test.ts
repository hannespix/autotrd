/**
 * Messkorrektur (Red-Team 05.10., umgesetzt 08.10.): Drei Zahlen, die Trades
 * steuern, waren falsch gemessen — ohne dass es jemand sehen konnte.
 *
 *  H1 Die Tagesbewertung holte 200 Dokumente in Pfad-Reihenfolge; dauerhaft
 *     unbewertbare Altlasten am Kopf verhungerten alles dahinter.
 *  H2 `scored` zählte Dokumente (3 je Fall) — das Stimmrecht der Prognose
 *     kam nach 7 Fällen statt nach 20.
 *  M3 `accounts` im Kollektiv-Vorwissen zählte jedes Konto täglich neu.
 *
 * Dazu der Puls-Herzschlag: still stehen und nichts zu tun haben sahen gleich aus.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KERZEN_NACH_ENDTAG,
  kerzenNachEndTag,
  tagesPrognoseVerfallen,
  TAGES_VERFALL_OHNE_KURSE_TAGE,
  TAGES_VERFALL_TAGE,
} from '../src/scheduled/evalForecasts.js';
import { axisKey, KOLLEKTIV_SAMMLUNG, KONTEN_ZAEHLUNG_V, neuesKontoFuer } from '../src/scheduled/autoTune.js';
import { PULSE_HERZSCHLAG_MIN, pulsHerzschlagFaellig } from '../src/scheduled/riskPulse.js';
import { GELOESCHTE_SAMMLUNGEN } from '../src/callable/reset.js';
import { bestParams, comboKey, DEFAULT_LOOKBACK, fallZahl, MIN_TOTAL_SCORES } from '../../shared/src/index.js';

const lese = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', '..', ...teile), 'utf8');
const evalSrc = lese('functions', 'src', 'scheduled', 'evalForecasts.ts');
const tuneSrc = lese('functions', 'src', 'scheduled', 'autoTune.ts');
const pulsSrc = lese('functions', 'src', 'scheduled', 'riskPulse.ts');
const indexe = JSON.parse(lese('firestore.indexes.json')) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }>;
};

describe('H1 — Tagesbewertung verhungert nicht mehr', () => {
  it('Verfall: strikt älter als TAGES_VERFALL_TAGE Kalendertage', () => {
    expect(TAGES_VERFALL_TAGE).toBe(30);
    expect(tagesPrognoseVerfallen('2026-09-01', '2026-10-08')).toBe(true); // 37 Tage
    expect(tagesPrognoseVerfallen('2026-09-08', '2026-10-08')).toBe(false); // genau 30 → noch nicht
    expect(tagesPrognoseVerfallen('2026-09-07', '2026-10-08')).toBe(true); // 31
    expect(tagesPrognoseVerfallen('2026-10-07', '2026-10-08')).toBe(false);
  });
  it('unlesbare Daten verfallen NIE (lieber warten als wegwerfen)', () => {
    expect(tagesPrognoseVerfallen('kaputt', '2026-10-08')).toBe(false);
    expect(tagesPrognoseVerfallen('2026-09-01', '')).toBe(false);
  });
  it('die Schlange ist nach Basistag sortiert, mit Rückfall bis der Index steht', () => {
    expect(evalSrc).toContain("pending = await base.orderBy('baseDate', 'asc').limit(BATCH_LIMIT).get();");
    expect(evalSrc).toContain("logger.warn('evalForecasts: Index (evaluated, baseDate) noch nicht bereit — unsortiert', err);");
    const idx = indexe.indexes.find((i) => i.collectionGroup === 'forecasts');
    expect(idx?.queryScope).toBe('COLLECTION_GROUP');
    expect(idx?.fields.map((f) => `${f.fieldPath}:${f.order}`)).toEqual(['evaluated:ASCENDING', 'baseDate:ASCENDING']);
  });
  it('verfallen heißt NIE bewerten — das Gate bleibt: kein Score ohne realisierten End-Tag', () => {
    // Der Verfall sitzt ausschließlich im `!score`-Zweig, und der endet mit
    // `continue`, bevor irgendein Zähler erreicht wird.
    const start = evalSrc.indexOf('      if (!score) {');
    const ende = evalSrc.indexOf('symbolDelta.set(key, d);', start);
    expect(start).toBeGreaterThan(-1);
    expect(ende).toBeGreaterThan(start);
    const zweig = evalSrc.slice(start, ende);
    expect(zweig).toContain(
      'if (kerzenNachEndTag(actuals, endTag) >= KERZEN_NACH_ENDTAG || tagesPrognoseVerfallen(endTag, today)) {',
    );
    expect(zweig).toContain('batch.update(ref, { evaluated: true, expired: true });');
    expect(zweig).toContain('continue;');
    expect(zweig).not.toContain('scored += 1');
    expect(zweig).not.toContain('tallySent(');
    // Das Fälligkeits-Gate selbst ist unangetastet.
    expect(evalSrc).toContain('if (!isForecastDue(doc.points, today)) continue;');
  });
  it('B2: Feiertag als End-Tag verfällt, sobald der Markt zwei Kerzen weiter ist — eine Lücke wartet', () => {
    expect(KERZEN_NACH_ENDTAG).toBe(2);
    const actuals = { '2026-12-23': 100, '2026-12-24': 101, '2026-12-28': 102, '2026-12-29': 103 };
    expect(kerzenNachEndTag(actuals, '2026-12-25')).toBe(2); // Weihnachten: nie eine Kerze
    expect(kerzenNachEndTag(actuals, '2026-12-28')).toBe(1); // Yahoo-Lücke am 28.? erst eine danach → warten
    expect(kerzenNachEndTag({ ...actuals, '2026-12-30': 0 }, '2026-12-29')).toBe(0); // Null-Close zählt nicht
  });
  it('B1: ohne Snapshot wird NICHT nach 30 Tagen verfallen, sondern erst nach 120 — und nur nach erfolgreichem Commit', () => {
    expect(TAGES_VERFALL_OHNE_KURSE_TAGE).toBe(120);
    expect(evalSrc).toContain('tagesPrognoseVerfallen(endTagVon(doc), today, TAGES_VERFALL_OHNE_KURSE_TAGE),');
    expect(evalSrc).toContain('if (ok) expired += tot.length;');
    expect(evalSrc).not.toContain('const alt = entries.filter(');
  });
  it('die Diagnose landet im Herzschlag (pending auf dem Limit = Stau)', () => {
    for (const f of ['pending: res.pending', 'due: res.due', 'expired: res.expired', 'unrealized: res.unrealized']) {
      expect(evalSrc).toContain(f);
    }
  });
});

describe('H2 — scored zählt Fälle, nicht Dokumente', () => {
  it('fallZahl = größtes n einer Kombi (alle Kombis sehen dieselben Fälle)', () => {
    expect(fallZahl({})).toBe(0);
    expect(fallZahl({ '10': { n: 7, hits: 4, maeSum: 1 }, '20': { n: 7, hits: 3, maeSum: 1 }, '30': { n: 6, hits: 3, maeSum: 1 } })).toBe(7);
  });
  it('B6: bestParams und tuningActive teilen dieselbe Schwelle — 19 Fälle sind Defaults, 20 wählen', () => {
    // Gewinner ist Arm 10 — NICHT der Default (20), sonst wäre der Test tautologisch.
    const mit = (n: number) => ({
      [comboKey(10)]: { n, hits: Math.round(n * 0.9), maeSum: n },
      [comboKey(20)]: { n, hits: Math.round(n * 0.6), maeSum: n },
      [comboKey(30)]: { n, hits: Math.round(n * 0.5), maeSum: n },
    });
    expect(DEFAULT_LOOKBACK).not.toBe(10);
    expect(bestParams(mit(19))).toEqual({ lookback: DEFAULT_LOOKBACK });
    expect(bestParams(mit(20))).toEqual({ lookback: 10 });
    expect(fallZahl(mit(20)) >= MIN_TOTAL_SCORES).toBe(true);
  });
  it('Stimmrecht erst nach MIN_TOTAL_SCORES FÄLLEN — in beiden Pfaden', () => {
    expect(MIN_TOTAL_SCORES).toBe(20);
    expect(evalSrc.split('scored: faelle,').length - 1).toBe(2);
    expect(evalSrc.split('tuningActive: faelle >= MIN_TOTAL_SCORES,').length - 1).toBe(2);
    expect(evalSrc).not.toContain('scored: total,');
    expect(evalSrc).not.toContain('tuningActive: total >= 20,');
  });
  it('die Trefferquote bleibt über die Arme gepoolt (frei von der Arm-Auswahl)', () => {
    expect(evalSrc.split('dirAccuracy: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,').length - 1).toBe(2);
  });
});

describe('M3 — ein Konto zählt je Variante genau einmal', () => {
  it('neuesKontoFuer: erst ohne Merker, nie mit', () => {
    expect(neuesKontoFuer(undefined, 'x')).toBe(true);
    expect(neuesKontoFuer({}, 'x')).toBe(true);
    expect(neuesKontoFuer({ x: '2026-10-08T00:00:00.000Z' }, 'x')).toBe(false);
    expect(neuesKontoFuer({ y: 'a' }, 'x')).toBe(true);
    expect(neuesKontoFuer({ toString: 'erbe' } as Record<string, unknown>, 'valueOf')).toBe(true); // kein Prototyp-Treffer
  });
  it('axisKey entschärft Punkte und Schrägstriche wie der Firestore-Pfad', () => {
    expect(axisKey('stop.pct/0.5')).toBe('stop_pct_0_5');
  });
  it('der Aufrufer übergibt den berechneten Wert, nicht mehr `true`', () => {
    expect(tuneSrc).toContain('const neu = neuesKontoFuer(beigetragen, key);');
    expect(tuneSrc).toMatch(/\{ promoted: e\.promoted, edge: e\.edge \},\s*neu,/);
    expect(tuneSrc).not.toMatch(/\{ promoted: e\.promoted, edge: e\.edge \},\s*true,/);
  });
  it('B3: der Merker liegt NICHT unter `tuning` — der Reset löscht diese Sammlung', () => {
    expect(KOLLEKTIV_SAMMLUNG).toBe('kollektiv');
    expect((GELOESCHTE_SAMMLUNGEN as readonly string[]).includes(KOLLEKTIV_SAMMLUNG)).toBe(false);
    expect(tuneSrc).toContain("userDoc.ref.collection(KOLLEKTIV_SAMMLUNG).doc('beitrag')");
    expect(tuneSrc).not.toContain("collection('tuning').doc('kollektiv')");
  });
  it('Merker erst nach gezähltem Beitrag; Altbestand wird einmalig genullt', () => {
    expect(KONTEN_ZAEHLUNG_V).toBe(2);
    expect(tuneSrc).toContain("if (stand.get('kontenV') !== KONTEN_ZAEHLUNG_V) {");
    expect(tuneSrc).toContain('for (const key of Object.keys(axes)) nullen[key] = { accounts: 0 };');
    const zaehlung = tuneSrc.indexOf('const gezaehlt = await (ref.update');
    const marker = tuneSrc.indexOf('markerSchreiben.map(({ ref: r, beigetragen }) => r.set({ beigetragen }, { merge: true }))');
    expect(zaehlung).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(zaehlung);
    expect(tuneSrc).toContain('if (gezaehlt) {');
  });
  it('der Merker trägt nur Variantenschlüssel und Datum — keine Zahlen', () => {
    expect(tuneSrc).toContain('if (neu) neueMarker[key] = now.toISOString();');
  });
});

describe('Puls-Herzschlag', () => {
  it('bei Ereignis immer, sonst im 5-Minuten-Takt', () => {
    expect(PULSE_HERZSCHLAG_MIN).toBe(5);
    expect(pulsHerzschlagFaellig(new Date('2026-10-08T14:03:00Z'), false)).toBe(false);
    expect(pulsHerzschlagFaellig(new Date('2026-10-08T14:03:00Z'), true)).toBe(true);
    expect(pulsHerzschlagFaellig(new Date('2026-10-08T14:05:00Z'), false)).toBe(true);
    expect(pulsHerzschlagFaellig(new Date('2026-10-08T14:00:00Z'), false)).toBe(true);
  });
  it('auch ein Margin-Call ist ein Ereignis', () => {
    expect(pulsSrc).toContain('pulsHerzschlagFaellig(now, r.exits > 0 || r.waterMarks > 0 || r.marginCalls > 0)');
  });
  it('B4/B5: Herzschlag auf ALLEN Pfaden, nach meta/pulse — nie nach meta/health', () => {
    expect(pulsSrc.split('return pulsHerzschlag(now, {').length - 1).toBe(3); // market_closed, keine_kurse, Normalpfad
    expect(pulsSrc).toContain(".doc('meta/pulse')");
    expect(pulsSrc).not.toContain("pulse: {");
    expect(pulsSrc).not.toContain(".doc('meta/health')");
  });
});
