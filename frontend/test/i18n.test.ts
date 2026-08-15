/**
 * Sprachumschalter Phase 0 (Task #139) — die Fallback-Regel ist das Fundament.
 *
 * Deutsch ist die Quelle der Wahrheit; Englisch darf lücken, aber nie
 * erfinden. Der Golden-Wächter pinnt zusätzlich die bisherigen deutschen
 * Login-Texte: Im DE-Modus rendert die App nachweislich EXAKT dieselben
 * Texte wie vor dem Umbau — damit ist „kaputtmachen" strukturell
 * ausgeschlossen (Owner: „ich mag auf keinen Fall irgendwas kaputt machen").
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DE, EN, sprachWahl, uebersetze, type TextSchluessel } from '../src/i18n.js';

const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
const auth = readFileSync(join(import.meta.dirname, '..', 'src', 'auth.ts'), 'utf8');
const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');

describe('die Fallback-Regel — fehlendes Englisch zeigt Deutsch, nie Lücken', () => {
  it('fehlender EN-Eintrag fällt auf den deutschen Text zurück', () => {
    expect(uebersetze('login.anmelden', 'en', {})).toBe(DE['login.anmelden']);
    // Auch ein leerer String zählt als „fehlt" — niemals nichts anzeigen.
    expect(uebersetze('login.anmelden', 'en', { 'login.anmelden': '' })).toBe(
      DE['login.anmelden'],
    );
  });

  it('vorhandener EN-Eintrag gewinnt im EN-Modus', () => {
    expect(uebersetze('login.anmelden', 'en')).toBe('Sign in');
  });

  it('im DE-Modus zählt IMMER das deutsche Wörterbuch', () => {
    for (const k of Object.keys(DE) as TextSchluessel[]) {
      expect(uebersetze(k, 'de')).toBe(DE[k]);
    }
  });
});

describe('Wörterbuch-Hygiene', () => {
  it('EN kennt keine Karteileichen — jeder Schlüssel existiert in DE', () => {
    for (const k of Object.keys(EN)) {
      expect(Object.hasOwn(DE, k), `EN-Schlüssel „${k}" fehlt in DE`).toBe(true);
    }
  });

  it('kein deutscher Text ist leer — DE ist die Quelle der Wahrheit', () => {
    for (const [k, v] of Object.entries(DE)) {
      expect(v.length, `DE-Schlüssel „${k}" ist leer`).toBeGreaterThan(0);
    }
  });
});

describe('Sprachwahl', () => {
  it("Standard ist 'de' — auch ohne localStorage oder mit Unsinn darin", () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
    });
    expect(sprachWahl()).toBe('de');
    vi.stubGlobal('localStorage', {
      getItem: () => 'quatsch',
    });
    expect(sprachWahl()).toBe('de');
    vi.stubGlobal('localStorage', {
      getItem: () => 'en',
    });
    expect(sprachWahl()).toBe('en');
    vi.unstubAllGlobals();
  });
});

describe('Golden-Wächter — im DE-Modus exakt die bisherigen Texte', () => {
  it('die deutschen Login-Texte sind byte-gleich zum Stand vor dem Umbau', () => {
    expect(DE['login.email']).toBe('E-Mail');
    expect(DE['login.passwort']).toBe('Passwort');
    expect(DE['login.anmelden']).toBe('Anmelden');
    expect(DE['login.registrieren']).toBe('Registrieren');
    expect(DE['login.passwortVergessen']).toBe('Passwort vergessen?');
    expect(DE['login.oder']).toBe('oder');
    expect(DE['login.mitGoogle']).toBe('Mit Google anmelden');
    expect(DE['login.emailFehlt']).toBe('Bitte oben die E-Mail-Adresse eintragen.');
    expect(DE['auth.falscheDaten']).toBe('E-Mail oder Passwort ist falsch.');
    expect(DE['auth.fehlgeschlagen']).toBe('Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
  });

  it('Tranche 2: die deutschen Optionen-Anzeige-Texte sind byte-gleich zum Bestand', () => {
    // Mehrzeilige Template-Literale wurden auf EINE Zeile normalisiert —
    // HTML kollabiert Whitespace, gerendert ist das identisch.
    expect(DE['opt.titel']).toBe('Optionen');
    expect(DE['opt.tabAnzeige']).toBe('Anzeige');
    expect(DE['opt.tabBroker']).toBe('Broker &amp; Echtgeld');
    expect(DE['opt.tabKonto']).toBe('Konto &amp; Steuer');
    expect(DE['opt.darstellung']).toBe('Darstellung');
    expect(DE['opt.hellDunkel']).toBe(
      '<b>Hell/Dunkel</b> — „System" folgt automatisch deiner Geräte-Einstellung; Hell/Dunkel stellt fest um.',
    );
    expect(DE['opt.themeSystem']).toBe('System');
    expect(DE['opt.themeHell']).toBe('Hell');
    expect(DE['opt.themeDunkel']).toBe('Dunkel');
    expect(DE['opt.optionaleElemente']).toBe('Optionale Elemente');
    expect(DE['opt.prognosePfeil']).toBe(
      '<b>Prognose-Pfeil</b> — eigene Kurs-Erwartung im Chart einzeichnen; zählt als gewichtete Stimme im Auto-Trading. <i>Beta, standardmäßig aus.</i>',
    );
    expect(DE['opt.vergleichsOverlay']).toBe(
      '<b>Vergleichs-Overlay</b> — zweites Symbol als %-Linie im Haupt-Chart.',
    );
    expect(DE['opt.multiChartRaster']).toBe(
      '<b>Multi-Chart-Raster</b> — 1/2/4 Charts parallel mit Lock-Sync.',
    );
    expect(DE['opt.module']).toBe('Module');
    expect(DE['opt.marktgruppen']).toBe('Marktgruppen');
    expect(DE['opt.moduleHint']).toContain('Abgewählte Module verschwinden komplett');
    expect(DE['opt.marktgruppenHint']).toContain('nur Anzeige — die Daten aller Gruppen');
  });

  it('Tranche 3a: die deutschen Trading-Tab-Texte sind byte-gleich zum Bestand', () => {
    expect(DE['opt.paperWallet']).toBe('Paper-Wallet · Grundeinstellungen');
    expect(DE['opt.kapitalPosition']).toBe('Kapital &amp; Positionsgröße');
    expect(DE['opt.startkapital']).toBe('Startkapital $');
    expect(DE['opt.investmentJeTrade']).toBe('Investment je Trade %');
    expect(DE['opt.risikoJeTrade']).toBe('Risiko je Trade %');
    expect(DE['opt.maxPositionen']).toBe('Max. gleichzeitige Positionen');
    expect(DE['opt.ruhigerSockel']).toBe('Ruhiger Sockel %');
    expect(DE['opt.hebel']).toBe('Hebel (Margin)');
    expect(DE['opt.hebel1']).toBe('1× — kein Hebel (Standard)');
    expect(DE['opt.hebel2']).toBe('2× — nur bei sehr starkem Signal');
    expect(DE['opt.hebel3']).toBe('3× — Maximum');
    expect(DE['opt.ausstiege']).toBe('Ausstiege');
    expect(DE['opt.stopLoss']).toBe('Stop-Loss %');
    expect(DE['opt.takeProfit']).toBe('Take-Profit %');
    expect(DE['opt.trailing']).toBe('Nachziehender Stop %');
    expect(DE['opt.maxHalte']).toBe('Max. Haltedauer (Tage)');
    expect(DE['opt.atrStop']).toBe('ATR-Stop (×ATR)');
    expect(DE['opt.atrZiel']).toBe('ATR-Ziel (×ATR)');
    expect(DE['opt.signaleTakt']).toBe('Signale &amp; Takt');
    expect(DE['opt.signalZeitrahmen']).toBe('Signal-Zeitrahmen');
    expect(DE['opt.tf5m']).toBe('5-Minuten (aktiv)');
    expect(DE['opt.tfDaily']).toBe('Tageskerzen (ruhig)');
    expect(DE['opt.kaufPause']).toBe('Kauf-Pause nach Verkauf (Min)');
    expect(DE['opt.konfluenzEinstieg']).toBe('Konfluenz Einstieg');
    expect(DE['opt.konfluenzAusstieg']).toBe('Konfluenz Ausstieg');
    expect(DE['opt.schutzschalter']).toBe('Schutzschalter');
    expect(DE['opt.kostenschwelle']).toBe('Kostenschwelle (× Gebühren)');
    expect(DE['opt.tagesNotbremsePct']).toBe('Tages-Notbremse (% Verlust)');
    expect(DE['opt.flatten']).toBe('Bei Notbremse zusätzlich alle Positionen schließen');
    expect(DE['opt.regimeGate']).toBe('Markt-Ampel (keine Shorts im Aufwärtstrend, Pause bei Stress)');
    expect(DE['opt.newsVeto']).toBe('News-Veto (Einstiege bei harten Events aussetzen)');
    expect(DE['opt.experimente']).toBe('Experimente');
    expect(DE['opt.shorten']).toBe('Shorten erlauben (Leerverkäufe)');
    expect(DE['opt.klassenKapital']).toBe('Kapital je Anlageklasse');
    expect(DE['opt.autoNachregeln']).toBe('Automatisch nachregeln (täglich, in Schritten von 0,25)');
    expect(DE['opt.vorschlagUebernehmen']).toBe('Vorschlag übernehmen');
    expect(DE['opt.speichern']).toBe('Speichern');
    expect(DE['opt.einstellungenPruefen']).toBe('Einstellungen prüfen');
    expect(DE['opt.jetztPruefen']).toBe('Jetzt prüfen');
    expect(DE['opt.ausgewaehlteUebernehmen']).toBe('Ausgewählte übernehmen');
    expect(DE['opt.loadouts']).toBe('Loadouts');
    expect(DE['opt.uebernehmen']).toBe('Übernehmen');
    expect(DE['opt.loName']).toBe('Aktuellen (gespeicherten) Stand sichern als …');
    expect(DE['opt.alsLoadoutSpeichern']).toBe('Als Loadout speichern');
    expect(DE['opt.bewaehrt']).toBe('Bewährte Einstellungen');
    expect(DE['opt.lade']).toBe('Lade …');
    expect(DE['opt.unterschiedeAnsehen']).toBe('Unterschiede ansehen');
    expect(DE['opt.notbremse']).toBe('Tages-Notbremse');
    expect(DE['opt.notbremseLoesen']).toBe('Notbremse lösen');
    // Lange Hints: Kernaussagen pinnen (mehrzeilige Literale wurden auf
    // eine Zeile normalisiert — HTML kollabiert Whitespace).
    expect(DE['opt.startkapitalHint']).toContain('ändert deinen aktuellen Kontostand');
    expect(DE['opt.nullSchaltetAb']).toContain('0 schaltet eine Regel ab');
    expect(DE['opt.klassenHint']).toContain('steuert nur den <b>Einstieg</b>');
    expect(DE['opt.klassenHint']).toContain('von Hand gesetzte Werte halten dauerhaft nur');
    expect(DE['opt.loadoutsHint']).toContain('bleiben <b>immer</b> deine');
  });

  it('Tranche 3b: die deutschen Broker/Konto-Tab-Texte sind byte-gleich zum Bestand', () => {
    expect(DE['opt.echtgeldAnbindung']).toBe('Echtgeld-Anbindung');
    expect(DE['opt.verbinden']).toBe('Verbinden');
    expect(DE['opt.pwPlatzhalter']).toBe('Dein autotrd-Passwort zur Bestätigung');
    expect(DE['opt.linkKonto']).toBe('1. Konto anlegen');
    expect(DE['opt.linkKeys']).toBe('2. Paper-Dashboard → API-Keys erzeugen');
    expect(DE['opt.linkDoku']).toBe('Dokumentation');
    expect(DE['opt.verbindungPruefen']).toBe('Verbindung prüfen');
    expect(DE['opt.trennen']).toBe('Trennen');
    expect(DE['opt.depotUebernehmen']).toBe('Depot vom Broker übernehmen');
    expect(DE['opt.scharfStellen']).toBe('Echtgeld scharf stellen');
    expect(DE['opt.pwKurz']).toBe('Dein Passwort');
    expect(DE['opt.aufEchtgeld']).toBe('Auf ECHTGELD umstellen');
    expect(DE['opt.zurueckPapier']).toBe('Zurück auf Papierhandel');
    expect(DE['opt.konto']).toBe('Konto');
    expect(DE['opt.angemeldetAls']).toBe('Angemeldet als');
    expect(DE['opt.abmelden']).toBe('Abmelden');
    expect(DE['opt.steuerExport']).toBe('Steuer-Export');
    expect(DE['opt.nurEchtgeld']).toBe('nur Echtgeld');
    expect(DE['opt.berichtErstellen']).toBe('Bericht erstellen');
    expect(DE['opt.neuAnfangen']).toBe('Neu anfangen');
    expect(DE['opt.resetTippen']).toBe('RESET tippen');
    expect(DE['opt.kontoZuruecksetzen']).toBe('Konto zurücksetzen');
    expect(DE['opt.startVomBroker']).toBe(
      'Startkapital vom verbundenen Broker übernehmen (statt der Zahl oben)',
    );
    // Lange Hints: Kernaussagen pinnen.
    expect(DE['opt.brokerHint']).toContain('<b>ohne zu handeln</b>');
    expect(DE['opt.liveKeyWarnung']).toContain('<b>Gehandelt wird damit nicht:</b>');
    expect(DE['opt.depotUebernehmenHint']).toContain('<b>es wird nichts gekauft oder verkauft</b>');
    expect(DE['opt.echtgeldWarnung']).toContain('<b>Ab jetzt fließt echtes Geld.</b>');
    expect(DE['opt.stoppWasPassiert']).toContain('<b>ungeschütztes</b> Konto');
    expect(DE['opt.steuerHint']).toContain('<b>FIFO</b>');
    expect(DE['opt.resetHint']).toContain('Nicht rückgängig zu machen.');
  });

  it('die Bestätigungs-Wörter RESET und ECHTGELD bleiben in JEDER Sprache wörtlich', () => {
    // Serverseitig gepinnt (RESET_CONFIRM_WORD bzw. setLiveMode) — eine
    // Übersetzung des Tipp-Worts würde die Bestätigung unmöglich machen.
    expect(DE['opt.resetTippen']).toContain('RESET');
    expect(EN['opt.resetTippen']).toContain('RESET');
    expect(DE['opt.echtgeldTippen']).toContain('ECHTGELD');
    expect(EN['opt.echtgeldTippen']).toContain('ECHTGELD');
    expect(DE['opt.aufEchtgeld']).toContain('ECHTGELD');
    expect(EN['opt.aufEchtgeld']).toContain('ECHTGELD');
    expect(EN['opt.scharfHint']).toContain('ECHTGELD');
    // Die Eingabefeld-Platzhalter der Wörter selbst bleiben unübersetzt.
    expect(dashboard).toContain('placeholder="ECHTGELD"');
  });

  it('Tranche 1: die deutschen Kopfleisten-Texte sind byte-gleich zum Bestand', () => {
    expect(DE['nav.engineAus']).toBe('Engine aus');
    expect(DE['nav.engineAn']).toBe('Engine an');
    expect(DE['nav.panelLinks']).toBe('Linkes Panel');
    expect(DE['nav.panelRechts']).toBe('Rechtes Panel');
    expect(DE['nav.optionenTitle']).toBe('Optionen: Elemente, Module & Paper-Wallet');
    expect(DE['nav.tourTitle']).toBe('Tour: die wichtigsten Bereiche in einer Minute');
    expect(DE['nav.spalteLinks']).toBe('Linke Spalte ein-/ausblenden');
    expect(DE['nav.spalteRechts']).toBe('Rechte Spalte ein-/ausblenden');
  });
});

describe('Anschluss-Wächter — die Funktion ist verdrahtet, nicht nur vorhanden', () => {
  it('renderLogin zieht seine Texte über t()', () => {
    for (const k of [
      "t('login.sub')",
      "t('login.anmelden')",
      "t('login.mitGoogle')",
      "t('login.emailFehlt')",
    ]) {
      expect(main).toContain(k);
    }
    // Kein hartkodierter Rest der übersetzten Texte im Template.
    expect(main).not.toContain('>Anmelden<');
    expect(main).not.toContain('>Mit Google anmelden<');
  });

  it('authErrorMessage übersetzt über t()', () => {
    expect(auth).toContain("t('auth.falscheDaten')");
    expect(auth).toContain("t('auth.fehlgeschlagen')");
  });

  it('die Kopfleiste zieht ihre Texte über t() — Badge inklusive Umschalter', () => {
    for (const k of [
      "t('nav.panelLinks')",
      "t('nav.panelRechts')",
      "t('nav.engineAus')",
      "t('nav.optionenTitle')",
      "t('nav.tourTitle')",
      "t('nav.spalteLinks')",
      "t('nav.spalteRechts')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Der dynamische Badge-Umschalter (renderEngineBadge) übersetzt BEIDE
    // Zustände — sonst spränge das Badge beim Engine-Start zurück auf Deutsch.
    expect(dashboard).toContain("running ? t('nav.engineAn') : t('nav.engineAus')");
    // Keine hartkodierten Reste in der Kopfleiste.
    expect(dashboard).not.toContain('>Engine aus</div>');
    expect(dashboard).not.toContain('aria-label="Linkes Panel"');
  });

  it('der Optionen-Tab „Anzeige" zieht seine Texte über t()', () => {
    for (const k of [
      "t('opt.titel')",
      "t('opt.tabAnzeige')",
      "t('opt.tabBroker')",
      "t('opt.darstellung')",
      "t('opt.hellDunkel')",
      "t('opt.themeSystem')",
      "t('opt.sprache')",
      "t('opt.optionaleElemente')",
      "t('opt.prognosePfeil')",
      "t('opt.indikatorExtras')",
      "t('opt.module')",
      "t('opt.moduleHint')",
      "t('opt.marktgruppen')",
      "t('opt.marktgruppenHint')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Keine hartkodierten Reste der übersetzten Region im Template.
    expect(dashboard).not.toContain('<h3>Optionen</h3>');
    expect(dashboard).not.toContain('data-otab="anzeige">Anzeige<');
    expect(dashboard).not.toContain('<b>Prognose-Pfeil</b> — eigene Kurs-Erwartung im Chart einzeichnen;\n');
    // Sprachnamen bleiben unübersetzt — jede Sprache in ihrem eigenen Namen.
    expect(dashboard).toContain('<option value="de">Deutsch</option>');
    expect(dashboard).toContain('<option value="en">English</option>');
  });

  it('der Optionen-Tab „Trading" zieht seine Texte über t()', () => {
    for (const k of [
      "t('opt.paperWallet')",
      "t('opt.startkapitalHint')",
      "t('opt.kapitalPosition')",
      "t('opt.startkapital')",
      "t('opt.hebel1')",
      "t('opt.ausstiege')",
      "t('opt.signaleTakt')",
      "t('opt.tf5m')",
      "t('opt.schutzschalter')",
      "t('opt.flatten')",
      "t('opt.shorten')",
      "t('opt.nullSchaltetAb')",
      "t('opt.klassenKapital')",
      "t('opt.klassenHint')",
      "t('opt.autoNachregeln')",
      "t('opt.speichern')",
      "t('opt.jetztPruefen')",
      "t('opt.loadoutsHint')",
      "t('opt.loName')",
      "t('opt.bewaehrt')",
      "t('opt.notbremseLoesen')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Keine hartkodierten Reste der übersetzten Region im Template.
    expect(dashboard).not.toContain('>Paper-Wallet · Grundeinstellungen<');
    expect(dashboard).not.toContain('<option value="1">1× — kein Hebel (Standard)</option>');
    expect(dashboard).not.toContain('id="owSave">Speichern<');
    expect(dashboard).not.toContain('id="bkrReset">Notbremse lösen<');
  });

  it('die Optionen-Tabs „Broker" und „Konto" ziehen ihre Texte über t()', () => {
    for (const k of [
      "t('opt.echtgeldAnbindung')",
      "t('opt.brokerHint')",
      "t('opt.verbinden')",
      "t('opt.liveKeyWarnung')",
      "t('opt.pwPlatzhalter')",
      "t('opt.pkAkHint')",
      "t('opt.linkKonto')",
      "t('opt.depotUebernehmen')",
      "t('opt.depotUebernehmenHint')",
      "t('opt.scharfStellen')",
      "t('opt.echtgeldWarnung')",
      "t('opt.echtgeldTippen')",
      "t('opt.aufEchtgeld')",
      "t('opt.stoppWasPassiert')",
      "t('opt.konto')",
      "t('opt.angemeldetAls')",
      "t('opt.abmelden')",
      "t('opt.steuerExport')",
      "t('opt.steuerHint')",
      "t('opt.neuAnfangen')",
      "t('opt.resetTippen')",
      "t('opt.kontoZuruecksetzen')",
      "t('opt.startVomBroker')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Keine hartkodierten Reste der übersetzten Region im Template.
    expect(dashboard).not.toContain('id="bkSave">Verbinden<');
    expect(dashboard).not.toContain('id="bkAdopt">Depot vom Broker übernehmen<');
    expect(dashboard).not.toContain('id="logoutBtn">Abmelden<');
    expect(dashboard).not.toContain('placeholder="RESET tippen"');
    // Der E-Mail-Einschub bleibt escaped hinter dem übersetzten Präfix.
    expect(dashboard).toContain("${t('opt.angemeldetAls')} <b>${email.replace(/[<>&]/g, '')}</b>");
  });

  it('die Sprachwahl sitzt in Optionen → Anzeige und wird angewandt', () => {
    const anzeige = dashboard.indexOf('data-opane="anzeige"');
    const select = dashboard.indexOf('id="ouLang"');
    expect(select, '#ouLang fehlt').toBeGreaterThan(anzeige);
    expect(dashboard.slice(select, select + 300)).toContain('value="de"');
    expect(dashboard.slice(select, select + 300)).toContain('value="en"');
    expect(dashboard).toContain("setzeSprache(ouLang.value === 'en' ? 'en' : 'de');");
  });
});
