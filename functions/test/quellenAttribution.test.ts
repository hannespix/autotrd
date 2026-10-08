/**
 * Task 17 (08.10.): Die Quellen-Attribution ist ANGESCHLOSSEN.
 *
 * `tradeQuelle` und `byClassQuelle` sind pur getestet (shared/). Hier steht,
 * dass snapshotEquity die Herkunft aus den vorhandenen Feldern des Trade-
 * Dokuments baut (kein zusätzlicher Read), sie an den ClosedTrade hängt
 * und die Quellen-Aufschlüsselung ins öffentliche Aggregat reicht —
 * sonst wären beide Funktionen tote Helfer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '../src/scheduled/snapshotEquity.ts'), 'utf8');
const broker = readFileSync(join(hier, '../src/core/broker.ts'), 'utf8');
const fillSync = readFileSync(join(hier, '../src/scheduled/fillSync.ts'), 'utf8');
const adopt = readFileSync(join(hier, '../src/callable/adoptBroker.ts'), 'utf8');
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');
const zaehl = (text: string, nadel: string): number => text.split(nadel).length - 1;
const anzahl = (nadel: string): number => snapshot.split(nadel).length - 1;

describe('Quellen-Attribution — Anschluss-Wächter', () => {
  it('die Herkunft kommt aus source, bucket, riskExit und sync des Schluss-Trades', () => {
    expect(anzahl('quelle: tradeQuelle({')).toBe(1);
    expect(anzahl("source: t.get('source'),")).toBe(1);
    expect(anzahl("bucket: t.get('bucket'),")).toBe(1);
    expect(anzahl("sync: t.get('sync'),")).toBe(1);
    // und zwar INNERHALB des pnl-Blocks: nur geschlossene Trades tragen die Herkunft
    const block = snapshot.slice(snapshot.indexOf('closed.push({'), snapshot.indexOf('const ts = tradeStats(closed);'));
    expect(block).toContain('quelle: tradeQuelle({');
  });

  it('der Steckbrief steht am Schluss-Trade — von der Position übernommen (Verkauf UND Cover)', () => {
    expect(broker.split('...(pos.bucket ? { bucket: pos.bucket } : {}),').length - 1).toBe(2);
  });

  it('die Quellen-Aufschlüsselung geht mit ins Aggregat UND ungekürzt ins private Konto-Dokument', () => {
    // zweimal: stats/main (privat, ungekürzt) und der Beitrag zum öffentlichen Aggregat (gekürzt ab Schwelle)
    expect(anzahl('byClassQuelle: attr.byClassQuelle,')).toBe(2);
    const beitrag = snapshot.slice(snapshot.indexOf('beitraege.push({'), snapshot.indexOf('beitraege.push({') + 900);
    expect(beitrag).toContain('byClassQuelle: attr.byClassQuelle,');
    const stats = snapshot.slice(snapshot.indexOf('bySymbol: attr.bySymbol,'), snapshot.indexOf('bySymbol: attr.bySymbol,') + 500);
    expect(stats).toContain('byClassQuelle: attr.byClassQuelle,');
  });
});

describe('Task 18 — Quelle beim Öffnen gestempelt, beim Schließen kopiert', () => {
  it('die Buchung rechnet den Einstiegsweg PUR vor der Transaktion und stempelt ihn auf Long UND Short', () => {
    expect(zaehl(broker, 'const einstieg = einstiegsQuelle({ quelle: req.quelle, source: req.source, bucket: req.bucket });')).toBe(1);
    expect(broker.indexOf('const einstieg = einstiegsQuelle(')).toBeLessThan(broker.indexOf('return db.runTransaction(async (tx) => {', broker.indexOf('export async function executePaperTrade(')));
    expect(zaehl(broker, '        ...(einstieg ? { quelle: einstieg } : {}),')).toBe(2);
    // nur eine UNGESTEMPELTE Position bekommt den Weg der Aufstockung
    expect(zaehl(broker, '          ...(!pos.quelle && einstieg ? { quelle: einstieg } : {}),')).toBe(1);
  });

  it('Verkauf UND Cover kopieren die Quelle als eigene Zeile — JE ZWEIG verankert, nicht nur gezählt (Red-Team H1)', () => {
    expect(zaehl(broker, '...(pos.quelle ? { quelle: pos.quelle } : {}),')).toBe(2);
    expect(zaehl(broker, '...(pos.bucket ? { bucket: pos.bucket } : {}),')).toBe(2);
    // Cover-Zweig: das Trade-Literal mit `cover: true` trägt die Kopie genau einmal
    const coverStart = broker.indexOf('          cover: true,');
    const cover = broker.slice(coverStart, broker.indexOf('        };', coverStart));
    expect(zaehl(cover, '          ...(pos.quelle ? { quelle: pos.quelle } : {}),')).toBe(1);
    // Verkaufs-Zweig: das Long-Schluss-Literal (6 Leerzeichen, `riskExit`-Zeile davor) ebenso
    const sellStart = broker.indexOf("      side: 'sell',\n      qty,\n      ...(ganz ? {} : { teilSchluss: true as const }),");
    expect(sellStart).toBeGreaterThan(coverStart);
    const sell = broker.slice(sellStart, broker.indexOf('    };', sellStart));
    expect(sell).toContain('      ...(pos.bucket ? { bucket: pos.bucket } : {}),\n      ...(pos.quelle ? { quelle: pos.quelle } : {}),\n');
  });

  it('die Aufstockung stempelt eine UNGESTEMPELTE Position nach — Long UND Short', () => {
    expect(zaehl(broker, '...(!pos.quelle && einstieg ? { quelle: einstieg } : {}),')).toBe(2);
  });

  it('Gegenrichtung: nie einen Steckbrief aus der Quelle erfinden — die Lernstatistik hängt am bucket', () => {
    expect(broker).not.toMatch(/bucket:\s*(einstieg|quelle|quelleNach)\b/);
    expect(fillSync).not.toMatch(/bucket:\s*quelle/);
    expect(adopt).not.toMatch(/bucket:\s*quelle/);
    // und keine Regel liest das Etikett (befund.quelle/schutz.quelle sind andere Felder)
    expect(scan).not.toMatch(/\b(pos|position|p)\.quelle\b/);
    expect(readFileSync(join(hier, '../src/scheduled/riskPulse.ts'), 'utf8')).not.toMatch(/\b(pos|position|p)\.quelle\b/);
  });

  it('Vermerke tragen den Einstiegsweg, Nachbuchungen lesen ihn (oder die Lauf-Kennung)', () => {
    expect(zaehl(broker, '      ...(mengen.quelle ? { quelle: mengen.quelle } : {}),')).toBe(1);
    expect(zaehl(broker, 'quelle: schliesst ? null : einstiegsQuelle({ quelle: req.quelle, source: req.source, bucket: req.bucket }),')).toBe(1);
    expect(zaehl(broker, '      ...(quelle ? { quelle } : {}),')).toBe(1); // unbookedFills
    expect(zaehl(broker, 'schliesst ? null : einstiegsQuelle({ quelle: req.quelle, source: req.source, bucket: req.bucket }),\n    );')).toBe(1);
    expect(zaehl(broker, 'const quelleNach = eroeffnend ? (d.quelle ?? quelleAusLauf(d.clientOrderId)) : null;')).toBe(1);
    expect(zaehl(broker, 'const quelleNach = d.quelle ?? quelleAusLauf(laufKennungAusVermerk(doc.data()));')).toBe(1);
    expect(zaehl(broker, '...(quelleNach ? { quelle: quelleNach } : {}),')).toBe(2);
  });

  it('fillSync stempelt nur ERÖFFNENDE Fills aus der Kennung der Order; adoptBroker erhält und ergänzt die Quelle', () => {
    expect(zaehl(fillSync, '...(!schliesst && quelleAusLauf(order.clientOrderId) ? { quelle: quelleAusLauf(order.clientOrderId)! } : {}),')).toBe(1);
    // auch der FEHLSCHLAG-Pfad reicht die Kennung an den Vermerk (Red-Team M1) — laufId ist dort nur 'fill-sync'
    expect(zaehl(fillSync, "        schliesst ? null : quelleAusLauf(order.clientOrderId),\n      );")).toBe(1);
    // adoptBroker: Quelle der Order, die die AKTUELLE Position eröffnet hat — nicht der frühesten aller Zeiten (Red-Team H2)
    expect(zaehl(adopt, "const einstiegJeSymbol = einstiegsKennungen(eigeneOrders, { shortsMoeglich: strategy.signals.allowShort === true });")).toBe(1);
    expect(zaehl(adopt, 'const quelle = alt?.quelle ?? quelleAusLauf(einstiegJeSymbol.get(`${short ? \'sell\' : \'buy\'}|${p.symbol}`));')).toBe(1);
    expect(zaehl(adopt, '      ...(quelle ? { quelle } : {}),')).toBe(1);
  });

  it('snapshotEquity liest das Feld und reicht die 7-Tage-Sicht je Quelle weiter', () => {
    expect(anzahl("quelle: t.get('quelle'),")).toBe(1);
    expect(anzahl("const quellen7t = attribution(closed.filter((t) => typeof t.at === 'string' && t.at >= fensterSeit)).byClassQuelle;")).toBe(1);
    expect(anzahl('byClassQuelle7t: quellen7t,')).toBe(2);
  });
});
