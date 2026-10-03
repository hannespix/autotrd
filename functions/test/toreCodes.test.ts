/**
 * #145-Grenzfälle (20.08.): Keine deutsche Prosa mehr in HttpsError.
 *
 * Nach Tranche 3a blieben an der trade-Grenze drei Lecks: `tore.grund`
 * (2×) und `kursAlter.grund` (1×) wanderten als deutscher Klartext in die
 * Fehlermeldung — für EN-Nutzer unlesbar, und serverText kann Prosa nicht
 * übersetzen. Beide Strukturen tragen längst Maschinen-Codes; die Grenze
 * übersetzt jetzt Codes in srv.*-Schlüssel. Die Prosa in `grund` bleibt
 * bewusst erhalten — für Server-Logs, wo Deutsch die Betriebssprache ist.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { kursZuAlt } from '../../shared/src/index.js';

const hier = dirname(fileURLToPath(import.meta.url));
const trade = readFileSync(join(hier, '../src/callable/trade.ts'), 'utf8');

describe('kursZuAlt liefert Maschinen-Codes neben der Log-Prosa', () => {
  const jetzt = new Date('2026-08-20T15:00:00Z');

  it('fehlender Zeitstempel → ohne_zeitstempel', () => {
    expect(kursZuAlt(undefined, 'stocks_us', jetzt).code).toBe('ohne_zeitstempel');
    expect(kursZuAlt('kein-datum', 'stocks_us', jetzt).code).toBe('ohne_zeitstempel');
  });

  it('über der Reißleine → tage_alt, bei offenem Markt veraltet → min_alt', () => {
    const alt = new Date(jetzt.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString();
    expect(kursZuAlt(alt, 'stocks_us', jetzt).code).toBe('tage_alt');
    const stunde = new Date(jetzt.getTime() - 60 * 60 * 1000).toISOString();
    // marktOffen explizit — der Test darf nicht an der Uhrzeit hängen.
    expect(kursZuAlt(stunde, 'stocks_us', jetzt, true).code).toBe('min_alt');
  });

  it('frischer Kurs → kein Code, kein Grund', () => {
    const frisch = new Date(jetzt.getTime() - 2 * 60 * 1000).toISOString();
    const b = kursZuAlt(frisch, 'stocks_us', jetzt, true);
    expect(b.zuAlt).toBe(false);
    expect(b.code).toBeUndefined();
  });
});

describe('die trade-Grenze wirft Codes, nie Prosa', () => {
  it('tore.grund und kursAlter.grund stehen in KEINER HttpsError mehr', () => {
    // Der 20.08.-Zustand in Reinform: `grund` ist Log-Material. Taucht es
    // wieder in einem Wurf auf, bekommt der EN-Nutzer deutschen Klartext.
    // Kommentare werden gestrippt — die Erklärung IM Code darf die Wörter
    // nennen, nur ausführbarer Code darf sie nicht anfassen.
    const code = trade
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('tore.grund');
    expect(code).not.toContain('kursAlter.grund');
  });

  it('die Tore-Codes sind vollständig auf srv.*-Schlüssel abgebildet', () => {
    expect(trade).toContain("tore.handel === 'reset_laeuft' ? 'srv.resetLaeuft'");
    expect(trade).toContain("tore.einstieg === 'breaker_aktiv'");
    expect(trade).toContain("'srv.breakerAktiv'");
    expect(trade).toContain("'srv.abgleichDrift'");
  });

  it('das Kursalter reist als Zahl, nicht als Satz', () => {
    /* Der Parameter hinter | ist sprachneutral: serverText setzt ihn in
     * {0} ein. Ein Satz an dieser Stelle wäre das alte Leck durch die
     * Hintertür. */
    expect(trade).toContain('srv.kursTageAlt|${Math.round((kursAlter.alterMin ?? 0) / 1440)}');
    expect(trade).toContain('srv.kursMinAlt|${kursAlter.alterMin ?? 0}');
    expect(trade).toContain("'srv.kursOhneZeitstempel'");
  });
});
