/**
 * Maßstab der TRADE-Kennzahlen (Befund 08.09.2026).
 *
 * Ein Nutzer schickte einen Screenshot: „Profit-Faktor 1.56 · Erwartung
 * +20,63 $" direkt neben „Gesamt P&L −297,47 $" und fragte, ob der Trader
 * kaputt sei. Keine der Zahlen war falsch — sie messen Verschiedenes:
 * Trefferquote, Profit-Faktor und Erwartung zählen JEDEN Abschluss der
 * Kontohistorie, Gesamt P&L zählt das Konto erst ab der Kapitalbasis. Nach
 * einem Depot-Schnitt klafft das zwangsläufig auseinander.
 *
 * Gesamt P&L trägt seinen Maßstab seit dem 13.08. (pnlMassstab.test.ts) —
 * diese drei trugen keinen. Eine unbeschriftete Zahl, die günstiger aussieht
 * als das Konto, ist ein Anzeigefehler in Richtung „gefühlter Gewinn"; genau
 * davor warnt die Kommentarzeile über der Gesamt-P&L-Rechnung.
 *
 * Zweiter Befund derselben Stelle: Die Trefferquote wurde aus der GELADENEN
 * SEITE gerechnet — drei Zeilen unter dem Kommentar, der davor warnt. Sie
 * sprang damit bei jedem „Ältere laden", obwohl `users/{uid}/stats/main` sie
 * serverseitig über alle Trades hält und das Dashboard das Dokument ohnehin
 * lädt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const renderPortfolio = dashboard.slice(
  dashboard.indexOf('function renderPortfolio'),
  dashboard.indexOf('function renderPfStats'),
);

describe('Trefferquote — vollständig statt geladene Seite', () => {
  it('nimmt die serverseitige Quote aus stats/main', () => {
    expect(renderPortfolio).toContain('const wrVollstaendig = st.pfStats?.winRatePct ?? null;');
  });

  it('die geladene Seite ist nur der Notnagel, nicht die Quelle', () => {
    const stelle = renderPortfolio.indexOf('const winRate =');
    expect(stelle, 'winRate-Zuweisung fehlt').toBeGreaterThan(0);
    const zeile = renderPortfolio.slice(stelle, renderPortfolio.indexOf('\n', stelle));
    // Der vollständige Wert steht VOR dem ??-Fallback — sonst gewänne die Seite.
    expect(zeile).toContain('wrVollstaendig ??');
  });

  it('der Notnagel wird sichtbar gekennzeichnet, statt wie eine Gesamtquote auszusehen', () => {
    expect(renderPortfolio).toContain("wrNurSeite ? ' *' : ''");
    expect(renderPortfolio).toContain("t('pf.wrNurSeiteA')");
    expect(DE['pf.wrNurSeiteB']).toContain('Gesamtzahl steht noch nicht bereit');
  });

  it('neue Server-Kennzahlen zeichnen das Portfolio neu — sonst bliebe der Notnagel stehen', () => {
    const stelle = dashboard.indexOf('watchPortfolioStats(uid, (stats) => {');
    expect(stelle, 'watchPortfolioStats fehlt').toBeGreaterThan(0);
    const block = dashboard.slice(stelle, stelle + 600);
    expect(block).toContain('renderPortfolio();');
    expect(block).toContain('renderPfStats();');
  });
});

describe('Maßstab unter Profit-Faktor und Erwartung', () => {
  it('die Zeile sitzt im Markup unter dem Kennzahlen-Gitter', () => {
    const gitter = dashboard.indexOf('id="pfGrid"');
    const exp = dashboard.indexOf('id="pfExp"');
    const basis = dashboard.indexOf('id="pfBasis"');
    expect(gitter).toBeGreaterThan(0);
    expect(basis, 'pfBasis fehlt im Markup').toBeGreaterThan(exp);
  });

  it('nennt die Zahl der Abschlüsse, über die gerechnet wurde', () => {
    expect(dashboard).toContain("t('pf.ueberAlleA')");
    expect(dashboard).toContain("n === 1 ? t('pf.abschluss1') : t('pf.abschlussN')");
    expect(DE['pf.ueberAlleA']).toContain('Profit-Faktor');
  });

  it('grenzt nach einem Depot-Schnitt ausdrücklich gegen Gesamt P&L ab', () => {
    // Das ist der Kern: Ohne diesen Satz bleibt der Widerspruch unerklärt.
    expect(dashboard).toContain('const schnitt = st.wallet?.resetAt;');
    expect(dashboard).toContain("t('pf.auchVorSchnitt')");
    expect(DE['pf.auchVorSchnittB']).toContain('Gesamt P&L nicht mehr enthält');
  });

  it('bleibt verborgen, solange es keinen einzigen Abschluss gibt', () => {
    expect(dashboard).toContain('pfBasis.hidden = n === 0;');
  });

  it('alle neuen Schlüssel sind auch auf Englisch da', () => {
    for (const k of ['pf.ueberAlleA', 'pf.abschluss1', 'pf.abschlussN', 'pf.auchVorSchnitt', 'pf.auchVorSchnittB', 'pf.wrNurSeiteA', 'pf.wrNurSeiteB'] as const) {
      expect(DE[k], `DE fehlt: ${k}`).toBeTruthy();
      expect(EN[k], `EN fehlt: ${k}`).toBeTruthy();
    }
  });
});
