/**
 * Wächter der Symbol-Monogramme (Owner-Frage 20.08.: „Logos je Symbol?").
 * Die Regeln: deterministisch (gleicher Ton je Symbol), inhärent escaped,
 * Palette ohne Gewinn-Grün/Verlust-Rot, eingebaut in die drei Kern-Listen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { symbolAvatar, symbolMonogramm, symbolTon } from '../src/symbolAvatar.js';

const lese = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('symbolTon — deterministisch und im Slot-Bereich', () => {
  it('gleiches Symbol ⇒ immer derselbe Ton, Bereich 0…5', () => {
    for (const s of ['NVDA', '^NDX', 'BRK-B', 'BTCUSD', 'EWJ', 'GLD']) {
      expect(symbolTon(s)).toBe(symbolTon(s));
      expect(symbolTon(s)).toBeGreaterThanOrEqual(0);
      expect(symbolTon(s)).toBeLessThanOrEqual(5);
    }
  });
});

describe('symbolMonogramm — ein bis zwei saubere Zeichen', () => {
  it('nimmt nur A–Z/0–9 und maximal zwei Zeichen', () => {
    expect(symbolMonogramm('NVDA')).toBe('NV');
    expect(symbolMonogramm('^NDX')).toBe('ND');
    expect(symbolMonogramm('BRK-B')).toBe('BR');
    expect(symbolMonogramm('btcusd')).toBe('BT');
    expect(symbolMonogramm('^^')).toBe('·');
  });

  it('inhärent escaped — bösartige Eingaben landen nie roh im Markup', () => {
    expect(symbolMonogramm('<script>')).toBe('SC');
    const html = symbolAvatar('<img src=x onerror=alert(1)>');
    // Genau EIN img: unser Logo-Layer — nichts Injiziertes daneben.
    expect(html.match(/<img/g)?.length).toBe(1);
    expect(html).toContain('class="sym-logo"');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('src=x');
  });
});

describe('symbolAvatar — Chip-HTML', () => {
  it('trägt Farbklasse, Monogramm und optional die sm-Variante', () => {
    const html = symbolAvatar('NVDA', true);
    expect(html).toContain(`f${symbolTon('NVDA')}`);
    expect(html).toContain(' sm');
    expect(html).toContain('NV');
    expect(symbolAvatar('NVDA')).not.toContain(' sm');
  });

  it('legt das echte Logo als Bild über das Monogramm — URL sauber encodiert', () => {
    const html = symbolAvatar('^NDX');
    expect(html).toContain('class="sym-logo"');
    expect(html).toContain('symbol=%5ENDX');
    expect(html).toContain('loading="lazy"');
    // Bösartige Eingaben landen NIE roh in der URL.
    expect(symbolAvatar('"<x>')).toContain('symbol=X');
  });
});

describe('Quelltext-Pins — Einbau und Palette', () => {
  const dashboard = lese('../src/dashboard.ts');
  const css = lese('../src/theme.css');

  it('die drei Kern-Listen tragen das Monogramm (Livebar, Signale, Positionen)', () => {
    expect(dashboard.match(/symbolAvatar\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(dashboard).toContain('lbSym.innerHTML = symbolAvatar(sym, true)');
    expect(dashboard).toContain('sigSym.innerHTML = symbolAvatar(sym, true)');
    expect(dashboard).toContain('symTd.innerHTML = symbolAvatar(p.symbol)');
  });

  it('die Fallback-Kette ist verdrahtet und der Logo-Weg läuft über UNSEREN Proxy', () => {
    // Als echter Aufruf am Zeilenanfang — ein auskommentierter zählt nicht.
    expect(dashboard).toMatch(/^\s*installiereLogoFallback\(\);/m);
    const avatar = lese('../src/symbolAvatar.ts');
    // Kein Dritt-Host im Frontend: nur der eigene Cloud-Run-Proxy.
    expect(avatar).toContain("LOGO_BASIS = 'https://logo-6xru5z43xa-uc.a.run.app'");
    expect(avatar).not.toContain('parqet');
    // Weißer Ring, damit dunkle Marken-Logos im Dark-Theme lesbar sind.
    expect(css).toMatch(/\.sym-logo[\s\S]*?background:\s*#fff/);
  });

  it('die Chip-Palette meidet Gewinn-Grün und Verlust-Rot', () => {
    const block = css.match(/\.sym-av[\s\S]*?\n\n/)?.[0] ?? '';
    expect(block).toContain('.sym-av.f5');
    expect(block).not.toContain('var(--gn');
    expect(block).not.toContain('var(--rd');
  });
});
