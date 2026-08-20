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
const LOGO_HOST = 'logo-6xru5z43xa-uc.a.run.app';

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
    // KEIN img im Grund-HTML (Logos setzt schmueckeAvatare aus dem Lager
    // ein) — und nichts Injiziertes.
    expect(html.match(/<img/g)).toBeNull();
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

  it('trägt das Logo-Ziel als sauberes data-Attribut — kein Netzwerk im HTML', () => {
    // Owner-Befund 21.08.: direkte <img src=Proxy> wurden von den
    // innerHTML-Re-Renders mitten im Laden abgeräumt (error ⇒ entfernt ⇒
    // „Logos kurz da, dann Buchstaben"). Das HTML trägt deshalb nur noch
    // das Ziel; schmueckeAvatare() setzt Logos aus dem Sitzungs-Lager ein.
    const html = symbolAvatar('^NDX');
    expect(html).toContain('data-logo-sym="^NDX"');
    expect(html).not.toContain(LOGO_HOST);
    expect(symbolAvatar('"<x>')).toContain('data-logo-sym="X"');
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
    expect(avatar).toContain(`LOGO_BASIS = 'https://${LOGO_HOST}'`);
    expect(avatar).not.toContain('parqet');
    // Weißer Ring, damit dunkle Marken-Logos im Dark-Theme lesbar sind.
    expect(css).toMatch(/\.sym-logo[\s\S]*?background:\s*#fff/);
  });

  it('das Lager schmückt nach JEDEM Listen-Render — ein Abruf je Symbol', () => {
    // Beide Render-Wege rufen den Schmück-Pass als echten Aufruf.
    expect(dashboard.match(/^\s*schmueckeAvatare\(\);/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const avatar = lese('../src/symbolAvatar.ts');
    expect(avatar).toContain('logoLager');
    expect(avatar).toContain('URL.createObjectURL');
  });

  it('die Chip-Palette meidet Gewinn-Grün und Verlust-Rot', () => {
    const block = css.match(/\.sym-av[\s\S]*?\n\n/)?.[0] ?? '';
    expect(block).toContain('.sym-av.f5');
    expect(block).not.toContain('var(--gn');
    expect(block).not.toContain('var(--rd');
  });
});
