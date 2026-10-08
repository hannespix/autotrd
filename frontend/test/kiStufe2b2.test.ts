/**
 * KI-Kaskade Stufe 2b-2 (08.10.): Was die Engine seit #536 tut, muss der
 * Nutzer sehen und abschalten können — sonst zahlt ein Konto 2 $/Tag in
 * einen Topf, von dem es nichts weiß.
 *
 * Drei Stellen, drei Wächter:
 *  1. Options-Modal: Schalter `signals.kiNachrichten` (fehlend = an, der
 *     Scan wertet `!== false`) — HTML, Speichern, Laden.
 *  2. Admin-Karte: Tagesbudget als Summen-Zeile (verbraucht / Limit,
 *     Konten, Aufrufe), rot bei erschöpftem Topf.
 *  3. Betriebszustand: `meta/health.ki` als Chip — nur wenn etwas geschah,
 *     Budget-Erschöpfung gelb (nichts ist kaputt).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lese = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', '..', ...teile), 'utf8');

const dashboard = lese('frontend', 'src', 'dashboard.ts');
const data = lese('frontend', 'src', 'data.ts');
const admin = lese('functions', 'src', 'callable', 'admin.ts');
const scan = lese('functions', 'src', 'scheduled', 'scanMarket.ts');

describe('Stufe 2b-2 — Schalter signals.kiNachrichten im Options-Modal', () => {
  it('die Checkbox steht im Block „Schutzschalter“ neben dem News-Veto', () => {
    expect(dashboard).toContain('<input type="checkbox" id="owKiNachrichten" />');
    expect(dashboard).toContain("${t('opt.kiNachrichten')} ${iBtn('kiNachrichten')}");
    const veto = dashboard.indexOf('id="owNewsVeto"');
    const ki = dashboard.indexOf('id="owKiNachrichten"');
    const exp = dashboard.indexOf("${t('opt.experimente')}</div>");
    expect(veto).toBeGreaterThan(-1);
    expect(ki).toBeGreaterThan(veto);
    expect(exp).toBeGreaterThan(ki);
  });
  it('Speichern schreibt den Haken als Boolean ins Feld', () => {
    expect(dashboard).toContain("kiNachrichten: ($('owKiNachrichten') as HTMLInputElement).checked,");
  });
  it('Laden: fehlend = an — exakt die Regel des Scans (`!== false`)', () => {
    expect(dashboard).toContain(
      "($('owKiNachrichten') as HTMLInputElement).checked = st.strategy.signals.kiNachrichten !== false;",
    );
    expect(scan).toContain('const kiAn = clamped.signals.kiNachrichten !== false;');
  });
});

describe('Stufe 2b-2 — KI-Tagesbudget in der Admin-Karte', () => {
  it('der Server liest den Tages-Topf und das Erschöpfungs-Flag, gibt nur Summen zurück', () => {
    expect(admin).toContain('db.doc(`admin/kiBudget-${tag}`).get()');
    expect(admin).toContain("db.doc('meta/kiNachrichten').get()");
    expect(admin).toContain("const erschoepft = stand.get('budgetErreichtTag') === tag;");
    expect(admin).toContain('kiBudget: await kiBudgetHeute(),');
    // Kein Konto-Bezug in der Antwort: Die Funktion kennt weder uid noch E-Mail.
    const start = admin.indexOf('async function kiBudgetHeute(');
    const ende = admin.indexOf('export const adminUsers = onCall(');
    expect(start).toBeGreaterThan(-1);
    const rumpf = admin.slice(start, ende);
    expect(rumpf).not.toMatch(/uid|email|users\//);
  });
  it('die Karte zeigt verbraucht / Limit, Konten, Aufrufe — rot bei Erschöpfung', () => {
    expect(dashboard).toContain('<div id="admKiBudget" class="mono hint" style="margin-top:6px">…</div>');
    expect(dashboard).toContain('renderKiBudget(s.kiBudget ?? null);');
    expect(dashboard).toContain('`${usd(b.verbrauchtUsd)} / ${usd(b.limitUsd)}`,');
    expect(dashboard).toContain("el.style.color = b.erschoepft ? 'var(--rd)' : 'var(--t3)';");
    expect(data).toContain('kiBudget?: KiBudgetStatus | null;');
  });
});

describe('Stufe 2b-2 — meta/health.ki im Betriebszustand', () => {
  it('der Typ kennt das Feld, das der Scan schreibt', () => {
    expect(scan).toContain('ki: kiLaufGesamt,');
    expect(data).toContain('  ki?: {\n    lage?: number;\n    budgetErschoepft?: boolean;');
  });
  it('ein Chip nur, wenn etwas geschah — die Null erzeugt keinen', () => {
    const stelle = dashboard.indexOf('const ki = h.ki;');
    expect(stelle).toBeGreaterThan(-1);
    const block = dashboard.slice(stelle, stelle + 1200);
    expect(block).toContain("if ((ki.lage ?? 0) > 0) kiTeile.push(`${ki.lage} ${t('ew.kiLage')}`);");
    expect(block).toContain("if ((ki.stops ?? 0) > 0) kiTeile.push(`${ki.stops} ${t('ew.kiStops')}`);");
    expect(block).toContain('if (kiTeile.length > 0) {');
    expect(block).toContain("whyChip(`KI: ${kiTeile.join(' · ')}`, 'var(--t3)')");
  });
  it('Budget erschöpft ist GELB, nicht rot — nichts ist kaputt, nur der Rückfall läuft', () => {
    expect(dashboard).toContain("whyChip(t('ew.kiBudgetErschoepft'), 'var(--yl,#d9a441)')");
  });
});

describe('Stufe 3 — Gewicht und Untätigkeits-Alarm im Betriebszustand', () => {
  it('der Typ kennt das Gewicht im ki-Block sowie kiBewertung und kiWirkung', () => {
    const start = data.indexOf('  ki?: {\n    lage?: number;');
    expect(start).toBeGreaterThan(-1);
    const kiBlock = data.slice(start, data.indexOf('} | null;', start));
    expect(kiBlock).toContain('gewicht?: number;');
    expect(data).toContain('kiBewertung?: {');
    expect(data).toContain('faelleWirksam?: number;');
    expect(data).toContain('kiWirkung?: { aktiv?: boolean; text?: string; seit?: string; at?: string } | null;');
  });
  it('Gewichts-Chip nur bei Abweichung von ×1 — und an whyChip gebunden', () => {
    const stelle = dashboard.indexOf("typeof h.ki?.gewicht === 'number' && h.ki.gewicht !== 1");
    expect(stelle).toBeGreaterThan(-1);
    const block = dashboard.slice(stelle, stelle + 700);
    expect(block).toContain('whyChip(');
    expect(block).toContain("`${t('ew.kiGewicht')} ×${gewicht.toFixed(2)}`");
    expect(block).toContain("gewicht > 1 ? 'var(--gn)' : 'var(--yl,#d9a441)'");
    expect(block).toContain("t('ew.kiGewichtTitel')");
    expect(block).toContain("${faelle} ${t('ew.kiFaelle')}");
  });
  it('Untätigkeits-Chip nur bei aktivem Alarm — GELB, nicht rot (nichts ist kaputt)', () => {
    const stelle = dashboard.indexOf('if (h.kiWirkung?.aktiv === true) {');
    expect(stelle).toBeGreaterThan(-1);
    const block = dashboard.slice(stelle, stelle + 400);
    expect(block).toContain("whyChip(t('ew.kiWirkungAlarm'), 'var(--yl,#d9a441)')");
    expect(block).not.toContain("'var(--rd)'");
    expect(block).toContain("chip.title = h.kiWirkung.text ?? t('ew.kiWirkungTitel');");
  });
});
