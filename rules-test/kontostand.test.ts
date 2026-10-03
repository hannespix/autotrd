/**
 * Audit-Befund 11.08. (A4): `snapshotEquity` mischte zwei Zeitpunkte.
 *
 * ── Der Befund ────────────────────────────────────────────────────────────
 *
 * Der Saldo stammte aus dem Konten-Query vom Beginn des Laufs, die Positionen
 * aus einem frischen Lesevorgang. Dazwischen liegen die Zinsbuchung und alle
 * vorher abgearbeiteten Konten. Fiel ein Kauf in dieses Fenster, zählte das
 * Geld doppelt — Cash aus dem alten Stand UND die neue Position. Dieselbe
 * Zahl wird zur Bezugsgröße der Notbremse, die dann am nächsten Tag zu früh
 * auslöst.
 *
 * ── Warum am Emulator und mit dem Admin-SDK ───────────────────────────────
 *
 * `leseKontostand` beruht auf einer Fähigkeit von Firestore, die ich nicht
 * annehmen darf: eine READ-ONLY-Transaktion, die ein Dokument UND eine
 * Collection-Abfrage liest. Ginge das nicht, bräche der tägliche Snapshot
 * komplett — und zwar erst in Produktion. Eine Attrappe hätte genau diese
 * Frage nicht beantwortet, sondern nur meine Vorstellung davon bestätigt.
 *
 * Deshalb läuft hier echter Produktionscode gegen echtes Firestore. Der
 * Emulator kommt aus `npm run test:rules` (firebase emulators:exec).
 */
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leseKontostand } from '../functions/src/scheduled/snapshotEquity.js';

let app: App;
let db: Firestore;

beforeAll(() => {
  // emulators:exec setzt FIRESTORE_EMULATOR_HOST; das Admin-SDK verbindet
  // sich dann ohne echte Zugangsdaten gegen den Emulator.
  expect(process.env['FIRESTORE_EMULATOR_HOST'], 'Emulator läuft nicht').toBeTruthy();
  app = initializeApp({ projectId: 'demo-rules' }, `kontostand-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

const anlegen = async (
  uid: string,
  wallet: unknown,
  positionen: Record<string, unknown>,
): Promise<FirebaseFirestore.DocumentReference> => {
  const ref = db.doc(`users/${uid}`);
  await ref.set(wallet === undefined ? { profile: {} } : { wallet: { paperBalance: wallet } });
  for (const [sym, pos] of Object.entries(positionen)) {
    await ref.collection('positions').doc(sym).set(pos as Record<string, unknown>);
  }
  return ref;
};

describe('leseKontostand', () => {
  it('liefert Saldo und Positionen aus dem Dokument', async () => {
    const ref = await anlegen('k1', 24_500.5, {
      AAPL: { symbol: 'AAPL', qty: 3, avgEntry: 100 },
      BTCUSD: { symbol: 'BTCUSD', qty: 0.02, avgEntry: 60_000 },
    });
    const stand = await leseKontostand(db, ref, 999);
    expect(stand.balance).toBe(24_500.5);
    expect(stand.positionen.map((p) => p.id).sort()).toEqual(['AAPL', 'BTCUSD']);
  });

  it('nimmt den FRISCHEN Saldo, nicht den Rückfall', async () => {
    /* Der Kern des Befunds: Der Rückfall ist der alte Stand vom Beginn des
     * Laufs. Käme er zum Zug, obwohl das Dokument lesbar ist, wäre genau der
     * Fehler zurück — nur diesmal fest verdrahtet. */
    const ref = await anlegen('k2', 10_000, {});
    await ref.set({ wallet: { paperBalance: 8_000 } }, { merge: true }); // Kauf dazwischen
    expect((await leseKontostand(db, ref, 10_000)).balance).toBe(8_000);
  });

  it('ohne Wallet-Feld greift der Rückfall', async () => {
    // Besser der alte Stand als gar kein Snapshot: Eine Lücke in der
    // Equity-Serie zieht sich durch Sharpe, MaxDD und die Kurve im Dashboard.
    const ref = await anlegen('k3', undefined, { AAPL: { symbol: 'AAPL', qty: 1 } });
    expect((await leseKontostand(db, ref, 7_777)).balance).toBe(7_777);
  });

  it('ein unbrauchbarer Wert greift ebenfalls den Rückfall ab', async () => {
    const ref = await anlegen('k4', 'zwölf', {});
    expect((await leseKontostand(db, ref, 500)).balance).toBe(500);
  });

  it('ein Konto ohne Positionen liefert eine leere Liste, keinen Fehler', async () => {
    const ref = await anlegen('k5', 1_000, {});
    const stand = await leseKontostand(db, ref, 0);
    expect(stand.positionen).toEqual([]);
    expect(stand.balance).toBe(1_000);
  });

  it('die Positionsdaten kommen vollständig durch', async () => {
    // `positionValue` braucht qty UND side; ein `select` an dieser Stelle
    // hätte den Short-Fall still falsch bewertet.
    const ref = await anlegen('k6', 1_000, {
      TSLA: { symbol: 'TSLA', qty: 5, avgEntry: 200, side: 'short' },
    });
    const stand = await leseKontostand(db, ref, 0);
    expect(stand.positionen[0]?.pos).toMatchObject({ qty: 5, side: 'short', avgEntry: 200 });
  });

  it('ein fehlendes Konto-Dokument wirft nicht', async () => {
    // Kann zwischen Query und Lesen passieren, wenn ein Konto gelöscht wird.
    // Ein Fehler hier stoppte den Snapshot dieses Kontos komplett.
    const stand = await leseKontostand(db, db.doc('users/gibtsnicht'), 42);
    expect(stand).toEqual({ balance: 42, positionen: [] });
  });
});
