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

  it('Tranche 4: die deutschen Panel-Titel sind byte-gleich zum Bestand', () => {
    expect(DE['panel.strategie']).toBe('Strategie');
    expect(DE['panel.engine']).toBe('Engine');
    expect(DE['panel.historie']).toBe('Trade-Historie');
    expect(DE['panel.journal']).toBe('Trade-Journal');
    expect(DE['panel.chart']).toBe('Chart');
    expect(DE['panel.chartKopf']).toBe('Chart · Candlestick + Volumen');
    expect(DE['panel.indikatorKacheln']).toBe('Indikator-Kacheln');
    expect(DE['panel.autoSignale']).toBe('Auto-Signale');
    expect(DE['panel.positionen']).toBe('Positionen');
    expect(DE['panel.positionenKopf']).toBe('Aktive Positionen');
    expect(DE['panel.markt']).toBe('Markt-Übersicht');
    expect(DE['panel.performance']).toBe('Performance');
    expect(DE['panel.manuellerTrade']).toBe('Manueller Trade');
    expect(DE['panel.marktUhr']).toBe('Markt-Uhr');
    expect(DE['panel.marktUhrKopf']).toBe('Markt-Uhr (ET)');
    expect(DE['panel.prognoseGenauigkeit']).toBe('Prognose-Genauigkeit');
    expect(DE['panel.prognoseLabor']).toBe('Prognose-Labor');
    expect(DE['panel.momentum']).toBe('Momentum-Ranking');
    expect(DE['panel.autoTuner']).toBe('Auto-Tuner');
    expect(DE['panel.struktursuche']).toBe('Struktursuche');
    expect(DE['panel.vergleichsChart']).toBe('Vergleichs-Chart');
    expect(DE['panel.haltedauer']).toBe('Wie lange halten?');
    expect(DE['panel.erkenntnisse']).toBe('Was das System gelernt hat');
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

  it('Panel-Titel: Registry UND Karten-Köpfe ziehen über t() — dieselben Schlüssel', () => {
    // Die Registry (Modul-Checkboxen, Palette) …
    for (const k of [
      "strategy: t('panel.strategie')",
      "sigcards: t('panel.indikatorKacheln')",
      "chart2: t('panel.vergleichsChart')",
    ]) {
      expect(dashboard).toContain(k);
    }
    // … und die Karten-Köpfe im Layout (auch die Sonder-Fassungen).
    for (const k of [
      "data-panel=\"history\"><div class=\"sect\">${t('panel.historie')}",
      "data-panel=\"chart\"><div class=\"sect\">${t('panel.chartKopf')}",
      "data-panel=\"positions\"><div class=\"sect\">${t('panel.positionenKopf')}",
      "data-panel=\"clock\"><div class=\"sect\">${t('panel.marktUhrKopf')}",
      "data-panel=\"erkenntnisse\"><div class=\"sect\">${t('panel.erkenntnisse')}",
    ]) {
      expect(dashboard).toContain(k);
    }
    // Keine hartkodierten Reste in Registry oder Köpfen.
    expect(dashboard).not.toContain("history: 'Trade-Historie'");
    expect(dashboard).not.toContain('class="sect">Trade-Historie');
    expect(dashboard).not.toContain('class="sect">Aktive Positionen');
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

describe('Onboarding-Tour ist zweisprachig (Tranche 5d)', () => {
  const tourQuelle = readFileSync(join(import.meta.dirname, '..', 'src', 'tour.ts'), 'utf8');

  it('kein deutscher Literaltext mehr im Tour-Modul', () => {
    /* Die Tour ist der EINZIGE Text, den ein neuer Nutzer sieht, bevor er
     * irgendetwas anderes gesehen hat — sie startet beim ersten Login von
     * selbst. Ausgerechnet dort deutsche Knöpfe zu zeigen, hieße: Die
     * Sprachwahl greift überall, nur nicht in der Einführung. */
    expect(tourQuelle).not.toContain('>Zurück<');
    expect(tourQuelle).not.toContain("'Fertig'");
    expect(tourQuelle).not.toContain("'Weiter'");
    expect(tourQuelle).not.toContain("'Einführungstour'");
    expect(tourQuelle).not.toContain('aria-label="Tour beenden"');
    expect(tourQuelle).toContain("t('tour.zurueck')");
    expect(tourQuelle).toContain("t('tour.fertig')");
    expect(tourQuelle).toContain("t('tour.beenden')");
    expect(tourQuelle).toContain("t('tour.aria')");
  });

  it('die sechs Stationen ziehen Titel UND Text über t()', () => {
    const block = dashboard.slice(
      dashboard.indexOf('const TOUR_STATIONEN = ['),
      dashboard.indexOf('function starteAppTour'),
    );
    for (const s of ['strategie', 'chart', 'engine', 'performance', 'optionen', 'engineWhy']) {
      expect(block, `Station ${s}: Titel fehlt`).toContain(`t('tour.${s}Titel')`);
      expect(block, `Station ${s}: Text fehlt`).toContain(`t('tour.${s}Text')`);
    }
    // Kein Rest-Literal: der Block enthält außer den Selektoren keinen Satz.
    expect(block).not.toMatch(/titel: '[^']/);
    expect(block).not.toMatch(/text:\s*\n?\s*'[^']/);
  });

  it('jede Tour-Station hat eine englische Fassung', () => {
    // Ein deutscher Fallback wäre hier besonders teuer: Die Tour erklärt die
    // App, und eine unverständliche Erklärung ist schlimmer als keine.
    for (const k of Object.keys(DE).filter((s) => s.startsWith('tour.'))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Teilbare Ergebnis-Grafik ist zweisprachig (Tranche 5e)', () => {
  const karte = readFileSync(join(import.meta.dirname, '..', 'src', 'shareCard.ts'), 'utf8');
  const aussage = readFileSync(join(import.meta.dirname, '..', 'src', 'shareAussage.ts'), 'utf8');
  const pruefstand = readFileSync(join(import.meta.dirname, '..', 'e2e', 'share-shot.mjs'), 'utf8');

  it('kein deutscher Literaltext mehr in der Karte', () => {
    /* Diese Grafik VERLÄSST die App. Deutsche Beschriftung auf einem Bild,
     * das ein englischsprachiger Nutzer in seine Zeitleiste stellt, ist für
     * genau das Publikum unlesbar, dem er sie zeigt. */
    for (const rest of [
      "'PAPIERKONTO'",
      "'ECHTGELD'",
      '>MEIN DEPOT<',
      '>WOMIT<',
      "'Trefferquote'",
      "'Max-Drawdown'",
      "'Schwächstes'",
      'Noch zu wenige Tage',
      'Automatisierter Handel',
    ]) {
      expect(karte, `Restliteral: ${rest}`).not.toContain(rest);
    }
    expect(karte).toContain("t('share.siegelPapier')");
    expect(karte).toContain("t('share.kopf')");
  });

  it('auch die Aussage-Zeilen laufen über t()', () => {
    for (const rest of [
      "'Zeitraum unbekannt'",
      'Beträge ausgeblendet`',
      "'Noch keine abgeschlossenen Trades'",
      'noch keine Tageskurve`',
    ]) {
      expect(aussage, `Restliteral: ${rest}`).not.toContain(rest);
    }
    expect(aussage).toContain("t('share.keineTrades')");
  });

  it('jede share.*-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => s.startsWith('share.'))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });

  it('der Siegel-Kasten wächst mit dem Wort — keine feste Breite mehr', () => {
    /* Der Bild-Prüfstand meldete beim Übersetzen: „PAPER ACCOUNT" misst
     * 228 px im 232-px-Kasten, also 2 px Luft je Seite. Das Siegel ist der
     * eine Text dieser Karte, der nicht verhandelbar ist — klebt er am
     * Rahmen, liest sich das wie ein Darstellungsfehler, auf einem Bild in
     * fremden Zeitleisten. Eine feste Breite kann das nächste Wort wieder
     * sprengen; die abgeleitete kann es nicht. */
    expect(karte).toContain('function siegelBreite(');
    expect(karte).toContain('siegelBreite(siegel)');
    expect(karte).not.toContain('width="232"');
  });

  it('der Bild-Prüfstand misst BEIDE Sprachen und das Siegel im Rahmen', () => {
    /* Ein Prüfstand, der die geänderte Sache nicht messen kann, bescheinigt
     * Fehlerfreiheit, die er nie gesehen hat (CLAUDE.md §6). Vor dieser
     * Tranche rendert er nur Deutsch und verglich nur <text> gegen <text> —
     * beides hätte den Siegel-Überlauf durchgelassen. */
    expect(pruefstand).toContain("for (const sprache of ['de', 'en'])");
    expect(pruefstand).toContain('autotrd-lang');
    expect(pruefstand).toContain('siegelRaus');
    expect(pruefstand).toContain('data-rolle="siegelRahmen"');
  });
});

describe('Chart-Werkzeugleiste ist zweisprachig (Tranche 5f)', () => {
  /* Der Block zwischen der Chart-Karte und dem Vergleichs-Chart. Er wird
   * hier ZUR LAUFZEIT abgegrenzt statt über feste Zeilennummern: Ein
   * Wächter, der an Zeile 728 hängt, prüft nach der nächsten Einfügung
   * irgendetwas anderes und meldet trotzdem grün. */
  const block = dashboard.slice(
    dashboard.indexOf('data-panel="chart"'),
    dashboard.indexOf('data-panel="chart2"'),
  );
  const chartQuelle = readFileSync(join(import.meta.dirname, '..', 'src', 'chart.ts'), 'utf8');

  it('der Block ist überhaupt gefunden worden', () => {
    // Ohne diese Zeile wäre ein leerer Block ein grüner Test — die
    // bequemste Art, sich Fehlerfreiheit zu bescheinigen.
    expect(block.length).toBeGreaterThan(5000);
    expect(block).toContain('data-ctype="candles"');
  });

  it('KEIN title-Attribut trägt noch deutschen Text', () => {
    /* Mechanische Arbeit braucht eine mechanische Kontrolle. ~60 Attribute
     * einzeln zu pinnen wäre eine Stichprobe — und eine Stichprobe findet
     * genau die Zeile nicht, die man beim Ersetzen übersprungen hat.
     * Deshalb: ALLE title-Attribute einsammeln und jedes prüfen. */
    const roh = [...block.matchAll(/title="([^"]*)"/g)]
      .map((m) => m[1] ?? '')
      .filter((v) => !v.startsWith('${t('));
    expect(roh, `title-Attribute ohne t(): ${roh.join(' | ')}`).toEqual([]);
  });

  /* Sprachneutrale Beschriftungen — sie bleiben mit Absicht Literale.
   *
   * Die Liste ist ausdrücklich eine POSITIVliste, keine Ausnahmeliste: Was
   * hier nicht steht, muss durch t(). Der erste Entwurf dieses Wächters
   * suchte stattdessen nach Umlauten — und ließ „Kerzen" durch, weil das
   * Wort keinen hat. Aufgefallen ist das erst in der Sabotage-Probe, und
   * genau dafür gibt es sie: Ein Wächter, den man mit einem Wort ohne
   * Umlaut aushebeln kann, prüft die Rechtschreibung, nicht die Sprache. */
  const NEUTRAL = new Set([
    'A', // Link-Gruppe
    '1W', '1M', '3M', 'Max', // in beiden Sprachen gleich (1T/1J/5J NICHT, s. u.)
    'SMA20', 'SMA50', 'SMA200', 'EMA9', 'EMA21', 'BB', 'VWAP', 'RSI', 'MACD',
    'Bars', 'Baseline', 'Heikin-Ashi', // Fachbegriffe, englischen Ursprungs
    'Lin', 'Log', 'Clean', 'News', 'Position', 'Y auto',
  ]);

  it('JEDE Beschriftung ist entweder übersetzt oder ausdrücklich neutral', () => {
    /* Mechanische Arbeit braucht eine mechanische Kontrolle, und diese hier
     * kennt keine Heuristik: Jeder Textknoten im Block muss ein t()-Aufruf
     * sein oder namentlich in NEUTRAL stehen. Ein vergessenes deutsches Wort
     * kann damit nicht durchrutschen, egal wie es geschrieben ist. */
    const ohneAufrufe = block.replace(/\$\{t\('[^']+'\)\}/g, '');
    const roh = [...ohneAufrufe.matchAll(/>([^<>{}$]*[A-Za-zÄÖÜäöü][^<>{}$]*)</g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((v) => v.length > 0 && !NEUTRAL.has(v));
    expect(roh, `nicht übersetzt und nicht als neutral erklärt: ${roh.join(' | ')}`).toEqual([]);
  });

  it('die Zeitrahmen-Kürzel sind übersetzt — 1T ist kein englisches Wort', () => {
    /* Der leiseste Fehler dieser Tranche wäre, 1T/1J/5J stehenzulassen:
     * Sie sehen wie Symbole aus, sind aber Abkürzungen für Tag und Jahr.
     * Ein englischer Nutzer liest „1T" als nichts. */
    expect(EN['chart.lbl1T']).toBe('1D');
    expect(EN['chart.lbl1J']).toBe('1Y');
    expect(EN['chart.lbl5J']).toBe('5Y');
    // Was gleich BLEIBT, bleibt bewusst gleich: 1W und 1M/3M stimmen in
    // beiden Sprachen überein und stehen deshalb gar nicht im Wörterbuch.
    expect(DE['chart.lbl1T' as TextSchluessel]).toBe('1T');
  });

  it('auch chart.ts selbst hat keinen deutschen Text mehr', () => {
    /* Eine einzige Zeichenkette — die Meldung, wenn die Chart-Bibliothek
     * nicht lädt. Sie erscheint genau dann, wenn ohnehin etwas kaputt ist;
     * dann auf Deutsch zu antworten wäre doppelt unfreundlich.
     *
     * Geprüft wird der CODE, nicht die Kommentare: Der erste Entwurf dieses
     * Wächters suchte den Satz in der ganzen Datei und wurde von einem
     * Doku-Kommentar rot, der genau dasselbe Wort erklärt. Ein Wächter, der
     * am Kommentar hängt, zwingt beim nächsten Mal dazu, die Erklärung zu
     * verstümmeln, statt den Fehler zu beheben. */
    const ohneKommentare = chartQuelle
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(ohneKommentare).not.toContain('Chart-Bibliothek nicht geladen');
    expect(chartQuelle).toContain("t('chart.libFehlt')");
  });

  it('jede chart.*-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => s.startsWith('chart.'))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Auswertungs-Karten sind zweisprachig (Tranche 5g)', () => {
  /* Performance, Depot-Verlauf, Haltedauer, Erkenntnisse — die vier Karten
   * mit den langen Erklärabsätzen. Sie sind der Grund, warum meine erste
   * Zählung des Rests („~60") um mehr als das Vierfache danebenlag: Diese
   * Texte stehen als Fließtext IM Markup, umbrochen und eingerückt, und
   * eine Suche nach großgeschriebenen Wörtern in Anführungszeichen findet
   * davon kein einziges.
   *
   * Geschnitten wird JE KARTE, nicht über die ganze Spanne. Der erste
   * Entwurf nahm alles von der Performance-Karte bis zum Order-Modal — und
   * meldete prompt Texte aus Karten, die zu späteren Tranchen gehören. Ein
   * Wächter, der mehr prüft als seine Tranche liefert, ist entweder immer
   * rot oder er lädt dazu ein, seine Grenze aufzuweichen. */
  const karte = (panel: string, bis: string): string =>
    dashboard.slice(dashboard.indexOf(`data-panel="${panel}"`), dashboard.indexOf(bis));

  const KARTEN: ReadonlyArray<readonly [string, string]> = [
    ['performance', 'data-panel="manualtrade"'],
    ['depotVerlauf', 'data-panel="haltedauer"'],
    ['haltedauer', 'data-panel="erkenntnisse"'],
    ['erkenntnisse', '<div class="dmodal" id="orderModal">'],
  ];

  it('alle vier Karten sind gefunden und nicht leer', () => {
    for (const [panel, bis] of KARTEN) {
      const k = karte(panel, bis);
      expect(k.length, `Karte ${panel} leer oder Grenze verrutscht`).toBeGreaterThan(300);
      expect(k).toContain(`data-panel="${panel}"`);
    }
  });

  /* Sprachneutral — dieselbe Regel wie bei den Zeitrahmen-Kürzeln in 5f,
   * nur andersherum: Was in beiden Sprachen IDENTISCH ist, bleibt Literal
   * und kommt gar nicht erst ins Wörterbuch. Eine Zeile, die nichts
   * übersetzt, kann trotzdem falsch werden — sie bringt nur Risiko ohne
   * Nutzen. „Drawdown" und „Sharpe" SIND die englischen Begriffe. */
  const NEUTRAL = new Set(['Cash', 'Equity (live)', 'Drawdown', 'Sharpe 30', 'Sharpe 90']);

  it('JEDER Textknoten der vier Karten ist übersetzt oder neutral', () => {
    for (const [panel, bis] of KARTEN) {
      const ohneAufrufe = karte(panel, bis)
        .replace(/\$\{t\('[^']+'\)\}/g, '')
        .replace(/\$\{iBtn\('[^']+'\)\}/g, '');
      const roh = [...ohneAufrufe.matchAll(/>([^<>{}$]*[A-Za-zÄÖÜäöü][^<>{}$]*)</g)]
        .map((m) => (m[1] ?? '').split(/\s+/).join(' ').trim())
        .filter((v) => v.length > 0 && !NEUTRAL.has(v));
      expect(roh, `${panel}: nicht übersetzt — ${roh.join(' | ')}`).toEqual([]);
    }
  });

  it('die langen Erklärabsätze sind vollständig übersetzt, nicht angerissen', () => {
    /* Der billigste Fehler bei einem umbrochenen Absatz wäre, nur die erste
     * Zeile zu ersetzen und den Rest stehenzulassen — das Ergebnis wäre ein
     * halb englischer Satz, und der liest sich schlimmer als ein ganz
     * deutscher. Deshalb je Absatz eine Probe auf das ENDE. */
    expect(EN['dc.hinweis']).toContain('since the start of the window');
    expect(EN['hd.hinweis']).toContain('not the signal');
    expect(EN['er.hinweis']).toContain('nothing is claimed');
    for (const k of ['dc.hinweis', 'hd.hinweis', 'er.hinweis'] as const) {
      expect(EN[k]!.length, `${k} wirkt abgeschnitten`).toBeGreaterThan(200);
    }
  });

  it('jede Zeile der vier Karten hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => /^(pf|dc|hd|er)\./.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});
