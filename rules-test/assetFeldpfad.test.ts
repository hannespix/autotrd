/**
 * Nebenbefund vom 11.08., gefunden beim Sharding des Asset-Caches (C3):
 * Symbole mit Punkt fanden ihren Cache-Eintrag NIE.
 *
 * ── Die Falle ─────────────────────────────────────────────────────────────
 *
 * Der Leser holte den Eintrag mit `snapshot.get(symbol)`. Ein String ist bei
 * Firestore aber kein Feldname, sondern ein FELDPFAD: `get('BRK.B')` sucht
 * das Feld `BRK` und darin das Unterfeld `B`. Geschrieben wurde der Eintrag
 * dagegen über ein Objekt-Literal (`{ [symbol]: … }`), und dort ist der
 * Punkt ein ganz normales Zeichen im Feldnamen.
 *
 * Schreiben und Lesen meinten also verschiedene Dinge. Für BRK.B — und jedes
 * andere Papier mit Punkt in der Alpaca-Schreibweise — lief jede Abfrage in
 * Stufe 3 und fragte live beim Broker nach. Der Cache war für diese Symbole
 * wirkungslos, ohne dass irgendwo ein Fehler entstand.
 *
 * ── Warum das kein Unit-Test finden konnte ────────────────────────────────
 *
 * Die Firestore-Attrappe in `functions/test/orderRouting.test.ts` bildet
 * `get(k)` als `daten[k]` nach — also als Feldnamen-Zugriff. Sie bestätigt
 * damit genau die falsche Annahme, aus der der Fehler entstanden ist. Ein
 * Test dagegen wäre grün geblieben, egal wie kaputt der Produktionscode ist.
 *
 * Deshalb steht dieser Test am echten Emulator und prüft das Verhalten von
 * Firestore selbst.
 */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feldZuStand } from '../functions/src/core/orderRouting.js';

let app: App;
let db: Firestore;

beforeAll(() => {
  expect(process.env['FIRESTORE_EMULATOR_HOST'], 'Emulator läuft nicht').toBeTruthy();
  app = initializeApp({ projectId: 'demo-rules' }, `assets-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

const AT = new Date().toISOString();

describe('Feldnamen mit Punkt', () => {
  it('snapshot.get() findet sie NICHT — das war der Fehler', async () => {
    const ref = db.doc('meta/assetFeldpfadProbe');
    await ref.set({ 'BRK.B': { bekannt: true, at: AT, tradable: true } });
    const snap = await ref.get();
    // Der Punkt wird als Pfadtrenner gelesen: Feld „BRK", Unterfeld „B".
    expect(snap.get('BRK.B')).toBe(undefined);
  });

  it('data() findet sie', async () => {
    const ref = db.doc('meta/assetFeldpfadProbe2');
    await ref.set({ 'BRK.B': { bekannt: true, at: AT, tradable: true } });
    const daten = (await ref.get()).data() ?? {};
    expect(daten['BRK.B']).toBeDefined();
  });

  it('und der neue Leser macht daraus einen brauchbaren Stand', async () => {
    // Der ganze Weg: schreiben wie der Produktionscode, lesen wie der
    // Produktionscode, übersetzen mit der Produktionsfunktion.
    const ref = db.doc('meta/assetFeldpfadProbe3');
    await ref.set(
      { 'BRK.B': { bekannt: true, at: AT, tradable: true, fractionable: true } },
      { merge: true },
    );
    const daten = (await ref.get()).data() ?? {};
    const stand = feldZuStand('BRK.B', daten['BRK.B'], Date.now());
    expect(stand).toMatchObject({ art: 'bekannt', asset: { symbol: 'BRK.B', tradable: true } });
  });

  it('merge legt weitere Symbole daneben, ohne die bestehenden zu verlieren', async () => {
    // Der Shard wächst über viele Läufe. Ein `set` ohne merge hätte bei jedem
    // neuen Symbol alle anderen gelöscht — und der Cache begänne täglich neu.
    const ref = db.doc('meta/assetFeldpfadProbe4');
    await ref.set({ AAPL: { bekannt: true, at: AT } }, { merge: true });
    await ref.set({ 'BRK.B': { bekannt: true, at: AT } }, { merge: true });
    const daten = (await ref.get()).data() ?? {};
    expect(Object.keys(daten).sort()).toEqual(['AAPL', 'BRK.B']);
  });
});
