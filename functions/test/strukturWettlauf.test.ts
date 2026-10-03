/**
 * Audit-Befund 11.08. (B4): Die Struktursuche schrieb aus einem veralteten
 * Stand.
 *
 * ── Das Fenster ───────────────────────────────────────────────────────────
 *
 * Zwischen `stateRef.get()` und `stateRef.set(zustand)` liegt die gesamte
 * Rechnung eines Kontos: eine Mutation bauen, Kandidat UND Amtierenden über
 * bis zu zwölf Symbole backtesten. Geschrieben wurde dann das komplette
 * Dokument aus dem alten Stand plus den eigenen Änderungen.
 *
 * Neben dem Scheduler (18:10 ET) gibt es `strukturNow` als HTTP-Trigger —
 * zwei Läufe gleichzeitig sind also kein Gedankenspiel, sondern der normale
 * Weg, wie man den Lauf von Hand anstößt.
 *
 * ── Was dabei verloren geht ───────────────────────────────────────────────
 *
 * Der teure Fall ist die Beförderung: Lauf A schreibt die neue
 * Schatten-Strategie UND den Zustand dazu; Lauf B überschreibt den Zustand
 * mit der alten Generation. Danach fährt der Schatten einen Baum, den der
 * Zustand nicht kennt — und das A/B-Duell misst zwei verschiedene Dinge
 * gegeneinander.
 *
 * Der stille Fall ist `nVersuche`. Er ist die Latte, gegen die
 * `beurteileBefoerderung` prüft: Je mehr Mutationen probiert wurden, desto
 * höher muss der Vorsprung sein, um noch etwas zu bedeuten (Selektion kostet
 * Signifikanz). Fällt der Zähler zurück, wird die Latte zu niedrig — und die
 * Suche befördert leichter, als sie darf. Genau die Overfitting-Bremse, für
 * die dieser Teil gebaut wurde.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schreibeZustandWennFrisch } from '../src/scheduled/strukturSuche.js';

/** Firestore-Attrappe: nur so viel, wie die Transaktion wirklich benutzt. */
const db = (standImDokument: string | undefined, geschrieben: unknown[] = []) =>
  ({
    runTransaction: async (fn: (tx: unknown) => Promise<boolean>) =>
      fn({
        get: async () => ({ get: (k: string) => (k === 'updatedAt' ? standImDokument : undefined) }),
        set: (_ref: unknown, daten: unknown) => geschrieben.push(daten),
      }),
  }) as unknown as FirebaseFirestore.Firestore;

const ref = {} as FirebaseFirestore.DocumentReference;
const zustand = { generation: 3, updatedAt: '2026-08-11T22:10:00Z' } as never;

describe('schreibeZustandWennFrisch', () => {
  it('schreibt, wenn niemand dazwischenkam', async () => {
    const raus: unknown[] = [];
    const ok = await schreibeZustandWennFrisch(
      db('2026-08-10T22:10:00Z', raus),
      ref,
      zustand,
      '2026-08-10T22:10:00Z',
    );
    expect(ok).toBe(true);
    expect(raus).toHaveLength(1);
  });

  it('schreibt NICHT, wenn ein anderer Lauf schneller war', async () => {
    const raus: unknown[] = [];
    const ok = await schreibeZustandWennFrisch(
      db('2026-08-11T22:11:00Z', raus),
      ref,
      zustand,
      '2026-08-10T22:10:00Z',
    );
    expect(ok).toBe(false);
    expect(raus).toHaveLength(0);
  });

  it('auch ein ÄLTERER Stand im Dokument blockt', async () => {
    /* Kein „neuer als"-Vergleich: Ein anderer Lauf hat auf einer anderen
     * Ausgangslage gerechnet, egal in welche Richtung die Uhr zeigt. Ein
     * Uhr-Versatz zwischen zwei Instanzen darf nicht dazu führen, dass einer
     * den anderen für veraltet hält. */
    const raus: unknown[] = [];
    const ok = await schreibeZustandWennFrisch(
      db('2026-08-01T00:00:00Z', raus),
      ref,
      zustand,
      '2026-08-10T22:10:00Z',
    );
    expect(ok).toBe(false);
  });

  it('ein Dokument ohne updatedAt gilt als verändert', async () => {
    const ok = await schreibeZustandWennFrisch(db(undefined), ref, zustand, '2026-08-10T22:10:00Z');
    expect(ok).toBe(false);
  });

  it('ein gelöschtes Dokument passt zu einem leeren Ausgangsstand', async () => {
    // Randfall, aber der richtige Ausgang: Beide Seiten sagen „hier war
    // nichts" — dann darf geschrieben werden.
    const raus: unknown[] = [];
    const ok = await schreibeZustandWennFrisch(db(undefined, raus), ref, zustand, undefined);
    expect(ok).toBe(true);
  });

  it('ein unbrauchbarer Wert im Feld gilt als verändert', async () => {
    const seltsam = {
      runTransaction: async (fn: (tx: unknown) => Promise<boolean>) =>
        fn({ get: async () => ({ get: () => 42 }), set: () => undefined }),
    } as unknown as FirebaseFirestore.Firestore;
    expect(await schreibeZustandWennFrisch(seltsam, ref, zustand, '2026-08-10T22:10:00Z')).toBe(
      false,
    );
  });
});

describe('Quelltext: die Reihenfolge stimmt', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'scheduled', 'strukturSuche.ts');
  const text = (): string => readFileSync(pfad, 'utf8');

  it('kein nacktes set auf den Suchzustand mehr', () => {
    // Solange es existiert, kann der Wettlauf über einen anderen Pfad
    // zurückkommen, ohne dass ein Test fällt.
    expect(text()).not.toContain('await stateRef.set(zustand)');
  });

  it('erst der Zustand, DANN die Schatten-Strategie', () => {
    /* Andersherum — so stand es hier — führe ein überholter Lauf den Schatten
     * auf einen Baum, den anschließend niemand mehr im Zustand hat. */
    const t = text();
    const wache = t.indexOf('schreibeZustandWennFrisch(db, stateRef, zustand, gelesenUpdatedAt)');
    const schatten = t.indexOf('await schreibeSchattenStrategie(userDoc.ref, zustand, watchlist, now);', wache);
    expect(wache).toBeGreaterThan(0);
    expect(schatten).toBeGreaterThan(wache);
  });

  it('ein überholter Lauf zählt keine Beförderung', () => {
    // Sonst meldete der Heartbeat Beförderungen, die im Dokument nie
    // ankamen — eine Sache, zwei Antworten.
    const t = text();
    const wache = t.indexOf('schreibeZustandWennFrisch(db, stateRef, zustand, gelesenUpdatedAt)');
    const zaehler = t.indexOf('befoerdert += 1;', wache);
    expect(zaehler).toBeGreaterThan(wache);
  });

  it('der Startpunkt wird mit create angelegt, nicht mit set', () => {
    /* Zwei gleichzeitige Läufe legten sonst beide eine Generation 0 an — der
     * zweite überschriebe den Startpunkt des ersten, und die
     * Schatten-Strategie zeigte auf einen dritten Baum. */
    expect(text()).toContain('await stateRef.create(zustand);');
  });

  it('auch der Seed-Verbrauch geht durch die Wache', () => {
    // Er schreibt nur einen Zähler, aber ein voller Überschreiber nimmt das
    // ganze Journal des anderen Laufs mit.
    const t = text();
    const ab = t.indexOf('zustand.seedZaehler += MAX_MUTATION_SEEDS;');
    expect(ab).toBeGreaterThan(0);
    expect(t.slice(ab, ab + 300)).toContain('schreibeZustandWennFrisch(');
  });
});
