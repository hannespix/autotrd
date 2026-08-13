/**
 * Cash-Hinweis beim Short-Buch (Owner-Frage 13.08., zweimal gestellt).
 *
 * Der Screenshot zeigte „CASH $−167.757,80" über „EQUITY $99.213,80" — und
 * die nackte negative Zahl las sich wie ein Sechsstellig-Verlust. Tatsächlich
 * ist sie Buchungslogik: Buch-Cash = Broker-Cash − 2 × Σ Short-Einstände
 * (adoptBroker/K-5, kontoAbgleich #277); die Equity daneben ist der echte,
 * broker-identische Kontostand. Eine Zahl, die zweimal dieselbe berechtigte
 * Rückfrage auslöst, ist ein Anzeige-Fehler — der Hinweis gehört an die Zahl.
 *
 * Die Wächter kodieren die drei Eigenschaften, die den Hinweis ehrlich
 * machen: Er erscheint NUR bei negativem Cash, er erklärt die Mechanik im
 * Klartext, und er nennt das verfügbare Kapital als max(0, cash) — reine
 * Anzeige, keine Wallet-Arithmetik.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Cash-Hinweis — Markup und Logik', () => {
  it('der Hinweis-Platz existiert direkt an der Cash-Zahl', () => {
    const cashZeile = dashboard.indexOf('id="vCash"');
    const hint = dashboard.indexOf('id="vCashHint"');
    expect(hint, 'vCashHint fehlt im Markup').toBeGreaterThan(0);
    // Direkt an der Zahl, nicht irgendwo in der Karte: zwischen Cash und
    // dem nächsten Feld (Equity).
    const equity = dashboard.indexOf('id="vEq"');
    expect(hint).toBeGreaterThan(cashZeile);
    expect(hint).toBeLessThan(equity);
  });

  it('erscheint NUR bei negativem Cash', () => {
    const render = dashboard.slice(dashboard.indexOf('function renderPortfolio'));
    const bedingung = render.indexOf('cash !== null && cash < 0');
    expect(bedingung, 'Negativ-Bedingung fehlt').toBeGreaterThan(0);
    expect(render.slice(0, bedingung + 600)).toContain('cashHint.hidden = !negativ');
  });

  it('erklärt die Short-Mechanik und verweist auf die Equity als echten Stand', () => {
    expect(dashboard).toContain('Shorts binden 2× ihren Einstand');
    expect(dashboard).toContain('der echte Kontostand');
  });

  it('nennt das verfügbare Kapital als max(0, cash) — Anzeige, keine Arithmetik', () => {
    expect(dashboard).toContain('money(Math.max(0, cash))');
  });
});
