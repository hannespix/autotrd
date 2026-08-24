/**
 * Konto-Löschung (Owner-Frage 24.08.: „gesperrte Konten löschen … sonst
 * kommt es zu einer Vermüllung der Datenbank" — Entscheidung: BEIDES, Archiv
 * UND ein echter, unumkehrbarer Löschanspruch).
 *
 * `pruefeLoeschVorbedingungen` ist die reine Entscheidung — pur gegen
 * konstruierte Eingaben testbar, ohne Firestore. Die Reihenfolge in
 * `loescheKonto` (Marker → Broker → Audit → recursiveDelete → deleteUser)
 * und die Verdrahtung in `admin.ts` (Bestätigungswort → Quota → Ziel-Prüfung
 * → loescheKonto) sind Quelltext-Wächter — derselbe Grund wie bei
 * `orderRaeumung.test.ts`: Eine Entscheidung, die niemand in der richtigen
 * Reihenfolge aufruft, sieht aus wie Schutz und ist keiner.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAILY_DELETE_LIMIT,
  DELETE_CONFIRM_WORD,
  LOESCHUNG_MIN_TAGE,
  pruefeLoeschVorbedingungen,
} from '../src/core/kontoLoeschung.js';

const JETZT = new Date('2026-08-24T12:00:00Z');
const vorTagen = (tage: number): string =>
  new Date(JETZT.getTime() - tage * 86_400_000).toISOString();

const basis = {
  zielAdmin: false,
  zielDaten: { accessLevel: 'archiviert', accessChangedAt: vorTagen(LOESCHUNG_MIN_TAGE + 1) },
  jetzt: JETZT,
  hatPositionen: false,
  hatUnbookedFills: false,
  liveBrokerVerbunden: false,
};

describe('pruefeLoeschVorbedingungen — der gute Fall geht durch', () => {
  it('archiviert, alt genug, alles leer — kein Wurf', () => {
    expect(() => pruefeLoeschVorbedingungen(basis)).not.toThrow();
  });

  it('blocked ist ebenso löschbar wie archiviert', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: { accessLevel: 'blocked', accessChangedAt: vorTagen(LOESCHUNG_MIN_TAGE + 1) },
      }),
    ).not.toThrow();
  });

  it('genau an der Grenze (LOESCHUNG_MIN_TAGE + etwas) geht noch durch', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: { accessLevel: 'blocked', accessChangedAt: vorTagen(LOESCHUNG_MIN_TAGE + 0.001) },
      }),
    ).not.toThrow();
  });
});

describe('pruefeLoeschVorbedingungen — jede der zehn Bedingungen blockiert einzeln', () => {
  it('ein Admin-Ziel ist tabu — auch wenn es sonst alles erfüllt', () => {
    expect(() => pruefeLoeschVorbedingungen({ ...basis, zielAdmin: true })).toThrow(
      /adminNichtLoeschbar/,
    );
  });

  it('pending ist nicht löschbar', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: { accessLevel: 'pending', accessChangedAt: vorTagen(999) },
      }),
    ).toThrow(/nurGesperrteArchivierteLoeschbar/);
  });

  it('approved ist nicht löschbar — auch nicht mit uraltem Zeitstempel', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: { accessLevel: 'approved', accessChangedAt: vorTagen(999) },
      }),
    ).toThrow(/nurGesperrteArchivierteLoeschbar/);
  });

  it('fehlendes accessLevel gilt als approved (accessLevelOf) — also nicht löschbar', () => {
    // Bestandskonten/Owner: fehlendes Feld = approved (shared/src/zugang.ts).
    // Ein Konto OHNE das Feld darf niemals über diesen Pfad verschwinden.
    expect(() =>
      pruefeLoeschVorbedingungen({ ...basis, zielDaten: { accessChangedAt: vorTagen(999) } }),
    ).toThrow(/nurGesperrteArchivierteLoeschbar/);
  });

  it('fehlender Zeitstempel blockiert — „unbekannt" ist NICHT „alt genug"', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({ ...basis, zielDaten: { accessLevel: 'archiviert' } }),
    ).toThrow(/loeschAlterUnbekannt/);
  });

  it('kaputter Zeitstempel blockiert ebenso', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: { accessLevel: 'archiviert', accessChangedAt: 'nicht-lesbar' },
      }),
    ).toThrow(/loeschAlterUnbekannt/);
  });

  it('zu kurz gesperrt/archiviert blockiert', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: { accessLevel: 'archiviert', accessChangedAt: vorTagen(LOESCHUNG_MIN_TAGE - 1) },
      }),
    ).toThrow(new RegExp(`loeschWartezeit\\|${LOESCHUNG_MIN_TAGE}`));
  });

  it('ein laufender Reset/Adopt (frischer Marker) blockiert', () => {
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: {
          ...basis.zielDaten,
          risk: { resetLaeuftSeit: new Date(JETZT.getTime() - 60_000).toISOString() },
        },
      }),
    ).toThrow(/kontoGeradeInBearbeitung/);
  });

  it('ein VERFALLENER Marker (älter als RESET_SPERRE_MIN) blockiert NICHT mehr', () => {
    // Derselbe Selbstauflösungs-Mechanismus wie beim Reset — ein
    // abgestürzter Lauf darf ein Konto nicht dauerhaft stilllegen.
    expect(() =>
      pruefeLoeschVorbedingungen({
        ...basis,
        zielDaten: {
          ...basis.zielDaten,
          risk: { resetLaeuftSeit: new Date(JETZT.getTime() - 20 * 60_000).toISOString() },
        },
      }),
    ).not.toThrow();
  });

  it('offene Positionen blockieren', () => {
    expect(() => pruefeLoeschVorbedingungen({ ...basis, hatPositionen: true })).toThrow(
      /nochOffenePositionen/,
    );
  });

  it('ungebuchte Fills blockieren — dort liegt echtes, ungebuchtes Geld', () => {
    expect(() => pruefeLoeschVorbedingungen({ ...basis, hatUnbookedFills: true })).toThrow(
      /nochUngebuchteFills/,
    );
  });

  it('eine LIVE-Broker-Verbindung blockiert — Echtgeld wird nie automatisch angefasst', () => {
    expect(() => pruefeLoeschVorbedingungen({ ...basis, liveBrokerVerbunden: true })).toThrow(
      /liveVerbindungVorLoeschung/,
    );
  });
});

describe('Konstanten — strenger als der Reset, nicht laxer', () => {
  it('DAILY_DELETE_LIMIT ist niedriger als resetWallet (5/Tag) — nicht umkehrbar', () => {
    expect(DAILY_DELETE_LIMIT).toBeLessThan(5);
    expect(DAILY_DELETE_LIMIT).toBeGreaterThan(0);
  });

  it('LOESCHUNG_MIN_TAGE ist eine echte Karenzzeit, keine Formsache', () => {
    expect(LOESCHUNG_MIN_TAGE).toBeGreaterThanOrEqual(7);
  });

  it('das Bestätigungswort ist nicht leer und nicht das Reset-Wort', () => {
    expect(DELETE_CONFIRM_WORD.length).toBeGreaterThan(3);
    expect(DELETE_CONFIRM_WORD).not.toBe('RESET');
  });
});

/* ── Quelltext-Wächter: die Reihenfolge, nicht nur die Entscheidung ──────── */

describe('Quelltext: loescheKonto hält die einzig sichere Reihenfolge', () => {
  const text = readFileSync(
    join(import.meta.dirname, '..', 'src', 'core', 'kontoLoeschung.ts'),
    'utf8',
  );

  it('Vorbedingungen VOR dem Marker, Marker VOR dem Broker-Aufräumen', () => {
    const vorbed = text.indexOf('pruefeLoeschVorbedingungen({');
    const marker = text.indexOf("update(new FieldPath('risk', 'resetLaeuftSeit')");
    const broker = text.indexOf('await trenneBroker(target)');
    expect(vorbed, 'Vorbedingungs-Prüfung fehlt').toBeGreaterThan(0);
    expect(marker, 'Marker-Setzen fehlt').toBeGreaterThan(vorbed);
    expect(broker, 'trenneBroker-Aufruf fehlt').toBeGreaterThan(marker);
  });

  it('Audit-Eintrag NACH dem Broker-Aufräumen, VOR recursiveDelete', () => {
    const broker = text.indexOf('await trenneBroker(target)');
    const audit = text.indexOf("collection('adminAuditLog').add(");
    const del = text.indexOf('await db.recursiveDelete(targetRef)');
    expect(audit, 'Audit-Eintrag fehlt').toBeGreaterThan(broker);
    expect(del, 'recursiveDelete fehlt').toBeGreaterThan(audit);
  });

  it('Auth-Löschung NACH recursiveDelete, nicht davor', () => {
    // Reihenfolge ist Absicht (Modul-Kopf): Ein bereits gültiges Token
    // könnte sonst bis zum Ablauf noch auf ein halb gelöschtes Firestore-
    // Dokument schreiben.
    const del = text.indexOf('await db.recursiveDelete(targetRef)');
    const authDel = text.indexOf('getAuth().deleteUser(target)');
    expect(authDel).toBeGreaterThan(del);
  });

  it('das Audit-Dokument liegt AUSSERHALB des Ziel-Baums (Top-Level-Collection)', () => {
    expect(text).toContain("db.collection('adminAuditLog').add(");
    expect(text).not.toContain("targetRef.collection('adminAuditLog')");
  });

  it('der Cache wird verworfen, BEVOR die Live-Verbindung geprüft wird', () => {
    const vergiss = text.indexOf('vergissVerbindung(target)');
    const brokerDoc = text.indexOf("db.doc(`users/${target}/private/broker`)");
    expect(vergiss, 'vergissVerbindung fehlt').toBeGreaterThan(0);
    expect(brokerDoc).toBeGreaterThan(vergiss);
  });
});

describe('Quelltext: admin.ts prüft Bestätigung und Quota VOR der Löschung', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'src', 'callable', 'admin.ts'), 'utf8');
  // Enger Ausschnitt NUR des delete-Zweigs: Die vorherige Grenze
  // (`action === 'setAdmin'`) lag mehrere Aktionen weiter unten und spannte
  // auch 'abgleich'/'uebernahmeVormerken'/… mit auf — deren eigene
  // `targetRef()`-Aufrufe machten den Wächter blind für ein FEHLENDES
  // `targetRef()` in DIESEM Zweig (Sabotage-Probe 24.08.). `return
  // ergebnis;` ist die letzte Zeile vor der schließenden Klammer.
  const ab = text.indexOf("if (action === 'delete') {");
  const bis = text.indexOf('return ergebnis;', ab) + 'return ergebnis;'.length;
  const block = text.slice(ab, bis);

  it("action === 'delete' existiert und der Ausschnitt ist eng genug", () => {
    expect(ab, "action 'delete' fehlt").toBeGreaterThan(0);
    expect(bis).toBeGreaterThan(ab);
    // Kein fremder Aktions-Zweig darf im Ausschnitt liegen — sonst misst
    // ein Test hier wieder fremde targetRef()/Quota-Aufrufe mit.
    expect(block).not.toContain("if (action === 'setAdmin')");
    expect(block).not.toContain("if (action === 'abgleich')");
  });

  it('exakte Anweisung: confirm-Wort-Prüfung als eigene if-Zeile', () => {
    // `toContain` auf die GENAUE Zeile statt eine Teilzeichenkette wie
    // `'confirm !== DELETE_CONFIRM_WORD'` — Letztere bliebe grün, selbst
    // wenn die Bedingung mit `false &&` neutralisiert würde (Sabotage-Probe
    // 24.08.: genau das blieb mit der alten Fassung unentdeckt).
    expect(block).toContain('if (confirm !== DELETE_CONFIRM_WORD) {');
  });

  it('exakte Anweisung: Quota-Verbrauch als eigener Aufruf', () => {
    expect(block).toContain("await consumeQuota(uid, 'adminDelete', DAILY_DELETE_LIMIT)");
  });

  it('Reihenfolge: confirm vor Quota vor targetRef() vor loescheKonto', () => {
    const confirm = block.indexOf('if (confirm !== DELETE_CONFIRM_WORD) {');
    const quota = block.indexOf("consumeQuota(uid, 'adminDelete'");
    const zielPruefung = block.indexOf('targetRef();');
    const aufruf = block.indexOf('await loescheKonto(');
    expect(confirm).toBeGreaterThan(-1);
    expect(quota).toBeGreaterThan(confirm);
    expect(zielPruefung, 'targetRef()-Aufruf fehlt — dieselbe Prüfung wie jede andere Aktion')
      .toBeGreaterThan(quota);
    expect(aufruf).toBeGreaterThan(zielPruefung);
  });
});
