/**
 * ⓘ-Tips zweisprachig (Task #139, Tranche 5).
 *
 * Die Tips sind der größte Textbestand der App und bleiben deshalb in ihrem
 * eigenen Modul — zwei Records nebeneinander statt 140 Einträge im
 * allgemeinen Wörterbuch. Diese Tests pinnen die drei Eigenschaften, an
 * denen der Umbau scheitern könnte:
 *
 *   1. Der DEUTSCHE Bestand ist unverändert (Golden-Pins) — im DE-Modus
 *      rendert die App nachweislich dieselben Texte wie vorher.
 *   2. Der Fallback ist FELDWEISE: eine übersetzte Überschrift ohne
 *      übersetzten Fließtext zeigt Englisch oben, Deutsch unten — nie leer.
 *   3. `INFO_EN` erfindet keine Schlüssel (Karteileichen).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INFO, INFO_DE, INFO_EN, waehleTips, type Tip } from '../src/infotips';

const quelle = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/infotips.ts'),
  'utf8',
);

describe('Fallback-Regel der Tips (pur)', () => {
  const de: Record<string, Tip> = {
    a: { t: 'Titel A', d: 'Text A' },
    b: { t: 'Titel B', d: 'Text B' },
  };

  it('im DE-Modus kommt der deutsche Record unverändert zurück', () => {
    expect(waehleTips(de, { a: { t: 'Title A' } }, 'de')).toBe(de);
  });

  it('FELDWEISER Fallback: übersetzte Überschrift, deutscher Fließtext', () => {
    const out = waehleTips(de, { a: { t: 'Title A' } }, 'en');
    expect(out['a']).toEqual({ t: 'Title A', d: 'Text A' });
  });

  it('fehlender EN-Eintrag fällt komplett auf Deutsch zurück — nie leer', () => {
    const out = waehleTips(de, { a: { t: 'Title A' } }, 'en');
    expect(out['b']).toEqual({ t: 'Titel B', d: 'Text B' });
  });

  it('leere EN-Strings zählen als „fehlt"', () => {
    const out = waehleTips(de, { a: { t: '', d: '' } }, 'en');
    expect(out['a']).toEqual({ t: 'Titel A', d: 'Text A' });
  });

  it('jede DE-ID überlebt die Übersetzung — kein Tip verschwindet', () => {
    const out = waehleTips(INFO_DE, INFO_EN, 'en');
    expect(Object.keys(out).sort()).toEqual(Object.keys(INFO_DE).sort());
    for (const [id, tip] of Object.entries(out)) {
      expect(tip.t.length, `Überschrift von „${id}" ist leer`).toBeGreaterThan(0);
      expect(tip.d.length, `Text von „${id}" ist leer`).toBeGreaterThan(0);
    }
  });
});

describe('Wörterbuch-Hygiene der Tips', () => {
  it('INFO_EN kennt keine Karteileichen — jede ID existiert in INFO_DE', () => {
    for (const id of Object.keys(INFO_EN)) {
      expect(Object.hasOwn(INFO_DE, id), `EN-Tip „${id}" fehlt in INFO_DE`).toBe(true);
    }
  });

  it('kein deutscher Tip ist leer — INFO_DE ist die Quelle der Wahrheit', () => {
    for (const [id, tip] of Object.entries(INFO_DE)) {
      expect(tip.t.length, `Überschrift von „${id}" ist leer`).toBeGreaterThan(0);
      expect(tip.d.length, `Text von „${id}" ist leer`).toBeGreaterThan(0);
    }
  });

  it('INFO ist im Testlauf (kein localStorage-Stub) die deutsche Fassung', () => {
    // Standard ist 'de' — auch ohne localStorage (s. sprachWahl).
    expect(INFO).toBe(INFO_DE);
  });
});

describe('Golden-Wächter — die deutschen Tips sind byte-gleich zum Bestand', () => {
  it('Überschriften der übersetzten Häppchen unverändert', () => {
    expect(INFO_DE['riskPerTrade']?.t).toBe('Risiko je Trade');
    expect(INFO_DE['maxOpenPositions']?.t).toBe('Max. gleichzeitige Positionen');
    expect(INFO_DE['corePct']?.t).toBe('Ruhiger Sockel %');
    expect(INFO_DE['leverage']?.t).toBe('Hebel (Margin)');
    expect(INFO_DE['exits']?.t).toBe('Warum geschlossen');
    expect(INFO_DE['stopLoss']?.t).toBe('Stop-Loss');
    expect(INFO_DE['takeProfit']?.t).toBe('Take-Profit');
    expect(INFO_DE['trailingStop']?.t).toBe('Nachziehender Stop (Trailing-Stop)');
    expect(INFO_DE['maxHold']?.t).toBe('Maximale Haltedauer');
    expect(INFO_DE['atrStop']?.t).toBe('ATR-Stop (volatilitätsadaptiv)');
    expect(INFO_DE['atrTake']?.t).toBe('ATR-Ziel');
  });

  it('Kernaussagen der langen Texte unverändert', () => {
    expect(INFO_DE['stopLoss']?.d).toContain('Automatische Verkaufs-Reißleine');
    expect(INFO_DE['riskPerTrade']?.d).toContain('wie viel darf ich verlieren, wenn der Stop greift');
    expect(INFO_DE['corePct']?.d).toContain('200-Tage-Schnitt');
    expect(INFO_DE['leverage']?.d).toContain('Margin-Call');
    expect(INFO_DE['atrStop']?.d).toContain('Typisch: 1,5–3');
  });

  it('der ⓘ-Knopf zieht seine Attribut-Texte über t() (Anschluss-Wächter)', () => {
    // Die Tip-INHALTE stehen hier im Modul, aber die beiden Attribute des
    // Knopfes gehören ins allgemeine Wörterbuch — sonst bliebe der
    // Screenreader-Text auch im EN-Modus deutsch.
    expect(quelle).toContain("uebersetzt('tip.erklaerung')");
    expect(quelle).toContain("uebersetzt('tip.wasBedeutet')");
    expect(quelle).not.toContain('aria-label="Erklärung:');
    expect(quelle).not.toContain('title="Was bedeutet das?"');
    // Die Auswahl passiert zur Modul-Ladezeit aus der gespeicherten Wahl.
    expect(quelle).toContain('waehleTips(INFO_DE, INFO_EN, sprachWahl())');
  });

  it('die englischen Fassungen tragen die Broker-Fachbegriffe', () => {
    expect(INFO_EN['stopLoss']?.t).toBe('Stop loss');
    expect(INFO_EN['takeProfit']?.t).toBe('Take profit');
    expect(INFO_EN['trailingStop']?.t).toBe('Trailing stop');
    expect(INFO_EN['leverage']?.d).toContain('margin call');
    // Häppchen 5b: Signale, Takt und Schutzschalter.
    expect(INFO_EN['rsiBuy']?.t).toBe('RSI buy threshold');
    expect(INFO_EN['minConfluence']?.t).toBe('Confluence for the entry');
    expect(INFO_EN['cooldownMin']?.d).toContain('whipsaw');
    expect(INFO_EN['minEdgeMultiple']?.d).toContain('square root of the holding period');
    expect(INFO_EN['dailyLossLimit']?.d).toContain('it blocks ENTRIES');
    expect(INFO_EN['regimeGate']?.d).toContain('200-day average');
    expect(INFO_EN['allowShort']?.d).toContain('theoretically unlimited');
  });

  it('Häppchen 5b: die deutschen Vorlagen sind byte-gleich geblieben', () => {
    expect(INFO_DE['rsiBuy']?.t).toBe('RSI-Kaufschwelle');
    expect(INFO_DE['rsiSell']?.t).toBe('RSI-Verkaufsschwelle');
    expect(INFO_DE['konfluenz']?.t).toBe('Minimale Konfluenz');
    expect(INFO_DE['minConfluence']?.t).toBe('Konfluenz für den Einstieg');
    expect(INFO_DE['exitConfluence']?.t).toBe('Konfluenz für den Ausstieg');
    expect(INFO_DE['signalTimeframe']?.t).toBe('Signal-Zeitrahmen');
    expect(INFO_DE['cooldownMin']?.t).toBe('Kauf-Pause nach Verkauf');
    expect(INFO_DE['minEdgeMultiple']?.t).toBe('Kostenschwelle');
    expect(INFO_DE['dailyLossLimit']?.t).toBe('Tages-Notbremse');
    expect(INFO_DE['flattenOnBreach']?.t).toBe('Bei Notbremse glattstellen');
    expect(INFO_DE['regimeGate']?.t).toBe('Markt-Ampel');
    expect(INFO_DE['newsVeto']?.t).toBe('News-Veto');
    expect(INFO_DE['allowShort']?.t).toBe('Shorten (Leerverkäufe)');
    expect(INFO_DE['minEdgeMultiple']?.d).toContain('Wurzel aus der Haltedauer');
    expect(INFO_DE['dailyLossLimit']?.d).toContain('Sie sperrt EINSTIEGE');
  });
});
