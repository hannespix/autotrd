/**
 * SECREVIEW3 — G3/K1: `brokerVerbindungLesend` (brokerZugang.ts L224-263) liefert bei einem LESEFEHLER
 * (Firestore nicht erreichbar, Admin-SDK nicht initialisiert) dasselbe wie bei „kein Broker hinterlegt":
 * `null`. Es merkt sich den Fehler zwar (`verbindungUnlesbar`), aber `brokerZugang` reicht nur `null`
 * weiter — und der Takt (tick.ts, Schritt 3) behandelt `null` als `kein_broker`: Der Nutzer wird
 * übersprungen UND seine Kommandos werden verworfen (`discardCommandsWithoutBroker`, Spiegel „Kommando
 * … verworfen — kein Broker verbunden"). Ein vorübergehender Firestore-Fehler frisst so ein `flatten`
 * oder `halt` des Nutzers — eine Sperre für Exits, ausgelöst durch die Infrastruktur, nicht durch die Ursache.
 *
 * Gegenbeispiel ohne Mock: Ohne initialisiertes Admin-SDK wirft `getFirestore()` — der Lesepfad meldet
 * „unlesbar", `brokerZugang` trotzdem „kein Broker".
 * Dieser Test SCHLÄGT FEHL, solange der Bug existiert.
 */
import { describe, expect, it } from 'vitest';
import { brokerZugang, verbindungUnlesbar } from '../../src/core/brokerZugang.ts';

describe('secreview3: Lesefehler beim Broker-Doc gilt als „kein Broker"', () => {
  it('brokerZugang muss einen Lesefehler als Fehler melden, nicht als null (⇒ Kommandos verworfen)', async () => {
    const ergebnis = await brokerZugang('u1', 1).then(
      (z) => ({ zugang: z, fehler: null as unknown }),
      (e: unknown) => ({ zugang: undefined, fehler: e }),
    );
    expect(verbindungUnlesbar('u1'), 'der Lesepfad hat den Fehler erkannt').toBe(true);
    expect(ergebnis.zugang, 'Lesefehler wird zu „kein Broker" (null) — der Takt überspringt den Nutzer und verwirft seine Kommandos').not.toBeNull();
  });
});
