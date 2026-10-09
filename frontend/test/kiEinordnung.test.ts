/** Task 22: KI-Einordnung im Detailblatt, Markt-Raster und Trade-Journal. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kiAnzeigeEintrag } from '@autotrd/shared';
import { kiEintragZu, kiZeile } from '../src/kiEinordnung.js';
import { DE, EN } from '../src/i18n.js';

const JETZT = Date.parse('2026-10-09T15:00:00.000Z');
const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const eintrag = (over: Record<string, unknown> = {}) => kiAnzeigeEintrag('4711_AAPL', {
  newsId: '4711', richtung: 'positiv', handlungsfaehig: true, stufe: 'pruefung', staerke: 0.74, eingepreist: 'nein',
  horizontTage: 3, firstSeenAt: '2026-10-09T14:00:00.000Z', decidedAt: '2026-10-09T14:05:00.000Z', sichtung: { ereignis: 'zahlen' }, ...over,
})!;

describe('kiZeile', () => {
  it('liest sich als Satz aus Alltagswörtern', () => {
    const z = kiZeile(eintrag(), JETZT);
    expect(z).toMatchObject({ pfeil: '▲', farbe: 'gn', wirkt: true });
    expect(z.text).toBe('gut für den Wert · gegengeprüft · Stärke 7/10 · Quartalszahlen · noch nicht im Kurs · wirkt etwa 3 Tage');
  });

  it('nur gesichtet, unbestätigt, eingepreist oder zu alt wirkt nicht — und sagt das', () => {
    expect(kiZeile(eintrag({ stufe: 'sichtung', handlungsfaehig: false }), JETZT)).toMatchObject({ wirkt: false });
    expect(kiZeile(eintrag({ stufe: 'sichtung', handlungsfaehig: false }), JETZT).text).toContain('nur gesichtet');
    expect(kiZeile(eintrag({ handlungsfaehig: false }), JETZT).text).toContain('Gegenprobe hat nicht bestätigt');
    expect(kiZeile(eintrag({ eingepreist: 'ja' }), JETZT).wirkt).toBe(false);
    expect(kiZeile(eintrag(), JETZT + 7 * 3_600_000).wirkt).toBe(false);
    expect(kiZeile(eintrag({ richtung: 'negativ' }), JETZT)).toMatchObject({ pfeil: '▼', farbe: 'rd' });
  });

  it('Join fürs Journal über {newsId}_{symbol}', () => {
    expect(kiEintragZu([eintrag()], '4711', 'AAPL')?.id).toBe('4711_AAPL');
    expect(kiEintragZu([eintrag()], '4711', 'MSFT')).toBeNull();
    expect(kiEintragZu([eintrag()], undefined, 'AAPL')).toBeNull();
  });

  it('alle kie.*-Texte gibt es auf Deutsch und Englisch', () => {
    const de = Object.keys(DE).filter((k) => k.startsWith('kie.'));
    expect(de.length).toBeGreaterThanOrEqual(30);
    for (const k of de) expect(EN[k as keyof typeof EN], k).toBeTruthy();
  });
});

describe('Verdrahtung', () => {
  it('Detailblatt: nur über die erneut geprüfte Whitelist, Text escaped', () => {
    expect(dashboard).toContain('return Array.isArray(roh) ? roh.map(kiAnzeigeGespeichert).filter((e): e is KiAnzeigeEintrag => e !== null) : [];');
    expect(dashboard).toContain('<span class="dki-t">${esc(z.text)}');
    expect(dashboard).toContain("<div class=\"hint dki-quelle\">${esc(t('kie.quelle'))}</div>");
    // Eigene Daten des Kontos (users/{uid}/kiAnzeige), nie aus market/** (Red-Team 09.10.).
    expect(dashboard).toContain('kiVerlaufAus(await ladeKiAnzeige(st.uid, symbol).catch(() => null))');
    expect(dashboard).not.toMatch(/data\?\.ki\b|\.ki\?\.verlauf/);
  });

  it('Abzeichen nur für frische, gegengeprüfte Einordnungen (KI_GUELTIG_STUNDEN)', () => {
    expect(dashboard).toContain('const kiJetzt = kiAktuell(kiVerlaufAus(kiAlle.get(symbol)), symbol, Date.now());');
    expect(dashboard).toContain("abz.textContent = `KI${kiJetzt.richtung === 'positiv' ? '▲' : '▼'}`;");
  });

  it('Journal: Einordnung zur Nachricht des Trades, ehrliche Lücke wenn verdrängt', () => {
    expect(dashboard).toContain("return { art: 'info', text: e ? t('kie.journal').replace('{0}', kiZeile(e, Date.now()).text) : t('kie.journalWeg') };");
  });
});
