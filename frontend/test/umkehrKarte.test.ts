/**
 * Karte „Kurzfrist-Umkehr" (Task 34, Schritt 3).
 *
 * Geprüft wird, was eine falsche Darstellung anrichten würde: Ein Tag ohne
 * Signal muss als NORMAL dastehen (sonst hält der Nutzer die Strategie für
 * kaputt), ein veralteter Kryptolauf darf keine alten Käufe zeigen, und
 * jedes Symbol muss über den Aufrufer laufen (anklickbares Etikett mit
 * `data-sym`, CLAUDE.md §6). Das Layout auf 390 px misst
 * `frontend/e2e/umkehr-shot.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  laufZeit,
  rsiText,
  umkehrLaeufe,
  umkehrModusHinweis,
  umkehrOhneKaufText,
  umkehrPlanHtml,
  umkehrSignaleHtml,
  umkehrZahlen,
  type UmkehrStatus,
} from '../src/umkehrKarte.js';
import { INFO_DE, INFO_EN } from '../src/infotips.js';

const sym = (s: string): string => `<span data-sym="${s}">${s}</span>`;
const sprache = (l: 'de' | 'en'): void => {
  vi.stubGlobal('localStorage', { getItem: () => l, setItem: () => undefined });
};
afterEach(() => vi.unstubAllGlobals());

const STATUS: UmkehrStatus = {
  abend: { at: '2026-10-21T21:52:00Z', tag: '2026-10-21', signale: [{ symbol: 'DBA', rsi: 2.72 }, { symbol: 'XLE', rsi: 8.1 }], signaleN: 2 },
  morgen: { at: '2026-10-22T13:35:00Z', kaeufe: 0, verkaeufe: 1, ohneKauf: { gehalten: 7, bargeldOderPlatz: 0, gesperrt: 0, abgelehnt: 0 } },
  krypto: { at: '2026-10-22T04:10:20Z', tag: '2026-10-20', soll: '2026-10-21', veraltet: true, kaeufe: 2, signale: [{ symbol: 'AVAX-USD', rsi: 1.2 }] },
};

describe('Kennzahlen', () => {
  it('veralteter Kryptolauf zeigt „wartet", nie die alten Käufe', () => {
    sprache('de');
    expect(umkehrZahlen(STATUS)).toEqual({ signale: '2', kaeufe: '0', krypto: 'wartet' });
    expect(umkehrZahlen({ ...STATUS, krypto: { kaeufe: 3, veraltet: false } }).krypto).toBe('3');
    expect(umkehrZahlen(null)).toEqual({ signale: '—', kaeufe: '—', krypto: '—' });
  });
});

describe('Signale', () => {
  it('tiefster RSI zuerst, jedes Symbol über den Aufrufer (data-sym), veraltete Krypto-Signale fallen weg', () => {
    sprache('de');
    const html = umkehrSignaleHtml(STATUS, sym);
    expect(html.indexOf('DBA')).toBeLessThan(html.indexOf('XLE'));
    expect(html).toContain('data-sym="DBA"');
    expect(html).not.toContain('AVAX-USD');
    expect(html).toContain('RSI 2,7');
    const frisch = umkehrSignaleHtml({ ...STATUS, krypto: { ...STATUS.krypto, veraltet: false } }, sym);
    expect(frisch.indexOf('AVAX-USD')).toBeLessThan(frisch.indexOf('DBA'));
  });

  it('ohne Signal steht da, dass das ein normaler Tag ist', () => {
    sprache('de');
    expect(umkehrSignaleHtml({ abend: { signale: [] } }, sym)).toContain('normaler Tag');
    sprache('en');
    expect(umkehrSignaleHtml(null, sym)).toContain('normal day');
  });
});

describe('Plan des eigenen Kontos', () => {
  it('Käufe und Verkäufe mit Grund in Klartext; offen vs. ausgeführt', () => {
    sprache('de');
    const plan = { tag: '2026-10-21', kaufen: [{ symbol: 'DBA', rsi: 2.72 }], verkaufen: [{ symbol: 'META', grund: 'umkehr_erholt' }], ausgefuehrtAm: null };
    const html = umkehrPlanHtml(plan, sym);
    expect(html).toContain('nächste Eröffnung');
    expect(html).toContain('data-sym="DBA"');
    expect(html).toContain('data-sym="META"');
    expect(html).toContain('erholt (über 5-Tage-Schnitt)');
    expect(umkehrPlanHtml({ ...plan, verkaufen: [{ symbol: 'X', grund: 'umkehr_frist' }] }, sym)).toContain('10 Handelstage vorbei');
    expect(umkehrPlanHtml({ ...plan, ausgefuehrtAm: '2026-10-22T13:35:00Z' }, sym)).toContain('letzten Eröffnung ausgeführt');
  });

  it('leerer oder fehlender Plan ist normal, kein Fehler', () => {
    sprache('de');
    expect(umkehrPlanHtml(null, sym)).toContain('Das ist normal');
    expect(umkehrPlanHtml({ kaufen: [], verkaufen: [] }, sym)).toContain('Das ist normal');
  });
});

describe('Läufe und Gründe', () => {
  it('drei Zeilen, Krypto-Wartezustand in Klartext', () => {
    sprache('de');
    const html = umkehrLaeufe(STATUS);
    expect(html.match(/uk-lauf/g)).toHaveLength(3);
    expect(html).toContain('Tageskerze fehlt noch');
    expect(html).not.toContain('2 Käufe');
    expect(umkehrLaeufe(null)).toContain('noch kein Lauf');
  });

  it('„Nicht gekauft" nennt nur Gründe, die vorkamen; nichts zu erklären ⇒ leer', () => {
    sprache('de');
    expect(umkehrOhneKaufText(STATUS)).toBe('Nicht gekauft (alle Konten): 7× schon im Depot oder gesperrt');
    expect(umkehrOhneKaufText({ morgen: { ohneKauf: { gehalten: 0, bargeldOderPlatz: 0, gesperrt: 0, abgelehnt: 0 } } })).toBe('');
    expect(umkehrOhneKaufText(null)).toBe('');
  });

  it('Modus-Hinweis nur, wenn das Konto NICHT auf Umkehr steht', () => {
    sprache('de');
    expect(umkehrModusHinweis('umkehr')).toBe('');
    expect(umkehrModusHinweis(undefined)).toBe('');
    expect(umkehrModusHinweis('confluence')).toContain('anderen Modus');
  });
});

describe('Zahlen- und Zeitformat nach Sprache', () => {
  it('Komma auf Deutsch, Punkt auf Englisch; kaputte Werte ⇒ Gedankenstrich', () => {
    sprache('de');
    expect(rsiText(2.72)).toBe('2,7');
    sprache('en');
    expect(rsiText(2.72)).toBe('2.7');
    expect(rsiText(Number.NaN)).toBe('—');
    expect(laufZeit(undefined)).toBe('—');
    expect(laufZeit('kaputt')).toBe('—');
  });
});

describe('Verdrahtung (Quelltext-Wächter)', () => {
  const hier = dirname(fileURLToPath(import.meta.url));
  const lies = (p: string): string => readFileSync(join(hier, p), 'utf8');

  it('Karte im Dashboard, Symbole als Etikett, beide Abos verdrahtet', () => {
    const d = lies('../src/dashboard.ts');
    expect(d).toContain("${umkehrGeruest(iBtn('umkehr'))}");
    expect(d).toContain("umkehr: t('panel.umkehr'),");
    expect(d).toContain('const sym = (x: string): string => symbolEtikett(x, false);');
    expect(d).toContain('umkehrRendern($, st.umkehrStatus, st.umkehrPlan, st.strategy?.engine?.mode, sym);');
    expect(lies('../src/umkehrKarte.ts')).toContain('<div class="card" data-panel="umkehr">');
    expect(d).toContain('watchUmkehrPlan(uid, (doc) => {');
    expect(d).toContain('watchUmkehr((doc) => {');
  });

  it('Regel: nur der EIGENE Plan ist lesbar, nicht die übrigen users/{uid}/meta-Docs', () => {
    const r = lies('../../firestore.rules');
    expect(r).toContain('match /meta/umkehrPlan {\n        allow read: if isOwner(uid);\n        allow write: if false;');
    expect(r).not.toMatch(/match \/users\/\{uid\}[\s\S]*match \/meta\/\{[a-zA-Z=*]+\} \{\n\s*allow read: if isOwner/);
  });

  it('Infotexte: Modus-Text nennt Umkehr als Standard, Umkehr-Tip zweisprachig', () => {
    expect(INFO_DE['engineMode']?.d).toContain('„Kurzfrist-Umkehr" (Standard seit 20.10.)');
    expect(INFO_EN['engineMode']?.d).toContain('(default since 20 Oct)');
    expect(INFO_DE['umkehr']?.d).toContain('Notbremse bei −15 % (Krypto −25 %)');
    expect(INFO_EN['umkehr']?.d).toContain('emergency brake at −15 % (crypto −25 %)');
  });
});
