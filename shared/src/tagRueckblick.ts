/**
 * Rückblickende Auswertung des TAGES-Horizonts (Engpass-Befund 09.08.).
 *
 * ── Warum das nötig wurde ─────────────────────────────────────────────────
 *
 * Am 09.08. standen die Schatten-Varianten live so:
 *
 *   live        (Ausstieg am Signal)   roh +0,0217 %   netto −0,3269 %   n=523
 *   live_kosten (kostengefiltert)      roh +0,0140 %   netto −0,0860 %   n=165
 *   live_tag    (einen Tag halten)     roh +1,3755 %   netto +0,8755 %   n=2
 *
 * Die Rohkante des Tages-Haltens ist das 63-Fache der gehandelten Variante,
 * und sie ist die einzige, die die Kosten trägt (feeShare stand bei 3,03 —
 * Gebühren fraßen das Dreifache des Bruttogewinns). Genau darauf beruht der
 * Exit-Umbau. Nur: `live_tag` wächst strukturell ~250-mal langsamer als
 * `live`, weil es ein gereiftes Kauf-/Verkaufssignal braucht statt eines
 * Beitrags je 5-Minuten-Scan. Bei n=2 ist die Entscheidung, auf die der
 * Umbau wartet, auf Monate hinaus nicht belegbar.
 *
 * Diese Datei holt die Belege aus der GESPEICHERTEN Historie nach, statt auf
 * sie zu warten.
 *
 * ── Warum das kein Lookahead ist ──────────────────────────────────────────
 *
 * Die Gefahr ist real und dieses Projekt hatte den Fehler schon: Ein früherer
 * HIGH-Bug in `forecast_eval` war exakt ein Lookahead-Leck. Deshalb liegt die
 * Zeitlogik hier — pur, ohne Firestore, ohne Netz — und ist unten Zeile für
 * Zeile festgenagelt. Drei Regeln, die NIE aufgeweicht werden dürfen:
 *
 *  1. Das Signal am Basistag sieht ausschließlich Kurse BIS EINSCHLIESSLICH
 *     diesem Tag. Der Schnitt (`slice(0, i + 1)`) ist die ganze Sache — wer
 *     ihn um eins verschiebt, misst die Zukunft und bekommt großartige Zahlen.
 *  2. Der Bewertungstag muss ECHT VOR HEUTE liegen. Die heutige Kerze ist
 *     unfertig; sie zu bewerten hieße, einen halben Tag als ganzen zu zählen.
 *  3. Zwischen Basis- und Bewertungstag darf keine große Lücke liegen. Sonst
 *     wird aus „einen Tag halten" bei einem Datenloch oder einer Aussetzung
 *     unbemerkt „drei Monate halten" — und die Bewegung dieser drei Monate
 *     landet in einer Statistik, die „Tag" heißt.
 *
 * Die Regeln 2 und 3 sind Gates im Sinne von CLAUDE.md §5.
 */
import { type SchattenKlasse, addiereSchatten, bewerteSchattenSignal } from './classShadow.js';

/** Ein Tag der gespeicherten Historie. `date` ist ISO (YYYY-MM-DD). */
export interface TagesKurs {
  date: string;
  close: number;
}

/**
 * Wie viele Tage Vorlauf die Indikatoren brauchen, bevor ein Signal zählt.
 *
 * Der längste Indikator im Konfluenz-Satz ist der 200er-Trendfilter; darunter
 * rechnet er auf einem Fenster, das es noch nicht gibt. 200 ist bewusst die
 * Untergrenze und nicht „ein bisschen weniger, dann haben wir mehr Punkte":
 * Signale aus der Anlaufphase sind nicht dieselbe Signalquelle, die gemessen
 * werden soll.
 */
export const MIN_VORLAUF = 200;

/**
 * Größte erlaubte Lücke zwischen Basis- und Bewertungstag, in Kalendertagen.
 *
 * Vier deckt ein langes Wochenende samt Feiertag ab (Fr → Di sind drei Tage,
 * mit Feiertag vier). Alles darüber ist keine Tageshaltedauer mehr, sondern
 * ein Loch in den Daten.
 */
export const MAX_LUECKE_TAGE = 4;

/**
 * Halte-Horizonte in Handelstagen, die je Basistag ausgewertet werden.
 *
 * Der Grund für mehrere: Teuer ist `signalFn` — sie rechnet die Indikatoren
 * über das ganze 250er-Fenster. Ob danach EIN Folgekurs abgezogen wird oder
 * fünf, fällt nicht ins Gewicht. Aus derselben Rechenarbeit wird so aus der
 * Ja/Nein-Frage „ist ein Tag besser als fünf Minuten?" eine KURVE über die
 * Haltedauer — und das ist die Frage hinter dem Exit-Umbau.
 *
 * 10 Handelstage sind zwei Wochen; darüber hinaus wird der Vergleich mit
 * einer Intraday-Strategie sinnlos.
 */
export const HORIZONTE = [1, 2, 3, 5, 10] as const;

/**
 * Größte erlaubte Lücke für einen Horizont von `h` Handelstagen.
 *
 * `h` Handelstage umfassen rund `1,4 · h` Kalendertage (fünf Handelstage je
 * sieben). Dazu kommt derselbe Puffer wie bei `MAX_LUECKE_TAGE` für lange
 * Wochenenden und Feiertage.
 *
 * Für h = 1 MUSS exakt `MAX_LUECKE_TAGE` herauskommen — sonst änderte dieser
 * Umbau still die Bedeutung der bereits gemessenen Tages-Kante. Die Formel
 * ist so gewählt, dass das gilt, und ein Test nagelt es fest.
 */
export function maxLuecke(h: number): number {
  return MAX_LUECKE_TAGE + Math.ceil((h - 1) * 1.4);
}

/**
 * Wie viele Kurse das Signal am Basistag sieht — ein ROLLENDES Fenster.
 *
 * Nicht „so viel Historie wie da ist", und das aus zwei Gründen:
 *
 *  1. Es soll DIESELBE Signalquelle gemessen werden, die auch handelt. Der
 *     Live-Scan holt `DEFAULT_STRATEGY.signals.period` = '1y', rechnet also
 *     auf rund 250 Tagen. Ein Wilder-RSI über 5000 Bars ist nicht derselbe
 *     Wert wie über 250 — eine Messung mit wachsendem Fenster würde etwas
 *     bewerten, das so nie gehandelt wurde.
 *  2. Kosten: Jeder Aufruf rechnet die Indikatoren über das ganze Fenster.
 *     Wachsend wäre das quadratisch in der Reihenlänge; bei alten Indizes
 *     mit Jahrzehnten Historie sprengt das jedes Zeitbudget.
 */
export const SIGNAL_FENSTER = 250;

/** Warum ein Basistag NICHT bewertet wurde — die Zahlen machen den Lauf lesbar. */
export interface RueckblickAusfaelle {
  /** Vor `MIN_VORLAUF` — die Indikatoren hätten auf Luft gerechnet. */
  zuWenigVorlauf: number;
  /** Signal war `hold`; es gibt nichts zu halten. */
  hold: number;
  /** Kein Folgetag in der Historie (Reihenende oder Loch). */
  keinFolgetag: number;
  /** Gate 2: Der Bewertungstag ist heute oder später — noch nicht realisiert. */
  nichtRealisiert: number;
  /** Gate 3: Lücke größer als `MAX_LUECKE_TAGE`. */
  luecke: number;
  /** Unbrauchbare Kurse (≤ 0, NaN) auf einer der beiden Seiten. */
  kaputt: number;
}

export interface TagRueckblickErgebnis {
  klasse: SchattenKlasse;
  /** Tatsächlich in die Kante eingegangene Basistage. */
  bewertet: number;
  ausfaelle: RueckblickAusfaelle;
  /**
   * Dieselben Beiträge, getrennt nach Signalrichtung (Owner-Frage 09.08.).
   *
   * Das ist die Zahl, die Drift von Kante trennt. Der erste Katalog-Lauf gab
   * 51,9 % Trefferquote bei +0,60 % Nettokante — die Richtung stimmt also kaum
   * öfter als beim Münzwurf, der Ertrag kommt aus der Asymmetrie der
   * Bewegungen. In einem steigenden Markt ist das bei Kaufsignalen aber genau
   * das, was auch reine Aufwärtsdrift erzeugen würde.
   *
   * Trägt nur `buy` und liegt `sell` bei null oder darunter, misst man die
   * Marktrichtung und nicht das Signal. Tragen beide, ist es eine Kante.
   * Ohne diese Trennung lässt sich der Unterschied aus keiner noch so großen
   * Stichprobe herauslesen.
   */
  nachRichtung: { buy: SchattenKlasse; sell: SchattenKlasse };
  /**
   * Dieselbe Rechnung über MEHRERE Haltedauern, Schlüssel = Handelstage.
   *
   * Die Felder oben (`klasse`, `bewertet`, `ausfaelle`, `nachRichtung`)
   * bleiben BEWUSST die Zahlen des Ein-Tages-Horizonts — sonst hätte dieser
   * Umbau still die Bedeutung der bereits gemessenen Tages-Kante verschoben.
   * `horizonte[1]` trägt dieselben Werte noch einmal.
   */
  horizonte: Record<number, HorizontErgebnis>;
}

/** Ergebnis für EINE Haltedauer. */
export interface HorizontErgebnis {
  /** Handelstage zwischen Einstieg und Bewertung. */
  tage: number;
  klasse: SchattenKlasse;
  bewertet: number;
  nachRichtung: { buy: SchattenKlasse; sell: SchattenKlasse };
  /** Ausfälle, die NUR diesen Horizont betreffen (Vorlauf gilt für alle). */
  hold: number;
  keinFolgetag: number;
  nichtRealisiert: number;
  luecke: number;
  kaputt: number;
}

/** Richtung, die das Signal am Basistag hatte. */
export type SignalFn = (closesBisBasistag: number[], preisAmBasistag: number) => 'buy' | 'sell' | 'hold';

function leereAusfaelle(): RueckblickAusfaelle {
  return { zuWenigVorlauf: 0, hold: 0, keinFolgetag: 0, nichtRealisiert: 0, luecke: 0, kaputt: 0 };
}

/** Kalendertage zwischen zwei ISO-Daten (a < b vorausgesetzt). */
export function tageZwischen(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.POSITIVE_INFINITY;
}

/**
 * Die Tages-Horizont-Kante aus gespeicherter Historie.
 *
 * `reihe` MUSS aufsteigend nach Datum sortiert sein — die Funktion prüft das
 * und bricht sonst ab, statt still Unsinn zu rechnen: Eine falsch sortierte
 * Reihe würde Regel 1 aushebeln, ohne dass es irgendwo auffiele.
 *
 * `heuteIso` ist Gate 2 und wird bewusst übergeben statt hier aus `new Date()`
 * gezogen — so ist die Zeitgrenze im Test wählbar und der Aufrufer kann sie
 * nicht versehentlich umgehen.
 */
export function werteTagRueckblick(
  reihe: readonly TagesKurs[],
  signalFn: SignalFn,
  roundtripKosten: number,
  heuteIso: string,
  minVorlauf: number = MIN_VORLAUF,
  fenster: number = SIGNAL_FENSTER,
  horizonte: readonly number[] = HORIZONTE,
): TagRueckblickErgebnis {
  const ausfaelle = leereAusfaelle();

  for (let i = 1; i < reihe.length; i++) {
    if (reihe[i]!.date <= reihe[i - 1]!.date) {
      throw new Error('werteTagRueckblick: Reihe ist nicht aufsteigend sortiert');
    }
  }

  // Laufender Stand je Horizont.
  interface Stand {
    klasse?: SchattenKlasse;
    buy?: SchattenKlasse;
    sell?: SchattenKlasse;
    bewertet: number;
    hold: number;
    keinFolgetag: number;
    nichtRealisiert: number;
    luecke: number;
    kaputt: number;
  }
  const stand = new Map<number, Stand>(
    horizonte.map((h) => [h, { bewertet: 0, hold: 0, keinFolgetag: 0, nichtRealisiert: 0, luecke: 0, kaputt: 0 }]),
  );

  const closes = reihe.map((t) => t.close);

  // Bis `length - 2`, denn mindestens i + 1 muss existieren.
  for (let i = 0; i < reihe.length - 1; i++) {
    const basis = reihe[i]!;

    if (i + 1 < minVorlauf) { ausfaelle.zuWenigVorlauf += 1; continue; }

    /*
     * Erst prüfen, WELCHE Horizonte auswertbar sind — und zwar BEVOR das
     * teure Signal gerechnet wird. Ein Basistag ohne einen einzigen gültigen
     * Horizont kostet so nichts.
     *
     * Die Gates gelten je Horizont einzeln: Der Bewertungstag von h = 10 kann
     * noch in der Zukunft liegen, während der von h = 1 längst realisiert ist.
     */
    const gueltig: Array<{ h: number; ziel: TagesKurs; s: Stand }> = [];
    for (const h of horizonte) {
      const s = stand.get(h)!;
      const ziel = reihe[i + h];
      if (!ziel) { s.keinFolgetag += 1; continue; }

      // ── Gate 2: nur vollständig realisierte Bewertungstage ──────────────
      // `>=` und nicht `>`: Die heutige Kerze ist noch offen. Sie zu nehmen
      // hieße, einen halben Handelstag als ganzen zu werten — und zwar
      // systematisch in Richtung des laufenden Trends.
      if (ziel.date >= heuteIso) { s.nichtRealisiert += 1; continue; }

      // ── Gate 3: keine Datenlöcher als Haltedauer verkaufen ──────────────
      // Die Schranke wächst mit dem Horizont (`maxLuecke`), sonst fiele jeder
      // längere Horizont grundsätzlich durch — für h = 1 ist sie unverändert.
      if (tageZwischen(basis.date, ziel.date) > maxLuecke(h)) { s.luecke += 1; continue; }

      if (!(basis.close > 0) || !(ziel.close > 0)) { s.kaputt += 1; continue; }
      gueltig.push({ h, ziel, s });
    }
    if (gueltig.length === 0) continue;

    // ── Regel 1: das Signal sieht NUR die Vergangenheit ───────────────────
    // Das Fenster endet bei `i + 1`, also EINSCHLIESSLICH Basistag: Sein
    // Schluss steht fest, er darf gesehen werden — `i + 1` auf keinen Fall.
    // Der Anfang rollt mit (`SIGNAL_FENSTER`), damit hier dieselbe
    // Signalquelle gemessen wird, die auch handelt.
    //
    // EIN Aufruf für ALLE Horizonte: Er hängt nur am Basistag, nicht an der
    // Haltedauer. Genau das macht die Kurve über die Haltedauer fast gratis.
    const direction = signalFn(closes.slice(Math.max(0, i + 1 - fenster), i + 1), basis.close);
    if (direction === 'hold') {
      for (const { s } of gueltig) s.hold += 1;
      continue;
    }

    for (const { ziel, s } of gueltig) {
      const beitrag = bewerteSchattenSignal({ direction, price: basis.close }, ziel.close, roundtripKosten);
      if (!beitrag.zaehlt) { s.kaputt += 1; continue; }
      s.klasse = addiereSchatten(s.klasse, beitrag);
      s[direction] = addiereSchatten(s[direction], beitrag);
      s.bewertet += 1;
    }
  }

  // Das Reihenende hat keinen Folgetag — einmal je Horizont zählen, damit die
  // Summe der Ausfälle plus `bewertet` die Reihenlänge ergibt und ein Loch
  // auffällt. Für h > 1 fehlen entsprechend mehr Tage; die sind oben in der
  // Schleife bereits als `keinFolgetag` gebucht.
  if (reihe.length > 0) for (const h of horizonte) stand.get(h)!.keinFolgetag += 1;

  const leer = (): SchattenKlasse => ({ n: 0, summePct: 0, treffer: 0 });
  const ergebnisse: Record<number, HorizontErgebnis> = {};
  for (const h of horizonte) {
    const s = stand.get(h)!;
    ergebnisse[h] = {
      tage: h,
      klasse: s.klasse ?? leer(),
      bewertet: s.bewertet,
      nachRichtung: { buy: s.buy ?? leer(), sell: s.sell ?? leer() },
      hold: s.hold,
      keinFolgetag: s.keinFolgetag,
      nichtRealisiert: s.nichtRealisiert,
      luecke: s.luecke,
      kaputt: s.kaputt,
    };
  }

  // Die Spitzenfelder bleiben der EIN-Tages-Horizont — siehe Typ-Kommentar.
  const eins = ergebnisse[horizonte.includes(1) ? 1 : horizonte[0]!]!;
  ausfaelle.hold = eins.hold;
  ausfaelle.keinFolgetag = eins.keinFolgetag;
  ausfaelle.nichtRealisiert = eins.nichtRealisiert;
  ausfaelle.luecke = eins.luecke;
  ausfaelle.kaputt = eins.kaputt;

  return {
    klasse: eins.klasse,
    bewertet: eins.bewertet,
    ausfaelle,
    nachRichtung: eins.nachRichtung,
    horizonte: ergebnisse,
  };
}
