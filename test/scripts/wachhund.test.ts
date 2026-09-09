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
    const warn = beurteile(eingabe({ champion: { updatedAt: JETZT - 5 * TAG, symbols: { TSLA: {} }, noTrade: { SPY: {} } } }));
    expect(warn.ok, 'fünf Tage über ein Wochenende sind noch kein Ausfall').toBe(true);
    expect(warn.warnungen).toBeGreaterThan(0);

    const fehler = beurteile(eingabe({ champion: { updatedAt: JETZT - (CHAMPION_FEHLER_TAGE + 1) * TAG, symbols: { TSLA: {} }, noTrade: { SPY: {} } } }));
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

  /**
   * Seit das Universum nächtlich wechselt, ist die Champion-Deckung die einzige
   * verbliebene Brücke zwischen „gemessen" und „gehandelt". Klafft sie, lief der
   * nächtliche Lauf halb durch — deshalb Fehler, nicht Warnung.
   */
  it('ein gehandeltes Symbol ohne Champion-Urteil ist ein FEHLER', () => {
    const u = beurteile(eingabe({
      engineConfig: { universe: { symbols: ['SPY', 'TSLA', 'AAPL'] }, timeframe: 5 },
    }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('ohne Champion-Urteil');
    expect(texte(u)).toContain('AAPL');
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

/**
 * Basis-Stufe (Prüfbefund M11): Der Korb des Blocks `basis` ist das gehandelte
 * Universum der Basis und umgeht `engineConfig.universe.symbols`. Der Wächter
 * prüft ihn gegen den Pool und den vorregistrierten Korb und meldet das Urteil.
 */
describe('Wächter — Basis-Stufe', () => {
  const basis = (over: Record<string, unknown> = {}) => ({
    version: 1,
    strategy: 'regime_allocation',
    label: 'Basis V2',
    symbols: ['SPY', 'TSLA', 'NVDA', 'AAPL', 'XLF', 'XLE', 'GLD', 'TLT'],
    pass: true,
    positionPct: 20,
    ...over,
  });
  const pool = ['SPY', 'TSLA', 'NVDA', 'AAPL', 'XLF', 'XLE', 'GLD', 'TLT', 'IEF'];
  const mitBasis = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    eingabe({
      repoPool: pool,
      champion: { updatedAt: JETZT - 7 * 3600_000, symbols: { TSLA: {} }, noTrade: { SPY: {} }, basis: basis(over) },
      repoBasisUniverse: basis().symbols,
      ...extra,
    });

  it('meldet Urteil, Korb und Position der Basis', () => {
    const u = beurteile(mitBasis());
    expect(u.ok, texte(u)).toBe(true);
    expect(texte(u)).toContain('Basis-Stufe „Basis V2": bestanden, 8 Symbole (SPY, TSLA, NVDA, AAPL, XLF, XLE, GLD, TLT), Position 20 %');
    const nicht = beurteile(mitBasis({ pass: false }));
    expect(nicht.ok).toBe(true);
    expect(texte(nicht)).toContain('NICHT bestanden (keine neuen Einstiege)');
  });

  it('WÄCHTER: ein Korb-Symbol außerhalb des Kandidatenpools ist ein Fehler', () => {
    const u = beurteile(mitBasis({ symbols: [...basis().symbols, 'GME'] }));
    expect(u.ok).toBe(false);
    expect(texte(u)).toContain('Korb-Symbole außerhalb des Kandidatenpools: GME');
  });

  it('WÄCHTER: ein Korb-Symbol, das nicht in optimizer.basisUniverse steht, ist ein Fehler; ein fehlendes eine Warnung', () => {
    const fremd = beurteile(mitBasis({ symbols: [...basis().symbols, 'IEF'] }));
    expect(fremd.ok).toBe(false);
    expect(texte(fremd)).toContain('nicht in optimizer.basisUniverse stehen: IEF');
    const fehlend = beurteile(mitBasis({ symbols: basis().symbols.slice(0, 8) }, { repoBasisUniverse: [...basis().symbols, 'IEF'] }));
    expect(fehlend.ok, texte(fehlend)).toBe(true);
    expect(texte(fehlend)).toContain('ohne Messung im Block (keine Bars?): IEF');
  });

  it('zu kleiner Korb (unter MIN_KORB) und unlesbare Version werden gemeldet; plattformweit aus steht im Bericht', () => {
    const klein = beurteile(mitBasis({ symbols: basis().symbols.slice(0, 5) }, { repoBasisUniverse: basis().symbols.slice(0, 5) }));
    expect(texte(klein)).toContain('Korb hat 5 Symbole, unter 8 rangiert nichts');
    const version = beurteile(mitBasis({ version: 2 }));
    expect(version.ok).toBe(false);
    expect(texte(version)).toContain('Version 2 — unlesbar');
    const aus = beurteile(mitBasis({}, { engineConfig: { universe: { symbols: ['SPY', 'TSLA'] }, timeframe: 5, strategy: { basis: false } } }));
    expect(texte(aus)).toContain('plattformweit AUS');
  });

  it('kein Block, aber vorregistrierter Korb ⇒ Warnung (Messung fehlt); ohne beides kein Wort', () => {
    const fehlt = beurteile(eingabe({ repoBasisUniverse: pool }));
    expect(fehlt.ok).toBe(true);
    expect(texte(fehlt)).toContain('die Messung fehlt noch');
    expect(texte(beurteile(eingabe()))).not.toContain('Basis-Stufe');
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
