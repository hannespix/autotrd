/**
 * Admin-Konten-Übersicht (Owner 13.08.): je Konto Equity, Trades, Reife.
 *
 * Der kritische Punkt ist NICHT, dass die Felder existieren, sondern WOHER
 * die Reife kommt: aus `liveGate.reifeFuerKonto` — derselben Funktion, die
 * Scan, brokerStatus und Order-Routing für die Echtgeld-Freigabe benutzen.
 * Eine eigene Reife-Rechnung im Admin-Callable wäre eine zweite Wahrheit
 * über die Frage, ob echtes Geld fließen darf; die Wächter unten verhindern
 * genau das.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const admin = readFileSync(join(hier, '../src/callable/admin.ts'), 'utf8');
const dashboard = readFileSync(join(hier, '../../frontend/src/dashboard.ts'), 'utf8');
const data = readFileSync(join(hier, '../../frontend/src/data.ts'), 'utf8');

describe('Admin-Konten-Übersicht (Quelltext-Wächter)', () => {
  it('die Reife kommt aus liveGate.reifeFuerKonto — keine zweite Rechnung', () => {
    expect(admin).toContain("import { reifeFuerKonto } from '../core/liveGate.js';");
    expect(admin).toContain('reifeFuerKonto(d.id)');
    // Kein eigener liveReife-Aufruf im Callable — der wäre die zweite Wahrheit.
    expect(admin).not.toContain('liveReife(');
  });

  it('die Zeile liefert trades (stats/main) und die Reife-Kurzform', () => {
    expect(admin).toContain("d.ref.collection('stats').doc('main').get()");
    expect(admin).toContain('trades: typeof tradesRoh ===');
    for (const feld of ['bereit: befund.bereit', 'erfuellt: befund.erfuellt', 'gesamt: befund.gesamt', 'fazit: befund.fazit']) {
      expect(admin).toContain(feld);
    }
  });

  it('das Frontend zeigt Trades + Reife-Fortschritt je Konto und hängt sie in die Zeile', () => {
    /* Seit Tranche 5i (19.08.) tragen die beiden Wörter Schlüssel. Geprüft
     * wird weiterhin dasselbe: dass Trades UND Reife-Fortschritt in
     * derselben Zeile stehen — nur nicht mehr über ihre Rechtschreibung. */
    expect(dashboard).toContain("${trades} ${t('adm.trades')} · ${t('adm.reife')} ");
    expect(dashboard).toContain('${row.reife.erfuellt}/${row.reife.gesamt}');
    expect(dashboard).toContain('reife.title = row.reife.fazit;');
    expect(dashboard).toContain('line.append(who, perf, reife, badge);');
  });

  it('der Frontend-Typ kennt beide Felder (sonst fällt der Anschluss still weg)', () => {
    expect(data).toContain('trades: number | null;');
    expect(data).toContain('reife: { bereit: boolean; erfuellt: number; gesamt: number; fazit: string };');
  });
});
