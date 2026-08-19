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

describe('Broker-Status und Steuer-Export sind zweisprachig (Tranche 5h)', () => {
  const rBroker = dashboard.slice(
    dashboard.indexOf('function renderBrokerStatus'),
    dashboard.indexOf('const TOPF_LABEL'),
  );
  const rSteuer = dashboard.slice(
    dashboard.indexOf('function renderSteuerbericht'),
    dashboard.indexOf('/* ── Subscriptions ──'),
  );

  it('beide Renderer sind gefunden', () => {
    expect(rBroker.length).toBeGreaterThan(1500);
    expect(rSteuer.length).toBeGreaterThan(2500);
  });

  it('kein deutsches Wort mehr im Code der beiden Renderer', () => {
    /* Anders als im Markup steht der Text hier in Template-Literalen und
     * String-Ketten. Der erste Entwurf schnitt deshalb erst die
     * Zeichenketten heraus und prüfte die einzeln — und ließ den
     * Sabotage-Fund glatt durch: Zwischen Backtick und Apostroph paart ein
     * Muster quer über den Code hinweg, und der deutsche Satz verschwand im
     * Rumpf eines benachbarten Treffers.
     *
     * Zweiter Anlauf ohne Tokenisierung: deutsche FUNKTIONSWÖRTER direkt im
     * (kommentarfreien) Code suchen. Sie kommen in Bezeichnern nicht vor —
     * `hinweise`, `zeilen`, `veraeusserungen` lösen nichts aus —, und
     * schon eines von ihnen genügt, um einen vergessenen Satz zu verraten,
     * egal in welcher Zeichenkette er steckt. Ein Wächter, der sein Objekt
     * erst zerlegen muss, kann sich beim Zerlegen irren; einer, der
     * geradeaus liest, nicht. */
    const nurCode = (q: string): string =>
      q.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const DEUTSCH =
      /\b(nicht|werden|wird|dürfen|hängt|steht|stehen|sind|keine|kein|eine|einen|dieses|jeder|gegeneinander|steuerbar|Anschaffung|Veräußerung|Papiergewinne|Steuerschuld)\b/g;
    for (const [name, q] of [
      ['renderBrokerStatus', rBroker],
      ['renderSteuerbericht', rSteuer],
    ] as const) {
      const treffer = [...new Set([...nurCode(q).matchAll(DEUTSCH)].map((m) => m[0]))];
      expect(treffer, `${name}: deutscher Rest — ${treffer.join(' | ')}`).toEqual([]);
    }
  });

  it('die §-Angaben stehen unverändert — auch in der englischen Fassung', () => {
    /* Ein Paragraph benennt deutsches Recht. „Section 20 (6)" wäre eine
     * Übersetzung, die niemand nachschlagen kann — dieselbe Regel wie bei
     * den Literatur-Zitaten in den ⓘ-Tips: Übersetzt wird die Erklärung
     * drumherum, nicht der Beleg. */
    expect(DE['tax.topfAktien' as TextSchluessel]).toContain('§ 20');
    expect(EN['tax.topfAktien']).toContain('§ 20');
    expect(EN['tax.topfPrivat']).toContain('§ 23');
    expect(EN['tax.freigrenzeA']).toContain('§ 23');
  });

  it('Freigrenze bleibt als Freigrenze erkennbar, nicht als Freibetrag', () => {
    /* Der Unterschied ist der ganze Punkt des Absatzes: Ein Euro über der
     * Grenze macht den GANZEN Betrag steuerpflichtig. „Allowance" allein
     * würde genau das Gegenteil behaupten. */
    expect(EN['tax.freigrenzeB']).toContain('exemption limit');
    expect(EN['tax.freigrenzeC']).toContain('not an allowance');
    expect(EN['tax.freigrenzeC']).toContain('WHOLE amount taxable');
  });

  it('jede br.*- und tax.*-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => /^(br|tax)\./.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Admin-Karte und Not-Aus sind zweisprachig (Tranche 5i)', () => {
  /* Derselbe Wächter-Bauplan wie in 5h — deutsche Funktionswörter direkt im
   * kommentarfreien Code, ohne Zeichenketten zu tokenisieren. Die
   * Erfahrung aus 5f und 5h: Ein Wächter, der clever wird, wird unzuverlässig. */
  const nurCode = (q: string): string =>
    q
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      /* Schlüsselnamen sind CODE, kein Anzeigetext. `t('adm.wartet')` würde
       * den Wächter sonst mit genau dem Wort auslösen, das er dort sehen
       * WILL — und die einzige Reparatur wäre, die Schlüssel unlesbar zu
       * machen. Ein Wächter, der zu englischen Bezeichnern zwingt, verbessert
       * nichts; er verschiebt nur den deutschen Text in den Dateikopf. */
      .replace(/t\('[^']+'\)/g, 't()')
      /* Auch Eigenschaftsnamen sind CODE: `row.reife.bereit` ist ein Feld im
       * Datenmodell, kein Anzeigetext. Dieses Projekt benennt bewusst auf
       * Deutsch (reife, bereit, erfuellt) — ein Wächter, der das anschlägt,
       * verlangt eine Umbenennung des halben Modells, um eine Übersetzung zu
       * bescheinigen, die damit nichts zu tun hat. */
      .replace(/\.[A-Za-zÄÖÜäöü_$][\w$]*/g, '.x');
  /* Roh für die Grenzprüfung, gestrippt für die Wortsuche. Der erste
   * Entwurf prüfte beides am gestrippten Text — und schlug fehl, weil das
   * Strippen `s.killSwitch` zu `.x` macht. Ein Wächter darf sein Prüfobjekt
   * nicht so weit verarbeiten, dass er seine eigene Grenzkontrolle
   * unbrauchbar macht. */
  const adminRoh = dashboard.slice(
    dashboard.indexOf('const ACCESS_BADGE'),
    dashboard.indexOf('function admBtn'),
  );
  const admin = nurCode(adminRoh);

  it('der Block ist gefunden', () => {
    expect(adminRoh.length).toBeGreaterThan(2000);
    expect(adminRoh).toContain('adminSetAccess');
    expect(adminRoh).toContain('killSwitch');
  });

  it('kein deutsches Wort mehr im Admin-Code', () => {
    const DEUTSCH =
      /\b(wartet|gesperrt|frei|lädt|Sperren|Freischalten|entziehen|machen|gefunden|Zustand|AUSGELÖST|bereit|lösen|auslösen|lesbar|laufen|normal)\b/g;
    const treffer = [...new Set([...admin.matchAll(DEUTSCH)].map((m) => m[0]))];
    expect(treffer, `deutscher Rest — ${treffer.join(' | ')}`).toEqual([]);
  });

  it('der Not-Aus bleibt in beiden Sprachen als Not-Aus erkennbar', () => {
    /* Das ist der Knopf, der ALLE Echtgeld-Orders stoppt. Seine Beschriftung
     * darf in keiner Sprache harmlos klingen — „Stop" wäre ein Wort für
     * einen Scan, „TRIP EMERGENCY STOP" ist eines für eine Reißleine. Die
     * Großschreibung trägt die Dringlichkeit mit, deshalb steht sie im
     * Wörterbuch und nicht im CSS. */
    expect(EN['adm.notausAusloesen']).toBe('TRIP EMERGENCY STOP');
    expect(EN['adm.notausAusloesen']).toBe(EN['adm.notausAusloesen']!.toUpperCase());
    expect(DE['adm.notausAusloesen' as TextSchluessel]).toBe('NOT-AUS auslösen');
    expect(EN['adm.ausgeloest']).toBe('TRIPPED');
  });

  it('jede adm.*-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => s.startsWith('adm.'))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Restmarkup der Karten und Modals (Tranche 5j)', () => {
  const lay = dashboard.slice(
    dashboard.indexOf('function layout('),
    dashboard.indexOf('const RESET_CONFIRM_WORD'),
  );

  it('der layout-Block ist gefunden', () => {
    expect(lay.length).toBeGreaterThan(40000);
    expect(lay).toContain('data-panel="strategy"');
    expect(lay).toContain('id="orderModal"');
  });

  it('kein deutscher Fließtext mehr im layout-Markup', () => {
    /* Positivliste wie in 5f — nur Fachbegriffe, Kürzel und Zeichen, die in
     * beiden Sprachen gleich sind. Alles andere muss durch t(). */
    const ohne = lay
      /* Kommentare zuerst: `layout` ist zu zwei Dritteln Erklärung, warum das
       * Markup so aussieht, wie es aussieht. Diese Sätze sollen deutsch
       * bleiben — dieses Projekt kommentiert auf Deutsch, und ein Wächter,
       * der das anschlägt, verlangt eine Übersetzung der Dokumentation, um
       * eine Übersetzung der Oberfläche zu bescheinigen. */
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\$\{t\('[^']+'\)\}/g, '')
      .replace(/\$\{iBtn\('[^']+'\)\}/g, '');
    const DEUTSCH =
      /\b(nicht|werden|wird|noch|keine|kein|eine|einen|deiner|deine|dein|jeder|jede|sobald|damit|dieses|dieser|bleiben|stellst|handelt|gilt|läuft|zählt)\b/g;
    const treffer = [...new Set([...ohne.matchAll(DEUTSCH)].map((m) => m[0]))];
    expect(treffer, `deutscher Rest im Markup — ${treffer.join(' | ')}`).toEqual([]);
  });

  it('die Engine-Stopp-Warnung bleibt in Teilen und behält ihre Schärfe', () => {
    /* Dieser Absatz sagt, was NICHT mehr passiert, wenn die Engine aus ist:
     * keine Stop-Loss- und keine Take-Profit-Ausführungen, offene Positionen
     * ungeschützt. Das ist die folgenreichste Warnung der Oberfläche.
     *
     * Sie ist absichtlich in vier Schlüssel geschnitten statt in einen
     * Absatz: In einem langen Block fällt eine schwache Übersetzung
     * niemandem auf — bei „unprotected" als eigener Zeile schon. */
    expect(EN['lay.stoppB']).toContain('stop-loss');
    expect(EN['lay.stoppB']).toContain('take-profit');
    expect(EN['lay.ungeschuetzt']).toBe('unprotected');
    expect(EN['lay.stoppA']).toContain('No new trades');
  });

  it('der Not-Aus-Hinweis sagt in beiden Sprachen, was WEITERLÄUFT', () => {
    /* Die Hälfte der Aussage ist die Einschränkung: Paper, eigenes Buch und
     * Depot-Überwachung laufen weiter. Ohne sie liest sich der Not-Aus wie
     * ein Totalausfall — und wer das glaubt, drückt ihn im Ernstfall nicht. */
    expect(EN['lay.notausHinweis']).toContain('Paper accounts');
    expect(EN['lay.notausHinweis']).toContain('keep running unchanged');
    expect(EN['lay.notausHinweis']).toContain('60 s');
  });

  it('jede lay.*-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => s.startsWith('lay.'))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Ablehnungsgründe, Regime und Zugang (Tranche 5k)', () => {
  const nurCode = (q: string): string =>
    q
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/t\('[^']+'\)/g, 't()')
      .replace(/\.[A-Za-zÄÖÜäöü_$][\w$]*/g, '.x');

  it('renderAccessNote ist vollständig übersetzt', () => {
    const roh = dashboard.slice(
      dashboard.indexOf('function renderAccessNote'),
      dashboard.indexOf('const GATE_TEXT'),
    );
    expect(roh).toContain('accessLevel');
    const DEUTSCH = /\b(Zugang|geprüft|gehandelt|Freischaltung|gesperrt|wende|Betreiber)\b/g;
    const treffer = [...new Set([...nurCode(roh).matchAll(DEUTSCH)].map((m) => m[0]))];
    expect(treffer, `deutscher Rest — ${treffer.join(' | ')}`).toEqual([]);
  });

  it('GATE_TEXT, REGIME_TEXT und KALENDER_TEXT tragen nur noch Schlüssel', () => {
    /* Diese drei Tabellen sind der meistgelesene Text der App, wenn etwas
     * nicht wie erwartet läuft: Sie beantworten, warum gerade NICHT
     * gehandelt wird. Eine unklare Übersetzung führt hier nicht zu
     * Verwirrung, sondern zu einer falschen Diagnose — wer „die Anlageklasse
     * steht auf 0" nicht versteht, sucht den Fehler in der Strategie statt
     * am Regler. */
    const tab = dashboard.slice(
      dashboard.indexOf('const GATE_TEXT'),
      dashboard.indexOf('function renderEngineWhy'),
    );
    /* Wortsuche statt Zeichenketten-Extraktion — dieselbe Lehre wie in 5h:
     * Ein Muster, das Quotes paart, paart quer über den Code und findet
     * Rümpfe statt Texte. Geradeaus lesen ist zuverlässiger. */
    const DEUTSCH =
      /\b(Konten|Notbremse|Einstiege|Ausstiege|abgelehnt|Anlageklasse|Schatten|Leerverkäufe|Markt|steigt|pausiert|Marktstress|geblockt|verliert|Ereignis|Schlagzeilen|erwartete|Bewegung|Gebühren|übersprungen|verkauft|Bedingungen|erfüllt|Aufwärtstrend|ruhig|Seitwärts|Zinsentscheid|Arbeitsmarktbericht|Verbraucherpreise)\b/g;
    const treffer = [...new Set([...nurCode(tab).matchAll(DEUTSCH)].map((m) => m[0]))];
    expect(treffer, `deutscher Rest in den Tabellen — ${treffer.join(' | ')}`).toEqual([]);
  });

  it('jede Bremse behält ihren Namen — die Kürzel sind der Vertrag zum Server', () => {
    /* Die Schlüssel links (breaker_aktiv, regime_stress …) kommen aus dem
     * Heartbeat und dürfen sich NICHT ändern; übersetzt wird nur, was rechts
     * daneben steht. Ein umbenanntes Kürzel wäre kein Übersetzungsfehler,
     * sondern eine stumme Lücke: Der Zähler käme an, fände keinen Text und
     * die Bremse verschwände aus der Liste. */
    const tab = dashboard.slice(
      dashboard.indexOf('const GATE_TEXT'),
      dashboard.indexOf('const REGIME_TEXT'),
    );
    for (const code of [
      'breaker_aktiv', 'abgleich_drift', 'klasse_aus', 'regime_gegen_trend',
      'regime_stress', 'filter_blockiert', 'news_veto', 'unter_kosten',
      'cluster_voll', 'nicht_handelbar', 'hebel_frei',
    ]) {
      expect(tab, `Kürzel ${code} fehlt`).toContain(`'${code}'`);
    }
  });

  it('jede acc./gate./reg./kal.-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => /^(acc|gate|reg|kal)\./.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Tranche 5l — „Warum handelt die Engine?" und die Melde-Texte der Montage', () => {
  /* Warum hier ein ANDERER Wächter steht als in 5f–5k:
   *
   * Die bisherigen Wächter suchten deutsche Wörter (Umlaute, Funktions-
   * wörter). Genau daran sind sie in dieser Tranche gescheitert: „Kerzen",
   * „Monatswende", „Gespeichert." und „Sichere …" haben weder Umlaut noch
   * Artikel — sie standen monatelang unübersetzt da und kein Wächter hat
   * gemurrt. Ein Wächter, der die Sache nicht messen kann, bescheinigt
   * Fehlerfreiheit.
   *
   * Deshalb dreht dieser Block die Beweislast um: JEDE Zeichenkette in den
   * beiden Funktionen ist verdächtig, bis sie sich ausweist. Ausweisen kann
   * sie sich als t()-Aufruf, als DOM-Id/Selektor/Ereignisname (die werden
   * vorher weggeschnitten) oder als eines der unten NAMENTLICH gelisteten
   * technischen Wörter. Alles andere ist ein Befund.
   *
   * Die Liste zu erweitern ist erlaubt — aber nur mit einem Wort, das
   * wirklich Code ist. Wer hier einen Anzeigetext einträgt, hebelt den
   * Wächter aus und das fällt beim Lesen sofort auf. */
  const funktion = (name: string): string => {
    const i = dashboard.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'));
    const rest = dashboard.slice(i + 20);
    const j = rest.search(/^(?:export )?(?:async )?function /m);
    return dashboard.slice(i, j < 0 ? undefined : i + 20 + j);
  };

  const fremdWorte = (code: string): string[] => {
    const ohne = code
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // Kommentare bleiben deutsch (Projekt-Konvention)
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/t\('[^']+'\)/g, ' ') // übersetzt = ausgewiesen
      .replace(/\$\('[^']+'\)/g, ' ') // DOM-Ids
      .replace(
        /(getItem|setItem|removeItem|addEventListener|removeEventListener|querySelector|querySelectorAll|closest|matches|getAttribute|setAttribute|hasAttribute|removeAttribute|toggle|add|remove|contains|getElementById|createElement|matchMedia|getPropertyValue|setProperty)\(\s*'[^']*'/g,
        ' ',
      )
      .replace(/'var\(--[^']*'/g, ' '); // CSS-Variablen
    const worte: string[] = [];
    for (const m of ohne.matchAll(/'([^']*)'/g)) {
      worte.push(...(m[1]!.match(/[A-Za-zÄÖÜäöüß]{3,}/g) ?? []));
    }
    for (const m of ohne.matchAll(/`([^`]*)`/g)) {
      const text = m[1]!.replace(/\$\{[^{}]*\}/g, ' ');
      worte.push(...(text.match(/[A-Za-zÄÖÜäöüß]{3,}/g) ?? []));
    }
    return [...new Set(worte)];
  };

  it('renderEngineWhy: jede Zeichenkette ist t() oder nachweislich technisch', () => {
    const NEUTRAL = new Set([
      // CSS / HTML-Gerüst
      'div', 'class', 'hint', 'mono', 'text', 'color', 'display', 'flex', 'gap',
      'align', 'items', 'baseline', 'right', 'width', 'inherit',
      // Kürzel aus dem Heartbeat (Vertrag zum Server — NICHT übersetzen)
      'approved', 'blocked', 'pending', 'trend', 'geprueft', 'gehandelt', 'laufend',
      'live', 'kosten', 'halte', 'hebel', 'frei', 'longs', 'ueberfuellt', 'short',
      'squeeze', 'setup', 'number',
      // Einheiten und Kennzahl-Namen, die in beiden Sprachen gleich heißen
      'VIX', 'Vol', 'min',
    ]);
    const rest = fremdWorte(funktion('renderEngineWhy')).filter((w) => !NEUTRAL.has(w));
    expect(rest, `nicht ausgewiesene Zeichenketten: ${rest.join(' | ')}`).toEqual([]);
  });

  it('mountDashboard: jede Zeichenkette ist t() oder nachweislich technisch', () => {
    const NEUTRAL = new Set([
      // CSS / HTML-Gerüst
      'div', 'class', 'hint', 'card', 'panel', 'style', 'color', 'font', 'family',
      'monospace', 'margin', 'top', 'text', 'input', 'checked', 'visible', 'data',
      'btn', 'active', 'show',
      // DOM-Ids, Datensatz-Namen und Selektor-Teile
      'chartGrid', 'cmpOverlay', 'subPanels', 'predArrow', 'drawBtn', 'indBtn',
      'layBtn', 'menuDraw', 'menuInd', 'menuLay', 'leftCol', 'rightCol', 'otSym',
      'otQty', 'otab', 'opane', 'ouPred', 'ouCmp', 'ouGrid', 'ouSub', 'lodel',
      'flCombos', 'flCombosIntra', 'stopsym', 'adv', 'titel', 'zoom', 'layer',
      'ctype', 'scale', 'grid', 'draw',
      // Speicher-Schlüssel, Tastennamen, Medienabfrage
      'autotrd', 'chart', 'prefers', 'scheme', 'dark', 'light', 'system', 'Enter',
      'Escape', 'ctrl',
      // Werte aus dem Zustand / Vertrag zum Server (NICHT übersetzen)
      'auto', 'fix', 'frei', 'hold', 'buy', 'trade', 'stop', 'start', 'middle',
      'end', 'max', 'live', 'status', 'change', 'symbol', 'broker', 'leverage',
      'approved', 'indices', 'ueberblick', 'trend', 'number', 'string',
      // Chart-Typen und Indikator-Kürzel (Fachbegriffe, in beiden Sprachen gleich)
      'candles', 'hollow', 'heikin', 'line', 'area', 'baseline', 'bars', 'hline',
      'rect', 'rsi', 'macd', 'QQQ',
      // Eigennamen und Dateinamen-Bestandteile
      'Alpha', 'Leech', 'Community', 'steuer', 'papierhandel', 'csv', 'charset', 'utf',
    ]);
    const rest = fremdWorte(funktion('mountDashboard')).filter((w) => !NEUTRAL.has(w));
    expect(rest, `nicht ausgewiesene Zeichenketten: ${rest.join(' | ')}`).toEqual([]);
  });

  it('der Speichern-Zwischenstand vergleicht übersetzt, nicht auf Deutsch', () => {
    /* Der Merker im Options-Modal („⚠ Noch nicht gespeichert") darf sich
     * nicht über die laufende Speicher-Meldung legen. Der Vergleich lief
     * über startsWith('Speichere') — auf Englisch stünde dort „Saving …"
     * und der Vergleich wäre IMMER falsch: Die Warnung hätte die laufende
     * Speicherung überschrieben. Übersetzen heißt hier, den Vergleich
     * mitzuziehen, nicht nur den Text. */
    expect(dashboard).toContain("m.textContent !== t('mt.speichere')");
    expect(dashboard).not.toContain("startsWith('Speichere')");
  });

  it('jede ew./mt.-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => /^(ew|mt)\./.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Tranche 5m — Legende, Live-Status, Loadouts und Portfolio', () => {
  /* Dieselbe umgekehrte Beweislast wie in 5l: JEDE Zeichenkette der vier
   * Funktionen ist verdächtig, bis sie sich als t()-Aufruf, DOM-/CSS-Technik
   * oder namentlich gelistetes Fachwort ausweist. Die Wortsuche der frühen
   * Tranchen hätte hier wieder versagt — „Ansehen", „Cover", „SHORT" tragen
   * weder Umlaut noch Artikel. */
  const funktion = (name: string): string => {
    const i = dashboard.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'));
    const rest = dashboard.slice(i + 20);
    const j = rest.search(/^(?:export )?(?:async )?function /m);
    return dashboard.slice(i, j < 0 ? undefined : i + 20 + j);
  };
  const fremdWorte = (code: string): string[] => {
    const ohne = code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/t\('[^']+'\)/g, ' ')
      .replace(/\$\('[^']+'\)/g, ' ')
      .replace(
        /(getItem|setItem|addEventListener|querySelector|querySelectorAll|closest|getElementById|createElement|getAttribute|setAttribute)\(\s*'[^']*'/g,
        ' ',
      )
      .replace(/'var\(--[^']*'/g, ' ');
    const worte: string[] = [];
    for (const m of ohne.matchAll(/'([^']*)'/g)) {
      worte.push(...(m[1]!.match(/[A-Za-zÄÖÜäöüß]{3,}/g) ?? []));
    }
    for (const m of ohne.matchAll(/`([^`]*)`/g)) {
      const text = m[1]!.replace(/\$\{[^{}]*\}/g, ' ');
      worte.push(...(text.match(/[A-Za-zÄÖÜäöüß]{3,}/g) ?? []));
    }
    return [...new Set(worte)];
  };
  const pruefe = (name: string, neutral: readonly string[]): void => {
    const erlaubt = new Set(neutral);
    const rest = fremdWorte(funktion(name)).filter((w) => !erlaubt.has(w));
    expect(rest, `${name}: nicht ausgewiesene Zeichenketten: ${rest.join(' | ')}`).toEqual([]);
  };

  it('renderLegend: Indikator-Namen sind Fachsprache, alles andere ist t()', () => {
    pruefe('renderLegend', [
      // Indikator-Kürzel — in beiden Sprachen identisch
      'SMA', 'EMA', 'VWAP', 'Bollinger', 'Session',
      // Layer-Schlüssel und DOM/CSS
      'bbU', 'bbL', 'cmp', 'pos', 'seit', 'area', 'buy', 'sell',
      'class', 'style', 'span', 'title', 'item', 'dot', 'background',
    ]);
  });

  it('renderLiveStatus: nur Vertragswerte und CSS bleiben Literale', () => {
    pruefe('renderLiveStatus', [
      'live', 'paper', // brokerArt — Vertrag zum Server
      'class', 'color', 'div', 'hint', 'left', 'margin', 'opacity', 'style', 'top', 'var',
    ]);
  });

  it('renderLoadouts: der Eigenname Alpha-Leech bleibt, der Rest ist t()', () => {
    pruefe('renderLoadouts', [
      // Eigenname des Features — wird nicht übersetzt (wie in mountDashboard)
      'Alpha', 'Leech', 'Community',
      // Statuscode aus dem Best-Practice-Dokument
      'gekuert',
      // DOM/CSS und HTML-Entities
      'amp', 'quot', 'anw', 'btn', 'button', 'card', 'class', 'data', 'div',
      'eigen', 'esc', 'fehlt', 'head', 'hint', 'length', 'margin', 'off',
      'risk', 'style', 'top',
    ]);
  });

  it('renderPortfolio: Cover/Exit/SHORT sind Fachbegriffe, alles andere ist t()', () => {
    pruefe('renderPortfolio', [
      // Fachbegriffe, in beiden Sprachen gleich (Knopf-Beschriftungen)
      'Cover', 'Exit', 'SHORT',
      // Seiten-/Zustandswerte und DOM/CSS
      'buy', 'sell', 'short', 'pos', 'show', 'smooth', 'center',
      'button', 'class', 'color', 'colspan', 'data', 'exit', 'font', 'hbtn',
      'smv', 'stag', 'style', 'sub', 'sym', 'var', 'vbig', 'weight',
    ]);
  });

  it('jede lg./lv./lo./pf.-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => /^(lg|lv|lo|pf)\./.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});

describe('Tranche 5n — die zehn Analyse- und Melde-Funktionen', () => {
  /* Umgekehrte Beweislast wie in 5l/5m — für zehn Funktionen auf einmal.
   * Die Positivlisten sind klein gehalten: Was hier NICHT steht und wie
   * Text aussieht, ist ein Befund. */
  const funktion = (name: string): string => {
    const i = dashboard.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'));
    const rest = dashboard.slice(i + 20);
    const j = rest.search(/^(?:export )?(?:async )?function /m);
    return dashboard.slice(i, j < 0 ? undefined : i + 20 + j);
  };
  const fremdWorte = (code: string): string[] => {
    const ohne = code
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/t\('[^']+'\)/g, ' ')
      .replace(/\$\('[^']+'\)/g, ' ')
      .replace(
        /(getElementById|createElement|addEventListener|querySelectorAll|querySelector|toLocaleString|toLocaleDateString)\(\s*'[^']*'/g,
        ' ',
      )
      .replace(/'var\(--[^']*'/g, ' ');
    const worte: string[] = [];
    for (const m of ohne.matchAll(/'([^']*)'/g)) {
      worte.push(...(m[1]!.match(/[A-Za-zÄÖÜäöüß]{3,}/g) ?? []));
    }
    for (const m of ohne.matchAll(/`([^`]*)`/g)) {
      const text = m[1]!.replace(/\$\{[^{}]*\}/g, ' ');
      worte.push(...(text.match(/[A-Za-zÄÖÜäöüß]{3,}/g) ?? []));
    }
    return [...new Set(worte)];
  };
  const NEUTRAL: Record<string, readonly string[]> = {
    // Statuscodes (Vertrag zum Server) + CSS/DOM; „Dollar/Trades" sind weg.
    renderKlassenRat: ['global', 'schatten', 'class', 'color', 'div', 'hint', 'inherit',
      'margin', 'span', 'style', 'title', 'top'],
    renderAbgleich: ['drift', 'fehler', 'color', 'cursor', 'details', 'div', 'margin',
      'pointer', 'style', 'summary', 'top', 'var'],
    renderMomentum: ['class', 'div', 'hint', 'mono', 'row', 'span', 'tag'],
    renderBestPractice: ['gekuert'],
    // ATR ist Fachkürzel; stop/target/short sind Code-Werte von levelDistPct.
    exitOutlook: ['ATR', 'class', 'next', 'pos', 'span', 'stop', 'target', 'short', 'title'],
    abHinweis: ['bericht', 'chronik', 'fehler', 'kein', 'keine', 'schluessel'],
    // „Auto" ist die Quelle-Markierung am Symbol — in beiden Sprachen gleich.
    renderJournal: ['Auto', 'buy', 'sell', 'engine', 'closed', 'class', 'color', 'colspan',
      'digit', 'span', 'stag', 'style', 'var'],
    updateOrderPreview: ['buy', 'sell', 'short', 'exposure', 'maximumFractionDigits', 'secs'],
    renderWatchHint: [],
    renderStruktur: ['DSR', 'Sharpe', 'Test', 'buy', 'start', 'class', 'digit', 'div',
      'hint', 'mono', 'number', 'span', 'tag'],
  };
  for (const [name, neutral] of Object.entries(NEUTRAL)) {
    it(`${name}: jede Zeichenkette ist t() oder nachweislich technisch`, () => {
      const erlaubt = new Set(neutral);
      const rest = fremdWorte(funktion(name)).filter((w) => !erlaubt.has(w));
      expect(rest, `${name}: nicht ausgewiesene Zeichenketten: ${rest.join(' | ')}`).toEqual([]);
    });
  }

  it('jede kr./ab./mo./bp./eo./ah./jn./op./wh./sk.-Zeile hat eine englische Fassung', () => {
    for (const k of Object.keys(DE).filter((s) => /^(kr|ab|mo|bp|eo|ah|jn|op|wh|sk)\./.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });
});
