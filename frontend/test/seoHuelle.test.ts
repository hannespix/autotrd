/**
 * Der Google-Auftritt der Hülle (Owner-Screenshot 24.08.).
 *
 * Google zeigte als Snippet für autotrd.net die Risiko-Zeile des
 * Login-Screens („Mir ist bewusst, dass autotrd keine Anlageberatung ist…").
 * Ursache: index.html hatte keine Meta-Description, der Body null Zeichen
 * crawlbaren Text — Googles Renderer nahm den einzigen vollständigen Satz
 * der Seite, und das war der Warntext.
 *
 * Die Risiko-Zeile selbst ist Text-Diät-Tabu und bleibt wörtlich. Die
 * Lösung ist, Google eine BESSERE Alternative anzubieten. Diese Wächter
 * pinnen die Alternative — wer den Head umbaut, merkt hier, wenn das
 * Snippet-Problem zurückkäme.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');

describe('index.html — was Google statt der Risiko-Zeile bekommt', () => {
  it('hat eine deutsche Meta-Description mit dem Pflicht-Schlusssatz', () => {
    const m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/s);
    expect(m, 'meta description fehlt').toBeTruthy();
    const text = m![1]!;
    // Kein Marketing ohne Einordnung: Der Hinweis gehört in jede
    // Selbstbeschreibung — er ist die ehrliche Kurzfassung der Rechtstexte.
    expect(text).toContain('Keine Anlageberatung');
    // Und sie beschreibt das Produkt, nicht das Risiko-Tor.
    expect(text).toContain('Trading');
    expect(text.length).toBeGreaterThan(80);
  });

  it('der Titel nennt Paper UND Broker — nicht mehr nur Paper', () => {
    // legal.ts: „autotrd ist KEIN reines Paper-Trading-Tool mehr". Ein Titel,
    // der etwas anderes sagt als die Rechtstexte, wäre eine neue Inkonsistenz.
    const titel = html.match(/<title>([^<]+)<\/title>/)![1]!;
    expect(titel).toContain('autotrd');
    expect(titel.toLowerCase()).toContain('paper');
    expect(titel.toLowerCase()).toContain('broker');
  });

  it('Canonical, Open Graph und Twitter-Card stehen', () => {
    expect(html).toContain('<link rel="canonical" href="https://autotrd.net/" />');
    for (const p of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
      expect(html, `${p} fehlt`).toContain(`property="${p}"`);
    }
    expect(html).toContain('name="twitter:card"');
  });

  it('strukturierte Daten sagen, WAS autotrd ist', () => {
    // Auch als Gegengewicht zur Verwechslung mit „Auto Trader" (Automarkt),
    // die Googles KI-Übersicht produziert.
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m, 'JSON-LD fehlt').toBeTruthy();
    const ld = JSON.parse(m![1]!) as Record<string, unknown>;
    expect(ld['@type']).toBe('WebApplication');
    expect(ld['applicationCategory']).toBe('FinanceApplication');
    expect(ld['url']).toBe('https://autotrd.net/');
  });

  it('der Body trägt crawlbaren Erst-Text — nicht mehr null Zeichen', () => {
    const body = html.slice(html.indexOf('<body'));
    expect(body).toContain('<noscript>');
    expect(body).toContain('<h1>autotrd</h1>');
    // Der Block liegt IM #app-Container, damit der erste JS-Render ihn
    // ersetzt — kein Nutzer sieht ihn länger als den ersten Frame.
    expect(body.indexOf('<noscript>')).toBeGreaterThan(body.indexOf('id="app"'));
  });

  it('die Risiko-Zeile bleibt unangetastet im Wörterbuch', () => {
    // Die Lösung war NIE, den Warntext zu kürzen. Wer diesen Test liest,
    // weil er rot ist: Die Zeile ist Text-Diät-Tabu (CLAUDE.md).
    const i18n = readFileSync(join(__dirname, '../src/i18n.ts'), 'utf8');
    expect(i18n).toContain('Mir ist bewusst, dass autotrd keine Anlageberatung ist');
  });
});

describe('robots.txt und sitemap.xml liegen in public/ (beide waren live 404)', () => {
  it('robots erlaubt und nennt die Sitemap', () => {
    const robots = readFileSync(join(__dirname, '../public/robots.txt'), 'utf8');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://autotrd.net/sitemap.xml');
  });

  it('die Sitemap nennt die Wurzel', () => {
    const sm = readFileSync(join(__dirname, '../public/sitemap.xml'), 'utf8');
    expect(sm).toContain('<loc>https://autotrd.net/</loc>');
  });

  it('das Manifest bewirbt nichts, was es nicht mehr gibt', () => {
    // „Strategie-Studio" ist entfernt (main.ts: das Studio ist weg).
    const mf = readFileSync(join(__dirname, '../public/manifest.json'), 'utf8');
    expect(mf).not.toContain('Strategie-Studio');
  });
});
