/**
 * SECREVIEW2 #13 — Der Engine-State liegt unter `users/{uid}/private/engineState` — EIN Doc je Nutzer,
 * unabhängig von Modus und Alpaca-Konto (state.ts L18). `connectBroker`/`trenneBroker` fassen ihn
 * nicht an. Zwei Folgen:
 *   (a) Konto-Wechsel (trennen, anderes Papier-/Echtgeld-Konto verbinden): Der alte State mit
 *       Positionen des ALTEN Kontos trifft auf ein Konto, das sie nicht hat ⇒ `reconcile` bucht
 *       „missing" mit geschätztem Kurs als `trade_closed` ⇒ zwei Trade-Docs (Steuer, stats/main)
 *       für einen Verkauf, der nie stattfand (reconcile.ts L139-145).
 *   (b) Modus-Wechsel (PK ⇒ AK nach Live-Reife, oder zurück): `Engine.start()` wirft
 *       „state.json gehört zum Modus …" (engine.ts L234) — in JEDEM Takt, ohne Weg für den Nutzer,
 *       das private Doc loszuwerden: Der Nutzer ist dauerhaft `failed`, Exits laufen nicht mehr.
 *
 * Der funktionale Teil zeigt (a) mit dem Takt-Fake; der statische Teil fordert, dass der Wechsel der
 * Verbindung den State entkoppelt (Pfad je Modus/Konto oder Reset beim Verbinden/Trennen).
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { engineStatePath } from '../../src/engine/state.ts';
import { stateMitPosition, T1, welt, type Welt } from './_welt.ts';

const hier = dirname(fileURLToPath(import.meta.url));
const welten: Welt[] = [];
afterEach(() => {
  for (const w of welten.splice(0)) w.aufraeumen();
});

describe('secreview2: Engine-State überlebt den Broker-Wechsel', () => {
  it('(a) alter State + neues Konto ohne die Position ⇒ State wird archiviert, kein Phantom-Verkauf', async () => {
    const w = welt();
    welten.push(w);
    // Position des alten Kontos (accountId ≠ Fake-Konto 'fake'); w.trading (neues Konto) hat nichts.
    w.db.seed(engineStatePath('u1'), { ...stateMitPosition(), accountId: 'konto-alt' });
    const r = await w.run(T1);
    expect(r.ok).toBe(0);
    expect(r.failed).toEqual([{ uid: 'u1', error: expect.stringContaining('archiviert') }]);
    const trades = w.db.list('users/u1/trades').map((d) => d.data);
    expect(trades.filter((t) => t.kursGeschaetzt === true), 'Verkauf mit geschätztem Kurs für eine Position, die dieses Konto nie hatte').toHaveLength(0);
    expect(w.trading.callsOf('submitOrder')).toHaveLength(0);
    expect(w.db.get(engineStatePath('u1'))).toBeUndefined();
    const archiv = w.db.list('users/u1/private/archiv/engineStates');
    expect(archiv).toHaveLength(1);
    expect(archiv[0]!.data.accountId).toBe('konto-alt');
    expect(Object.keys(archiv[0]!.data.positions as object)).toEqual(['AAPL']);
    expect(w.db.list('users/u1/journal').some((d) => String(d.data.text ?? '').includes('archiviert'))).toBe(true);

    // Nächster Takt: frisches Buch für das neue Konto, der State trägt dessen Konto-ID.
    const r2 = await w.run(T1 + 60_000);
    expect(r2.ok).toBe(1);
    expect((w.db.get(engineStatePath('u1')) as { accountId?: string } | undefined)?.accountId).toBe('fake');
  });

  it('(b) Verbinden/Trennen muss den Engine-State entkoppeln (Pfad je Modus/Konto oder Reset)', () => {
    const connect = readFileSync(join(hier, '../../src/callable/connectBroker.ts'), 'utf8');
    const pfadJeKonto = engineStatePath.length >= 2; // engineStatePath(uid, mode|accountId)
    const resetBeimWechsel = /engineState/.test(connect);
    expect(pfadJeKonto || resetBeimWechsel, 'State ist weder je Modus/Konto getrennt noch wird er beim Wechsel zurückgesetzt').toBe(true);
  });
});
