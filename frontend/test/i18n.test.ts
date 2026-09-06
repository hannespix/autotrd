/**
 * Sprachumschalter — die Fallback-Regel ist das Fundament.
 *
 * Deutsch ist die Quelle der Wahrheit; Englisch darf lücken, aber nie
 * erfinden. Der Golden-Wächter pinnt die deutschen Texte, die den Umbau auf
 * den Auto-Trader UNVERÄNDERT überstehen mussten (Login, Risiko, Optionen,
 * Kopfleiste): Im DE-Modus rendert die App nachweislich dieselben Texte wie
 * vor dem Umbau — damit ist „kaputtmachen" strukturell ausgeschlossen.
 *
 * Dazu die Anschluss-Wächter (die Funktion ist verdrahtet, nicht nur
 * vorhanden) und das datei-weite Netz gegen deutschen Anzeigetext außerhalb
 * des Wörterbuchs.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DE, EN, serverText, sprachWahl, uebersetze, type TextSchluessel } from '../src/i18n.js';

const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
const auth = readFileSync(join(import.meta.dirname, '..', 'src', 'auth.ts'), 'utf8');
const dashboard = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard.ts'), 'utf8');
const legal = readFileSync(join(import.meta.dirname, '..', 'src', 'legal.ts'), 'utf8');

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

  it('jeder Schlüssel, den der Quelltext zieht, existiert im Wörterbuch', () => {
    /* `t()` ist typisiert — ein Tippfehler fällt schon im Typecheck auf.
     * Hier geht es um die Gegenrichtung des Bundles: JEDER Schlüssel des
     * Wörterbuchs wird auch gezogen (oder gehört zu einer Familie, die
     * dynamisch aufgelöst wird: srv./val./lv.krit.). Karteileichen kosten
     * sonst still Bundle-Bytes — beim Umbau auf den Auto-Trader waren es
     * über tausend. */
    const src = join(import.meta.dirname, '..', 'src');
    const alle = readdirSync(src)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(src, f), 'utf8'))
      .join('\n');
    // infotips.ts importiert t als `uebersetzt` — derselbe Aufruf, anderer Name.
    const gezogen = new Set([...alle.matchAll(/\b(?:t|uebersetzt)\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]!));
    const dynamisch = /^(srv|val|lv\.krit)\./;
    const leichen = Object.keys(DE).filter((k) => !gezogen.has(k) && !dynamisch.test(k));
    expect(leichen, `Wörterbuch-Zeilen ohne Aufruf: ${leichen.join(', ')}`).toEqual([]);
  });
});

describe('Sprachwahl', () => {
  it("Standard ist 'de' — auch ohne localStorage oder mit Unsinn darin", () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(sprachWahl()).toBe('de');
    vi.stubGlobal('localStorage', { getItem: () => 'quatsch' });
    expect(sprachWahl()).toBe('de');
    vi.stubGlobal('localStorage', { getItem: () => 'en' });
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

  it('die Risiko-Zeile ist Text-Diät-Tabu und bleibt wörtlich', () => {
    expect(DE['login.risikoHaken']).toContain('Mir ist bewusst, dass autotrd keine Anlageberatung ist');
    expect(DE['login.risikoHaken']).toContain('Totalverlust');
    expect(DE['login.risikoFehlt']).toBe('Bitte den Risikohinweis bestätigen — ohne das entsteht kein Konto.');
  });

  it('die deutschen Optionen-Texte (Anzeige, Broker, Konto) sind byte-gleich zum Bestand', () => {
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
    expect(DE['opt.echtgeldAnbindung']).toBe('Echtgeld-Anbindung');
    expect(DE['opt.verbinden']).toBe('Verbinden');
    expect(DE['opt.verbindungPruefen']).toBe('Verbindung prüfen');
    expect(DE['opt.trennen']).toBe('Trennen');
    expect(DE['opt.scharfStellen']).toBe('Echtgeld scharf stellen');
    expect(DE['opt.aufEchtgeld']).toBe('Auf ECHTGELD umstellen');
    expect(DE['opt.zurueckPapier']).toBe('Zurück auf Papierhandel');
    expect(DE['opt.konto']).toBe('Konto');
    expect(DE['opt.angemeldetAls']).toBe('Angemeldet als');
    expect(DE['opt.abmelden']).toBe('Abmelden');
    expect(DE['opt.steuerExport']).toBe('Steuer-Export');
    expect(DE['opt.neuAnfangen']).toBe('Neu anfangen');
    expect(DE['opt.resetTippen']).toBe('RESET tippen');
    expect(DE['opt.kontoZuruecksetzen']).toBe('Konto zurücksetzen');
  });

  it('die Bestätigungs-Wörter RESET und ECHTGELD bleiben in JEDER Sprache wörtlich', () => {
    // Sie sind serverseitig gepinnt — ein übersetztes Wort würde immer abgelehnt.
    expect(dashboard).toContain("const RESET_CONFIRM_WORD = 'RESET';");
    expect(dashboard).toContain('placeholder="ECHTGELD"');
    expect(EN['opt.resetTippen']).toContain('RESET');
    expect(EN['opt.aufEchtgeld']).toContain('ECHTGELD');
    expect(EN['opt.echtgeldTippen']).toContain('ECHTGELD');
  });

  it('die deutschen Kopfleisten- und Karten-Titel sind byte-gleich zum Bestand', () => {
    expect(DE['nav.engineAus']).toBe('Engine aus');
    expect(DE['nav.engineAn']).toBe('Engine an');
    expect(DE['nav.panelLinks']).toBe('Linkes Panel');
    expect(DE['nav.panelRechts']).toBe('Rechtes Panel');
    expect(DE['panel.engine']).toBe('Engine');
    expect(DE['panel.historie']).toBe('Trade-Historie');
    expect(DE['panel.positionenKopf']).toBe('Aktive Positionen');
    expect(DE['panel.performance']).toBe('Performance');
    expect(DE['legal.zeile']).toBe('Trading birgt erhebliche Verlustrisiken — keine Anlageberatung.');
    expect(EN['legal.zeile']).toBe('Trading involves a substantial risk of loss — this is not investment advice.');
    expect(DE['legal.risikohinweis']).toBe('Risikohinweis');
    expect(DE['legal.impressum']).toBe('Impressum');
    expect(DE['legal.datenschutz']).toBe('Datenschutz');
  });

  it('die Warntexte des Not-Aus und der Engine-Karte behalten ihre Schärfe', () => {
    expect(DE['lay.notausHinweis']).toBeTruthy();
    expect(EN['lay.notausHinweis']).toBeTruthy();
    expect(DE['acc.blocked']).toContain('gesperrt');
    expect(DE['eng.schalterHint']).toContain('Stops beim Broker');
  });
});

describe('Anschluss-Wächter — die Funktion ist verdrahtet, nicht nur vorhanden', () => {
  it('renderLogin zieht seine Texte über t()', () => {
    for (const k of [
      "t('login.sub')", "t('login.email')", "t('login.passwort')", "t('login.anmelden')",
      "t('login.registrieren')", "t('login.passwortVergessen')", "t('login.oder')",
      "t('login.mitGoogle')", "t('login.emailFehlt')", "t('login.risikoHaken')",
      "t('login.risikoLink')", "t('login.risikoFehlt')", "t('login.resetUnterwegs')",
    ]) {
      expect(main).toContain(k);
    }
    expect(main).not.toContain('>Anmelden<');
    expect(main).not.toContain('>Mit Google anmelden<');
  });

  it('authErrorMessage übersetzt über t()', () => {
    expect(auth).toContain("t('auth.falscheDaten')");
    expect(auth).toContain("t('auth.fehlgeschlagen')");
  });

  it('die Kopfleiste zieht ihre Texte über t() — Badge inklusive Umschalter', () => {
    for (const k of ["t('nav.panelLinks')", "t('nav.panelRechts')", "t('nav.engineAus')", "t('nav.optionenTitle')"]) {
      expect(dashboard).toContain(k);
    }
    expect(dashboard).toContain("running ? t('nav.engineAn') : t('nav.engineAus')");
    expect(dashboard).not.toContain('>Engine aus</div>');
    expect(dashboard).not.toContain('aria-label="Linkes Panel"');
  });

  it('der Legal-Footer zieht Beschriftungen über t(), die Rechtstexte bleiben deutsch', () => {
    for (const k of ["t('legal.zeile')", "t('legal.risikohinweis')", "t('legal.impressum')", "t('legal.datenschutz')"]) {
      expect(legal).toContain(k);
    }
    expect(legal).not.toContain('<span>Trading birgt erhebliche');
    // Impressum/Datenschutz sind deutsches Recht — Projektentscheidung.
    expect(legal).toContain("disclaimer: 'Risikohinweis',");
  });

  it('die Karten des Auto-Traders ziehen ihre Titel über t()', () => {
    for (const k of [
      "t('panel.engine')", "t('panel.einstellungen')", "t('panel.positionenKopf')",
      "t('lay.engineWhyKopf')", "t('panel.champion')", "t('panel.historie')", "t('panel.performance')",
    ]) {
      expect(dashboard).toContain(k);
    }
  });

  it('die Sprachwahl sitzt in Optionen → Anzeige und wird angewandt', () => {
    expect(dashboard).toContain('<option value="de">Deutsch</option>');
    expect(dashboard).toContain('<option value="en">English</option>');
    expect(dashboard).toContain("setzeSprache(ouLang.value === 'en' ? 'en' : 'de');");
  });

  it('der Speichern-Zwischenstand vergleicht übersetzt, nicht auf Deutsch', () => {
    /* Der Merker in der Einstellungs-Karte („⚠ Noch nicht gespeichert")
     * darf sich nicht über die laufende Speicher-Meldung legen. Ein Vergleich
     * über startsWith('Speichere') wäre auf Englisch IMMER falsch. */
    expect(dashboard).toContain("m.textContent !== t('mt.speichere')");
    expect(dashboard).not.toContain("startsWith('Speichere')");
  });
});

describe('Englische Fassung der Auto-Trader-Oberfläche', () => {
  it('jede Zeile der neuen Präfixe hat eine englische Fassung', () => {
    const re = /^(eng|as|ch|cmd|ew|halt|pos|gp|acc|fd|adm|br|tax|lv|pf|ps|kv|jn|tab|zr|opt|nav|panel|lay|mt|bk|legal|login|auth|mn|pw|tip|srv|val)\./;
    for (const k of Object.keys(DE).filter((s) => re.test(s))) {
      expect(EN[k as TextSchluessel], `${k} ohne englische Fassung`).toBeTruthy();
    }
  });

  it('die Halt-Gründe und Kommando-Texte sind wirklich übersetzt, nicht kopiert', () => {
    for (const k of ['halt.dailyLoss', 'halt.drawdown', 'cmd.resumeText', 'cmd.flattenText', 'ew.g.taktSteht', 'as.hint'] as const) {
      expect(EN[k], `${k} nur kopiert`).not.toBe(DE[k]);
    }
  });
});

/* Deutsche Alltags- und Fachwörter, an denen der Wächter deutschen
 * Anzeigetext erkennt — auch umlautfreie wie „Kauf", „Gesamt", „starten". */
const DEUTSCHE_WORTE =
  /[ÄÖÜäöüß]|\b(der|die|das|den|und|oder|nicht|kein|keine|noch|wird|ist|sind|von|zum|zur|bitte|mehr|dein|deine|ohne|seit|jetzt|alle|wenn|wurde|kommt|Bitte|warten|Kauf|Verkauf|Uhr|Tag|Tage|Woche|Monat|geladen|gespeichert|fehlgeschlagen|entfernen|bestätigen|Kaufen|Verkaufen|Kaufkraft|Gesamt|Zwischensumme|starten|stoppen|gestoppt|einstellen|einblenden|ausblenden|lassen|zoomen|Historie|Vorhersage|Prognose|Periode|Handelstag|Kerzen|Speichere|wechseln|Statistik|Fenster|synchron)\b/;

function deutscheTreffer(quelle: string, erlaubt: ReadonlySet<string>): string[] {
  const code = quelle
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML-Kommentare im Template — bleiben deutsch
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/t\('[^']+'\)/g, ' ')
    .replace(/\$\('[^']+'\)/g, ' ')
    .replace(/console\.\w+\(\s*'[^']*'/g, ' ') // Entwickler-Logs bleiben deutsch
    .replace(/toLocaleDateString\('de-DE'/g, ' ')
    .replace(/toLocaleString\('de-DE'/g, ' ');
  const treffer: string[] = [];
  for (const m of code.matchAll(/'([^'\n]*)'/g)) {
    const roh = m[1]!;
    if (erlaubt.has(roh)) continue;
    if (DEUTSCHE_WORTE.test(roh) && /[A-Za-zÄÖÜäöüß]{3,}/.test(roh)) treffer.push(roh.slice(0, 60));
  }
  for (const m of code.matchAll(/`([^`]*)`/g)) {
    const roh = m[1]!.replace(/\$\{[^{}]*\}/g, ' ');
    if (DEUTSCHE_WORTE.test(roh) && /[A-Za-zÄÖÜäöüß]{3,}/.test(roh)) treffer.push(roh.slice(0, 60));
  }
  return [...new Set(treffer)];
}

describe('Der datei-weite Rückfall-Wächter', () => {
  it('kein deutscher Anzeigetext mehr in irgendeiner Funktion von dashboard.ts', () => {
    /* Ausnahmen sind NAMENTLICH gelistet, als ganze Zeichenkette — nicht als
     * Muster, das man dehnen kann. */
    const ERLAUBT = new Set<string>([
      'Ältere Trades nicht ladbar:', // console.warn-Text (Entwickler-Log)
    ]);
    const treffer = deutscheTreffer(dashboard, ERLAUBT);
    expect(
      treffer,
      `deutscher Anzeigetext außerhalb des Wörterbuchs: ${treffer.join(' | ')}`,
    ).toEqual([]);
  });

  it('der Wächter erkennt einen eingebauten Fehler', () => {
    expect(deutscheTreffer("el.textContent = 'Bitte warten';", new Set())).toEqual(['Bitte warten']);
  });

  /* Dasselbe Netz über den GANZEN src-Ordner per readdirSync — eine
   * künftige Datei ist automatisch erfasst. Ausnahmen mit Grund:
   *  - i18n.ts:      das Wörterbuch selbst.
   *  - legal.ts:     Rechtstexte bleiben bewusst deutsch (deutsches Recht).
   *  - infotips.ts:  führt sein EIGENES zweisprachiges Wörterbuch.
   *  - dashboard.ts: hat oben seinen eigenen Wächter. */
  const AUSGENOMMEN = new Set(['i18n.ts', 'legal.ts', 'infotips.ts', 'dashboard.ts']);
  // Code-Werte, die wie deutsche Wörter aussehen: Firestore-Feldnamen und Typ-Literale.
  const CODE_WERTE = new Set(['von', 'keine']);
  const srcDir = join(import.meta.dirname, '..', 'src');
  for (const datei of readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !AUSGENOMMEN.has(f))) {
    it(`${datei}: kein deutscher Anzeigetext außerhalb des Wörterbuchs`, () => {
      const treffer = deutscheTreffer(readFileSync(join(srcDir, datei), 'utf8'), CODE_WERTE);
      expect(treffer, `${datei}: ${treffer.join(' | ')}`).toEqual([]);
    });
  }
});

describe('serverText — Server-Fehlercodes auflösen', () => {
  it('übersetzt einen bekannten srv.*-Code in die gewählte Sprache', () => {
    expect(serverText(new Error('srv.anmeldungErforderlich'))).toBe('Anmeldung erforderlich');
    expect(EN['srv.anmeldungErforderlich']).toBe('Sign-in required');
  });

  it('setzt bei Parameter-Codes den Wert hinter dem ersten | in {0} ein', () => {
    expect(serverText(new Error('srv.tageslimitSpeicherungen|300'))).toContain('300');
    // Der Wert darf selbst | enthalten (durchgereichte Broker-Meldung) —
    // er bleibt in einem Stück, weil nur am ERSTEN | getrennt wird.
    expect(serverText(new Error('srv.verbindungFehlgeschlagen|a|b'))).toBe(
      'Verbindung fehlgeschlagen: a|b',
    );
    expect(serverText(new Error('srv.resetBestaetigen|RESET'))).toContain('RESET');
  });

  it('kennt die Codes des Engine-Takts', () => {
    // Das Kommando-Callable lehnt ohne Broker ab — ein roher Code wäre hier
    // die schlechteste aller Meldungen.
    expect(DE['srv.keinBrokerFuerKommando']).toBeTruthy();
    expect(EN['srv.keinBrokerFuerKommando']).toBeTruthy();
  });

  it('reicht Unbekanntes wortwörtlich durch — nie eine leere Meldung', () => {
    expect(serverText(new Error('internal'))).toBe('internal');
    expect(serverText(new Error('srv.nochNichtVergeben'))).toBe('srv.nochNichtVergeben');
    expect(serverText('roher String')).toBe('roher String');
    expect(serverText(undefined)).toBe('');
  });

  it('kein rohes e.message mehr in dashboard.ts — jede Anzeige läuft über serverText', () => {
    expect(dashboard).toContain('serverText(e)');
    expect(dashboard.match(/\be\.message\b/g) ?? []).toEqual([]);
  });
});
