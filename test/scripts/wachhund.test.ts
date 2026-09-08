/**
 * Der nächtliche Wächter.
 *
 * Zwei Dinge muss er können, und beide sind an einem Tag schon vorgekommen:
 *
 * 1. Merken, dass die Engine etwas handelt, das im Repo gar nicht als
 *    Kandidat steht. Seit das Universum jede Nacht neu nach Liquidität
 *    gewählt wird, ist Gleichheit mit `config/platform.yaml` kein Kriterium
 *    mehr — wohl aber die Zugehörigkeit zum Pool, der sich nur per Commit
 *    ändert. Ohne diese Prüfung könnte eine kaputte Auswahl die Plattform
 *    auf beliebige Werte umstellen.
 * 2. Nichts ändern. Er schaut und berichtet; jede Änderung geht durch einen
 *    Pull Request, den ein Mensch anschaut.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs ohne Typen
import { alsMarkdown, beurteile, CHAMPION_FEHLER_TAGE } from '../../scripts/module/wachhund.mjs';

const TAG = 86_400_000;
const JETZT = Date.UTC(2026, 8, 8, 6, 0, 0);

function eingabe(over: Record<string, unknown> = {}) {
  return {
    jetztMs: JETZT,
    health: { lastRunAt: new Date(JETZT - 60_000).toISOString() },
    champion: { updatedAt: JETZT - 7 * 3600_000, symbols: { TSLA: {} }, noTrade: { SPY: {} } },
    engineConfig: { universe: { symbols: ['SPY', 'TSLA'] }, timeframe: 5 },
    repoSymbols: ['TSLA', 'SPY'],
    repoPool: ['SPY', 'TSLA', 'NVDA', 'AAPL'],
    repoBenchmark: 'SPY',
    repoMaxSymbols: 3,
    repoTimeframe: 5,
    nutzer: [{ uid: 'a', engineAn: true, live: false }],
    herzschlagUrteil: { ok: true },
    ...over,
  };
}
const texte = (u: { befunde: { stufe: string; text: string }[] }) => u.befunde.map((b) => `${b.stufe}: ${b.text}`).join(' | ');

describe('Wächter', () => {
  it('gesunder Zustand ⇒ kein Befund', () => {
    const u = beurteile(eingabe());
    expect(u.ok, texte(u)).toBe(true);
    expect(u.fehler).toBe(0);
  });

  it('toter Takt ist ein Fehler', () => {
    const u = beurteile(eingabe({ herzschlagUrteil: { ok: false, text: 'Takt steht seit 42 min' } }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('42 min');
  });

  it('fehlender Champion ist ein Fehler — ohne ihn handelt niemand', () => {
    const u = beurteile(eingabe({ champion: null }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('Kein meta/champion');
  });

  it('alter Champion: erst Warnung, dann Fehler', () => {
    const warn = beurteile(eingabe({ champion: { updatedAt: JETZT - 5 * TAG, symbols: { TSLA: {} }, noTrade: {} } }));
    expect(warn.ok, 'fünf Tage über ein Wochenende sind noch kein Ausfall').toBe(true);
    expect(warn.warnungen).toBeGreaterThan(0);

    const fehler = beurteile(eingabe({ champion: { updatedAt: JETZT - (CHAMPION_FEHLER_TAGE + 1) * TAG, symbols: { TSLA: {} }, noTrade: {} } }));
    expect(fehler.ok).toBe(false);
    expect(texte(fehler)).toContain('Optimierer läuft nicht');
  });

  it('ein Symbol AUSSERHALB des Kandidatenpools ist ein Fehler — der Pool ändert sich nur per Commit', () => {
    const u = beurteile(eingabe({ engineConfig: { universe: { symbols: ['SPY', 'TSLA', 'GME'] }, timeframe: 5 } }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('außerhalb des Kandidatenpools: GME');
  });

  it('ein anderes Symbol AUS dem Pool ist in Ordnung — die Auswahl läuft nächtlich', () => {
    const u = beurteile(eingabe({
      engineConfig: { universe: { symbols: ['SPY', 'NVDA'] }, timeframe: 5 },
      champion: { updatedAt: JETZT - 7 * 3600_000, symbols: { NVDA: {} }, noTrade: { SPY: {} } },
    }));
    expect(u.ok, texte(u)).toBe(true);
  });

  it('mehr Symbole als erlaubt ist ein Fehler — über 30 antwortet Alpaca mit 405', () => {
    const u = beurteile(eingabe({ engineConfig: { universe: { symbols: ['SPY', 'TSLA', 'NVDA', 'AAPL'] }, timeframe: 5 } }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('erlaubt sind 3');
  });

  it('fehlender Benchmark im gehandelten Universum ist ein Fehler', () => {
    const u = beurteile(eingabe({
      engineConfig: { universe: { symbols: ['TSLA', 'NVDA'] }, timeframe: 5 },
      champion: { updatedAt: JETZT - 7 * 3600_000, symbols: { TSLA: {} }, noTrade: { NVDA: {} } },
    }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('Benchmark SPY fehlt');
  });

  it('ein gehandeltes Symbol ohne Champion-Urteil ist eine Warnung', () => {
    const u = beurteile(eingabe({ engineConfig: { universe: { symbols: ['SPY', 'TSLA', 'NVDA'] }, timeframe: 5 } }));
    expect(texte(u)).toContain('Ohne Champion-Urteil (wird nicht gehandelt): NVDA');
  });

  it('abweichender Zeitrahmen ist ein Fehler', () => {
    const u = beurteile(eingabe({ engineConfig: { universe: { symbols: ['SPY', 'TSLA'] }, timeframe: 60 } }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('Zeitrahmen weicht ab');
  });

  it('kein handelndes Symbol ist eine Warnung, kein Fehler — „nicht handeln" ist erlaubt', () => {
    const u = beurteile(eingabe({ champion: { updatedAt: JETZT - 3600_000, symbols: {}, noTrade: { SPY: {}, TSLA: {} } } }));
    expect(u.ok, 'null Symbole sind ein zulässiges Ergebnis').toBe(true);
    expect(texte(u)).toContain('zulässiges Ergebnis');
  });

  it('Echtgeld-Konten werden ausdrücklich genannt', () => {
    const u = beurteile(eingabe({ nutzer: [{ uid: 'x1', engineAn: true, live: true }, { uid: 'x2', engineAn: true, live: false }] }));
    expect(texte(u)).toContain('ECHTGELD');
    expect(texte(u)).toContain('x1');
    expect(texte(u)).not.toContain('x2, ');
  });

  it('die Zusammenfassung nennt jeden Befund', () => {
    const md = alsMarkdown(beurteile(eingabe()));
    expect(md).toContain('## Wächter');
    expect(md).toContain('Takt schlägt');
  });
});

describe('Wächter-Workflow', () => {
  const wf = (): string => readFileSync(new URL('../../.github/workflows/wachhund.yml', import.meta.url), 'utf8');

  it('ändert nichts — kein Veröffentlichen, kein Umstieg, kein Deploy', () => {
    const text = wf();
    for (const verboten of ['publish-champion', 'sync-engine-config', 'umstieg.mjs', 'firebase-tools', 'git push']) {
      expect(text, `der Wächter darf ${verboten} nicht enthalten`).not.toContain(verboten);
    }
  });

  it('läuft nachts und von Hand', () => {
    expect(wf()).toContain("cron: '0 6 * * *'");
    expect(wf()).toContain('workflow_dispatch');
  });
});
