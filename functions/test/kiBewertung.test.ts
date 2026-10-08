/**
 * KI-Kaskade Stufe 3 (08.10.): Verdrahtung des Bewertungslaufs und der
 * Gewichtsanwendung im Scan — Quelltext-Wächter plus die reine Fassungsregel.
 *
 * Was hier bewacht wird, ist genau das, was ein Red-Team zuerst anzweifelt:
 *   - Das Gate (End-Tag strikt vor heute) läuft über dieselbe pure Funktion
 *     wie die Tests in shared/test/kiBewertung.test.ts.
 *   - Ohne Kurse wird NICHT verfallen (Lehre aus evalForecasts B1).
 *   - Marker und Aggregat stehen im selben Batch (Lehre aus dem Audit 11.08.).
 *   - Das Gewicht kommt NUR aus `wirksam` und erreicht im Scan genau zwei
 *     Stellen: Stimmgewicht und Probegröße — keinen Stop, kein Veto.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KI_BEWERTUNG_FENSTER_TAGE, zaehlerVerwerfen } from '../src/scheduled/kiBewertung.js';
import { KI_BEWERTUNG_V } from '../../shared/src/index.js';

const lese = (...teile: string[]): string =>
  readFileSync(join(import.meta.dirname, '..', '..', ...teile), 'utf8');
const lauf = lese('functions', 'src', 'scheduled', 'kiBewertung.ts');
const scan = lese('functions', 'src', 'scheduled', 'scanMarket.ts');
const index = lese('functions', 'src', 'index.ts');
const scheduler = lese('scripts-ci', 'check-scheduler.mjs');
const aktion = lese('shared', 'src', 'kiAktion.ts');
const nachrichten = lese('functions', 'src', 'scheduled', 'kiNachrichten.ts');
const indexe = JSON.parse(lese('firestore.indexes.json')) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }>;
};

describe('Fassung', () => {
  it('verwirft Zähler einer anderen Fassung, nie die aktuelle oder eine fehlende', () => {
    expect(zaehlerVerwerfen(KI_BEWERTUNG_V)).toBe(false);
    expect(zaehlerVerwerfen(undefined)).toBe(false);
    expect(zaehlerVerwerfen(KI_BEWERTUNG_V + 1)).toBe(true);
    expect(zaehlerVerwerfen(0)).toBe(true);
  });
});

describe('Bewertungslauf — Verdrahtung', () => {
  it('ist exportiert und im Zeitplan-Wächter eingetragen (werktags 16:45 ET, nach evalForecasts)', () => {
    expect(index).toContain("export { kiBewertung, kiBewertungNow } from './scheduled/kiBewertung.js';");
    expect(scheduler).toContain("{ fn: 'kiBewertung', service: 'kibewertung', cron: '45 16 * * 1-5', was: 'KI-Urteils-Bewertung' }");
    expect(lauf).toContain("schedule: '45 16 * * 1-5',");
    expect(lauf).toContain("timeZone: 'America/New_York',");
  });
  it('bewertet über die pure Funktion mit dem UTC-Tag des Laufs (Gate strikt < today)', () => {
    expect(lauf).toContain("const today = now.toISOString().slice(0, 10);");
    expect(lauf).toContain('const r = bewerteUrteil(u, schluesse, kosten, today);');
  });
  it('ohne Kurse wird NICHT verfallen — offen gezählt, nächstes Mal erneut', () => {
    const stelle = lauf.indexOf('keine Kurse für ${symbol}');
    expect(stelle).toBeGreaterThan(-1);
    const block = lauf.slice(stelle, stelle + 200);
    expect(block).toContain('offen += liste.length;');
    expect(block).toContain('continue;');
    expect(block).not.toContain('verfallen');
  });
  it('B4: indizierte Abfrage über bewertet == false, Altbestand nur über das Fenster — Urteile tragen das Feld seit der Anlage', () => {
    expect(lauf).toContain("indiziert = await coll.where('bewertet', '==', false).orderBy('decidedAt', 'asc').limit(BATCH_LIMIT).get();");
    expect(lauf).toContain("for (const d of fenster.docs) if (d.get('bewertet') === undefined) aufnehmen(d, true);");
    expect(lauf).toContain('batch.update(ref, { bewertet: false });');
    const idx = indexe.indexes.find((i) => i.collectionGroup === 'kiUrteile');
    expect(idx?.fields.map((f) => `${f.fieldPath}:${f.order}`)).toEqual(['bewertet:ASCENDING', 'decidedAt:ASCENDING']);
    expect(nachrichten.split('bewertet: false').length - 1).toBe(3); // urteilSchreiben + zwei Batch-Anlagen
  });
  it('B3a: ein Fall je (Symbol, Bezugstag) — Geschwister werden bewertet, aber nicht gezählt', () => {
    expect(lauf).toContain("const snap = await coll.where('fall', '==', key).limit(1).get();");
    expect(lauf).toContain("const istDoppelt = r.stand === 'bewertet' && key !== null && (await fallSchonGezaehlt(key));");
    expect(lauf).toContain('else if (istDoppelt) doppelt += 1;');
  });
  it('genau eine Bewertung je Urteil; Marker und Aggregat im selben Batch', () => {
    expect(lauf).toContain("if (d.get('bewertung')) return; // genau eine Bewertung je Urteil");
    expect(lauf).toContain('bewertet: true,');
    expect(lauf).toContain("args.push(new FieldPath('faelle', b, 'n'), FieldValue.increment(d.n));");
    expect(lauf).toContain('(batch.update as (...a: unknown[]) => unknown)(statsRef, ...args);');
    const aggregat = lauf.indexOf('(batch.update as (...a: unknown[]) => unknown)(statsRef, ...args);');
    const commit = lauf.indexOf('await batch.commit();', aggregat);
    expect(commit).toBeGreaterThan(aggregat);
  });
  it('das Gewicht kommt NUR aus dem Gewichts-Bucket (tatsächlich abgegebene Long-Stimmen)', () => {
    expect(lauf).toContain('const gewicht = kiGewicht(faelle[KI_GEWICHT_BUCKET]);');
    expect(lauf.split('kiGewicht(').length - 1).toBe(1);
  });
  it('nur Summen nach meta/kiStats und meta/health — keine Kontokennung, keine Trades', () => {
    const start = lauf.indexOf('await statsRef.set(');
    const ende = lauf.indexOf('{ merge: true },', start);
    const block = lauf.slice(start, ende);
    expect(block).not.toMatch(/uid|email|users\//);
  });
  it('Wochenbericht nur freitags und einmal je ISO-Woche, an Admins als System-Nachricht', () => {
    expect(lauf).toContain("if (wochentagEt === 'Fri' && stand.get('wocheGemeldet') !== woche) {");
    expect(lauf).toContain("db.collection('users').where('admin', '==', true).get()");
    expect(lauf).toContain("a.ref.collection('nachrichten').add({ von: 'admin', text, at: now.toISOString() })");
  });
  it('Emulator-Trigger ist außerhalb des Emulators gesperrt', () => {
    expect(lauf).toContain("if (process.env.FUNCTIONS_EMULATOR !== 'true') {");
    expect(KI_BEWERTUNG_FENSTER_TAGE).toBe(45);
  });
});

describe('Scan — Anwendung des Gewichts', () => {
  it('liest meta/kiStats einmal je Scan — DENSELBEN Bucket, aus dem der Lauf rechnet; nicht lesbar ⇒ 1', () => {
    expect(scan).toContain("db.doc('meta/kiStats').get(),");
    // Naht-Befund 08.10.: Scan las `faelle.wirksam`, geschrieben wird `wirksam_long`.
    expect(scan).toContain('kiStats.get(`faelle.${KI_GEWICHT_BUCKET}`)');
    expect(scan).not.toContain("'faelle.wirksam'");
    expect(scan).toContain('let kiGewichtFaktor = 1;');
    // Beide Seiten hängen an derselben Konstante.
    expect(lauf).toContain('const gewicht = kiGewicht(faelle[KI_GEWICHT_BUCKET]);');
  });
  it('das Gewicht erreicht genau zwei Stellen: Stimme und Probegröße — keinen Stop, kein Veto', () => {
    expect(scan).toMatch(/kiGenutzt\[symbol\] as KiGenutzt \| undefined,\s*kiGewichtFaktor,\s*\);/);
    expect(scan).toContain('const kiFaktor = kiGroessenFaktor(ohneKi, direction, kiGewichtFaktor);');
    // Jede Verwendung außerhalb dieser zwei Stellen (und Deklaration/Zuweisung/
    // Herzschlag) wäre ein neuer Pfad — hier aufgelistet, damit er auffällt.
    const zeilen = scan.split('\n').filter((z) => z.includes('kiGewichtFaktor'));
    const erlaubt = [/let kiGewichtFaktor = 1;/, /kiGewichtFaktor = kiGewicht\($/, /gewicht: kiGewichtFaktor,/, /^\s*kiGewichtFaktor,$/, /kiGroessenFaktor\(ohneKi, direction, kiGewichtFaktor\)/];
    for (const z of zeilen) expect(erlaubt.some((re) => re.test(z))).toBe(true);
    // kiPositionsAktion (Stops/Ausstiege) und kiVeto kennen das Gewicht nicht —
    // geprüft über den Aufruf bis zum schließenden `);`.
    for (const fn of ['kiPositionsAktion(', 'kiVeto(']) {
      let von = scan.indexOf(fn);
      expect(von).toBeGreaterThan(-1);
      while (von !== -1) {
        const bis = scan.indexOf(');', von);
        expect(scan.slice(von, bis)).not.toContain('kiGewichtFaktor');
        von = scan.indexOf(fn, von + 1);
      }
    }
  });
  it('B2: KI-Alleingang ist ein eigener Marker — Hebel-Sperre, Probe-Etikett und Bucket hängen NICHT am Zahlenwert', () => {
    expect(scan).toContain("const kiAllein = direction !== 'hold' && ohneKi !== direction;");
    expect(scan.split('const budget = kiAllein ? null : hebelBudget(konfluenz, {').length - 1).toBe(2);
    expect(scan).toContain('if (kiAllein) kiLauf.probe += 1;');
    expect(scan).toContain('const gebucht = kiAllein ? bucketKey(');
    expect(scan).toContain('&& !kiAllein ? { soloTrend: true }');
    expect(scan).not.toContain('kiFaktor < 1');
    expect(scan).not.toContain('kiFaktor === 1');
  });
  it('B7: der Scan markiert, welche Urteile tatsächlich gestimmt haben (nur Zeitstempel)', () => {
    expect(scan).toContain("if (kiVote && kiSig && kiVote.dir === direction) kiGestimmt.add(`${kiSig.newsId}_${symbol}`);");
    expect(scan).toContain("b.set(db.doc(`kiUrteile/${id}`), { gestimmtAt: new Date().toISOString() }, { merge: true });");
  });
  it('B5: Lage zählt nur, was JETZT handelbar ist (Einstiegsfenster, Markt offen)', () => {
    expect(scan).toContain('&& Date.now() - Date.parse(s.firstSeenAt) <= KI_EINSTIEG_MAX_MIN * 60_000');
    expect(scan).toContain('&& marketOpenForClass(classify(s.symbol), new Date()),');
    expect(lauf).toContain('logger.warn(`KIWIRKUNG: ${zustand.text}`);');
  });
  it('zählt je Scan Lage und Aktionen für den Untätigkeits-Alarm (nur Zähler)', () => {
    expect(scan).toContain('lageScans: FieldValue.increment(kiLaufGesamt.lage > 0 ? 1 : 0),');
    expect(scan).toContain('aktionen: FieldValue.increment(aktionen),');
    expect(scan).toContain('gewicht: kiGewichtFaktor,');
  });
  it('kiStimme: Gewicht 0 heißt KEINE Stimme — und über 1 nie mehr als die Konfluenz', () => {
    expect(aktion).toContain('const weight = kiStimmGewicht(requiredConfluence, gewicht);');
    expect(aktion).toContain('if (weight === 0) return null;');
    expect(aktion).toContain('return Math.min(voll, Math.floor(voll * f));');
  });
});
