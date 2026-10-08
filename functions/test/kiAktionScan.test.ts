/**
 * KI-Kaskade Stufe 2b (06.10.) — die Verdrahtung im Scan.
 *
 * Die Regeln selbst sind pur getestet (shared/test/kiAktion.test.ts). Hier
 * steht, was an den NAHTSTELLEN nie passieren darf:
 *   - Der KI-Stop ersetzt keinen regulären Stop (er könnte ihn sonst
 *     lockern) — er ist eine ZUSÄTZLICHE Marke in `riskExitReason`.
 *   - Die KI wird erst gefragt, wenn keine Regel ohnehin schließt, und kann
 *     einen Ausstieg nie verhindern.
 *   - Ohne KI-Stimme rechnet der Scan exakt wie vor Stufe 2b.
 *   - Probe-Einstiege bekommen nie Hebel.
 *   - Der Schalter je Konto schaltet ALLES ab (Stimme, Veto, Ausstieg).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, journalThese, type Position, type Strategy } from '../../shared/src/index.js';
import { riskExitReason } from '../src/core/broker.js';

const strat = (stopLossPct: number): Strategy => {
  const s = structuredClone(DEFAULT_STRATEGY);
  s.engine.stopLossPct = stopLossPct;
  s.engine.takeProfitPct = 0;
  s.engine.trailingStopPct = 0;
  return s;
};
const pos = (over: Partial<Position> = {}): Position => ({
  symbol: 'ACME',
  qty: 10,
  avgEntry: 100,
  stopLoss: null,
  takeProfit: null,
  openedAt: '2026-10-05T14:00:00.000Z',
  ...over,
});
const kiStop = (level: number): Position['kiStop'] => ({ level, grund: 'ki_unklar', newsId: 'alp-1', gesetztAt: '2026-10-06T14:00:00.000Z' });

describe('riskExitReason — KI-Stop als ZUSÄTZLICHE Marke', () => {
  it('Long: feuert an und unter der Marke, nicht darüber', () => {
    const s = strat(5);
    expect(riskExitReason(pos({ kiStop: kiStop(98) }), 98.1, s)).toBeNull();
    expect(riskExitReason(pos({ kiStop: kiStop(98) }), 98, s)).toBe('ki_stop');
    expect(riskExitReason(pos({ kiStop: kiStop(98) }), 97, s)).toBe('ki_stop');
  });

  it('lockert NIE einen engeren regulären Stop — beide gelten, der engere gewinnt', () => {
    // regulärer Level 96, KI-Stop tiefer bei 95: bei 95,9 schließt der reguläre
    expect(riskExitReason(pos({ stopLoss: 96, kiStop: kiStop(95) }), 95.9, strat(4))).toBe('stop_loss');
    // Prozent-Stop 4 % (Level fehlt), KI-Stop 95: bei 95,9 schließt der Prozent-Stop
    expect(riskExitReason(pos({ kiStop: kiStop(95) }), 95.9, strat(4))).toBe('stop_loss');
  });

  it('feuern beide, gehört der Ausstieg dem regulären Stop (saubere Zuordnung)', () => {
    expect(riskExitReason(pos({ stopLoss: 96, kiStop: kiStop(98) }), 95, strat(4))).toBe('stop_loss');
    expect(riskExitReason(pos({ stopLoss: 96, kiStop: kiStop(98) }), 97, strat(4))).toBe('ki_stop');
  });

  it('Short gespiegelt: Marke ÜBER dem Kurs', () => {
    const s = strat(5);
    const p = pos({ side: 'short', kiStop: kiStop(102) });
    expect(riskExitReason(p, 101.9, s)).toBeNull();
    expect(riskExitReason(p, 102, s)).toBe('ki_stop');
  });

  it('kaputte oder fehlende Marke: kein Ausstieg (Altbestand bleibt unberührt)', () => {
    const s = strat(5);
    expect(riskExitReason(pos({ kiStop: null }), 97, s)).toBeNull();
    expect(riskExitReason(pos({ kiStop: { ...kiStop(98)!, level: Number.NaN } }), 97, s)).toBeNull();
    expect(riskExitReason(pos({ kiStop: { ...kiStop(98)!, level: 0 } }), 97, s)).toBeNull();
  });
});

describe('Journal-Satz', () => {
  it('KI-Probe-Einstieg behauptet nicht „Konfluenz erreicht"', () => {
    const s = journalThese({
      art: 'entry',
      side: 'buy',
      source: 'engine',
      signalContext: {
        typ: 'konfluenz',
        votes: { rsi: 'hold', macd: 'buy', bollinger: 'hold' },
        konfluenz: 1,
        minKonfluenz: 2,
        ki: { richtung: 'positiv', probe: true },
        regime: 'trend',
      },
    });
    expect(s).toBe(
      'Einstieg long, weil die Technik bei 1/2 stand (MACD kauft) und eine gegengeprüfte Nachricht positiv bewertet wurde (KI, Probegröße) — Regime trend.',
    );
    expect(s).not.toContain('erreicht');
  });

  it('KI-Ausstieg und KI-Stop haben eigene Gründe', () => {
    expect(journalThese({ art: 'exit', side: 'sell', riskExit: 'ki_news', pnl: 3 })).toBe(
      'Position geschlossen auf eine gegengeprüfte Nachricht gegen die Position (KI) — Ergebnis +3,00 $.',
    );
    expect(journalThese({ art: 'exit', side: 'sell', riskExit: 'ki_stop', pnl: -1 })).toContain('KI-Stop');
  });
});

describe('Quelltext-Wächter: Verdrahtung im Scan', () => {
  const scan = readFileSync(new URL('../src/scheduled/scanMarket.ts', import.meta.url), 'utf8');
  const lauf = readFileSync(new URL('../src/scheduled/kiNachrichten.ts', import.meta.url), 'utf8');
  const anzahl = (nadel: string): number => scan.split(nadel).length - 1;

  it('die KI-Lage: ein Read je Scan, nur Urteile VOR dem Scan, Ausfall = kein Einfluss', () => {
    expect(anzahl(".where('decidedAt', '>=', new Date(kiJetzt - KI_GUELTIG_STUNDEN * 3_600_000).toISOString())")).toBe(1);
    expect(anzahl('kiLage = kiSignaleAus(urteile.docs.map((d) => d.data()), kiJetzt);')).toBe(1);
    expect(anzahl("kiBudgetErschoepft = kiStand.get('budgetErreichtTag') === budgetTag(new Date(kiJetzt));")).toBe(1);
  });

  it('der Schalter je Konto schaltet alles ab', () => {
    expect(anzahl('const kiAn = clamped.signals.kiNachrichten !== false;')).toBe(1);
    expect(anzahl('const kiFuer = (sym: string): KiSignal | undefined => (kiAn ? kiLage.get(sym) : undefined);')).toBe(1);
    // keine Stelle liest die Lage am Schalter vorbei
    expect(anzahl('kiLage.get(')).toBe(1);
  });

  it('Risiko-Block: die KI wird erst gefragt, wenn keine Regel schließt — und kann keinen Ausstieg verhindern', () => {
    expect(anzahl('const kiSig = regelGrund ? undefined : kiFuer(symbol);')).toBe(1);
    expect(anzahl("const reason = regelGrund ?? (kiAktion?.art === 'verkauf' ? kiAktion.grund : null);")).toBe(1);
    // der KI-Stop landet im EIGENEN Feld, nie im stopLoss-Level — und per
    // update(), damit eine inzwischen geschlossene Position kein Geister-
    // Dokument bekommt (Naht-Prüfung 06.10.)
    expect(anzahl('.update({ kiStop })')).toBe(1);
    expect(scan).not.toContain('.set({ kiStop }');
    expect(scan).not.toMatch(/stopLoss:\s*kiAktion/);
  });

  it('Einstiegstor: richtungsbewusstes Veto, Aufhebung des blinden Vetos nur im echten Buch', () => {
    expect(anzahl('const kiSig = echtesBuch && handelbar ? kiFuer(symbol) : undefined;')).toBe(1);
    expect(anzahl("if (kiGegen) return 'ki_veto';")).toBe(1);
    expect(anzahl('const veto = vetoAufgehoben ? { blocked: false } : vetoRoh;')).toBe(1);
  });

  it('Signal: ohne KI-/Lexikon-Stimme dieselbe Richtung wie vor Stufe 2b', () => {
    expect(anzahl('const ohneKi = applyPredictionVote(sig, vote);')).toBe(1);
    expect(anzahl('const direction = kiVote || lexVote ? mitStimmen(sig, [vote, kiVote, lexVote]).direction : ohneKi;')).toBe(1);
  });

  it('Probegröße an beiden Einstiegen, und ein Probe-Einstieg bekommt nie Hebel', () => {
    expect(anzahl('sb.ueberzeugung * klassenGewicht(clamped, symbol) * regimeGroessenFaktor(regime) * kiFaktor;')).toBe(2);
    expect(anzahl('const budget = kiAllein ? null : hebelBudget(konfluenz, {')).toBe(2); // Stufe 3: eigener Marker, nicht der Zahlenwert
    // der Hebel hängt am TECHNISCHEN Steckbrief
    expect(anzahl('bucket: filterBuckets[sb.tech] ?? null,')).toBe(2);
  });

  it('H1: Sperre und Überzeugung hängen am technischen Steckbrief — das KI-Etikett nur bei der Probe', () => {
    expect(anzahl('const tech = bucketKey({ ...basis, signature: signalSignature(sig.votes, dir) });')).toBe(1);
    expect(anzahl('const gebucht = kiAllein ? bucketKey({ ...basis, signature: signalSignature(votesMitKi(dir), dir) }) : tech;')).toBe(1);
    expect(anzahl('gesperrt: bucketVerdict(filterBuckets[tech]).blocked || bucketVerdict(filterBuckets[gebucht]).blocked,')).toBe(1);
    expect(anzahl('ueberzeugung: Math.min(ueberzeugung(tech), ueberzeugung(gebucht)),')).toBe(1);
    expect(anzahl("const sb = steckbriefe('buy', 'long');")).toBe(1);
    expect(anzahl("const sb = steckbriefe('sell', 'short');")).toBe(1);
    expect(anzahl('if (sb.gesperrt) {')).toBe(2);
    // kein Einstieg prüft mehr direkt einen KI-Steckbrief
    expect(scan).not.toContain("signature: signalSignature(votesMitKi('buy'), 'buy'),");
  });

  it('H2/H3: Veto-Aufhebung nur fürs selbe Ereignis; ein Urteil, eine Handlung', () => {
    expect(anzahl('&& kiUebersteuertNewsVeto(kiSig, side, marketData.get(symbol)?.news?.hardEvent?.published);')).toBe(1);
    expect(anzahl('kiGenutzt[symbol] as KiGenutzt | undefined,')).toBe(1); // an kiStimme übergeben
    // Einstieg UND ki_news-Ausstieg verbrauchen — sofort geschrieben, nicht am Kontoende (R4)
    expect(anzahl('await kiVerbrauchen(symbol, kiSig.newsId);')).toBe(2);
    expect(anzahl("await (userDoc.ref.update as (...a: unknown[]) => Promise<unknown>)(new FieldPath('kiGenutzt', sym), wert)")).toBe(1);
    expect(anzahl("await zaehleKiEinstieg('buy');")).toBe(1);
    expect(anzahl("await zaehleKiEinstieg('sell');")).toBe(1);
    expect(anzahl('sig.votes,\n            )')).toBe(1); // Lexikon bekommt die Indikator-Stimmen (M2)
  });

  it('Herzschlag trägt die KI-Wirkung; der KI-Lauf schreibt den Budget-Tag', () => {
    expect(anzahl('ki: kiLaufGesamt,')).toBe(1);
    expect(lauf).toContain('await standRef.set({ budgetErreichtTag: tag }, { merge: true })');
  });

  it('der Auto-Tuner vergleicht ohne KI-Probe-Trades (M3)', () => {
    const tune = readFileSync(new URL('../src/scheduled/autoTune.ts', import.meta.url), 'utf8');
    expect(tune).toContain("if (istKiProbeBucket(t.get('bucket'))) continue;");
  });
});
