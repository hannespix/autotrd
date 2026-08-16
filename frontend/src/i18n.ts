/**
 * Sprachumschalter (Task #139, Phase 0) — Deutsch bleibt die Quelle der
 * Wahrheit, Englisch ist eine Übersetzungsschicht darüber.
 *
 * ── Die eine Regel, die alles trägt ───────────────────────────────────────
 *
 * Fehlt eine englische Übersetzung, erscheint der DEUTSCHE Text — niemals
 * ein leerer String, niemals ein Fehler, niemals ein Schlüssel-Name im UI.
 * Damit ist „kaputtmachen" strukturell ausgeschlossen: Der schlimmste
 * denkbare Zustand ist ein deutscher Text im Englisch-Modus, und genau das
 * ist während der schrittweisen Übersetzung (Phase 1, modulweise) der
 * gewollte Zwischenstand.
 *
 * ── Konventionen ──────────────────────────────────────────────────────────
 *
 *  - `DE` ist vollständig und der einzige Ort, an dem neue Texte entstehen.
 *    `EN` darf lücken (Fallback), aber nie Schlüssel erfinden — der Test
 *    `i18n.test.ts` weist Karteileichen ab.
 *  - Schlüssel sind `bereich.name` (z. B. `login.anmelden`), damit die
 *    Phase-1-Tranchen sauber geschnitten werden können.
 *  - Die Wahl liegt in localStorage `autotrd-lang` ('de' Standard | 'en'),
 *    gleiche Mechanik wie das Theme (`autotrd-theme`, s. dashboard.ts).
 *    Serverseitig erzeugte Texte (Journal, KI-Bericht, Regler-Gründe)
 *    bleiben in Phase 0/1 unangetastet — die kommen als Codes in Phase 2.
 */

export type Sprache = 'de' | 'en';

/** Deutsches Wörterbuch — vollständig, Quelle der Wahrheit. */
export const DE = {
  'login.sub': 'Automatisiertes Trading · Paper & Broker-Anbindung · keine Anlageberatung',
  'login.email': 'E-Mail',
  'login.passwort': 'Passwort',
  'login.anmelden': 'Anmelden',
  'login.registrieren': 'Registrieren',
  'login.passwortVergessen': 'Passwort vergessen?',
  'login.oder': 'oder',
  'login.mitGoogle': 'Mit Google anmelden',
  'login.emailFehlt': 'Bitte oben die E-Mail-Adresse eintragen.',
  'login.resetUnterwegs': 'Passwort-Reset-Mail ist unterwegs (Spam-Ordner prüfen).',
  'nav.panelLinks': 'Linkes Panel',
  'nav.panelRechts': 'Rechtes Panel',
  'nav.engineAus': 'Engine aus',
  'nav.engineAn': 'Engine an',
  'nav.optionenTitle': 'Optionen: Elemente, Module & Paper-Wallet',
  'nav.tourTitle': 'Tour: die wichtigsten Bereiche in einer Minute',
  'nav.spalteLinks': 'Linke Spalte ein-/ausblenden',
  'nav.spalteRechts': 'Rechte Spalte ein-/ausblenden',
  // Optionen-Modal (Tranche 2: Rahmen + Tab „Anzeige"). Einige Werte tragen
  // Inline-Markup (<b>/<i>) bzw. HTML-Entities (&amp;) — sie landen im
  // layout()-Template per innerHTML, genau wie die bisherigen Literale.
  'opt.titel': 'Optionen',
  'opt.tabAnzeige': 'Anzeige',
  'opt.tabTrading': 'Trading',
  'opt.tabBroker': 'Broker &amp; Echtgeld',
  'opt.tabKonto': 'Konto &amp; Steuer',
  'opt.darstellung': 'Darstellung',
  'opt.hellDunkel':
    '<b>Hell/Dunkel</b> — „System" folgt automatisch deiner Geräte-Einstellung; Hell/Dunkel stellt fest um.',
  'opt.themeSystem': 'System',
  'opt.themeHell': 'Hell',
  'opt.themeDunkel': 'Dunkel',
  'opt.sprache':
    '<b>Sprache / Language</b> — Deutsch ist Standard. Englisch übersetzt die Oberfläche schrittweise; noch nicht übersetzte Texte erscheinen auf Deutsch.',
  'opt.optionaleElemente': 'Optionale Elemente',
  'opt.prognosePfeil':
    '<b>Prognose-Pfeil</b> — eigene Kurs-Erwartung im Chart einzeichnen; zählt als gewichtete Stimme im Auto-Trading. <i>Beta, standardmäßig aus.</i>',
  'opt.vergleichsOverlay': '<b>Vergleichs-Overlay</b> — zweites Symbol als %-Linie im Haupt-Chart.',
  'opt.multiChartRaster': '<b>Multi-Chart-Raster</b> — 1/2/4 Charts parallel mit Lock-Sync.',
  'opt.indikatorExtras':
    '<b>Indikator-Extras</b> — VWAP (Intraday) und RSI/MACD-Unterpanels unter dem Haupt-Chart.',
  'opt.module': 'Module',
  'opt.moduleHint':
    'Abgewählte Module verschwinden komplett (geht auch per ✕ direkt am Modul); ▾ am Modul klappt nur zu. Die Auswahl synct über deine Geräte.',
  'opt.marktgruppen': 'Marktgruppen',
  'opt.marktgruppenHint':
    'Abgewählte Gruppen verschwinden aus Markt-Browser und Watchlist-Picker (nur Anzeige — die Daten aller Gruppen laufen serverseitig weiter).',
  // Optionen-Modal, Tab „Trading" (Tranche 3a). ⓘ-Knöpfe (iBtn) und
  // Eingabefelder bleiben außerhalb der Schlüssel — übersetzt wird nur Text.
  'opt.paperWallet': 'Paper-Wallet · Grundeinstellungen',
  'opt.startkapitalHint':
    'Das <b>Startkapital</b> ändert deinen aktuellen Kontostand <b>nicht</b>. Es greift erst bei „Neu anfangen" ganz unten — dann wird das Wallet auf diesen Betrag zurückgesetzt. Die Positionsgrößen rechnen immer mit dem <b>verfügbaren Cash</b>, nie mit dem Startkapital.',
  'opt.kapitalPosition': 'Kapital &amp; Positionsgröße',
  'opt.startkapital': 'Startkapital $',
  'opt.investmentJeTrade': 'Investment je Trade %',
  'opt.risikoJeTrade': 'Risiko je Trade %',
  'opt.maxPositionen': 'Max. gleichzeitige Positionen',
  'opt.ruhigerSockel': 'Ruhiger Sockel %',
  'opt.hebel': 'Hebel (Margin)',
  'opt.hebel1': '1× — kein Hebel (Standard)',
  'opt.hebel2': '2× — nur bei sehr starkem Signal',
  'opt.hebel3': '3× — Maximum',
  'opt.ausstiege': 'Ausstiege',
  'opt.stopLoss': 'Stop-Loss %',
  'opt.takeProfit': 'Take-Profit %',
  'opt.trailing': 'Nachziehender Stop %',
  'opt.maxHalte': 'Max. Haltedauer (Tage)',
  'opt.atrStop': 'ATR-Stop (×ATR)',
  'opt.atrZiel': 'ATR-Ziel (×ATR)',
  'opt.signaleTakt': 'Signale &amp; Takt',
  'opt.signalZeitrahmen': 'Signal-Zeitrahmen',
  'opt.tf5m': '5-Minuten (aktiv)',
  'opt.tfDaily': 'Tageskerzen (ruhig)',
  'opt.kaufPause': 'Kauf-Pause nach Verkauf (Min)',
  'opt.konfluenzEinstieg': 'Konfluenz Einstieg',
  'opt.konfluenzAusstieg': 'Konfluenz Ausstieg',
  'opt.schutzschalter': 'Schutzschalter',
  'opt.kostenschwelle': 'Kostenschwelle (× Gebühren)',
  'opt.tagesNotbremsePct': 'Tages-Notbremse (% Verlust)',
  'opt.flatten': 'Bei Notbremse zusätzlich alle Positionen schließen',
  'opt.regimeGate': 'Markt-Ampel (keine Shorts im Aufwärtstrend, Pause bei Stress)',
  'opt.newsVeto': 'News-Veto (Einstiege bei harten Events aussetzen)',
  'opt.experimente': 'Experimente',
  'opt.shorten': 'Shorten erlauben (Leerverkäufe)',
  'opt.nullSchaltetAb':
    '0 schaltet eine Regel ab; ATR-Werte ersetzen die festen Prozente. Alles Weitere erklärt das ⓘ am jeweiligen Feld.',
  'opt.klassenKapital': 'Kapital je Anlageklasse',
  'opt.klassenHint':
    'Der Regler multipliziert die Positionsgröße in dieser Klasse: <b>0</b> = handelt nicht mehr, <b>1</b> = normal, <b>1,5</b> = größere Stücke. Bestehende Positionen werden trotzdem immer geschlossen — der Regler steuert nur den <b>Einstieg</b>. Und: Eine Klasse auf 0 wird weiter <b>gemessen</b> (Schatten-Kante), sie kann sich also zurückverdienen. Ohne das wäre jedes Abschalten endgültig. Ist <b>„Automatisch nachregeln"</b> an, stellt der Tageslauf die Regler auf die gemessene Kante zurück — von Hand gesetzte Werte halten dauerhaft nur mit abgewähltem Häkchen.',
  'opt.autoNachregeln': 'Automatisch nachregeln (täglich, in Schritten von 0,25)',
  'opt.vorschlagUebernehmen': 'Vorschlag übernehmen',
  'opt.speichern': 'Speichern',
  'opt.einstellungenPruefen': 'Einstellungen prüfen',
  'opt.jetztPruefen': 'Jetzt prüfen',
  'opt.ausgewaehlteUebernehmen': 'Ausgewählte übernehmen',
  'opt.loadouts': 'Loadouts',
  'opt.loadoutsHint':
    'Vorgefertigte Grundeinstellungen als Startpunkt — danach stellst du weiter frei ein, und der Selbstoptimierer lernt normal weiter. Watchlist, Kapital und dein Start/Stop-Schalter bleiben <b>immer</b> deine.',
  'opt.uebernehmen': 'Übernehmen',
  'opt.loName': 'Aktuellen (gespeicherten) Stand sichern als …',
  'opt.alsLoadoutSpeichern': 'Als Loadout speichern',
  'opt.bewaehrt': 'Bewährte Einstellungen',
  'opt.lade': 'Lade …',
  'opt.unterschiedeAnsehen': 'Unterschiede ansehen',
  'opt.notbremse': 'Tages-Notbremse',
  'opt.notbremseLoesen': 'Notbremse lösen',
  // Optionen-Modal, Tabs „Broker & Echtgeld" + „Konto & Steuer" (Tranche 3b).
  // Die Bestätigungs-Wörter RESET und ECHTGELD sind serverseitig gepinnt und
  // bleiben in JEDER Sprache wörtlich stehen — nur der Satz drumherum wird
  // übersetzt.
  'opt.echtgeldAnbindung': 'Echtgeld-Anbindung',
  'opt.brokerHint':
    'Prüft die Verbindung zum Broker, <b>ohne zu handeln</b>, und gleicht das eigene Buch mit dem Depot beim Broker ab. Echtgeld verlangt zwei Schalter an zwei Orten — ein Klick allein schaltet nichts scharf.',
  'opt.verbinden': 'Verbinden',
  'opt.liveKeyWarnung':
    '<b>Das ist ein Echtgeld-Schlüssel (AK…).</b> Er wird verschlüsselt gespeichert und nie wieder angezeigt. <b>Gehandelt wird damit nicht:</b> Dafür braucht es zusätzlich den Live-Modus in den Einstellungen, die Server-Freigabe und eine bestandene Live-Reife. Bis dahin siehst du dein echtes Depot nur im Abgleich.',
  'opt.reauthHint':
    'Zur Sicherheit muss deine Anmeldung frisch sein — eine übernommene, offene Sitzung soll genau das hier nicht können.',
  'opt.pwPlatzhalter': 'Dein autotrd-Passwort zur Bestätigung',
  'opt.pkAkHint':
    '<b>Papierkonto-Schlüssel</b> beginnen mit „PK", <b>Echtgeld-Schlüssel</b> mit „AK". Das Papierkonto ist bei Alpaca gratis und sofort da — fang damit an.',
  'opt.linkKonto': '1. Konto anlegen',
  'opt.linkKeys': '2. Paper-Dashboard → API-Keys erzeugen',
  'opt.linkDoku': 'Dokumentation',
  'opt.verbindungPruefen': 'Verbindung prüfen',
  'opt.trennen': 'Trennen',
  'opt.depotUebernehmen': 'Depot vom Broker übernehmen',
  'opt.depotUebernehmenHint':
    'Holt Positionen, Einstände, Barbestand und die von autotrd gesendeten Orders vom Broker ins Buch — <b>es wird nichts gekauft oder verkauft</b>. Für den Fall, dass Buch und Depot auseinandergelaufen sind (z. B. nach „Neu anfangen" mit verbundenem Broker). Buch-Positionen ohne Gegenstück beim Broker werden dabei entfernt; Stops kommen neu aus deiner aktuellen Strategie.',
  'opt.scharfStellen': 'Echtgeld scharf stellen',
  'opt.scharfHint':
    'Es geht los, wenn <b>beides</b> gilt: Dieser Schalter steht auf ECHTGELD <b>und</b> die Trading-Engine steht auf <b>Start</b>. Ein Schalter allein handelt nicht.',
  'opt.echtgeldWarnung':
    '<b>Ab jetzt fließt echtes Geld.</b> Die Engine kauft und verkauft selbstständig auf deinem Alpaca-Echtgeldkonto — ohne weitere Rückfrage, rund um die Uhr für Krypto, zu Börsenzeiten für den Rest. Verluste sind real und nicht rückgängig zu machen.',
  'opt.echtgeldTippen':
    'Zum Bestätigen <b>ECHTGELD</b> tippen. Deine Anmeldung muss dabei frisch sein — du wirst nach deinem Passwort gefragt.',
  'opt.pwKurz': 'Dein Passwort',
  'opt.aufEchtgeld': 'Auf ECHTGELD umstellen',
  'opt.zurueckPapier': 'Zurück auf Papierhandel',
  'opt.stoppWasPassiert':
    '<b>Was passiert beim Stoppen?</b> Die Engine legt sofort die Hände in den Schoß: keine neuen Käufe, keine Verkäufe, auch keine Stop-Loss- oder Take-Profit-Ausführungen. Dein Depot bleibt <b>exakt so stehen, wie es ist</b> — es wird nichts glattgestellt. Das ist gewollt, hat aber eine Kehrseite: Ein gestopptes Konto ist auch ein <b>ungeschütztes</b> Konto. Wer über Nacht stoppt und Positionen offen lässt, hat keinen Stop-Loss mehr. Für längere Pausen deshalb besser: Positionen von Hand schließen, dann stoppen.',
  'opt.konto': 'Konto',
  'opt.angemeldetAls': 'Angemeldet als',
  'opt.abmelden': 'Abmelden',
  'opt.steuerExport': 'Steuer-Export',
  'opt.steuerHint':
    'Paart Käufe und Verkäufe nach <b>FIFO</b>, rechnet Haltedauern und sortiert die Ergebnisse in die Töpfe, die das deutsche Recht getrennt hält. Bei Krypto zählt die <b>Ein-Jahres-Frist</b> — danach steuerfrei. Keine Steuerberatung: Die Zahlen sind eine Aufbereitung für deinen Steuerberater, keine Steuerschuld.',
  'opt.nurEchtgeld': 'nur Echtgeld',
  'opt.berichtErstellen': 'Bericht erstellen',
  'opt.neuAnfangen': 'Neu anfangen',
  'opt.resetHint':
    'Setzt <b>Handelshistorie, offene Positionen, Kontostand und Kennzahlen</b> auf null zurück. Kursdaten, Prognose-Trefferquoten und deine Strategien bleiben. Nicht rückgängig zu machen.',
  'opt.resetTippen': 'RESET tippen',
  'opt.kontoZuruecksetzen': 'Konto zurücksetzen',
  'opt.startVomBroker':
    'Startkapital vom verbundenen Broker übernehmen (statt der Zahl oben)',
  // Panel-Titel (Tranche 4): EIN Schlüsselsatz für Modul-Checkboxen,
  // Palette und Karten-Köpfe. Wo der Karten-Kopf mehr sagt als der
  // Modul-Name (Chart, Positionen, Markt-Uhr), gibt es beide Fassungen.
  'panel.strategie': 'Strategie',
  'panel.engine': 'Engine',
  'panel.historie': 'Trade-Historie',
  'panel.journal': 'Trade-Journal',
  'panel.chart': 'Chart',
  'panel.chartKopf': 'Chart · Candlestick + Volumen',
  'panel.indikatorKacheln': 'Indikator-Kacheln',
  'panel.autoSignale': 'Auto-Signale',
  'panel.positionen': 'Positionen',
  'panel.positionenKopf': 'Aktive Positionen',
  'panel.markt': 'Markt-Übersicht',
  'panel.performance': 'Performance',
  'panel.manuellerTrade': 'Manueller Trade',
  'panel.marktUhr': 'Markt-Uhr',
  'panel.marktUhrKopf': 'Markt-Uhr (ET)',
  'panel.prognoseGenauigkeit': 'Prognose-Genauigkeit',
  'panel.prognoseLabor': 'Prognose-Labor',
  'panel.momentum': 'Momentum-Ranking',
  'panel.autoTuner': 'Auto-Tuner',
  'panel.struktursuche': 'Struktursuche',
  'panel.vergleichsChart': 'Vergleichs-Chart',
  'panel.haltedauer': 'Wie lange halten?',
  'panel.erkenntnisse': 'Was das System gelernt hat',
  'auth.falscheDaten': 'E-Mail oder Passwort ist falsch.',
  'auth.ungueltigeEmail': 'Das ist keine gültige E-Mail-Adresse.',
  'auth.emailVergeben': 'Für diese E-Mail existiert bereits ein Konto.',
  'auth.schwachesPasswort': 'Das Passwort ist zu schwach (mindestens 6 Zeichen).',
  'auth.zuVieleVersuche': 'Zu viele Versuche — bitte kurz warten.',
  'auth.googleAbgebrochen': 'Google-Anmeldung abgebrochen.',
  'auth.fehlgeschlagen': 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.',
} as const;

export type TextSchluessel = keyof typeof DE;

/**
 * Englisches Wörterbuch — darf Lücken haben (dann greift der Fallback),
 * aber KEINE Schlüssel außerhalb von `DE` (Karteileichen-Test).
 */
export const EN: Partial<Record<TextSchluessel, string>> = {
  'login.sub': 'Automated trading · paper & broker connection · not investment advice',
  'login.email': 'Email',
  'login.passwort': 'Password',
  'login.anmelden': 'Sign in',
  'login.registrieren': 'Sign up',
  'login.passwortVergessen': 'Forgot password?',
  'login.oder': 'or',
  'login.mitGoogle': 'Sign in with Google',
  'login.emailFehlt': 'Please enter your email address above.',
  'login.resetUnterwegs': 'Password reset email is on its way (check your spam folder).',
  'nav.panelLinks': 'Left panel',
  'nav.panelRechts': 'Right panel',
  'nav.engineAus': 'Engine off',
  'nav.engineAn': 'Engine on',
  'nav.optionenTitle': 'Options: elements, modules & paper wallet',
  'nav.tourTitle': 'Tour: the key areas in one minute',
  'nav.spalteLinks': 'Show/hide left column',
  'nav.spalteRechts': 'Show/hide right column',
  'opt.titel': 'Options',
  'opt.tabAnzeige': 'Display',
  'opt.tabTrading': 'Trading',
  'opt.tabBroker': 'Broker &amp; live trading',
  'opt.tabKonto': 'Account &amp; taxes',
  'opt.darstellung': 'Appearance',
  'opt.hellDunkel':
    '<b>Light/Dark</b> — “System” follows your device setting automatically; Light/Dark sets it permanently.',
  'opt.themeSystem': 'System',
  'opt.themeHell': 'Light',
  'opt.themeDunkel': 'Dark',
  'opt.sprache':
    '<b>Sprache / Language</b> — German is the default. English translates the interface step by step; texts not yet translated appear in German.',
  'opt.optionaleElemente': 'Optional elements',
  'opt.prognosePfeil':
    '<b>Forecast arrow</b> — draw your own price expectation on the chart; counts as a weighted vote in auto-trading. <i>Beta, off by default.</i>',
  'opt.vergleichsOverlay': '<b>Comparison overlay</b> — a second symbol as a % line on the main chart.',
  'opt.multiChartRaster': '<b>Multi-chart grid</b> — 1/2/4 charts side by side with lock sync.',
  'opt.indikatorExtras':
    '<b>Indicator extras</b> — VWAP (intraday) and RSI/MACD sub-panels below the main chart.',
  'opt.module': 'Modules',
  'opt.moduleHint':
    'Deselected modules disappear entirely (also works via ✕ on the module itself); ▾ on a module only collapses it. The selection syncs across your devices.',
  'opt.marktgruppen': 'Market groups',
  'opt.marktgruppenHint':
    'Deselected groups disappear from the market browser and watchlist picker (display only — data for all groups keeps running server-side).',
  'opt.paperWallet': 'Paper wallet · basics',
  'opt.startkapitalHint':
    'The <b>starting capital</b> does <b>not</b> change your current balance. It only applies on “Start over” at the very bottom — the wallet is then reset to this amount. Position sizes always use the <b>available cash</b>, never the starting capital.',
  'opt.kapitalPosition': 'Capital &amp; position size',
  'opt.startkapital': 'Starting capital $',
  'opt.investmentJeTrade': 'Investment per trade %',
  'opt.risikoJeTrade': 'Risk per trade %',
  'opt.maxPositionen': 'Max. concurrent positions',
  'opt.ruhigerSockel': 'Quiet core %',
  'opt.hebel': 'Leverage (margin)',
  'opt.hebel1': '1× — no leverage (default)',
  'opt.hebel2': '2× — only on very strong signals',
  'opt.hebel3': '3× — maximum',
  'opt.ausstiege': 'Exits',
  'opt.stopLoss': 'Stop loss %',
  'opt.takeProfit': 'Take profit %',
  'opt.trailing': 'Trailing stop %',
  'opt.maxHalte': 'Max. holding period (days)',
  'opt.atrStop': 'ATR stop (×ATR)',
  'opt.atrZiel': 'ATR target (×ATR)',
  'opt.signaleTakt': 'Signals &amp; cadence',
  'opt.signalZeitrahmen': 'Signal timeframe',
  'opt.tf5m': '5-minute (active)',
  'opt.tfDaily': 'Daily candles (calm)',
  'opt.kaufPause': 'Buy pause after a sell (min)',
  'opt.konfluenzEinstieg': 'Entry confluence',
  'opt.konfluenzAusstieg': 'Exit confluence',
  'opt.schutzschalter': 'Circuit breakers',
  'opt.kostenschwelle': 'Cost threshold (× fees)',
  'opt.tagesNotbremsePct': 'Daily loss brake (% loss)',
  'opt.flatten': 'On brake, additionally close all positions',
  'opt.regimeGate': 'Market light (no shorts in an uptrend, pause under stress)',
  'opt.newsVeto': 'News veto (suspend entries on hard events)',
  'opt.experimente': 'Experiments',
  'opt.shorten': 'Allow shorting (short sales)',
  'opt.nullSchaltetAb':
    '0 disables a rule; ATR values replace the fixed percentages. Everything else is explained by the ⓘ next to each field.',
  'opt.klassenKapital': 'Capital per asset class',
  'opt.klassenHint':
    'The dial multiplies the position size in this class: <b>0</b> = stops trading, <b>1</b> = normal, <b>1.5</b> = larger sizes. Open positions are always closed regardless — the dial only controls the <b>entry</b>. And: a class at 0 keeps being <b>measured</b> (shadow edge), so it can earn its way back. Without that, every shutdown would be final. If <b>“Auto-adjust”</b> is on, the daily run resets the dials to the measured edge — manually set values only persist with the checkbox unticked.',
  'opt.autoNachregeln': 'Auto-adjust (daily, in steps of 0.25)',
  'opt.vorschlagUebernehmen': 'Apply suggestion',
  'opt.speichern': 'Save',
  'opt.einstellungenPruefen': 'Review settings',
  'opt.jetztPruefen': 'Check now',
  'opt.ausgewaehlteUebernehmen': 'Apply selected',
  'opt.loadouts': 'Loadouts',
  'opt.loadoutsHint':
    'Ready-made base settings as a starting point — afterwards you keep tuning freely and the self-optimizer keeps learning as usual. Watchlist, capital and your start/stop switch always remain <b>yours</b>.',
  'opt.uebernehmen': 'Apply',
  'opt.loName': 'Save the current (saved) state as …',
  'opt.alsLoadoutSpeichern': 'Save as loadout',
  'opt.bewaehrt': 'Proven settings',
  'opt.lade': 'Loading …',
  'opt.unterschiedeAnsehen': 'View differences',
  'opt.notbremse': 'Daily loss brake',
  'opt.notbremseLoesen': 'Release the brake',
  'opt.echtgeldAnbindung': 'Live-money connection',
  'opt.brokerHint':
    'Checks the connection to the broker, <b>without trading</b>, and reconciles your own book with the depot at the broker. Live money requires two switches in two places — a single click arms nothing.',
  'opt.verbinden': 'Connect',
  'opt.liveKeyWarnung':
    '<b>This is a live-money key (AK…).</b> It is stored encrypted and never shown again. <b>It does not trade:</b> that additionally requires live mode in the settings, the server-side approval and a passed live-readiness check. Until then you only see your real depot in the reconciliation.',
  'opt.reauthHint':
    'For safety your sign-in must be fresh — a hijacked open session must not be able to do exactly this.',
  'opt.pwPlatzhalter': 'Your autotrd password to confirm',
  'opt.pkAkHint':
    '<b>Paper-account keys</b> start with “PK”, <b>live-money keys</b> with “AK”. The paper account is free at Alpaca and available immediately — start with that.',
  'opt.linkKonto': '1. Create an account',
  'opt.linkKeys': '2. Paper dashboard → generate API keys',
  'opt.linkDoku': 'Documentation',
  'opt.verbindungPruefen': 'Check connection',
  'opt.trennen': 'Disconnect',
  'opt.depotUebernehmen': 'Adopt depot from broker',
  'opt.depotUebernehmenHint':
    'Fetches positions, cost bases, cash and the orders sent by autotrd from the broker into the book — <b>nothing is bought or sold</b>. For the case that book and depot have drifted apart (e.g. after “Start over” with a connected broker). Book positions without a counterpart at the broker are removed; stops are re-derived from your current strategy.',
  'opt.scharfStellen': 'Arm live trading',
  'opt.scharfHint':
    'It starts when <b>both</b> hold: this switch is set to ECHTGELD <b>and</b> the trading engine is set to <b>Start</b>. One switch alone does not trade.',
  'opt.echtgeldWarnung':
    '<b>From now on real money flows.</b> The engine buys and sells autonomously on your Alpaca live account — without further confirmation, around the clock for crypto, during market hours for the rest. Losses are real and cannot be undone.',
  'opt.echtgeldTippen':
    'Type <b>ECHTGELD</b> to confirm. Your sign-in must be fresh — you will be asked for your password.',
  'opt.pwKurz': 'Your password',
  'opt.aufEchtgeld': 'Switch to ECHTGELD (live)',
  'opt.zurueckPapier': 'Back to paper trading',
  'opt.stoppWasPassiert':
    '<b>What happens on stop?</b> The engine immediately folds its hands: no new buys, no sells, not even stop-loss or take-profit executions. Your depot stays <b>exactly as it is</b> — nothing is flattened. That is intended, but has a flip side: a stopped account is also an <b>unprotected</b> account. If you stop overnight with open positions, you have no stop loss anymore. For longer breaks, better: close positions manually, then stop.',
  'opt.konto': 'Account',
  'opt.angemeldetAls': 'Signed in as',
  'opt.abmelden': 'Sign out',
  'opt.steuerExport': 'Tax export',
  'opt.steuerHint':
    'Pairs buys and sells by <b>FIFO</b>, computes holding periods and sorts the results into the buckets German law keeps separate. For crypto the <b>one-year period</b> applies — tax-free afterwards. Not tax advice: the numbers are a preparation for your tax advisor, not a tax liability.',
  'opt.nurEchtgeld': 'live money only',
  'opt.berichtErstellen': 'Create report',
  'opt.neuAnfangen': 'Start over',
  'opt.resetHint':
    'Resets <b>trade history, open positions, balance and metrics</b> to zero. Price data, forecast hit rates and your strategies remain. Cannot be undone.',
  'opt.resetTippen': 'Type RESET',
  'opt.kontoZuruecksetzen': 'Reset account',
  'opt.startVomBroker':
    'Adopt starting capital from the connected broker (instead of the number above)',
  'panel.strategie': 'Strategy',
  'panel.engine': 'Engine',
  'panel.historie': 'Trade history',
  'panel.journal': 'Trade journal',
  'panel.chart': 'Chart',
  'panel.chartKopf': 'Chart · candlestick + volume',
  'panel.indikatorKacheln': 'Indicator tiles',
  'panel.autoSignale': 'Auto signals',
  'panel.positionen': 'Positions',
  'panel.positionenKopf': 'Open positions',
  'panel.markt': 'Market overview',
  'panel.performance': 'Performance',
  'panel.manuellerTrade': 'Manual trade',
  'panel.marktUhr': 'Market clock',
  'panel.marktUhrKopf': 'Market clock (ET)',
  'panel.prognoseGenauigkeit': 'Forecast accuracy',
  'panel.prognoseLabor': 'Forecast lab',
  'panel.momentum': 'Momentum ranking',
  'panel.autoTuner': 'Auto-tuner',
  'panel.struktursuche': 'Structure search',
  'panel.vergleichsChart': 'Comparison chart',
  'panel.haltedauer': 'How long to hold?',
  'panel.erkenntnisse': 'What the system has learned',
  'auth.falscheDaten': 'Email or password is incorrect.',
  'auth.ungueltigeEmail': 'That is not a valid email address.',
  'auth.emailVergeben': 'An account already exists for this email.',
  'auth.schwachesPasswort': 'The password is too weak (at least 6 characters).',
  'auth.zuVieleVersuche': 'Too many attempts — please wait a moment.',
  'auth.googleAbgebrochen': 'Google sign-in was cancelled.',
  'auth.fehlgeschlagen': 'Sign-in failed. Please try again.',
};

/**
 * Pure Übersetzungs-Regel — als eigene Funktion, damit der Test die
 * Fallback-Semantik mit beliebigen Wörterbüchern prüfen kann, ohne
 * localStorage zu stubben.
 */
export function uebersetze(
  schluessel: TextSchluessel,
  sprache: Sprache,
  en: Partial<Record<TextSchluessel, string>> = EN,
): string {
  if (sprache === 'en') {
    const u = en[schluessel];
    if (typeof u === 'string' && u.length > 0) return u;
  }
  return DE[schluessel];
}

/** Gewählte Sprache — alles außer ausdrücklichem 'en' ist Deutsch. */
export function sprachWahl(): Sprache {
  try {
    return localStorage.getItem('autotrd-lang') === 'en' ? 'en' : 'de';
  } catch {
    return 'de';
  }
}

/** Wahl speichern — das Anwenden (Neu-Rendern) entscheidet der Aufrufer. */
export function setzeSprache(sprache: Sprache): void {
  localStorage.setItem('autotrd-lang', sprache);
}

/** Der Übersetzer fürs UI: deutscher Text oder seine englische Fassung. */
export function t(schluessel: TextSchluessel): string {
  return uebersetze(schluessel, sprachWahl());
}
