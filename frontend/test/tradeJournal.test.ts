/**
 * Task 21 (Owner 09.10.: „in der Trading-History … wenn man drauf klickt,
 * die Entscheidungsgründe fürs Kaufen und Rausgehen festhalten"): Jede
 * Historie-Zeile öffnet das Trade-Journal mit Kauf- UND Verkaufsgrund.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DE, EN } from '../src/i18n.js';

const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const data = readFileSync(join(import.meta.dirname, '..', 'src', 'data.ts'), 'utf8');

describe('Trade-Journal per Klick in der Historie', () => {
  it('Zeilen sind per Klick und Tastatur erreichbar', () => {
    expect(dashboard).toContain("tr.dataset.ji = String(i);");
    expect(dashboard).toContain('tr.tabIndex = 0;');
    expect(dashboard).toContain("if (e.key !== 'Enter' && e.key !== ' ') return;");
  });

  it('ein langer Druck (Symbol-Steckbrief) öffnet nicht zusätzlich das Journal', () => {
    expect(dashboard).toContain('if (druckAb > 0 && Date.now() - druckAb > 400) return;');
  });

  it('Kauf und Verkauf erscheinen zusammen — egal, welche Zeile angeklickt wurde', () => {
    expect(dashboard).toContain('const gegen = gegenstueck(row, st.trades);');
    expect(dashboard).toContain('const einstiegRow = ausstieg ? gegen : row;');
    expect(dashboard).toContain('const ausstiegRow = ausstieg ? row : gegen;');
  });

  it('Journal über die Doc-ID (= Trade-ID), die Trade-Zeilen tragen sie', () => {
    expect(data).toContain("cb(snap.docs.map((d) => ({ ...(d.data() as TradeRow), id: d.id })), snap.docs[snap.docs.length - 1] ?? null);");
    expect(data).toContain("rows: snap.docs.map((d) => ({ ...(d.data() as TradeRow), id: d.id })),");
    expect(data).toContain("const snap = await getDoc(doc(db(), 'users', uid, 'journal', id));");
  });

  it('eine ältere Antwort überschreibt nie den späteren Klick', () => {
    expect(dashboard).toContain('if (!st || st.uid !== uid || lauf !== tradeDetailLauf) return;');
  });

  it('Kopfzahlen im selben Format wie die Gründe (keine „$-20.70" neben „−20,70 $")', () => {
    expect(dashboard).toContain('${escText(deGeld(ausstiegRow.pnl))}');
    expect(dashboard).not.toMatch(/oeffneTradeDetail[\s\S]{0,1500}money\(ausstiegRow\.pnl\)/);
  });

  it('alle td.*-Texte gibt es auf Deutsch und Englisch', () => {
    const de = Object.keys(DE).filter((k) => k.startsWith('td.'));
    expect(de.length).toBeGreaterThanOrEqual(10);
    for (const k of de) expect(EN[k as keyof typeof EN], k).toBeTruthy();
  });
});
