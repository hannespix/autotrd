/**
 * Owner-Feedback 11.08.: „Marken überdecken zu viel wichtiger Infos."
 *
 * ── Was auf dem Bildschirm stand ──────────────────────────────────────────
 *
 * Auf dem Telefon lagen drei graue Kästen — `52W-Hoch`, `52W-Tief` und vor
 * allem `Pivot · ATR 5,4 %` — mitten im Kursverlauf, und zwar am RECHTEN
 * Rand: genau dort, wo die jüngsten Kerzen stehen. Bei GLD verdeckte der
 * Pivot-Kasten allein rund ein Drittel der Chartbreite auf Höhe des
 * aktuellen Kurses.
 *
 * ── Die Regel gab es schon ────────────────────────────────────────────────
 *
 * Im Kopf von `PriceLineSpec` steht seit dem 04.08., mit demselben
 * Owner-Wortlaut:
 *
 *   „Text am rechten Rand der Linie. Sparsam einsetzen: Er steht IM Chart
 *    und verdeckt Kurs — meist sagt schon das Achsen-Label alles
 *    (Owner 04.08.: „überlagert zu viel Info")."
 *
 * R1 und S1 befolgen sie (`axisLabel: false`, kein Titel). Die drei Marken
 * darüber taten es nicht — dieselbe Fehlerfamilie wie im Backend: Eine Regel
 * ist aufgeschrieben und gilt nur im Normalfall.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quelle = (): string =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('Marken-Titel: schmal schweigen, breit kurz fassen', () => {
  it('jeder Marken-Titel läuft durch die Breiten-Prüfung', () => {
    const text = quelle();
    const ab = text.indexOf('function markenLinien(');
    expect(ab, 'markenLinien nicht gefunden').toBeGreaterThan(0);
    const bis = text.indexOf('function positionsLinien(', ab);
    const block = text.slice(ab, bis);
    // Kein `title:` mehr, das nicht durch markenTitel geht.
    for (const zeile of block.split('\n')) {
      if (!/\btitle:/.test(zeile)) continue;
      expect(zeile, `ungefilterter Titel: ${zeile.trim()}`).toContain('markenTitel(');
    }
  });

  it('drei Marken tragen Titel, R1 und S1 weiterhin keinen', () => {
    const text = quelle();
    const ab = text.indexOf('function markenLinien(');
    const bis = text.indexOf('function positionsLinien(', ab);
    const block = text.slice(ab, bis);
    expect((block.match(/markenTitel\(/g) ?? []).length).toBe(3);
    // R1/S1 waren schon vorher stumm — der Fix darf das nicht umdrehen.
    for (const key of ['mk:r1', 'mk:s1']) {
      const zeile = block.split('\n').find((z) => z.includes(key));
      expect(zeile, `${key} nicht gefunden`).toBeDefined();
      expect(zeile).not.toContain('title:');
      expect(zeile, `${key} soll auch kein Achsen-Label belegen`).toContain('axisLabel: false');
    }
  });

  it('die Titel sind kurz — kein „52W-Hoch" mehr', () => {
    const text = quelle();
    const ab = text.indexOf('function markenLinien(');
    const bis = text.indexOf('function positionsLinien(', ab);
    // Ab der ersten Marken-Zeile — der erklärende Kommentar davor nennt die
    // alten Titel absichtlich, und `return []` gibt es weiter oben als Guard.
    const code = text.slice(text.indexOf("{ key: 'mk:52h'", ab), bis);
    expect(code).not.toContain('52W-Hoch');
    expect(code).not.toContain('52W-Tief');
    expect(code).toContain("markenTitel('52W ↑')");
    expect(code).toContain("markenTitel('52W ↓')");
  });

  it('das ATR bleibt am Pivot — es geht nicht verloren', () => {
    // Der Owner wollte weniger Überdeckung, nicht weniger Information. Auf
    // breiten Schirmen war nie zu wenig Platz.
    const text = quelle();
    const ab = text.indexOf('function markenLinien(');
    const bis = text.indexOf('function positionsLinien(', ab);
    expect(text.slice(ab, bis)).toContain('Pivot · ATR ${atr.toFixed(1)} %');
  });

  it('markenTitel liefert einen leeren String, kein undefined', () => {
    // `PriceLineSpec.title` ist unter `exactOptionalPropertyTypes` ein
    // `string`; die Chart-Schicht setzt `spec.title ?? ''`. Leer IST dort
    // „kein Text" — `undefined` wäre ein Typfehler.
    const text = quelle();
    const ab = text.indexOf('function markenTitel(');
    expect(ab).toBeGreaterThan(0);
    const block = text.slice(ab, text.indexOf('}', ab) + 1);
    expect(block).toContain('): string {');
    expect(block).toContain("? text : ''");
  });

  it('die Schwelle ist dieselbe wie beim OHLC-HUD', () => {
    // Eine Schwelle im ganzen Dashboard, nicht zwei, die auseinanderlaufen.
    const text = quelle();
    const treffer = /const MARKEN_TEXT_AB_PX = (\d+);/.exec(text);
    expect(treffer, 'MARKEN_TEXT_AB_PX nicht gefunden').not.toBeNull();
    expect(text).toContain(`window.innerWidth > ${Number(treffer![1]) as number}`);
  });
});
