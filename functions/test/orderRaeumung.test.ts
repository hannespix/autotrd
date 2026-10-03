/**
 * GTC-Waisen beim Trennen (Befund 24.08.).
 *
 * `trenneBroker` löschte das Schlüsselpaar und ließ alle offenen Orders beim
 * Broker stehen. Schutz-Stops sind GTC: Sie arbeiteten danach unbeaufsichtigt
 * weiter, reservierten die Stücke gegen jeden manuellen Verkauf und
 * blockierten die Exits eines Nachfolge-Kontos auf demselben Depot — und weil
 * die Schlüssel weg waren, konnte kein Code sie je wieder stornieren.
 *
 * `raeumeEigeneOrders` schließt die Lücke. Die Tests hier prüfen die reine
 * Funktion (mit gestelltem fetch) UND per Quelltext-Wächter ihren Einsatz —
 * dieselbe Lehre wie bei `watchlistUnion`: Eine Entscheidung, die niemand
 * ruft, sieht aus wie Schutz und ist keiner.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { raeumeEigeneOrders } from '../src/core/orderRaeumung.js';
import type { AlpacaSchluessel } from '../src/core/alpacaBroker.js';

const SCHLUESSEL: AlpacaSchluessel = { keyId: 'PKTEST', secret: 'geheim-genug-fuer-den-test' };

/** Eine offene Order, wie Alpaca sie liefert — Felder wie im echten JSON. */
const offen = (
  id: string,
  clientOrderId: string,
  typ = 'stop',
  symbol = 'AAPL',
): Record<string, unknown> => ({
  id,
  client_order_id: clientOrderId,
  symbol,
  side: 'sell',
  type: typ,
  qty: '5',
  stop_price: '180.55',
  limit_price: typ === 'stop_limit' ? '180.10' : null,
});

/**
 * Gestellter fetch: GET liefert die Liste, DELETE je Order-ID den
 * eingestellten Ausgang. `-1` simuliert einen Netzwerkfehler (fetch wirft),
 * 204 die leere Alpaca-Antwort, die `alpacaOrderStornieren` als Erfolg liest.
 */
const brokerMock = (liste: unknown, stornoStatus: Record<string, number> = {}) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'DELETE') {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const status = stornoStatus[id] ?? 204;
      if (status === -1) throw new TypeError('fetch failed');
      return {
        ok: status < 400,
        status,
        text: async () => (status === 204 ? '' : JSON.stringify({ msg: 'x' })),
      } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(liste) } as unknown as Response;
  });

describe('raeumeEigeneOrders — nur eigene, aber ALLE eigenen', () => {
  it('storniert eigene Orders jedes Typs — auch stop_limit und limit', async () => {
    // Kein Typ-Filter, mit Absicht: Der Filter auf `typ === 'stop'` hat in
    // adoptBroker bereits einmal alle Krypto-Schutz-Stops (stop_limit)
    // übersehen. Beim Abräumen zählt „gehört uns", nicht „ist ein Stop".
    const f = brokerMock([
      offen('o1', 'u1-AAPL-sell-5-scan-9-schutz', 'stop'),
      offen('o2', 'u1-BTC-USD-sell-2-scan-9-schutz', 'stop_limit', 'BTC/USD'),
      offen('o3', 'u1-ETH-USD-buy-1-scan-9', 'limit', 'ETH/USD'),
    ]);
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f);
    expect(b.gefunden).toBe(3);
    expect(b.storniert).toBe(3);
    expect(b.erledigteOrderIds).toEqual(['o1', 'o2', 'o3']);
    // Ein GET (Liste) + drei DELETEs
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('lässt fremde Orders unangetastet — Mensch in der Alpaca-Oberfläche', async () => {
    const f = brokerMock([
      offen('o1', 'u1-AAPL-sell-5-scan-9-schutz'),
      offen('fremd', 'irgendwas-anderes'),
      offen('leer', ''),
    ]);
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f);
    expect(b.gefunden).toBe(1);
    expect(b.erledigteOrderIds).toEqual(['o1']);
    const geloescht = f.mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(geloescht).toHaveLength(1);
    expect(String(geloescht[0]?.[0])).toContain('/v2/orders/o1');
  });

  it('kein Verwechslungs-Präfix: u1 räumt nicht die Orders von u12 ab', async () => {
    // Der Präfix endet auf `-` — sonst wäre `u12-…` ein Treffer für `u1`.
    const f = brokerMock([offen('x', 'u12-AAPL-sell-5-scan-9-schutz')]);
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f);
    expect(b.gefunden).toBe(0);
  });

  it('bereinigt die uid wie clientOrderId(): Sonderzeichen werden _', async () => {
    const f = brokerMock([offen('o1', 'u_1-AAPL-sell-5-scan-9-schutz')]);
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u.1', new Set(), f);
    expect(b.gefunden).toBe(1);
  });

  it('nimmt bekannte schutz.orderIds auch OHNE Präfix mit — gekappte uid', async () => {
    // `clientOrderId()` kappt bei Überlänge den uid-Teil, nie den Schwanz.
    // Die Order trägt dann ein fremd aussehendes Präfix — aber das Buch
    // kennt ihre ID.
    const f = brokerMock([offen('o9', 'gekappt-AAPL-sell-5-scan-9-schutz')]);
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(['o9']), f);
    expect(b.gefunden).toBe(1);
    expect(b.erledigteOrderIds).toEqual(['o9']);
  });
});

describe('raeumeEigeneOrders — ehrlicher Befund statt Zusicherung', () => {
  it('zählt 422 als gefüllt — die Stücke sind dann schon weg', async () => {
    const f = brokerMock(
      [offen('o1', 'u1-A-sell-1-s-schutz'), offen('o2', 'u1-B-sell-1-s-schutz', 'stop', 'MSFT')],
      { o2: 422 },
    );
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f);
    expect(b.storniert).toBe(1);
    expect(b.gefuellt).toBe(1);
    // Auch die gefüllte Order ist ERLEDIGT — sie hält nichts mehr fest, ihr
    // schutz-Verweis im Buch darf fallen.
    expect(b.erledigteOrderIds).toEqual(['o1', 'o2']);
  });

  it('wirft bei Netz-/Serverfehlern nicht, sondern zählt sie', async () => {
    const f = brokerMock(
      [
        offen('o1', 'u1-A-sell-1-s-schutz'),
        offen('o2', 'u1-B-sell-1-s-schutz', 'stop', 'MSFT'),
        offen('o3', 'u1-C-sell-1-s-schutz', 'stop', 'NVDA'),
      ],
      { o2: -1, o3: 500 },
    );
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f);
    expect(b.storniert).toBe(1);
    expect(b.fehler).toBe(2);
    // Eine Order, deren Storno scheiterte, ist NICHT erledigt — ihr
    // schutz-Verweis bleibt stehen, die Antwort meldet den Rest.
    expect(b.erledigteOrderIds).toEqual(['o1']);
  });

  it('meldet eine nicht abrufbare Liste, statt zu werfen', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f);
    expect(b.listeFehlgeschlagen).toBe(true);
    expect(b.gefunden).toBe(0);
    expect(b.erledigteOrderIds).toEqual([]);
  });

  it('meldet ein volles 500er-Fenster als möglicherweise unvollständig', async () => {
    // `alpacaOrdersOffen` paginiert nicht: Exakt 500 Treffer heißt, dahinter
    // kann mehr liegen — der Befund darf keine Vollständigkeit behaupten.
    const viele = Array.from({ length: 500 }, (_, i) => offen(`f${i}`, 'fremd-x'));
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), brokerMock(viele));
    expect(b.moeglicherweiseUnvollstaendig).toBe(true);
    expect(b.gefunden).toBe(0);
  });

  it('zählt bei gerissener Frist den Rest als Fehler, statt zu sterben', async () => {
    // Die Frist reißt NACH dem Schlüssel-Löschen im Aufrufer — die Function
    // sterben zu lassen hieße: keine Antwort, kein Buch-Putzen.
    const f = brokerMock([
      offen('o1', 'u1-A-sell-1-s-schutz'),
      offen('o2', 'u1-B-sell-1-s-schutz', 'stop', 'MSFT'),
    ]);
    const b = await raeumeEigeneOrders('paper', SCHLUESSEL, 'u1', new Set(), f, 0);
    expect(b.gefunden).toBe(2);
    expect(b.fehler).toBe(2);
    expect(b.storniert).toBe(0);
    // Kein einziger DELETE ging raus.
    expect(f.mock.calls.filter((c) => c[1]?.method === 'DELETE')).toHaveLength(0);
  });
});

describe('raeumeEigeneOrders — Echtgeld ist tabu', () => {
  it('bei mode live: kein Listen, kein Storno, kein einziger Alpaca-Call', async () => {
    const f = brokerMock([offen('o1', 'u1-A-sell-1-s-schutz')]);
    const b = await raeumeEigeneOrders('live', SCHLUESSEL, 'u1', new Set(['o1']), f);
    expect(b.liveUebersprungen).toBe(true);
    expect(b.gefunden).toBe(0);
    expect(b.erledigteOrderIds).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

/* ── Quelltext-Wächter: der Einsatz, nicht nur die Entscheidung ──────────── */

describe('Quelltext: trenneBroker räumt auf — in der einzig sicheren Reihenfolge', () => {
  const text = readFileSync(
    join(import.meta.dirname, '..', 'src', 'callable', 'connectBroker.ts'),
    'utf8',
  );

  it('Schlüssel in die Hand, DANN löschen, DANN stornieren', () => {
    // Die Reihenfolge ist die Sicherung: (1) Verbindung lesen, solange das
    // Dokument existiert — danach gibt es die Schlüssel nicht mehr.
    // (2) Löschen VOR dem Sweep — das Trennen darf nie daran scheitern,
    // dass Alpaca nicht antwortet, sonst käme ein Konto mit widerrufenen
    // Schlüsseln nie mehr von ihnen los. (3) Der Sweep als Best-Effort.
    const lesen = text.indexOf('await brokerVerbindungLesend(uid)');
    const loeschen = text.indexOf('await ref.delete()');
    const sweep = text.indexOf('raeumeEigeneOrders(');
    expect(lesen, 'brokerVerbindungLesend fehlt in trenneBroker').toBeGreaterThan(0);
    expect(loeschen, 'ref.delete fehlt').toBeGreaterThan(lesen);
    expect(sweep, 'raeumeEigeneOrders wird nicht gerufen').toBeGreaterThan(loeschen);
  });

  it('tote schutz-Verweise fallen transaktional — nur bei unveränderter orderId', () => {
    // Ein paralleler pflegeSchutz kann nach dem Storno einen NEUEN Stop
    // eingetragen haben; dessen lebende Kennung blind zu nullen hieße, den
    // späteren Exit an der Order-Reservierung scheitern zu lassen (Red-Team
    // 24.08., Angriff c). Deshalb: Transaktion, Vergleich, dann update —
    // und nie set(merge), das eine parallel gelöschte Position als
    // Geister-Dokument wiederauferstehen ließe.
    const sweep = text.indexOf('raeumeEigeneOrders(');
    const ende = text.indexOf('geloescht: true', sweep);
    const block = text.slice(sweep, ende);
    expect(block).toContain('db.runTransaction(');
    expect(block).toMatch(/schutz\.orderId'\) as unknown\) === oid/);
    expect(block).toContain('tx.update(pRef, { schutz: null })');
    expect(block).not.toContain('merge: true');
  });

  it('das Callable trägt ein Zeitbudget über der Sweep-Frist', () => {
    // Default wären 60 s — der Sweep läuft aber NACH dem Schlüssel-Löschen:
    // Stürbe die Function im Sweep, käme ein Fehler zurück, obwohl getrennt
    // wurde, und das Buch bliebe ungeputzt. 120 s > FRIST_MS (90 s) heißt:
    // Es gewinnt immer die ehrliche Antwort, nie der Timeout.
    expect(text).toContain('timeoutSeconds: 120');
  });
});

describe('Quelltext: die Echtgeld-Sperre sitzt im Modul, nicht beim Aufrufer', () => {
  it('raeumeEigeneOrders bricht bei mode !== paper ab, bevor irgendetwas läuft', () => {
    // Die lesende Verbindung umgeht die vier Echtgeld-Guards — der Sweep
    // wäre sonst der einzige gate-freie Schreibpfad auf ein Live-Depot,
    // und er stornierte ausgerechnet die Schutz-Stops (Red-Team 24.08.,
    // Angriff a). Hart im Modul, damit kein künftiger Aufrufer es vergisst.
    const modul = readFileSync(
      join(import.meta.dirname, '..', 'src', 'core', 'orderRaeumung.ts'),
      'utf8',
    );
    const sperre = modul.indexOf("if (mode !== 'paper')");
    const liste = modul.indexOf('alpacaOrdersOffen(');
    expect(sperre, 'Echtgeld-Sperre fehlt').toBeGreaterThan(0);
    // Die Sperre steht VOR dem ersten Alpaca-Aufruf (Import zählt nicht —
    // deshalb die Suche ab der Sperre).
    expect(modul.indexOf('await alpacaOrdersOffen(', sperre)).toBeGreaterThan(sperre);
    expect(liste).toBeGreaterThan(0);
  });
});

describe('Quelltext: adoptBroker erkennt auch Krypto-Schutz (stop_limit)', () => {
  const text = readFileSync(
    join(import.meta.dirname, '..', 'src', 'callable', 'adoptBroker.ts'),
    'utf8',
  );

  it('der Wiedererkennungs-Filter nimmt stop UND stop_limit', () => {
    // `alpacaStopOrder` sendet für Krypto `stop_limit` — ein Filter nur auf
    // `stop` machte genau diese Schutz-Stops bei jedem Adopt zu Waisen.
    expect(text).toMatch(/o\.typ !== 'stop' && o\.typ !== 'stop_limit'/);
  });

  it('das Limit wandert in die schutz-Verknüpfung', () => {
    // Ohne `limitPreis` müsste das Nachziehen (`alpacaOrderErsetzen`) beim
    // stop_limit raten — das Feld ist im Positions-Schema ausdrücklich
    // „muss beim Nachziehen mitwandern".
    expect(text).toContain('limitPreis: o.limitPreis');
  });
});
