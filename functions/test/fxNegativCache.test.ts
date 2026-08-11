/**
 * Audit-Befund 11.08. (D1): Der FX-Cache merkte sich Fehlschläge für immer.
 *
 * ── Was passierte ─────────────────────────────────────────────────────────
 *
 * `speicher.set(key, kurs)` lief auch mit `kurs === null` — und der
 * Prozess-Cache lebt so lange wie die Function-Instanz, also Minuten bis
 * Stunden. Ein einziger Aussetzer der Kurs-API (Timeout, 5xx, kurze
 * Netzstörung) reichte, damit ALLE Trades dieses Tages auf dieser Instanz
 * dauerhaft ohne `fxRate` gebucht wurden — auch dann noch, wenn die API eine
 * Sekunde später wieder lieferte.
 *
 * ── Warum das erst Monate später auffällt ─────────────────────────────────
 *
 * Ein fehlender Kurs blockiert nichts: Der Trade geht durch, nur die
 * fx-Felder fehlen. Sichtbar wird es beim Steuer-Export (`fxLuecken`) — und
 * dann ist der Kurs eines vergangenen Tages nur noch mit Handarbeit zu
 * beschaffen.
 *
 * ── Warum nicht einfach gar kein Negativ-Cache ────────────────────────────
 *
 * Weil ein Tag, den die API grundsätzlich nicht kennt, sonst bei JEDEM
 * Trade in acht Sekunden Timeout liefe. Im 5-Minuten-Scan mit mehreren
 * Konten wäre das der sichere Weg ins Funktions-Timeout — ein Fix, der einen
 * schlimmeren Fehler einbaut als den, den er behebt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FX_NEGATIV_MS, fxCacheDauerMs, fxCacheTreffer } from '../src/core/fx.js';
import type { FxKurs } from '../../shared/src/index.js';

const KURS: FxKurs = { date: '2026-08-11', rate: 1.09, source: 'ecb' };

describe('fxCacheDauerMs', () => {
  it('ein Kurs gilt unbegrenzt', () => {
    // Der EZB-Referenzkurs eines Tages ändert sich nicht mehr. Ihn erneut zu
    // holen wäre ein Netzaufruf ohne jeden Nutzen.
    expect(fxCacheDauerMs(KURS)).toBe(Number.POSITIVE_INFINITY);
  });

  it('ein Fehlschlag gilt kurz', () => {
    expect(fxCacheDauerMs(null)).toBe(FX_NEGATIV_MS);
    expect(FX_NEGATIV_MS).toBeLessThanOrEqual(60_000);
    expect(FX_NEGATIV_MS).toBeGreaterThan(0);
  });
});

describe('fxCacheTreffer', () => {
  it('ohne Eintrag muss geholt werden', () => {
    expect(fxCacheTreffer(undefined, 1_000)).toBe(undefined);
  });

  it('ein gültiger Kurs kommt aus dem Cache', () => {
    expect(fxCacheTreffer({ kurs: KURS, bis: Number.POSITIVE_INFINITY }, 9e15)).toBe(KURS);
  });

  it('ein frischer Fehlschlag bleibt ein Fehlschlag', () => {
    // Innerhalb des Fensters wird NICHT erneut gefragt — das ist der Zweck.
    expect(fxCacheTreffer({ kurs: null, bis: 60_000 }, 30_000)).toBe(null);
  });

  it('ein abgelaufener Fehlschlag wird neu geholt', () => {
    /* Der Kern des Befunds: Hier stand vorher dauerhaft `null`, und jeder
     * Trade des Tages ging ohne Kurs durch. */
    expect(fxCacheTreffer({ kurs: null, bis: 60_000 }, 60_000)).toBe(undefined);
    expect(fxCacheTreffer({ kurs: null, bis: 60_000 }, 999_000)).toBe(undefined);
  });

  it('genau auf der Ablaufgrenze wird neu geholt', () => {
    // Im Zweifel fragen: Ein überflüssiger Abruf kostet eine Anfrage, ein
    // übersehener Kurs kostet eine Zeile im Steuerbericht.
    expect(fxCacheTreffer({ kurs: null, bis: 500 }, 500)).toBe(undefined);
  });

  it('unterscheidet „null gespeichert" von „nichts gespeichert"', () => {
    // Beide führen zu einem Abruf, aber aus verschiedenen Gründen — und der
    // Unterschied ist genau das, was der alte Code nicht machen konnte:
    // `speicher.get()` lieferte in beiden Fällen etwas, das wie „kein Kurs"
    // aussah.
    expect(fxCacheTreffer({ kurs: null, bis: 1e12 }, 0)).toBe(null);
    expect(fxCacheTreffer(undefined, 0)).toBe(undefined);
  });
});

describe('Quelltext: der Abrufpfad benutzt die Ablaufzeit', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'core', 'fx.ts');

  it('kein nacktes speicher.set mit dem Kurs allein', () => {
    /* Genau diese Zeile war der Befund. Ohne diesen Test käme sie beim
     * nächsten Umbau zurück, und die vier Tests darüber blieben grün. */
    const text = readFileSync(pfad, 'utf8');
    expect(text).not.toContain('speicher.set(key, kurs);');
  });

  it('der Ablauf kommt aus fxCacheDauerMs, nicht aus einer Zahl im Code', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).toContain('bis: Date.now() + fxCacheDauerMs(kurs)');
  });

  it('das Lesen geht durch fxCacheTreffer', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).toContain('fxCacheTreffer(speicher.get(key), Date.now())');
  });

  it('ein Treffer aus Firestore gilt unbegrenzt', () => {
    // Er kommt aus dem dauerhaften Cache — ihn nach einer Minute wieder
    // verfallen zu lassen, wäre ein Firestore-Read je Minute und Tag ohne
    // jeden Erkenntnisgewinn.
    const text = readFileSync(pfad, 'utf8');
    expect(text).toContain('speicher.set(key, { kurs, bis: Number.POSITIVE_INFINITY })');
  });
});
