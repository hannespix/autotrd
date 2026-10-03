/**
 * Wächter der Feldmaske in der Admin-Liste (Emulator-Befund 21.08.).
 *
 * `Query.select(...)` ist eine **Maske**: Was nicht drinsteht, liefert
 * `snap.get(feld)` als `undefined` — ohne Fehler, ohne Warnung, ohne
 * Typfehler. Genau so verschwand die Abgleich-Sperre aus der Admin-Ansicht:
 * `risk.abgleich` stand im Dokument, wurde unten gelesen, war aber nicht
 * projiziert. Die Anzeige war stumm; der Quelltext sah richtig aus, und die
 * Wächter, die nur Aufrufe prüfen, waren grün.
 *
 * Dieser Wächter kann diese Klasse Fehler sehen, weil er BEIDE Listen liest
 * und gegeneinander hält: jedes gelesene Feld muss von der Maske gedeckt
 * sein — entweder exakt oder über einen Präfix (`wallet` deckt
 * `wallet.paperBalance`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'callable', 'admin.ts'), 'utf8');

/** Der `list`-Zweig — nur dort wirkt die Maske. */
function listBlock(s: string): string {
  return s.slice(s.indexOf("if (action === 'list')"), s.indexOf("if (action === 'abgleich')"));
}

function maske(blk: string): string[] {
  const m = /\.select\(([\s\S]*?)\)\s*\n\s*\.limit\(/.exec(blk);
  if (!m) throw new Error('kein .select(...) vor .limit(...) gefunden');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

function gelesen(blk: string): string[] {
  return [...new Set([...blk.matchAll(/\bd\.get\(\s*'([^']+)'/g)].map((x) => x[1]!))];
}

const gedeckt = (feld: string, m: readonly string[]): boolean =>
  m.some((s) => feld === s || feld.startsWith(`${s}.`));

describe('Admin-Liste: was gelesen wird, muss projiziert sein', () => {
  it('jedes d.get(...) im list-Zweig ist von select(...) gedeckt', () => {
    const blk = listBlock(quelle());
    const m = maske(blk);
    const fehlend = gelesen(blk).filter((f) => !gedeckt(f, m));
    expect(fehlend).toEqual([]);
  });

  it('die Sperr-Anzeige ist konkret gedeckt — sie war der Anlass', () => {
    /* Ohne diese Zeile liefert `d.get('risk.abgleich')` still `undefined`,
     * `abgleichZeile` gibt `null` zurück, und die Admin-Ansicht behauptet
     * „kein Abgleich-Problem" für ein Konto, das gesperrt ist. Im Emulator
     * nachgestellt: Vermerk mit `fehlbestand: 3` im Dokument, Antwort der
     * Function `abgleich: null`. */
    const blk = listBlock(quelle());
    expect(gedeckt('risk.abgleich', maske(blk))).toBe(true);
    expect(blk).toContain("abgleich: abgleichZeile(d.get('risk.abgleich'), jetzt)");
  });

  it('die Maske deckt nichts ab, was gar nicht gelesen wird', () => {
    /* Andersherum ist es kein Fehler, aber ein Hinweis auf Reste: Wer ein
     * Feld projiziert und nie liest, holt Daten ohne Zweck über die
     * Leitung. `accessLevel` geht über `d.data()` statt `d.get()` und ist
     * deshalb ausgenommen. */
    const blk = listBlock(quelle());
    const liest = gelesen(blk);
    const ungenutzt = maske(blk).filter(
      (s) => s !== 'accessLevel' && !liest.some((f) => f === s || f.startsWith(`${s}.`)),
    );
    expect(ungenutzt).toEqual([]);
  });
});
