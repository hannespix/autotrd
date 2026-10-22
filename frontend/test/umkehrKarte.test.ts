/**
 * Karte „Kurzfrist-Umkehr" (Task 34, Schritt 3).
 *
 * Geprüft wird, was eine falsche Darstellung anrichten würde (Befunde von
 * UI-Kritik und Red-Team 22.10.):
 *  - Die Karte darf keinen Kauf als „ausgeführt" melden — der Server
 *    stempelt den Plan VOR dem Handel; Beleg ist allein das Depot.
 *  - Ein alter Plan (Modus gewechselt, Engine gestoppt, Konto übersprungen)
 *    darf nicht als „nächste Eröffnung" dastehen.
 *  - „Normaler Tag" erst, wenn ein Abendplan vorliegt — nicht beim Laden.
 *  - Ein veralteter Kryptolauf zeigt keine alten Käufe; der nächste Versuch
 *    stimmt auch nach 14:10 UTC.
 *  - Jedes Symbol läuft über den Aufrufer (`data-sym`, CLAUDE.md §6).
 * Das Layout auf 390/280 px misst `frontend/e2e/umkehr-shot.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  laufZeit,
  naechsterKryptoVersuch,
  naechsterSchritt,
  nyZeitpunkt,
  planAktuell,
  rsiText,
  tagText,
  umkehrKontoHinweis,
  umkehrLaeufe,
  umkehrOhneKaufText,
  umkehrPlanHtml,
  umkehrSignalAnzahl,
  umkehrSignaleHtml,
  umkehrZahlen,
  type UmkehrKontoPlan,
  type UmkehrStatus,
} from '../src/umkehrKarte.js';
import { INFO_DE, INFO_EN } from '../src/infotips.js';

const sym = (s: string): string => `<span data-sym="${s}">${s}</span>`;
const sprache = (l: 'de' | 'en'): void => {
  vi.stubGlobal('localStorage', { getItem: () => l, setItem: () => undefined });
};
afterEach(() => vi.unstubAllGlobals());

const OK = { mode: 'umkehr', running: true, echtgeld: false };
const LEER = new Set<string>();

const STATUS: UmkehrStatus = {
  abend: { at: '2026-10-21T20:45:00Z', tag: '2026-10-21', signale: [{ symbol: 'DBA', rsi: 2.72 }, { symbol: 'XLE', rsi: 8.1 }], signaleN: 2 },
  morgen: { at: '2026-10-22T13:35:00Z', kaeufe: 0, verkaeufe: 1, ohneKauf: { gehalten: 7, bargeldOderPlatz: 0, gesperrt: 0, abgelehnt: 0 } },
  krypto: { at: '2026-10-22T04:10:20Z', tag: '2026-10-20', soll: '2026-10-21', veraltet: true, kaeufe: 2, signale: [{ symbol: 'AVAX-USD', rsi: 1.2 }] },
};
const PLAN: UmkehrKontoPlan = {
  tag: '2026-10-21',
  erstelltAt: '2026-10-21T20:45:30Z',
  kaufen: [{ symbol: 'DBA', rsi: 2.72 }],
  verkaufen: [{ symbol: 'META', grund: 'umkehr_erholt' }],
  ausgefuehrtAm: null,
};
// Offener Plan: der Morgenlauf liegt VOR dem Plan.
const VOR_MORGEN: UmkehrStatus = { ...STATUS, morgen: { ...STATUS.morgen, at: '2026-10-21T13:35:00Z' } };

describe('Konto bekommt Pläne nur wie der Server (umkehrKonten)', () => {
  it('anderer Modus, undefined, Echtgeld, gestoppt ⇒ eigener Hinweis statt „normal"', () => {
    sprache('de');
    expect(umkehrKontoHinweis(OK)).toBe('');
    expect(umkehrKontoHinweis({ ...OK, mode: 'confluence' })).toContain('anderen Modus');
    expect(umkehrKontoHinweis({ ...OK, mode: undefined })).toContain('anderen Modus');
    expect(umkehrKontoHinweis({ ...OK, echtgeld: true })).toContain('Echtgeld');
    expect(umkehrKontoHinweis({ ...OK, running: false })).toContain('gestoppt');
    const html = umkehrPlanHtml(PLAN, STATUS, { ...OK, running: false }, LEER, sym);
    expect(html).toContain('gestoppt');
    expect(html).not.toContain('DBA');
  });
});

describe('Plan des eigenen Kontos', () => {
  it('nur aktuell, wenn er zum letzten Abendplan gehört', () => {
    expect(planAktuell(PLAN, STATUS)).toBe(PLAN);
    expect(planAktuell({ ...PLAN, tag: '2026-10-20' }, STATUS)).toBeNull();
    expect(planAktuell(PLAN, { morgen: STATUS.morgen })).toBeNull();
    expect(planAktuell(null, STATUS)).toBeNull();
  });

  it('offen: Datum, nächste Eröffnung, RSI; jedes Symbol über data-sym', () => {
    sprache('de');
    const html = umkehrPlanHtml(PLAN, VOR_MORGEN, OK, LEER, sym);
    expect(html).toContain('Plan vom 21.10. – Kauf kurz nach der nächsten Eröffnung');
    expect(html).toContain('data-sym="DBA"');
    expect(html).toContain('data-sym="META"');
    expect(html).toContain('RSI 2,7');
    expect(html).toContain('erholt (über 5‑Tage‑Schnitt)');
    expect(umkehrPlanHtml({ ...PLAN, verkaufen: [{ symbol: 'X', grund: 'umkehr_frist' }] }, VOR_MORGEN, OK, LEER, sym)).toContain('10 Handelstage vorbei');
  });

  it('bearbeitet: NIE „ausgeführt" — je Zeile, was das Depot sagt', () => {
    sprache('de');
    const bearbeitet = { ...PLAN, ausgefuehrtAm: '2026-10-22' };
    const leer = umkehrPlanHtml(bearbeitet, STATUS, OK, LEER, sym);
    expect(leer).toContain('zur Eröffnung am 22.10. abgearbeitet');
    expect(leer).not.toMatch(/ausgeführt/);
    expect(leer).toContain('nicht im Depot'); // DBA nie gekauft (Bargeld/Platz/Sperre)
    expect(leer).toContain('verkauft'); // META weg
    const voll = umkehrPlanHtml(bearbeitet, STATUS, OK, new Set(['DBA', 'META']), sym);
    expect(voll).toContain('>im Depot<');
    expect(voll).toContain('noch im Depot');
  });

  it('Kaufsperre zur Eröffnung steht da', () => {
    sprache('de');
    const html = umkehrPlanHtml({ ...PLAN, ausgefuehrtAm: '2026-10-22', einstiegGesperrt: 'tages_notbremse' }, STATUS, OK, LEER, sym);
    expect(html).toContain('Kaufsperre');
  });

  it('ohne Stempel, aber Morgenlauf schon nach dem Plan ⇒ „nicht abgearbeitet", nicht „nächste Eröffnung"', () => {
    sprache('de');
    const html = umkehrPlanHtml(PLAN, STATUS, OK, LEER, sym);
    expect(html).toContain('nicht abgearbeitet');
    expect(html).not.toContain('nächsten Eröffnung');
  });

  it('leer: „normal" nur MIT Abendplan; ohne Abendplan „noch keine Daten"', () => {
    sprache('de');
    expect(umkehrPlanHtml(null, STATUS, OK, LEER, sym)).toContain('Abendplan vom 21.10.');
    expect(umkehrPlanHtml(null, STATUS, OK, LEER, sym)).toContain('Das ist normal');
    expect(umkehrPlanHtml({ ...PLAN, kaufen: [], verkaufen: [] }, STATUS, OK, LEER, sym)).toContain('Das ist normal');
    expect(umkehrPlanHtml(null, null, OK, LEER, sym)).toContain('Noch keine Daten');
    expect(umkehrPlanHtml(null, null, OK, LEER, sym)).not.toContain('normal');
  });

  it('kaputte Einträge sprengen nichts', () => {
    sprache('de');
    const kaputt = { ...PLAN, kaufen: [{ symbol: undefined as unknown as string, rsi: 1 }, { symbol: 'DBA', rsi: 2 }] };
    expect(() => umkehrPlanHtml(kaputt, VOR_MORGEN, OK, LEER, sym)).not.toThrow();
  });
});

describe('Kennzahlen und Signale', () => {
  it('Zahl der Signale = Liste (Börse + frische Krypto); veraltete Krypto zählt nicht', () => {
    sprache('de');
    expect(umkehrSignalAnzahl(STATUS)).toBe(2);
    expect(umkehrSignalAnzahl({ ...STATUS, krypto: { ...STATUS.krypto, veraltet: false } })).toBe(3);
    expect(umkehrSignalAnzahl(null)).toBeNull();
    expect(umkehrZahlen(STATUS, PLAN)).toEqual({ plan: '1', signale: '2', alle: '0' });
    expect(umkehrZahlen(null, null)).toEqual({ plan: '—', signale: '—', alle: '—' });
    // Nach der Eröffnung zählt das Depot, nicht der Plan.
    const bearbeitet = { ...PLAN, kaufen: [{ symbol: 'DBA', rsi: 2 }, { symbol: 'XLE', rsi: 3 }], ausgefuehrtAm: '2026-10-22' };
    expect(umkehrZahlen(STATUS, bearbeitet, new Set(['DBA'])).plan).toBe('1');
    expect(umkehrZahlen(STATUS, { ...bearbeitet, ausgefuehrtAm: null }, new Set(['DBA'])).plan).toBe('2');
  });

  it('tiefster RSI zuerst, „in deinem Plan"/„Krypto" in der Mitte, „+ N weitere" bei Kappung', () => {
    sprache('de');
    const frisch = { ...STATUS, krypto: { ...STATUS.krypto, veraltet: false } };
    const html = umkehrSignaleHtml(frisch, PLAN, sym);
    expect(html.indexOf('AVAX-USD')).toBeLessThan(html.indexOf('DBA'));
    expect(html).toContain('in deinem Plan');
    expect(html).toContain('>Krypto<');
    expect(umkehrSignaleHtml(STATUS, PLAN, sym)).not.toContain('AVAX-USD');
    const viele: UmkehrStatus = { abend: { tag: '2026-10-21', signaleN: 40, signale: Array.from({ length: 30 }, (_, i) => ({ symbol: `S${i}`, rsi: i / 4 })) } };
    expect(umkehrSignaleHtml(viele, null, sym)).toContain('+ 32 weitere');
  });

  it('ohne Signal: datierter „normaler Tag"; ohne Daten: „noch keine Daten"', () => {
    sprache('de');
    expect(umkehrSignaleHtml({ abend: { tag: '2026-10-21', signale: [] } }, null, sym)).toContain('Abendplan vom 21.10. kein Kaufsignal');
    expect(umkehrSignaleHtml(null, null, sym)).toContain('Noch keine Daten');
    sprache('en');
    expect(umkehrSignaleHtml({ abend: { tag: '2026-10-21', signale: [] } }, null, sym)).toContain('normal day');
  });
});

describe('Läufe und Gründe', () => {
  it('drei Zeilen; veraltete Krypto zeigt den nächsten Versuch statt alter Käufe', () => {
    sprache('de');
    const html = umkehrLaeufe(STATUS);
    expect(html.match(/uk-lauf/g)).toHaveLength(3);
    expect(html).toContain('Krypto-Kurse von gestern fehlen noch');
    expect(html).not.toContain('2 Käufe');
    expect(umkehrLaeufe(null)).toContain('noch kein Lauf');
    expect(umkehrLaeufe({ morgen: { at: '2026-10-22T13:35:00Z', kaeufe: 1, verkaeufe: 2 } })).toContain('>1 Kauf<');
    expect(umkehrLaeufe({ abend: { at: '2026-10-21T20:45:00Z', tag: '2026-10-21', signaleN: 1 } })).toContain('>1 Signal<');
  });

  it('nächster Kryptoversuch: +2 h bis 14:10 UTC, danach 00:10 am Folgetag', () => {
    expect(new Date(naechsterKryptoVersuch(Date.parse('2026-10-22T04:10:20Z'))).toISOString()).toBe('2026-10-22T06:10:00.000Z');
    expect(new Date(naechsterKryptoVersuch(Date.parse('2026-10-22T13:10:00Z'))).toISOString()).toBe('2026-10-22T14:10:00.000Z');
    expect(new Date(naechsterKryptoVersuch(Date.parse('2026-10-22T14:10:05Z'))).toISOString()).toBe('2026-10-23T00:10:00.000Z');
  });

  it('Gründe: Eröffnung + frischer Kryptolauf summiert, nur was vorkam', () => {
    sprache('de');
    expect(umkehrOhneKaufText(STATUS)).toBe('Warum nicht alles gekauft wurde (alle Konten zusammen): 7× schon im Depot oder Wert einzeln gesperrt');
    const mitKrypto: UmkehrStatus = { ...STATUS, krypto: { veraltet: false, ohneKauf: { gehalten: 1, abgelehnt: 2 } } };
    expect(umkehrOhneKaufText(mitKrypto)).toContain('8× schon im Depot');
    expect(umkehrOhneKaufText(mitKrypto)).toContain('2× Order abgelehnt');
    expect(umkehrOhneKaufText({ morgen: { ohneKauf: { gehalten: 0 } } })).toBe('');
    expect(umkehrOhneKaufText(null)).toBe('');
  });
});

describe('Zeit', () => {
  it('New Yorker Wanduhr ⇒ UTC, auch über die Zeitumstellung', () => {
    expect(new Date(nyZeitpunkt(2026, 10, 22, 9, 35)).toISOString()).toBe('2026-10-22T13:35:00.000Z'); // EDT
    expect(new Date(nyZeitpunkt(2026, 11, 2, 9, 35)).toISOString()).toBe('2026-11-02T14:35:00.000Z'); // EST
  });

  it('nächster Schritt: Kauf 9:35 / Abendplan 16:45 NY, Wochenende übersprungen', () => {
    expect(naechsterSchritt(Date.parse('2026-10-22T12:00:00Z'))).toEqual({ art: 'morgen', ms: Date.parse('2026-10-22T13:35:00Z') });
    expect(naechsterSchritt(Date.parse('2026-10-22T15:00:00Z'))).toEqual({ art: 'abend', ms: Date.parse('2026-10-22T20:45:00Z') });
    // Freitag nach dem Abendplan ⇒ Montag 9:35.
    expect(naechsterSchritt(Date.parse('2026-10-23T21:00:00Z'))).toEqual({ art: 'morgen', ms: Date.parse('2026-10-26T13:35:00Z') });
  });

  it('Komma/Punkt nach Sprache; Zeitzone steht dabei; kaputte Werte ⇒ —', () => {
    sprache('de');
    expect(rsiText(2.72)).toBe('2,7');
    expect(tagText('2026-10-21')).toBe('21.10.');
    expect(laufZeit('2026-10-22T13:35:00Z')).toMatch(/[A-Z]{2,}|GMT|UTC/);
    sprache('en');
    expect(rsiText(2.72)).toBe('2.7');
    expect(tagText('2026-10-21')).toBe('10/21');
    expect(rsiText(Number.NaN)).toBe('—');
    expect(laufZeit(undefined)).toBe('—');
    expect(laufZeit('kaputt')).toBe('—');
    expect(tagText(null)).toBe('—');
  });
});

describe('Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const lies = (p: string): string => readFileSync(join(hier, p), 'utf8');

  it('Karte im Dashboard, Symbole als Etikett, Depot + Konto-Zustand übergeben, abgeschirmt', () => {
    const d = lies('../src/dashboard.ts');
    expect(d).toContain("${umkehrGeruest(iBtn('umkehr'))}");
    expect(d).toContain("umkehr: t('panel.umkehr'),");
    expect(d).toContain('const sym = (x: string): string => symbolEtikett(x, false);');
    expect(d).toContain('umkehrRendern($, st.umkehrStatus, st.umkehrPlan, konto, gehalten, sym, Date.now());');
    expect(d).toContain("const konto = { mode: s?.engine?.mode, running: s?.engine?.running === true, echtgeld: s?.broker?.mode === 'live' };");
    expect(d).toContain("console.warn('Umkehr-Karte nicht gerendert', err);");
    expect(d).toContain('      st.positions = positions;\n      renderUmkehr();');
    expect(d).toContain('watchUmkehrPlan(uid, (doc) => {');
    expect(d).toContain('watchUmkehr((doc) => {');
    expect(lies('../src/umkehrKarte.ts')).toContain('<div class="card" data-panel="umkehr">');
  });

  it('Regel: nur der EIGENE Plan ist lesbar, nicht die übrigen users/{uid}/meta-Docs', () => {
    const r = lies('../../firestore.rules');
    expect(r).toContain('match /meta/umkehrPlan {\n        allow read: if isOwner(uid);\n        allow write: if false;');
    expect(r).not.toMatch(/match \/users\/\{uid\}[\s\S]*match \/meta\/\{[a-zA-Z=*]+\} \{\n\s*allow read: if isOwner/);
  });

  it('Infotexte: Umkehr als Standard; Ertrag nur für die Rückrechnung ohne Krypto', () => {
    expect(INFO_DE['engineMode']?.d).toContain('„Kurzfrist-Umkehr" (Standard seit 20.10.)');
    expect(INFO_EN['engineMode']?.d).toContain('(default since 20 Oct)');
    expect(INFO_DE['umkehr']?.d).toContain('Notbremse bei −15 % (Krypto −25 %)');
    expect(INFO_EN['umkehr']?.d).toContain('emergency brake at −15 % (crypto −25 %)');
    expect(INFO_DE['umkehr']?.d).toContain('auf 35 Börsenwerte (ohne Krypto)');
    expect(INFO_DE['umkehr']?.d).toContain('Für Krypto ist kein Vorsprung belegt.');
    expect(INFO_EN['umkehr']?.d).toContain('For crypto no edge is proven.');
  });
});
