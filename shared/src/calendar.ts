/**
 * Termin-Kalender (Owner-Anstoß 04.08. über FinancialJuice) — Stufe 1: messen.
 *
 * ── Warum Kalender und nicht Squawk ────────────────────────────────────────
 *
 * Der Owner fragte nach FinancialJuice, einem Echtzeit-Nachrichtenticker für
 * Trader. Der Live-Test ergab: keine öffentliche API, kein RSS (alle Pfade
 * 404 bzw. Weiterleitung auf die Fehlerseite), auch über Google News kein
 * Zugriff — das Produkt ist bewusst hinter einem Login. Erreichbar wäre es
 * nur per Scraping, und eine Quelle, die jederzeit stillschweigend versiegen
 * kann, taugt nicht als Fundament einer Handelsentscheidung.
 *
 * Der wertvolle Teil eines solchen Dienstes ist ohnehin nicht die Meldung um
 * 14:30, sondern das Wissen, DASS um 14:30 etwas kommt. Und das ist gratis,
 * weil es sich RECHNEN lässt: Die US-Arbeitsmarktdaten erscheinen am ersten
 * Freitag des Monats, die Fed tagt an acht im Voraus veröffentlichten
 * Terminen. Kein Abo, keine fremde API, kein Ausfallrisiko.
 *
 * ── Was der Kalender bewirken soll ─────────────────────────────────────────
 *
 * Um solche Termine springen Kurse, statt zu laufen — dieselbe Mechanik wie
 * beim News-Veto (29.07.): RSI, MACD und Bollinger sagen über Sprünge
 * nichts, und ein Stop schützt nicht, weil bei einer Kurslücke zum nächsten
 * Kurs ausgeführt wird, nicht zum Stop-Kurs. Kurz VOR dem Termin ist also
 * der schlechteste Moment für einen neuen Einstieg.
 *
 * Der Turn-of-the-Month-Effekt ist die zweite, ganz andere Sache in dieser
 * Datei: In den letzten zwei und ersten drei Handelstagen eines Monats
 * fließen Gehälter und Fondsbeiträge in den Markt. Der Effekt ist seit
 * Jahrzehnten dokumentiert und braucht überhaupt keine Datenquelle — nur
 * das Datum.
 *
 * Stufe 1 heißt auch hier: rechnen und protokollieren, nicht steuern. Erst
 * wenn die Statistik über genug Termine zeigt, dass es sich lohnt, bekommt
 * der Kalender Einfluss — dieselbe Beweislast wie überall.
 */

/**
 * FOMC-Zinsentscheide (Datum in ET, Entscheid jeweils 14:00 ET).
 *
 * Der Fed-Kalender wird ein Jahr im Voraus veröffentlicht; diese Liste ist
 * das einzige, was hier von Hand gepflegt werden muss. Läuft sie ab, meldet
 * `fomcAbgelaufen()` das — eine stumm leerlaufende Liste wäre schlimmer als
 * gar keine, weil das System dann „nie ein Termin" meldet statt „ich weiß es
 * nicht mehr".
 */
export const FOMC_DATES: readonly string[] = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-16',
  '2027-07-28', '2027-09-22', '2027-11-03', '2027-12-15',
];

/** Stunden VOR einem Termin, in denen keine neuen Einstiege sinnvoll sind. */
export const EVENT_VORLAUF_H = 12;
/** Handelstage am Monatsende, die zum Turn-of-the-Month-Fenster zählen. */
export const TOM_ENDE_TAGE = 2;
/** Handelstage am Monatsanfang, die dazuzählen. */
export const TOM_ANFANG_TAGE = 3;

export type EventKind = 'fomc' | 'nfp' | 'cpi';

export interface CalendarReading {
  /** Termin, der innerhalb des Vorlauffensters liegt (null = frei). */
  bevorstehend: EventKind | null;
  /** Stunden bis zum Termin (null, wenn keiner ansteht). */
  stundenBis: number | null;
  /** Liegt der Tag im Turn-of-the-Month-Fenster? */
  turnOfMonth: boolean;
  /** Ist die FOMC-Liste abgelaufen? Dann ist 'fomc' unzuverlässig. */
  fomcVeraltet: boolean;
}

/** UTC-Datum als `YYYY-MM-DD`. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Erster Freitag eines Monats — der US-Arbeitsmarktbericht (NFP).
 *
 * Der verlässlichste Termin im ganzen Kalender: seit Jahrzehnten unverändert,
 * 8:30 ET, und er bewegt jeden Markt gleichzeitig.
 */
export function ersterFreitag(jahr: number, monat0: number): Date {
  const d = new Date(Date.UTC(jahr, monat0, 1));
  // getUTCDay: 0=So … 5=Fr. Bis zum ersten Freitag vorspulen.
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * CPI-Termin (Verbraucherpreise) — Näherung.
 *
 * Anders als NFP folgt der CPI keiner exakten Regel; das BLS veröffentlicht
 * meist zwischen dem 10. und 15. des Monats. Als Näherung wird der 13.
 * genommen bzw. der nächste Werktag. Das ist bewusst UNGENAU und deshalb
 * getrennt benannt: Ein Fenster von zwölf Stunden um einen um ein bis zwei
 * Tage verschobenen Termin trifft die Volatilität nicht zuverlässig — die
 * Auswertung wird zeigen, ob die Näherung trägt oder ob der Termin
 * gepflegt werden muss wie FOMC.
 */
export function cpiNaeherung(jahr: number, monat0: number): Date {
  const d = new Date(Date.UTC(jahr, monat0, 13));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Ist die gepflegte FOMC-Liste noch gültig? */
export function fomcAbgelaufen(now: Date): boolean {
  const letzter = FOMC_DATES[FOMC_DATES.length - 1];
  return letzter === undefined || iso(now) > letzter;
}

/**
 * Turn-of-the-Month-Fenster.
 *
 * Gezählt wird in KALENDERTAGEN mit Wochenend-Korrektur statt in echten
 * Handelstagen: Ein Börsenfeiertagskalender wäre eine zweite Liste zum
 * Pflegen, und der Effekt ist ohnehin unscharf — ein um einen Tag
 * verschobenes Fenster ändert nichts an seiner Aussage. Krypto handelt
 * durchgehend, dort ist die Frage gegenstandslos.
 */
export function istTurnOfMonth(now: Date): boolean {
  const tag = now.getUTCDate();
  if (tag <= TOM_ANFANG_TAGE) return true;
  const letzterTag = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return tag > letzterTag - TOM_ENDE_TAGE;
}

/**
 * Was steht an? Pure Funktion über dem aktuellen Zeitpunkt.
 *
 * Geprüft wird ein Fenster von `EVENT_VORLAUF_H` Stunden VOR dem Termin.
 * Danach wird bewusst NICHT gesperrt: Die Volatilitäts-Ausdehnung nach einem
 * Termin ist die verlässlichste Bewegung des Monats — sie zu meiden hieße,
 * genau das wegzuwerfen, wofür man den Kalender gebaut hat.
 */
export function calendarReading(now: Date): CalendarReading {
  const jahr = now.getUTCFullYear();
  const monat0 = now.getUTCMonth();
  const stunden = (ziel: Date, uhrEt: number): number =>
    (ziel.getTime() + uhrEt * 3_600_000 - now.getTime()) / 3_600_000;

  // Kandidaten: dieser und der nächste Monat (ein Termin kann über die
  // Monatsgrenze in unser Fenster ragen).
  const kandidaten: Array<{ kind: EventKind; h: number }> = [];
  for (const versatz of [0, 1]) {
    const j = monat0 + versatz > 11 ? jahr + 1 : jahr;
    const m = (monat0 + versatz) % 12;
    // 8:30 ET ≈ 13:30 UTC (Sommerzeit) — die Stunde ist grob, das Fenster
    // ist zwölf Stunden breit; eine Stunde Zeitzonen-Ungenauigkeit spielt
    // darin keine Rolle.
    kandidaten.push({ kind: 'nfp', h: stunden(ersterFreitag(j, m), 13.5) });
    kandidaten.push({ kind: 'cpi', h: stunden(cpiNaeherung(j, m), 13.5) });
  }
  for (const d of FOMC_DATES) {
    // 14:00 ET ≈ 19:00 UTC
    kandidaten.push({ kind: 'fomc', h: stunden(new Date(`${d}T00:00:00Z`), 19) });
  }

  const imFenster = kandidaten
    .filter((k) => k.h > 0 && k.h <= EVENT_VORLAUF_H)
    .sort((a, b) => a.h - b.h)[0];

  return {
    bevorstehend: imFenster?.kind ?? null,
    stundenBis: imFenster ? Math.round(imFenster.h * 10) / 10 : null,
    turnOfMonth: istTurnOfMonth(now),
    fomcVeraltet: fomcAbgelaufen(now),
  };
}
