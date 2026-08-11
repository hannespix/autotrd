/**
 * Audit-Befund 11.08. (C3): Der Asset-Cache lag in EINEM Dokument.
 *
 * ── Warum das heute unauffällig ist und morgen bricht ─────────────────────
 *
 * `meta/alpacaAssets` trug ein Feld je Symbol. Bei den 166 Katalog-Symbolen
 * sind das etwa 30 KB. Der laufende Umbau zieht das gesamte Alpaca-Universum
 * in die Rangliste — über 11.000 handelbare Papiere. Bei rund 180 Byte je
 * Eintrag reißt das Dokument die harte 1-MB-Grenze von Firestore.
 *
 * Was dann passiert, ist das eigentlich Böse: Der Schreibvorgang scheitert,
 * der `.catch` macht daraus eine Warnung, und der Cache friert auf dem Stand
 * ein, den er zufällig gerade hatte. Jedes neue Symbol geht ab da bei JEDEM
 * Scan live an Alpaca. Langsamer, teurer, und die einzige Spur ist eine
 * Logzeile unter tausenden.
 *
 * ── Was der Fix nebenbei einspart ────────────────────────────────────────
 *
 * Firestore rechnet je gelesenem DOKUMENT. Vorher las jede einzelne
 * Symbol-Abfrage das ganze Dokument — bei 1 MB ein teurer Read für ein Feld.
 * Jetzt wandert beim Lesen der KOMPLETTE Shard in die Prozess-Map: Ein Scan
 * über hunderte Symbole trifft höchstens 16 Dokumente statt hunderter.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSET_SHARDS,
  SCHREIBWEISE_V,
  assetShard,
  assetShardPfad,
  feldZuStand,
} from '../src/core/orderRouting.js';
import { allSymbols } from '../../shared/src/index.js';

describe('assetShard', () => {
  it('liefert immer einen gültigen Shard', () => {
    for (const sym of allSymbols()) {
      const s = assetShard(sym);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(ASSET_SHARDS);
    }
  });

  it('ist STABIL — dasselbe Symbol landet immer im selben Shard', () => {
    /* Die eigentliche Anforderung. Wanderte ein Symbol zwischen zwei Läufen,
     * läge sein Eintrag im alten Shard und würde nie mehr gefunden: Der
     * Cache verlöre still seine Wirkung, und niemand sähe es — es würde
     * einfach immer live gefragt. */
    for (const sym of ['AAPL', 'BRK.B', 'BTCUSD', '^GSPC', 'X']) {
      expect(assetShard(sym)).toBe(assetShard(sym));
    }
    // Feste Erwartungen, damit ein geänderter Hash auffällt statt
    // durchzurutschen.
    expect(assetShardPfad('AAPL')).toBe(`meta/alpacaAssets_${assetShard('AAPL')}`);
  });

  it('verteilt den Katalog halbwegs gleichmäßig', () => {
    /* Ein Präfix nach Anfangsbuchstaben täte das NICHT — „A" und „S" tragen
     * ein Vielfaches von „X", und ein einzelner überfüllter Shard hätte
     * genau dasselbe Größenproblem wie vorher das eine Dokument. */
    const zaehler = new Array<number>(ASSET_SHARDS).fill(0);
    for (const sym of allSymbols()) zaehler[assetShard(sym)] = (zaehler[assetShard(sym)] ?? 0) + 1;
    const schnitt = allSymbols().length / ASSET_SHARDS;
    for (const n of zaehler) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(schnitt * 3);
    }
  });

  it('unterscheidet ähnliche Symbole', () => {
    // Ein Hash, der Reihenfolge ignoriert, würfe „ABC" und „CBA" zusammen —
    // harmlos für die Korrektheit, aber ein Zeichen für einen schwachen Hash.
    const alle = new Set(['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'].map((s) => assetShard(s)));
    expect(alle.size).toBeGreaterThan(1);
  });

  it('ein leeres Symbol wirft nicht', () => {
    expect(assetShard('')).toBeGreaterThanOrEqual(0);
  });
});

describe('feldZuStand', () => {
  const jetzt = Date.parse('2026-08-11T12:00:00Z');
  const vor = (h: number): string => new Date(jetzt - h * 3_600_000).toISOString();

  it('macht aus einer Zusage einen bekannten Stand', () => {
    const stand = feldZuStand(
      'AAPL',
      { bekannt: true, at: vor(1), tradable: true, fractionable: true, shortable: false },
      jetzt,
    );
    expect(stand).toEqual({
      art: 'bekannt',
      asset: {
        symbol: 'AAPL',
        tradable: true,
        fractionable: true,
        shortable: false,
        easyToBorrow: false,
        marginable: false,
      },
    });
  });

  it('macht aus einer frischen Absage „fehlt"', () => {
    expect(feldZuStand('^GSPC', { bekannt: false, at: vor(1), v: SCHREIBWEISE_V }, jetzt)).toEqual({
      art: 'fehlt',
    });
  });

  it('verwirft eine Absage aus ÄLTERER Schreibweise', () => {
    /* `bekannt: false` heißt nicht „gibt es nicht", sondern „auf DIESE Frage
     * kam 404". Lernt `zuAlpacaSymbol` eine Schreibweise dazu, beantwortet
     * der alte Eintrag eine Frage, die wir nicht mehr stellen — und
     * blockierte sonst bis morgen jeden Einstieg. */
    expect(feldZuStand('BRK.B', { bekannt: false, at: vor(1), v: SCHREIBWEISE_V - 1 }, jetzt)).toBe(
      null,
    );
  });

  it('behält eine ZUSAGE aus älterer Schreibweise', () => {
    // Was Alpaca einmal kannte, kennt es weiter. Nur Absagen hängen an ihrer
    // Fragestellung.
    expect(feldZuStand('AAPL', { bekannt: true, at: vor(1), v: 1 }, jetzt)).toMatchObject({
      art: 'bekannt',
    });
  });

  it('verwirft alles über 24 Stunden', () => {
    expect(feldZuStand('AAPL', { bekannt: true, at: vor(25) }, jetzt)).toBe(null);
  });

  it('verwirft auch einen Eintrag weit aus der Zukunft', () => {
    // Uhr-Versatz oder ein von Hand gesetztes Feld. Ein Eintrag, der noch
    // ein Jahr „frisch" bliebe, wäre schlimmer als keiner.
    expect(feldZuStand('AAPL', { bekannt: true, at: vor(-48) }, jetzt)).toBe(null);
  });

  it('verwirft Müll, statt daraus etwas abzuleiten', () => {
    for (const roh of [null, undefined, 'ja', 42, {}, { bekannt: true }, { at: 'gestern' }]) {
      expect(feldZuStand('AAPL', roh, jetzt), JSON.stringify(roh)).toBe(null);
    }
  });

  it('fehlende Eigenschaften gelten als NICHT erlaubt', () => {
    // Die vorsichtige Richtung: Ein fehlendes `shortable` darf nicht als
    // „darf leerverkauft werden" durchgehen.
    const stand = feldZuStand('AAPL', { bekannt: true, at: vor(1) }, jetzt);
    expect(stand).toMatchObject({
      asset: { tradable: false, fractionable: false, shortable: false },
    });
  });
});

describe('Quelltext: der Cache benutzt die Shards', () => {
  const pfad = join(import.meta.dirname, '..', 'src', 'core', 'orderRouting.ts');

  it('gelesen und geschrieben wird im Shard, nicht im alten Sammel-Dokument', () => {
    const text = readFileSync(pfad, 'utf8');
    expect(text).toContain('getFirestore().doc(assetShardPfad(symbol))');
    expect(text).not.toContain("doc('meta/alpacaAssets')");
  });

  it('der ganze Shard wandert in die Prozess-Map, nicht nur ein Feld', () => {
    /* Ohne das wäre der Umbau ein reiner Größen-Fix und ließe die Kosten, wo
     * sie waren: ein Firestore-Read je Symbol-Abfrage. */
    const text = readFileSync(pfad, 'utf8');
    const ab = text.indexOf('getFirestore().doc(assetShardPfad(symbol))');
    const block = text.slice(ab, text.indexOf('Stufe 3', ab));
    expect(block).toContain('for (const [sym, roh] of Object.entries(daten))');
    expect(block).toContain('assetCache.set(sym,');
  });
});
