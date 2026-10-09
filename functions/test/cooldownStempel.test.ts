/**
 * Quelltext-Wächter (Task 26, Red-Team-Fund 09.10.): Die Kauf-Pause wird
 * nach JEDEM Engine-Ausstieg gestempelt — nicht nur nach Risiko-Exits.
 *
 * Vorher stempelten nur der Broker-Stop-Fill und die Risk-Exit-Schleife
 * `engineCooldowns[symbol]`. Die vier Signal-Ausstiege (Engine-Sell,
 * Engine-Cover, Strategie-Sell, Strategie-Cover) stempelten nichts: Nach
 * einem Signal-Verkauf durfte dasselbe Symbol im nächsten 5-Minuten-Scan
 * sofort wieder gekauft werden — die Einstellung „Kauf-Pause nach Verkauf"
 * galt dort schlicht nicht. Das ist Verdrahtung, keine Funktion; deshalb
 * prüft dieser Wächter den Quelltext, Zweig für Zweig.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const scan = readFileSync(join(hier, '../src/scheduled/scanMarket.ts'), 'utf8');

/** Der Block vom Positions-Löschen bis zur Log-Zeile des Zweigs. */
function zweig(logStart: string): string {
  const ende = scan.indexOf(logStart);
  expect(ende, `Zweig „${logStart}" fehlt`).toBeGreaterThan(-1);
  const start = scan.lastIndexOf('positions.delete(symbol);', ende);
  expect(start).toBeGreaterThan(-1);
  return scan.slice(start, ende);
}

describe('Kauf-Pause nach jedem Engine-Ausstieg', () => {
  it.each([
    'logger.info(`Engine-Sell ',
    'logger.info(`Engine-Cover ',
    'logger.info(`Strategie-Sell ',
    'logger.info(`Strategie-Cover ',
  ])('%s stempelt engineCooldowns im Lauf UND im Firestore-Update', (log) => {
    const z = zweig(log);
    expect(z).toContain('engineCooldowns[symbol] = now.toISOString();');
    expect(z).toContain("cooldownUpdates.push(new FieldPath('engineCooldowns', symbol), now.toISOString());");
    // Und der Block ist klein — kein zweiter Zweig dazwischen.
    expect(z.length).toBeLessThan(900);
  });

  it('insgesamt sechs Stempel: zwei Risiko-Pfade (Broker-Stop, Risk-Exit) + vier Signal-Pfade', () => {
    const n = scan.split('engineCooldowns[symbol] = now.toISOString();').length - 1;
    expect(n).toBe(6);
  });

  it('die Einstiege prüfen weiterhin denselben Stempel (sonst wäre er wirkungslos)', () => {
    const n = scan.split('cooldownActive(engineCooldowns[symbol], now, cdMin)').length - 1;
    expect(n).toBeGreaterThanOrEqual(4);
  });
});
